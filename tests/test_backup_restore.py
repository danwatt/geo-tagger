"""Backup format 2 + restore (audit D11).

The round trip builds a library, backs it up, then opens a brand-new DB where the
same files were "rescanned" under a different absolute root, in a different
order (so every photo and face id differs), with detected faces re-detected at
slightly jittered boxes — and checks restore brings every piece of user data
back, compared by identity (photo path/checksum, face photo+state), never by id.
"""
import calendar
import copy
from datetime import datetime
from pathlib import Path

import numpy as np
import pytest

from geotagger import config, index
from geotagger.services import backup_service

SIZE = 100
F1 = "0.10000,0.10000,0.30000,0.40000"   # Dan, representative
F2 = "0.40000,0.10000,0.55000,0.35000"   # ignored
F3 = "0.60000,0.10000,0.75000,0.35000"   # come-back
F4 = "0.10000,0.50000,0.25000,0.75000"   # unlabeled, NOT Ann (negative)
F6 = "0.60000,0.50000,0.75000,0.75000"   # unlabeled, nothing to back up
MANUAL = "0.80000,0.80000,0.95000,0.98000"  # hand-drawn, Bob
F7 = "0.20000,0.20000,0.50000,0.60000"   # Ann, on the moved photo
OLD_DT = calendar.timegm(datetime(1965, 1, 1).timetuple())  # pre-1970: negative epoch


def _jitter(bbox: str, d: float = 0.01) -> str:
    return ",".join(f"{float(v) + d:.5f}" for v in bbox.split(","))


def _emb(seed: int) -> bytes:
    v = np.random.default_rng(seed).standard_normal(512).astype(np.float32)
    return (v / np.linalg.norm(v)).tobytes()


# ── DB switching ──

@pytest.fixture
def dbs(tmp_path, monkeypatch):
    """open(name) -> a fresh index DB under tmp_path/name, closing the previous
    one; every test here juggles an 'old' and a 'new' library."""
    monkeypatch.delenv("GEOTAGGER_CACHE_DIR", raising=False)
    monkeypatch.delenv("GEOTAGGER_SCAN_DIRS", raising=False)
    # Restore applies settings live; put the module attribute back afterwards.
    monkeypatch.setattr(config, "WORKQUEUE_SESSION_GAP", config.WORKQUEUE_SESSION_GAP)

    def close():
        if index._db is not None:
            index._db.close()
        index._db = None
        index._db_path = None

    def open_(name: str):
        close()
        d = tmp_path / name
        d.mkdir(exist_ok=True)
        return index.init_db(d)

    yield open_
    close()
    from geotagger import faces
    faces._gallery_cache = None
    faces._unlabeled_cache = None
    faces._suggested_scores_cache = None


def _add_photo(root: str, rel: str, *, lat=None, lng=None, source="none", acc=None,
               checksum=None, dt=None) -> int:
    p = Path(root, *rel.split("/"))
    index.upsert_photo(p.name, str(p.parent), p.suffix[1:], "image", 1.0, SIZE, lat, lng,
                       source, None, None, photo_datetime=dt, gps_accuracy=acc,
                       checksum=checksum)
    return index.get_db().execute("SELECT id FROM photos WHERE dir=? AND filename=?",
                                  (str(p.parent), p.name)).fetchone()["id"]


def _face_ids(photo_id: int) -> dict[str, int]:
    return {r["bbox"]: r["id"] for r in index.get_db().execute(
        "SELECT id, bbox FROM faces WHERE photo_id=?", (photo_id,))}


def _setting():
    return "WORKQUEUE_SESSION_GAP", "1200"


