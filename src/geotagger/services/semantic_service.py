"""Blocking semantic-search work, run on the shared executor: the embedding batch
loop, text/photo similarity ranking, and the one-shot model download job."""

import io
import logging
import threading
from pathlib import Path

from geotagger import config, index, scan_failures, semantic, thumbnails
from geotagger.scan_failures import BatchAborted, FailureStreak, FileUnreadable

logger = logging.getLogger(__name__)


class SemanticUnavailable(RuntimeError):
    """Model not downloaded — routes turn this into a 409 with a clear message."""


def _require_model():
    if not semantic.model_status()["available"]:
        raise SemanticUnavailable(
            "Text search model not downloaded — get it from Data Management first")


# ── Indexing ──

def _decode_preview(row):
    """The photo's upright preview as a fully decoded PIL image. Only this step can
    raise FileUnreadable: ``load()`` forces the decode here, since Image.open is
    lazy and would otherwise defer a corrupt file's error into encode_image, where
    it would read as a model failure."""
    from PIL import Image
    path = Path(index.photo_path(row))
    try:
        data = thumbnails.get_preview_oriented(path, row["mtime"], row["size"], row["orientation"])
        img = Image.open(io.BytesIO(data))
        img.load()
        return img
    except Exception as e:
        scan_failures.raise_classified(e, path)


def embed_batch(photo_ids: list[int], allow_failures: bool = False) -> dict:
    """Embed a batch of photos (blocking). Uses the cached *upright* display preview
    — already decoded from RAW/HEIC/video and cached, and CLIP-family models degrade
    on sideways images.

    A photo whose own file can't be read is stored as vec=NULL so the client loop
    moves on ("Retry failed" clears those). Anything else — the model failing to
    load or run, or a failure scan_failures can't pin on the file — raises
    BatchAborted, and so does a run of ``config.SCAN_FAILURE_STREAK_LIMIT``
    unreadable photos in a row unless ``allow_failures``; successes before the
    abort are still stored, the failing run is not (audit F1)."""
    _require_model()
    photo_rows = [r for r in (index.get_photo(pid) for pid in photo_ids) if r]
    if not photo_rows:
        return {"processed": 0, "errors": []}
    try:
        semantic.load_visual()
    except Exception as e:
        logger.exception("Semantic visual model failed to load")
        semantic.release_visual()
        raise BatchAborted(f"Text search model failed to load: {e}", code="model") from e

    rows: list[tuple[int, bytes | None]] = []
    errors: list[str] = []
    streak = FailureStreak(config.SCAN_FAILURE_STREAK_LIMIT, allow=allow_failures)
    try:
        for row in photo_rows:
            try:
                img = _decode_preview(row)
            except FileUnreadable as e:
                errors.append(f"{row['filename']}: {e}")
                streak.fail((row["id"], None), errors[-1])
                continue
            try:
                with img:
                    vec = semantic.encode_vec(semantic.encode_image(img))
            except Exception as e:
                logger.exception(f"Semantic embedding failed on {row['filename']}")
                # The session may be what broke; the next batch builds a fresh one.
                semantic.release_visual()
                raise BatchAborted(f"Text search model failed on {row['filename']}: {e}",
                                   code="model") from e
            rows.extend(streak.ok())
            rows.append((row["id"], vec))
    except BatchAborted as e:
        e.errors = e.errors or errors
        index.store_embeddings(rows, config.SEMANTIC_MODEL_NAME)
        raise
    rows.extend(streak.drain())
    index.store_embeddings(rows, config.SEMANTIC_MODEL_NAME)
    return {"processed": len(rows), "errors": errors}


def scan(limit: int, allow_failures: bool = False) -> dict:
    """One client-loop step: embed up to ``limit`` un-indexed photos, report what's
    left. Frees the visual model once nothing remains."""
    pending = index.get_unembedded_photo_ids(config.SEMANTIC_MODEL_NAME)
    result = embed_batch(pending[: max(1, limit)], allow_failures)
    result["remaining"] = len(pending) - result["processed"]
    result["failed"] = index.count_embeddings(config.SEMANTIC_MODEL_NAME)["failed"]
    if result["remaining"] <= 0:
        semantic.release_visual()
    return result


def retry_failed() -> dict:
    """Re-queue every photo whose file couldn't be read (vec=NULL)."""
    return {"requeued": index.clear_failed_embeddings(config.SEMANTIC_MODEL_NAME)}


def status() -> dict:
    return {"model": config.SEMANTIC_MODEL_NAME,
            "available": semantic.model_status()["available"],
            **index.count_embeddings(config.SEMANTIC_MODEL_NAME)}


# ── Search ──

def search_text(text: str, candidate_ids: list[int] | None) -> list[tuple[int, float]]:
    _require_model()
    return semantic.rank(semantic.encode_text(text), candidate_ids, config.SEMANTIC_MIN_SCORE)


def similar_to(photo_id: int, candidate_ids: list[int] | None) -> list[tuple[int, float]]:
    """"More like this": the photo's own stored vector as the query. Needs no model
    load at all — only the stored vectors."""
    blob = index.get_embedding(photo_id, config.SEMANTIC_MODEL_NAME)
    if blob is None:
        raise ValueError("This photo hasn't been indexed for text search yet")
    return semantic.rank(semantic.decode_vec(blob), candidate_ids,
                         config.SEMANTIC_SIMILAR_MIN_SCORE, exclude_id=photo_id)


# ── Model download job ──
_dl_lock = threading.Lock()
_dl_job: dict = {"running": False, "done": False, "error": None, "message": ""}


def model_status() -> dict:
    return semantic.model_status()


def model_job_status() -> dict:
    with _dl_lock:
        return dict(_dl_job)


def _progress(done_bytes: int, name: str):
    with _dl_lock:
        _dl_job["message"] = f"Downloading {name}… {done_bytes / 2**20:,.0f} MB of ~1,430 MB"


def _run_model_download(force: bool):
    try:
        semantic.download_model(force=force, progress_cb=_progress)
        st = semantic.model_status()
        index.record_dataset_download(
            dataset="semantic_model", region=st["name"],
            url=config.SEMANTIC_MODEL_URL.format(name=st["name"]),
            size_bytes=st["size_bytes"], records_loaded=None,
        )
        with _dl_lock:
            _dl_job["message"] = "Text search model ready."
            _dl_job["done"] = True
    except Exception as e:  # noqa: BLE001 — surfaced to the UI via job status
        logger.exception("Semantic model download failed")
        with _dl_lock:
            _dl_job["error"] = str(e)
    finally:
        with _dl_lock:
            _dl_job["running"] = False


def start_model_download(executor, force: bool = False) -> bool:
    """Start the download on the executor; False if one is already running.
    Idempotent: files already on disk are skipped unless ``force``."""
    with _dl_lock:
        if _dl_job["running"]:
            return False
        _dl_job.update(running=True, done=False, error=None, message="Starting…")
    executor.submit(_run_model_download, force)
    return True
