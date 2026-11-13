"""Endpoint tests for geotagger.api.photos (listing, filtering, area search, detail)."""

import json

import pytest

from geotagger import index


def _add(path, lat=None, lng=None, dt=1000):
    index.upsert_photo(
        filename=path, dir_=".", ext=".jpg", media_type="image",
        mtime=1.0, size=1, lat=lat, lng=lng,
        geotag_source="sidecar" if lat is not None else "none",
        sidecar_path=None, sidecar_mtime=None, camera="c",
        photo_datetime=dt, gps_accuracy=None, orientation=1,
    )
    return index.get_db().execute("SELECT id FROM photos WHERE filename=?", (path,)).fetchone()[0]


def test_geotagged_filter(client):
    _add("t.jpg", lat=10, lng=20, dt=1000)
    _add("u.jpg", dt=2000)
    assert len(client.get("/api/photos").json()) == 2
    assert [p["filename"] for p in client.get("/api/photos?geotagged=yes").json()] == ["t.jpg"]
    assert [p["filename"] for p in client.get("/api/photos?geotagged=no").json()] == ["u.jpg"]


def test_photo_list_shape(client):
    _add("t.jpg", lat=10, lng=20)
    p = client.get("/api/photos").json()[0]
    assert set(p) == {"id", "filename", "media_type", "lat", "lng", "geotag_source",
                      "camera", "photo_datetime", "gps_accuracy", "geocode_ignored",
                      "date_precision", "dir", "location"}


def test_ids_filter(client):
    a = _add("a.jpg", dt=1000)
    _add("b.jpg", dt=2000)
    c = _add("c.jpg", dt=3000)
    r = client.get(f"/api/photos?ids={a},{c}").json()
    assert {p["filename"] for p in r} == {"a.jpg", "c.jpg"}


def test_ids_filter_overrides_other_filters(client):
    a = _add("a.jpg", lat=10, lng=20, dt=1000)
    r = client.get(f"/api/photos?ids={a}&geotagged=no").json()
    assert [p["filename"] for p in r] == ["a.jpg"]


def test_ids_filter_invalid_400(client):
    assert client.get("/api/photos?ids=abc").status_code == 400


def test_assign_date_rejects_empty_selection(client):
    r = client.post("/api/photos/assign-date", json={"photo_ids": [], "year": 2020})
    assert r.status_code == 400


def test_assign_date_rejects_bad_year(client):
    a = _add("a.jpg", dt=1000)
    assert client.post("/api/photos/assign-date",
                       json={"photo_ids": [a], "year": 1000}).status_code == 400
    assert client.post("/api/photos/assign-date",
                       json={"photo_ids": [a], "year": 3000}).status_code == 400


def test_assign_date_rejects_bad_month(client):
    a = _add("a.jpg", dt=1000)
    r = client.post("/api/photos/assign-date",
                    json={"photo_ids": [a], "year": 2020, "month": 13})
    assert r.status_code == 400


def test_by_area_radius(client):
    _add("near.jpg", lat=10.0, lng=20.0, dt=1000)
    _add("far.jpg", lat=11.0, lng=21.0, dt=1000)
    r = client.get("/api/photos/by-area?lat=10.0&lng=20.0&radius=100").json()
    assert [p["filename"] for p in r] == ["near.jpg"]


def test_by_bounds_box(client):
    _add("in.jpg", lat=10.0, lng=20.0, dt=1000)
    _add("out.jpg", lat=15.0, lng=25.0, dt=1000)
    r = client.get("/api/photos/by-bounds?min_lat=9&max_lat=11&min_lng=19&max_lng=21").json()
    assert [p["filename"] for p in r] == ["in.jpg"]


def test_by_bounds_folds_in_untagged_within_window(client):
    _add("geo.jpg", lat=10.0, lng=20.0, dt=1000)
    _add("untagged_near.jpg", dt=1300)   # 300s away, inside default 900s window
    _add("untagged_far.jpg", dt=9999)    # outside window — excluded
    names = {p["filename"] for p in
             client.get("/api/photos/by-bounds?min_lat=9&max_lat=11&min_lng=19&max_lng=21").json()}
    assert names == {"geo.jpg", "untagged_near.jpg"}


