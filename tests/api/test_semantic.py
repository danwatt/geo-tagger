"""Endpoint tests for semantic search: /api/semantic/*, /api/search?text=…,
/api/photos/{id}/similar and the Data page model status. Uses the `fake_semantic`
fixture, so no real model is downloaded or run."""

from geotagger import index


def _add(name, dt=1000, camera="c"):
    index.upsert_photo(
        filename=name, dir_=".", ext=".jpg", media_type="image", mtime=1.0, size=1,
        lat=None, lng=None, geotag_source="none", sidecar_path=None, sidecar_mtime=None,
        camera=camera, photo_datetime=dt, gps_accuracy=None, orientation=1,
    )
    return index.get_db().execute("SELECT id FROM photos WHERE filename=?", (name,)).fetchone()[0]


def _index_all(client):
    remaining, rounds = None, 0
    while remaining != 0:
        r = client.post("/api/semantic/scan", json={"limit": 2})
        assert r.status_code == 200
        remaining = r.json()["remaining"]
        rounds += 1
        assert rounds < 20
    return rounds


def test_scan_loop_walks_remaining_to_zero(client, fake_semantic):
    for n in ("red_1.jpg", "green_1.jpg", "blue_1.jpg", "red_2.jpg", "grey.jpg"):
        _add(n)
    assert client.get("/api/semantic/status").json()["remaining"] == 5
    assert _index_all(client) == 3
    s = client.get("/api/semantic/status").json()
    assert s == {**s, "available": True, "embedded": 5, "remaining": 0, "total": 5}


def test_text_search_ranks_and_scores(client, fake_semantic):
    red, _, _ = _add("red_1.jpg"), _add("green_1.jpg"), _add("blue_1.jpg")
    _index_all(client)
    r = client.get("/api/search", params={"text": "something red"}).json()
    assert r["photos"][0]["id"] == red
    assert all("score" in p for p in r["photos"])
    scores = [p["score"] for p in r["photos"]]
    assert scores == sorted(scores, reverse=True)


def test_text_search_combines_with_filters(client, fake_semantic):
    _add("red_1.jpg", camera="canon")
    nikon_red = _add("red_2.jpg", camera="nikon")
    _add("blue_1.jpg", camera="nikon")
    _index_all(client)
    r = client.get("/api/search", params={"text": "red", "camera": "nikon"}).json()
    assert [p["id"] for p in r["photos"]][0] == nikon_red
    assert all(p["camera"] == "nikon" for p in r["photos"])


def test_text_search_threshold_drops_poor_matches(client, fake_semantic, monkeypatch):
    from geotagger import config
    _add("red_1.jpg"), _add("blue_1.jpg")
    _index_all(client)
    monkeypatch.setattr(config, "SEMANTIC_MIN_SCORE", 0.9)
    r = client.get("/api/search", params={"text": "red"}).json()
    assert [p["filename"] for p in r["photos"]] == ["red_1.jpg"]


def test_text_search_date_sort_keeps_filter(client, fake_semantic, monkeypatch):
    from geotagger import config
    _add("red_late.jpg", dt=2000)
    _add("red_early.jpg", dt=1000)
    _add("blue_1.jpg", dt=1500)
    _index_all(client)
    monkeypatch.setattr(config, "SEMANTIC_MIN_SCORE", 0.9)
    r = client.get("/api/search", params={"text": "red", "sort": "date_asc"}).json()
    assert [p["filename"] for p in r["photos"]] == ["red_early.jpg", "red_late.jpg"]


def test_relevance_without_query_is_400(client):
    assert client.get("/api/search", params={"sort": "relevance"}).status_code == 400


def test_text_and_similar_together_is_400(client, fake_semantic):
    pid = _add("red_1.jpg")
    r = client.get("/api/search", params={"text": "red", "similar_to": pid})
    assert r.status_code == 400


