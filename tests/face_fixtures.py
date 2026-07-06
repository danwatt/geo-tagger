"""Helpers for building face-recognition test data *without* the InsightFace model.

The recognition engine (``geotagger.faces``) is pure cosine geometry on 512-d
L2-normalized embeddings, so the math can be tested by *injecting* embeddings
whose pairwise similarities we control — no 275 MB model download, deterministic,
and fast.

Two tiers (only the first lives here):

* **Synthetic embeddings with controlled geometry** — the workhorse below. You
  define the ground-truth cosine structure, so assertions are exact instead of
  circular. In 512-d, random unit vectors are near-orthogonal (cosine ~ 0 ± 0.04),
  which is exactly why distinct identities separate cleanly in real ArcFace space,
  so this is a faithful stand-in for the matching/clustering tests.
* **A frozen fixture of real embeddings** (Tier 2) — generated once from real runs
  and committed as a small ``.npz``, used to sanity-check that the *default
  thresholds* hold on genuine ArcFace output. Not included here; add it if/when
  we want that regression anchor.

Everything routes through ``faces.encode_embedding`` so the blob round-trip and
the ``(N, 512)`` reshape in ``faces._embeddings_matrix`` stay under test — that
reshape assumes every blob is exactly 512×float32 and is a genuinely fragile spot.
"""
import calendar
import itertools
import time
from datetime import datetime

import numpy as np

from geotagger import faces, index

DIM = faces.EMBED_DIM  # 512
_BBOX = "0.00000,0.00000,1.00000,1.00000"  # a face row needs a bbox; content is irrelevant to the math
_photo_seq = itertools.count()  # unique synthetic photo paths across a test


# ── Synthetic embedding generators (pure numpy, no DB) ──

def _normalize(v: np.ndarray) -> np.ndarray:
    return v / np.linalg.norm(v, axis=-1, keepdims=True)


def unit_vectors(rng: np.random.Generator, n: int, dim: int = DIM) -> np.ndarray:
    """``n`` random L2-normalized float32 vectors. In high-d these are
    near-orthogonal, so each stands in for a *distinct* identity or centroid."""
    return _normalize(rng.standard_normal((n, dim)).astype(np.float32))


def cluster_around(rng: np.random.Generator, centroid: np.ndarray, k: int,
                   intra_cos: float = 0.8) -> np.ndarray:
    """``k`` unit vectors scattered around ``centroid`` so pairs sit at roughly
    ``intra_cos`` cosine — i.e. ``k`` different photos of the same person.

    Derives the noise scale from the closed form ``cos ~= 1 / (1 + dim*sigma^2)``
    for ``centroid + sigma*N(0, I)`` renormalized. Default 0.8 is comfortably
    above both the match (0.35) and cluster (0.65) thresholds.
    """
    dim = centroid.shape[-1]
    sigma = np.float32(np.sqrt(max(1.0 / intra_cos - 1.0, 0.0) / dim))
    noise = rng.standard_normal((k, dim)).astype(np.float32)
    return _normalize(centroid[None, :] + sigma * noise)


def vec_at_cosine(rng: np.random.Generator, base: np.ndarray, target: float) -> np.ndarray:
    """A unit vector at *exactly* ``target`` cosine to ``base`` (a unit vector).

    Built as ``target*base + sqrt(1-target^2)*perp`` with ``perp`` a random unit
    vector orthogonal to ``base``. Use it to pin down threshold boundaries (does
    a face at cosine 0.34 get rejected and 0.36 accepted?).
    """
    base = _normalize(np.asarray(base, np.float32))
    r = rng.standard_normal(base.shape).astype(np.float32)
    perp = _normalize(r - (r @ base) * base)  # Gram-Schmidt: strip the base component
    t = np.float32(target)
    s = np.float32(np.sqrt(1.0 - float(t) * float(t)))
    return _normalize(t * base + s * perp)


def synthetic_population(rng: np.random.Generator, n_people: int, faces_per_person: int,
                         intra_cos: float = 0.8, dim: int = DIM
                         ) -> tuple[np.ndarray, np.ndarray]:
    """Return ``(embeddings (N, dim), labels (N,))`` for ``n_people`` distinct
    identities, each with ``faces_per_person`` faces at ~``intra_cos`` cosine.

    Handy for the clustering path, which takes a bare matrix: assert
    ``cluster_unlabeled`` recovers exactly ``n_people`` pure clusters.
    """
    centroids = unit_vectors(rng, n_people, dim)
    embs, labels = [], []
    for pid, c in enumerate(centroids):
        embs.append(cluster_around(rng, c, faces_per_person, intra_cos))
        labels.extend([pid] * faces_per_person)
    return np.concatenate(embs).astype(np.float32), np.array(labels)


