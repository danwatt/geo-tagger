"""Endpoint tests for POST /api/geocode/export-sidecars (audit T2): the on-demand
DB-to-XMP catch-up for photos geotagged DB-only.

The route is one batch of the client-loop convention (audit A7): `limit` photos
per call, `after_id` = the previous call's `cursor`, repeat until `remaining`
is 0. Only photos whose sidecar doesn't hold their current values are picked
(index.get_photos_to_export). These pin what a call writes, what it reports on
a partial failure, the DB tracking it leaves behind, and the batching /
idempotency contract. Real sidecar contents are read back through ExifTool
(et_session); the batching tests stub the write."""

import os
from pathlib import Path

import pytest
from PIL import Image

from geotagger import exiftool_session, index, sidecar


def _photo(tmp_path: Path, name: str, lat=None, lng=None, loc: dict | None = None) -> int:
    img = tmp_path / name
    Image.new("RGB", (8, 8), "blue").save(img, "JPEG")
    index.upsert_photo(
        filename=name, dir_=str(tmp_path), ext=".jpg", media_type="image",
        mtime=1.0, size=1, lat=lat, lng=lng,
        geotag_source="database" if lat is not None else "none",
        sidecar_path=None, sidecar_mtime=None, camera="c",
        photo_datetime=1000, gps_accuracy=None, orientation=1,
    )
    pid = index.get_db().execute(
        "SELECT id FROM photos WHERE dir=? AND filename=?", (str(tmp_path), name)).fetchone()[0]
    if loc:
        index.update_photo_location(pid, loc)
    return pid


def _xmp_tags(xmp: Path, *tags: str) -> dict:
    with exiftool_session.get_et_lock():
        return exiftool_session.get_et().get_tags([str(xmp)], tags=list(tags))[0]


def _row(pid: int):
    return index.get_db().execute(
        "SELECT sidecar_path, sidecar_mtime, geotag_source FROM photos WHERE id=?", (pid,)).fetchone()


def test_export_writes_gps_and_places_for_geotagged_photos_only(et_session, client, tmp_path):
    placed = _photo(tmp_path, "placed.jpg", 48.8584, 2.2945,
                    loc={"city": "Paris", "state": "Ile-de-France",
                         "country": "France", "country_code": "FR"})
    bare = _photo(tmp_path, "bare.jpg", -33.8568, 151.2153)     # not geocoded yet
    untagged = _photo(tmp_path, "untagged.jpg")

    r = client.post("/api/geocode/export-sidecars")
    assert r.status_code == 200
    assert r.json() == {"processed": 2, "written": 2, "failed": 0, "errors_sample": [],
                        "cursor": bare, "remaining": 0}

    lat, lng, _src = sidecar.read_gps(tmp_path / "placed.jpg")
    assert round(lat, 4) == 48.8584 and round(lng, 4) == 2.2945
    tags = _xmp_tags(tmp_path / "placed.xmp", "XMP-photoshop:City", "XMP-photoshop:Country")
    assert tags.get("XMP:City") == "Paris" and tags.get("XMP:Country") == "France"

    lat, lng, _src = sidecar.read_gps(tmp_path / "bare.jpg")
    assert round(lat, 4) == -33.8568 and round(lng, 4) == 151.2153   # hemisphere kept
    assert "XMP:City" not in _xmp_tags(tmp_path / "bare.xmp", "XMP-photoshop:City")

    assert not (tmp_path / "untagged.xmp").exists()
    # The DB now tracks the sidecar exactly as a scan would, so the next scan
    # sees these rows as fresh instead of re-reading them.
    for pid, xmp in ((placed, "placed.xmp"), (bare, "bare.xmp")):
        row = _row(pid)
        assert row["geotag_source"] == "sidecar"
        assert row["sidecar_path"] == xmp
        assert row["sidecar_mtime"] == (tmp_path / xmp).stat().st_mtime
    assert _row(untagged)["geotag_source"] == "none"

    # Idempotent: nothing changed, so a second run has nothing left to write.
    again = client.post("/api/geocode/export-sidecars").json()
    assert again["processed"] == 0 and again["remaining"] == 0


def test_export_partial_failure_is_reported_and_isolated(client, tmp_path, monkeypatch):
    """One bad file must not abort the run: the rest still export, the failure is
    counted with a sample, and the failed row's tracking is left as it was."""
    ok = _photo(tmp_path, "ok.jpg", 10.0, 20.0)
    bad = _photo(tmp_path, "bad.jpg", 11.0, 21.0)
    written = []

    def fake_write(p, lat, lng, location=None, gps_accuracy=None):
        if p.name == "bad.jpg":
            raise RuntimeError("exiftool says no")
        written.append(p.name)
        xmp = p.with_suffix(".xmp")
        xmp.write_text("<x:xmpmeta xmlns:x='adobe:ns:meta/'/>")
        return xmp

    monkeypatch.setattr(sidecar, "write_gps", fake_write)
    r = client.post("/api/geocode/export-sidecars")
    assert r.status_code == 200
    assert r.json() == {"processed": 2, "written": 1, "failed": 1,
                        "errors_sample": ["bad.jpg: exiftool says no"],
                        "cursor": bad, "remaining": 0}
    assert written == ["ok.jpg"]
    assert _row(ok)["geotag_source"] == "sidecar" and _row(ok)["sidecar_path"] == "ok.xmp"
    assert tuple(_row(bad)) == (None, None, "database")
    # The failure is still to export: the next run (cursor 0) retries just it.
    assert index.count_photos_to_export() == 1


