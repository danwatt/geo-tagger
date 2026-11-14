"""The hotspot clustering's spatial grid (audit G5): a neighbour within the merge
radius must always be found, whatever the latitude, direction or antimeridian."""

import math
import random

import pytest

from geotagger.services import hotspots_service as hs

RADIUS = 100.0


def _dest(lat: float, lng: float, meters: float, bearing_deg: float) -> tuple[float, float]:
    """Spherical great-circle destination — independent of the module's own
    equirectangular metric, so the tests don't just echo the implementation."""
    r = 6_371_008.8
    d = meters / r
    t = math.radians(bearing_deg)
    p1, l1 = math.radians(lat), math.radians(lng)
    p2 = math.asin(math.sin(p1) * math.cos(d) + math.cos(p1) * math.sin(d) * math.cos(t))
    l2 = l1 + math.atan2(math.sin(t) * math.sin(d) * math.cos(p1),
                         math.cos(d) - math.sin(p1) * math.sin(p2))
    return math.degrees(p2), (math.degrees(l2) + 540.0) % 360.0 - 180.0


def _cell(lat: float, lng: float, n: int = 1, sid: int = 1) -> dict:
    return {"alat": lat, "alng": lng, "n": n, "last_ts": 1, "sample_id": sid}


def _pair(seed: tuple[float, float], meters: float, bearing: float) -> list[dict]:
    lat, lng = _dest(*seed, meters, bearing)
    return hs.cluster_cells([_cell(*seed, n=10, sid=1), _cell(lat, lng, sid=2)], RADIUS)


@pytest.mark.parametrize("seed", [
    (47.6, -122.3),       # Seattle — the audit's repro
    (0.0, 0.0),           # equator / prime meridian band edges
    (-33.87, 151.21),     # southern hemisphere
    (78.22, 15.65),       # Svalbard
    (89.95, 30.0),        # a few km from the pole
])
@pytest.mark.parametrize("bearing", range(0, 360, 5))
def test_cell_90m_away_merges_in_every_direction(seed, bearing):
    assert len(_pair(seed, 90.0, bearing)) == 1


@pytest.mark.parametrize("seed", [(47.6, -122.3), (78.22, 15.65), (0.0, 0.0)])
@pytest.mark.parametrize("bearing", range(0, 360, 15))
def test_cell_just_outside_the_radius_stays_separate(seed, bearing):
    assert len(_pair(seed, 110.0, bearing)) == 2


@pytest.mark.parametrize("bearing", [60, 90, 120, 240, 270, 300])
def test_merges_across_the_antimeridian(bearing):
    # Fiji: 179.9995 and its neighbour on the far side of ±180.
    clusters = _pair((-17.0, 179.9995), 90.0, bearing)
    assert len(clusters) == 1


def test_antimeridian_centroid_stays_on_the_dateline():
    # Equal weights either side of ±180 must average to ±180, not to 0°.
    clusters = hs.cluster_cells([_cell(-17.0, 179.9996, n=5), _cell(-17.0, -179.9996, n=5)],
                                RADIUS)
    assert len(clusters) == 1
    assert abs(clusters[0]["lng"]) == pytest.approx(180.0, abs=1e-6)


def test_meters_between_takes_the_short_way_round():
    assert hs.meters_between(-17.0, 179.9995, -17.0, -179.9995) < 120.0


def test_at_the_pole_does_not_crash():
    clusters = hs.cluster_cells([_cell(90.0, 0.0, n=3), _cell(90.0, 120.0), _cell(-90.0, -45.0)],
                                RADIUS)
    # All points at the north pole are the same spot (cos(90°) = 0).
    assert sorted(c["count"] for c in clusters) == [1, 4]


def test_grid_nearest_matches_brute_force():
    """Exactness check: for random clusters spread across every latitude regime
    and the dateline, the grid's answer equals a linear scan's."""
    rng = random.Random(7)
    anchors = [(47.6, -122.3), (78.2, 15.6), (-17.0, 179.999), (89.99, 0.0), (0.0, 0.0)]
    clusters = []
    for alat, alng in anchors:
        for _ in range(300):
            lat, lng = _dest(alat, alng, rng.uniform(0, 400), rng.uniform(0, 360))
            clusters.append({"lat": lat, "lng": lng})
    grid = hs.build_grid(clusters, RADIUS)
    for alat, alng in anchors:
        for _ in range(300):
            qlat, qlng = _dest(alat, alng, rng.uniform(0, 400), rng.uniform(0, 360))
            best, best_d = None, RADIUS
            for cl in clusters:
                d = hs.meters_between(qlat, qlng, cl["lat"], cl["lng"])
                if d < best_d:
                    best, best_d = cl, d
            got = grid.nearest(qlat, qlng)
            if best is None:
                assert got is None
            else:
                assert got is not None
                assert hs.meters_between(qlat, qlng, got["lat"], got["lng"]) == pytest.approx(best_d)


def test_clustering_is_deterministic():
    rng = random.Random(3)
    cells = []
    for _ in range(2000):
        lat, lng = _dest(47.6, -122.3, rng.uniform(0, 2000), rng.uniform(0, 360))
        cells.append(_cell(lat, lng, n=rng.randint(1, 30), sid=rng.randint(1, 10**6)))
    cells.sort(key=lambda c: -c["n"])
    a = hs.cluster_cells([dict(c) for c in cells], RADIUS)
    b = hs.cluster_cells([dict(c) for c in cells], RADIUS)
    assert a == b


def test_no_two_clusters_seeded_within_the_radius():
    """The user-visible symptom of G5: duplicate hotspots. Every cluster seed was
    created only because nothing was in range, so no two final centroids should
    sit well inside one merge radius of each other (centroid drift allows a little
    slack, hence 0.5 x radius)."""
    rng = random.Random(11)
    cells = []
    for _ in range(50):
        clat, clng = rng.uniform(-60, 80), rng.uniform(-180, 180)
        for _ in range(40):
            lat, lng = _dest(clat, clng, rng.uniform(0, 60), rng.uniform(0, 360))
            cells.append(_cell(lat, lng, n=rng.randint(1, 30)))
    cells.sort(key=lambda c: -c["n"])
    clusters = hs.cluster_cells(cells, RADIUS)
    grid = hs.build_grid([], RADIUS)
    for cl in clusters:
        near = grid.nearest(cl["lat"], cl["lng"])
        assert near is None or hs.meters_between(cl["lat"], cl["lng"],
                                                 near["lat"], near["lng"]) >= 0.5 * RADIUS
        grid.add(cl)