def test_text_search_409_without_model(client, tmp_path):
    from geotagger import semantic
    semantic.init_semantic(tmp_path)  # cache dir, but no model files
    _add("a.jpg")
    r = client.get("/api/search", params={"text": "red"})
    assert r.status_code == 409 and "Data Management" in r.json()["detail"]
    assert client.post("/api/semantic/scan", json={"limit": 1}).status_code == 409


def test_plain_search_unaffected(client):
    _add("a.jpg", dt=2000), _add("b.jpg", dt=1000)
    r = client.get("/api/search").json()
    assert [p["filename"] for p in r["photos"]] == ["b.jpg", "a.jpg"]
    assert all("score" not in p for p in r["photos"])


def test_similar_endpoint(client, fake_semantic):
    red, red2, _ = _add("red_1.jpg"), _add("red_2.jpg"), _add("blue_1.jpg")
    _index_all(client)
    r = client.get(f"/api/photos/{red}/similar").json()
    ids = [p["id"] for p in r["photos"]]
    assert ids[0] == red2 and red not in ids
    # Also reachable through /api/search so it combines with filters.
    r = client.get("/api/search", params={"similar_to": red}).json()
    assert r["photos"][0]["id"] == red2


def test_similar_errors(client, fake_semantic):
    assert client.get("/api/photos/99999/similar").status_code == 404
    pid = _add("red_1.jpg")  # not indexed yet
    assert client.get(f"/api/photos/{pid}/similar").status_code == 400


def test_data_status_reports_semantic_model(client, fake_semantic):
    m = client.get("/api/data/status").json()["semantic_model"]
    assert m["available"] is True and m["name"]
    assert client.get("/api/data/semantic-model/download/status").json()["running"] is False


def test_ranked_search_pages_top_matches_with_true_total(client, fake_semantic, monkeypatch):
    from geotagger import config
    monkeypatch.setattr(config, "SEMANTIC_MIN_SCORE", -1.0)   # keep every candidate
    for n in ("red_1.jpg", "red_2.jpg", "red_3.jpg", "blue_1.jpg", "green_1.jpg"):
        _add(n)
    _index_all(client)
    full = client.get("/api/search", params={"text": "red"}).json()
    assert full["total"] == 5 and full["truncated"] is False
    ids, offset = [], 0
    while offset is not None:
        page = client.get("/api/search", params={"text": "red", "limit": 2, "offset": offset}).json()
        assert page["total"] == 5
        ids += [p["id"] for p in page["photos"]]
        offset = page["next_offset"]
    assert ids == [p["id"] for p in full["photos"]]   # pages walk the relevance order
    first = client.get("/api/search", params={"text": "red", "limit": 2}).json()
    assert first["truncated"] is True and len(first["photos"]) == 2
    # The timeline counts all five hits, not the two on this page.
    assert first["histogram"]["counts"] == [5]
    only = client.get("/api/search", params={"text": "red", "ids_only": "true"}).json()
    assert only["ids"] == ids and only["total"] == 5


def test_ranked_search_date_sort_pages(client, fake_semantic, monkeypatch):
    from geotagger import config
    monkeypatch.setattr(config, "SEMANTIC_MIN_SCORE", 0.9)
    late, early = _add("red_late.jpg", dt=2000), _add("red_early.jpg", dt=1000)
    _add("blue_1.jpg", dt=1500)
    _index_all(client)
    r = client.get("/api/search", params={"text": "red", "sort": "date_asc", "limit": 1}).json()
    assert [p["id"] for p in r["photos"]] == [early] and r["total"] == 2 and r["next_offset"] == 1
    r = client.get("/api/search", params={"text": "red", "sort": "date_asc", "limit": 1,
                                          "offset": 1}).json()
    assert [p["id"] for p in r["photos"]] == [late] and r["next_offset"] is None
    assert r["histogram"]["min"] == 1000 and r["histogram"]["max"] == 2000