def test_export_error_samples_are_capped(client, tmp_path, monkeypatch):
    for i in range(7):
        _photo(tmp_path, f"f{i}.jpg", 1.0 + i, 2.0)

    def boom(*a, **k):
        raise RuntimeError("nope")

    monkeypatch.setattr(sidecar, "write_gps", boom)
    out = client.post("/api/geocode/export-sidecars").json()
    assert out["written"] == 0 and out["failed"] == 7 and len(out["errors_sample"]) == 5


def test_export_empty_library(client):
    assert client.post("/api/geocode/export-sidecars").json() == {
        "processed": 0, "written": 0, "failed": 0, "errors_sample": [],
        "cursor": 0, "remaining": 0}


# ── Batching (A7) ──

@pytest.fixture
def fake_write(monkeypatch):
    """Stub the ExifTool write: drop a minimal sidecar (distinct mtime each time),
    record which files were written, fail any whose name is in `fail`."""
    calls: list[str] = []
    fail: set[str] = set()

    def write(p, lat, lng, location=None, gps_accuracy=None):
        if p.name in fail:
            raise RuntimeError("exiftool says no")
        calls.append(p.name)
        xmp = p.with_suffix(".xmp")
        xmp.write_text("<x:xmpmeta xmlns:x='adobe:ns:meta/'/>")
        st = xmp.stat()
        os.utime(xmp, ns=(st.st_atime_ns, st.st_mtime_ns + len(calls) * 1_000_000))
        return xmp

    monkeypatch.setattr(sidecar, "write_gps", write)
    return calls, fail


def _run(client, limit, after_id=0):
    r = client.post("/api/geocode/export-sidecars", json={"limit": limit, "after_id": after_id})
    assert r.status_code == 200
    return r.json()


def _loop(client, limit) -> list[dict]:
    """Drive the export the way home.js does: follow `cursor` until remaining == 0."""
    batches, cursor = [], 0
    while True:
        out = _run(client, limit, cursor)
        batches.append(out)
        cursor = out["cursor"]
        if out["remaining"] == 0:
            return batches


def test_export_batches_follow_the_cursor_until_nothing_remains(client, tmp_path, fake_write):
    calls, _ = fake_write
    ids = [_photo(tmp_path, f"p{i}.jpg", 10.0 + i, 20.0) for i in range(5)]
    _photo(tmp_path, "untagged.jpg")

    batches = _loop(client, limit=2)
    assert [b["processed"] for b in batches] == [2, 2, 1]
    assert [b["remaining"] for b in batches] == [3, 1, 0]
    assert [b["cursor"] for b in batches] == [ids[1], ids[3], ids[4]]
    assert sorted(calls) == [f"p{i}.jpg" for i in range(5)]
    assert index.count_photos_to_export() == 0


def test_export_resumes_after_a_restart_without_redoing_finished_photos(client, tmp_path, fake_write):
    """A run abandoned midway (tab closed, server restarted) is picked up by a
    fresh run from cursor 0 with only the unfinished photos left."""
    calls, _ = fake_write
    for i in range(5):
        _photo(tmp_path, f"p{i}.jpg", 10.0 + i, 20.0)
    assert _run(client, limit=2)["remaining"] == 3
    calls.clear()

    batches = _loop(client, limit=10)
    assert batches[0]["processed"] == 3 and batches[-1]["remaining"] == 0
    assert sorted(calls) == ["p2.jpg", "p3.jpg", "p4.jpg"]


