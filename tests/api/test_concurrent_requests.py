"""Genuinely concurrent requests against one app (audit T2's "any concurrent
request" gap). test_index_concurrency covers the transaction layer directly;
these drive the same shared connection through the HTTP routes, the way a
second browser tab or an overlapping client batch would.

Each thread waits on a Barrier so the requests really overlap, then the
assertions check what no interleaving may break: no 5xx, and DB state equal to
*some* serial order of the writes — never a torn mix of two of them."""

import threading

import numpy as np

from geotagger import index

import face_fixtures as ff

N_THREADS = 6
ROUNDS = 4
TIMEOUT = 30


def _run_concurrently(fns) -> list:
    """Run each zero-arg callable on its own thread, all released together by a
    barrier. Returns their results; re-raises the first exception."""
    barrier = threading.Barrier(len(fns), timeout=TIMEOUT)
    results: list = [None] * len(fns)
    errors: list[BaseException] = []

    def worker(i, fn):
        try:
            barrier.wait()
            results[i] = fn()
        except BaseException as e:  # surfaced on the main thread below
            errors.append(e)

    threads = [threading.Thread(target=worker, args=(i, fn), name=f"concurrent-{i}")
               for i, fn in enumerate(fns)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(TIMEOUT)
    assert not any(t.is_alive() for t in threads), "a request thread hung"
    if errors:
        raise errors[0]
    return results


def _photos(n: int) -> list[int]:
    for i in range(n):
        index.upsert_photo(
            filename=f"c{i}.jpg", dir_="/conc", ext=".jpg", media_type="image",
            mtime=1.0, size=1, lat=None, lng=None, geotag_source="none",
            sidecar_path=None, sidecar_mtime=None, camera="c",
            photo_datetime=1_600_000_000 + i, gps_accuracy=None, orientation=1,
        )
    return [r[0] for r in index.get_db().execute(
        "SELECT id FROM photos WHERE dir='/conc' ORDER BY id")]


def test_overlapping_geotag_writes_never_tear(client):
    """Every thread geotags the same photos to its own point (DB-only mode, the
    default), several rounds each, while a reader lists photos. Each photo must
    end on exactly one writer's (lat, lng) pair — a lat from one request with
    the lng of another would mean two writes interleaved inside a row update."""
    ids = _photos(25)
    points = {t: (10.0 + t, 20.0 + 2 * t) for t in range(N_THREADS)}

    def writer(t):
        def go():
            codes = []
            for _ in range(ROUNDS):
                lat, lng = points[t]
                r = client.post("/api/geotag", json={"ids": ids, "lat": lat, "lng": lng})
                codes.append((r.status_code, r.json()["written"] == ids, r.json()["failed"]))
            return codes
        return go

    def reader():
        return [client.get("/api/photos").status_code for _ in range(ROUNDS * 2)]

    out = _run_concurrently([writer(t) for t in range(N_THREADS)] + [reader])
    for codes in out[:-1]:
        assert codes == [(200, True, [])] * ROUNDS
    assert out[-1] == [200] * (ROUNDS * 2)

    valid = set(points.values())
    rows = index.get_db().execute(
        "SELECT lat, lng, geotag_source FROM photos WHERE id IN (SELECT value FROM json_each(?))",
        (index.ids_json(ids),)).fetchall()
    assert len(rows) == len(ids)
    for r in rows:
        assert (r["lat"], r["lng"]) in valid
        assert r["geotag_source"] == "database"
    # The R*Tree spatial index must agree with the rows it shadows (the points are
    # whole degrees, so its float32 storage compares exactly).
    spatial = index.get_db().execute(
        "SELECT COUNT(*) FROM photos p JOIN photos_spatial s ON s.id = p.id "
        "WHERE p.id IN (SELECT value FROM json_each(?)) "
        "AND s.min_lat = p.lat AND s.min_lng = p.lng",
        (index.ids_json(ids),)).fetchone()[0]
    assert spatial == len(ids)


def test_overlapping_face_assigns_stay_consistent(client):
    """Threads bulk-assign the same faces to different people at once (one by
    name, so get_or_create_person races too) while others ignore a disjoint set.
    Afterwards each face has exactly one owner, person face counts add up, and
    the racing name produced one person, not duplicates."""
    db = index.get_db()
    rng = np.random.default_rng(42)
    shared = ff.seed_unlabeled(db, ff.unit_vectors(rng, 20))
    to_ignore = ff.seed_unlabeled(db, ff.unit_vectors(rng, 10))
    people = [index.create_person(f"Person {i}") for i in range(3)]

    def assign_to(pid):
        return lambda: client.post("/api/faces/assign",
                                   json={"face_ids": shared, "person_id": pid})

    def assign_by_name():
        return client.post("/api/faces/assign", json={"face_ids": shared, "name": "Racer"})

    def ignore():
        return client.post("/api/faces/ignore", json={"face_ids": to_ignore, "ignored": True})

    fns = [assign_to(p) for p in people] + [assign_by_name, assign_by_name, ignore]
    responses = _run_concurrently(fns)
    for r in responses:
        assert r.status_code == 200, r.text
    for r in responses[:-1]:
        assert r.json()["assigned"] == len(shared) and r.json()["not_found"] == 0

    racers = db.execute("SELECT id FROM persons WHERE name='Racer'").fetchall()
    assert len(racers) == 1                    # UNIQUE name, no duplicate person
    owners = set(people) | {racers[0][0]}
    rows = db.execute(
        "SELECT person_id, ignored FROM faces WHERE id IN (SELECT value FROM json_each(?))",
        (index.ids_json(shared),)).fetchall()
    assert all(r["person_id"] in owners and r["ignored"] == 0 for r in rows)
    # Last writer wins per batch: one assign committed last, so all 20 share an owner.
    assert len({r["person_id"] for r in rows}) == 1

    counts = {p["id"]: p["face_count"]
              for p in client.get("/api/persons?face_counts=true").json()}
    assert sum(counts.get(o, 0) for o in owners) == len(shared)
    assert client.get("/api/faces?scope=ignored").json()["total"] == len(to_ignore)
    assert client.get("/api/faces?scope=unlabeled").json()["total"] == 0
