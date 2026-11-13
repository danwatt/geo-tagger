"""Blocking semantic-search work, run on the shared executor: the embedding batch
loop, text/photo similarity ranking, and the one-shot model download job."""

import io
import logging
import threading
from pathlib import Path

from geotagger import config, index, semantic, thumbnails

logger = logging.getLogger(__name__)


class SemanticUnavailable(RuntimeError):
    """Model not downloaded — routes turn this into a 409 with a clear message."""


def _require_model():
    if not semantic.model_status()["available"]:
        raise SemanticUnavailable(
            "Text search model not downloaded — get it from Data Management first")


# ── Indexing ──

def embed_batch(photo_ids: list[int]) -> dict:
    """Embed a batch of photos (blocking). Uses the cached *upright* display preview
    — already decoded from RAW/HEIC/video and cached, and CLIP-family models degrade
    on sideways images. Failures are stored as vec=NULL so they aren't retried
    forever by the client loop (same reasoning as faces_service.scan_faces_batch)."""
    from PIL import Image
    _require_model()
    rows: list[tuple[int, bytes | None]] = []
    errors: list[str] = []
    for pid in photo_ids:
        row = index.get_photo(pid)
        if not row:
            continue
        try:
            data = thumbnails.get_preview_oriented(
                Path(index.photo_path(row)), row["mtime"], row["size"], row["orientation"])
            with Image.open(io.BytesIO(data)) as img:
                rows.append((pid, semantic.encode_vec(semantic.encode_image(img))))
        except SemanticUnavailable:
            raise
        except Exception as e:  # noqa: BLE001 — per-photo failure, recorded and skipped
            errors.append(f"{row['filename']}: {e}")
            rows.append((pid, None))
    index.store_embeddings(rows, config.SEMANTIC_MODEL_NAME)
    return {"processed": len(rows), "errors": errors}


def scan(limit: int) -> dict:
    """One client-loop step: embed up to ``limit`` un-indexed photos, report what's
    left. Frees the visual model once nothing remains."""
    pending = index.get_unembedded_photo_ids(config.SEMANTIC_MODEL_NAME)
    result = embed_batch(pending[: max(1, limit)])
    result["remaining"] = len(pending) - result["processed"]
    if result["remaining"] <= 0:
        semantic.release_visual()
    return result


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
