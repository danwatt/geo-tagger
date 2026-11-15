"""Unit tests for geotagger.services.* — the framework-free blocking jobs the API
routes hand to the executor. No FastAPI here; they run the real DB / geocoder /
ExifTool / face-math code paths directly.

ExifTool-backed cases use the session-scoped ``et_session`` fixture, which skips
them locally if the binary isn't available (and fails them when CI=true); face detection (scan_faces_batch's happy path) needs the
275 MB InsightFace model, so only its model-free branch is covered here.
"""

from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from geotagger import index, serializers, faces
from geotagger.services import geocode_service, photos_service, faces_service

import face_fixtures as ff


def _add_photo(db, path="p.jpg", lat=None, lng=None, photo_datetime=1_600_000_000) -> int:
    p = Path(path)
    index.upsert_photo(
        filename=p.name, dir_=str(p.parent), ext=".jpg",
        media_type="image", mtime=1.0, size=100, lat=lat, lng=lng,
        geotag_source="sidecar" if lat is not None else "none",
        sidecar_path=None, sidecar_mtime=None, camera="Cam",
        photo_datetime=photo_datetime, gps_accuracy=None, orientation=1,
    )
    return db.execute(
        "SELECT id FROM photos WHERE dir=? AND filename=?", (str(p.parent), p.name)
    ).fetchone()[0]


def _make_jpg(path) -> str:
    Image.new("RGB", (8, 8), color="blue").save(path, "JPEG")
    return str(path)


def _rect(min_lat, max_lat, min_lng, max_lng):
    """One rectangular polygon (no holes) in the OSM/Census stored ring format."""
    outer = [[min_lat, min_lng], [max_lat, min_lng], [max_lat, max_lng], [min_lat, max_lng]]
    return [[outer, []]]


def _place_tags(sc) -> dict:
    from geotagger import exiftool_session
    # pyexiftool's "-G" returns family-0 prefixes ("XMP:City").
    return exiftool_session.get_et().get_tags([str(sc)], tags=[
        "XMP-photoshop:City", "XMP-photoshop:State",
        "XMP-photoshop:Country", "XMP-iptcCore:CountryCode"])[0]


def _write_geonames(dir_):
    (dir_ / "cities500.txt").write_text(
        "\t".join(["1", "Testville", "Testville", "", "40.0", "-74.0", "P", "PPL",
                   "US", "", "NY", "061", "", "", "1000000", "", "", "", ""]) + "\n",
        encoding="utf-8")
    (dir_ / "admin1CodesASCII.txt").write_text("US.NY\tNew York\tNew York\t1\n", encoding="utf-8")
    (dir_ / "admin2Codes.txt").write_text("US.NY.061\tNew York County\tNew York County\t10\n", encoding="utf-8")
    (dir_ / "countryInfo.txt").write_text("# header\nUS\tUSA\t840\tUS\tUnited States\tWashington\n", encoding="utf-8")


class TestGeocodePending:
    def test_matches_and_writes_location(self, db, geonames_dir):
        _write_geonames(geonames_dir)
        pid = _add_photo(db, lat=40.001, lng=-74.001)
        res = geocode_service.geocode_pending()
        assert res == {"processed": 1, "matched": 1, "available": True, "remaining": 0}
        row = index.get_photo(pid)
        assert row["loc_city"] == "Testville"
        assert row["loc_country_code"] == "US"

    def test_unavailable_when_no_geonames(self, db, geonames_dir):
        _add_photo(db, lat=40.0, lng=-74.0)
        res = geocode_service.geocode_pending()
        assert res["available"] is False
        assert res["processed"] == 0
        assert res["remaining"] == 1

    # ── Any one dataset is enough (audit G7) ──

    def test_osm_only_install_geocodes(self, db, geonames_dir, osm_db):
        osm_db([dict(name="OsmCity", category="city", admin_level=8, area=1.0,
                     polygons=_rect(39.9, 40.1, -74.1, -73.9))])
        pid = _add_photo(db, lat=40.0, lng=-74.0)
        res = geocode_service.geocode_pending()
        assert res == {"processed": 1, "matched": 1, "available": True, "remaining": 0}
        row = index.get_photo(pid)
        assert row["loc_city"] == "OsmCity"
        assert row["loc_country_code"] is None    # OSM has no country polygons
        assert index.count_geocoded_photos() == 1  # a city alone counts as geocoded

    def test_census_only_install_geocodes_with_us_country(self, db, geonames_dir, census_db):
        census_db([{"name": "CensusPlace", "polygons": _rect(39.9, 40.1, -74.1, -73.9)}])
        pid = _add_photo(db, lat=40.0, lng=-74.0)
        res = geocode_service.geocode_pending()
        assert (res["available"], res["matched"]) == (True, 1)
        row = index.get_photo(pid)
        assert row["loc_city"] == "CensusPlace"
        assert row["loc_state"] == "Texas"
        assert (row["loc_country_code"], row["loc_country"]) == ("US", "United States")

    def test_respects_limit(self, db, geonames_dir):
        _write_geonames(geonames_dir)
        for i in range(3):
            _add_photo(db, path=f"g{i}.jpg", lat=40.001, lng=-74.001)
        res = geocode_service.geocode_pending(limit=2)
        assert res["processed"] == 2
        assert res["remaining"] == 1


