"""Endpoint tests for geotagger.api.status (status, debug, live settings)."""


def test_status_and_debug(client):
    s = client.get("/api/status").json()
    assert set(s["exiftool"]) == {"available", "reason"}
    assert s["db_total"] == 0 and "geocoder" in s
    assert "ok" not in s and "error" not in s

    d = client.get("/api/debug").json()
    assert d == {"total": 0, "sample": []}


def test_settings_defaults_not_overridden(client):
    settings = client.get("/api/settings").json()["settings"]
    assert all(s["overridden"] is False for s in settings)
    match = next(s for s in settings if s["key"] == "FACE_MATCH_THRESHOLD")
    assert match["value"] == match["default"]


def test_settings_patch_then_reset_round_trip(client):
    r = client.patch("/api/settings", json={"values": {"FACE_MATCH_THRESHOLD": 0.5}})
    assert r.status_code == 200
    assert r.json() == {"updated": {"FACE_MATCH_THRESHOLD": 0.5}}

    match = next(s for s in client.get("/api/settings").json()["settings"]
                 if s["key"] == "FACE_MATCH_THRESHOLD")
    assert match["value"] == 0.5 and match["overridden"] is True

    r = client.post("/api/settings/reset", json={"keys": ["FACE_MATCH_THRESHOLD"]})
    assert r.status_code == 200 and r.json() == {"reset": ["FACE_MATCH_THRESHOLD"]}

    match = next(s for s in client.get("/api/settings").json()["settings"]
                 if s["key"] == "FACE_MATCH_THRESHOLD")
    assert match["overridden"] is False
    assert match["value"] == match["default"]


def test_settings_bool_patch_and_reset_round_trip(client):
    # RAW_FULL_DECODE is a bool setting; the checkbox sends 1/0 and it round-trips
    # as a JSON bool (coerced server-side per SETTINGS_SPEC).
    r = client.patch("/api/settings", json={"values": {"RAW_FULL_DECODE": 1}})
    assert r.status_code == 200
    assert r.json() == {"updated": {"RAW_FULL_DECODE": True}}

    raw = next(s for s in client.get("/api/settings").json()["settings"]
               if s["key"] == "RAW_FULL_DECODE")
    assert raw["type"] == "bool" and raw["value"] is True and raw["overridden"] is True

    r = client.post("/api/settings/reset", json={"keys": ["RAW_FULL_DECODE"]})
    assert r.status_code == 200
    raw = next(s for s in client.get("/api/settings").json()["settings"]
               if s["key"] == "RAW_FULL_DECODE")
    assert raw["value"] is False and raw["overridden"] is False


def test_settings_patch_unknown_key_400(client):
    r = client.patch("/api/settings", json={"values": {"NOPE": 1}})
    assert r.status_code == 400


def test_settings_patch_out_of_range_400(client):
    # FACE_MATCH_THRESHOLD is capped at 0.9.
    r = client.patch("/api/settings", json={"values": {"FACE_MATCH_THRESHOLD": 5.0}})
    assert r.status_code == 400


def test_settings_reset_unknown_key_400(client):
    r = client.post("/api/settings/reset", json={"keys": ["NOPE"]})
    assert r.status_code == 400


# ── Errors are real statuses, components report availability (audit A12) ──

def test_status_reports_missing_exiftool_as_component(client, monkeypatch):
    from geotagger.api import status
    monkeypatch.setattr(status, "exiftool_status",
                        lambda: {"ok": False, "error": "not started"})
    r = client.get("/api/status")
    assert r.status_code == 200
    assert r.json()["exiftool"] == {"available": False, "reason": "not started"}


def test_status_and_debug_db_failure_is_503(client, monkeypatch):
    from geotagger.api import status

    def broken():
        raise RuntimeError("disk on fire")
    monkeypatch.setattr(status.index, "get_db", broken)
    for path in ("/api/status", "/api/debug"):
        r = client.get(path)
        assert r.status_code == 503, path
        assert "disk on fire" in r.json()["detail"]