def test_by_location_region_and_time_candidates(client):
    for state in ("Texas", "Oregon"):
        pid = _add(f"{state}.jpg", lat=30, lng=-96, dt=1000)
        index.get_db().execute(
            "UPDATE photos SET loc_county='Washington County', loc_state=? WHERE id=?",
            (state, pid),
        )
    index.get_db().commit()
    _add("untagged_near.jpg", dt=1300)
    _add("untagged_far.jpg", dt=9999)
    params = {"location_fields": json.dumps({"loc_county": "Washington County", "loc_state": "Texas"})}
    result = client.get("/api/photos/by-location", params=params)
    assert result.status_code == 200
    assert {p["filename"] for p in result.json()} == {"Texas.jpg", "untagged_near.jpg"}
    params["window"] = 0
    assert [p["filename"] for p in client.get("/api/photos/by-location", params=params).json()] == ["Texas.jpg"]
    params.update(window=900, geotagged="no")
    assert [p["filename"] for p in client.get("/api/photos/by-location", params=params).json()] == ["untagged_near.jpg"]


def test_by_location_invalid_or_empty(client):
    assert client.get("/api/photos/by-location", params={"location_fields": '{"loc_city":"Missing"}'}).json() == []
    for value in ('{}', '[]', 'null', '{"id":"1"}', 'bad'):
        assert client.get("/api/photos/by-location", params={"location_fields": value}).status_code == 400


def test_missing_ids_404(client):
    assert client.get("/api/thumbnail/999").status_code == 404
    assert client.get("/api/preview/999").status_code == 404
    assert client.get("/api/photo/999").status_code == 404
    assert client.get("/api/photo/999/fullsize").status_code == 404


def test_thumbnail_and_preview_serve_the_rendition_format(client, thumbs_dir, tmp_path):
    """Both routes must advertise thumbnails.media_type(), not a hardcoded image/jpeg —
    the cached renditions are WebP by default."""
    import io
    from PIL import Image
    from geotagger import thumbnails

    p = tmp_path / "shot.jpg"
    Image.new("RGB", (300, 200), (20, 180, 90)).save(p, "JPEG")
    index.upsert_photo(
        filename="shot.jpg", dir_=str(tmp_path), ext=".jpg",
        media_type="image", mtime=1.0, size=1, lat=None, lng=None,
        geotag_source="none", sidecar_path=None, sidecar_mtime=None, orientation=1,
    )
    pid = index.get_db().execute(
        "SELECT id FROM photos WHERE dir=? AND filename=?", (str(tmp_path), "shot.jpg")
    ).fetchone()[0]

    for route in (f"/api/thumbnail/{pid}", f"/api/preview/{pid}"):
        r = client.get(route)
        assert r.status_code == 200
        assert r.headers["content-type"] == thumbnails.media_type()
        assert Image.open(io.BytesIO(r.content)).format == "WEBP"


def test_fullsize_renders_jpeg_with_face_boxes(client, tmp_path):
    import io
    from PIL import Image, ImageDraw

    # A real image on disk so the on-the-fly render can decode it (non-RAW path).
    p = tmp_path / "shot.jpg"
    img = Image.new("RGB", (120, 90), (200, 50, 50))
    ImageDraw.Draw(img).rectangle([10, 10, 60, 60], fill=(40, 40, 200))
    img.save(p, "JPEG")
    index.upsert_photo(
        filename="shot.jpg", dir_=str(tmp_path), ext=".jpg",
        media_type="image", mtime=1.0, size=1, lat=None, lng=None,
        geotag_source="none", sidecar_path=None, sidecar_mtime=None, orientation=1,
    )
    pid = index.get_db().execute(
        "SELECT id FROM photos WHERE dir=? AND filename=?", (str(tmp_path), "shot.jpg")
    ).fetchone()[0]
    # A detected face so the box-drawing branch runs.
    cur = index.get_db().execute(
        "INSERT INTO faces (photo_id, person_id, bbox, det_score, source, "
        "ignored, created_at) VALUES (?, NULL, '0.1,0.1,0.4,0.4', 0.9, 'detected', 0, 0)",
        (pid,),
    )
    index.get_db().execute(
        "INSERT INTO face_embeddings (face_id, embedding) VALUES (?, X'00')",
        (cur.lastrowid,),
    )
    index.get_db().commit()

    r = client.get(f"/api/photo/{pid}/fullsize")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/jpeg"
    out = Image.open(io.BytesIO(r.content))
    assert out.size == (120, 90)   # full resolution, upright