class TestExportToSidecars:
    def test_writes_gps_and_location_for_geocoded_photo(self, db, tmp_path, et_session):
        img = _make_jpg(tmp_path / "e.jpg")
        pid = _add_photo(db, path=img, lat=1.0, lng=2.0)
        db.execute(
            "UPDATE photos SET loc_city=?, loc_state=?, loc_country=?, loc_country_code=? WHERE id=?",
            ("Testville", "New York", "United States", "US", pid))
        db.commit()

        res = geocode_service.export_to_sidecars()
        assert res["written"] == 1
        assert res["failed"] == 0
        assert (tmp_path / "e.xmp").exists()
        row = index.get_photo(pid)
        # Sidecar tracking + source are kept current so the next scan won't re-index the row.
        assert row["sidecar_path"] is not None
        assert row["geotag_source"] == "sidecar"

    def test_writes_gps_for_geotagged_photo_without_location(self, db, tmp_path, et_session):
        """A photo geotagged DB-only (config.WRITE_XMP_ON_GEOTAG=False) but not
        yet reverse-geocoded still gets its GPS exported."""
        img = _make_jpg(tmp_path / "e2.jpg")
        pid = _add_photo(db, path=img, lat=1.0, lng=2.0)

        res = geocode_service.export_to_sidecars()
        assert res["written"] == 1
        assert (tmp_path / "e2.xmp").exists()
        assert index.get_photo(pid)["geotag_source"] == "sidecar"

    def test_writes_city_without_country_code(self, db, tmp_path, et_session):
        """An OSM-only answer (city, no country) is still exported (audit G7);
        the tags with no value are simply not present."""
        img = _make_jpg(tmp_path / "e3.jpg")
        pid = _add_photo(db, path=img, lat=1.0, lng=2.0)
        db.execute("UPDATE photos SET loc_city=? WHERE id=?", ("OsmCity", pid))
        db.commit()

        assert geocode_service.export_to_sidecars()["written"] == 1
        tags = _place_tags(tmp_path / "e3.xmp")
        assert tags.get("XMP:City") == "OsmCity"
        assert not tags.get("XMP:Country")
        assert not tags.get("XMP:CountryCode")

    def test_unresolved_photo_keeps_existing_place_tags(self, db, tmp_path, et_session):
        """Nothing resolved in the DB -> the sidecar's place names are left alone."""
        from geotagger import sidecar
        img = _make_jpg(tmp_path / "e4.jpg")
        sidecar.write_gps(Path(img), 1.0, 2.0, location={"city": "Kept", "country_code": "US"})
        _add_photo(db, path=img, lat=1.0, lng=2.0)

        assert geocode_service.export_to_sidecars()["written"] == 1
        tags = _place_tags(tmp_path / "e4.xmp")
        assert tags.get("XMP:City") == "Kept"
        assert tags.get("XMP:CountryCode") == "US"

    def test_noop_when_nothing_geotagged(self, db, et_session):
        _add_photo(db)  # no lat/lng
        assert geocode_service.export_to_sidecars() == {
            "processed": 0, "written": 0, "failed": 0, "errors_sample": [],
            "cursor": 0, "remaining": 0}


class TestGetPhotoMetadata:
    def test_returns_dict_for_real_image(self, tmp_path, et_session):
        meta = photos_service.get_photo_metadata(_make_jpg(tmp_path / "m.jpg"))
        assert isinstance(meta, dict)

    def test_bad_path_degrades_to_dict(self, et_session):
        assert isinstance(photos_service.get_photo_metadata("/no/such/file.jpg"), dict)


