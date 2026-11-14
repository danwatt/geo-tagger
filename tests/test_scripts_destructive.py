"""Audit T8: scripts that reset library state library-wide must refuse to run
without --yes, change nothing under --dry-run, and do the reset with --yes.

The scripts live outside the package, so they're loaded by path and their
main(argv) is called in-process against an isolated temp DB (GEOTAGGER_CACHE_DIR
points at it, which is how resolve_root picks the DB when --cache-dir is absent).
"""
import importlib.util
import time
from pathlib import Path

import pytest

from geotagger import index

SCRIPTS = Path(__file__).parent.parent / "scripts"


def _load(name: str):
    spec = importlib.util.spec_from_file_location(f"_script_{name}", SCRIPTS / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def lib(tmp_path, monkeypatch):
    """A temp library DB with three images: two scanned and hashed (one carrying a
    tagged face), one with no faces. Yields a query helper."""
    cache = tmp_path / "cache"
    monkeypatch.setenv("GEOTAGGER_CACHE_DIR", str(cache))
    db = index.init_db()
    for name, ext in (("a.jpg", ".jpg"), ("b.jpg", ".jpg"), ("c.nef", ".nef")):
        index.upsert_photo(
            filename=name, dir_=str(tmp_path), ext=ext, media_type="image", mtime=0.0,
            size=0, lat=None, lng=None, geotag_source="none", sidecar_path=None,
            sidecar_mtime=None, checksum=f"sum-{name}",
        )
    now = time.time()
    with index.transaction() as tx:
        tx.execute("UPDATE photos SET faces_scanned_at=?", (now,))
        tx.execute("INSERT INTO persons (id, name, created_at) VALUES (1, 'Ann', ?)", (now,))
        a, c = (tx.execute("SELECT id FROM photos WHERE filename=?", (n,)).fetchone()[0]
                for n in ("a.jpg", "c.nef"))
        for pid in (a, c):
            tx.execute(
                "INSERT INTO faces (photo_id, person_id, bbox, det_score, created_at) "
                "VALUES (?, 1, '[0,0,10,10]', 0.9, ?)", (pid, now))

    def q(sql: str):
        return index.get_db().execute(sql).fetchone()[0]

    yield q
    if index._db is not None:
        index._db.close()
    index._db = None
    index._db_path = None
    db.close()


# ── backfill_checksums --rescan ──

@pytest.fixture
def backfill(monkeypatch):
    mod = _load("backfill_checksums")
    monkeypatch.setattr(mod.scanner, "file_checksum", lambda path: "rehashed")
    return mod


def test_backfill_rescan_without_yes_refuses(lib, backfill, capsys):
    assert backfill.main(["--rescan"]) == 2
    assert "--yes" in capsys.readouterr().err
    assert lib("SELECT COUNT(*) FROM photos WHERE checksum LIKE 'sum-%'") == 3


def test_backfill_rescan_dry_run_changes_nothing(lib, backfill, capsys):
    assert backfill.main(["--rescan", "--dry-run"]) == 0
    assert "clear 3 stored checksum" in capsys.readouterr().out
    assert lib("SELECT COUNT(*) FROM photos WHERE checksum LIKE 'sum-%'") == 3


def test_backfill_rescan_yes_rehashes_everything(lib, backfill):
    assert backfill.main(["--rescan", "--yes"]) == 0
    assert lib("SELECT COUNT(*) FROM photos WHERE checksum='rehashed'") == 3


def test_backfill_plain_run_needs_no_confirmation(lib, backfill):
    assert backfill.main([]) == 0  # nothing missing: no reset, no refusal
    assert lib("SELECT COUNT(*) FROM photos WHERE checksum LIKE 'sum-%'") == 3


# ── scan_faces --rescan / --rescan-empty ──

@pytest.fixture
def scan(monkeypatch):
    mod = _load("scan_faces")
    # No model, no ExifTool: detection "finds" nothing and doesn't mark the photo
    # scanned, so the reset stays observable after the run.
    monkeypatch.setattr(mod, "start_et", lambda: None)
    monkeypatch.setattr(mod, "stop_et", lambda: None)
    monkeypatch.setattr(mod.faces, "load_model", lambda: None)
    monkeypatch.setattr(mod.faces, "detect_and_store", lambda row: 0)
    return mod


UNSCANNED = "SELECT COUNT(*) FROM photos WHERE faces_scanned_at IS NULL"


@pytest.mark.parametrize("flag", ["--rescan", "--rescan-empty"])
def test_scan_reset_without_yes_refuses(lib, scan, flag, capsys):
    assert scan.main([flag]) == 2
    assert "--yes" in capsys.readouterr().err
    assert lib(UNSCANNED) == 0


@pytest.mark.parametrize("flag,expected", [("--rescan", 3), ("--rescan-empty", 1)])
def test_scan_reset_dry_run_changes_nothing(lib, scan, flag, expected, capsys):
    assert scan.main([flag, "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert f"re-queue {expected} already-scanned" in out
    if flag == "--rescan":
        assert "discarding 2 person tag(s)" in out
    assert lib(UNSCANNED) == 0


@pytest.mark.parametrize("flag,expected", [("--rescan", 3), ("--rescan-empty", 1)])
def test_scan_reset_yes_requeues(lib, scan, flag, expected):
    assert scan.main([flag, "--yes"]) == 0
    assert lib(UNSCANNED) == expected


def test_scan_rescan_flags_are_exclusive(lib, scan):
    with pytest.raises(SystemExit):
        scan.main(["--rescan", "--rescan-empty", "--yes"])


# ── rescan_raw_faces --include-labeled ──

@pytest.fixture
def raw_rescan(monkeypatch):
    mod = _load("rescan_raw_faces")
    calls: list[int] = []
    monkeypatch.setattr(mod, "rescan_detect",
                        lambda todo, dry_run: calls.append(len(todo)) if not dry_run else None)
    mod.calls = calls
    return mod


def test_raw_include_labeled_without_yes_refuses(lib, raw_rescan, capsys):
    assert raw_rescan.main(["--include-labeled"]) == 2
    assert "discard 1 person tag(s)" in capsys.readouterr().err
    assert raw_rescan.calls == []


def test_raw_include_labeled_dry_run_and_yes(lib, raw_rescan):
    assert raw_rescan.main(["--include-labeled", "--dry-run"]) == 0
    assert raw_rescan.calls == []
    assert raw_rescan.main(["--include-labeled", "--yes"]) == 0
    assert raw_rescan.calls == [1]


def test_raw_default_mode_skips_labeled_without_confirmation(lib, raw_rescan):
    # The labeled RAW is skipped, so there's nothing to discard and no gate.
    assert raw_rescan.main([]) == 0
    assert raw_rescan.calls == [0]
