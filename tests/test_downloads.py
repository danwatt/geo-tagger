"""Atomic, verified downloads (geotagger/downloads.py) and the dataset/model
downloaders built on it — audit G1. No network: urllib's urlopen is replaced by a
fake that serves canned bodies per URL, including short bodies (a body shorter
than its Content-Length, i.e. a transfer cut off mid-way).

The property under test throughout: the final filename only ever holds a
complete, verified file — a failure at any step leaves nothing under it and no
stray temp file beside it.
"""

import hashlib
import io
import os
import sys
import threading
import zipfile
from pathlib import Path

import osmium
import pytest

from geotagger import config, downloads, faces, osm_compact, semantic
from geotagger.services import data_service

PBF_URL = "https://download.geofabrik.de/north-america/us/texas-latest.osm.pbf"


class _Resp:
    def __init__(self, body: bytes, length: int | None):
        self._buf = io.BytesIO(body)
        self.headers = {} if length is None else {"Content-Length": str(length)}

    def read(self, n: int = -1) -> bytes:
        return self._buf.read(n)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _Routes(dict):
    calls: list[str]


@pytest.fixture
def http(monkeypatch):
    """routes[url] = body, or (body, content_length) to fake a short transfer.
    Unrouted URLs raise HTTPError 404; every requested URL is recorded."""
    from urllib.error import HTTPError

    routes = _Routes()  # url -> bytes | (bytes, content_length)
    calls: list[str] = []

    def fake_urlopen(req, timeout=None):
        url = req.full_url
        calls.append(url)
        if url not in routes:
            raise HTTPError(url, 404, "Not Found", {}, None)
        spec = routes[url]
        body, length = spec if isinstance(spec, tuple) else (spec, len(spec))
        return _Resp(body, length)

    monkeypatch.setattr(downloads, "urlopen", fake_urlopen)
    routes.calls = calls
    return routes


def _siblings(path: Path) -> list[str]:
    return sorted(p.name for p in path.parent.iterdir()) if path.parent.exists() else []


