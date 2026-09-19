"""The work queue: untagged photos rolled up into ranked, one-decision batches."""

import pytest

from geotagger import config, index
from geotagger.services import geotag_service, work_queue_service

HOUR = 3600
DAY = 86400
BASE = 1_700_000_000   # an arbitrary but fixed "now"


def _upsert(path, lat=None, lng=None, photo_datetime=BASE, camera="CamA",
            dir_=".", geotag_source="none"):
    index.upsert_photo(
        filename=path, dir_=dir_, ext=".jpg", media_type="image",
        mtime=1.0, size=1, lat=lat, lng=lng, geotag_source=geotag_source,
        sidecar_path=None, sidecar_mtime=None,
        camera=camera, photo_datetime=photo_datetime, gps_accuracy=None, orientation=1,
    )
    return index.get_db().execute(
        "SELECT id FROM photos WHERE filename=? AND dir=?", (path, dir_)
    ).fetchone()["id"]


def _run(n, *, start, step=60, camera="CamA", dir_=".", prefix="p"):
    """A run of `n` untagged photos `step` seconds apart. Returns their ids."""
    return [_upsert(f"{prefix}{i}.jpg", photo_datetime=start + i * step,
                    camera=camera, dir_=dir_) for i in range(n)]


@pytest.fixture(autouse=True)
def _clear_queue_cache():
    work_queue_service.invalidate()
    yield
    work_queue_service.invalidate()
    # The settings tests mutate config module attributes live; restore them even
    # when one fails mid-test, so the next test isn't run under a stray gap.
    for key in ("WORKQUEUE_SESSION_GAP", "WORKQUEUE_FOLDER_MIN_FRAC", "WORKQUEUE_MIN_SIZE"):
        config.reset_setting(key)


class TestSessions:
    def test_a_run_from_one_camera_is_one_batch(self, db):
        _run(10, start=BASE)
        sessions = [b for b in work_queue_service.build()["batches"] if b["kind"] == "session"]
        assert len(sessions) == 1
        assert sessions[0]["count"] == 10

    def test_a_camera_change_splits_the_session(self, db):
        _run(6, start=BASE, camera="CamA", prefix="a")
        _run(6, start=BASE + 60, camera="CamB", prefix="b")
        sessions = [b for b in work_queue_service.build()["batches"] if b["kind"] == "session"]
        assert sorted(b["camera"] for b in sessions) == ["CamA", "CamB"]

    def test_a_gap_over_the_threshold_splits_the_session(self, db):
        _run(6, start=BASE, prefix="morning")
        _run(6, start=BASE + 6 * HOUR, prefix="evening")   # > the 4 h default
        sessions = [b for b in work_queue_service.build()["batches"] if b["kind"] == "session"]
        assert len(sessions) == 2

    def test_a_multi_day_trip_with_short_nightly_gaps_stays_one_session(self, db):
        # Three days of shooting, each night a 3 h gap — under the threshold, so
        # the whole trip is the one decision it really is.
        for day in range(3):
            _run(5, start=BASE + day * (5 * 60 + 3 * HOUR), step=60, prefix=f"d{day}_")
        sessions = [b for b in work_queue_service.build()["batches"] if b["kind"] == "session"]
        assert len(sessions) == 1
        assert sessions[0]["count"] == 15

    def test_the_title_names_the_span_and_a_readable_camera(self, db):
        _run(6, start=BASE, camera="NIKON CORPORATION NIKON D300")
        title = next(b for b in work_queue_service.build()["batches"]
                     if b["kind"] == "session")["title"]
        assert "NIKON D300" == title.split("·")[-1].strip()

    def test_samples_are_the_first_middle_and_last_member(self, db):
        ids = _run(9, start=BASE)
        samples = next(b for b in work_queue_service.build()["batches"]
                       if b["kind"] == "session")["sample_photo_ids"]
        assert samples == [ids[0], ids[4], ids[-1]]


