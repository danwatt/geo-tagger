"""Audit G2: geocoding datasets change under a running app.

- The OSM merge builds into a temp file and swaps it in, so a lookup during the
  build sees the old dataset or the new one, never a half-inserted region.
- geocode_cache rows carry the dataset version they were computed against; after
  any dataset job (OSM merge, Census build, GeoNames download) older rows are
  never served, and photos whose lookup found no city are re-queued.
"""

import json
import sqlite3
import sys
from pathlib import Path

import pytest

from geotagger import config, geocode, index, osm_builder, osm_places
from geotagger.services import data_service


def _rect(min_lat, max_lat, min_lng, max_lng):
    outer = [[min_lat, min_lng], [max_lat, min_lng], [max_lat, max_lng], [min_lat, max_lng]]
    return [[outer, []]]


PARK = dict(name="Old Park", category="park", area=0.01, polygons=_rect(40.04, 40.06, -75.06, -75.04))
CITY = dict(name="Newtown", category="city", admin_level=8, area=1.0,
            polygons=_rect(40.00, 40.10, -75.10, -75.00))
POINT = (40.05, -75.05)


def _insert_place(db: sqlite3.Connection, place: dict) -> None:
    """What osm_builder.process_file does for one matched area."""
    polys = place["polygons"]
    lats = [pt[0] for outer, _ in polys for pt in outer]
    lngs = [pt[1] for outer, _ in polys for pt in outer]
    bbox = (min(lats), max(lats), min(lngs), max(lngs))
    cur = db.execute(
        "INSERT INTO places (osm_type, osm_id, name, category, admin_level, rank, area, "
        "min_lat, max_lat, min_lng, max_lng, rings) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        ("way", hash(place["name"]) & 0xFFFF, place["name"], place["category"],
         place.get("admin_level"), 1, place["area"], *bbox, json.dumps(polys)))
    db.execute("INSERT INTO places_spatial VALUES (?,?,?,?,?)", (cur.lastrowid, *bbox))


def _fake_pbf(tmp_path: Path, name="test-latest.osm.pbf") -> Path:
    p = tmp_path / name
    p.write_bytes(b"not a real pbf")
    return p


def _add_photo(path: str, lat, lng) -> int:
    p = Path(path)
    index.upsert_photo(
        filename=p.name, dir_=str(p.parent), ext=".jpg", media_type="image", mtime=1.0,
        size=100, lat=lat, lng=lng, geotag_source="sidecar", sidecar_path=None,
        sidecar_mtime=None, camera="Cam", photo_datetime=1_600_000_000,
        gps_accuracy=None, orientation=1)
    return index.get_db().execute(
        "SELECT id FROM photos WHERE dir=? AND filename=?", (str(p.parent), p.name)
    ).fetchone()[0]


def _cache_rows() -> int:
    return index.get_db().execute("SELECT COUNT(*) FROM geocode_cache").fetchone()[0]


# ── OSM build: temp file + atomic swap ──