def test_photo_detail(client):
    pid = _add("d.jpg", lat=10, lng=20, dt=1000)
    p = client.get(f"/api/photo/{pid}").json()
    assert p["id"] == pid
    assert p["filename"] == "d.jpg"
    assert p["lat"] == 10 and p["lng"] == 20


def _add_real_file(tmp_path, name, content=b"fake-photo-bytes"):
    p = tmp_path / name
    p.write_bytes(content)
    index.upsert_photo(
        filename=name, dir_=str(tmp_path), ext=p.suffix, media_type="image",
        mtime=1.0, size=len(content), lat=None, lng=None,
        geotag_source="none", sidecar_path=None, sidecar_mtime=None, orientation=1,
    )
    return index.get_db().execute(
        "SELECT id FROM photos WHERE dir=? AND filename=?", (str(tmp_path), name)
    ).fetchone()[0]


def test_download_zip(client, tmp_path):
    import zipfile
    from io import BytesIO

    id1 = _add_real_file(tmp_path, "a.jpg", b"AAAA")
    id2 = _add_real_file(tmp_path, "b.raw", b"BBBB")

    r = client.post("/api/photos/download-zip", json={"photo_ids": [id1, id2]})
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/zip"
    zf = zipfile.ZipFile(BytesIO(r.content))
    names = sorted(zf.namelist())
    assert names == ["a.jpg", "b.raw"]
    assert zf.read("a.jpg") == b"AAAA"
    assert zf.read("b.raw") == b"BBBB"


def test_download_zip_empty_400(client):
    r = client.post("/api/photos/download-zip", json={"photo_ids": []})
    assert r.status_code == 400


def test_download_zip_dedupes_duplicate_filenames(client, tmp_path):
    import zipfile
    from io import BytesIO

    dir1 = tmp_path / "d1"
    dir2 = tmp_path / "d2"
    dir1.mkdir()
    dir2.mkdir()
    id1 = _add_real_file(dir1, "same.jpg", b"ONE")
    id2 = _add_real_file(dir2, "same.jpg", b"TWO")

    r = client.post("/api/photos/download-zip", json={"photo_ids": [id1, id2]})
    assert r.status_code == 200
    zf = zipfile.ZipFile(BytesIO(r.content))
    assert sorted(zf.namelist()) == ["same (1).jpg", "same.jpg"]


def _zip_temp_files():
    import tempfile
    from pathlib import Path
    return list(Path(tempfile.gettempdir()).glob("geotagger-zip-*.zip"))


def test_download_zip_missing_file_skipped_and_reported(client, tmp_path):
    import zipfile
    from io import BytesIO

    id1 = _add_real_file(tmp_path, "a.jpg", b"AAAA")
    id2 = _add_real_file(tmp_path, "gone.jpg", b"GG")
    (tmp_path / "gone.jpg").unlink()

    r = client.post("/api/photos/download-zip", json={"photo_ids": [id1, id2, 99999]})
    assert r.status_code == 200
    assert r.headers["x-skipped-files"] == "2"
    assert zipfile.ZipFile(BytesIO(r.content)).namelist() == ["a.jpg"]


def test_download_zip_all_missing_404(client, tmp_path):
    id1 = _add_real_file(tmp_path, "gone.jpg", b"GG")
    (tmp_path / "gone.jpg").unlink()
    r = client.post("/api/photos/download-zip", json={"photo_ids": [id1, 99999]})
    assert r.status_code == 404
    r = client.post("/api/photos/download-zip?check=1", json={"photo_ids": [id1]})
    assert r.status_code == 404


def test_download_zip_over_cap_413(client, tmp_path, monkeypatch):
    from geotagger import config
    id1 = _add_real_file(tmp_path, "a.jpg", b"A" * 600)
    id2 = _add_real_file(tmp_path, "b.jpg", b"B" * 600)
    monkeypatch.setattr(config, "ZIP_MAX_BYTES", 1000)
    before = _zip_temp_files()
    for url in ("/api/photos/download-zip", "/api/photos/download-zip?check=1"):
        r = client.post(url, json={"photo_ids": [id1, id2]})
        assert r.status_code == 413
        assert "GEOTAGGER_ZIP_MAX_BYTES" in r.json()["detail"]
    assert _zip_temp_files() == before  # rejected before any archive was built
    # Under the cap it still works; 0 disables the cap.
    assert client.post("/api/photos/download-zip", json={"photo_ids": [id1]}).status_code == 200
    monkeypatch.setattr(config, "ZIP_MAX_BYTES", 0)
    assert client.post("/api/photos/download-zip", json={"photo_ids": [id1, id2]}).status_code == 200


