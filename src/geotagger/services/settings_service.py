"""Cache invalidation for runtime-tunable settings (config.SETTINGS_SPEC).

A settings change mutates the config attribute, but several in-memory caches were
built under the old value and would keep serving it — with no other write to
evict them, indefinitely. Each cache-owning module declares which settings it
bakes in as a ``SETTING_INVALIDATORS`` map next to its caches; this module only
gathers those maps and dispatches. Every path that applies a setting (the
settings PATCH and reset routes, a backup restore) calls ``invalidate_for``.

Startup's apply_all_overrides needs no call: it runs in lifespan before any
request can have built a cache.
"""

from collections.abc import Callable, Iterable

# Settings that have no in-memory cache to invalidate, and why. Kept explicit
# (and checked against SETTINGS_SPEC by the tests) so a new setting has to be
# placed in one bucket or the other instead of silently being neither.
CACHE_FREE_SETTINGS: dict[str, str] = {
    "WRITE_XMP_ON_GEOTAG": "read per geotag write",
    "RAW_FULL_DECODE": "on-disk renditions use a distinct _fd suffix, so the key "
                       "already changes with the setting",
    "FACE_DECODE_MAX_DIM": "face-detect decode is built in memory per scan, not cached; "
                           "only affects future detections",
    "FACE_AMBIGUITY_MARGIN": "read per suggest_for_person call",
    "FACE_GATE_MAX_EXAMPLES": "read per suggest_for_person call",
    "FACE_SUGGEST_SCAN_CAP": "part of the unlabeled-cache key",
    "FACE_PRESELECT_MIN_SCORE": "frontend-only; people.js reads it from /api/settings on load",
    "FACE_QUERY_LIMIT": "frontend-only; people.js reads it from /api/settings on load",
    "FACE_CROWD_MIN_SIZE": "read per /api/crowds request",
    "FACE_CLUSTER_THRESHOLD": "read per /api/faces/clusters request",
    "FACE_CLUSTER_MIN_SIZE": "read per /api/faces/clusters request",
    "FACE_CLUSTER_CAP": "read per /api/faces/clusters request",
    # Representative flags are persisted DB state recomputed only by the explicit
    # Recompute action (the UI says to rerun it) — not a cache, so a settings change
    # deliberately doesn't trigger that potentially long recluster.
    "FACE_DEDUP_MIN_FACES": "used only by the explicit representatives recompute",
    "FACE_DEDUP_THRESHOLD": "used only by the explicit representatives recompute",
    "FACE_DEDUP_MAX_FRACTION": "used only by the explicit representatives recompute",
    "SEMANTIC_MIN_SCORE": "applied per query; the vector matrix cache is raw embeddings",
    "SEMANTIC_SIMILAR_MIN_SCORE": "applied per query; the vector matrix cache is raw embeddings",
}


def setting_invalidators() -> dict[str, list[Callable[[], None]]]:
    """setting key -> the invalidation callables every cache owner registered for it."""
    # Local imports: faces pulls in numpy and the work queue its geocode chain;
    # neither is needed until a setting actually changes.
    from geotagger import faces
    from geotagger.services import work_queue_service
    merged: dict[str, list[Callable[[], None]]] = {}
    for owner in (faces.SETTING_INVALIDATORS, work_queue_service.SETTING_INVALIDATORS):
        for key, fn in owner.items():
            merged.setdefault(key, []).append(fn)
    return merged


def invalidate_for(keys: Iterable[str]) -> None:
    """Drop every cache whose contents depend on one of the changed ``keys``. Call
    after the new values are applied to config, so a rebuild can't pick up the old
    one. Each callable runs once even if several changed keys map to it."""
    registry = setting_invalidators()
    done: set[Callable[[], None]] = set()
    for key in keys:
        for fn in registry.get(key, ()):
            if fn not in done:
                done.add(fn)
                fn()
