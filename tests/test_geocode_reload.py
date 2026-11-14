"""Audit G3: a dataset installed or replaced while the app runs takes effect
without a restart.

- GeoNames gained reset()/refresh_if_changed(): the Data page download un-latches
  "unavailable" on a first install and swaps the tables on a re-download, before
  the cache version moves. Tables are published as one object, so a lookup racing
  a reset uses the old set or the new one, never a mix.
- Files that change by other means (CLI script, copied by hand) are noticed by
  check_datasets(): status endpoints run it on every call, lookups every
  config.DATASET_RECHECK_SECONDS.
"""

import os
import threading

import pytest

from geotagger import census_places, config, geocode, index, osm_builder, osm_places
from geotagger.downloads import replace_retrying
from geotagger.services import data_service

from test_geocode import CITY_A, _city_row, _write_admin_files, _write_geonames_files
from test_geocode_invalidation import CITY, PARK, POINT, _insert_place


def _cities_text(cities) -> str:
    return "\n".join(_city_row(**c) for c in cities) + "\n"


def _fake_geonames_download(monkeypatch, cities):
    """downloads.download_to that "downloads" real GeoNames content."""
    from geotagger import downloads

    def fake_download_to(url, dest, **kw):
        if dest.name == "cities500.txt":
            text = _cities_text(cities)
        else:
            tmp = dest.parent / "__admin__"
            tmp.mkdir(exist_ok=True)
            _write_admin_files(tmp)
            text = (tmp / dest.name).read_text(encoding="utf-8")
        part = dest.with_name(dest.name + ".part")
        part.write_text(text, encoding="utf-8")
        os.replace(part, dest)   # atomic, as the real downloader is
        return {"bytes": len(text)}

    monkeypatch.setattr(downloads, "download_to", fake_download_to)
    # Calling the runner directly skips start_geonames_download's state reset, so
    # don't inherit an earlier test's job error.
    monkeypatch.setattr(data_service, "_geonames_job",
                        {"running": True, "done": False, "error": None, "message": ""})


def _bump_mtime(path):
    """A replacement file with the same size still gets a new mtime; force one so
    the test doesn't depend on the filesystem's timestamp granularity."""
    st = path.stat()
    os.utime(path, ns=(st.st_atime_ns, st.st_mtime_ns + 10**9))


# ── GeoNames: in-app download job ──

class TestGeonamesJob:
    def test_first_install_is_picked_up_without_a_restart(self, geonames_dir, db, monkeypatch):
        assert geocode.lookup(40.0, -74.0) is None
        assert geocode._state == "unavailable"
        _fake_geonames_download(monkeypatch, [CITY_A])
        data_service._run_geonames_download()
        assert data_service.geonames_job_status()["error"] is None
        assert geocode.status()["state"] == "unloaded"   # un-latched, reload is lazy
        loc = geocode.lookup(40.0, -74.0)
        assert loc["city"] == "Testville" and loc["state"] == "New York"
        assert geocode.status()["cities"] == 1

    def test_redownload_swaps_tables_before_the_version_moves(self, geonames_dir, db, monkeypatch):
        _write_geonames_files(geonames_dir, [CITY_A])
        assert geocode.lookup(40.0, -74.0)["city"] == "Testville"
        old_version = geocode.cache_version()
        renamed = dict(CITY_A, name="Newville")
        _fake_geonames_download(monkeypatch, [renamed])

        seen_when_version_moved = []
        real_changed = geocode.datasets_changed

        def spy(*a, **k):
            # What a lookup made right as the version moves would compute.
            seen_when_version_moved.append(geocode._merged_lookup(40.0, -74.0)["city"])
            return real_changed(*a, **k)

        monkeypatch.setattr(geocode, "datasets_changed", spy)
        data_service._run_geonames_download(force=True)

        assert seen_when_version_moved == ["Newville"]
        new_version = geocode.cache_version()
        assert new_version != old_version
        assert geocode.lookup(40.0, -74.0)["city"] == "Newville"
        qlat, qlng = geocode.quantize(40.0, -74.0)
        assert index.get_cached_geocode(qlat, qlng, version=new_version)["city"] == "Newville"
        # The old answer is gone, not just shadowed.
        assert index.get_cached_geocode(qlat, qlng, version=old_version) is None

    def test_a_download_that_skips_every_file_keeps_the_tables(self, geonames_dir, db, monkeypatch):
        _write_geonames_files(geonames_dir, [CITY_A])
        geocode.lookup(40.0, -74.0)
        tables = geocode._data
        data_service._run_geonames_download()   # every file present, no force
        assert geocode._data is tables           # no needless reparse


# ── GeoNames: reset() vs. concurrent lookups ──

