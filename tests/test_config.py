"""Env-resolved knobs in config.py that validate their input. config resolves env
vars at import time, so these exercise the get_*() helpers the module constants
are built from rather than reloading the module."""

import pytest

from geotagger import config


# ── GEOTAGGER_WORKERS ──

class TestWorkers:
    def test_defaults_to_four_when_unset(self, monkeypatch):
        monkeypatch.delenv("GEOTAGGER_WORKERS", raising=False)
        assert config.get_workers() == 4

    def test_empty_counts_as_unset(self, monkeypatch):
        monkeypatch.setenv("GEOTAGGER_WORKERS", "")
        assert config.get_workers() == 4

    def test_env_value_is_used(self, monkeypatch):
        monkeypatch.setenv("GEOTAGGER_WORKERS", "12")
        assert config.get_workers() == 12

    @pytest.mark.parametrize("value", ["0", "-2", "abc", "2.5"])
    def test_invalid_value_is_rejected(self, monkeypatch, value):
        monkeypatch.setenv("GEOTAGGER_WORKERS", value)
        with pytest.raises(ValueError, match="GEOTAGGER_WORKERS must be an integer >= 1"):
            config.get_workers()

    def test_module_constant_is_valid(self):
        assert isinstance(config.WORKERS, int) and config.WORKERS >= 1


# ── GEOTAGGER_SIDECAR_MODE ──

class TestSidecarMode:
    def test_defaults_to_basename(self, monkeypatch):
        monkeypatch.delenv("GEOTAGGER_SIDECAR_MODE", raising=False)
        assert config.get_sidecar_mode() == "basename"

    @pytest.mark.parametrize(("value", "expected"), [
        ("basename", "basename"), ("fullname", "fullname"), (" FullName ", "fullname"),
    ])
    def test_allowed_values(self, monkeypatch, value, expected):
        monkeypatch.setenv("GEOTAGGER_SIDECAR_MODE", value)
        assert config.get_sidecar_mode() == expected

    @pytest.mark.parametrize("value", ["fulname", "full", ""])
    def test_invalid_value_is_rejected(self, monkeypatch, value):
        monkeypatch.setenv("GEOTAGGER_SIDECAR_MODE", value)
        with pytest.raises(ValueError, match="GEOTAGGER_SIDECAR_MODE must be"):
            config.get_sidecar_mode()


# ── GEOTAGGER_EXIFTOOL_TIMEOUT ──

class TestExifToolTimeout:
    def test_defaults_to_sixty_seconds(self, monkeypatch):
        monkeypatch.delenv("GEOTAGGER_EXIFTOOL_TIMEOUT", raising=False)
        assert config.get_exiftool_timeout() == 60.0

    def test_empty_counts_as_unset(self, monkeypatch):
        monkeypatch.setenv("GEOTAGGER_EXIFTOOL_TIMEOUT", " ")
        assert config.get_exiftool_timeout() == 60.0

    @pytest.mark.parametrize(("value", "expected"), [("15", 15.0), ("2.5", 2.5), ("0", 0.0)])
    def test_allowed_values(self, monkeypatch, value, expected):
        monkeypatch.setenv("GEOTAGGER_EXIFTOOL_TIMEOUT", value)
        assert config.get_exiftool_timeout() == expected

    @pytest.mark.parametrize("value", ["-1", "abc", "nan", "inf"])
    def test_invalid_value_is_rejected(self, monkeypatch, value):
        monkeypatch.setenv("GEOTAGGER_EXIFTOOL_TIMEOUT", value)
        with pytest.raises(ValueError, match="GEOTAGGER_EXIFTOOL_TIMEOUT must be"):
            config.get_exiftool_timeout()