def test_download_zip_check_reports_counts(client, tmp_path):
    id1 = _add_real_file(tmp_path, "a.jpg", b"AAAA")
    id2 = _add_real_file(tmp_path, "b.jpg", b"BB")
    r = client.post("/api/photos/download-zip?check=1", json={"photo_ids": [id1, id2, 99999]})
    assert r.status_code == 200
    assert r.json() == {"count": 2, "total_bytes": 6, "skipped": 1}


def test_download_zip_form_post(client, tmp_path):
    """The browser's navigation download posts a urlencoded form, not JSON."""
    import zipfile
    from io import BytesIO

    id1 = _add_real_file(tmp_path, "a.jpg", b"AAAA")
    id2 = _add_real_file(tmp_path, "b.raw", b"BBBB")
    r = client.post("/api/photos/download-zip",
                    content=f"photo_ids={id1}%2C{id2}",
                    headers={"Content-Type": "application/x-www-form-urlencoded"})
    assert r.status_code == 200
    assert 'attachment; filename="photos-2.zip"' in r.headers["content-disposition"]
    assert sorted(zipfile.ZipFile(BytesIO(r.content)).namelist()) == ["a.jpg", "b.raw"]
    bad = client.post("/api/photos/download-zip", content="photo_ids=1,abc",
                      headers={"Content-Type": "application/x-www-form-urlencoded"})
    assert bad.status_code == 400


def test_download_zip_temp_file_removed_after_response(client, tmp_path):
    id1 = _add_real_file(tmp_path, "a.jpg", b"AAAA")
    before = set(_zip_temp_files())
    r = client.post("/api/photos/download-zip", json={"photo_ids": [id1]})
    assert r.status_code == 200
    assert r.headers["content-length"] == str(len(r.content))
    assert set(_zip_temp_files()) == before


def test_download_zip_is_not_built_in_memory():
    """Structural guard: the archive goes to a temp file, never a BytesIO."""
    import inspect
    from geotagger.services import zip_service
    src = inspect.getsource(zip_service)
    assert "BytesIO" not in src and "getvalue" not in src
    assert "mkstemp" in src


# ── Undo date commit: client-supplied snapshots reach ExifTool args ──

def _snap(**over):
    return {"photo_id": 1, "raw_datetime": None, "photo_datetime": None,
            "date_precision": None, **over}


def test_undo_date_commit_rejects_injected_raw_datetime(client):
    """pyexiftool joins args with newlines, so a newline inside the value would
    smuggle extra ExifTool arguments (including another target file)."""
    for bad in ["2011:10:27 00:00:00\n-XMP:Title=pwned",
                "2011:10:27 00:00:00\r\n-all=",
                "2011:10:27 00:00:00\n",
                "not a date",
                "-overwrite_original"]:
        r = client.post("/api/photos/undo-date-commit",
                        json={"previous": [_snap(raw_datetime=bad)]})
        assert r.status_code == 422, bad


def test_undo_date_commit_rejects_malformed_snapshots(client):
    post = lambda snap: client.post("/api/photos/undo-date-commit", json={"previous": [snap]})
    assert post(_snap(date_precision="decade")).status_code == 422
    assert post(_snap(photo_datetime="yesterday")).status_code == 422
    assert post({"raw_datetime": None}).status_code == 422  # no photo_id


def test_commit_then_undo_round_trips_through_the_api(client, tmp_path):
    """The snapshots commit returns — including a real ExifTool-read
    raw_datetime string — must pass the undo route's validation."""
    import pytest
    from PIL import Image
    from geotagger import exiftool_session
    if exiftool_session._et is None:
        pytest.skip("ExifTool unavailable")
    Image.new("RGB", (8, 8), color="blue").save(tmp_path / "t.jpg", "JPEG")
    index.upsert_photo(
        filename="t.jpg", dir_=str(tmp_path), ext=".jpg", media_type="image",
        mtime=1.0, size=1, lat=None, lng=None, geotag_source="none",
        sidecar_path=None, sidecar_mtime=None, camera="", photo_datetime=0,
        gps_accuracy=-1.0, orientation=1,
    )
    pid = index.get_db().execute("SELECT id FROM photos").fetchone()[0]
    entry = lambda year: {"entries": [{"photo_id": pid, "year": year, "precision": "year"}]}

    first = client.post("/api/photos/commit-guessed-dates", json=entry(2001)).json()
    second = client.post("/api/photos/commit-guessed-dates", json=entry(2005)).json()
    assert second["previous"][0]["raw_datetime"]  # a string ExifTool read back

    r = client.post("/api/photos/undo-date-commit", json={"previous": second["previous"]})
    assert r.status_code == 200 and r.json() == {"reverted": 1}
    assert index.get_photo(pid)["date_precision"] == "year"
    r = client.post("/api/photos/undo-date-commit", json={"previous": first["previous"]})
    assert r.status_code == 200 and r.json() == {"reverted": 1}
    assert index.get_photo(pid)["date_precision"] is None