def _swap_in(dir_, cities, name="cities500.txt"):
    staged = dir_ / "__staged__"
    staged.write_text(_cities_text(cities), encoding="utf-8")
    # Reader threads may be mid-parse on the old file; on Windows a plain
    # os.replace then fails with PermissionError. Use the same retrying replace
    # the download path uses, so this exercises the real swap.
    replace_retrying(staged, dir_ / name)


SET_1 = [dict(CITY_A, name="Alpha")]                                # 1 row, NY
SET_2 = [dict(geonameid=9, name="Gamma", lat=10.0, lng=10.0, cc="CA", admin1="08"),
         dict(CITY_A, geonameid=8, name="Beta", cc="CA", admin1="08")]  # 2 rows, Ontario
VALID = {("Alpha", "New York"), ("Beta", "Ontario")}


class TestResetConcurrency:
    def test_lookups_racing_resets_see_one_whole_table_set(self, geonames_dir):
        _write_geonames_files(geonames_dir, SET_1)
        seen: set = set()
        errors: list = []
        stop = threading.Event()

        def reader():
            try:
                while not stop.is_set():
                    r = geocode._raw_lookup(40.0, -74.0)
                    seen.add((r["city"], r["state"]))
            except Exception as e:  # an IndexError would mean new tree + old names
                errors.append(e)

        threads = [threading.Thread(target=reader) for _ in range(3)]
        for t in threads:
            t.start()
        try:
            for i in range(60):
                _swap_in(geonames_dir, SET_2 if i % 2 == 0 else SET_1)
                geocode.reset()
        finally:
            stop.set()
            for t in threads:
                t.join()
        assert errors == []
        assert seen <= VALID and seen   # never None, never a mixed pair

    @pytest.mark.parametrize("invalidate", ["reset", "refresh_if_changed"])
    def test_a_reset_mid_parse_discards_the_stale_parse(self, geonames_dir, monkeypatch, invalidate):
        _write_geonames_files(geonames_dir, SET_1)
        real_parse = geocode._parse
        parsing, release = threading.Event(), threading.Event()
        parses = []

        def slow_parse():
            out = real_parse()
            parses.append(out.names[0])
            if len(parses) == 1:
                parsing.set()
                release.wait(5)
            return out

        monkeypatch.setattr(geocode, "_parse", slow_parse)
        result = {}
        t = threading.Thread(target=lambda: result.update(geocode._raw_lookup(40.0, -74.0)))
        t.start()
        assert parsing.wait(5)
        _swap_in(geonames_dir, SET_2)          # files replaced under the parse
        if invalidate == "reset":
            geocode.reset()                    # the in-app job's path; never blocks on the parse
        else:
            assert geocode.refresh_if_changed() is False   # nothing published yet...
        release.set()
        t.join(5)
        assert parses == ["Alpha", "Gamma"]    # ...but the stale parse was redone
        assert (result["city"], result["state"]) == ("Beta", "Ontario")

    def test_a_snapshot_taken_before_reset_stays_whole(self, geonames_dir):
        _write_geonames_files(geonames_dir, SET_1)
        t = geocode._tables()
        geocode.reset()
        _swap_in(geonames_dir, SET_2)
        assert geocode._place_dict(t, 0)["city"] == "Alpha"   # old set, intact
        assert geocode._raw_lookup(40.0, -74.0)["city"] == "Beta"


# ── OSM: first install through the in-app merge job ──

class TestOsmJobFirstInstall:
    def test_latched_unavailable_then_merge_job(self, osm_db, db, monkeypatch):
        assert osm_places.lookup(*POINT) is None
        assert osm_places._state == "unavailable"
        cache_dir = config.get_pbf_cache_dir()
        cache_dir.mkdir(parents=True, exist_ok=True)
        (cache_dir / "us_texas-latest.osm.pbf").write_bytes(b"x")
        from geotagger import osm_compact
        monkeypatch.setattr(osm_compact, "is_complete_pbf", lambda p: True)
        monkeypatch.setattr(config, "OSM_COMPACT_PBF", False)

        def fake_process_file(db_, pbf, index_, progress_cb=None):
            _insert_place(db_, CITY)
            return {"kept": {"city": 1}, "skipped": {}, "errors": 0, "seconds": 0.0}

        monkeypatch.setattr(osm_builder, "process_file", fake_process_file)
        data_service._run_osm_download_and_merge(["us_texas"])
        assert data_service.osm_job_status()["error"] is None
        st = data_service.osm_status()
        assert st["state"] == "ready" and st["places"] == 1
        assert geocode.lookup(*POINT)["city"] == "Newtown"


# ── Out-of-band installs: check_datasets() ──