def build_old_library(root: str) -> None:
    fam_w = index.create_family("Watts")
    index.create_family("Smiths")
    dan, ann, bob = (index.create_person(n) for n in ("Dan", "Ann", "Bob"))
    index.set_person_family(dan, fam_w)
    index.set_person_birth_date(dan, "1980-01-02")
    index.set_person_not_before(dan, "1985-01-01")
    index.set_person_not_after(ann, "2030-12-31")
    with index.transaction() as db:
        db.execute("UPDATE persons SET family_id=(SELECT id FROM families WHERE name='Smiths') "
                   "WHERE id=?", (bob,))
    index.set_setting(*_setting())

    p1 = _add_photo(root, "2020/a.jpg")  # DB-only geotag, no checksum (path-only match)
    index.update_geotag(p1, 10.5, 20.25, "database", None, None, gps_accuracy=5.0)
    _add_photo(root, "2020/b.jpg", lat=1.0, lng=2.0, source="embedded", acc=3.0, checksum="c2")
    p3 = _add_photo(root, "2021/Sub/c.jpg", lat=7.0, lng=8.0, source="embedded", checksum="c3")
    index.update_geotag(p3, None, None, "none", None, None)  # removed by the user
    p4 = _add_photo(root, "screens/s.png", checksum="c4")
    index.set_geocode_ignored([p4], True)
    p5 = _add_photo(root, "old/scan.jpg", checksum="c5")
    index.assign_approximate_date(p5, OLD_DT, "year", None, None)

    p6 = _add_photo(root, "faces/group.jpg", checksum="c6")
    index.replace_faces(p6, [{"bbox": b, "det_score": 0.9, "embedding": _emb(i)}
                             for i, b in enumerate((F1, F2, F3, F4, F6))])
    ids = _face_ids(p6)
    index.assign_face(ids[F1], dan)
    index.set_person_representatives(dan, [ids[F1]])
    index.set_faces_ignored([ids[F2]], True)
    index.set_faces_come_back([ids[F3]], True)
    index.add_face_negatives([ids[F4]], ann)
    index.add_manual_face(p6, MANUAL, person_id=bob, embedding=_emb(99))

    p7 = _add_photo(root, "moved/m.jpg", checksum="c7")
    index.replace_faces(p7, [{"bbox": F7, "det_score": 0.8, "embedding": _emb(7)}])
    index.assign_face(_face_ids(p7)[F7], ann)

    place = index.create_place("Home", "custom", "[[0,0],[1,1]]")
    index.set_place_representative(place, p1)


def rescan_new_library(root: str, *, moved_rel: str = "elsewhere/m.jpg",
                       skip: tuple = (), extra=None) -> None:
    """What a scan + face scan of the same files would produce under a new root:
    no DB-only state, different insertion order (different ids), jittered boxes.
    The sidecar of old/scan.jpg holds the approximate date (photo_datetime) but
    not its precision flag; c.jpg's embedded GPS comes back."""
    for i in range(3):
        _add_photo(root, f"filler/{i}.jpg")
    entries = [
        ("faces/group.jpg", {"checksum": "c6"}),
        (moved_rel, {"checksum": "c7"}),
        ("old/scan.jpg", {"checksum": "c5", "dt": OLD_DT}),
        ("screens/s.png", {"checksum": "c4"}),
        ("2021/Sub/c.jpg", {"lat": 7.0, "lng": 8.0, "source": "embedded", "checksum": "c3"}),
        ("2020/b.jpg", {"lat": 1.0, "lng": 2.0, "source": "embedded", "acc": 3.0, "checksum": "c2"}),
        ("2020/a.jpg", {}),
    ]
    ids = {}
    for rel, kw in entries:
        if rel not in skip:
            ids[rel] = _add_photo(root, rel, **kw)
    if "faces/group.jpg" in ids:
        index.replace_faces(ids["faces/group.jpg"], [
            {"bbox": _jitter(b), "det_score": 0.9, "embedding": _emb(i)}
            for i, b in enumerate((F6, F4, F3, F2, F1))])
    if moved_rel in ids:
        index.replace_faces(ids[moved_rel], [{"bbox": _jitter(F7, -0.01), "det_score": 0.8,
                                              "embedding": _emb(7)}])
    if extra:
        extra(ids)


# ── Logical dump (identity, never ids) ──

