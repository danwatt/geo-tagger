"""RequestGuard: Host allow-list (DNS rebinding) + Origin/Sec-Fetch-Site (cross-site writes)."""
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
    assert client.get(GET, headers={"Host": host}).status_code != 403


@pytest.mark.parametrize("suffix", ["", ".local"])
def test_machine_hostname_allowed(client, suffix):
    host = socket.gethostname().upper() + suffix
    assert client.get(GET, headers={"Host": f"{host}:8000"}).status_code != 403


def test_configured_host_allowed(client, monkeypatch):
    assert client.get(GET, headers={"Host": "photos.example"}).status_code == 403
    monkeypatch.setattr(config, "ALLOWED_HOSTS", ["photos.example"])
    assert client.get(GET, headers={"Host": "photos.example:8000"}).status_code != 403


def test_rejected_host_api_and_static(client):
    r = client.get(GET, headers={"Host": "evil.example"})
    assert r.status_code == 403
    assert "GEOTAGGER_ALLOWED_HOSTS" in r.json()["detail"]
    assert client.get("/", headers={"Host": "evil.example:8000"}).status_code == 403


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
    assert client.post(POST, headers={"Sec-Fetch-Site": "same-origin"}).status_code != 403


def test_get_with_foreign_origin_allowed(client):
    assert client.get(GET, headers={"Origin": "http://evil.example"}).status_code != 403
