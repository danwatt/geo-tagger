"""Parameter validation (audit A4): malformed filters are 400s, never silently
dropped; non-positive limits are 422s, never SQLite's unlimited LIMIT -1."""

import pytest

BAD_BBOX = ["garbage", "1,2,3", "1,2,3,x", "nan,0,1,1"]


@pytest.mark.parametrize("bbox", BAD_BBOX)
def test_photos_bad_bbox_is_400(client, bbox):
    res = client.get("/api/photos", params={"bbox": bbox})
    assert res.status_code == 400
    assert "bbox" in res.json()["detail"]


@pytest.mark.parametrize("field", ["date_from", "date_to"])
def test_photos_bad_date_is_400(client, field):
    res = client.get("/api/photos", params={field: "2024-13-45"})
    assert res.status_code == 400
    assert "YYYY-MM-DD" in res.json()["detail"]


def test_photos_empty_filters_still_mean_no_filter(client):
    res = client.get("/api/photos", params={"bbox": "", "date_from": "", "date_to": ""})
    assert res.status_code == 200


def test_search_bad_bbox_and_date_are_400(client):
    assert client.get("/api/search", params={"bbox": "garbage"}).status_code == 400
    assert client.get("/api/search", params={"date_from": "nope"}).status_code == 400


def test_untagged_faces_bad_bbox_is_400(client):
    res = client.get("/api/search/untagged-faces", params={"person_ids": "1", "bbox": "garbage"})
    assert res.status_code == 400


@pytest.mark.parametrize("path", [
    "/api/geocode/places", "/api/geocode/voronoi", "/api/geocode/osm-places",
    "/api/geocode/census-places", "/api/geocode/zctas",
])
@pytest.mark.parametrize("limit", [0, -1])
def test_geocode_nonpositive_limit_is_422(client, path, limit):
    res = client.get(path, params={"bbox": "-1,-1,1,1", "limit": limit})
    assert res.status_code == 422


def test_by_location_limit_is_validated(client):
    fields = '{"country": "X"}'
    assert client.get("/api/photos/by-location",
                      params={"location_fields": fields, "limit": -1}).status_code == 422
    assert client.get("/api/photos/by-location",
                      params={"location_fields": fields, "limit": 99_999_999}).status_code == 422


@pytest.mark.parametrize("path,body", [
    ("/api/geocode/backfill", {"limit": -1}),
    ("/api/semantic/scan", {"limit": -1}),
    ("/api/faces/scan", {"limit": 0}),
    ("/api/geotag/propose", {"ids": [1], "limit": -1}),
])
def test_body_nonpositive_limit_is_422(client, path, body):
    assert client.post(path, json=body).status_code == 422
