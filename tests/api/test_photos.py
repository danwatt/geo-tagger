"""Endpoint tests for geotagger.api.photos (listing, filtering, area search, detail)."""

import json

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
                      "dir", "location"}


def test_context_filter_uses_polygon_and_dates(client):
    poly = [[9, 19], [9, 21], [11, 21], [11, 19]]
    cid = index.create_context("Trip", json.dumps(poly), 500, 1500, 9, 11, 19, 21)
    _add("in.jpg", lat=10, lng=20, dt=1000)     # inside polygon + date window
    _add("out_geo.jpg", lat=50, lng=50, dt=1000)  # outside polygon
    _add("out_time.jpg", lat=10, lng=20, dt=9999)  # inside polygon, outside dates
    names = [p["filename"] for p in client.get(f"/api/photos?context_id={cid}").json()]
    assert names == ["in.jpg"]


def test_context_not_found_404(client):
    assert client.get("/api/photos?context_id=999").status_code == 404


def test_by_area_radius(client):
    _add("near.jpg", lat=10.0, lng=20.0, dt=1000)
    _add("far.jpg", lat=11.0, lng=21.0, dt=1000)
    r = client.get("/api/photos/by-area?lat=10.0&lng=20.0&radius=100").json()
    assert [p["filename"] for p in r] == ["near.jpg"]


def test_missing_ids_404(client):
    assert client.get("/api/thumbnail/999").status_code == 404
    assert client.get("/api/preview/999").status_code == 404
    assert client.get("/api/photo/999").status_code == 404
    assert client.get("/api/photo/999/fullsize").status_code == 404


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
    index.get_db().execute(
        "INSERT INTO faces (photo_id, person_id, bbox, det_score, embedding, source, "
        "ignored, created_at) VALUES (?, NULL, '0.1,0.1,0.4,0.4', 0.9, X'00', 'detected', 0, 0)",
        (pid,),
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