def _make_jpg_oriented(path, orientation: int) -> str:
    """A JPEG carrying a real EXIF Orientation tag (274)."""
    img = Image.new("RGB", (8, 8), color="green")
    exif = img.getexif()
    exif[274] = orientation
    img.save(path, "JPEG", exif=exif.tobytes())
    return str(path)


class TestAddManualFace:
    """faces_service.add_manual_face — a hand-drawn box for a face detection missed."""

    def _no_model(self, monkeypatch):
        """Stand in for an absent InsightFace model: embedding fails, box survives."""
        def boom(*a, **k):
            raise RuntimeError("no model")
        monkeypatch.setattr(faces, "embed_bbox", boom)

    def test_stores_box_and_person(self, db, monkeypatch):
        monkeypatch.setattr(faces, "embed_bbox",
                            lambda *a, **k: (faces.encode_embedding(np.zeros(512)), 0.6))
        pid = _add_photo(db)
        person_id = index.get_or_create_person("Ada")

        res = faces_service.add_manual_face(pid, [0.1, 0.2, 0.3, 0.5], person_id)
        assert res["embedded"] is True
        assert res["det_score"] == 0.6

        rows = index.get_faces_for_photo(pid)
        assert len(rows) == 1
        assert rows[0]["source"] == "manual"
        assert rows[0]["person_id"] == person_id
        assert rows[0]["det_score"] == 1.0          # the user's assertion, not the model's
        assert [float(v) for v in rows[0]["bbox"].split(",")] == [0.1, 0.2, 0.3, 0.5]

    def test_maps_display_box_to_sensor_space(self, db, monkeypatch):
        self._no_model(monkeypatch)
        pid = _add_photo(db)
        db.execute("UPDATE photos SET orientation=6 WHERE id=?", (pid,))
        db.commit()

        drawn = [0.1, 0.2, 0.3, 0.5]
        faces_service.add_manual_face(pid, drawn)
        stored = [float(v) for v in index.get_faces_for_photo(pid)[0]["bbox"].split(",")]
        # Stored sensor-space, and orienting it back for display recovers what was drawn.
        assert stored != drawn
        assert serializers.thumbnails.orient_bbox(stored, 6) == pytest.approx(drawn, abs=1e-4)

    def test_survives_a_missing_model(self, db, monkeypatch):
        self._no_model(monkeypatch)
        pid = _add_photo(db)
        res = faces_service.add_manual_face(pid, [0.1, 0.1, 0.4, 0.4])
        assert res["embedded"] is False
        # Still listed for the photo (the join is a LEFT JOIN for exactly this).
        rows = index.get_faces_for_photo(pid)
        assert len(rows) == 1
        assert rows[0]["embedding"] is None
        # ...but stays out of the recognition gallery / unlabeled matrix.
        assert index.get_unlabeled_faces() == []

    def test_rejects_a_degenerate_box(self, db, monkeypatch):
        self._no_model(monkeypatch)
        pid = _add_photo(db)
        with pytest.raises(ValueError):
            faces_service.add_manual_face(pid, [0.5, 0.5, 0.5005, 0.9])

    def test_rejects_unknown_photo(self, db):
        with pytest.raises(ValueError):
            faces_service.add_manual_face(999999, [0.1, 0.1, 0.4, 0.4])

    def test_survives_a_routine_rescan_but_not_a_nuke(self, db, monkeypatch):
        """source='manual' is the whole point: replace_faces only drops detected rows."""
        self._no_model(monkeypatch)
        pid = _add_photo(db)
        faces_service.add_manual_face(pid, [0.1, 0.1, 0.4, 0.4])

        index.replace_faces(pid, [])                  # a detection pass that found nothing
        assert len(index.get_faces_for_photo(pid)) == 1

        index.delete_photo_faces([pid])               # the nuclear option
        assert index.get_faces_for_photo(pid) == []

    def test_delete_manual_face_only_deletes_manual(self, db, monkeypatch):
        self._no_model(monkeypatch)
        pid = _add_photo(db)
        index.replace_faces(pid, [{"bbox": "0.6,0.6,0.7,0.7", "det_score": 0.5,
                                   "embedding": faces.encode_embedding(np.zeros(512))}])
        detected_id = index.get_faces_for_photo(pid)[0]["id"]
        manual_id = index.add_manual_face(pid, "0.1,0.1,0.2,0.2")

        assert index.delete_manual_face(detected_id) is False
        assert index.delete_manual_face(manual_id) is True
        assert [r["id"] for r in index.get_faces_for_photo(pid)] == [detected_id]