class TestOsmBuildSwap:
    def test_lookups_during_a_merge_see_the_old_dataset_then_the_new(self, osm_db, tmp_path,
                                                                     monkeypatch):
        db_path = osm_db([PARK])
        # Open the app's read handle first: the swap must cope with it (Windows).
        assert osm_places.lookup(*POINT)["city"] is None
        seen_mid_build = []

        def fake_process_file(db, pbf, index_, progress_cb=None):
            _insert_place(db, CITY)
            db.commit()  # committed, as the real builder does every 20k rows
            seen_mid_build.append(osm_places.lookup(*POINT))
            return {"kept": {"city": 1}, "skipped": {}, "errors": 0, "seconds": 0.0}

        monkeypatch.setattr(osm_builder, "process_file", fake_process_file)
        summary = osm_builder.build_or_append(db_path, [_fake_pbf(tmp_path)], append=True)

        # Mid-build: the committed city row was in the temp file, not the live DB.
        assert seen_mid_build == [{"city": None, "sublocation": "Old Park",
                                   "category": "park", "place_id": 1}]
        # After the swap: the reader reopened the new file, which kept the old rows.
        after = osm_places.lookup(*POINT)
        assert after["city"] == "Newtown" and after["sublocation"] == "Old Park"
        assert summary["total_places"] == 2
        assert not db_path.with_name(db_path.name + ".tmp").exists()

    def test_fresh_build_replaces_instead_of_appending(self, osm_db, tmp_path, monkeypatch):
        db_path = osm_db([PARK])
        osm_places.lookup(*POINT)

        def fake_process_file(db, pbf, index_, progress_cb=None):
            _insert_place(db, CITY)
            return {"kept": {"city": 1}, "skipped": {}, "errors": 0, "seconds": 0.0}

        monkeypatch.setattr(osm_builder, "process_file", fake_process_file)
        osm_builder.build_or_append(db_path, [_fake_pbf(tmp_path)], append=False)
        assert osm_places.lookup(*POINT) == {"city": "Newtown", "sublocation": None,
                                             "category": "city", "place_id": 1}

    def test_failed_merge_leaves_the_live_db_untouched(self, osm_db, tmp_path, monkeypatch):
        db_path = osm_db([PARK])
        before = osm_places.lookup(*POINT)

        def boom(db, pbf, index_, progress_cb=None):
            _insert_place(db, CITY)
            db.commit()
            raise RuntimeError("osmium blew up")

        monkeypatch.setattr(osm_builder, "process_file", boom)
        with pytest.raises(RuntimeError, match="osmium"):
            osm_builder.build_or_append(db_path, [_fake_pbf(tmp_path)], append=True)
        assert osm_places.lookup(*POINT) == before
        assert not db_path.with_name(db_path.name + ".tmp").exists()

    def test_first_install_is_picked_up_without_a_restart(self, osm_db, tmp_path, monkeypatch):
        # No DB yet: the reader latches "unavailable"; the swap resets that.
        db_path = config.OSM_DB_PATH
        assert osm_places.lookup(*POINT) is None
        assert osm_places._state == "unavailable"

        def fake_process_file(db, pbf, index_, progress_cb=None):
            _insert_place(db, CITY)
            return {"kept": {"city": 1}, "skipped": {}, "errors": 0, "seconds": 0.0}

        monkeypatch.setattr(osm_builder, "process_file", fake_process_file)
        osm_builder.build_or_append(db_path, [_fake_pbf(tmp_path)], append=True)
        assert osm_places.lookup(*POINT)["city"] == "Newtown"

    @pytest.mark.skipif(sys.platform != "win32", reason="POSIX lets an open file be replaced")
    def test_swap_blocked_by_another_handle_reports_and_keeps_the_build(self, osm_db, tmp_path):
        db_path = osm_db([PARK])
        tmp = tmp_path / "places.sqlite.tmp"
        tmp.write_bytes(db_path.read_bytes())
        foreign = sqlite3.connect(str(db_path))  # e.g. a second app instance
        try:
            foreign.execute("SELECT COUNT(*) FROM places").fetchone()
            with pytest.raises(RuntimeError, match="another process"):
                osm_places.replace_db(tmp, db_path)
        finally:
            foreign.close()
        assert tmp.exists()
        # The old file is still served.
        assert osm_places.lookup(*POINT)["sublocation"] == "Old Park"


# ── geocode_cache versioning ──

class TestCacheVersioning:
    def test_pre_install_answer_is_not_served_after_the_dataset_changes(
            self, osm_db, db, tmp_path, monkeypatch):
        db_path = osm_db([PARK])
        geocode.cache_version()          # the version the app ran with
        assert geocode.lookup(*POINT)["city"] is None
        assert _cache_rows() == 1

        def fake_process_file(db_, pbf, index_, progress_cb=None):
            _insert_place(db_, CITY)
            return {"kept": {"city": 1}, "skipped": {}, "errors": 0, "seconds": 0.0}

        monkeypatch.setattr(osm_builder, "process_file", fake_process_file)
        osm_builder.build_or_append(db_path, [_fake_pbf(tmp_path)], append=True)
        result = geocode.datasets_changed()
        assert result["changed"] is True and result["purged"] == 1
        assert geocode.lookup(*POINT)["city"] == "Newtown"

    def test_a_lookup_in_flight_across_the_change_is_never_served(self, osm_db, db, monkeypatch):
        osm_db([PARK])
        real = geocode._merged_lookup

        def changing_mid_lookup(lat, lng):
            out = real(lat, lng)
            # The dataset changes after this lookup read the old data.
            import os
            st = config.OSM_DB_PATH.stat()
            os.utime(config.OSM_DB_PATH, ns=(st.st_atime_ns, st.st_mtime_ns + 10**9))
            geocode.datasets_changed()
            return out

        monkeypatch.setattr(geocode, "_merged_lookup", changing_mid_lookup)
        geocode.lookup(*POINT)
        qlat, qlng = geocode.quantize(*POINT)
        # Written under the old version, so a miss under the current one.
        assert index.get_cached_geocode(qlat, qlng, version=geocode.cache_version()) is None

    def test_a_dataset_rebuilt_while_the_app_was_stopped_retires_the_cache(self, osm_db, db):
        db_path = osm_db([PARK])
        geocode.lookup(*POINT)
        qlat, qlng = geocode.quantize(*POINT)
        old = geocode.cache_version()
        assert index.get_cached_geocode(qlat, qlng, version=old) is not None
        # CLI rebuild (new file, new mtime), then a fresh process.
        osm_places.reset()
        db_path.unlink()
        osm_db([PARK, CITY])
        geocode._cache_version = None
        assert geocode.cache_version() != old
        assert index.get_cached_geocode(qlat, qlng, version=geocode.cache_version()) is None
        assert geocode.lookup(*POINT)["city"] == "Newtown"

    def test_legacy_rows_without_a_version_are_ignored(self, db):
        qlat, qlng = geocode.quantize(*POINT)
        with index.transaction() as conn:
            conn.execute("INSERT INTO geocode_cache (qlat, qlng, city, created_at) "
                         "VALUES (?, ?, 'Stale', 0)", (qlat, qlng))
        assert index.get_cached_geocode(qlat, qlng, version=geocode.cache_version()) is None

    def test_no_change_is_a_no_op(self, db):
        index.update_photo_location(_add_photo("/lib/a.jpg", *POINT), None)
        geocode.cache_version()
        assert geocode.datasets_changed() == {"changed": False, "purged": 0, "requeued": 0}
        assert index.count_photos_needing_geocode() == 0

    def test_only_cityless_photos_are_requeued(self, osm_db, db):
        osm_db([PARK])
        geocode.cache_version()
        no_city = _add_photo("/lib/a.jpg", *POINT)
        has_city = _add_photo("/lib/b.jpg", *POINT)
        index.update_photo_locations([
            (no_city, {"city": None, "sublocation": "Old Park"}),
            (has_city, {"city": "Somewhere"}),
        ])
        config.OSM_DB_PATH.unlink()  # any dataset change
        osm_places.reset()
        assert geocode.datasets_changed()["requeued"] == 1
        ids = [r["id"] for r in index.get_photos_needing_geocode()]
        assert ids == [no_city]
        # Existing names are left alone until the retry overwrites them.
        row = index.get_db().execute(
            "SELECT loc_sublocation FROM photos WHERE id=?", (no_city,)).fetchone()
        assert row[0] == "Old Park"


