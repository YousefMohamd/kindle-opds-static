"""Tests for the Drive sweep (Build 1 planner + Build 2 registry sync).

No network, no D1, no Drive: the planner runs on submissions JSON
blobs; --run is exercised with a stubbed drive_index subprocess.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tbi"))

import drive_sweep  # noqa: E402
from drive_sweep import (  # noqa: E402
    apply_marker, load_failed, parse_pending, registry_from_d1_rows,
)

F_A = "AAA111AAA111AAA11111"
F_B = "BBB222BBB222BBB22222"
F_C = "CCC333CCC333CCC33333"


def _sub(folder, status, user=111, ts="2026-11-26T10:00:00Z"):
    return {"timestamp": ts, "user_id": user, "type": "channel",
            "title": f"drive:{folder}", "status": status}


def test_parse_pending_newest_wins():
    # Newest first: a newer "accepted" supersedes the pending one.
    recs = [_sub(F_A, "accepted", ts="2026-11-26T11:00:00Z"),
            _sub(F_A, "pending_index", ts="2026-11-26T10:00:00Z")]
    plan = parse_pending(recs, set(), set())
    assert plan["to_index"] == []


def test_parse_pending_pubreq_before_index_still_indexes():
    # The submitter asked for publication while the folder was still
    # unindexed — the pubreq record is newest, but the folder still
    # needs indexing (otherwise the monitor 400s on approve).
    recs = [_sub(F_A, "pending_public", ts="2026-11-26T11:00:00Z"),
            _sub(F_A, "pending_index", ts="2026-11-26T10:00:00Z")]
    plan = parse_pending(recs, set(), set())
    assert [t["folder_id"] for t in plan["to_index"]] == [F_A]
    assert plan["to_index"][0]["submitter_tg_id"] == 111


def test_parse_pending_skips_indexed_failed_and_other_types():
    recs = [
        _sub(F_A, "pending_index"),
        _sub(F_B, "pending_index"),
        _sub(F_C, "pending_index"),
        {"timestamp": "2026-11-26T10:00:00Z", "user_id": 111,
         "type": "channel", "title": "t.me/somechannel", "status": "pending"},
        {"timestamp": "2026-11-26T10:00:00Z", "user_id": 111,
         "type": "channel", "title": "drive:ABC", "status": "pending_index"},
    ]
    plan = parse_pending(recs, {F_A}, {F_B})
    assert [t["folder_id"] for t in plan["to_index"]] == [F_C]
    assert plan["skipped_indexed"] == [F_A]
    assert plan["skipped_failed"] == [F_B]
    assert plan["invalid"] == ["ABC"]


def test_load_failed_accepts_kv_list_and_plain_list(tmp_path):
    p = tmp_path / "failed.json"
    p.write_text(json.dumps({"keys": [
        {"key": f"drive:failed:{F_A}"}, {"key": "other:thing"}]}),
        encoding="utf-8")
    assert load_failed(p) == {F_A}
    p.write_text(json.dumps([F_B]), encoding="utf-8")
    assert load_failed(p) == {F_B}
    assert load_failed(tmp_path / "nope.json") == set()


def test_registry_from_d1_rows_maps_fields_and_skips_bad_visibility():
    rows = [
        {"folder_id": F_A, "title": "مكتبة أ", "added_by": "111",
         "added_at": "2026-11-26", "status": "active",
         "submitter_tg_id": 111, "visibility": "private"},
        {"folder_id": F_B, "title": "Bad", "added_by": "",
         "added_at": "", "status": "active", "submitter_tg_id": None,
         "visibility": "bogus"},
        {"folder_id": "short", "title": "Bad id", "visibility": "public"},
    ]
    reg = registry_from_d1_rows(rows)
    assert len(reg["libraries"]) == 1
    lib = reg["libraries"][0]
    assert lib["folder_id"] == F_A and lib["visibility"] == "private"
    assert lib["submitted_by"] == 111


def test_apply_marker_upserts_and_forces_visibility():
    reg = {"libraries": [
        {"folder_id": F_A, "title": "Old", "visibility": "pending_public",
         "submitted_by": 111}]}
    out = apply_marker(reg, {"folder_id": F_A, "title": "New",
                             "visibility": "public", "submitter_tg_id": 111})
    assert out["libraries"][0]["visibility"] == "public"
    assert out["libraries"][0]["title"] == "New"
    assert out["libraries"][0]["submitted_by"] == 111
    out2 = apply_marker({"libraries": []},
                        {"folder_id": F_B, "title": "Fresh",
                         "visibility": "private", "submitter_tg_id": 222})
    assert out2["libraries"][0]["folder_id"] == F_B
    assert out2["libraries"][0]["submitted_by"] == 222


def test_sync_registry_from_d1_rows_cli(monkeypatch, tmp_path):
    import sys
    reg = tmp_path / "drive-libraries.json"
    reg.write_text(json.dumps({"libraries": [
        {"folder_id": F_A, "title": "Stale", "visibility": "private"}]}),
        encoding="utf-8")
    rows = tmp_path / "rows.json"
    rows.write_text(json.dumps({"results": [
        {"folder_id": F_A, "title": "Fresh", "added_by": "111",
         "added_at": "2026-11-26", "status": "active",
         "submitter_tg_id": 111, "visibility": "public"}]}),
        encoding="utf-8")
    monkeypatch.setattr(sys, "argv", ["drive_sweep.py", "--sync-registry",
        "--registry", str(reg), "--d1-rows", str(rows)])
    assert drive_sweep.main() == 0
    data = json.loads(reg.read_text(encoding="utf-8"))
    assert data["libraries"][0]["visibility"] == "public"
    assert data["libraries"][0]["title"] == "Fresh"


def test_sync_registry_marker_fallback_cli(monkeypatch, tmp_path):
    import sys
    reg = tmp_path / "drive-libraries.json"
    reg.write_text(json.dumps({"libraries": []}), encoding="utf-8")
    marker = tmp_path / "marker.json"
    marker.write_text(json.dumps(
        {"folder_id": F_A, "title": "Marked", "visibility": "public",
         "submitter_tg_id": 111, "at": "2026-11-26T12:00:00Z"}),
        encoding="utf-8")
    monkeypatch.setattr(sys, "argv", ["drive_sweep.py", "--sync-registry",
        "--registry", str(reg), "--marker", str(marker)])
    assert drive_sweep.main() == 0
    data = json.loads(reg.read_text(encoding="utf-8"))
    assert data["libraries"][0]["visibility"] == "public"
    assert data["libraries"][0]["submitted_by"] == 111


def test_plan_cli_writes_plan_json(monkeypatch, tmp_path):
    import sys
    subs = tmp_path / "subs.json"
    subs.write_text(json.dumps([
        _sub(F_A, "pending_index"),
        _sub(F_B, "pending_index"),
    ]), encoding="utf-8")
    reg = tmp_path / "drive-libraries.json"
    reg.write_text(json.dumps({"libraries": [
        {"folder_id": F_B, "title": "Indexed", "visibility": "private"}]}),
        encoding="utf-8")
    out = tmp_path / "plan.json"
    monkeypatch.setattr(sys, "argv", ["drive_sweep.py", "--plan",
        "--submissions", str(subs), "--registry", str(reg),
        "--out", str(out)])
    assert drive_sweep.main() == 0
    plan = json.loads(out.read_text(encoding="utf-8"))
    assert [t["folder_id"] for t in plan["to_index"]] == [F_A]
    assert plan["skipped_indexed"] == [F_B]


class _FakeRun:
    """Stand-in for subprocess.run: fabricates drive_index outputs."""

    def __init__(self, outcomes):
        # outcomes: {folder_id: (returncode, n_books)}
        self.outcomes = outcomes
        self.calls = []

    def __call__(self, cmd, capture_output=True, text=True, timeout=None):
        folder = cmd[cmd.index("--folder") + 1]
        out_dir = Path(cmd[cmd.index("--out-dir") + 1])
        rc, n = self.outcomes.get(folder, (0, 1))
        self.calls.append(folder)

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


def test_run_indexes_and_advances_start_id(monkeypatch, tmp_path):
    import sys
    subs = tmp_path / "subs.json"
    subs.write_text(json.dumps([
        _sub(F_A, "pending_index"), _sub(F_B, "pending_index"),
    ]), encoding="utf-8")
    reg = tmp_path / "drive-libraries.json"
    reg.write_text(json.dumps({"libraries": []}), encoding="utf-8")
    fake = _FakeRun({F_A: (0, 2), F_B: (0, 3)})
    monkeypatch.setattr(drive_sweep.subprocess, "run", fake)
    manifest = tmp_path / "manifest.json"
    monkeypatch.setattr(sys, "argv", ["drive_sweep.py", "--run",
        "--submissions", str(subs), "--registry", str(reg),
        "--out-dir", str(tmp_path / "batches"),
        "--state-file", str(tmp_path / "s.jsonl"),
        "--start-id", "100", "--manifest", str(manifest)])
    assert drive_sweep.main() == 0
    data = json.loads(manifest.read_text(encoding="utf-8"))
    assert len(data["indexed"]) == 2
    assert data["indexed"][0]["books"] == 2
    assert data["indexed"][1]["books"] == 3
    # 100 + 2 books -> the second folder starts at 102.
    assert data["next_start_id"] == 105
    assert data["failed"] == [] and data["deferred"] == []


def test_run_records_failures_and_defers_over_max(monkeypatch, tmp_path):
    import sys
    subs = tmp_path / "subs.json"
    subs.write_text(json.dumps([
        _sub(F_A, "pending_index"), _sub(F_B, "pending_index"),
        _sub(F_C, "pending_index"),
    ]), encoding="utf-8")
    reg = tmp_path / "drive-libraries.json"
    reg.write_text(json.dumps({"libraries": []}), encoding="utf-8")
    fake = _FakeRun({F_A: (3, 0), F_B: (4, 0), F_C: (0, 1)})
    monkeypatch.setattr(drive_sweep.subprocess, "run", fake)
    manifest = tmp_path / "manifest.json"
    monkeypatch.setattr(sys, "argv", ["drive_sweep.py", "--run",
        "--submissions", str(subs), "--registry", str(reg),
        "--out-dir", str(tmp_path / "batches"),
        "--state-file", str(tmp_path / "s.jsonl"),
        "--start-id", "100", "--manifest", str(manifest)])
    assert drive_sweep.main() == 0
    data = json.loads(manifest.read_text(encoding="utf-8"))
    assert [f["folder_id"] for f in data["failed"]] == [F_A]
    assert data["failed"][0]["reason"] == "not_shared_or_missing"
    assert [d["folder_id"] for d in data["deferred"]] == [F_B]
    assert [i["folder_id"] for i in data["indexed"]] == [F_C]


# --- WAVE 7: make-public backstop (SWEEP_SPEC_pubreq.md) ------------

def test_parse_pending_to_publish_indexed_private():
    # Indexed library, registry still private, newest record asks
    # for publication -> the backstop list, not the index list.
    recs = [_sub(F_A, "pending_public")]
    plan = parse_pending(recs, {F_A}, set(),
                         {F_A.lower(): "private"})
    assert [t["folder_id"] for t in plan["to_publish"]] == [F_A]
    assert plan["to_publish"][0]["submitter_tg_id"] == 111
    assert plan["to_index"] == []


def test_parse_pending_to_publish_skipped_when_already_pending():
    # Already pending_public in the registry: the endpoint already
    # applied it — neither action list (fail closed).
    recs = [_sub(F_A, "pending_public")]
    plan = parse_pending(recs, {F_A}, set(),
                         {F_A.lower(): "pending_public"})
    assert plan["to_publish"] == [] and plan["to_index"] == []


def test_parse_pending_to_publish_unknown_visibility_is_neither():
    # Missing visibility value must not trigger a write.
    recs = [_sub(F_A, "pending_public")]
    plan = parse_pending(recs, {F_A}, set(), {})
    assert plan["to_publish"] == [] and plan["to_index"] == []


def test_parse_pending_pubreq_unindexed_still_indexes():
    # Not indexed yet: the folder still needs indexing (the publish
    # SQL is emitted by --run once it is indexed); to_publish stays
    # empty because there is no registry row to UPDATE.
    recs = [_sub(F_A, "pending_public")]
    plan = parse_pending(recs, set(), set(),
                         {F_A.lower(): "private"})
    assert [t["folder_id"] for t in plan["to_index"]] == [F_A]
    assert plan["to_publish"] == []


def test_parse_pending_rejection_after_pubreq_is_neither():
    # Newest-wins: an owner rejection after the request supersedes
    # it — the folder appears in neither action list.
    recs = [_sub(F_A, "rejected", ts="2026-11-26T12:00:00Z"),
            _sub(F_A, "pending_public", ts="2026-11-26T11:00:00Z")]
    plan = parse_pending(recs, {F_A}, set(),
                         {F_A.lower(): "private"})
    assert plan["to_publish"] == [] and plan["to_index"] == []


def test_publish_sql_for_is_guarded():
    from drive_sweep import publish_sql_for
    sql = publish_sql_for(F_A, "2026-11-26T12:00:00Z")
    assert sql == ("UPDATE drive_libraries SET visibility = 'pending_public', "
                   "requested_at = '2026-11-26T12:00:00Z' "
                   f"WHERE folder_id = '{F_A}' AND visibility = 'private';")
    import pytest
    with pytest.raises(ValueError):
        publish_sql_for("bad id!", "2026-11-26T12:00:00Z")


def test_run_emits_publish_sql_for_pubreq_trigger(monkeypatch, tmp_path):
    # A folder indexed in this run from a pending_public trigger
    # carries publish_sql (guard + requested_at); a plain
    # pending_index folder carries none.
    import sys
    subs = tmp_path / "subs.json"
    subs.write_text(json.dumps([
        _sub(F_A, "pending_public"), _sub(F_B, "pending_index"),
    ]), encoding="utf-8")
    reg = tmp_path / "drive-libraries.json"
    reg.write_text(json.dumps({"libraries": []}), encoding="utf-8")
    fake = _FakeRun({F_A: (0, 1), F_B: (0, 1)})
    monkeypatch.setattr(drive_sweep.subprocess, "run", fake)
    manifest = tmp_path / "manifest.json"
    monkeypatch.setattr(sys, "argv", ["drive_sweep.py", "--run",
        "--submissions", str(subs), "--registry", str(reg),
        "--out-dir", str(tmp_path / "batches"),
        "--state-file", str(tmp_path / "s.jsonl"),
        "--start-id", "100", "--manifest", str(manifest)])
    assert drive_sweep.main() == 0
    data = json.loads(manifest.read_text(encoding="utf-8"))
    by_id = {e["folder_id"]: e for e in data["indexed"]}
    assert "publish_sql" in by_id[F_A]
    assert "AND visibility = 'private'" in by_id[F_A]["publish_sql"]
    assert "requested_at = '20" in by_id[F_A]["publish_sql"]
    assert f"folder_id = '{F_A}'" in by_id[F_A]["publish_sql"]
    assert "publish_sql" not in by_id[F_B]
    assert data["to_publish"] == []


def test_run_to_publish_manifest_for_indexed_private(monkeypatch, tmp_path):
    # Indexed private library + pending_public record: no indexing
    # happens, but the manifest carries the backstop UPDATE.
    import sys
    subs = tmp_path / "subs.json"
    subs.write_text(json.dumps([_sub(F_A, "pending_public")]),
                    encoding="utf-8")
    reg = tmp_path / "drive-libraries.json"
    reg.write_text(json.dumps({"libraries": [
        {"folder_id": F_A, "title": "Priv", "visibility": "private"}]}),
        encoding="utf-8")
    fake = _FakeRun({})
    monkeypatch.setattr(drive_sweep.subprocess, "run", fake)
    manifest = tmp_path / "manifest.json"
    monkeypatch.setattr(sys, "argv", ["drive_sweep.py", "--run",
        "--submissions", str(subs), "--registry", str(reg),
        "--out-dir", str(tmp_path / "batches"),
        "--state-file", str(tmp_path / "s.jsonl"),
        "--start-id", "100", "--manifest", str(manifest)])
    assert drive_sweep.main() == 0
    assert fake.calls == []  # nothing to index
    data = json.loads(manifest.read_text(encoding="utf-8"))
    assert data["indexed"] == []
    assert len(data["to_publish"]) == 1
    pub = data["to_publish"][0]
    assert pub["folder_id"] == F_A and pub["submitter_tg_id"] == 111
    assert "AND visibility = 'private'" in pub["publish_sql"]
    assert f"folder_id = '{F_A}'" in pub["publish_sql"]


def test_plan_cli_lists_to_publish(monkeypatch, tmp_path):
    import sys
    subs = tmp_path / "subs.json"
    subs.write_text(json.dumps([_sub(F_A, "pending_public")]),
                    encoding="utf-8")
    reg = tmp_path / "drive-libraries.json"
    reg.write_text(json.dumps({"libraries": [
        {"folder_id": F_A, "title": "Priv", "visibility": "private"}]}),
        encoding="utf-8")
    out = tmp_path / "plan.json"
    monkeypatch.setattr(sys, "argv", ["drive_sweep.py", "--plan",
        "--submissions", str(subs), "--registry", str(reg),
        "--out", str(out)])
    assert drive_sweep.main() == 0
    plan = json.loads(out.read_text(encoding="utf-8"))
    assert [t["folder_id"] for t in plan["to_publish"]] == [F_A]
    assert plan["to_index"] == []