def dump(root: str) -> dict:
    db = index.get_db()
    rooter = backup_service._Rooter([root])

    def key(photo_id):
        r = db.execute("SELECT dir, filename, checksum FROM photos WHERE id=?", (photo_id,)).fetchone()
        if r is None:
            return None
        return r["checksum"] or rooter.identity(r["dir"], r["filename"])[1]

    fam = {r["id"]: r["name"] for r in db.execute("SELECT id, name FROM families")}
    persons = {r["id"]: r["name"] for r in db.execute("SELECT id, name FROM persons")}
    photos = {key(r["id"]): (r["lat"], r["lng"], r["geotag_source"], r["gps_accuracy"],
                             r["geotag_removed"], r["geocode_ignored"], r["photo_datetime"],
                             r["date_precision"])
              for r in db.execute("SELECT * FROM photos WHERE dir NOT LIKE '%filler%'")}
    faces = sorted((
        (key(r["photo_id"]), r["source"], persons.get(r["person_id"]), r["ignored"],
         r["come_back"], r["representative"], r["assigned_at"], r["ignored_at"],
         r["come_back_at"],
         r["bbox"] if r["source"] == "manual" else "",
         r["created_at"] if r["source"] == "manual" else 0,
         r["embedding"] if r["source"] == "manual" else b"")
        for r in db.execute(
            "SELECT f.*, e.embedding FROM faces f LEFT JOIN face_embeddings e ON e.face_id=f.id "
            "WHERE f.person_id IS NOT NULL OR f.ignored=1 OR f.come_back=1 OR f.source='manual' "
            "OR f.id IN (SELECT face_id FROM face_negatives)")), key=repr)
    negatives = sorted(
        (key(r["photo_id"]), persons[r["person_id"]], r["created_at"])
        for r in db.execute("SELECT f.photo_id, n.person_id, n.created_at FROM face_negatives n "
                            "JOIN faces f ON f.id=n.face_id"))
    return {
        "families": sorted((r["name"], r["created_at"]) for r in db.execute("SELECT * FROM families")),
        "persons": sorted(((r["name"], r["birth_date"], r["not_before"], r["not_after"],
                            fam.get(r["family_id"]), r["created_at"])
                           for r in db.execute("SELECT * FROM persons")), key=repr),
        "places": sorted((r["name"], r["type"], r["bounds"], r["created_at"],
                          key(r["representative_photo_id"]))
                         for r in db.execute("SELECT * FROM places")),
        "settings": index.get_all_settings(),
        "photos": photos,
        "faces": faces,
        "negatives": negatives,
        "n_faces": db.execute("SELECT COUNT(*) FROM faces").fetchone()[0],
    }


def _strip(report: dict) -> dict:
    r = dict(report)
    for k in ("dry_run", "note"):
        r.pop(k)
    return r


@pytest.fixture
def backed_up(dbs, tmp_path):
    """(backup, original dump, new root) with the new library already rescanned."""
    old_root, new_root = str(tmp_path / "old" / "Photos"), str(tmp_path / "moved" / "Photos")
    dbs("old_db")
    build_old_library(old_root)
    original = dump(old_root)
    backup = backup_service.build_backup(roots=[old_root])
    dbs("new_db")
    rescan_new_library(new_root)
    return backup, original, new_root


# ── a. true round trip ──

def test_round_trip_restores_every_user_value(backed_up):
    backup, original, new_root = backed_up
    assert dump(new_root) != original
    report = backup_service.restore_backup(backup, dry_run=False, roots=[new_root])
    restored = dump(new_root)
    for k in original:
        if k != "n_faces":
            assert restored[k] == original[k], k
    assert report["photos"]["matched_by_path"] == 6
    assert report["photos"]["matched_by_checksum"] == 1  # moved/m.jpg -> elsewhere/m.jpg
    assert report["photos"]["unmatched"] == 0
    assert report["faces"]["created"] == 1  # the manual box
    assert report["faces"]["unmatched"] == 0
    assert report["geotags"]["applied"] == 2  # a.jpg tag + c.jpg removal over embedded GPS
    assert report["dates"]["applied"] == 1
    assert report["representatives"]["applied"] == 1
    assert report["conflicts_sample"] == []
    # Restored geotag is DB-only (no sidecar was written) and its derived names are
    # cleared for the geocode backfill.
    row = index.get_db().execute(
        "SELECT geotag_source, sidecar_path, geocoded_at FROM photos WHERE filename='a.jpg'").fetchone()
    assert tuple(row) == ("database", None, None)
    assert config.WORKQUEUE_SESSION_GAP == 1200  # applied live