# ── Every dataset job path invalidates ──

@pytest.fixture
def stale_cache(db):
    """A cached answer and a city-less geocoded photo from before the job."""
    geocode.cache_version()
    qlat, qlng = geocode.quantize(*POINT)
    index.put_cached_geocode(qlat, qlng, {"city": None}, version=geocode.cache_version())
    pid = _add_photo("/lib/a.jpg", *POINT)
    index.update_photo_location(pid, {"city": None})
    old = geocode.cache_version()

    def check():
        assert geocode.cache_version() != old
        assert _cache_rows() == 0
        assert [r["id"] for r in index.get_photos_needing_geocode()] == [pid]
    return check


class TestDatasetJobs:
    def test_osm_merge_job(self, stale_cache, osm_db, monkeypatch):
        osm_db([PARK])
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
        stale_cache()
        assert geocode.lookup(*POINT)["city"] == "Newtown"

    def test_census_build_job(self, stale_cache, tmp_path, monkeypatch):
        from geotagger import census_builder, downloads
        monkeypatch.setattr(config, "CENSUS_DB_PATH", tmp_path / "census" / "places.sqlite")
        config.CENSUS_DB_PATH.parent.mkdir()
        for name in ("cb-place-500k.zip", "cb-zcta520-500k.zip", "geonames-us-postal.zip"):
            (config.CENSUS_DB_PATH.parent / name).write_bytes(b"zip")
        monkeypatch.setattr(downloads, "zip_ok", lambda p: True)

        def fake_build(db_path, *a, **k):
            db_path.write_bytes(b"built")
            return {"total_places": 1, "total_zctas": 0}

        monkeypatch.setattr(census_builder, "build", fake_build)
        monkeypatch.setattr(census_builder, "cb_urls", lambda: [("x", "http://example.invalid")])
        data_service._run_census_download()
        assert data_service.census_job_status()["error"] is None
        stale_cache()

    def test_geonames_download_job_even_when_it_fails_partway(self, stale_cache, tmp_path,
                                                              monkeypatch):
        from geotagger import downloads
        monkeypatch.setattr(config, "GEONAMES_DIR", tmp_path / "geonames")
        calls = []

        def fake_download_to(url, dest, **kw):
            calls.append(dest.name)
            if len(calls) == 2:
                raise downloads.DownloadError("connection reset")
            dest.write_text("x\n", encoding="utf-8")
            return {"bytes": 2}

        monkeypatch.setattr(downloads, "download_to", fake_download_to)
        data_service._run_geonames_download()
        assert "connection reset" in data_service.geonames_job_status()["error"]
        stale_cache()  # cities500.txt did land, so the cache must still be retired
