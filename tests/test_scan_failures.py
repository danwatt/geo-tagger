"""Audit F1: a systemic failure (model won't load/run, disk full, folder gone) must
abort a face/semantic batch with nothing marked, while a photo whose own file is
unreadable is recorded — distinguishably from "scanned, 0 faces" / "embedded" —
and can be re-queued with "retry failed". No real models: the InsightFace app and
the detection preview are faked."""

import errno
import io
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
from PIL import Image

from geotagger import config, faces, index, scan_failures, thumbnails
from geotagger.scan_failures import BatchAborted, FileUnreadable
from geotagger.services import faces_service, semantic_service


def _add(dir_: Path, name: str) -> int:
    index.upsert_photo(
        filename=name, dir_=str(dir_), ext=".jpg", media_type="image", mtime=1.0, size=1,
        lat=None, lng=None, geotag_source="none", sidecar_path=None, sidecar_mtime=None,
        camera="c", photo_datetime=1000, gps_accuracy=None, orientation=1,
    )
    return index.get_db().execute(
        "SELECT id FROM photos WHERE dir=? AND filename=?", (str(dir_), name)).fetchone()[0]


def _jpeg() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (32, 32), (120, 120, 120)).save(buf, "JPEG")
    return buf.getvalue()


class FakeApp:
    """Stands in for insightface's FaceAnalysis: one face for files named face_*,
    none otherwise; ``fail`` makes inference itself blow up."""

    def __init__(self):
        self.fail = False
        self.next_faces = 0

    def get(self, arr):
        if self.fail:
            raise RuntimeError("onnxruntime: CUDA out of memory")
        emb = np.ones(faces.EMBED_DIM, dtype=np.float32) / np.sqrt(faces.EMBED_DIM)
        return [SimpleNamespace(bbox=[4, 4, 20, 20], det_score=0.9, normed_embedding=emb)
                for _ in range(self.next_faces)]


@pytest.fixture
def fake_faces(db, tmp_path, monkeypatch):
    app = FakeApp()
    monkeypatch.setattr(faces, "_get_app", lambda: app)

    def fake_preview(path, mtime, size, orientation=None):
        name = Path(path).name
        app.next_faces = 1 if name.startswith("face_") else 0
        if name.startswith("broken"):
            raise OSError("cannot identify image file")
        if name.startswith("gone"):
            raise FileNotFoundError(errno.ENOENT, "No such file", str(path))
        if name.startswith("full"):
            raise OSError(errno.ENOSPC, "No space left on device")
        return _jpeg(), False

    monkeypatch.setattr(thumbnails, "get_detection_preview", fake_preview)
    return app


def _state(pid):
    r = index.get_db().execute(
        "SELECT faces_scanned_at, faces_scan_error FROM photos WHERE id=?", (pid,)).fetchone()
    return r["faces_scanned_at"], r["faces_scan_error"]


# ── Classification ──

@pytest.mark.parametrize("exc, per_file", [
    (ValueError("bad marker"), True),
    (OSError("cannot identify image file"), True),
    (RuntimeError("Cannot decode HEIC"), True),
    (MemoryError(), False),
    (ImportError("pillow_heif"), False),
    (OSError(errno.ENOSPC, "No space left on device"), False),
])
def test_classification(tmp_path, exc, per_file):
    assert scan_failures.is_file_error(exc, tmp_path / "a.jpg") is per_file


def test_oserror_on_another_file_is_systemic(tmp_path):
    photo = tmp_path / "a.jpg"
    cache_err = PermissionError(errno.EACCES, "denied", str(tmp_path / "cache" / "x.webp"))
    own_err = PermissionError(errno.EACCES, "denied", str(photo))
    assert not scan_failures.is_file_error(cache_err, photo)
    assert scan_failures.is_file_error(own_err, photo)


def test_missing_folder_is_systemic(tmp_path):
    # A vanished file in a present folder is that file's problem; a vanished folder
    # (unmounted drive) takes everything in it down and must not be written off.
    assert scan_failures.is_file_error(FileNotFoundError("x"), tmp_path / "a.jpg")
    assert not scan_failures.is_file_error(FileNotFoundError("x"), tmp_path / "nope" / "a.jpg")


# ── Faces ──

def test_model_load_failure_aborts_and_marks_nothing(fake_faces, tmp_path, monkeypatch):
    ids = [_add(tmp_path, f"p{i}.jpg") for i in range(3)]

    def boom():
        raise RuntimeError("INVALID_PROTOBUF: Load model failed")
    monkeypatch.setattr(faces, "_get_app", boom)
    with pytest.raises(BatchAborted) as ei:
        faces_service.scan_faces_batch(ids)
    assert ei.value.code == "model"
    assert all(_state(pid) == (None, None) for pid in ids)
    assert index.get_unscanned_photo_ids() == ids


