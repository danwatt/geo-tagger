from geotagger import date_guess


class TestGuessDateFromFilename:
    def test_yyyymmdd_prefix(self):
        assert date_guess.guess_date_from_filename("20111027-IMG_0015.JPG") == (2011, 10, 27)

    def test_dash_separated(self):
        assert date_guess.guess_date_from_filename("2011-10-27 IMG_0015.jpg") == (2011, 10, 27)

    def test_android_style_embedded(self):
        assert date_guess.guess_date_from_filename("IMG_20111027_143000.jpg") == (2011, 10, 27)

    def test_invalid_calendar_date_rejected(self):
        assert date_guess.guess_date_from_filename("20111345-IMG_0015.JPG") is None

    def test_out_of_range_year_rejected(self):
        assert date_guess.guess_date_from_filename("19501027-IMG_0015.JPG") is None

    def test_longer_digit_run_not_matched(self):
        # A 10+ digit serial shouldn't be sliced into a fake date.
        assert date_guess.guess_date_from_filename("34620111027001.jpg") is None

    def test_no_date_in_filename(self):
        assert date_guess.guess_date_from_filename("IMG_0015.JPG") is None


class TestGuessDateFromDir:
    def test_year_month_segment(self):
        assert date_guess.guess_date_from_dir(r"C:\Photos\2011-10") == (2011, 10)

    def test_year_then_bare_month_child(self):
        assert date_guess.guess_date_from_dir("C:/Photos/2011/10") == (2011, 10)

    def test_year_then_non_month_child_falls_back_to_year_only(self):
        assert date_guess.guess_date_from_dir("C:/Photos/2011/Vacation") == (2011, None)

    def test_plain_year_segment(self):
        assert date_guess.guess_date_from_dir("C:/Scans/2011/Vacation") == (2011, None)

    def test_no_year_anywhere(self):
        assert date_guess.guess_date_from_dir("C:/Photos/Vacation") is None

    def test_out_of_range_year_segment_skipped(self):
        assert date_guess.guess_date_from_dir("C:/Photos/1950/Vacation") is None


class TestGuessDate:
    def test_filename_wins_over_folder(self):
        g = date_guess.guess_date("20111027-IMG_0015.JPG", "C:/Photos/2009")
        assert g == {"year": 2011, "month": 10, "day": 27, "precision": None, "source": "filename"}

    def test_folder_year_month_when_no_filename_match(self):
        g = date_guess.guess_date("IMG_0015.JPG", "C:/Photos/2011-10")
        assert g == {"year": 2011, "month": 10, "day": None, "precision": "month", "source": "folder"}

    def test_folder_year_only(self):
        g = date_guess.guess_date("IMG_0015.JPG", "C:/Photos/2011")
        assert g == {"year": 2011, "month": None, "day": None, "precision": "year", "source": "folder"}

    def test_no_guess_available(self):
        assert date_guess.guess_date("IMG_0015.JPG", "C:/Photos/Vacation") is None
