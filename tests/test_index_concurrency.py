"""Write units in index.py are atomic and isolated across threads (audit C1).

The app shares ONE sqlite3 connection between the event loop, the executor
threads and the scan workers, and SQLite transactions are per connection — so
without index.transaction() one thread's commit persists another's half-done
write, and a write that raises midway rides the next unrelated commit.

"Committed" state is always checked through a second, independent connection:
the shared one can see its own uncommitted statements, a fresh one cannot.
"""
import random
import sqlite3
import threading

import pytest

from geotagger import index

# Generous: only ever reached when something is broken (a deadlock), never on a
# passing run — every wait below is released by an Event, not by time passing.
TIMEOUT = 20


def _photo(name: str) -> int:
    index.upsert_photo(
        filename=name, dir_=".", ext=".jpg", media_type="image",
        mtime=1000.0, size=100, lat=None, lng=None, geotag_source="none",
        sidecar_path=None, sidecar_mtime=None, orientation=1,
    )
    return index.get_db().execute(
        "SELECT id FROM photos WHERE filename=?", (name,)).fetchone()[0]


def _face(tag: int = 0) -> dict:
    return {"bbox": "0.1,0.1,0.2,0.2", "det_score": 0.9, "embedding": bytes([tag % 256]) * 8}


def _committed(sql: str, params=()) -> list[tuple]:
    """Run a query on a brand-new connection — sees committed data only."""
    conn = sqlite3.connect(str(index._db_path))
    try:
        return conn.execute(sql, params).fetchall()
    finally:
        conn.close()


def _face_ids(photo_id: int) -> list[int]:
    return [r[0] for r in _committed(
        "SELECT id FROM faces WHERE photo_id=? ORDER BY id", (photo_id,))]


class _Blocker(dict):
    """A face dict that parks replace_faces in the middle of its unit — after the
    DELETEs and the first INSERT — until released, then fails it."""

    def __init__(self):
        super().__init__()
        self.reached = threading.Event()
        self.release = threading.Event()

    def __getitem__(self, key):
        self.reached.set()
        assert self.release.wait(TIMEOUT), "never released"
        raise RuntimeError("boom")


class TestRollback:
    def test_failed_multi_statement_write_leaves_no_partial_rows(self, db):
        pid = _photo("a.jpg")
        index.replace_faces(pid, [_face(1), _face(2)])
        before = _face_ids(pid)
        assert len(before) == 2

        # Second face has no det_score: the DELETEs and the first INSERT have
        # already run when the second INSERT's parameters raise KeyError.
        with pytest.raises(KeyError):
            index.replace_faces(pid, [_face(3), {"bbox": "0,0,1,1"}])

        assert not db.in_transaction
        assert _face_ids(pid) == before

        # An unrelated committed write must not resurrect the failed unit.
        person = index.create_person("Ada")
        assert _committed("SELECT name FROM persons WHERE id=?", (person,)) == [("Ada",)]
        assert _face_ids(pid) == before
        assert len(_committed("SELECT face_id FROM face_embeddings")) == 2
        assert index.get_photo(pid)["faces_det_dimension"] is None

    def test_failure_injected_mid_unit_rolls_back_delete_person(self, db, monkeypatch):
        """delete_person clears negatives and unassigns faces before the DELETE;
        if a later statement fails, the person must keep their faces."""
        pid = _photo("a.jpg")
        index.replace_faces(pid, [_face(1)])
        face_id = _face_ids(pid)[0]
        person = index.create_person("Ada")
        other = index.create_person("Bob")
        index.assign_face(face_id, person)
        index.add_face_negatives([face_id], other)

        real_execute = type(db).execute

        def failing_execute(sql, parameters=()):
            if sql.startswith("DELETE FROM persons"):
                raise sqlite3.OperationalError("injected")
            return real_execute(db, sql, parameters)

        monkeypatch.setattr(db, "execute", failing_execute)
        with pytest.raises(sqlite3.OperationalError):
            index.delete_person(person)
        monkeypatch.undo()

        index.set_setting("unrelated", "1")  # next commit on the connection
        assert _committed("SELECT person_id FROM faces WHERE id=?", (face_id,)) == [(person,)]
        assert _committed("SELECT COUNT(*) FROM persons") == [(2,)]

    def test_rollback_invalidates_generation_keyed_caches(self, db):
        faces_gen, geotag_gen = index.faces_generation(), index.geotag_generation()
        with pytest.raises(RuntimeError):
            with index.transaction():
                raise RuntimeError("boom")
        assert index.faces_generation() > faces_gen
        assert index.geotag_generation() > geotag_gen


