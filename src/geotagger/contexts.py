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
