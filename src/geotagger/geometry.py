"""Pure geometry helpers: point-in-polygon, polygon bbox/centroid, and the
longitude normalization Leaflet's unwrapped bounds need.

Lived in contexts.py until the Life Contexts feature was removed; nothing here
was context-specific, and the geocoder, OSM place lookup and area queries all
depend on it."""


def point_in_polygon(lat: float, lng: float, verts: list[list[float]]) -> bool:
    """Ray-casting point-in-polygon. verts is [[lat, lng], ...]."""
    inside = False
    n = len(verts)
    j = n - 1
    for i in range(n):
        yi, xi = verts[i][0], verts[i][1]
        yj, xj = verts[j][0], verts[j][1]
        if ((yi > lat) != (yj > lat)) and \
           (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside


def polygon_bbox(verts) -> tuple[float, float, float, float]:
    """-> (min_lat, max_lat, min_lng, max_lng)."""
    lats = [v[0] for v in verts]
    lngs = [v[1] for v in verts]
    return min(lats), max(lats), min(lngs), max(lngs)


def normalize_lng(lng: float) -> float:
    """Wrap longitude into [-180, 180]. Leaflet can return values outside this range
    when the user pans across the antimeridian."""
    lng = lng % 360
    if lng > 180:
        lng -= 360
    if lng < -180:
        lng += 360
    return lng


def normalize_lng_bbox(min_lng: float, max_lng: float) -> tuple[float, float]:
    """Shift a bbox's longitudes by a common multiple of 360 so they land in a
    sane range. map.getBounds() (Leaflet) returns raw, unwrapped longitudes once
    the map has been panned all the way around the globe — e.g. -458.4/-456.1
    instead of -98.4/-96.1 — which then matches nothing in a `lng BETWEEN` SQL
    filter. Shifting both bounds by the same amount (derived from the bbox
    center) preserves width and ordering, unlike normalizing each bound
    independently which could invert a narrow bbox that straddles +/-180."""
    center = (min_lng + max_lng) / 2.0
    shift = normalize_lng(center) - center
    return min_lng + shift, max_lng + shift


def polygon_centroid(verts) -> tuple[float, float]:
    """Area-weighted centroid -> (lat, lng). Falls back to vertex mean for degenerate polygons."""
    n = len(verts)
    if n == 0:
        return 0.0, 0.0
    # shoelace centroid; treat lng as x, lat as y
    area = 0.0
    cx = 0.0
    cy = 0.0
    for i in range(n):
        x0, y0 = verts[i][1], verts[i][0]
        x1, y1 = verts[(i + 1) % n][1], verts[(i + 1) % n][0]
        cross = x0 * y1 - x1 * y0
        area += cross
        cx += (x0 + x1) * cross
        cy += (y0 + y1) * cross
    area /= 2.0
    if abs(area) < 1e-12:
        return (sum(v[0] for v in verts) / n, sum(v[1] for v in verts) / n)
    cx /= 6.0 * area
    cy /= 6.0 * area
    return cy, cx  # (lat, lng)