class TestFolders:
    def test_a_mostly_untagged_folder_becomes_a_batch(self, db):
        _run(8, start=BASE, dir_="scans/1985", prefix="s")
        folders = [b for b in work_queue_service.build()["batches"] if b["kind"] == "folder"]
        assert len(folders) == 1
        assert folders[0]["count"] == 8
        assert folders[0]["dir"] == "scans/1985"

    def test_a_mostly_tagged_folder_does_not(self, db):
        # 6 untagged of 20 = 30%, below the 80% floor.
        _run(6, start=BASE, dir_="mixed", prefix="u")
        for i in range(14):
            _upsert(f"t{i}.jpg", lat=40.0, lng=-75.0, dir_="mixed",
                    photo_datetime=BASE + i, geotag_source="sidecar")
        folders = [b for b in work_queue_service.build()["batches"] if b["kind"] == "folder"]
        assert folders == []

    def test_a_folder_drops_out_once_it_is_tagged_past_the_threshold(self, db):
        ids = _run(10, start=BASE, dir_="scans/1985", prefix="s")
        assert any(b["kind"] == "folder" for b in work_queue_service.build()["batches"])

        geotag_service.write_geotag(ids[:6], 40.0, -75.0)   # 4 of 10 left = 40%
        work_queue_service.invalidate()
        folders = [b for b in work_queue_service.build()["batches"] if b["kind"] == "folder"]
        assert folders == []

    def test_undated_folders_have_no_span_and_no_proposal(self, db):
        for i in range(8):
            _upsert(f"u{i}.jpg", photo_datetime=0, dir_="scans/box", camera=None)
        folder = next(b for b in work_queue_service.build()["batches"] if b["kind"] == "folder")
        assert folder["start_ts"] is None and folder["end_ts"] is None
        assert folder["proposal"] is None
        assert folder["confidence"] == 0


class TestVotes:
    def test_a_close_neighbour_votes_and_a_distant_one_does_not(self, db):
        _upsert("anchor.jpg", lat=40.0, lng=-75.0, photo_datetime=BASE,
                geotag_source="sidecar")
        _run(5, start=BASE + 600, step=60, prefix="near")     # 10 min away
        _run(5, start=BASE + 10 * HOUR, step=60, prefix="far")  # a separate outing

        sessions = [b for b in work_queue_service.build()["batches"] if b["kind"] == "session"]
        near = next(b for b in sessions if b["start_ts"] == BASE + 600)
        far = next(b for b in sessions if b["start_ts"] == BASE + 10 * HOUR)
        assert near["confidence"] == 1.0
        assert near["proposal"]["lat"] == pytest.approx(40.0)
        assert far["confidence"] == 0
        assert far["proposal"] is None

    def test_the_batch_label_matches_what_the_propose_bar_will_say(self, db):
        # Drift guard: the card must promise exactly what the user sees on arrival.
        _upsert("anchor.jpg", lat=40.0, lng=-75.0, photo_datetime=BASE,
                geotag_source="sidecar")
        ids = _run(6, start=BASE + 300, step=60, prefix="n")

        batch = next(b for b in work_queue_service.build()["batches"] if b["kind"] == "session")
        proposed = geotag_service.propose_locations(ids)
        assert batch["proposal"]["label"] == proposed["candidates"][0]["label"]
        assert batch["proposal"]["votes"] == proposed["candidates"][0]["votes"]


class TestRanking:
    def test_a_smaller_batch_with_a_guess_outranks_a_bigger_one_without(self, db):
        # 20 photos at confidence 1.0 (score 40) vs 30 with none (score 30).
        _upsert("anchor.jpg", lat=40.0, lng=-75.0, photo_datetime=BASE,
                geotag_source="sidecar")
        _run(20, start=BASE + 300, step=10, camera="Guessed", prefix="g")
        _run(30, start=BASE + 30 * DAY, step=10, camera="Blind", prefix="b")

        sessions = [b for b in work_queue_service.build()["batches"] if b["kind"] == "session"]
        assert sessions[0]["camera"] == "Guessed"
        assert sessions[0]["count"] == 20

    def test_batches_below_min_size_are_counted_not_listed(self, db):
        _run(10, start=BASE, camera="Big", dir_="big", prefix="big")
        _run(3, start=BASE + 30 * DAY, camera="Tiny", dir_="tiny", prefix="tiny")

        q = work_queue_service.build()
        assert [b["count"] for b in q["batches"] if b["kind"] == "session"] == [10]
        # The 3-photo session is dropped and nothing else covers those photos, so
        # they land in the tail — which is what makes Home's arithmetic add up.
        assert q["tail_photos"] == 3
        assert q["total_photos"] == 13

    def test_the_tail_excludes_small_batches_a_listed_batch_already_covers(self, db):
        # One folder of 13: a 3-photo session inside it is too small to list, but
        # the folder batch covers those photos, so they are not "left over".
        _run(10, start=BASE, camera="Big", dir_="box", prefix="big")
        _run(3, start=BASE + 30 * DAY, camera="Tiny", dir_="box", prefix="tiny")

        q = work_queue_service.build()
        assert q["tail_photos"] == 0