def test_inference_failure_aborts_keeping_earlier_successes(fake_faces, tmp_path):
    ok, broken, later = _add(tmp_path, "face_a.jpg"), _add(tmp_path, "broken.jpg"), _add(tmp_path, "c.jpg")
    calls = {"n": 0}
    real_get = fake_faces.get

    def flaky(arr):
        calls["n"] += 1
        if calls["n"] == 2:
            raise RuntimeError("onnxruntime: session crashed")
        return real_get(arr)
    fake_faces.get = flaky
    with pytest.raises(BatchAborted):
        faces_service.scan_faces_batch([ok, broken, later])
    assert _state(ok)[0] is not None
    # The unreadable file before the crash is dropped with the batch, and the photo
    # the model failed on is untouched.
    assert _state(broken) == (None, None) and _state(later) == (None, None)


def test_unreadable_file_is_tombstoned_distinguishably(fake_faces, tmp_path):
    good, empty, broken = (_add(tmp_path, "face_1.jpg"), _add(tmp_path, "plain.jpg"),
                           _add(tmp_path, "broken.jpg"))
    r = faces_service.scan_faces_batch([good, empty, broken])
    assert r["processed"] == 3 and r["faces_found"] == 1
    assert len(r["errors"]) == 1 and "broken.jpg" in r["errors"][0]
    # Scanned-with-no-faces has a timestamp; failed has an error and no timestamp.
    assert _state(empty)[0] is not None and _state(empty)[1] is None
    scanned_at, err = _state(broken)
    assert scanned_at is None and "cannot identify" in err
    assert index.get_unscanned_photo_ids() == []
    assert index.count_face_scan_failures() == 1


def test_disk_full_aborts(fake_faces, tmp_path):
    pid = _add(tmp_path, "full.jpg")
    with pytest.raises(BatchAborted):
        faces_service.scan_faces_batch([pid])
    assert _state(pid) == (None, None)


def test_retry_clears_only_failed_rows(fake_faces, tmp_path):
    empty, broken = _add(tmp_path, "plain.jpg"), _add(tmp_path, "broken.jpg")
    faces_service.scan_faces_batch([empty, broken])
    scanned_before = _state(empty)[0]
    assert index.clear_face_scan_failures() == 1
    assert index.get_unscanned_photo_ids() == [broken]
    assert _state(empty) == (scanned_before, None)


def test_consecutive_failure_guard(fake_faces, tmp_path, monkeypatch):
    monkeypatch.setattr(config, "SCAN_FAILURE_STREAK_LIMIT", 3)
    first = _add(tmp_path, "plain.jpg")
    run = [_add(tmp_path, f"broken{i}.jpg") for i in range(3)]
    with pytest.raises(BatchAborted) as ei:
        faces_service.scan_faces_batch([first, *run])
    assert ei.value.code == "too_many_failures" and len(ei.value.errors) == 3
    assert _state(first)[0] is not None            # the success before the run stays
    assert all(_state(pid) == (None, None) for pid in run)
    # The user confirms the files really are bad: the override marks them.
    faces_service.scan_faces_batch(run, allow_failures=True)
    assert all(_state(pid)[1] for pid in run)


def test_guard_resets_on_success(fake_faces, tmp_path, monkeypatch):
    monkeypatch.setattr(config, "SCAN_FAILURE_STREAK_LIMIT", 3)
    ids = [_add(tmp_path, n) for n in
           ("broken1.jpg", "broken2.jpg", "plain.jpg", "broken3.jpg", "broken4.jpg")]
    r = faces_service.scan_faces_batch(ids)
    assert r["processed"] == 5 and index.count_face_scan_failures() == 4


def test_manual_tags_survive_failure_and_retry(fake_faces, tmp_path):
    pid = _add(tmp_path, "broken.jpg")
    person = index.get_or_create_person("Ann")
    manual = index.add_manual_face(pid, "0.1,0.1,0.3,0.3", person)
    faces_service.scan_faces_batch([pid])
    assert _state(pid)[1] is not None
    assert index.get_face(manual)["person_id"] == person

    # The file is fixed; retry re-detects. replace_faces touches only detected faces.
    with index.transaction() as db:
        db.execute("UPDATE photos SET filename='face_fixed.jpg' WHERE id=?", (pid,))
    index.clear_face_scan_failures()
    r = faces_service.scan_faces_batch(index.get_unscanned_photo_ids())
    assert r["faces_found"] == 1
    assert _state(pid)[0] is not None and _state(pid)[1] is None
    assert index.get_face(manual)["person_id"] == person
    n = index.get_db().execute("SELECT COUNT(*) FROM faces WHERE photo_id=?", (pid,)).fetchone()[0]
    assert n == 2


