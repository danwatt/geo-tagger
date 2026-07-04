const el = (id) => document.getElementById(id);

let map;
let beforeMarkers = [];
let afterMarkers = [];
let selectedLocationMarker;
let currentGroup = null;
let selectedIds = new Set();
let lastClickedIndex = -1;

document.addEventListener("DOMContentLoaded", () => {
    map = L.map('map').setView([0, 0], 2);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);

    map.on('click', onMapClick);
    map.on('moveend', correctWorldWrap);
    const mapContainer = el('map-container');
    mapContainer.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
    });
    mapContainer.addEventListener("drop", onMapDrop);

    el('save-btn').addEventListener('click', saveGeotags);
    el('skip-btn').addEventListener('click', skipGroup);

    // Imprecise drop toggle
    const impreciseToggle = document.getElementById("imprecise-toggle");
    const impreciseRadiusSelect = document.getElementById("imprecise-radius-select");
    if (impreciseToggle && impreciseRadiusSelect) {
        impreciseToggle.addEventListener("change", () => {
        impreciseRadiusSelect.style.display = impreciseToggle.checked ? "inline-block" : "none";
        });
    }

    loadNextGroup();
});

// Leaflet projects longitude linearly with no wraparound, so continuous
// horizontal dragging lets the map's own center drift past +/-180. Markers are
// placed at their canonical (wrapped) lat/lng, so once the view has drifted a
// full world away, they'd render a full world-width off screen. Silently
// re-centering to the CRS-wrapped equivalent view fixes this — visually a
// no-op, since Leaflet's tile rendering is already seamless across world
// copies — and keeps the map's own coordinate system from drifting further.
function correctWorldWrap() {
    const center = map.getCenter();
    const wrapped = map.wrapLatLng(center);
    if (Math.abs(wrapped.lng - center.lng) > 1e-9) {
        map.setView(wrapped, map.getZoom(), { animate: false });
    }
}

function onMapClick(e) {
    if (selectedLocationMarker) {
        map.removeLayer(selectedLocationMarker);
    }
    selectedLocationMarker = L.marker(e.latlng).addTo(map);
}

async function onMapDrop(e) {
    e.preventDefault();
    const ids = JSON.parse(e.dataTransfer.getData("application/json") || "[]");
    if (!ids.length) return;

    const latlng = map.mouseEventToLatLng(e);

    let accuracy = null;
    const impreciseToggle = document.getElementById("imprecise-toggle");
    if (impreciseToggle && impreciseToggle.checked) {
        const radiusSelect = document.getElementById("imprecise-radius-select");
        accuracy = parseFloat(radiusSelect.value);
    }
    
    await geotagPhotos(ids, latlng.lat, latlng.lng, accuracy);
}


function handleThumbClick(e, photo, index) {
    const photoId = photo.id;
    const toTagPhotos = currentGroup.to_tag;

    if (e.shiftKey && lastClickedIndex >= 0) {
        const lo = Math.min(lastClickedIndex, index);
        const hi = Math.max(lastClickedIndex, index);
        for (let i = lo; i <= hi; i++) {
            selectedIds.add(toTagPhotos[i].id);
        }
    } else if (e.ctrlKey || e.metaKey) {
        if (selectedIds.has(photoId)) {
            selectedIds.delete(photoId);
        } else {
            selectedIds.add(photoId);
        }
    } else {
        selectedIds.clear();
        selectedIds.add(photoId);
    }
    lastClickedIndex = index;
    refreshSelectionUI();
}

function refreshSelectionUI() {
    const allThumbnails = document.querySelectorAll('#grid-to-tag-section img');
    allThumbnails.forEach(img => {
        const id = parseInt(img.dataset.photoId, 10);
        if (selectedIds.has(id)) {
            img.classList.add('selected');
        } else {
            img.classList.remove('selected');
        }
    });
}

function handleDragStart(e, photo) {
    if (!selectedIds.has(photo.id)) {
        selectedIds.clear();
        selectedIds.add(photo.id);
        refreshSelectionUI();
    }
    e.dataTransfer.setData("application/json", JSON.stringify([...selectedIds]));
    e.dataTransfer.effectAllowed = "copy";
}

async function geotagPhotos(ids, lat, lng, accuracy = null) {
    try {
        const response = await fetch('/api/geotag', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ ids, lat, lng, gps_accuracy: accuracy })
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        // Reload the group to see the changes
        const after_ts = currentGroup.to_tag.length > 0 ? currentGroup.to_tag[currentGroup.to_tag.length - 1].photo_datetime : null;
        loadNextGroup(after_ts);

    } catch (error) {
        console.error('Could not save geotags:', error);
        alert('Failed to save geotags.');
    }
}

