"""Unit tests for geotagger.semantic + the photo_embeddings index helpers. The real
SigLIP model is never needed — see the `fake_semantic` fixture in conftest.py."""

import numpy as np
import pytest

from geotagger import config, index, semantic
from geotagger.services import semantic_service

MODEL = config.SEMANTIC_MODEL_NAME


def _add(name, dt=1000):
    index.upsert_photo(
        filename=name, dir_=".", ext=".jpg", media_type="image", mtime=1.0, size=1,
        lat=None, lng=None, geotag_source="none", sidecar_path=None, sidecar_mtime=None,
        camera="c", photo_datetime=dt, gps_accuracy=None, orientation=1,
    )
    return index.get_db().execute("SELECT id FROM photos WHERE filename=?", (name,)).fetchone()[0]


def _unit(*head):
    v = np.zeros(semantic.EMBED_DIM, dtype=np.float32)
    v[:len(head)] = head
    return v / np.linalg.norm(v)


# ── Text canonicalization (must match open_clip's 'canonicalize') ──

@pytest.mark.parametrize("raw, expected", [
    ("Sunset over the City!", "sunset over the city"),
    ("  red   neon\tsign ", "red neon sign"),
    ("snake_case_words", "snake case words"),
    ("it's a dog's life.", "its a dogs life"),
    ("", ""),
])
def test_canonicalize(raw, expected):
    assert semantic.canonicalize(raw) == expected


def test_tokenize_pads_and_truncates():
    class Tok:
        def __init__(self, n):
            self.n = n

        def encode(self, text):
            return type("E", (), {"ids": list(range(1, self.n + 1))})()

    short = semantic.tokenize(Tok(3), 0, "x")
    assert short.shape == (1, semantic.CONTEXT_LENGTH) and short.dtype == np.int32
    assert short[0, :4].tolist() == [1, 2, 3, 0]
    long = semantic.tokenize(Tok(100), 0, "x")
    assert long[0, -1] == semantic.CONTEXT_LENGTH


def test_preprocess_squashes_and_normalizes():
    from PIL import Image
    x = semantic.preprocess(Image.new("RGB", (400, 100), (255, 0, 127)), (224, 224),
                            np.array([.5, .5, .5], np.float32), np.array([.5, .5, .5], np.float32))
    assert x.shape == (1, 3, 224, 224)
    assert x[0, 0].mean() == pytest.approx(1.0) and x[0, 1].mean() == pytest.approx(-1.0)


def test_vec_round_trip_fp16():
    v = _unit(0.3, 0.4, 0.5)
    blob = semantic.encode_vec(v)
    assert len(blob) == semantic.EMBED_DIM * 2
    assert np.allclose(semantic.decode_vec(blob), v, atol=1e-3)


# ── DB helpers ──

def test_unembedded_respects_model_and_failures(db):
    a, b, c = _add("a.jpg"), _add("b.jpg"), _add("c.jpg")
    assert index.get_unembedded_photo_ids(MODEL) == [a, b, c]
    index.store_embeddings([(a, semantic.encode_vec(_unit(1))), (b, None)], MODEL)
    # b failed (vec NULL) — recorded, so not retried; c still pending.
    assert index.get_unembedded_photo_ids(MODEL) == [c]
    # A different model needs everything again.
    assert index.get_unembedded_photo_ids("other-model") == [a, b, c]
    counts = index.count_embeddings(MODEL)
    assert counts == {"total": 3, "embedded": 1, "failed": 1, "remaining": 1}


def test_delete_trigger_removes_embedding(db):
    a = _add("a.jpg")
    index.store_embeddings([(a, semantic.encode_vec(_unit(1)))], MODEL)
    index.get_db().execute("DELETE FROM photos WHERE id=?", (a,))
    index.get_db().commit()
    assert index.get_db().execute("SELECT COUNT(*) FROM photo_embeddings").fetchone()[0] == 0


def test_migration_on_existing_db_without_table(tmp_path, monkeypatch):
    monkeypatch.delenv("GEOTAGGER_CACHE_DIR", raising=False)
    conn = index.init_db(tmp_path)
    conn.execute("DROP TRIGGER photo_embeddings_delete")
    conn.execute("DROP TABLE photo_embeddings")
    conn.commit()
    conn.close()
    index._db = None
    conn = index.init_db(tmp_path)  # re-open: additive migration recreates it
    try:
        assert conn.execute("SELECT COUNT(*) FROM photo_embeddings").fetchone()[0] == 0
    finally:
        conn.close()
        index._db = None
        index._db_path = None


# ── Ranking + cache ──

def test_rank_filters_orders_and_thresholds(db):
    a, b, c = _add("a.jpg"), _add("b.jpg"), _add("c.jpg")
    index.store_embeddings([(a, semantic.encode_vec(_unit(1, 0))),
                            (b, semantic.encode_vec(_unit(1, 1))),
                            (c, semantic.encode_vec(_unit(0, 1)))], MODEL)
    q = _unit(1, 0)
    hits = semantic.rank(q, None, min_score=0.5)
    assert [pid for pid, _ in hits] == [a, b]            # c (score 0) below threshold
    assert hits[0][1] == pytest.approx(1.0, abs=1e-3)
    assert [pid for pid, _ in semantic.rank(q, [b, c, 999], 0.0)] == [b, c]
    assert semantic.rank(q, [], 0.0) == []
    assert [pid for pid, _ in semantic.rank(q, None, 0.5, exclude_id=a)] == [b]


def test_matrix_cache_rebuilds_on_change(db):
    a, b = _add("a.jpg"), _add("b.jpg")
    index.store_embeddings([(a, semantic.encode_vec(_unit(1)))], MODEL)
    ids, _ = semantic.get_matrix()
    assert ids.tolist() == [a]
    index.store_embeddings([(b, semantic.encode_vec(_unit(0, 1)))], MODEL)
    ids, mat = semantic.get_matrix()
    assert ids.tolist() == [a, b] and mat.shape == (2, semantic.EMBED_DIM)


# ── Service (with fake encoders) ──

def test_scan_embeds_records_failures_and_finishes(db, fake_semantic):
    _add("red_1.jpg"), _add("broken.jpg"), _add("blue_1.jpg")
    r = semantic_service.scan(limit=2)
    assert r["processed"] == 2 and r["remaining"] == 1
    assert len(r["errors"]) == 1 and "broken.jpg" in r["errors"][0]
    r = semantic_service.scan(limit=2)
    assert r["remaining"] == 0
    assert semantic_service.status()["embedded"] == 2


def test_search_text_and_similar(db, fake_semantic):
    red, green, blue = _add("red_1.jpg"), _add("green_1.jpg"), _add("blue_1.jpg")
    red2 = _add("red_2.jpg")
    semantic_service.scan(limit=10)
    hits = semantic_service.search_text("a red thing", None)
    assert {hits[0][0], hits[1][0]} == {red, red2}
    sim = semantic_service.similar_to(red, [green, blue, red2])
    assert sim[0][0] == red2
    with pytest.raises(ValueError):
        semantic_service.similar_to(_add("never_indexed.jpg"), None)


def test_service_requires_model(db, tmp_path, monkeypatch):
    monkeypatch.delenv("GEOTAGGER_CACHE_DIR", raising=False)
    semantic.init_semantic(tmp_path)  # no model files on disk
    _add("a.jpg")
    with pytest.raises(semantic_service.SemanticUnavailable):
        semantic_service.scan(limit=1)
    with pytest.raises(semantic_service.SemanticUnavailable):
        semantic_service.search_text("x", None)
