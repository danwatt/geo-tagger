"""Unit tests for geotagger.services.* — the framework-free blocking jobs the API
routes hand to the executor. No FastAPI here; they run the real DB / geocoder /
ExifTool / face-math code paths directly.

ExifTool-backed cases use the session-scoped ``et_session`` fixture and skip if the
binary isn't available; face detection (scan_faces_batch's happy path) needs the
275 MB InsightFace model, so only its model-free branch is covered here.
"""

import numpy as np
from PIL import Image

from geotagger import index, serializers, faces
from geotagger.services import geocode_service, photos_service, faces_service

import face_fixtures as ff


def _add_photo(db, path="p.jpg", lat=None, lng=None, photo_datetime=1_600_000_000) -> int:
    index.upsert_photo(
        path=path, filename=path.rsplit("/", 1)[-1], dir_=".", ext=".jpg",
        media_type="image", mtime=1.0, size=100, lat=lat, lng=lng,
        geotag_source="sidecar" if lat is not None else "none",
        sidecar_path=None, sidecar_mtime=None, camera="Cam",
        photo_datetime=photo_datetime, gps_accuracy=None, orientation=1,
    )
    return db.execute("SELECT id FROM photos WHERE path=?", (path,)).fetchone()[0]


def _make_jpg(path) -> str:
    Image.new("RGB", (8, 8), color="blue").save(path, "JPEG")
    return str(path)


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

    def test_respects_limit(self, db, geonames_dir):
        _write_geonames(geonames_dir)
        for i in range(3):
            _add_photo(db, path=f"g{i}.jpg", lat=40.001, lng=-74.001)
        res = geocode_service.geocode_pending(limit=2)
        assert res["processed"] == 2
        assert res["remaining"] == 1


class TestExportLocationsToSidecars:
    def test_writes_sidecar_for_geocoded_photo(self, db, tmp_path, et_session):
        img = _make_jpg(tmp_path / "e.jpg")
        pid = _add_photo(db, path=img, lat=1.0, lng=2.0)
        db.execute(
            "UPDATE photos SET loc_city=?, loc_state=?, loc_country=?, loc_country_code=? WHERE id=?",
            ("Testville", "New York", "United States", "US", pid))
        db.commit()

        res = geocode_service.export_locations_to_sidecars()
        assert res["written"] == 1
        assert res["errors"] == 0
        assert (tmp_path / "e.xmp").exists()
        # Sidecar tracking is kept current so the next scan won't re-index the row.
        assert index.get_photo(pid)["sidecar_path"] is not None

    def test_noop_when_nothing_geocoded(self, db, et_session):
        assert geocode_service.export_locations_to_sidecars() == {
            "written": 0, "errors": 0, "error_samples": []}


class TestGetPhotoMetadata:
    def test_returns_dict_for_real_image(self, tmp_path, et_session):
        meta = photos_service.get_photo_metadata(_make_jpg(tmp_path / "m.jpg"))
        assert isinstance(meta, dict)

    def test_bad_path_degrades_to_dict(self, et_session):
        assert isinstance(photos_service.get_photo_metadata("/no/such/file.jpg"), dict)


class TestUpdatePhotoTimes:
    def test_applies_offset_and_persists(self, db, tmp_path, et_session):
        img = _make_jpg(tmp_path / "t.jpg")
        pid = _add_photo(db, path=img, photo_datetime=1000)
        n = photos_service.update_photo_times({pid: 3600})
        assert n == 1
        assert index.get_photo(pid)["photo_datetime"] == 1000 + 3600
        assert (tmp_path / "t.xmp").exists()

    def test_skips_missing_photo_and_zero_timestamp(self, db, tmp_path, et_session):
        assert photos_service.update_photo_times({999999: 10}) == 0
        img = _make_jpg(tmp_path / "z.jpg")
        pid = _add_photo(db, path=img, photo_datetime=0)
        assert photos_service.update_photo_times({pid: 10}) == 0


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