def _zip_bytes(files: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in files.items():
            zf.writestr(name, data)
    return buf.getvalue()


# ── download_to ──

def test_success_lands_under_final_name_only(http, tmp_path):
    http["https://x/a.bin"] = b"hello world"
    dest = tmp_path / "a.bin"
    seen: list[tuple[int, int | None]] = []
    got = downloads.download_to("https://x/a.bin", dest, progress=lambda d, t: seen.append((d, t)),
                                expected_md5=hashlib.md5(b"hello world").hexdigest())
    assert dest.read_bytes() == b"hello world"
    assert got["bytes"] == 11
    assert seen[-1] == (11, 11)
    assert _siblings(dest) == ["a.bin"]


def test_truncated_body_leaves_no_final_file_and_no_part(http, tmp_path):
    http["https://x/a.bin"] = (b"only half", 1000)
    dest = tmp_path / "a.bin"
    with pytest.raises(downloads.DownloadError, match="Incomplete"):
        downloads.download_to("https://x/a.bin", dest)
    assert _siblings(dest) == []


def test_md5_mismatch_is_rejected(http, tmp_path):
    http["https://x/a.bin"] = b"tampered"
    dest = tmp_path / "a.bin"
    with pytest.raises(downloads.DownloadError, match="Checksum mismatch"):
        downloads.download_to("https://x/a.bin", dest, expected_md5="0" * 32)
    assert _siblings(dest) == []


def test_failed_redownload_keeps_the_previous_good_file(http, tmp_path):
    dest = tmp_path / "a.bin"
    dest.write_bytes(b"old but complete")
    http["https://x/a.bin"] = (b"new", 50)
    with pytest.raises(downloads.DownloadError):
        downloads.download_to("https://x/a.bin", dest)
    assert dest.read_bytes() == b"old but complete"
    assert _siblings(dest) == ["a.bin"]


def test_http_error_creates_no_temp_file(http, tmp_path):
    from urllib.error import HTTPError
    dest = tmp_path / "a.bin"
    with pytest.raises(HTTPError):
        downloads.download_to("https://x/missing", dest)
    assert _siblings(dest) == []


def test_transform_failure_leaves_nothing(http, tmp_path):
    http["https://x/a.bin"] = b"data"
    dest = tmp_path / "a.bin"

    def boom(part: Path):
        assert part.read_bytes() == b"data"  # transform sees the verified download
        raise RuntimeError("transform failed")

    with pytest.raises(RuntimeError, match="transform failed"):
        downloads.download_to("https://x/a.bin", dest, transform=boom)
    assert _siblings(dest) == []


def test_corrupt_zip_is_rejected(http, tmp_path):
    good = _zip_bytes({"a.txt": b"x" * 5000})
    # Flip a byte in the compressed payload: right length, wrong CRC.
    bad = bytearray(good)
    bad[40] ^= 0xFF
    http["https://x/a.zip"] = bytes(bad)
    dest = tmp_path / "a.zip"
    with pytest.raises(downloads.DownloadError):
        downloads.download_to("https://x/a.zip", dest, transform=downloads.check_zip)
    assert _siblings(dest) == []


def test_extract_zip_txt_lands_the_member(http, tmp_path):
    http["https://x/cities500.zip"] = _zip_bytes({"readme.txt": b"read me", "cities500.txt": b"row\n"})
    dest = tmp_path / "cities500.txt"
    downloads.download_to("https://x/cities500.zip", dest, transform=downloads.extract_zip_txt)
    assert dest.read_bytes() == b"row\n"
    assert _siblings(dest) == ["cities500.txt"]


# ── OSM extracts: download -> verify md5 -> compact -> rename ──

def _write_pbf(path: Path) -> None:
    """A tiny extract with one keepable object (a named park) and one that
    compaction drops (an unnamed building)."""
    header = osmium.io.Header()
    header.add_box(osmium.osm.Box(-96.5, 29.5, -95.5, 30.5))
    writer = osmium.SimpleWriter(str(path), header=header)
    coords = {1: (30.0, -96.0), 2: (30.0, -95.999), 3: (30.001, -95.999), 4: (30.001, -96.0),
              11: (30.01, -96.0), 12: (30.01, -95.999), 13: (30.011, -95.999)}
    for nid, (lat, lng) in coords.items():
        writer.add_node(osmium.osm.mutable.Node(id=nid, location=(lng, lat), version=1))
    writer.add_way(osmium.osm.mutable.Way(id=100, nodes=[1, 2, 3, 4, 1],
                                          tags={"leisure": "park", "name": "Test Park"}))
    writer.add_way(osmium.osm.mutable.Way(id=101, nodes=[11, 12, 13, 11], tags={"building": "yes"}))
    writer.close()


@pytest.fixture
def raw_pbf(tmp_path) -> bytes:
    src = tmp_path / "src" / "raw.osm.pbf"
    src.parent.mkdir()
    _write_pbf(src)
    return src.read_bytes()


@pytest.fixture
def osm_env(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "OSM_DB_PATH", tmp_path / "osm" / "places.sqlite")
    monkeypatch.setattr(config, "OSM_COMPACT_PBF", True)
    cache = config.get_pbf_cache_dir()
    cache.mkdir(parents=True)
    return cache / "us_texas-latest.osm.pbf"


def _serve_pbf(http, body: bytes, md5: str | None = None, length: int | None = None):
    http[PBF_URL] = (body, len(body) if length is None else length)
    http[PBF_URL + ".md5"] = f"{md5 or hashlib.md5(body).hexdigest()}  texas-latest.osm.pbf\n".encode()


def _no_stray_files(dest: Path):
    stray = [p for p in dest.parent.rglob("*") if p.is_file() and p != dest]
    assert stray == []


def test_pbf_download_compacts_the_temp_file_then_renames(http, osm_env, raw_pbf, monkeypatch):
    _serve_pbf(http, raw_pbf)
    dest = osm_env
    compacted: list[Path] = []
    real_compact = osm_compact.compact

    def spy(path, progress_cb=None):
        compacted.append(path)
        assert not dest.exists()  # final name stays empty until compaction is done
        assert path.read_bytes() == raw_pbf  # compaction runs on the verified raw bytes
        return real_compact(path, progress_cb=progress_cb)

    monkeypatch.setattr(osm_compact, "compact", spy)
    data_service._download_pbf(PBF_URL, dest, "Texas", lambda _m: None)

    assert len(compacted) == 1 and compacted[0] != dest
    assert osm_compact.is_compacted(dest)
    assert dest.read_bytes() != raw_pbf  # the compacted output, not the raw download
    ways = {w.id for w in osmium.FileProcessor(str(dest), osmium.osm.WAY)}
    assert ways == {100}
    _no_stray_files(dest)


def test_pbf_md5_mismatch_leaves_no_final_file(http, osm_env, raw_pbf):
    _serve_pbf(http, raw_pbf, md5="f" * 32)
    with pytest.raises(downloads.DownloadError, match="Checksum mismatch"):
        data_service._download_pbf(PBF_URL, osm_env, "Texas", lambda _m: None)
    assert not osm_env.exists()
    _no_stray_files(osm_env)


def test_pbf_truncated_download_leaves_no_final_file(http, osm_env, raw_pbf):
    _serve_pbf(http, raw_pbf[: len(raw_pbf) // 2], length=len(raw_pbf))
    with pytest.raises(downloads.DownloadError, match="Incomplete"):
        data_service._download_pbf(PBF_URL, osm_env, "Texas", lambda _m: None)
    assert not osm_env.exists()
    _no_stray_files(osm_env)


def test_pbf_compaction_failure_leaves_no_final_file(http, osm_env, raw_pbf, monkeypatch):
    _serve_pbf(http, raw_pbf)

    def boom(*_a, **_k):
        raise RuntimeError("compaction blew up")

    monkeypatch.setattr(osm_compact, "compact", boom)
    with pytest.raises(RuntimeError, match="compaction blew up"):
        data_service._download_pbf(PBF_URL, osm_env, "Texas", lambda _m: None)
    assert not osm_env.exists()
    _no_stray_files(osm_env)


def test_pbf_download_without_compaction_keeps_raw_bytes(http, osm_env, raw_pbf, monkeypatch):
    monkeypatch.setattr(config, "OSM_COMPACT_PBF", False)
    _serve_pbf(http, raw_pbf)
    data_service._download_pbf(PBF_URL, osm_env, "Texas", lambda _m: None)
    assert osm_env.read_bytes() == raw_pbf


def _run_osm_job(monkeypatch):
    monkeypatch.setattr(data_service.index, "record_dataset_download", lambda **_k: None)
    data_service._osm_job.update(running=True, done=False, error=None, message="", result=None)
    data_service._run_osm_download_and_merge(["us_texas"])
    return data_service.osm_job_status()


def test_is_complete_pbf_spots_truncation(tmp_path, raw_pbf):
    p = tmp_path / "x.osm.pbf"
    p.write_bytes(raw_pbf)
    assert osm_compact.is_complete_pbf(p)
    osm_compact.compact(p)
    assert osm_compact.is_complete_pbf(p)
    whole = p.read_bytes()
    for cut in (0, 3, 10, len(whole) // 2, len(whole) - 1):
        p.write_bytes(whole[:cut])
        assert not osm_compact.is_complete_pbf(p), cut
    p.write_bytes(whole + b"\x00")
    assert not osm_compact.is_complete_pbf(p)


def test_cached_final_file_skips_download(http, osm_env, raw_pbf, monkeypatch):
    osm_env.write_bytes(raw_pbf)
    osm_compact.compact(osm_env)
    before = osm_env.read_bytes()
    job = _run_osm_job(monkeypatch)
    assert job["error"] is None and job["done"] is True
    assert http.calls == []  # no md5 fetch, no download
    assert osm_env.read_bytes() == before


def test_legacy_truncated_cached_pbf_is_downloaded_again(http, osm_env, raw_pbf, monkeypatch):
    # What the pre-atomic downloader left behind after a timeout.
    osm_env.write_bytes(raw_pbf[: len(raw_pbf) // 2])
    _serve_pbf(http, raw_pbf)
    job = _run_osm_job(monkeypatch)
    assert job["error"] is None and job["done"] is True
    assert PBF_URL in http.calls
    assert osm_compact.is_compacted(osm_env)


# ── Census archives ──

def test_census_zip_falls_back_on_404_but_not_on_truncation(http, tmp_path, monkeypatch):
    from geotagger import census_builder
    monkeypatch.setattr(config, "CENSUS_CB_YEAR", 2024)
    (_y1, newest), (_y2, older), *_ = census_builder.cb_urls()
    body = _zip_bytes({"cb.shp": b"x" * 100})
    http[older] = body
    dest = tmp_path / "cb-place-500k.zip"
    year, url = census_builder.download_cb_zip(dest)
    assert url == older and dest.read_bytes() == body

    dest.unlink()
    http[newest] = (body[:10], len(body))
    with pytest.raises(downloads.DownloadError):
        census_builder.download_cb_zip(dest)
    assert _siblings(dest) == []


# ── Semantic model files ──

def test_semantic_truncated_model_file_is_not_installed(http, tmp_path, monkeypatch):
    semantic.init_semantic(tmp_path)
    base = config.SEMANTIC_MODEL_URL.format(name=config.SEMANTIC_MODEL_NAME)
    for rel in semantic.MODEL_FILES:
        http[base + rel] = b"{}"
    http[base + "textual/model.onnx"] = (b"onnx", 4096)
    with pytest.raises(downloads.DownloadError):
        semantic.download_model()
    d = semantic._model_dir()
    assert not (d / "textual" / "model.onnx").exists()
    assert not list(d.rglob("*.part"))
    assert semantic.model_status()["available"] is False

    http[base + "textual/model.onnx"] = b"onnx"
    progress: list[int] = []
    semantic.download_model(progress_cb=lambda done, _name: progress.append(done))
    assert semantic.model_status()["available"] is True
    assert progress[-1] == semantic.model_status()["size_bytes"]


# ── InsightFace model pack ──

def test_face_pack_installs_atomically_over_a_leftover_empty_dir(http, tmp_path, monkeypatch):
    from insightface.utils.storage import BASE_REPO_URL
    monkeypatch.setattr(faces, "_model_dir", tmp_path / "insightface")
    model_path = tmp_path / "insightface" / "models" / config.FACE_MODEL_NAME
    model_path.mkdir(parents=True)  # InsightFace's own downloader left this empty
    url = f"{BASE_REPO_URL}/{config.FACE_MODEL_NAME}.zip"
    body = _zip_bytes({"det_10g.onnx": b"d", "w600k_r50.onnx": b"r"})

    http[url] = (body[:20], len(body))
    with pytest.raises(downloads.DownloadError):
        faces._ensure_model_pack()
    assert not any(model_path.glob("*.onnx"))

    http[url] = body
    faces._ensure_model_pack()
    assert sorted(p.name for p in model_path.iterdir()) == ["det_10g.onnx", "w600k_r50.onnx"]
    assert sorted(p.name for p in model_path.parent.iterdir()) == [config.FACE_MODEL_NAME]
    assert faces.model_status()["available"] is True


# ── replace_retrying: a reader briefly holding the target open ──

@pytest.mark.skipif(sys.platform != "win32", reason="POSIX replaces open files freely")
def test_replace_retrying_waits_out_a_short_lived_reader(tmp_path):
    # The GeoNames swap can land while a lazy parse is still reading the old file;
    # Windows refuses os.replace until that handle closes.
    dest, src = tmp_path / "cities500.txt", tmp_path / "staged"
    dest.write_text("old", encoding="utf-8")
    src.write_text("new", encoding="utf-8")
    fh = dest.open(encoding="utf-8")
    with pytest.raises(PermissionError):
        os.replace(src, dest)                      # the failure being guarded against
    timer = threading.Timer(0.2, fh.close)
    timer.start()
    try:
        downloads.replace_retrying(src, dest)
    finally:
        timer.join()
    assert dest.read_text(encoding="utf-8") == "new"


@pytest.mark.skipif(sys.platform != "win32", reason="POSIX replaces open files freely")
def test_replace_retrying_gives_up_on_a_file_held_for_good(tmp_path):
    dest, src = tmp_path / "held.txt", tmp_path / "staged"
    dest.write_text("old", encoding="utf-8")
    src.write_text("new", encoding="utf-8")
    with dest.open(encoding="utf-8"):
        with pytest.raises(PermissionError):
            downloads.replace_retrying(src, dest, attempts=3, delay=0.01)
    assert src.exists()                             # nothing lost; caller can retry
