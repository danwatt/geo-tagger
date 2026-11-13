import calendar
from datetime import datetime, timedelta

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


class TestLivePhotoSidecarPath:
    """Audit S5: a video that shares its stem with an image gets its own sidecar
    in basename mode instead of silently sharing the image's."""

    @pytest.fixture
    def pair(self, tmp_path, monkeypatch):
        monkeypatch.setattr(sidecar, "SIDECAR_MODE", "basename")
        (tmp_path / "IMG_1.HEIC").write_bytes(b"h")
        (tmp_path / "IMG_1.MOV").write_bytes(b"m")
        return tmp_path

    def test_image_keeps_basename_video_gets_fullname(self, pair):
        assert sidecar.sidecar_path(pair / "IMG_1.HEIC") == pair / "IMG_1.xmp"
        assert sidecar.sidecar_path(pair / "IMG_1.MOV") == pair / "IMG_1.MOV.xmp"

    def test_lone_video_keeps_basename(self, tmp_path, monkeypatch):
        monkeypatch.setattr(sidecar, "SIDECAR_MODE", "basename")
        (tmp_path / "VID.MOV").write_bytes(b"m")
        assert sidecar.sidecar_path(tmp_path / "VID.MOV") == tmp_path / "VID.xmp"

    def test_lowercase_extensions_pair_too(self, tmp_path, monkeypatch):
        monkeypatch.setattr(sidecar, "SIDECAR_MODE", "basename")
        (tmp_path / "a.jpg").write_bytes(b"j")
        (tmp_path / "a.mp4").write_bytes(b"v")
        assert sidecar.sidecar_path(tmp_path / "a.mp4") == tmp_path / "a.mp4.xmp"

    def test_fullname_mode_unchanged(self, pair, monkeypatch):
        monkeypatch.setattr(sidecar, "SIDECAR_MODE", "fullname")
        assert sidecar.sidecar_path(pair / "IMG_1.MOV") == pair / "IMG_1.MOV.xmp"
        assert sidecar.sidecar_name_candidates(pair / "IMG_1.MOV") == ("IMG_1.MOV.xmp",)

    def test_name_candidates_cover_both_video_names(self, pair):
        assert sidecar.sidecar_name_candidates(pair / "IMG_1.MOV") == ("IMG_1.xmp", "IMG_1.MOV.xmp")
        assert sidecar.sidecar_name_candidates(pair / "IMG_1.HEIC") == ("IMG_1.xmp",)

    def test_tracking_ignores_the_images_sidecar(self, pair):
        (pair / "IMG_1.xmp").write_bytes(b"x")
        assert sidecar.sidecar_tracking(pair / "IMG_1.MOV") == (None, None)
        assert sidecar.sidecar_tracking(pair / "IMG_1.HEIC")[0] == "IMG_1.xmp"

    def test_split_copies_and_never_overwrites(self, pair):
        (pair / "IMG_1.xmp").write_bytes(b"<shared/>")
        own = sidecar.split_shared_sidecar(pair / "IMG_1.MOV")
        assert own == pair / "IMG_1.MOV.xmp" and own.read_bytes() == b"<shared/>"
        assert (pair / "IMG_1.xmp").read_bytes() == b"<shared/>"
        own.write_bytes(b"<video's own/>")
        with pytest.raises(FileExistsError):
            sidecar.split_shared_sidecar(pair / "IMG_1.MOV")
        assert own.read_bytes() == b"<video's own/>"


@pytest.mark.usefixtures("et_session")
class TestLivePhotoWrites:
    @pytest.fixture
    def pair(self, tmp_path, sample_image, monkeypatch):
        # Real JPEG bytes under both names, so ExifTool can read the originals.
        monkeypatch.setattr(sidecar, "SIDECAR_MODE", "basename")
        data = sample_image.read_bytes()
        (tmp_path / "IMG_1.HEIC").write_bytes(data)
        (tmp_path / "IMG_1.MOV").write_bytes(data)
        return tmp_path / "IMG_1.HEIC", tmp_path / "IMG_1.MOV"

    def test_each_gets_its_own_sidecar(self, pair):
        heic, mov = pair
        assert sidecar.write_gps(heic, 10.0, 20.0) == heic.parent / "IMG_1.xmp"
        assert sidecar.write_gps(mov, 30.0, 40.0) == mov.parent / "IMG_1.MOV.xmp"
        assert sidecar.read_gps(heic)[:2] == pytest.approx((10.0, 20.0))
        assert sidecar.read_gps(mov)[:2] == pytest.approx((30.0, 40.0))

    def test_geotagging_the_image_leaves_the_video_alone(self, pair):
        heic, mov = pair
        sidecar.write_gps(heic, 10.0, 20.0)
        assert sidecar.read_gps(mov) == (None, None, "none")
        assert not (mov.parent / "IMG_1.MOV.xmp").exists()


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

    # Audit S1: these used to return None, leaving photo_datetime NULL and the
    # file re-read on every scan.
    _WALL = calendar.timegm((2024, 10, 2, 14, 23, 45, 0, 0, 0))

    def test_sub_seconds_are_tolerated(self):
        assert sidecar._parse_exif_datetime("2024:10:02 14:23:45.123") == self._WALL

    @pytest.mark.parametrize("suffix", ["Z", "+05:30", "-08:00", "+0530"])
    def test_offset_is_ignored_wall_clock_kept(self, suffix):
        # photo_datetime is wall-clock-as-UTC: the offset is not applied.
        assert sidecar._parse_exif_datetime(f"2024:10:02 14:23:45{suffix}") == self._WALL

    def test_sub_seconds_and_offset_together(self):
        assert sidecar._parse_exif_datetime("2024:10:02 14:23:45.50+05:30") == self._WALL

    def test_zero_date_is_unparseable(self):
        assert sidecar._parse_exif_datetime("0000:00:00 00:00:00") is None

    def test_impossible_date_is_unparseable(self):
        assert sidecar._parse_exif_datetime("2024:02:30 10:00:00") is None

    def test_trailing_junk_is_unparseable(self):
        assert sidecar._parse_exif_datetime("2024:10:02 14:23:45 garbage") is None


