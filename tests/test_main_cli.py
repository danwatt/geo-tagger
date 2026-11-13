import os
import sys

import pytest

from geotagger import config
from geotagger.__main__ import _is_loopback, main


# Variables main() writes to os.environ. Registering each with monkeypatch
# before the call makes pytest restore (or delete) it afterwards; plain
# delenv(raising=False) on an absent var records nothing, so main()'s write
# would leak into later tests.
_ENV_VARS = (
    "GEOTAGGER_WORKERS",
    "GEOTAGGER_CACHE_DIR",
    "GEOTAGGER_NO_SCAN",
    "GEOTAGGER_SCAN_DIRS",
)


@pytest.fixture
def cli(monkeypatch):
    """Isolate main(): clean env, no real server, fixed config host, fake uvicorn."""
    for name in _ENV_VARS:
        monkeypatch.setenv(name, "")
        monkeypatch.delenv(name)

    monkeypatch.setattr("geotagger.config.HOST", "127.0.0.1")
    monkeypatch.setattr("geotagger.index.get_last_scan_roots", lambda: ["x"])

    calls: list[dict] = []

    def fake_run(app, **kwargs):
        calls.append({"app": app, **kwargs})

    monkeypatch.setattr("uvicorn.run", fake_run)

    def run(*argv: str) -> list[dict]:
        monkeypatch.setattr(sys, "argv", ["geotagger", *argv])
        main()
        return calls

    return run


@pytest.mark.parametrize(
    ("host", "expected"),
    [
        ("127.0.0.1", True),
        ("127.5.4.3", True),
        ("::1", True),
        ("localhost", True),
        ("LocalHost", True),
        ("0.0.0.0", False),
        ("::", False),
        ("", False),
        ("192.168.1.20", False),
        ("fe80::1", False),
        ("myhost.lan", False),
    ],
)
def test_is_loopback(host, expected):
    assert _is_loopback(host) is expected


def test_no_workers_flag_leaves_preset_env_untouched(cli, monkeypatch):
    monkeypatch.setenv("GEOTAGGER_WORKERS", "8")
    cli("--scan-dir", os.getcwd())
    assert os.environ["GEOTAGGER_WORKERS"] == "8"
    assert config.get_workers() == 8


def test_no_workers_flag_and_no_env_leaves_unset(cli):
    cli("--scan-dir", os.getcwd())
    assert "GEOTAGGER_WORKERS" not in os.environ
    assert config.get_workers() == 4


def test_workers_flag_sets_env(cli):
    cli("--scan-dir", os.getcwd(), "--workers", "6")
    assert os.environ["GEOTAGGER_WORKERS"] == "6"
    assert config.get_workers() == 6


def test_workers_flag_overrides_preset_env(cli, monkeypatch):
    monkeypatch.setenv("GEOTAGGER_WORKERS", "8")
    cli("--scan-dir", os.getcwd(), "--workers", "2")
    assert config.get_workers() == 2


@pytest.mark.parametrize("value", ["-3", "abc", "2.5"])
def test_workers_flag_bad_value_is_rejected(cli, capsys, value):
    with pytest.raises(SystemExit) as exc:
        cli("--scan-dir", os.getcwd(), f"--workers={value}")
    assert exc.value.code != 0
    assert "--workers" in capsys.readouterr().err


def test_workers_zero_is_rejected(cli, capsys):
    with pytest.raises(SystemExit) as exc:
        cli("--scan-dir", os.getcwd(), "--workers", "0")
    assert exc.value.code != 0
    assert "at least 1" in capsys.readouterr().err


def test_specific_lan_host_warns_and_is_passed_to_uvicorn(cli, capsys):
    calls = cli("--scan-dir", os.getcwd(), "--host", "192.168.1.20")
    out = capsys.readouterr().out
    assert "NO AUTHENTICATION" in out
    assert "Server accessible at: http://192.168.1.20:8000" in out
    assert calls[-1]["host"] == "192.168.1.20"


def test_network_flag_warns_and_binds_wildcard(cli, capsys):
    calls = cli("--scan-dir", os.getcwd(), "--network")
    out = capsys.readouterr().out
    assert "NO AUTHENTICATION" in out
    assert calls[-1]["host"] == "0.0.0.0"


def test_default_bind_has_no_warning(cli, capsys):
    calls = cli("--scan-dir", os.getcwd())
    out = capsys.readouterr().out
    assert "NO AUTHENTICATION" not in out
    assert "Server accessible at: http://127.0.0.1:8000" in out
    assert calls[-1]["host"] == "127.0.0.1"


def test_ipv6_loopback_has_no_warning(cli, capsys):
    calls = cli("--scan-dir", os.getcwd(), "--host", "::1")
    out = capsys.readouterr().out
    assert "NO AUTHENTICATION" not in out
    assert "Server accessible at: http://[::1]:8000" in out
    assert calls[-1]["host"] == "::1"