# ── /api/photos/update-times (absolute, retry-safe time corrections) ──

def _dt(pid):
    return index.get_db().execute("SELECT photo_datetime FROM photos WHERE id=?", (pid,)).fetchone()[0]


def _stub_write(monkeypatch, fail_names=()):
    """Replace the ExifTool sidecar write; record calls, fail for files named in
    `fail_names` (a mutable set, so a test can 'fix' the fault between requests)."""
    from geotagger import sidecar
    calls = []

    def fake(p, ts):
        calls.append((p.name, ts))
        if p.name in fail_names:
            raise RuntimeError("exiftool exploded\nwith a traceback")
        return p.with_suffix(".xmp")

    monkeypatch.setattr(sidecar, "write_datetime", fake)
    return calls


def _upd(pid, expected, target):
    return {"id": pid, "expected": expected, "target": target}


def test_update_times_retry_after_partial_failure_applies_once(client, monkeypatch):
    """The D8 regression: a failure mid-batch followed by re-sending the identical
    request must leave every photo shifted exactly once, not twice."""
    ids = [_add(f"r{i}.jpg", dt=1_600_000_000 + i) for i in range(3)]
    fail = {"r1.jpg"}
    calls = _stub_write(monkeypatch, fail)
    body = {"updates": [_upd(i, 1_600_000_000 + n, 1_600_000_000 + n + 3600) for n, i in enumerate(ids)]}

    r = client.post("/api/photos/update-times", json=body)
    assert r.status_code == 200
    out = r.json()
    assert out["written"] == [ids[0], ids[2]]
    assert out["failed"] == [{"id": ids[1], "error": "exiftool exploded"}]
    assert _dt(ids[1]) == 1_600_000_001            # failed photo's row untouched

    fail.clear()                                   # the fault goes away; client retries as-is
    r = client.post("/api/photos/update-times", json=body)
    assert r.status_code == 200 and r.json()["failed"] == []
    assert [_dt(i) for i in ids] == [1_600_003_600, 1_600_003_601, 1_600_003_602]
    # the two photos that had already landed were not written a second time
    names = [c[0] for c in calls]
    assert names.count("r0.jpg") == 1 and names.count("r2.jpg") == 1
    unchanged = {x["id"]: x["unchanged"] for x in r.json()["results"]}
    assert unchanged == {ids[0]: True, ids[1]: False, ids[2]: True}


def test_update_times_conflict_is_not_applied(client, monkeypatch):
    a = _add("ca.jpg", dt=5000)
    b = _add("cb.jpg", dt=6000)
    calls = _stub_write(monkeypatch)
    r = client.post("/api/photos/update-times",
                    json={"updates": [_upd(a, 4000, 4600), _upd(b, 6000, 6600)]})
    assert r.status_code == 200
    out = r.json()
    assert out["written"] == [b]
    assert out["failed"][0]["id"] == a and out["failed"][0]["conflict"] is True
    assert _dt(a) == 5000 and _dt(b) == 6600
    assert [c[0] for c in calls] == ["cb.jpg"]


def test_update_times_all_conflicts_is_409(client, monkeypatch):
    a = _add("c409.jpg", dt=5000)
    _stub_write(monkeypatch)
    r = client.post("/api/photos/update-times", json={"updates": [_upd(a, 4000, 4600)]})
    assert r.status_code == 409 and r.json()["failed"][0]["conflict"] is True


def test_update_times_already_at_target_is_noop(client, monkeypatch):
    a = _add("noop.jpg", dt=7600)
    calls = _stub_write(monkeypatch)
    r = client.post("/api/photos/update-times", json={"updates": [_upd(a, 7000, 7600)]})
    assert r.status_code == 200
    out = r.json()
    assert out["written"] == [a] and out["results"][0]["unchanged"] is True
    assert calls == [] and _dt(a) == 7600


