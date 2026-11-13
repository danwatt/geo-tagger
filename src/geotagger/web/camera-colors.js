/* Shared per-camera colour assignment + legend for the Geocode and Time Sync pages.
 *
 * Loaded after common.js and before the page script. Top-level globals, since
 * the page scripts use them directly. renderLegend() relies on the page's own
 * top-level `photos` array and `applyFilters()` function.
 */

/* ── Camera colors ── */
const CAM_PALETTE = [
  "#e05c5c", // red
  "#e0a040", // amber
  "#d4d43a", // yellow
  "#5cb85c", // green
  "#3ab8b8", // teal
  "#4a90d9", // blue
  "#9b5ce0", // purple
  "#e05cbc", // pink
  "#e07840", // orange
  "#7ab85c", // lime
];
const camColorMap = {};   // camera string -> hex color
let camPaletteCursor = 0;
let hiddenCameras = new Set();

function camColor(camera) {
  const key = camera || "Unknown";
  if (!camColorMap[key]) {
    camColorMap[key] = CAM_PALETTE[camPaletteCursor % CAM_PALETTE.length];
    camPaletteCursor++;
  }
  return camColorMap[key];
}

/* ── Camera legend ── */
function renderLegend() {
  const legend = document.getElementById("cam-legend");
  legend.innerHTML = "";

  // Get unique cameras from the currently loaded photos
  const currentCameras = new Set(photos.map(p => p.camera || "Unknown"));

  // Only show cameras that are in the current selection
  Object.entries(camColorMap).forEach(([cam, color]) => {
    if (!currentCameras.has(cam)) return;  // Skip cameras not in current selection

    const item = document.createElement("div");
    item.className = "cam-legend-item" + (hiddenCameras.has(cam) ? " dimmed" : "");
    item.title = `Click to hide/show ${cam}`;
    item.innerHTML = `<div class="cam-legend-dot" style="background:${escapeHtml(color)}"></div><span>${escapeHtml(cam)}</span>`;
    item.addEventListener("click", () => {
      hiddenCameras.has(cam) ? hiddenCameras.delete(cam) : hiddenCameras.add(cam);
      item.classList.toggle("dimmed");
      applyFilters();
    });
    legend.appendChild(item);
  });
}