class TestOutOfBandInstalls:
    def test_geonames_copied_in_is_picked_up_by_a_lookup(self, geonames_dir, db, monkeypatch):
        monkeypatch.setattr(config, "DATASET_RECHECK_SECONDS", 0.0)
        assert geocode.lookup(40.0, -74.0) is None
        assert geocode._state == "unavailable"
        _write_geonames_files(geonames_dir, [CITY_A])     # e.g. scripts/get_geonames.py
        assert geocode.lookup(40.0, -74.0)["city"] == "Testville"

    def test_a_cli_install_retires_answers_cached_without_it(self, geonames_dir, osm_db, db,
                                                             monkeypatch):
        monkeypatch.setattr(config, "DATASET_RECHECK_SECONDS", 0.0)
        osm_db([PARK])
        before = geocode.lookup(*POINT)
        assert before["city"] is None and before["sublocation"] == "Old Park"
        old = geocode.cache_version()
        _write_geonames_files(geonames_dir, [dict(CITY_A, lat=40.05, lng=-75.05)])
        after = geocode.lookup(*POINT)
        assert after["city"] == "Testville" and after["sublocation"] == "Old Park"
        assert geocode.cache_version() != old
        qlat, qlng = geocode.quantize(*POINT)
        assert index.get_cached_geocode(qlat, qlng, version=old) is None

    def test_osm_built_by_the_cli_is_picked_up(self, osm_db, db, monkeypatch):
        monkeypatch.setattr(config, "DATASET_RECHECK_SECONDS", 0.0)
        assert geocode.lookup(*POINT) is None
        assert osm_places._state == "unavailable"
        osm_db([CITY])
        assert geocode.lookup(*POINT)["city"] == "Newtown"

    def test_census_built_by_the_cli_is_picked_up(self, census_db, db, monkeypatch):
        monkeypatch.setattr(config, "DATASET_RECHECK_SECONDS", 0.0)
        assert geocode.lookup(*POINT) is None
        assert census_places._state == "unavailable"
        census_db([dict(name="Censusville", polygons=CITY["polygons"])])
        assert geocode.lookup(*POINT)["city"] == "Censusville"

    def test_lookups_are_throttled_but_status_is_immediate(self, geonames_dir, db, monkeypatch):
        monkeypatch.setattr(config, "DATASET_RECHECK_SECONDS", 3600.0)
        monkeypatch.setattr(geocode, "_last_check", __import__("time").monotonic())
        geocode.lookup(40.0, -74.0)
        _write_geonames_files(geonames_dir, [CITY_A])
        # Within the interval a lookup doesn't stat anything...
        assert geocode.lookup(40.0, -74.0) is None
        assert geocode._state == "unavailable"
        # ...but the status endpoints check on every call.
        st = geocode.status()
        assert st["available"] is True and st["state"] == "unloaded" and st["error"] is None
        assert geocode.lookup(40.0, -74.0)["city"] == "Testville"

    def test_status_endpoint_reflects_an_out_of_band_install(self, client, geonames_dir):
        client.get("/api/geocode/status")
        geocode._ensure_loaded()
        assert client.get("/api/geocode/status").json()["state"] == "unavailable"
        _write_geonames_files(geonames_dir, [CITY_A])
        body = client.get("/api/geocode/status").json()
        assert body["available"] is True and body["state"] == "unloaded"

    def test_a_replaced_file_reloads_even_when_ready(self, geonames_dir, db, monkeypatch):
        monkeypatch.setattr(config, "DATASET_RECHECK_SECONDS", 0.0)
        _write_geonames_files(geonames_dir, SET_1)
        assert geocode.lookup(40.0, -74.0)["city"] == "Alpha"
        _swap_in(geonames_dir, SET_2)
        _bump_mtime(geonames_dir / "cities500.txt")
        assert geocode.lookup(40.0, -74.0)["city"] == "Beta"

    def test_unchanged_files_cost_no_reload(self, geonames_dir, db, monkeypatch):
        monkeypatch.setattr(config, "DATASET_RECHECK_SECONDS", 0.0)
        _write_geonames_files(geonames_dir, [CITY_A])
        geocode.lookup(40.0, -74.0)
        tables = geocode._data
        assert geocode.check_datasets() is False
        geocode.lookup(40.1, -74.1)
        assert geocode._data is tables

    def test_check_stands_down_during_an_in_app_job(self, geonames_dir, db):
        geocode.lookup(40.0, -74.0)
        assert geocode._state == "unavailable"
        with geocode.dataset_job():
            _write_geonames_files(geonames_dir, [CITY_A])
            assert geocode.check_datasets() is False
            assert geocode._state == "unavailable"   # left for the job to settle
        assert geocode.check_datasets() is True
        assert geocode.lookup(40.0, -74.0)["city"] == "Testville"