# ── DB seeding (routes through the real photo/person/face code paths) ──

def epoch(year: int, month: int = 1, day: int = 1) -> int:
    """UTC epoch seconds for a date — matches how photo_datetime is stored, via
    ``calendar.timegm`` (the project's own Windows-safe idiom for pre-1970 dates)."""
    return int(calendar.timegm(datetime(year, month, day).timetuple()))


def reset_faces_caches() -> None:
    """Drop the module-level recognition caches and bump the generation they key
    on, so a freshly-seeded DB isn't shadowed by a Gallery/matrix built earlier in
    the same test. (Cross-test isolation is handled by the ``db`` fixture teardown.)"""
    faces._gallery_cache = None
    faces._unlabeled_cache = None
    faces._suggested_scores_cache = None
    index.bump_faces_generation()


def _datetimes(photo_datetimes, k: int) -> list[int | None]:
    """Normalize the ``photo_datetimes`` arg to a per-face list of length ``k``."""
    if photo_datetimes is None:
        return [None] * k
    if np.isscalar(photo_datetimes):
        return [int(photo_datetimes)] * k
    dts = list(photo_datetimes)
    assert len(dts) == k, f"photo_datetimes has {len(dts)} entries, expected {k}"
    return [None if d is None else int(d) for d in dts]


def _insert_faces(db, embeddings: np.ndarray, person_id: int | None,
                  photo_datetimes, det_score: float) -> list[int]:
    """Insert one face per embedding, each backed by its own photo row (so
    ``photo_datetime`` can vary per face). Returns the new face ids in order."""
    embeddings = np.atleast_2d(np.asarray(embeddings, np.float32))
    dts = _datetimes(photo_datetimes, len(embeddings))
    now = time.time()
    face_ids: list[int] = []
    for vec, dt in zip(embeddings, dts):
        n = next(_photo_seq)
        # Real photo-insert path — exercises upsert_photo and gives the join in
        # get_labeled_faces / list_faces a photos row to hang photo_datetime on.
        index.upsert_photo(
            filename=f"face_{n}.jpg", dir_="/test", ext=".jpg",
            media_type="image", mtime=0.0, size=0, lat=None, lng=None,
            geotag_source="none", sidecar_path=None, sidecar_mtime=None,
            photo_datetime=dt,
        )
        photo_id = db.execute(
            "SELECT id FROM photos WHERE dir=? AND filename=?", ("/test", f"face_{n}.jpg")
        ).fetchone()[0]
        cur = db.execute(
            """INSERT INTO faces (photo_id, person_id, bbox, det_score, embedding,
                                  source, ignored, created_at, assigned_at)
               VALUES (?, ?, ?, ?, ?, 'detected', 0, ?, ?)""",
            (photo_id, person_id, _BBOX, det_score, faces.encode_embedding(vec),
             now, now if person_id is not None else None),
        )
        face_ids.append(cur.lastrowid)
    db.commit()
    return face_ids


def seed_person(db, name: str, embeddings: np.ndarray, *, birth_date: str | None = None,
                photo_datetimes=None, det_score: float = 0.9, labeled: bool = True
                ) -> tuple[int, list[int]]:
    """Create a person and insert ``embeddings`` ((k, 512)) as their faces.

    ``labeled=True`` → faces are assigned to the person, so they enter the
    recognition gallery (``build_gallery`` / ``get_labeled_faces``).
    ``labeled=False`` → faces are left unlabeled (they land in the suggestion
    queue) but still tied to a known ground-truth person via the return value.

    ``photo_datetimes`` is None, a scalar epoch (shared), or a per-face sequence.
    ``birth_date`` is ISO ``YYYY-MM-DD`` and powers the age-aware matching paths.
    Returns ``(person_id, [face_id, ...])``.
    """
    person_id = index.create_person(name)
    if birth_date is not None:
        index.set_person_birth_date(person_id, birth_date)
    face_ids = _insert_faces(db, embeddings, person_id if labeled else None,
                             photo_datetimes, det_score)
    reset_faces_caches()
    return person_id, face_ids


def seed_unlabeled(db, embeddings: np.ndarray, *, photo_datetimes=None,
                   det_score: float = 0.9) -> list[int]:
    """Insert unlabeled query faces (no person). Returns the new face ids in order.

    Use these as the "unknowns" for the suggestion paths (``get_unlabeled_matrix``,
    ``suggest_persons_batch``). ``det_score`` defaults to 0.9 so the faces clear
    the default ``FACE_SUGGEST_MIN_DET_SCORE`` floor and aren't filtered out.
    """
    face_ids = _insert_faces(db, embeddings, None, photo_datetimes, det_score)
    reset_faces_caches()
    return face_ids
