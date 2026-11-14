"""Undo snapshots for one-click face and person writes (audit U3).

Same contract as geotag_service's undo (U2) and photos_service.undo_date_commit:
every write that a single click can make — assign / unassign, ignore / restore,
come back, "ignore unlabeled" on a photo, delete person — returns an ``undo``
token describing exactly what it changed, the client keeps it for as long as its
Undo toast is up, and hands it back to POST /api/faces/undo. Nothing is stored
server-side, so there is no history to expire or leak between tabs.

The token:
    {"faces": [{"face_id", "before": {<FACE_STATE_COLS>}, "expect": {<EXPECT_COLS>},
                "negatives": [{"person_id", "created_at"}]}],
     "person": {<persons row>, "negatives": [{"face_id", "created_at"}]} | None,
     "created_person_id": int | None}

* ``before`` is the face row's whole state verbatim (timestamps included), so the
  restored row is indistinguishable from the original — tag-order views and the
  come-back queue order by those timestamps.
* ``expect`` is what the write left. A face that no longer matches it was changed
  again since (another tab, a later action on this page) and is refused as a
  conflict rather than clobbered; the rest of the batch still restores.
* ``negatives`` are the "not this person" rows the write deleted (assigning a face
  to P drops its "not P"); undo puts them back.
* ``person`` is a deleted person's row plus the negatives that went with it. Undo
  re-inserts it under the same id when that id is still free, so every client-side
  reference (staged assignments, the scope being viewed, Quick Tag's "use
  previous") stays valid; only if the id was reused meanwhile does it get a new
  one (reported as ``person_id``).
* ``created_person_id`` is a person an assign-by-name created; undo deletes it
  again if nothing refers to it afterwards.

Only faces the write actually changed are listed, so an undo can't "restore" a
face that was already in its final state and pick a fight with a later edit.
"""

import time

from geotagger import index

FACE_STATE_COLS = ("person_id", "ignored", "ignored_at", "come_back", "come_back_at",
                   "representative", "assigned_at")
# What undo compares to decide "changed since". The timestamps make a re-do of the
# same action (ignore again, re-tag to the same person) count as a change too.
EXPECT_COLS = ("person_id", "ignored", "come_back", "assigned_at", "ignored_at",
               "come_back_at")
_FLAG_COLS = ("ignored", "come_back", "representative")
PERSON_COLS = ("id", "name", "birth_date", "not_before", "not_after", "created_at",
               "family_id")


class UndoConflict(Exception):
    """The whole undo can't proceed (a deleted person's name is taken again)."""


def _state(row) -> dict:
    return {c: (int(row[c]) if c in _FLAG_COLS else row[c]) for c in FACE_STATE_COLS}


def _face_states(db, face_ids: list[int]) -> dict[int, dict]:
    if not face_ids:
        return {}
    cols = ", ".join(FACE_STATE_COLS)
    return {r["id"]: _state(r) for r in db.execute(
        f"SELECT id, {cols} FROM faces WHERE id IN (SELECT value FROM json_each(?))",
        (index.ids_json(face_ids),))}


def _negatives_on(db, face_ids: list[int]) -> dict[int, list[dict]]:
    """{face_id: [{person_id, created_at}]} for the given faces."""
    out: dict[int, list[dict]] = {}
    if not face_ids:
        return out
    for r in db.execute(
            "SELECT face_id, person_id, created_at FROM face_negatives "
            "WHERE face_id IN (SELECT value FROM json_each(?))", (index.ids_json(face_ids),)):
        out.setdefault(r["face_id"], []).append(
            {"person_id": r["person_id"], "created_at": r["created_at"]})
    return out


def capture(face_ids: list[int], write) -> tuple[object, dict]:
    """Run ``write()`` and return (its result, the undo token for ``face_ids``).

    The before-read, the write and the after-read are one transaction, so no
    other writer can slip in between and have its change mistaken for ours.
    ``write`` may return a dict with ``created_person_id`` (assign-by-name) —
    it's lifted into the token. Pass every face the write might touch; the ones
    it left unchanged are dropped from the token."""
    face_ids = list(dict.fromkeys(face_ids))
    with index.transaction() as db:
        before = _face_states(db, face_ids)
        negs_before = _negatives_on(db, face_ids)
        result = write()
        after = _face_states(db, face_ids)
        negs_after = _negatives_on(db, face_ids)
    faces = []
    for fid, was in before.items():
        now = after.get(fid)
        if now is None:
            continue  # the write deleted the face; nothing to restore it from
        kept = {(n["person_id"], n["created_at"]) for n in negs_after.get(fid, [])}
        dropped = [n for n in negs_before.get(fid, [])
                   if (n["person_id"], n["created_at"]) not in kept]
        if was == now and not dropped:
            continue
        faces.append({"face_id": fid, "before": was,
                      "expect": {c: now[c] for c in EXPECT_COLS},
                      "negatives": dropped})
    created = result.get("created_person_id") if isinstance(result, dict) else None
    return result, {"faces": faces, "person": None, "created_person_id": created}