class TestRefreshOrientations:
    def test_corrects_stale_stored_orientation(self, db, tmp_path, et_session):
        img = _make_jpg_oriented(tmp_path / "rot.jpg", 6)
        pid = _add_photo(db, path=img)          # _add_photo stores orientation=1
        assert faces_service.refresh_orientations([pid]) == 1
        assert index.get_photo(pid)["orientation"] == 6

    def test_noop_when_already_correct(self, db, tmp_path, et_session):
        img = _make_jpg_oriented(tmp_path / "ok.jpg", 1)
        pid = _add_photo(db, path=img)
        assert faces_service.refresh_orientations([pid]) == 0
        assert index.get_photo(pid)["orientation"] == 1

    def test_fills_in_null_orientation(self, db, tmp_path, et_session):
        img = _make_jpg_oriented(tmp_path / "null.jpg", 8)
        pid = _add_photo(db, path=img)
        db.execute("UPDATE photos SET orientation=NULL WHERE id=?", (pid,))
        db.commit()
        assert faces_service.refresh_orientations([pid]) == 1
        assert index.get_photo(pid)["orientation"] == 8

    def test_unknown_ids_are_skipped(self, db):
        assert faces_service.refresh_orientations([999999]) == 0


class TestUpdatePhotoTimes:
    def test_applies_offset_and_persists(self, db, tmp_path, et_session):
        img = _make_jpg(tmp_path / "t.jpg")
        pid = _add_photo(db, path=img, photo_datetime=1000)
        out = photos_service.update_photo_times(
            [{"id": pid, "expected": 1000, "target": 1000 + 3600}])
        assert out["written"] == [pid]
        assert index.get_photo(pid)["photo_datetime"] == 1000 + 3600
        assert (tmp_path / "t.xmp").exists()

    def test_skips_missing_photo_and_zero_timestamp(self, db, tmp_path, et_session):
        out = photos_service.update_photo_times(
            [{"id": 999999, "expected": 1000, "target": 1010}])
        assert out["written"] == [] and out["not_found"] == [999999]
        img = _make_jpg(tmp_path / "z.jpg")
        pid = _add_photo(db, path=img, photo_datetime=0)
        out = photos_service.update_photo_times(
            [{"id": pid, "expected": 1000, "target": 1010}])
        assert out["written"] == [] and [f["id"] for f in out["failed"]] == [pid]
        assert index.get_photo(pid)["photo_datetime"] == 0


class TestGuessDates:
    def test_filename_guess(self, db):
        pid = _add_photo(db, path="C:/Photos/Vacation/20111027-IMG_0015.JPG", photo_datetime=None)
        out = photos_service.guess_dates([pid])
        assert out == [{
            "photo_id": pid, "filename": "20111027-IMG_0015.JPG", "current_datetime": None,
            "guess": {"year": 2011, "month": 10, "day": 27, "precision": None, "source": "filename"},
        }]

    def test_folder_guess_when_no_filename_match(self, db):
        pid = _add_photo(db, path="C:/Photos/2011-10/IMG_0015.JPG", photo_datetime=None)
        out = photos_service.guess_dates([pid])
        assert out[0]["guess"] == {"year": 2011, "month": 10, "day": None,
                                   "precision": "month", "source": "folder"}

    def test_no_guess_available(self, db):
        pid = _add_photo(db, path="C:/Photos/Vacation/IMG_0015.JPG", photo_datetime=None)
        out = photos_service.guess_dates([pid])
        assert out[0]["guess"] is None

    def test_missing_photo_skipped(self, db):
        assert photos_service.guess_dates([999999]) == []