def test_update_times_all_failed_is_502_and_unknown_ids_404(client, monkeypatch):
    a = _add("f502.jpg", dt=5000)
    _stub_write(monkeypatch, {"f502.jpg"})
    r = client.post("/api/photos/update-times", json={"updates": [_upd(a, 5000, 5600)]})
    assert r.status_code == 502 and r.json()["written"] == [] and _dt(a) == 5000
    r = client.post("/api/photos/update-times", json={"updates": [_upd(98765, 5000, 5600)]})
    assert r.status_code == 404 and r.json()["not_found"] == [98765]
    assert client.post("/api/photos/update-times", json={"updates": []}).status_code == 200


def test_update_times_mixed_known_unknown(client, monkeypatch):
    a = _add("mix.jpg", dt=5000)
    _stub_write(monkeypatch)
    out = client.post("/api/photos/update-times",
                      json={"updates": [_upd(a, 5000, 5600), _upd(98765, 5000, 5600)]}).json()
    assert out["written"] == [a] and out["not_found"] == [98765]


def test_update_times_undated_photo_reported_failed(client, monkeypatch):
    a = _add("undated.jpg", dt=0)
    calls = _stub_write(monkeypatch)
    r = client.post("/api/photos/update-times", json={"updates": [_upd(a, 5000, 5600)]})
    assert r.status_code == 502
    assert r.json()["failed"] == [{"id": a, "error": "photo has no date to shift"}]
    assert calls == [] and _dt(a) == 0


@pytest.mark.parametrize("entry", [
    {"id": 1, "expected": 5000, "target": 0},               # 0 = undated, not a time
    {"id": 1, "expected": 0, "target": 5000},
    {"id": 1, "expected": 5000, "target": -9_999_999_999},  # before 1826
    {"id": 1, "expected": 5000, "target": 99_999_999_999},  # far future
])
def test_update_times_rejects_bad_timestamps(client, monkeypatch, entry):
    calls = _stub_write(monkeypatch)
    r = client.post("/api/photos/update-times", json={"updates": [entry]})
    assert r.status_code == 400 and calls == []


def test_update_times_rejects_non_integer_and_duplicate_ids(client, monkeypatch):
    a = _add("dup.jpg", dt=5000)
    _stub_write(monkeypatch)
    r = client.post("/api/photos/update-times",
                    json={"updates": [{"id": a, "expected": 5000, "target": 5000.5}]})
    assert r.status_code == 422
    r = client.post("/api/photos/update-times",
                    json={"updates": [_upd(a, 5000, 5600), _upd(a, 5000, 5700)]})
    assert r.status_code == 400 and _dt(a) == 5000


def test_update_times_pre_1970_target(client, monkeypatch):
    a = _add("old.jpg", dt=-500_000_000)          # 1954
    calls = _stub_write(monkeypatch)
    target = -500_000_000 + 86_400
    r = client.post("/api/photos/update-times",
                    json={"updates": [_upd(a, -500_000_000, target)]})
    assert r.status_code == 200 and r.json()["written"] == [a]
    assert _dt(a) == target and calls == [("old.jpg", target)]
    assert client.get(f"/api/photo/{a}").status_code == 200   # serializes a negative time


def test_update_times_db_failure_after_sidecar_is_failed(client, monkeypatch):
    from contextlib import contextmanager
    a = _add("dbf.jpg", dt=5000)
    _stub_write(monkeypatch)

    @contextmanager
    def broken():
        raise RuntimeError("db is locked")
        yield  # pragma: no cover

    with monkeypatch.context() as m:
        m.setattr(index, "transaction", broken)
        r = client.post("/api/photos/update-times", json={"updates": [_upd(a, 5000, 5600)]})
    assert r.status_code == 502 and r.json()["failed"] == [{"id": a, "error": "db is locked"}]
    assert _dt(a) == 5000


def test_update_times_invalidates_caches_when_written(client, monkeypatch):
    from geotagger.services import hotspots_service, work_queue_service
    a = _add("inv.jpg", dt=5000)
    _stub_write(monkeypatch)
    inval = []
    monkeypatch.setattr(hotspots_service, "invalidate", lambda: inval.append("hotspots"))
    monkeypatch.setattr(work_queue_service, "invalidate", lambda: inval.append("queue"))
    client.post("/api/photos/update-times", json={"updates": [_upd(a, 5000, 5600)]})
    assert inval == ["hotspots", "queue"]
