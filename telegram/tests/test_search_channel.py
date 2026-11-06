"""Tests for `tbi search-channel` (v0.3): targeted server-side search,
indexing of hits, and the priority-request queue (offline)."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tbi import cli as cli_mod  # noqa: E402
from tbi.cli import main  # noqa: E402
from tbi.scrape import FileMeta, Post  # noqa: E402
from tbi.store import Store  # noqa: E402


def _hit_post(name="testchan", pid=42):
    return Post(
        channel=name, post_id=pid,
        url=f"https://t.me/{name}/{pid}",
        files=[FileMeta(filename="Dune.epub", size_text="1.2 MB",
                        size_bytes=1200000)],
    )


def test_search_channel_found_indexes_post(tmp_path, capsys, monkeypatch):
    db = tmp_path / "index.db"
    monkeypatch.setattr(cli_mod, "classify", lambda name, timeout=30: "channel")
    monkeypatch.setattr(cli_mod, "search_channel",
                        lambda name, query, limit=50: [_hit_post()])
    assert main([
        "search-channel", "--channel", "testchan", "--query", "Dune",
        "--db", str(db),
    ]) == 0
    out = capsys.readouterr().out
    assert "Dune" in out
    assert "https://t.me/testchan/42" in out
    assert "1 result(s), 1 book file(s)" in out
    # The hit is indexed: a plain search finds it now.
    assert main(["search", "Dune", "--db", str(db)]) == 0
    out = capsys.readouterr().out
    assert "Dune.epub" in out


def test_search_channel_not_found_queues_priority(tmp_path, capsys, monkeypatch):
    db = tmp_path / "index.db"
    monkeypatch.setattr(cli_mod, "classify", lambda name, timeout=30: "channel")
    monkeypatch.setattr(cli_mod, "search_channel",
                        lambda name, query, limit=50: [])
    assert main([
        "search-channel", "--channel", "testchan", "--query", "Dune",
        "--db", str(db),
    ]) == 0
    out = capsys.readouterr().out
    assert "No match for 'Dune' in @testchan" in out
    assert "priority backfill request" in out
    store = Store(db)
    try:
        pending = store.list_pending_priority()
    finally:
        store.close()
    assert pending == [
        {"channel": "testchan", "query": "Dune", "created_at": pending[0]["created_at"]}
    ]
    # A second identical request is a duplicate, not a second row.
    assert main([
        "search-channel", "--channel", "testchan", "--query", "Dune",
        "--db", str(db),
    ]) == 0
    out = capsys.readouterr().out
    assert "already queued" in out
    store = Store(db)
    try:
        assert len(store.list_pending_priority()) == 1
    finally:
        store.close()


def test_search_channel_no_preview_fails(tmp_path, capsys, monkeypatch):
    db = tmp_path / "index.db"
    monkeypatch.setattr(cli_mod, "classify", lambda name, timeout=30: "no_preview")
    assert main([
        "search-channel", "--channel", "testchan", "--query", "Dune",
        "--db", str(db),
    ]) == 1
    captured = capsys.readouterr()
    assert "no public preview" in captured.out + captured.err


def test_priority_queue_add_list_resolve(tmp_path):
    db = tmp_path / "index.db"
    store = Store(db)
    try:
        assert store.add_priority_request("chanA", "Dune") is True
        assert store.add_priority_request("chanA", "Dune") is False  # duplicate
        assert store.add_priority_request("chanB", "Dune") is True
        assert store.pending_priority_channels() == ["chanA", "chanB"]
        store.resolve_priority("chanA", "Dune")
        assert store.pending_priority_channels() == ["chanB"]
    finally:
        store.close()


def test_priority_queue_resolves_when_book_appears(tmp_path):
    db = tmp_path / "index.db"
    store = Store(db)
    try:
        sid = store.upsert_source("channel", "testchan")
        pid = store.upsert_post(sid, 42, "2026-11-06T10:00:00+00:00", "", "")
        store.replace_files_for_post(pid, [{
            "filename": "Dune.epub", "ext": "epub",
            "size_text": "1.2 MB", "size_bytes": 1200000,
            "title": "Dune", "author": "",
            "dedupe_key": "dune||1200000",
            "obtain_url": "https://t.me/testchan/42",
        }])
        store.commit()
        assert store.add_priority_request("testchan", "Dune") is True
        assert store.add_priority_request("testchan", "Other Book") is True
        resolved = store.resolve_matching_priority("testchan")
        assert resolved == ["Dune"]
        assert store.pending_priority_channels() == ["testchan"]
        assert store.list_pending_priority()[0]["query"] == "Other Book"
    finally:
        store.close()