def assign(face_ids: list[int], person_id: int | None, name: str | None = None
           ) -> tuple[dict, dict]:
    """assign_faces with an undo token. ``name`` finds or creates the person
    inside the same unit, and a person created here is recorded so undo can
    remove it again. Returns ({"assigned", "person_id"}, undo)."""
    def write():
        pid, created = person_id, None
        if name:
            db = index.get_db()
            row = db.execute("SELECT id FROM persons WHERE name=?", (name,)).fetchone()
            pid = row["id"] if row else index.create_person(name)
            created = None if row else pid
        n = index.assign_faces(face_ids, pid)
        return {"assigned": n, "person_id": pid, "created_person_id": created}
    out, undo = capture(face_ids, write)
    out.pop("created_person_id", None)
    return out, undo


def set_ignored(face_ids: list[int], ignored: bool) -> dict:
    return capture(face_ids, lambda: index.set_faces_ignored(face_ids, ignored))[1]


def set_come_back(face_ids: list[int], come_back: bool) -> dict:
    return capture(face_ids, lambda: index.set_faces_come_back(face_ids, come_back))[1]


def ignore_unlabeled_in_photos(photo_ids: list[int]) -> tuple[int, dict]:
    """index.ignore_unlabeled_in_photos with an undo token. Every face of those
    photos is snapshotted (a crowd photo's few dozen rows); capture keeps only
    the ones that were actually ignored."""
    with index.transaction() as db:
        ids = [r[0] for r in db.execute(
            "SELECT id FROM faces WHERE photo_id IN (SELECT value FROM json_each(?))",
            (index.ids_json(photo_ids),))]
        return capture(ids, lambda: index.ignore_unlabeled_in_photos(photo_ids))


def delete_person(person_id: int) -> dict | None:
    """index.delete_person with an undo token carrying the person row, every face
    it labeled and every "not this person" negative. None if no such person."""
    with index.transaction() as db:
        row = db.execute(
            f"SELECT {', '.join(PERSON_COLS)} FROM persons WHERE id=?", (person_id,)).fetchone()
        if row is None:
            return None
        person = {c: row[c] for c in PERSON_COLS}
        person["negatives"] = [
            {"face_id": r["face_id"], "created_at": r["created_at"]}
            for r in db.execute(
                "SELECT face_id, created_at FROM face_negatives WHERE person_id=?", (person_id,))]
        ids = [r[0] for r in db.execute(
            "SELECT id FROM faces WHERE person_id=?", (person_id,))]
        _, undo = capture(ids, lambda: index.delete_person(person_id))
    undo["person"] = person
    return undo


# ── Undo ──

def _changed_since(now: dict, expect: dict) -> bool:
    for c in EXPECT_COLS:
        a, b = now.get(c), expect.get(c)
        if c in ("ignored", "come_back"):
            a, b = bool(a), bool(b)
        if a != b:
            return True
    return False


def _restore_person(db, person: dict) -> int:
    """Re-insert a deleted person; returns its (possibly new) id."""
    name = person["name"]
    if db.execute("SELECT 1 FROM persons WHERE name=?", (name,)).fetchone():
        raise UndoConflict(f'A person named "{name}" exists again — rename or merge '
                           f'them first')
    family_id = person.get("family_id")
    if family_id is not None and not index.get_family(family_id):
        family_id = None  # the family was deleted since; the person comes back without
    cols = ("name", "birth_date", "not_before", "not_after", "created_at", "family_id")
    vals = [name, person.get("birth_date"), person.get("not_before"), person.get("not_after"),
            person.get("created_at") or time.time(), family_id]
    if not db.execute("SELECT 1 FROM persons WHERE id=?", (person["id"],)).fetchone():
        db.execute(f"INSERT INTO persons (id, {', '.join(cols)}) VALUES (?, ?, ?, ?, ?, ?, ?)",
                   [person["id"], *vals])
        return person["id"]
    # The id was reused by a person created since (persons.id has no
    # AUTOINCREMENT): take a fresh one; the reply says which.
    return db.execute(f"INSERT INTO persons ({', '.join(cols)}) VALUES (?, ?, ?, ?, ?, ?)",
                      vals).lastrowid


