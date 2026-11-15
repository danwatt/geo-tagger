"""RequestGuard: Host allow-list (DNS rebinding), Origin/Sec-Fetch-Site (cross-site writes)
and the --network access token."""
import socket

import pytest

from geotagger import config

# Cheap POST route: an empty body fails validation (422) before any real work.
POST = "/api/geotag"
GET = "/api/status"


@pytest.mark.parametrize("host", [
    "localhost", "localhost:8000", "foo.localhost", "127.0.0.1:8000", "[::1]:8000", "[::1]", "192.168.1.5",
])
def test_allowed_hosts(client, host):
    assert client.get(GET, headers={"Host": host}).status_code == 200


@pytest.mark.parametrize("suffix", ["", ".local"])
def test_machine_hostname_allowed(client, suffix):
    host = socket.gethostname().upper() + suffix
    assert client.get(GET, headers={"Host": f"{host}:8000"}).status_code == 200


def test_configured_host_allowed(client, monkeypatch):
    assert client.get(GET, headers={"Host": "photos.example"}).status_code == 400
    monkeypatch.setattr(config, "ALLOWED_HOSTS", ["photos.example"])
    assert client.get(GET, headers={"Host": "photos.example:8000"}).status_code == 200


def test_rejected_host_api_and_static(client):
    r = client.get(GET, headers={"Host": "evil.example"})
    assert r.status_code == 400
    assert "GEOTAGGER_ALLOWED_HOSTS" in r.json()["detail"]
    # Static pages and the SPA catch-all go through the same check.
    assert client.get("/", headers={"Host": "evil.example:8000"}).status_code == 400
    assert client.get("/style.css", headers={"Host": "evil.example"}).status_code == 400
    # The TestClient default Host isn't on the list either.
    assert client.get(GET, headers={"Host": "testserver"}).status_code == 400


def test_same_origin_post_allowed(client):
    r = client.post(POST, headers={"Host": "127.0.0.1:8000", "Origin": "http://127.0.0.1:8000"})
    assert r.status_code != 403


def test_default_port_origin_allowed(client):
    r = client.post(POST, headers={"Host": "localhost", "Origin": "http://localhost:80"})
    assert r.status_code != 403


def test_foreign_origin_post_rejected(client):
    assert client.post(POST, headers={"Origin": "http://evil.example"}).status_code == 403
    # Same host, different port is a different origin too.
    assert client.post(POST, headers={"Host": "127.0.0.1:8000", "Origin": "http://127.0.0.1:9999"}).status_code == 403


def test_null_origin_rejected(client):
    assert client.post(POST, headers={"Origin": "null"}).status_code == 403


def test_no_origin_post_allowed(client):
    assert client.post(POST).status_code != 403


def test_sec_fetch_site_cross_site_rejected(client):
    assert client.post(POST, headers={"Sec-Fetch-Site": "cross-site"}).status_code == 403
    # same-site ignores ports: another dev server on localhost:3000 would qualify.
    assert client.post(POST, headers={"Sec-Fetch-Site": "same-site"}).status_code == 403
    assert client.post(POST, headers={"Sec-Fetch-Site": "same-origin"}).status_code != 403
    assert client.post(POST, headers={"Sec-Fetch-Site": "none"}).status_code != 403


def test_get_with_foreign_origin_allowed(client):
    assert client.get(GET, headers={"Origin": "http://evil.example"}).status_code == 200
    assert client.get(GET, headers={"Sec-Fetch-Site": "cross-site"}).status_code == 200


def test_same_origin_form_post_allowed(client):
    # The Search page submits download-zip as a real <form> navigation: the browser sends
    # Origin + Sec-Fetch-Site: same-origin and a urlencoded body.
    r = client.post("/api/photos/download-zip", data={"photo_ids": "999"}, headers={
        "Host": "127.0.0.1:8000", "Origin": "http://127.0.0.1:8000", "Sec-Fetch-Site": "same-origin"})
    assert r.status_code == 404  # reached the route: no such photo


def test_cross_site_bodyless_post_rejected(client):
    # The audit's forgeable body-less POSTs: a plain <form> from another site.
    for path in ("/api/geocode/export-sidecars", "/api/faces/dedup/recompute", "/api/semantic/scan"):
        r = client.post(path, headers={"Origin": "https://evil.example", "Sec-Fetch-Site": "cross-site"})
        assert r.status_code == 403, path


# ── Access token (--network) ──

TOKEN = "s3cret-token"


@pytest.fixture
def token(monkeypatch):
    monkeypatch.setattr(config, "ACCESS_TOKEN", TOKEN)
    return TOKEN


def test_token_required(client, token):
    r = client.get(GET)
    assert r.status_code == 401
    assert "token" in r.json()["detail"]
    assert client.get("/").status_code == 401
    assert client.post(POST).status_code == 401
    assert client.get(GET, headers={"Cookie": "geotagger_token=wrong"}).status_code == 401
    assert client.get(GET, headers={"Authorization": "Bearer wrong"}).status_code == 401


def test_token_bearer(client, token):
    assert client.get(GET, headers={"Authorization": f"Bearer {TOKEN}"}).status_code == 200
    assert client.get(GET, headers={"Authorization": f"bearer {TOKEN}"}).status_code == 200


def test_token_cookie_flow(client, token):
    r = client.get(f"/search.html?token={TOKEN}&q=x", follow_redirects=False)
    assert r.status_code == 303
    # The token is stripped from the URL; other params survive.
    assert r.headers["location"] == "/search.html?q=x"
    set_cookie = r.headers["set-cookie"]
    assert f"geotagger_token={TOKEN}" in set_cookie and "HttpOnly" in set_cookie
    # TestClient keeps the cookie, like a browser would.
    assert client.get(GET).status_code == 200
    # A static file too. Not "/": the pages are a Vite build (web_dist/) the
    # Python test job doesn't run, while theme.css is always in web/.
    assert client.get("/theme.css").status_code == 200


def test_token_wrong_query_rejected(client, token):
    r = client.get("/?token=nope", follow_redirects=False)
    assert r.status_code == 401
    assert "set-cookie" not in r.headers


def test_token_query_not_accepted_on_post(client, token):
    assert client.post(f"{POST}?token={TOKEN}").status_code == 401


def test_token_does_not_bypass_origin_check(client, token):
    r = client.post(POST, headers={"Authorization": f"Bearer {TOKEN}", "Origin": "http://evil.example"})
    assert r.status_code == 403


def test_no_token_in_loopback_mode(client):
    assert config.ACCESS_TOKEN == ""
    assert client.get(GET).status_code == 200
