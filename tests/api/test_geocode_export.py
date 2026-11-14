"""Endpoint tests for POST /api/geocode/export-sidecars (audit T2): the on-demand
DB-to-XMP catch-up for photos geotagged DB-only.

The route is a single call over every geotagged photo (no limit/remaining
batching), so these pin what one call writes, what it reports on a partial
failure, and the DB tracking it leaves behind. Real sidecar contents are read
back through ExifTool (et_session)."""

from pathlib import Path

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
    assert r.json() == {"written": 2, "errors": 0, "error_samples": []}

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

    # Idempotent: a second run rewrites the same values without error.
    assert client.post("/api/geocode/export-sidecars").json()["written"] == 2


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
    assert r.json() == {"written": 1, "errors": 1, "error_samples": ["bad.jpg: exiftool says no"]}
    assert written == ["ok.jpg"]
    assert _row(ok)["geotag_source"] == "sidecar" and _row(ok)["sidecar_path"] == "ok.xmp"
    assert tuple(_row(bad)) == (None, None, "database")


def test_export_error_samples_are_capped(client, tmp_path, monkeypatch):
    for i in range(7):
        _photo(tmp_path, f"f{i}.jpg", 1.0 + i, 2.0)

    def boom(*a, **k):
        raise RuntimeError("nope")

    monkeypatch.setattr(sidecar, "write_gps", boom)
    out = client.post("/api/geocode/export-sidecars").json()
    assert out["written"] == 0 and out["errors"] == 7 and len(out["error_samples"]) == 5


def test_export_empty_library(client):
    assert client.post("/api/geocode/export-sidecars").json() == {
        "written": 0, "errors": 0, "error_samples": []}
