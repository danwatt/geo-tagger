"""Settings changes invalidate exactly the caches that bake them in (audit F3).

The face caches (gallery, unlabeled matrix, suggestion scores) only rebuild on a
faces-table change, so before this a threshold or age-penalty change via the
Settings page was ignored by the suggested-only review until restart. Each test
warms the caches through the real endpoint, changes one setting through the
settings API, and checks the very next suggestions reflect it."""

import numpy as np
import pytest

import face_fixtures as ff
from geotagger import config, faces, index
from geotagger.services import backup_service, settings_service


@pytest.fixture(autouse=True)
def _restore_settings():
    """The settings routes mutate module attributes; put every one back."""
    yield
    for key in config.SETTINGS_DEFAULTS:
        config.reset_setting(key)


def _suggested(client) -> dict[int, float]:
    """face_id -> score from the suggested-only listing (the cached scores path)."""
    r = client.get("/api/faces?scope=unlabeled&suggested_only=true")
    assert r.status_code == 200
    return {f["id"]: f["suggestion"]["score"] for f in r.json()["faces"]}


def _patch(client, **values):
    r = client.patch("/api/settings", json={"values": values})
    assert r.status_code == 200, r.text


def _reset(client, *keys):
    r = client.post("/api/settings/reset", json={"keys": list(keys)})
    assert r.status_code == 200, r.text


def _one_example(rng, *, birth_date=None, example_dt=None, bbox=None):
    """Person "Ann" with a single labeled example; returns its embedding, so an
    unknown built with vec_at_cosine scores exactly that cosine (before age
    adjustment)."""
    db = index.get_db()
    example = ff.unit_vectors(rng, 1)[0]
    _, (fid,) = ff.seed_person(db, "Ann", example[None, :], birth_date=birth_date,
                               photo_datetimes=example_dt)
    if bbox is not None:
        db.execute("UPDATE faces SET bbox=? WHERE id=?", (bbox, fid))
        db.commit()
        ff.reset_faces_caches()
    return example


# ── Face knobs that must invalidate ──

def test_match_threshold_patch_and_reset(client):
    rng = np.random.default_rng(1)
    example = _one_example(rng)
    (u,) = ff.seed_unlabeled(index.get_db(), ff.vec_at_cosine(rng, example, 0.45)[None, :])

    assert u in _suggested(client)                       # 0.45 >= default 0.35; caches warm
    _patch(client, FACE_MATCH_THRESHOLD=0.5)
    assert u not in _suggested(client)
    _reset(client, "FACE_MATCH_THRESHOLD")
    assert u in _suggested(client)


def test_age_penalty_knobs(client):
    rng = np.random.default_rng(2)
    example = _one_example(rng, birth_date="2000-01-01", example_dt=ff.epoch(2000, 1, 1))
    # Ten years older than the example: gap 10 → penalty min(10, cap) * per_year.
    (u,) = ff.seed_unlabeled(index.get_db(), ff.vec_at_cosine(rng, example, 0.6)[None, :],
                             photo_datetimes=ff.epoch(2010, 1, 1))

    assert u in _suggested(client)                       # 0.6 - 10*0.02 = 0.4
    _patch(client, FACE_AGE_PENALTY_PER_YEAR=0.03)
    assert u not in _suggested(client)                   # 0.6 - 0.3 = 0.3
    _patch(client, FACE_AGE_PENALTY_CAP_YEARS=2.0)
    assert u in _suggested(client)                       # 0.6 - 2*0.03 = 0.54
    _reset(client, "FACE_AGE_PENALTY_PER_YEAR", "FACE_AGE_PENALTY_CAP_YEARS")
    assert _suggested(client)[u] == pytest.approx(0.4, abs=1e-3)


def test_birth_tolerance(client):
    rng = np.random.default_rng(3)
    example = _one_example(rng, birth_date="2000-07-01", example_dt=ff.epoch(2000, 7, 1))
    # ~0.3 years before birth: inside the default 0.5-year grace, outside 0.1.
    (u,) = ff.seed_unlabeled(index.get_db(), ff.vec_at_cosine(rng, example, 0.6)[None, :],
                             photo_datetimes=ff.epoch(2000, 3, 15))

    assert u in _suggested(client)
    _patch(client, FACE_BIRTH_TOLERANCE_YEARS=0.1)
    assert u not in _suggested(client)
    _reset(client, "FACE_BIRTH_TOLERANCE_YEARS")
    assert u in _suggested(client)


