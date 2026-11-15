"""Behaviour-preserving perf fixes (audit P9): each test pins the result the old
code produced and, where cheap, the improvement itself (commit count, parse
count, peak memory)."""
import json
import tracemalloc
from pathlib import Path

import numpy as np

import face_fixtures as ff
from geotagger import faces, geocode, index
from geotagger.services import geocode_service, hotspots_service


def _add_photo(db, name, lat=None, lng=None, dt=1_600_000_000) -> int:
    index.upsert_photo(
        filename=name, dir_="/p9", ext=".jpg", media_type="image", mtime=1.0, size=1,
        lat=lat, lng=lng, geotag_source="sidecar" if lat is not None else "none",
        sidecar_path=None, sidecar_mtime=None, camera="Cam", photo_datetime=dt,
        gps_accuracy=None, orientation=1)
    return db.execute("SELECT id FROM photos WHERE dir='/p9' AND filename=?", (name,)).fetchone()[0]


def _count_begins(db, fn):
    stmts: list[str] = []
    db.set_trace_callback(stmts.append)
    try:
        fn()
    finally:
        db.set_trace_callback(None)
    return sum(1 for s in stmts if s.startswith("BEGIN"))


# ── a. geocode_pending batches its writes ──

def _fake_lookup(lat, lng):
    if lat >= 50:
        return None
    return {"city": f"C{int(lat)}", "state": "S", "country": "Land", "country_code": "LL"}


def test_geocode_pending_single_transaction_same_result(db, monkeypatch):
    monkeypatch.setattr(geocode, "any_available", lambda: True)
    monkeypatch.setattr(geocode, "lookup", _fake_lookup)
    ids = [_add_photo(db, f"g{i}.jpg", lat=10.0 + i * 20, lng=1.0) for i in range(4)]  # last two: lat 50, 70
    res = {}
    begins = _count_begins(db, lambda: res.update(geocode_service.geocode_pending()))
    assert begins == 1                      # was one commit per photo
    assert res == {"processed": 4, "matched": 2, "available": True, "remaining": 0}
    rows = [index.get_photo(i) for i in ids]
    assert [r["loc_city"] for r in rows] == ["C10", "C30", None, None]
    assert all(r["geocoded_at"] is not None for r in rows)   # no-match is recorded too


def test_geocode_pending_bad_row_does_not_lose_batch(db, monkeypatch):
    monkeypatch.setattr(geocode, "any_available", lambda: True)

    def lookup(lat, lng):
        if lat == 11.0:
            raise RuntimeError("boom")
        return _fake_lookup(lat, lng)

    monkeypatch.setattr(geocode, "lookup", lookup)
    ids = [_add_photo(db, f"b{i}.jpg", lat=10.0 + i, lng=1.0) for i in range(3)]
    res = geocode_service.geocode_pending()
    assert (res["processed"], res["matched"], res["remaining"]) == (2, 2, 1)
    assert index.get_photo(ids[1])["geocoded_at"] is None     # retried next run
    assert index.get_photo(ids[0])["loc_city"] == "C10"
    assert index.get_photo(ids[2])["loc_city"] == "C12"


def test_geocode_pending_chunks_writes(db, monkeypatch):
    monkeypatch.setattr(geocode, "any_available", lambda: True)
    monkeypatch.setattr(geocode, "lookup", _fake_lookup)
    monkeypatch.setattr(geocode_service, "_WRITE_CHUNK", 2)
    for i in range(5):
        _add_photo(db, f"c{i}.jpg", lat=1.0 + i, lng=1.0)
    begins = _count_begins(db, geocode_service.geocode_pending)
    assert begins == 3                      # 2 + 2 + 1


# ── b. covered_by_place parses each place's bounds once ──

def test_covered_by_place_parses_bounds_once(monkeypatch):
    from geotagger.place_bounds import parse_bounds
    parse_bounds.cache_clear()
    circle = {"lat": 40.0, "lng": -74.0, "radius": 500.0}
    places = [{"bounds": json.dumps(circle), "type": "circle"},
              {"bounds": "not json", "type": "circle"},
              {"bounds": "[1, 2]", "type": "custom"}]
    import json as real_json
    calls = []
    orig = real_json.loads
    monkeypatch.setattr(real_json, "loads", lambda s, *a, **k: (calls.append(s), orig(s, *a, **k))[1])
    pts = [(40.0 + i * 0.01, -74.0) for i in range(50)]
    out = [hotspots_service.covered_by_place(la, ln, 100.0, places) for la, ln in pts]
    assert out[0] is True and out[-1] is False
    assert len(calls) <= len(places)        # at most one per place, not 50 x 3


# ── c. unlabeled cache holds one copy of the embeddings ──