class TestPickDatetime:
    _WALL = calendar.timegm((2019, 1, 2, 3, 4, 5, 0, 0, 0))

    def test_zero_date_falls_through_to_next_candidate(self):
        assert sidecar._pick_datetime(
            [None, "0000:00:00 00:00:00", None, "2019:01:02 03:04:05"]) == self._WALL

    def test_first_parseable_candidate_wins(self):
        assert sidecar._pick_datetime(
            ["2019:01:02 03:04:05", "2000:01:01 00:00:00"]) == self._WALL

    def test_all_garbage_is_zero_not_none(self):
        assert sidecar._pick_datetime(["0000:00:00 00:00:00", "junk", ""]) == 0

    def test_no_candidates_is_zero(self):
        assert sidecar._pick_datetime([None, None]) == 0


class TestUnparseableDateIsFresh:
    """End to end: a file whose only date tag is a zeroed placeholder is stored
    as 0 and counts as fresh on the next scan, instead of NULL (never read)."""

    def test_zero_embedded_date_falls_through_to_embedded_xmp(self, et_session, sample_image):
        et = exiftool_session.get_et()
        et.execute("-overwrite_original", "-EXIF:DateTimeOriginal=0000:00:00 00:00:00",
                   "-XMP:DateTimeOriginal=2019:01:02 03:04:05", str(sample_image))
        # Guard the premise: the zeroed tag really is there (and truthy), so this
        # exercises the fall-through rather than a missing tag.
        assert et.get_tags([str(sample_image)], tags=["EXIF:DateTimeOriginal"])[0]             .get("EXIF:DateTimeOriginal") == "0000:00:00 00:00:00"
        assert sidecar.read_metadata(sample_image)["photo_datetime"] == \
            calendar.timegm((2019, 1, 2, 3, 4, 5, 0, 0, 0))

    def test_all_garbage_stores_zero_and_is_fresh_on_rescan(self, db, et_session, sample_image):
        from geotagger import index
        et = exiftool_session.get_et()
        et.execute("-overwrite_original", "-EXIF:DateTimeOriginal=0000:00:00 00:00:00",
                   str(sample_image))
        meta = sidecar.read_metadata(sample_image)
        assert meta["photo_datetime"] == 0

        st = sample_image.stat()
        d, name = str(sample_image.parent), sample_image.name
        index.upsert_photo(
            filename=name, dir_=d, ext=".jpg", media_type="image",
            mtime=st.st_mtime, size=st.st_size, lat=meta["lat"], lng=meta["lng"],
            geotag_source=meta["geotag_source"], sidecar_path=None, sidecar_mtime=None,
            camera=meta["camera"], photo_datetime=meta["photo_datetime"],
            gps_accuracy=meta["gps_accuracy"], orientation=meta["orientation"],
        )
        assert index.is_fresh(d, name, st.st_mtime, None, None)
        assert index.fresh_flags([(d, name, st.st_mtime, None, None)]) == [True]

    def test_legacy_null_row_is_stale_then_repaired(self, db, et_session, sample_image):
        """Rows already stuck at NULL by the old parser are re-read once (NULL is
        "never read") and the re-read stores 0, after which they are fresh."""
        from geotagger import index
        st = sample_image.stat()
        d, name = str(sample_image.parent), sample_image.name
        kw = dict(filename=name, dir_=d, ext=".jpg", media_type="image",
                  mtime=st.st_mtime, size=st.st_size, lat=None, lng=None,
                  geotag_source="none", sidecar_path=None, sidecar_mtime=None,
                  camera="", gps_accuracy=-1.0, orientation=1)
        index.upsert_photo(**kw, photo_datetime=None)
        assert not index.is_fresh(d, name, st.st_mtime, None, None)
        index.upsert_photo(**kw, photo_datetime=sidecar.read_metadata(sample_image)["photo_datetime"])
        assert index.is_fresh(d, name, st.st_mtime, None, None)


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


