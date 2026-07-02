"""Recognition-math tests driven by synthetic embeddings (no InsightFace model).

Demonstrates the ``face_fixtures`` helpers: we manufacture 512-d embeddings with
known cosine structure, seed them through the real photo/person/face DB paths,
and assert the matching/clustering/age math behaves. See ``face_fixtures`` for
the two-tier rationale (this is Tier 1 — the frozen-real-embedding anchor is
separate).
"""
import numpy as np

import face_fixtures as ff
from geotagger import faces


def test_encode_decode_roundtrip():
    """The blob (de)serialization and the (N, 512) matrix reshape are lossless."""
    rng = np.random.default_rng(3)
    v = ff.unit_vectors(rng, 1)[0]
    back = faces.decode_embedding(faces.encode_embedding(v))
    assert back.dtype == np.float32
    assert np.allclose(back, v, atol=1e-6)

    # The joined-buffer path in _embeddings_matrix (the recognition hot path).
    m = ff.unit_vectors(rng, 4)
    rows = [{"embedding": faces.encode_embedding(x)} for x in m]
    matrix = faces._embeddings_matrix(rows)
    assert matrix.shape == (4, faces.EMBED_DIM)
    assert np.allclose(matrix, m, atol=1e-6)


def test_cluster_recovers_distinct_identities():
    """cluster_unlabeled splits well-separated identities into pure clusters."""
    rng = np.random.default_rng(0)
    n_people, per_person = 4, 5
    embs, labels = ff.synthetic_population(rng, n_people, per_person)

    clusters = faces.cluster_unlabeled(embs)  # default threshold 0.65, min_size 3

    assert len(clusters) == n_people
    covered = set()
    for cl in clusters:
        member_labels = {int(labels[i]) for i in cl}
        assert len(member_labels) == 1, "a cluster mixed two identities"
        assert len(cl) == per_person
        covered |= member_labels
    assert covered == set(range(n_people))


class TestMatching:
    def test_suggest_picks_the_right_person(self, db):
        rng = np.random.default_rng(1)
        centroids = ff.unit_vectors(rng, 2)
        alice, _ = ff.seed_person(db, "Alice", ff.cluster_around(rng, centroids[0], 6))
        bob, _ = ff.seed_person(db, "Bob", ff.cluster_around(rng, centroids[1], 6))

        gallery = faces.build_gallery()
        assert len(gallery) == 12

        query = ff.cluster_around(rng, centroids[0], 1)[0]  # a fresh photo of Alice
        result = faces.suggest_person(query, None, gallery)
        assert result is not None
        assert result[0] == alice
        assert result[1] >= 0.35

    def test_batch_matches_each_face_to_its_person(self, db):
        rng = np.random.default_rng(2)
        centroids = ff.unit_vectors(rng, 2)
        alice, _ = ff.seed_person(db, "Alice", ff.cluster_around(rng, centroids[0], 6))
        bob, _ = ff.seed_person(db, "Bob", ff.cluster_around(rng, centroids[1], 6))
        gallery = faces.build_gallery()

        qa = ff.cluster_around(rng, centroids[0], 2)
        qb = ff.cluster_around(rng, centroids[1], 2)
        fids = ff.seed_unlabeled(db, np.concatenate([qa, qb]))
        expected = {fids[0]: alice, fids[1]: alice, fids[2]: bob, fids[3]: bob}

        rows, unknowns, times = faces.get_unlabeled_matrix()
        scores = faces.suggest_persons_batch(rows, gallery, unknowns=unknowns, times=times)

        assert len(rows) == 4
        for row, score in zip(rows, scores):
            assert score is not None
            assert score[0] == expected[row["id"]]

    def test_threshold_boundary(self, db):
        """A face just over FACE_MATCH_THRESHOLD (0.35) matches; just under, None."""
        rng = np.random.default_rng(4)
        g = ff.unit_vectors(rng, 1)[0]
        person, _ = ff.seed_person(db, "Solo", g[None, :])
        gallery = faces.build_gallery()

        result = faces.suggest_person(ff.vec_at_cosine(rng, g, 0.40), None, gallery)
        assert result is not None and result[0] == person
        assert abs(result[1] - 0.40) < 1e-3  # score is the cosine we dialed in

        assert faces.suggest_person(ff.vec_at_cosine(rng, g, 0.30), None, gallery) is None


class TestAgeMath:
    def test_photo_predating_birth_is_excluded(self, db):
        """An identical embedding still won't match if the photo predates birth."""
        rng = np.random.default_rng(5)
        g = ff.unit_vectors(rng, 1)[0]
        ff.seed_person(db, "Kid", g[None, :], birth_date="2010-01-01",
                       photo_datetimes=ff.epoch(2015))
        gallery = faces.build_gallery()

        # Undated query: a perfect embedding match.
        assert faces.suggest_person(g, None, gallery) is not None
        # Same embedding, but dated 5 years before birth (> tolerance) → excluded.
        assert faces.suggest_person(g, ff.epoch(2005), gallery) is None