def test_unlabeled_cache_rows_drop_blobs_but_keep_everything_else(db):
    rng = np.random.default_rng(0)
    embs = ff.unit_vectors(rng, 6)
    ff.seed_unlabeled(db, embs)
    rows, unknowns, times = faces.get_unlabeled_matrix()
    assert len(rows) == 6 and unknowns.shape == (6, embs.shape[1])
    assert all("embedding" not in r.keys() for r in rows)
    fresh = index.list_faces("unlabeled", None, -1)
    for cached, orig in zip(rows, fresh):
        assert {k: cached[k] for k in cached.keys()} == {k: orig[k] for k in orig.keys() if k != "embedding"}
    # Matrix rows still line up with the rows (blob order == row order).
    for i, orig in enumerate(fresh):
        assert np.array_equal(unknowns[i], faces.decode_embedding(orig["embedding"]))
    # Consumers of the cached rows keep working off the slimmed rows.
    from geotagger import serializers
    item = serializers.face_item(rows[0])
    assert item["id"] == rows[0]["id"]
    faces.drop_from_unlabeled_cache([rows[0]["id"]])
    r2, u2, _ = faces.get_unlabeled_matrix()
    assert len(r2) == 5 and u2.shape[0] == 5


# ── d. cluster_unlabeled: same clusters, much smaller peak ──

def _reference_clusters(x, threshold, min_size):
    n = len(x)
    parent = list(range(n))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    sims = x @ x.T
    for i, j in zip(*np.nonzero(sims >= threshold)):
        if i < j:
            parent[find(int(i))] = find(int(j))
    g: dict[int, list[int]] = {}
    for i in range(n):
        g.setdefault(find(i), []).append(i)
    out = [v for v in g.values() if len(v) >= min_size]
    out.sort(key=len, reverse=True)
    return out


def _synthetic(n, k, dim=64, seed=1):
    rng = np.random.default_rng(seed)
    cent = rng.normal(size=(k, dim)).astype(np.float32)
    x = cent[rng.integers(0, k, n)] + 0.5 * rng.normal(size=(n, dim)).astype(np.float32)
    return x / np.linalg.norm(x, axis=1, keepdims=True)


def test_cluster_unlabeled_matches_reference_across_chunk_boundaries(monkeypatch):
    x = _synthetic(700, 40)             # > one 256-row slab, not a multiple of it
    ref = _reference_clusters(x, 0.6, 2)
    got = faces.cluster_unlabeled(x, threshold=0.6, min_size=2)
    key = lambda cl: sorted(sorted(c) for c in cl)  # noqa: E731  (sizes tie; compare as sets)
    assert key(got) == key(ref)
    monkeypatch.setattr(faces, "_CLUSTER_CHUNK", 64)
    assert key(faces.cluster_unlabeled(x, threshold=0.6, min_size=2)) == key(ref)


def test_cluster_unlabeled_peak_memory_bounded():
    n = 6000
    x = _synthetic(n, 300)
    tracemalloc.start()
    faces.cluster_unlabeled(x, threshold=0.65, min_size=2)
    peak = tracemalloc.get_traced_memory()[1]
    tracemalloc.stop()
    old_slab = 1024 * n * (4 + 1)       # float32 sims + bool mask the old code allocated per chunk
    assert peak < old_slab / 2


# ── e. find_untagged_face_photos: ids-only allowed set ──

def test_search_photos_ids_only_matches_full_rows(db):
    for i in range(5):
        _add_photo(db, f"s{i}.jpg", lat=40.0 if i % 2 else None, lng=-74.0 if i % 2 else None, dt=100 + i)
    full = index.search_photos(geotagged="yes", limit=10_000_000)
    slim = index.search_photos(geotagged="yes", limit=10_000_000, ids_only=True)
    assert [r["id"] for r in slim] == [r["id"] for r in full] and slim
    assert slim[0].keys() == ["id", "photo_datetime"]   # A3: ranked search needs the date too


# ── f. get_photos selects only the columns its callers read ──

def test_get_photos_columns_cover_serializer(db):
    from geotagger import serializers
    pid = _add_photo(db, "f.jpg", lat=40.0, lng=-74.0)
    index.update_photo_location(pid, {"city": "X", "state": "S", "country": "Land", "country_code": "LL"})
    slim = index.get_photos(ids=[pid])[0]
    full = index.get_photo(pid)
    assert serializers.photo_to_dict(slim) == serializers.photo_to_dict(full)
    assert index.photo_path(slim) == index.photo_path(full)
    assert len(slim.keys()) < len(full.keys())
    assert Path(index.photo_path(slim)).name == "f.jpg"
    # every filter path shares the column list
    assert index.get_photos(geotagged="yes")[0].keys() == slim.keys()
    assert index.get_photos(undated=True) == []
