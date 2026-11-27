"""Tests for Drive removal + cleanup (bot v4.8.84 follow-up).

Covers: the sweep's "removed" backstop (parse_pending -> to_remove),
the guarded remove/unavailable SQL builders, the --run manifest
entries the workflow applies, and the daily health check's
library-level visibility flips (unavailable / recovery).

No network, no D1, no Drive: the planner runs on submissions JSON
blobs; --run is exercised with a stubbed drive_index subprocess;
drive_health is exercised with a stubbed check_library.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tbi"))

import drive_health  # noqa: E402
import drive_sweep  # noqa: E402
from drive_sweep import (  # noqa: E402
    parse_pending, registry_from_d1_rows, remove_sql_for,
    restore_sql_for, unavailable_sql_for,
)

F_A = "AAA111AAA111AAA11111"
F_B = "BBB222BBB222BBB22222"
F_C = "CCC333CCC333CCC33333"


def _sub(folder, status, user=111, ts="2026-11-26T10:00:00Z"):
    return {"timestamp": ts, "user_id": user, "type": "channel",
            "title": f"drive:{folder}", "status": status}


# --- parse_pending: "removed" -------------------------------------

def test_parse_pending_removed_indexed_goes_to_remove():
    recs = [_sub(F_A, "removed")]
    plan = parse_pending(recs, {F_A}, set())
    assert [t["folder_id"] for t in plan["to_remove"]] == [F_A]
    assert plan["to_remove"][0]["submitter_tg_id"] == 111
    assert plan["to_index"] == []
    assert plan["skipped_indexed"] == [F_A]


def test_parse_pending_removed_unindexed_never_indexes():
    # Never indexed: nothing to hide, and it must NOT be indexed now
    # (a removed folder must not come back through the sweep).
    recs = [_sub(F_A, "removed")]
    plan = parse_pending(recs, set(), set())
    assert plan["to_remove"] == []
    assert plan["to_index"] == []
    assert plan["skipped_removed"] == [F_A]


def test_parse_pending_removed_newest_wins_over_pubreq():
    # Newest record is the removal; the older pending_public is dead.
    recs = [_sub(F_A, "removed", ts="2026-11-26T11:00:00Z"),
            _sub(F_A, "pending_public", ts="2026-11-26T10:00:00Z")]
    plan = parse_pending(recs, {F_A}, set(), {F_A.lower(): "private"})
    assert [t["folder_id"] for t in plan["to_remove"]] == [F_A]
    assert plan["to_publish"] == []


def test_parse_pending_pubreq_newest_wins_over_removed():
    # The other way round: a newer pending_public beats an older
    # removal (the user re-asked for publication after removing).
    recs = [_sub(F_A, "pending_public", ts="2026-11-26T11:00:00Z"),
            _sub(F_A, "removed", ts="2026-11-26T10:00:00Z")]
    plan = parse_pending(recs, {F_A}, set(), {F_A.lower(): "private"})
    assert [t["folder_id"] for t in plan["to_publish"]] == [F_A]
    assert plan["to_remove"] == []


def test_parse_pending_readd_of_removed_goes_to_restore():
    # The user removed the library, then re-added the same folder:
    # newest record is a fresh pending_index, registry still says
    # removed -> the restore list, not the index list (the books
    # rows are still there; no re-index is needed).
    recs = [_sub(F_A, "pending_index")]
    plan = parse_pending(recs, {F_A}, set(), {F_A.lower(): "removed"})
    assert [t["folder_id"] for t in plan["to_restore"]] == [F_A]
    assert plan["to_index"] == []
    assert plan["to_remove"] == []


def test_parse_pending_readd_of_live_library_is_noop():
    # Re-adding a library that is already live changes nothing.
    recs = [_sub(F_A, "pending_index")]
    plan = parse_pending(recs, {F_A}, set(), {F_A.lower(): "private"})
    assert plan["to_restore"] == []
    assert plan["to_index"] == []
    assert plan["skipped_indexed"] == [F_A]


# --- Guarded SQL builders ------------------------------------------

def test_remove_sql_for_is_guarded_and_keeps_metadata():
    sql = remove_sql_for(F_A, "2026-11-27T15:00:00Z")
    assert "SET visibility = 'removed'" in sql
    assert "AND visibility != 'removed'" in sql
    assert "DELETE" not in sql


def test_unavailable_sql_for_never_touches_removed():
    sql = unavailable_sql_for(F_A, "2026-11-27T15:00:00Z")
    assert "SET visibility = 'unavailable'" in sql
    assert "IN ('public', 'private', 'pending_public')" in sql
    assert "DELETE" not in sql


def test_restore_sql_for_only_matches_dead_states():
    sql = restore_sql_for(F_A, "2026-11-27T15:00:00Z")
    assert "SET visibility = 'private'" in sql
    assert "IN ('removed', 'unavailable')" in sql
    assert "DELETE" not in sql


def test_registry_from_d1_rows_keeps_removed_and_unavailable():
    rows = [
        {"folder_id": F_A, "title": "A", "added_by": "", "added_at": "",
         "status": "active", "visibility": "removed", "submitter_tg_id": 111},
        {"folder_id": F_B, "title": "B", "added_by": "", "added_at": "",
         "status": "active", "visibility": "unavailable",
         "submitter_tg_id": 111},
    ]
    reg = registry_from_d1_rows(rows)
    assert [e["visibility"] for e in reg["libraries"]] == [
        "removed", "unavailable"]


# --- --run manifest: to_remove / to_unavailable --------------------

def test_run_manifest_carries_remove_sql(monkeypatch, tmp_path):
    subs = tmp_path / "subs.json"
    subs.write_text(json.dumps([_sub(F_A, "removed")]), encoding="utf-8")
    reg = tmp_path / "drive-libraries.json"
    reg.write_text(json.dumps({"libraries": [
        {"folder_id": F_A, "title": "Lib A", "visibility": "public"}]}),
        encoding="utf-8")
    manifest = tmp_path / "manifest.json"
    monkeypatch.setattr(sys, "argv", ["drive_sweep.py", "--run",
        "--submissions", str(subs), "--registry", str(reg),
        "--out-dir", str(tmp_path / "batches"),
        "--state-file", str(tmp_path / "s.jsonl"),
        "--start-id", "100", "--manifest", str(manifest)])
    assert drive_sweep.main() == 0
    data = json.loads(manifest.read_text(encoding="utf-8"))
    assert [t["folder_id"] for t in data["to_remove"]] == [F_A]
    assert "SET visibility = 'removed'" in data["to_remove"][0]["remove_sql"]
    assert data["to_unavailable"] == []
    assert data["indexed"] == []


def test_run_manifest_carries_restore_sql(monkeypatch, tmp_path):
    subs = tmp_path / "subs.json"
    subs.write_text(json.dumps([_sub(F_A, "pending_index")]),
                    encoding="utf-8")
    reg = tmp_path / "drive-libraries.json"
    reg.write_text(json.dumps({"libraries": [
        {"folder_id": F_A, "title": "Lib A", "visibility": "removed"}]}),
        encoding="utf-8")
    manifest = tmp_path / "manifest.json"
    monkeypatch.setattr(sys, "argv", ["drive_sweep.py", "--run",
        "--submissions", str(subs), "--registry", str(reg),
        "--out-dir", str(tmp_path / "batches"),
        "--state-file", str(tmp_path / "s.jsonl"),
        "--start-id", "100", "--manifest", str(manifest)])
    assert drive_sweep.main() == 0
    data = json.loads(manifest.read_text(encoding="utf-8"))
    assert [t["folder_id"] for t in data["to_restore"]] == [F_A]
    assert "SET visibility = 'private'" in data["to_restore"][0]["restore_sql"]
    assert data["indexed"] == []


class _FakeRun:
    """Stand-in for subprocess.run: fabricates drive_index outputs."""

    def __init__(self, outcomes):
        # outcomes: {folder_id: (returncode, n_books)}
        self.outcomes = outcomes

    def __call__(self, cmd, capture_output=True, text=True, timeout=None):
        folder = cmd[cmd.index("--folder") + 1]
        out_dir = Path(cmd[cmd.index("--out-dir") + 1])
        rc, n = self.outcomes.get(folder, (0, 1))

        class Proc:
            pass

        p = Proc()
        p.returncode = rc
        p.stdout = ""
        p.stderr = ""
        if rc == 0:
            out_dir.mkdir(parents=True, exist_ok=True)
            books = [{"title": f"Book {i}", "folder_id": folder}
                     for i in range(n)]
            (out_dir / f"drive-{folder[:12]}-books.json").write_text(
                json.dumps(books), encoding="utf-8")
        return p


def test_run_failed_listing_becomes_to_unavailable(monkeypatch, tmp_path):
    subs = tmp_path / "subs.json"
    subs.write_text(json.dumps([_sub(F_A, "pending_index")]),
                    encoding="utf-8")
    reg = tmp_path / "drive-libraries.json"
    reg.write_text(json.dumps({"libraries": []}), encoding="utf-8")
    fake = _FakeRun({F_A: (3, 0)})  # 3 = EXIT_NOT_SHARED
    monkeypatch.setattr(drive_sweep.subprocess, "run", fake)
    manifest = tmp_path / "manifest.json"
    monkeypatch.setattr(sys, "argv", ["drive_sweep.py", "--run",
        "--submissions", str(subs), "--registry", str(reg),
        "--out-dir", str(tmp_path / "batches"),
        "--state-file", str(tmp_path / "s.jsonl"),
        "--start-id", "100", "--manifest", str(manifest)])
    assert drive_sweep.main() == 0
    data = json.loads(manifest.read_text(encoding="utf-8"))
    assert data["failed"][0]["reason"] == "not_shared_or_missing"
    assert [t["folder_id"] for t in data["to_unavailable"]] == [F_A]
    assert "SET visibility = 'unavailable'" in \
        data["to_unavailable"][0]["unavailable_sql"]


# --- drive_health: library-level flips -----------------------------

def _health_run(monkeypatch, tmp_path, registry, folder_ok, missing=None):
    reg = tmp_path / "drive-libraries.json"
    reg.write_text(json.dumps({"libraries": registry}), encoding="utf-8")
    state = tmp_path / "drive-state.jsonl"
    state.write_text("", encoding="utf-8")
    out = tmp_path / "out"

    def stub(client, folder_id, indexed, checked_at):
        return {"folder_id": folder_id, "folder_ok": folder_ok,
                "folder_error": "" if folder_ok else "404",
                "missing": missing or [], "recovered": [],
                "live_count": 0}

    monkeypatch.setattr(drive_health, "check_library", stub)
    # main() builds HttpDriveClient before check_library runs; the
    # client is never used (check_library is stubbed), but its
    # constructor raises without a key. Dummy value, no network.
    monkeypatch.setenv("DRIVE_API_KEY", "test-dummy")
    monkeypatch.setattr(sys, "argv", ["drive_health.py", "--client", "http",
        "--registry", str(reg), "--state", str(state),
        "--out-dir", str(out)])
    rc = drive_health.main()
    sql = (out / "drive-health.sql").read_text(encoding="utf-8")
    return rc, sql


def test_health_dead_folder_flips_unavailable(monkeypatch, tmp_path):
    rc, sql = _health_run(monkeypatch, tmp_path,
                          [{"folder_id": F_A, "title": "Lib A",
                            "visibility": "private"}], folder_ok=False)
    assert rc == 1
    assert "SET visibility='unavailable'" in sql
    assert F_A in sql


def test_health_recovery_restores_private(monkeypatch, tmp_path):
    rc, sql = _health_run(monkeypatch, tmp_path,
                          [{"folder_id": F_A, "title": "Lib A",
                            "visibility": "unavailable"}], folder_ok=True)
    assert rc == 0
    assert "SET visibility='private'" in sql
    assert "AND visibility='unavailable'" in sql


def test_health_never_touches_removed(monkeypatch, tmp_path):
    rc, sql = _health_run(monkeypatch, tmp_path,
                          [{"folder_id": F_A, "title": "Lib A",
                            "visibility": "removed"}], folder_ok=False)
    assert rc == 1
    assert "SET visibility='unavailable'" not in sql
    assert "SET visibility='private'" not in sql