def test_suggest_min_det_score(client):
    rng = np.random.default_rng(4)
    example = _one_example(rng)
    (u,) = ff.seed_unlabeled(index.get_db(), ff.vec_at_cosine(rng, example, 0.6)[None, :],
                             det_score=0.7)

    assert u in _suggested(client)                       # 0.7 clears the 0.65 floor
    _patch(client, FACE_SUGGEST_MIN_DET_SCORE=0.8)
    assert u not in _suggested(client)
    _reset(client, "FACE_SUGGEST_MIN_DET_SCORE")
    assert u in _suggested(client)


def test_min_gallery_bbox_area(client):
    rng = np.random.default_rng(5)
    # A 0.05 x 0.05 example (area 0.0025) is below the default 0.01 floor, so it
    # can't anchor a match until the floor is lowered.
    example = _one_example(rng, bbox="0.10000,0.10000,0.15000,0.15000")
    (u,) = ff.seed_unlabeled(index.get_db(), ff.vec_at_cosine(rng, example, 0.6)[None, :])

    assert u not in _suggested(client)
    _patch(client, FACE_MIN_GALLERY_BBOX_AREA=0.0)
    assert u in _suggested(client)
    _reset(client, "FACE_MIN_GALLERY_BBOX_AREA")
    assert u not in _suggested(client)


# ── Targeted, not blanket ──

def _warm(client):
    rng = np.random.default_rng(6)
    example = _one_example(rng)
    ff.seed_unlabeled(index.get_db(), ff.vec_at_cosine(rng, example, 0.6)[None, :])
    assert _suggested(client)
    return faces._gallery_cache, faces._unlabeled_cache, faces._suggested_scores_cache


def test_unrelated_settings_leave_face_caches_alone(client):
    gallery, unlabeled, scores = _warm(client)
    _patch(client, WORKQUEUE_MIN_SIZE=7, FACE_QUERY_LIMIT=1000,
           FACE_AMBIGUITY_MARGIN=0.1, SEMANTIC_MIN_SCORE=0.1)
    _reset(client, "WORKQUEUE_MIN_SIZE", "FACE_CLUSTER_THRESHOLD")
    assert faces._gallery_cache is gallery
    assert faces._unlabeled_cache is unlabeled
    assert faces._suggested_scores_cache is scores


def test_score_knob_keeps_rows_and_gallery(client):
    gallery, unlabeled, _ = _warm(client)
    _patch(client, FACE_MATCH_THRESHOLD=0.4)
    assert faces._suggested_scores_cache is None
    _suggested(client)
    assert faces._gallery_cache is gallery and faces._unlabeled_cache is unlabeled


def test_gallery_knob_keeps_unlabeled_rows(client):
    gallery, unlabeled, _ = _warm(client)
    gen = index.faces_generation()
    _patch(client, FACE_MIN_GALLERY_BBOX_AREA=0.02)
    _suggested(client)
    assert faces._gallery_cache is not gallery
    assert faces._unlabeled_cache is unlabeled
    assert index.faces_generation() == gen    # no full generation bump


def test_in_flight_scores_from_old_knobs_are_not_served(client, monkeypatch):
    """A matmul that started before a threshold change must not be filed as current."""
    rng = np.random.default_rng(7)
    example = _one_example(rng)
    (u,) = ff.seed_unlabeled(index.get_db(), ff.vec_at_cosine(rng, example, 0.45)[None, :])
    real = faces.suggest_persons_batch

    def racing(*a, **k):
        out = real(*a, **k)                  # computed under the old threshold
        config.apply_setting_override("FACE_MATCH_THRESHOLD", 0.5)
        settings_service.invalidate_for(["FACE_MATCH_THRESHOLD"])
        return out
    monkeypatch.setattr(faces, "suggest_persons_batch", racing)
    faces.get_suggested_scores()
    monkeypatch.setattr(faces, "suggest_persons_batch", real)
    rows, scores = faces.get_suggested_scores()
    assert all(s is None for r, s in zip(rows, scores) if r["id"] == u)


# ── Registry coverage and the backup-restore path ──

def test_every_setting_is_classified_exactly_once():
    spec_keys = {s["key"] for s in config.SETTINGS_SPEC}
    mapped = set(settings_service.setting_invalidators())
    free = set(settings_service.CACHE_FREE_SETTINGS)
    assert not (mapped & free)
    assert mapped | free == spec_keys


def test_backup_restore_invalidates_for_restored_settings(db, monkeypatch):
    calls = []
    monkeypatch.setattr(settings_service, "invalidate_for", lambda keys: calls.append(set(keys)))
    ctx = backup_service._Ctx(db=db, b={}, overwrite=False, photo_ids=[], face_ids=[])
    ctx.applied_settings = {"FACE_MATCH_THRESHOLD": 0.45}
    backup_service._after_commit(ctx)
    assert config.FACE_MATCH_THRESHOLD == 0.45
    assert calls == [{"FACE_MATCH_THRESHOLD"}]