def test_export_requeues_a_photo_when_its_values_or_sidecar_change(client, tmp_path, fake_write):
    calls, _ = fake_write
    a = _photo(tmp_path, "a.jpg", 10.0, 20.0)
    b = _photo(tmp_path, "b.jpg", 11.0, 21.0)
    c = _photo(tmp_path, "c.jpg", 12.0, 22.0)
    _loop(client, limit=10)
    assert index.count_photos_to_export() == 0

    # Newly geocoded (place names now to write), re-geotagged, and a sidecar
    # changed since by something else (a scan re-read it: new tracked mtime).
    index.update_photo_location(a, {"city": "Paris", "country": "France", "country_code": "FR"})
    with index.transaction() as db:
        db.execute("UPDATE photos SET lat=13.5 WHERE id=?", (b,))
        db.execute("UPDATE photos SET sidecar_mtime=sidecar_mtime+1 WHERE id=?", (c,))
    assert index.count_photos_to_export() == 3
    calls.clear()
    _loop(client, limit=10)
    assert sorted(calls) == ["a.jpg", "b.jpg", "c.jpg"]
    assert index.count_photos_to_export() == 0

    # A photo whose geotag is removed drops out of the set entirely.
    with index.transaction() as db:
        db.execute("UPDATE photos SET lat=NULL, lng=NULL, loc_city='Lyon' WHERE id=?", (a,))
    assert index.count_photos_to_export() == 0


def test_export_failure_is_stepped_past_then_retried_next_run(client, tmp_path, fake_write):
    """A file that keeps failing can't stall the loop (the cursor moves past it)
    and stays queued, so the next run retries only it."""
    calls, fail = fake_write
    ids = [_photo(tmp_path, f"p{i}.jpg", 10.0 + i, 20.0) for i in range(4)]
    fail.add("p1.jpg")

    batches = _loop(client, limit=1)
    assert len(batches) == 4 and batches[-1]["remaining"] == 0
    assert sum(b["failed"] for b in batches) == 1
    assert index.count_photos_to_export() == 1

    fail.clear()
    calls.clear()
    out = _run(client, limit=10)
    assert out["processed"] == 1 and out["written"] == 1 and out["cursor"] == ids[1]
    assert calls == ["p1.jpg"] and out["remaining"] == 0


def test_export_leaves_photo_queued_if_it_changed_during_the_write(client, tmp_path, monkeypatch):
    """A geotag landing while ExifTool writes the old values: the sidecar is
    stale, so the export signature must not be recorded."""
    pid = _photo(tmp_path, "race.jpg", 10.0, 20.0)

    def write(p, lat, lng, location=None, gps_accuracy=None):
        with index.transaction() as db:
            db.execute("UPDATE photos SET lat=lat+1 WHERE id=?", (pid,))
        xmp = p.with_suffix(".xmp")
        xmp.write_text("<x:xmpmeta xmlns:x='adobe:ns:meta/'/>")
        return xmp

    monkeypatch.setattr(sidecar, "write_gps", write)
    assert _run(client, limit=10)["written"] == 1
    assert index.count_photos_to_export() == 1


@pytest.mark.parametrize("body", [{"limit": 0}, {"limit": 100_000}, {"after_id": -1}])
def test_export_rejects_out_of_range_params(client, body):
    assert client.post("/api/geocode/export-sidecars", json=body).status_code == 422


def test_export_photo_with_embedded_gps_and_no_accuracy_tag(et_session, client, tmp_path):
    """A camera fix with no GPSHPositioningError scans as gps_accuracy -1.0 (the
    "unknown" sentinel read_metadata reports, kept so is_fresh doesn't re-read
    the file). Export passed that straight to write_gps, which rejects negative
    accuracy — so every such photo failed with "invalid gps_accuracy: -1.0"."""
    img = tmp_path / "cam.jpg"
    Image.new("RGB", (8, 8), "blue").save(img, "JPEG")
    # Test fixture only: give the throwaway JPEG embedded GPS (no accuracy tag).
    with exiftool_session.get_et_lock():
        exiftool_session.get_et().execute(
            "-overwrite_original", "-GPSLatitude=40.5", "-GPSLatitudeRef=N",
            "-GPSLongitude=74.25", "-GPSLongitudeRef=W", str(img))
    meta = sidecar.read_metadata(img)
    assert (meta["geotag_source"], meta["gps_accuracy"]) == ("embedded", -1.0)
    index.upsert_photo(
        filename=img.name, dir_=str(tmp_path), ext=".jpg", media_type="image",
        mtime=img.stat().st_mtime, size=img.stat().st_size,
        lat=meta["lat"], lng=meta["lng"], geotag_source=meta["geotag_source"],
        sidecar_path=None, sidecar_mtime=None, camera=meta["camera"],
        photo_datetime=meta["photo_datetime"], gps_accuracy=meta["gps_accuracy"],
        orientation=meta["orientation"],
    )

    r = client.post("/api/geocode/export-sidecars")
    assert r.status_code == 200
    body = r.json()
    assert (body["written"], body["failed"], body["errors_sample"]) == (1, 0, [])

    xmp = sidecar.sidecar_path(img)
    tags = _xmp_tags(xmp, "XMP:GPSLatitude", "XMP:GPSLongitude", "XMP:GPSHPositioningError")
    assert float(tags["XMP:GPSLatitude"]) == pytest.approx(40.5)
    assert float(tags["XMP:GPSLongitude"]) == pytest.approx(-74.25)
    assert "XMP:GPSHPositioningError" not in tags