class TestCommitAndUndoGuessedDates:
    def test_commit_writes_sidecar_and_db_then_undo_restores(self, db, tmp_path, et_session):
        img = _make_jpg(tmp_path / "20111027-IMG_0015.JPG")
        pid = _add_photo(db, path=img, photo_datetime=None)

        result = photos_service.commit_guessed_dates(
            [{"photo_id": pid, "year": 2011, "month": 10, "day": 27, "precision": None}])
        assert result["updated"] == 1
        row = index.get_photo(pid)
        assert row["date_precision"] is None
        assert row["photo_datetime"] > 0
        assert (tmp_path / "20111027-IMG_0015.xmp").exists()

        reverted = photos_service.undo_date_commit(result["previous"])
        assert reverted == 1
        row = index.get_photo(pid)
        assert row["photo_datetime"] is None or row["photo_datetime"] == 0
        assert row["date_precision"] is None

    def test_commit_approximate_precision_then_undo(self, db, tmp_path, et_session):
        img = _make_jpg(tmp_path / "IMG_0015.jpg")
        pid = _add_photo(db, path=img, photo_datetime=None)

        result = photos_service.commit_guessed_dates(
            [{"photo_id": pid, "year": 2011, "month": None, "day": None, "precision": "year"}])
        assert index.get_photo(pid)["date_precision"] == "year"

        photos_service.undo_date_commit(result["previous"])
        row = index.get_photo(pid)
        assert row["date_precision"] is None
        assert row["photo_datetime"] is None or row["photo_datetime"] == 0

    def test_undo_restores_a_prior_real_date_not_just_undated(self, db, tmp_path, et_session):
        """Guessing over an already (wrongly) dated photo should be undoable
        back to that prior exact date, not just to 'undated'."""
        img = _make_jpg(tmp_path / "t.jpg")
        pid = _add_photo(db, path=img, photo_datetime=1000)
        from geotagger.sidecar import write_datetime
        write_datetime(Path(img), 1000)  # give it a real sidecar-backed date first

        result = photos_service.commit_guessed_dates(
            [{"photo_id": pid, "year": 2011, "month": 10, "day": 27, "precision": None}])
        assert index.get_photo(pid)["photo_datetime"] != 1000

        photos_service.undo_date_commit(result["previous"])
        assert index.get_photo(pid)["photo_datetime"] == 1000

    def test_missing_photo_skipped(self, db):
        assert photos_service.commit_guessed_dates(
            [{"photo_id": 999999, "year": 2011, "month": None, "day": None, "precision": "year"}]
        ) == {"updated": 0, "previous": []}
        assert photos_service.undo_date_commit([]) == 0


class TestScanFacesBatch:
    def test_missing_photo_is_skipped_without_the_model(self, db):
        # No InsightFace model needed: an unknown photo id short-circuits.
        assert faces_service.scan_faces_batch([999999]) == {
            "processed": 0, "faces_found": 0, "errors": []}


class TestComputeClusters:
    def test_recovers_two_pure_groups(self, db):
        rng = np.random.default_rng(0)
        c1, c2 = ff.unit_vectors(rng, 2)
        embs = np.concatenate([ff.cluster_around(rng, c1, 5),
                               ff.cluster_around(rng, c2, 5)])
        ff.seed_unlabeled(db, embs)

        rows, unknowns, times = faces.get_unlabeled_matrix()
        gallery = faces.build_gallery()          # empty: nothing labeled
        names = serializers.person_name_map()
        clusters = faces_service.compute_clusters(
            rows, unknowns, times, gallery, names,
            threshold=0.65, min_size=3, full=False)

        assert len(clusters) == 2
        assert sorted(c["size"] for c in clusters) == [5, 5]
        # Empty gallery -> no "looks like <known person>" suggestion.
        assert all(c["suggestion"] is None for c in clusters)
        # Samples are serializers.face_item dicts.
        first = clusters[0]["sample"][0]
        assert {"id", "bbox", "suggestion", "alternatives"} <= set(first)
        assert len(clusters[0]["face_ids"]) == 5

    def test_min_size_filters_small_groups(self, db):
        rng = np.random.default_rng(1)
        c1, c2 = ff.unit_vectors(rng, 2)
        # 5 of person A, only 2 of person B.
        embs = np.concatenate([ff.cluster_around(rng, c1, 5),
                               ff.cluster_around(rng, c2, 2)])
        ff.seed_unlabeled(db, embs)
        rows, unknowns, times = faces.get_unlabeled_matrix()
        clusters = faces_service.compute_clusters(
            rows, unknowns, times, faces.build_gallery(),
            serializers.person_name_map(), threshold=0.65, min_size=3, full=False)
        assert [c["size"] for c in clusters] == [5]
