"""Endpoint tests for geotagger.api.contexts (CRUD, validation, person links)."""


def _poly():
    return [[10, 20], [10, 21], [11, 20]]


def test_create_get_delete(client):
    payload = {"name": "Trip", "polygon": _poly(),
               "start_date": "2020-01-01", "end_date": "2020-01-31"}
    c = client.post("/api/contexts", json=payload).json()
    cid = c["id"]
    assert c["name"] == "Trip"
    assert c["start_date"] == "2020-01-01"
    assert c["end_date"] == "2020-02-01"  # end_ts is exclusive end-of-day
    assert c["polygon"] == _poly()

    assert any(x["id"] == cid for x in client.get("/api/contexts").json())
    assert client.delete(f"/api/contexts/{cid}").json() == {"success": True}
    assert all(x["id"] != cid for x in client.get("/api/contexts").json())


def test_create_rejects_short_polygon(client):
    r = client.post("/api/contexts", json={"name": "x", "polygon": [[0, 0], [1, 1]]})
    assert r.status_code == 400


def test_create_rejects_bad_date(client):
    r = client.post("/api/contexts", json={"name": "x", "polygon": _poly(),
                                           "start_date": "not-a-date"})
    assert r.status_code == 400


def test_create_rejects_start_after_end(client):
    r = client.post("/api/contexts", json={"name": "x", "polygon": _poly(),
                                           "start_date": "2020-02-01", "end_date": "2020-01-01"})
    assert r.status_code == 400


def test_patch_updates_fields(client):
    cid = client.post("/api/contexts", json={"name": "A", "polygon": _poly()}).json()["id"]
    assert client.patch(f"/api/contexts/{cid}", json={"name": "B"}).json()["name"] == "B"
    r = client.patch(f"/api/contexts/{cid}", json={"start_date": "2021-06-01"})
    assert r.json()["start_date"] == "2021-06-01"
    # Clearing a date sends null.
    assert client.patch(f"/api/contexts/{cid}", json={"start_date": None}).json()["start_date"] is None


def test_patch_missing_404(client):
    assert client.patch("/api/contexts/999", json={"name": "x"}).status_code == 404


def test_patch_empty_name_400(client):
    cid = client.post("/api/contexts", json={"name": "A", "polygon": _poly()}).json()["id"]
    assert client.patch(f"/api/contexts/{cid}", json={"name": "   "}).status_code == 400


def test_person_assignment(client):
    pid = client.post("/api/persons", json={"name": "Alice"}).json()["id"]
    cid = client.post("/api/contexts", json={"name": "A", "polygon": _poly(),
                                             "person_ids": [pid]}).json()["id"]
    ctx = next(x for x in client.get("/api/contexts").json() if x["id"] == cid)
    assert ctx["persons"] == [{"id": pid, "name": "Alice"}]