class TestIsolation:
    def test_other_threads_commit_does_not_persist_a_half_finished_write(self, db):
        pid = _photo("a.jpg")
        index.replace_faces(pid, [_face(1), _face(2)])
        before = _face_ids(pid)
        blocker = _Blocker()
        errors: dict[str, BaseException] = {}
        b_started = threading.Event()

        def half_write():
            try:
                index.replace_faces(pid, [_face(3), blocker])
            except BaseException as e:  # noqa: BLE001 — recorded for the assert below
                errors["a"] = e

        def unrelated_write():
            b_started.set()
            try:
                index.create_person("Bob")
            except BaseException as e:  # noqa: BLE001
                errors["b"] = e

        a = threading.Thread(target=half_write)
        b = threading.Thread(target=unrelated_write)
        a.start()
        assert blocker.reached.wait(TIMEOUT)  # A: DELETEs + one INSERT pending
        b.start()
        assert b_started.wait(TIMEOUT)        # B: about to write and commit
        blocker.release.set()                 # A now fails mid-unit
        a.join(TIMEOUT)
        b.join(TIMEOUT)
        assert not a.is_alive() and not b.is_alive()

        assert isinstance(errors.get("a"), RuntimeError)
        assert "b" not in errors
        # B's write landed; none of A's did, in whichever order they ran.
        assert _committed("SELECT name FROM persons") == [("Bob",)]
        assert _face_ids(pid) == before
        assert len(_committed("SELECT face_id FROM face_embeddings")) == 2

    def test_writer_waits_for_the_open_unit(self, db):
        """A second writer runs strictly after the first unit ends, so its commit
        can never land inside it."""
        order: list[str] = []
        inside = threading.Event()
        proceed = threading.Event()
        b_started = threading.Event()

        def first():
            with index.transaction() as conn:
                conn.execute("INSERT INTO persons (name, created_at) VALUES ('A', 0)")
                inside.set()
                assert proceed.wait(TIMEOUT)
                order.append("a-end")

        def second():
            b_started.set()
            index.create_person("B")
            order.append("b-end")

        a = threading.Thread(target=first)
        b = threading.Thread(target=second)
        a.start()
        assert inside.wait(TIMEOUT)
        b.start()
        assert b_started.wait(TIMEOUT)
        # Uncommitted, so invisible to any other connection while A is open.
        assert _committed("SELECT COUNT(*) FROM persons") == [(0,)]
        proceed.set()
        a.join(TIMEOUT)
        b.join(TIMEOUT)

        assert order == ["a-end", "b-end"]
        assert sorted(_committed("SELECT name FROM persons")) == [("A",), ("B",)]