class _FakeLocalDatetime(datetime):
    """Stands in for sidecar.datetime on a machine in UTC+5:30: any conversion
    through the local zone (fromtimestamp without tz, .timestamp() on a naive
    value) is shifted, so code that wrongly goes through local time fails here
    even when the real machine/CI zone is UTC. Windows has no time.tzset(), so
    this is how the zone is forced portably."""
    _OFFSET = timedelta(hours=5, minutes=30)

    @classmethod
    def fromtimestamp(cls, ts, tz=None):
        if tz is not None:
            return super().fromtimestamp(ts, tz)
        return cls(1970, 1, 1) + timedelta(seconds=ts) + cls._OFFSET


# Wall-clock instants, incl. pre-1970 (negative epoch: fromtimestamp raises
# OSError on Windows) and a DST-ambiguous summer date.
_WALLCLOCKS = [
    datetime(2020, 5, 17, 10, 30, 0),
    datetime(2019, 1, 2, 3, 4, 5),
    datetime(1955, 6, 1, 12, 0, 0),
]


class TestDatetimeEpochHelpers:
    @pytest.mark.parametrize("wall", _WALLCLOCKS)
    def test_helpers_are_inverses(self, wall):
        ts = sidecar.wallclock_to_epoch(wall)
        assert sidecar.epoch_to_wallclock(ts) == wall

    def test_pre_1970_epoch_converts(self):
        assert sidecar.epoch_to_wallclock(-86400) == datetime(1969, 12, 31)

    @pytest.mark.parametrize("wall", _WALLCLOCKS)
    def test_write_datetime_hands_exiftool_the_exact_wallclock(self, wall, tmp_path, monkeypatch):
        """No ExifTool needed: capture the string write_datetime would write.
        The DB holds wall-clock-as-UTC, so the sidecar must get that same wall
        clock with no timezone shift, whatever the machine zone."""
        written = []
        monkeypatch.setattr(sidecar, "read_metadata", lambda p: {"photo_datetime": 0})
        monkeypatch.setattr(sidecar, "write_datetime_raw",
                            lambda p, s: written.append(s) or tmp_path / "x.xmp")
        monkeypatch.setattr(sidecar, "datetime", _FakeLocalDatetime)  # simulate UTC+5:30

        sidecar.write_datetime(tmp_path / "photo.jpg", calendar.timegm(wall.timetuple()))

        assert written == [wall.strftime("%Y:%m:%d %H:%M:%S")]

    def test_write_datetime_logging_old_time_does_not_use_local_zone(self, tmp_path, monkeypatch):
        # Pre-1970 old_ts used to hit fromtimestamp (OSError on Windows).
        monkeypatch.setattr(sidecar, "read_metadata", lambda p: {"photo_datetime": -86400 * 5})
        monkeypatch.setattr(sidecar, "write_datetime_raw", lambda p, s: tmp_path / "x.xmp")
        monkeypatch.setattr(sidecar, "datetime", _FakeLocalDatetime)
        sidecar.write_datetime(tmp_path / "photo.jpg", 0)


class TestDatetimeRoundTrip:
    @pytest.mark.parametrize("wall", _WALLCLOCKS)
    def test_write_then_read_datetime_is_identity(self, wall, et_session, sample_image):
        """True round trip: the epoch handed to write_datetime comes back
        unchanged from read_metadata, and the sidecar holds the wall-clock text."""
        ts_in = calendar.timegm(wall.timetuple())
        sidecar.write_datetime(sample_image, ts_in)

        assert sidecar.read_sidecar_datetime_raw(sample_image) == wall.strftime("%Y:%m:%d %H:%M:%S")
        assert sidecar.read_metadata(sample_image)["photo_datetime"] == ts_in

    def test_round_trip_in_a_forced_non_utc_zone(self, et_session, sample_image, monkeypatch):
        # Where the platform allows, force a real non-UTC zone as well (POSIX only;
        # the fake-datetime tests above cover Windows).
        import time
        if not hasattr(time, "tzset"):
            pytest.skip("time.tzset unavailable on this platform")
        monkeypatch.setenv("TZ", "Asia/Kolkata")
        time.tzset()
        try:
            ts_in = calendar.timegm(datetime(2020, 5, 17, 10, 30, 0).timetuple())
            sidecar.write_datetime(sample_image, ts_in)
            assert sidecar.read_metadata(sample_image)["photo_datetime"] == ts_in
        finally:
            monkeypatch.undo()
            time.tzset()

    def test_sidecar_datetime_correction_takes_priority_over_embedded(self, et_session, sample_image):
        # Regression guard for Time Sync: a correction written to the sidecar
        # (write_datetime never touches the original file) must win over
        # whatever is embedded in the image itself, mirroring GPS's
        # sidecar-first precedence. Give the image its own (wrong/original)
        # embedded timestamp first, then apply a sidecar correction.
        et = exiftool_session.get_et()
        et.execute("-overwrite_original", "-EXIF:DateTimeOriginal=2000:01:01 00:00:00", str(sample_image))

        corrected = datetime(2019, 1, 2, 3, 4, 5)
        sidecar.write_datetime(sample_image, calendar.timegm(corrected.timetuple()))

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