# ── b. dry run ──

def test_dry_run_changes_nothing_and_reports_the_real_counts(backed_up):
    backup, _original, new_root = backed_up
    before = dump(new_root)
    gen = (index.faces_generation(), index.geotag_generation())
    dry = backup_service.restore_backup(backup, roots=[new_root])  # dry_run defaults to True
    assert dry["dry_run"] is True
    assert dump(new_root) == before
    assert (index.faces_generation(), index.geotag_generation()) == gen
    assert config.WORKQUEUE_SESSION_GAP != 1200
    real = backup_service.restore_backup(backup, dry_run=False, roots=[new_root])
    assert _strip(dry) == _strip(real)


# ── c. idempotent ──

def test_second_restore_is_all_already_present(backed_up):
    backup, original, new_root = backed_up
    backup_service.restore_backup(backup, dry_run=False, roots=[new_root])
    once = dump(new_root)
    again = backup_service.restore_backup(backup, dry_run=False, roots=[new_root])
    assert dump(new_root) == once
    for cat in backup_service._CATEGORIES:
        assert again[cat]["applied"] == 0, cat
        assert again[cat]["conflict"] == 0, cat
    assert again["faces"]["already_present"] == 6  # F1-F4, F7, manual
    assert again["persons"]["already_present"] == 3


# ── d. conflicts ──

def test_conflicts_are_skipped_unless_overwrite(dbs, tmp_path):
    old_root, new_root = str(tmp_path / "old" / "Photos"), str(tmp_path / "new" / "Photos")
    dbs("old_db")
    build_old_library(old_root)
    original = dump(old_root)
    backup = backup_service.build_backup(roots=[old_root])
    dbs("new_db")

    def diverge(ids):
        index.update_geotag(ids["2020/a.jpg"], -5.0, -6.0, "database", None, None)
        bob = index.create_person("Bob")
        index.assign_face(_face_ids(ids["faces/group.jpg"])[_jitter(F1)], bob)
        index.set_setting("WORKQUEUE_SESSION_GAP", "3600")
        index.set_person_birth_date(index.create_person("Dan"), "1999-09-09")
    rescan_new_library(new_root, moved_rel="moved/m.jpg", extra=diverge)

    report = backup_service.restore_backup(backup, dry_run=False, roots=[new_root])
    for cat in ("geotags", "faces", "settings", "persons"):
        assert report[cat]["conflict"] == 1, cat
    assert report["representatives"]["conflict"] == 1  # F1's flag rides its skipped state
    after = dump(new_root)
    assert after["photos"]["2020/a.jpg"][:2] == (-5.0, -6.0)
    assert after["settings"]["WORKQUEUE_SESSION_GAP"] == "3600"
    assert ("c6", "detected", "Bob") in [f[:3] for f in after["faces"]]
    dan = next(p for p in after["persons"] if p[0] == "Dan")
    assert dan[1] == "1999-09-09" and dan[2] == "1985-01-01"  # conflict kept, unset filled
    assert {c["category"] for c in report["conflicts_sample"]} == {
        "geotags", "faces", "settings", "persons"}

    forced = backup_service.restore_backup(backup, dry_run=False, overwrite=True, roots=[new_root])
    assert forced["geotags"]["applied"] == 1 and forced["faces"]["applied"] == 1
    final = dump(new_root)
    for k in ("photos", "faces", "settings", "negatives"):
        assert final[k] == original[k], k
    # created_at isn't restored onto a person that already existed here.
    assert [p[:5] for p in final["persons"]] == [p[:5] for p in original["persons"]]


# ── e. unmatched / checksum fallback ──

