import calendar
from datetime import datetime

import pytest

from geotagger import sidecar, exiftool_session


# ── pure, no exiftool needed ──

class TestSidecarPath:
    def test_basename_mode_strips_extension(self, tmp_path, monkeypatch):
        monkeypatch.setattr(sidecar, "SIDECAR_MODE", "basename")
        assert sidecar.sidecar_path(tmp_path / "IMG_1.NEF") == tmp_path / "IMG_1.xmp"

    def test_fullname_mode_keeps_extension(self, tmp_path, monkeypatch):
        monkeypatch.setattr(sidecar, "SIDECAR_MODE", "fullname")
        assert sidecar.sidecar_path(tmp_path / "IMG_1.NEF") == tmp_path / "IMG_1.NEF.xmp"


class TestCoerceOrientation:
    def test_valid_values_pass_through(self):
        for v in range(1, 9):
            assert sidecar._coerce_orientation(v) == v

    def test_string_digits_are_parsed(self):
        assert sidecar._coerce_orientation("8") == 8

    def test_none_defaults_to_1(self):
        assert sidecar._coerce_orientation(None) == 1

    def test_out_of_range_defaults_to_1(self):
        assert sidecar._coerce_orientation(0) == 1
        assert sidecar._coerce_orientation(9) == 1

    def test_garbage_defaults_to_1(self):
        assert sidecar._coerce_orientation("rotate 90") == 1


class TestParseExifDatetime:
    def test_parses_standard_exif_format(self):
        ts = sidecar._parse_exif_datetime("2024:10:02 14:23:45")
        assert ts == calendar.timegm((2024, 10, 2, 14, 23, 45, 0, 0, 0))

    def test_none_for_empty_string(self):
        assert sidecar._parse_exif_datetime("") is None

    def test_none_for_garbage(self):
        assert sidecar._parse_exif_datetime("not a date") is None


# ── round-trip through a real exiftool process + sidecar file ──

class TestGpsRoundTrip:
    def test_write_then_read_gps(self, et_session, sample_image):
        sidecar.write_gps(sample_image, 40.7128, -74.0060)
        meta = sidecar.read_metadata(sample_image)
        assert meta["lat"] == pytest.approx(40.7128, abs=1e-5)
        assert meta["lng"] == pytest.approx(-74.0060, abs=1e-5)
        assert meta["geotag_source"] == "sidecar"

    def test_write_then_remove_gps(self, et_session, sample_image):
        sidecar.write_gps(sample_image, 40.7128, -74.0060)
        sidecar.remove_gps(sample_image)
        meta = sidecar.read_metadata(sample_image)
        assert meta["lat"] is None
        assert meta["lng"] is None
        assert meta["geotag_source"] == "none"

    def test_remove_gps_on_photo_with_no_sidecar_is_a_noop(self, et_session, sample_image):
        # No sidecar exists yet; remove_gps must not create one or raise.
        sidecar.remove_gps(sample_image)
        assert not sidecar.sidecar_path(sample_image).exists()

    def test_gps_accuracy_round_trips(self, et_session, sample_image):
        sidecar.write_gps(sample_image, 1.0, 2.0, gps_accuracy=12.5)
        meta = sidecar.read_metadata(sample_image)
        assert meta["gps_accuracy"] == pytest.approx(12.5)

    def test_write_gps_overwrites_previous_coordinates(self, et_session, sample_image):
        sidecar.write_gps(sample_image, 1.0, 2.0)
        sidecar.write_gps(sample_image, 3.0, 4.0)
        meta = sidecar.read_metadata(sample_image)
        assert meta["lat"] == pytest.approx(3.0)
        assert meta["lng"] == pytest.approx(4.0)


class TestLocationRoundTrip:
    def test_write_location_writes_place_name_tags(self, et_session, sample_image):
        location = {"city": "Springfield", "state": "Illinois",
                    "country": "United States", "country_code": "US"}
        sc = sidecar.write_location(sample_image, location)

        et = exiftool_session.get_et()
        tags = et.get_tags([str(sc)], tags=[
            "XMP-photoshop:City", "XMP-photoshop:State",
            "XMP-photoshop:Country", "XMP-iptcCore:CountryCode",
        ])[0]
        # pyexiftool's common "-G" arg returns family-0 group prefixes
        # ("XMP:City"), not the family-1 names used to select the tags.
        assert tags.get("XMP:City") == "Springfield"
        assert tags.get("XMP:State") == "Illinois"
        assert tags.get("XMP:Country") == "United States"
        assert tags.get("XMP:CountryCode") == "US"

    def test_remove_gps_clears_place_names_too(self, et_session, sample_image):
        location = {"city": "Springfield", "state": "Illinois",
                    "country": "United States", "country_code": "US"}
        sidecar.write_gps(sample_image, 1.0, 2.0, location=location)
        sidecar.remove_gps(sample_image)

        et = exiftool_session.get_et()
        sc = sidecar.sidecar_path(sample_image)
        tags = et.get_tags([str(sc)], tags=["XMP-photoshop:City"])[0]
        assert not tags.get("XMP:City")