class TestBatchLookup:
    def test_get_batch_returns_only_still_untagged_members(self, db):
        ids = _run(10, start=BASE)
        batch_id = work_queue_service.build()["batches"][0]["id"]
        work_queue_service.invalidate()

        geotag_service.write_geotag(ids[:4], 40.0, -75.0)
        batch = work_queue_service.get_batch(batch_id)
        assert batch["photo_ids"] == ids[4:]

    def test_get_batch_is_gone_once_every_member_is_tagged(self, db):
        ids = _run(10, start=BASE)
        batch_id = work_queue_service.build()["batches"][0]["id"]
        work_queue_service.invalidate()

        geotag_service.write_geotag(ids, 40.0, -75.0)
        assert work_queue_service.get_batch(batch_id) is None

    def test_get_next_honours_the_skip_list(self, db):
        _run(20, start=BASE, camera="First", dir_="a", prefix="f")
        _run(10, start=BASE + 30 * DAY, camera="Second", dir_="b", prefix="s")

        head = work_queue_service.get_next(kind="session")
        assert head["camera"] == "First"
        assert work_queue_service.get_next(skip=[head["id"]], kind="session")["camera"] == "Second"

    def test_get_next_is_none_on_an_empty_queue(self, db):
        assert work_queue_service.get_next() is None


class TestCacheInvalidation:
    def test_tagging_photos_rebuilds_the_queue(self, db):
        ids = _run(10, start=BASE)
        assert work_queue_service.get_queue()["total_photos"] == 10

        geotag_service.write_geotag(ids, 40.0, -75.0)
        assert work_queue_service.get_queue()["total_photos"] == 0

    def test_ignoring_photos_rebuilds_the_queue(self, client):
        ids = _run(10, start=BASE)
        assert work_queue_service.get_queue()["total_photos"] == 10

        assert client.post("/api/geotag/ignore", json={"ids": ids, "ignored": True}).status_code == 200
        assert work_queue_service.get_queue()["total_photos"] == 0


class TestApi:
    def test_the_queue_endpoint_pages(self, client):
        for i in range(3):
            _run(10 - i, start=BASE + i * 30 * DAY, camera=f"Cam{i}", prefix=f"c{i}_")

        first = client.get("/api/work-queue?limit=1").json()
        assert first["total_batches"] >= 3
        assert len(first["batches"]) == 1

        second = client.get("/api/work-queue?limit=1&offset=1").json()
        assert second["batches"][0]["id"] != first["batches"][0]["id"]

    def test_batched_photos_is_a_union_not_a_sum(self, client):
        # The same 8 photos are both a session and a folder batch; counting them
        # twice would make the card claim more work than the library holds.
        _run(8, start=BASE, dir_="scans/1985", prefix="s")
        data = client.get("/api/work-queue").json()
        assert data["total_batches"] == 2
        assert data["batched_photos"] == 8

    def test_member_ids_stay_server_side(self, client):
        _run(8, start=BASE, dir_="scans/1985", prefix="s")
        assert all("member_ids" not in b
                   for b in client.get("/api/work-queue").json()["batches"])

    def test_the_kind_filter(self, client):
        _run(8, start=BASE, dir_="scans/1985", prefix="s")
        sessions = client.get("/api/work-queue?kind=session").json()["batches"]
        folders = client.get("/api/work-queue?kind=folder").json()["batches"]
        assert all(b["kind"] == "session" for b in sessions) and sessions
        assert all(b["kind"] == "folder" for b in folders) and folders

    def test_the_batch_endpoint_round_trips_an_id_containing_a_path(self, client):
        ids = _run(8, start=BASE, dir_="scans/1985 Box", prefix="s")
        from urllib.parse import quote
        folder = next(b for b in client.get("/api/work-queue?kind=folder").json()["batches"])
        res = client.get(f"/api/work-queue/batch/{quote(folder['id'], safe='')}")
        assert res.status_code == 200
        assert res.json()["photo_ids"] == ids

    def test_the_batch_endpoint_404s_when_the_batch_is_done(self, client):
        ids = _run(8, start=BASE)
        batch_id = client.get("/api/work-queue?kind=session").json()["batches"][0]["id"]
        client.post("/api/geotag/ignore", json={"ids": ids, "ignored": True})
        from urllib.parse import quote
        assert client.get(f"/api/work-queue/batch/{quote(batch_id, safe='')}").status_code == 404

    def test_the_next_endpoint_404s_on_an_empty_queue(self, client):
        assert client.get("/api/work-queue/next").status_code == 404