def test_unmatched_photos_and_ambiguous_checksums_are_reported(dbs, tmp_path):
    old_root, new_root = str(tmp_path / "old" / "Photos"), str(tmp_path / "new" / "Photos")
    dbs("old_db")
    build_old_library(old_root)
    backup = backup_service.build_backup(roots=[old_root])
    dbs("new_db")

    def duplicate(ids):
        _add_photo(new_root, "copies/m-copy.jpg", checksum="c7")  # same bytes twice
    rescan_new_library(new_root, skip=("screens/s.png",), extra=duplicate)

    report = backup_service.restore_backup(backup, dry_run=False, roots=[new_root])
    photos = report["photos"]
    assert photos["unmatched"] == 2
    assert photos["ambiguous_checksum"] == 1
    assert photos["matched_by_checksum"] == 0
    assert sorted(photos["unmatched_sample"]) == ["Photos/moved/m.jpg", "Photos/screens/s.png"]
    assert report["geocode_ignored"]["unmatched"] == 1
    assert report["faces"]["unmatched"] == 1  # Ann's face on the ambiguous photo
    assert any("(photo unmatched)" in s for s in report["unmatched_faces_sample"])
    # Everything else still restored.
    assert report["geotags"]["applied"] == 2 and report["faces"]["applied"] == 4


def test_checksum_fallback_and_renamed_root(dbs, tmp_path):
    """One root on each side under different names maps by being the only one; a
    file moved within it is found by checksum."""
    old_root, new_root = str(tmp_path / "old" / "Photos"), str(tmp_path / "new" / "Pictures")
    dbs("old_db")
    build_old_library(old_root)
    backup = backup_service.build_backup(roots=[old_root])
    dbs("new_db")
    rescan_new_library(new_root)
    report = backup_service.restore_backup(backup, dry_run=False, roots=[new_root])
    assert report["photos"]["matched_by_path"] == 6
    assert report["photos"]["matched_by_checksum"] == 1
    assert report["photos"]["unmatched"] == 0


def test_unknown_roots_match_by_path_suffix(backed_up):
    """A restoring server that doesn't know its scan roots still finds
    '<root label>/<rel>' at the end of the stored absolute paths."""
    backup, original, _new_root = backed_up
    report = backup_service.restore_backup(backup, dry_run=True, roots=[])
    assert report["photos"]["matched_by_path"] == 6
    assert report["photos"]["matched_by_checksum"] == 1


# ── f. atomic ──

def test_failure_mid_restore_rolls_everything_back(backed_up, monkeypatch):
    backup, _original, new_root = backed_up
    before = dump(new_root)

    def boom(ctx):
        raise RuntimeError("disk on fire")
    monkeypatch.setattr(backup_service, "_restore_face_negatives", boom)
    with pytest.raises(RuntimeError, match="disk on fire"):
        backup_service.restore_backup(backup, dry_run=False, roots=[new_root])
    assert dump(new_root) == before
    assert not index.get_db().in_transaction


# ── g. old format ──

def test_format_1_backup_is_accepted_and_matches_by_absolute_path(dbs, tmp_path):
    root = str(tmp_path / "lib")
    dbs("new_db")
    pid = _add_photo(root, "2020/a.jpg")
    index.replace_faces(pid, [{"bbox": F1, "det_score": 0.9, "embedding": _emb(1)}])
    photo_dir = str(Path(root, "2020"))
    v1 = {  # exactly the shape the pre-D11 build_backup produced
        "version": 1, "exported_at": 0.0, "settings": {"WORKQUEUE_SESSION_GAP": "1800"},
        "families": [{"name": "Watts", "created_at": 1.0}],
        "persons": [{"name": "Dan", "birth_date": None, "not_before": None, "not_after": None,
                     "family": "Watts", "created_at": 2.0}],
        "places": [{"name": "Home", "type": "custom", "bounds": "[]", "created_at": 3.0,
                    "representative_photo": {"dir": photo_dir, "filename": "a.jpg"}}],
        "geotags": [{"dir": photo_dir, "filename": "a.jpg", "lat": 1.5, "lng": 2.5,
                     "geotag_source": "database"}],
        "faces": [{"photo_dir": photo_dir, "photo_filename": "a.jpg", "bbox": _jitter(F1),
                   "det_score": 0.9, "source": "detected", "ignored": False,
                   "come_back": False, "representative": False, "person": "Dan",
                   "created_at": 4.0, "assigned_at": 5.0, "ignored_at": None,
                   "come_back_at": None}],
        "face_negatives": [],
    }
    report = backup_service.restore_backup(v1, dry_run=False, roots=[])
    assert report["source_format"] == 1
    assert report["photos"]["matched_by_path"] == 1
    row = index.get_photo(pid)
    assert (row["lat"], row["lng"], row["geotag_source"]) == (1.5, 2.5, "database")
    face = index.get_db().execute("SELECT person_id, assigned_at FROM faces").fetchone()
    assert face["assigned_at"] == 5.0 and face["person_id"] is not None
    assert index.get_db().execute("SELECT representative_photo_id FROM places").fetchone()[0] == pid