async function saveGeotags() {
    if (!selectedLocationMarker) {
        alert("Please select a location on the map first.");
        return;
    }

    if (selectedIds.size === 0) {
        alert("Please select photos to geotag.");
        return;
    }

    const ids = [...selectedIds];
    const { lat, lng } = selectedLocationMarker.getLatLng();

    let accuracy = null;
    const impreciseToggle = document.getElementById("imprecise-toggle");
    if (impreciseToggle && impreciseToggle.checked) {
      const radiusSelect = document.getElementById("imprecise-radius-select");
      accuracy = parseFloat(radiusSelect.value);
    }

    await geotagPhotos(ids, lat, lng, accuracy);
}


function skipGroup() {
    if (currentGroup && currentGroup.to_tag.length > 0) {
        const after_ts = currentGroup.to_tag[currentGroup.to_tag.length - 1].photo_datetime;
        loadNextGroup(after_ts);
    } else {
        loadNextGroup();
    }
}


async function loadNextGroup(after_ts = null) {
    try {
        let url = '/api/geocode/next-group';
        if (after_ts) {
            url += `?after_ts=${after_ts}`;
        }
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        currentGroup = data;
        if (data) {
            renderGrids(data);
            renderMapMarkers(data);
        } else {
            // handle no more groups
            el('photo-container').innerHTML = "<h2>All photos are geotagged!</h2>";
        }
    } catch (error) {
        console.error('Could not fetch next group:', error);
    }
}

function renderGrids(data) {
    renderGroup('grid-before-section', 'Before', data.before);
    renderGroup('grid-to-tag-section', 'To Geocode', data.to_tag);
    renderGroup('grid-after-section', 'After', data.after);
}

function renderGroup(sectionId, title, photos) {
    const section = el(sectionId);
    section.innerHTML = '';

    if (photos.length === 0) {
        section.style.display = 'none';
        return;
    }
    section.style.display = 'block';

    const header = document.createElement('div');
    header.className = 'face-group-header';

    const label = document.createElement('div');
    label.className = 'face-group-label';
    label.textContent = title;
    header.appendChild(label);

    const meta = document.createElement('div');
    meta.className = 'face-group-meta';
    meta.textContent = formatMeta(photos);
    header.appendChild(meta);

    section.appendChild(header);

    const cells = document.createElement('div');
    cells.className = 'face-group-cells';
    for (const [index, photo] of photos.entries()) {
        const img = document.createElement('img');
        img.src = `/api/thumbnail/${photo.id}`;
        img.dataset.photoId = photo.id;
        img.draggable = true;

        if (sectionId === 'grid-to-tag-section') {
            img.addEventListener('click', (e) => handleThumbClick(e, photo, index));
            img.addEventListener('dragstart', (e) => handleDragStart(e, photo));
        }
        cells.appendChild(img);
    }
    section.appendChild(cells);
}

function formatMeta(photos) {
    if (!photos || photos.length === 0) return '';

    const dateRange = formatDateRange(photos);
    const location = formatLocation(photos);

    return [dateRange, location].filter(Boolean).join(' · ');
}

function formatDateRange(photos) {
    const timestamps = photos.map(p => p.photo_datetime).filter(Boolean);
    if (timestamps.length === 0) return 'Undated';

    const min_ts = Math.min(...timestamps);
    const max_ts = Math.max(...timestamps);

    const min_date = new Date(min_ts * 1000);
    const max_date = new Date(max_ts * 1000);

    if (min_date.toDateString() === max_date.toDateString()) {
        return min_date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    } else {
        return `${min_date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} - ${max_date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
    }
}

function formatLocation(photos) {
    const locations = photos.map(p => p.location).filter(Boolean);
    if (locations.length === 0) return null;

    // For simplicity, just use the first location
    const loc = locations[0];
    return [loc.city, loc.state, loc.country].filter(Boolean).join(', ');
}

function renderMapMarkers(data) {
    // Clear existing markers
    beforeMarkers.forEach(marker => map.removeLayer(marker));
    afterMarkers.forEach(marker => map.removeLayer(marker));
    if (selectedLocationMarker) {
        map.removeLayer(selectedLocationMarker);
    }
    beforeMarkers = [];
    afterMarkers = [];
    selectedLocationMarker = null;

    // Add 'before' markers
    data.before.forEach(photo => {
        if (photo.lat && photo.lng) {
            const marker = L.marker([photo.lat, photo.lng]).addTo(map);
            beforeMarkers.push(marker);
        }
    });

    // Add 'after' markers
    data.after.forEach(photo => {
        if (photo.lat && photo.lng) {
            const marker = L.marker([photo.lat, photo.lng], { icon: redIcon }).addTo(map);
            afterMarkers.push(marker);
        }
    });

    // Fit map to markers if there are any
    const allMarkers = [...beforeMarkers, ...afterMarkers];
    if (allMarkers.length > 0) {
        const group = new L.featureGroup(allMarkers);
        map.fitBounds(group.getBounds().pad(0.5));
    } else {
        map.setView([0,0], 2);
    }
}

// Custom icon for 'after' markers to differentiate them
const redIcon = new L.Icon({
  iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-red.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41]
});