class TestNesting:
    def test_nested_units_commit_once_at_the_outermost_exit(self, db):
        statements: list[str] = []
        db.set_trace_callback(statements.append)
        try:
            with index.transaction():
                person = index.create_person("Ada")        # nested unit
                family = index.create_family("Lovelace")   # nested unit
                index.set_person_family(person, family)
                # Inner units have "finished" but nothing is durable yet.
                assert _committed("SELECT COUNT(*) FROM persons") == [(0,)]
        finally:
            db.set_trace_callback(None)

        assert sum(s.upper().startswith("COMMIT") for s in statements) == 1
        assert sum(s.upper().startswith("BEGIN") for s in statements) == 1
        assert _committed("SELECT family_id FROM persons WHERE id=?", (person,)) == [(family,)]

    def test_outer_failure_rolls_back_completed_inner_units(self, db):
        with pytest.raises(RuntimeError):
            with index.transaction():
                index.create_person("Ada")
                index.create_family("Lovelace")
                raise RuntimeError("validation failed after the writes")

        index.set_setting("unrelated", "1")
        assert _committed("SELECT COUNT(*) FROM persons") == [(0,)]
        assert _committed("SELECT COUNT(*) FROM families") == [(0,)]
        assert _committed("SELECT value FROM settings WHERE key='unrelated'") == [("1",)]

    def test_caught_inner_failure_undoes_only_the_inner_unit(self, db):
        pid = _photo("a.jpg")
        with index.transaction():
            index.create_person("Ada")
            with pytest.raises(KeyError):
                index.replace_faces(pid, [_face(1), {"bbox": "0,0,1,1"}])
            index.create_person("Bob")

        assert sorted(_committed("SELECT name FROM persons")) == [("Ada",), ("Bob",)]
        assert _face_ids(pid) == []

    def test_lock_and_depth_are_released_after_a_failure(self, db):
        with pytest.raises(RuntimeError):
            with index.transaction():
                with index.transaction():
                    raise RuntimeError("boom")
        assert index._tx_depth == 0
        # Another thread can take the lock and write straight away.
        done = threading.Event()
        t = threading.Thread(target=lambda: (index.create_person("Ada"), done.set()))
        t.start()
        assert done.wait(TIMEOUT)
        t.join(TIMEOUT)

    def test_get_or_create_person_is_one_unit(self, db):
        """Lookup + insert under one lock: N racing threads create one row."""
        n = 8
        barrier = threading.Barrier(n)
        ids: list[int] = []

        def run():
            barrier.wait(TIMEOUT)
            ids.append(index.get_or_create_person("Ada"))

        threads = [threading.Thread(target=run) for _ in range(n)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(TIMEOUT)

        assert len(set(ids)) == 1 and len(ids) == n
        assert _committed("SELECT COUNT(*) FROM persons") == [(1,)]


class TestSharedConnectionReads:
    def test_concurrent_identical_queries_each_get_their_own_rows(self, db):
        """Reads are not serialized, and every thread shares the one connection.
        With sqlite3's per-connection statement cache on, threads running the
        same SQL text shared one prepared statement and got each other's rows
        (or "bad parameter or other API misuse")."""
        n_threads, iterations = 6, 1500
        ids = [_photo(f"p{i}.jpg") for i in range(40)]
        start = threading.Barrier(n_threads)
        problems: list[str] = []

        def run(t: int):
            try:
                start.wait(TIMEOUT)
                for n in range(iterations):
                    want = ids[(t * 7 + n) % len(ids)]
                    row = index.get_photo(want)
                    if row is None or row["id"] != want:
                        problems.append(f"asked for {want}, got {row and row['id']}")
            except BaseException as e:  # noqa: BLE001
                problems.append(repr(e))

        threads = [threading.Thread(target=run, args=(t,)) for t in range(n_threads)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(TIMEOUT)
        assert problems == []


class TestMaintenance:
    def test_vacuum_runs_after_writes_through_the_primitive(self, db):
        """VACUUM cannot run inside a transaction — the primitive must leave none open."""
        pid = _photo("a.jpg")
        index.replace_faces(pid, [_face(i) for i in range(20)])
        index.replace_faces(pid, [])
        result = index.vacuum_if_needed(min_free_ratio=0.0)
        assert result["vacuumed"] is True
        assert index.get_photo(pid) is not None


class TestStress:
    def test_mixed_writers_and_a_reader_keep_invariants(self, db):
        n_threads, iterations = 6, 20
        photos = [_photo(f"p{i}.jpg") for i in range(n_threads)]
        expected_faces = [0] * n_threads
        errors: list[BaseException] = []
        start = threading.Barrier(n_threads + 1)
        stop_reader = threading.Event()

        def writer(i: int):
            rng = random.Random(i)
            pid = photos[i]
            try:
                start.wait(TIMEOUT)
                for n in range(iterations):
                    k = rng.randrange(0, 4)
                    op = rng.randrange(5)
                    if op == 0:  # a unit that fails midway must leave no trace
                        try:
                            index.replace_faces(pid, [_face(n)] * k + [{"bbox": "0,0,1,1"}])
                        except KeyError:
                            pass
                        else:
                            raise AssertionError("expected the injected failure")
                    else:
                        index.replace_faces(pid, [_face(n)] * k)
                        expected_faces[i] = k
                    index.get_or_create_person("shared")
                    person = index.create_person(f"t{i}-{n}")
                    face_ids = [r["id"] for r in index.get_db().execute(
                        "SELECT id FROM faces WHERE photo_id=?", (pid,)).fetchall()]
                    index.assign_faces(face_ids, person)
                    index.add_face_negatives(face_ids, person)
                    if op == 1:  # caller-level unit that is abandoned
                        try:
                            with index.transaction():
                                index.rename_person(person, "renamed")
                                index.delete_person(person)
                                raise ValueError("abandon")
                        except ValueError:
                            pass
                    index.set_setting(f"k{i}", str(n))
                    index.delete_person(person)
            except BaseException as e:  # noqa: BLE001
                errors.append(e)

        def reader():
            try:
                start.wait(TIMEOUT)
                while not stop_reader.is_set():
                    index.get_persons()
                    index.count_faces()
                    index.get_all_settings()
            except BaseException as e:  # noqa: BLE001
                errors.append(e)

        threads = [threading.Thread(target=writer, args=(i,)) for i in range(n_threads)]
        r = threading.Thread(target=reader)
        for t in threads + [r]:
            t.start()
        for t in threads:
            t.join(TIMEOUT * 3)
        stop_reader.set()
        r.join(TIMEOUT)
        assert not any(t.is_alive() for t in threads + [r])
        assert errors == []

        assert not db.in_transaction and index._tx_depth == 0
        assert _committed("PRAGMA integrity_check") == [("ok",)]
        # Every temporary person was deleted; the shared one exists exactly once.
        assert _committed("SELECT name FROM persons") == [("shared",)]
        assert _committed("SELECT COUNT(*) FROM face_negatives") == [(0,)]
        assert _committed("SELECT COUNT(*) FROM faces WHERE person_id IS NOT NULL") == [(0,)]
        # Faces and their embeddings stay 1:1 — no half-replaced photo.
        assert _committed(
            "SELECT COUNT(*) FROM faces f LEFT JOIN face_embeddings e ON e.face_id=f.id "
            "WHERE e.face_id IS NULL") == [(0,)]
        assert _committed(
            "SELECT COUNT(*) FROM face_embeddings e LEFT JOIN faces f ON f.id=e.face_id "
            "WHERE f.id IS NULL") == [(0,)]
        for i, pid in enumerate(photos):
            assert len(_face_ids(pid)) == expected_faces[i], f"photo {i}"
            assert _committed("SELECT value FROM settings WHERE key=?", (f"k{i}",)) == [
                (str(iterations - 1),)]