@pytest.mark.parametrize("data, msg", [
    ({"format": 99}, "unsupported backup format 99"),
    ({"hello": "world"}, "not a geotagger backup"),
    ({"format": 2, "faces": [{"photo": 5, "bbox": F1}]}, "out of range"),
    ({"format": 2, "photos": "nope"}, "must be a list"),
])
def test_bad_backups_are_rejected_cleanly(dbs, data, msg):
    dbs("db")
    with pytest.raises(backup_service.BackupFormatError, match=msg):
        backup_service.restore_backup(data, dry_run=False, roots=[])


# ── h. format contents ──

def test_backup_carries_audit_fields_and_relative_paths(dbs, tmp_path):
    root = str(tmp_path / "old" / "Photos")
    dbs("db")
    build_old_library(root)
    b = backup_service.build_backup(roots=[root])
    assert b["format"] == 2
    assert b["roots"] == [{"label": "Photos", "path": Path(root).as_posix()}]
    by_rel = {p["rel"]: p for p in b["photos"]}
    assert all(p["root"] == "Photos" and p["abs"] is None for p in b["photos"])
    assert all(not Path(rel).is_absolute() and "\\" not in rel for rel in by_rel)
    assert by_rel["2020/b.jpg"]["gps_accuracy"] == 3.0
    assert by_rel["2020/a.jpg"]["gps_accuracy"] == 5.0
    assert by_rel["screens/s.png"]["geocode_ignored"] is True
    assert by_rel["2021/Sub/c.jpg"]["geotag_removed"] is True
    assert by_rel["old/scan.jpg"]["date_precision"] == "year"
    assert by_rel["old/scan.jpg"]["photo_datetime"] == OLD_DT
    assert by_rel["moved/m.jpg"]["checksum"] == "c7" and by_rel["moved/m.jpg"]["size"] == SIZE
    # Only faces with user state; only the manual one carries its embedding.
    assert len(b["faces"]) == 6
    assert [f["source"] for f in b["faces"] if f["embedding_b64"]] == ["manual"]
    assert b["face_negatives"] == [{"face": next(i for i, f in enumerate(b["faces"])
                                                 if f["bbox"] == F4),
                                    "person": "Ann", "created_at": b["face_negatives"][0]["created_at"]}]


def test_photo_outside_known_roots_keeps_absolute_path(dbs, tmp_path):
    dbs("db")
    elsewhere = str(tmp_path / "loose")
    pid = _add_photo(elsewhere, "x.jpg")
    index.set_geocode_ignored([pid], True)
    b = backup_service.build_backup(roots=[str(tmp_path / "Photos")])
    (p,) = b["photos"]
    assert p["root"] is None and p["rel"] is None
    assert p["abs"] == Path(elsewhere, "x.jpg").as_posix()
    # ...and still restores onto itself.
    with index.transaction() as db:
        db.execute("UPDATE photos SET geocode_ignored=0")
    r = backup_service.restore_backup(copy.deepcopy(b), dry_run=False, roots=[])
    assert r["geocode_ignored"]["applied"] == 1


def test_rooter_labels_and_nested_roots(tmp_path):
    a, b, inner = tmp_path / "x" / "Photos", tmp_path / "y" / "Photos", tmp_path / "x" / "Photos" / "Phone"
    r = backup_service._Rooter([str(a), str(b), str(inner)])
    assert r.labels == ["Photos", "Photos#2", "Phone"]
    assert r.identity(str(inner / "2020"), "i.jpg")[:2] == ("Phone", "2020/i.jpg")
    assert r.identity(str(a), "top.jpg")[:2] == ("Photos", "top.jpg")
    assert r.identity(str(b / "Deep" / "Er"), "z.JPG")[:2] == ("Photos#2", "Deep/Er/z.JPG")