class TestPhotosDirFilter:
    def test_dir_matches_exactly_with_no_prefix_leakage(self, client):
        _upsert("a.jpg", dir_="photos/2024")
        _upsert("b.jpg", dir_="photos/2024-extra")

        rows = client.get("/api/photos?dir=photos/2024").json()
        assert [r["filename"] for r in rows] == ["a.jpg"]

    def test_dir_finds_undated_photos_too(self, client):
        _upsert("u.jpg", dir_="scans/box", photo_datetime=0)
        rows = client.get("/api/photos?dir=scans/box").json()
        assert [r["filename"] for r in rows] == ["u.jpg"]


class TestSettings:
    def test_the_knobs_are_live_tunable(self, client):
        # Two runs 6 h apart: one session at the default 4 h gap, one at 8 h.
        _run(6, start=BASE, dir_="a", prefix="m")
        _run(6, start=BASE + 6 * HOUR, dir_="b", prefix="e")
        sessions = lambda: [b for b in client.get("/api/work-queue?kind=session").json()["batches"]]
        assert len(sessions()) == 2

        res = client.patch("/api/settings", json={"values": {"WORKQUEUE_SESSION_GAP": 8 * HOUR}})
        assert res.status_code == 200
        # The cached build was made under the old gap — it must not survive.
        assert len(sessions()) == 1

        assert client.post("/api/settings/reset",
                           json={"keys": ["WORKQUEUE_SESSION_GAP"]}).status_code == 200
        assert len(sessions()) == 2

    def test_min_size_is_live_tunable(self, client):
        _run(3, start=BASE, dir_="tiny", prefix="t")
        assert client.get("/api/work-queue").json()["total_batches"] == 0

        client.patch("/api/settings", json={"values": {"WORKQUEUE_MIN_SIZE": 2}})
        assert client.get("/api/work-queue").json()["total_batches"] > 0
        client.post("/api/settings/reset", json={"keys": ["WORKQUEUE_MIN_SIZE"]})


class TestDirFacet:
    def test_dirs_list_is_ordered_by_untagged_work(self, client):
        _run(3, start=BASE, dir_="mostly-done", prefix="d")
        for i in range(9):
            _upsert(f"t{i}.jpg", lat=40.0, lng=-75.0, dir_="mostly-done",
                    photo_datetime=BASE + i, geotag_source="sidecar")
        _run(7, start=BASE, dir_="all-untagged", prefix="u")

        rows = client.get("/api/photos/dirs").json()
        assert [r["dir"] for r in rows] == ["all-untagged", "mostly-done"]
        assert rows[0] == {"dir": "all-untagged", "total": 7, "untagged": 7}
        assert rows[1] == {"dir": "mostly-done", "total": 12, "untagged": 3}

    def test_dirs_list_honours_the_cap(self, client):
        for i in range(5):
            _upsert(f"p{i}.jpg", dir_=f"dir{i}")
        assert len(client.get("/api/photos/dirs?limit=2").json()) == 2