class TestReadMetadataCamera:
    def test_file_without_make_model_reports_empty_camera(self, et_session, sample_image):
        """'' (not None) = read, nothing found. index.is_fresh treats a NULL
        camera as never-read and would re-scan the file on every boot."""
        assert sidecar.read_metadata(sample_image)["camera"] == ""


class TestReadOrientations:
    def test_missing_tag_defaults_to_1(self, et_session, sample_image):
        # A plain JPEG with no orientation tag must come back as 1, not absent.
        oris = sidecar.read_orientations([sample_image])
        assert oris[sample_image] == 1

    def test_reads_written_orientation(self, et_session, sample_image):
        et = exiftool_session.get_et()
        et.execute("-overwrite_original", "-EXIF:Orientation#=8", str(sample_image))
        oris = sidecar.read_orientations([str(sample_image)])
        # Keyed by Path regardless of whether the caller passed a str or Path.
        from pathlib import Path
        assert oris[Path(sample_image)] == 8

    def test_empty_list_returns_empty(self, et_session):
        assert sidecar.read_orientations([]) == {}


class TestDatetimeRoundTrip:
    def test_write_datetime_writes_local_wallclock_string(self, et_session, sample_image):
        dt = datetime(2020, 5, 17, 10, 30, 0)
        sidecar.write_datetime(sample_image, int(dt.timestamp()))

        et = exiftool_session.get_et()
        sc = sidecar.sidecar_path(sample_image)
        tags = et.get_tags([str(sc)], tags=["XMP:DateTimeOriginal"])[0]
        assert tags["XMP:DateTimeOriginal"] == dt.strftime("%Y:%m:%d %H:%M:%S")

    def test_write_then_read_datetime(self, et_session, sample_image):
        # write_datetime formats the given epoch as a *local* wall-clock string;
        # read_metadata (_parse_exif_datetime) parses that string back treating it
        # as UTC. The two are not inverses on a non-UTC host — this pins down the
        # actual round-trip contract rather than assuming naive symmetry.
        dt = datetime(2020, 5, 17, 10, 30, 0)
        ts_in = int(dt.timestamp())
        sidecar.write_datetime(sample_image, ts_in)
        got = sidecar.read_metadata(sample_image)["photo_datetime"]
        expected = calendar.timegm(datetime.fromtimestamp(ts_in).timetuple())
        assert got == expected

    def test_sidecar_datetime_correction_takes_priority_over_embedded(self, et_session, sample_image):
        # Regression guard for Time Sync: a correction written to the sidecar
        # (write_datetime never touches the original file) must win over
        # whatever is embedded in the image itself, mirroring GPS's
        # sidecar-first precedence. Give the image its own (wrong/original)
        # embedded timestamp first, then apply a sidecar correction.
        et = exiftool_session.get_et()
        et.execute("-overwrite_original", "-EXIF:DateTimeOriginal=2000:01:01 00:00:00", str(sample_image))

        corrected = datetime(2019, 1, 2, 3, 4, 5)
        sidecar.write_datetime(sample_image, int(corrected.timestamp()))

        meta = sidecar.read_metadata(sample_image)
        assert meta["photo_datetime"] == calendar.timegm(corrected.timetuple())


class TestArgumentInjectionGuard:
    """pyexiftool sends one argument per line to the -stay_open process, so a
    line break inside any argument becomes extra arguments."""

    def test_write_rejects_line_break_in_value(self, et_session, sample_image):
        with pytest.raises(ValueError):
            sidecar.write_datetime_raw(
                sample_image, "2011:10:27 00:00:00\n-XMP:Title=pwned")
        assert not sidecar.sidecar_path(sample_image).exists()

    def test_place_name_with_line_break_is_rejected(self, et_session, sample_image):
        with pytest.raises(ValueError):
            sidecar.write_location(sample_image, {"city": "Paris\n-XMP:Title=pwned"})
        assert not sidecar.sidecar_path(sample_image).exists()

    def test_read_rejects_line_break_in_path(self, et_session, sample_image):
        et = exiftool_session.get_et()
        with pytest.raises(ValueError):
            et.get_tags([f"{sample_image}\n-ver"], tags=["XMP:Title"])

    def test_session_still_usable_after_a_rejected_call(self, et_session, sample_image):
        with pytest.raises(ValueError):
            sidecar.write_datetime_raw(sample_image, "x\ny")
        sidecar.write_datetime_raw(sample_image, "2011:10:27 00:00:00")
        assert sidecar.read_sidecar_datetime_raw(sample_image) == "2011:10:27 00:00:00"
