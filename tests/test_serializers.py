"""Unit tests for geotagger.serializers — the pure DB-row -> JSON shaping helpers.

These need no FastAPI app: they build real sqlite3.Row objects via the index layer
(and face_fixtures for face rows) and assert the exact dict shapes the API returns.
"""

import numpy as np

from geotagger import index, serializers

import face_fixtures as ff


def _add_photo(db, path="p.jpg", lat=None, lng=None, camera="Canon EOS",
               photo_datetime=1_600_000_000, gps_accuracy=None, media_type="image") -> int:
    index.upsert_photo(
        path=path, filename=path, dir_=".", ext=".jpg", media_type=media_type,
        mtime=1.0, size=100, lat=lat, lng=lng,
        geotag_source="sidecar" if lat is not None else "none",
        sidecar_path=None, sidecar_mtime=None, camera=camera,
        photo_datetime=photo_datetime, gps_accuracy=gps_accuracy, orientation=1,
    )
    return db.execute("SELECT id FROM photos WHERE path=?", (path,)).fetchone()[0]


class TestPhotoToDict:
    def test_grid_shape_and_types(self, db):
        pid = _add_photo(db, lat=10.0, lng=20.0, gps_accuracy=5.0)
        d = serializers.photo_to_dict(index.get_photo(pid))
        assert d == {
            "id": pid, "filename": "p.jpg", "media_type": "image",
            "lat": 10.0, "lng": 20.0, "geotag_source": "sidecar",
            "camera": "Canon EOS", "photo_datetime": 1_600_000_000,
            "gps_accuracy": 5.0, "geocode_ignored": False,
        }

    def test_zero_accuracy_becomes_none(self, db):
        pid = _add_photo(db, lat=1.0, lng=2.0, gps_accuracy=0.0)
        assert serializers.photo_to_dict(index.get_photo(pid))["gps_accuracy"] is None

    def test_geocode_ignored_is_bool(self, db):
        pid = _add_photo(db)
        db.execute("UPDATE photos SET geocode_ignored=1 WHERE id=?", (pid,))
        db.commit()
        assert serializers.photo_to_dict(index.get_photo(pid))["geocode_ignored"] is True


class TestPhotoGeocodeDict:
    def test_no_location_is_none(self, db):
        pid = _add_photo(db, lat=1.0, lng=2.0)
        d = serializers.photo_geocode_dict(index.get_photo(pid))
        assert d["location"] is None
        assert "geocode_ignored" not in d  # distinct shape from photo_to_dict

    def test_nested_location_when_present(self, db):
        pid = _add_photo(db, lat=1.0, lng=2.0)
        db.execute("UPDATE photos SET loc_city=?, loc_state=?, loc_country=? WHERE id=?",
                   ("Paris", "Île-de-France", "France", pid))
        db.commit()
        d = serializers.photo_geocode_dict(index.get_photo(pid))
        assert d["location"] == {"city": "Paris", "sublocation": None,
                                 "state": "Île-de-France", "country": "France"}

    def test_nested_location_includes_sublocation(self, db):
        pid = _add_photo(db, lat=1.0, lng=2.0)
        db.execute("UPDATE photos SET loc_city=?, loc_sublocation=?, loc_country=? WHERE id=?",
                   ("Paris", "Eiffel Tower", "France", pid))
        db.commit()
        d = serializers.photo_geocode_dict(index.get_photo(pid))
        assert d["location"]["sublocation"] == "Eiffel Tower"


class TestRowLocation:
    def test_none_when_country_missing(self, db):
        pid = _add_photo(db)
        assert serializers.row_location(index.get_photo(pid)) is None

    def test_dict_when_country_present(self, db):
        pid = _add_photo(db)
        db.execute("UPDATE photos SET loc_city=?, loc_state=?, loc_country=? WHERE id=?",
                   ("Rome", "Lazio", "Italy", pid))
        db.commit()
        assert serializers.row_location(index.get_photo(pid)) == {
            "city": "Rome", "sublocation": None, "state": "Lazio", "country": "Italy"}

    def test_defensive_against_rows_without_loc_columns(self, db):
        # A row that doesn't even carry the loc_* columns must not KeyError.
        _add_photo(db)
        row = db.execute("SELECT id, filename FROM photos").fetchone()
        assert serializers.row_location(row) is None


class TestFaceItem:
    def test_shape_from_list_faces_row(self, db):
        rng = np.random.default_rng(1)
        ff.seed_unlabeled(db, ff.unit_vectors(rng, 1), det_score=0.9)
        row = index.list_faces("all")[0]
        item = serializers.face_item(row)
        assert set(item) == {
            "id", "photo_id", "filename", "bbox", "det_score", "person_id",
            "person_name", "ignored", "photo_datetime", "assigned_at",
            "ignored_at", "location", "suggestion", "alternatives", "negatives",
        }
        assert item["suggestion"] is None
        assert item["alternatives"] == []
        assert item["ignored"] is False
        assert isinstance(item["bbox"], list) and len(item["bbox"]) == 4


class TestPersonNameMap:
    def test_maps_ids_to_names(self, db):
        a = index.create_person("Alice")
        b = index.create_person("Bob")
        assert serializers.person_name_map() == {a: "Alice", b: "Bob"}

    def test_empty_when_no_persons(self, db):
        assert serializers.person_name_map() == {}


class TestContextRowToDict:
    def test_shape_and_date_formatting(self, db):
        import json
        cid = index.create_context(
            "Trip", json.dumps([[0, 0], [0, 1], [1, 1]]),
            start_ts=1_577_836_800, end_ts=1_577_923_200,  # 2020-01-01, 2020-01-02
            min_lat=0, max_lat=1, min_lng=0, max_lng=1,
        )
        d = serializers.context_row_to_dict(index.get_context(cid))
        assert d["name"] == "Trip"
        assert d["polygon"] == [[0, 0], [0, 1], [1, 1]]
        assert d["start_date"] == "2020-01-01"
        assert d["end_date"] == "2020-01-02"
        assert d["persons"] == []

    def test_persons_included(self, db):
        import json
        cid = index.create_context("C", json.dumps([[0, 0], [0, 1], [1, 1]]),
                                   None, None, 0, 1, 0, 1)
        pid = index.create_person("Alice")
        # persons are accessed via p["id"] / p["name"], so real rows work here.
        d = serializers.context_row_to_dict(index.get_context(cid),
                                            index.get_context_persons(cid))
        assert d["persons"] == []  # none assigned yet
        index.set_context_persons(cid, [pid])
        d = serializers.context_row_to_dict(index.get_context(cid),
                                            index.get_context_persons(cid))
        assert d["persons"] == [{"id": pid, "name": "Alice"}]


class TestFormatCrowdGroupLabel:
    def test_zero_is_unknown(self):
        assert serializers.format_crowd_group_label(0) == "Unknown date"

    def test_formats_utc_date(self):
        # 2021-01-01 00:00:00 UTC
        assert serializers.format_crowd_group_label(1_609_459_200) == "January 1, 2021"
