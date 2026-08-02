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


# ── Polyline (route) geometry ──
#
# The road-trip corridor query needs point-to-polyline distance and positions
# along a route for tens of thousands of photos, so everything below works in a
# local equirectangular projection anchored at the route's mean latitude: one
# cos() for the whole route, then plain 2-D algebra per photo instead of a
# great-circle call per segment per photo. Error is well under a percent over a
# few degrees of latitude, which is nothing against corridors half a mile wide.

def local_scale(verts) -> tuple[float, float]:
    """-> (meters per degree latitude, meters per degree longitude) at the mean
    latitude of `verts` ([[lat, lng], ...])."""
    from math import cos, radians
    lat0 = sum(v[0] for v in verts) / len(verts) if verts else 0.0
    return 111132.0, max(111320.0 * cos(radians(lat0)), 1.0)


def _xy(lat: float, lng: float, scale: tuple[float, float]) -> tuple[float, float]:
    return lng * scale[1], lat * scale[0]


def planar_distance(lat1: float, lng1: float, lat2: float, lng2: float,
                    scale: tuple[float, float]) -> float:
    """Distance in meters between two nearby points under the same local
    projection the route helpers use."""
    x0, y0 = _xy(lat1, lng1, scale)
    x1, y1 = _xy(lat2, lng2, scale)
    return ((x1 - x0) ** 2 + (y1 - y0) ** 2) ** 0.5


def route_cumulative_lengths(verts, scale: tuple[float, float]) -> list[float]:
    """Arc length in meters from the route start to each vertex; [0.0] for a
    single point. cum[-1] is the total route length."""
    cum = [0.0]
    for i in range(1, len(verts)):
        x0, y0 = _xy(verts[i - 1][0], verts[i - 1][1], scale)
        x1, y1 = _xy(verts[i][0], verts[i][1], scale)
        cum.append(cum[-1] + ((x1 - x0) ** 2 + (y1 - y0) ** 2) ** 0.5)
    return cum


def distance_to_route(lat: float, lng: float, verts, cum: list[float],
                      scale: tuple[float, float]) -> tuple[float, float]:
    """-> (distance in meters to the nearest point on the polyline, arc length of
    that nearest point). `cum` comes from route_cumulative_lengths."""
    px, py = _xy(lat, lng, scale)
    best_d2 = float("inf")
    best_s = 0.0
    for i in range(1, len(verts)):
        x0, y0 = _xy(verts[i - 1][0], verts[i - 1][1], scale)
        x1, y1 = _xy(verts[i][0], verts[i][1], scale)
        dx, dy = x1 - x0, y1 - y0
        seg2 = dx * dx + dy * dy
        # t is where the perpendicular foot falls on the segment, clamped to its
        # ends so a photo off the end of a segment measures to the endpoint.
        t = 0.0 if seg2 <= 0 else max(0.0, min(1.0, ((px - x0) * dx + (py - y0) * dy) / seg2))
        fx, fy = x0 + t * dx, y0 + t * dy
        d2 = (px - fx) ** 2 + (py - fy) ** 2
        if d2 < best_d2:
            best_d2 = d2
            best_s = cum[i - 1] + t * (seg2 ** 0.5)
    return best_d2 ** 0.5, best_s


def point_along_route(s: float, verts, cum: list[float]) -> tuple[float, float]:
    """Interpolate the (lat, lng) at arc length `s` along the polyline. Clamped
    to the route's ends, so extrapolated positions stay on the road."""
    import bisect
    if s <= 0:
        return verts[0][0], verts[0][1]
    if s >= cum[-1]:
        return verts[-1][0], verts[-1][1]
    i = bisect.bisect_right(cum, s)          # first vertex past s
    seg = cum[i] - cum[i - 1]
    f = 0.0 if seg <= 0 else (s - cum[i - 1]) / seg
    return (verts[i - 1][0] + f * (verts[i][0] - verts[i - 1][0]),
            verts[i - 1][1] + f * (verts[i][1] - verts[i - 1][1]))


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