def test_rescan_checks_model_before_wiping(fake_faces, tmp_path, monkeypatch):
    pid = _add(tmp_path, "face_1.jpg")
    faces_service.scan_faces_batch([pid])
    monkeypatch.setattr(faces, "_get_app", lambda: (_ for _ in ()).throw(RuntimeError("no model")))
    with pytest.raises(BatchAborted):
        faces_service.rescan_photo_faces([pid])
    n = index.get_db().execute("SELECT COUNT(*) FROM faces WHERE photo_id=?", (pid,)).fetchone()[0]
    assert n == 1


def test_file_unreadable_message_names_type(tmp_path):
    with pytest.raises(FileUnreadable, match="ValueError: bad"):
        try:
            raise ValueError("bad")
        except ValueError as e:
            scan_failures.raise_classified(e, tmp_path / "a.jpg")


# ── Semantic ──

def _sem_add(name):
    return _add(Path("."), name)


def _vec_rows():
    return {r["photo_id"]: r["vec"] for r in index.get_db().execute(
        "SELECT photo_id, vec FROM photo_embeddings").fetchall()}


def test_semantic_model_load_failure_stores_nothing(db, fake_semantic, monkeypatch):
    ids = [_sem_add("red_1.jpg"), _sem_add("blue_1.jpg")]

    def boom():
        raise RuntimeError("Load model failed")
    monkeypatch.setattr(fake_semantic, "load_visual", boom)
    with pytest.raises(BatchAborted) as ei:
        semantic_service.scan(limit=10)
    assert ei.value.code == "model"
    assert _vec_rows() == {}
    assert index.get_unembedded_photo_ids(config.SEMANTIC_MODEL_NAME) == ids


def test_semantic_inference_failure_aborts(db, fake_semantic, monkeypatch):
    _sem_add("red_1.jpg")
    monkeypatch.setattr(fake_semantic, "encode_image",
                        lambda img: (_ for _ in ()).throw(RuntimeError("ORT failure")))
    with pytest.raises(BatchAborted):
        semantic_service.scan(limit=10)
    assert _vec_rows() == {}


def test_semantic_retry_clears_only_failed(db, fake_semantic):
    red, broken = _sem_add("red_1.jpg"), _sem_add("broken.jpg")
    r = semantic_service.scan(limit=10)
    assert r["failed"] == 1 and r["remaining"] == 0
    rows = _vec_rows()
    assert rows[red] is not None and rows[broken] is None
    assert semantic_service.retry_failed() == {"requeued": 1}
    assert index.get_unembedded_photo_ids(config.SEMANTIC_MODEL_NAME) == [broken]
    assert _vec_rows()[red] is not None


def test_semantic_guard(db, fake_semantic, monkeypatch):
    monkeypatch.setattr(config, "SCAN_FAILURE_STREAK_LIMIT", 2)
    red = _sem_add("red_1.jpg")
    _sem_add("broken1.jpg"), _sem_add("broken2.jpg")
    with pytest.raises(BatchAborted) as ei:
        semantic_service.scan(limit=10)
    assert ei.value.code == "too_many_failures"
    assert list(_vec_rows()) == [red]
    r = semantic_service.scan(limit=10, allow_failures=True)
    assert r["remaining"] == 0 and r["failed"] == 2


# ── Routes ──

def test_faces_scan_route_503_and_retry(client, tmp_path, monkeypatch):
    pid = _add(tmp_path, "p.jpg")
    monkeypatch.setattr(faces, "_get_app",
                        lambda: (_ for _ in ()).throw(RuntimeError("model file corrupt")))
    r = client.post("/api/faces/scan", json={"limit": 10})
    assert r.status_code == 503
    detail = r.json()["detail"]
    assert detail["code"] == "model" and "model file corrupt" in detail["message"]
    assert _state(pid) == (None, None)

    index.mark_face_scan_failures([(pid, "OSError: bad")])
    st = client.get("/api/faces/scan/status").json()
    assert st["failed_photos"] == 1 and st["remaining_photos"] == 0
    assert client.get("/api/stats/summary").json()["faces"]["failed_photos"] == 1
    assert client.post("/api/faces/scan/retry-failed").json() == {"requeued": 1}
    assert client.get("/api/faces/scan/status").json()["remaining_photos"] == 1


def test_semantic_retry_route(client):
    pid = _sem_add("x.jpg")
    index.store_embeddings([(pid, None)], config.SEMANTIC_MODEL_NAME)
    assert client.post("/api/semantic/retry-failed").json() == {"requeued": 1}