def undo(token: dict) -> dict:
    """Put back what a write's ``undo`` token describes. Faces changed since are
    refused (``conflicts``), faces gone are ``not_found``; the rest restore.
    Raises UndoConflict (nothing written) when a deleted person can't come back.

    Returns {"restored": [face_id], "conflicts": [face_id], "not_found": [face_id],
             "person_id": int | None, "person_id_changed": bool,
             "family_dropped": bool, "removed_person_id": int | None}."""
    person = token.get("person")
    snaps = token.get("faces") or []
    created = token.get("created_person_id")
    restored: list[int] = []
    conflicts: list[int] = []
    not_found: list[int] = []
    new_pid = None
    family_dropped = False
    removed_person = None
    with index.transaction() as db:
        id_map: dict[int, int] = {}
        if person is not None:
            new_pid = _restore_person(db, person)
            id_map[person["id"]] = new_pid
            family_dropped = (person.get("family_id") is not None and db.execute(
                "SELECT family_id FROM persons WHERE id=?", (new_pid,)).fetchone()[0] is None)
        now_states = _face_states(db, [s["face_id"] for s in snaps])
        known_persons = {r[0] for r in db.execute("SELECT id FROM persons")}
        for snap in snaps:
            fid = snap["face_id"]
            now = now_states.get(fid)
            if now is None:
                not_found.append(fid)
                continue
            before = dict(snap["before"])
            pid = before.get("person_id")
            if pid is not None:
                pid = before["person_id"] = id_map.get(pid, pid)
            if _changed_since(now, snap["expect"]) or (pid is not None and pid not in known_persons):
                conflicts.append(fid)
                continue
            db.execute(
                "UPDATE faces SET " + ", ".join(f"{c}=?" for c in FACE_STATE_COLS) + " WHERE id=?",
                [*(int(bool(before[c])) if c in _FLAG_COLS else before.get(c)
                   for c in FACE_STATE_COLS), fid])
            for n in snap.get("negatives") or []:
                npid = id_map.get(n["person_id"], n["person_id"])
                # Never re-add "not P" to a face that is (again) labeled P.
                if npid in known_persons and npid != pid:
                    db.execute("INSERT OR IGNORE INTO face_negatives (face_id, person_id, "
                               "created_at) VALUES (?, ?, ?)", (fid, npid, n["created_at"]))
            restored.append(fid)
        if person is not None and person.get("negatives"):
            neg_ids = [n["face_id"] for n in person["negatives"]]
            labels = {r[0]: r[1] for r in db.execute(
                "SELECT id, person_id FROM faces WHERE id IN (SELECT value FROM json_each(?))",
                (index.ids_json(neg_ids),))}
            db.executemany(
                "INSERT OR IGNORE INTO face_negatives (face_id, person_id, created_at) "
                "VALUES (?, ?, ?)",
                [(n["face_id"], new_pid, n["created_at"]) for n in person["negatives"]
                 if n["face_id"] in labels and labels[n["face_id"]] != new_pid])
        if created is not None and created not in id_map.values():
            # An assign-by-name made this person; it goes again unless something
            # (a face, a negative) refers to it now.
            in_use = db.execute(
                "SELECT EXISTS(SELECT 1 FROM faces WHERE person_id=?) "
                "OR EXISTS(SELECT 1 FROM face_negatives WHERE person_id=?)",
                (created, created)).fetchone()[0]
            if not in_use and db.execute(
                    "DELETE FROM persons WHERE id=?", (created,)).rowcount:
                removed_person = created
    # Restored faces may re-enter (or leave) the unlabeled queue and the gallery:
    # a plain bump rebuilds every face cache (drop_from_unlabeled_cache only
    # handles pure removals).
    index.bump_faces_generation()
    return {"restored": restored, "conflicts": conflicts, "not_found": not_found,
            "person_id": new_pid,
            "person_id_changed": person is not None and new_pid != person["id"],
            "family_dropped": family_dropped, "removed_person_id": removed_person}
