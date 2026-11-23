"""Tests for tbi.live_sync — realtime-sync hardening (v4.8.63).

Everything here is offline: a fake Telethon client (duck-typed)
stands in for the real one, so no network and no credentials are
needed — and Telethon itself is never imported (it is an optional
dependency). The input-peer factories are monkeypatched the same
way test_entity_cache.py does it.
"""

import asyncio
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tbi.entity_cache import EntityCache, ResolveFloodWait  # noqa: E402
from tbi.live_sync import _scan_run_id, _write_summary, run_check  # noqa: E402


class _FloodWait(Exception):
    """Stand-in for Telethon's FloodWaitError (only `.seconds`
    matters — the resolver honours it duck-typed)."""

    def __init__(self, seconds=0):
        super().__init__(f"flood wait {seconds}s")
        self.seconds = seconds


class FakeFile:
    def __init__(self, name, size):
        self.name = name
        self.size = size
        self.ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""


class FakeMessage:
    def __init__(self, pid, text="", file=None):
        self.id = pid
        self.message = text
        self.file = file
        self.media = None
        self.date = datetime(2026, 11, 6, 10, 0, tzinfo=timezone.utc)


class FakeEntity:
    """A channel/group entity carrying its handle (class name is
    not "User", so the resolver never refuses it)."""

    def __init__(self, handle):
        self.handle = handle


class FakeClient:
    """Duck-typed stand-in for a Telethon client.

    ``by_handle`` maps handle -> messages (newest first).
    ``flood_on`` is a set of handles whose get_entity raises a
    flood wait (the ResolveUsernameRequest flood of run #632).
    Every get_entity call is recorded, so the tests can prove the
    cache is (or is not) used."""

    def __init__(self, by_handle, *, flood_on=()):
        self.by_handle = by_handle
        self.flood_on = set(flood_on)
        self.get_entity_calls: list[str] = []

    async def get_entity(self, handle):
        self.get_entity_calls.append(handle)
        if handle in self.flood_on:
            raise _FloodWait(seconds=3000)
        return FakeEntity(handle)

    async def iter_messages(self, entity, offset_id=0, limit=None):
        msgs = self.by_handle.get(getattr(entity, "handle", ""), [])
        msgs = [m for m in msgs if offset_id == 0 or m.id < offset_id]
        if limit is not None:
            msgs = msgs[:limit]
        for m in msgs:
            yield m


@pytest.fixture
def fake_input_peers(monkeypatch):
    """Monkeypatch the lazy Telethon input-peer factories (no
    Telethon installed here) and return the id -> handle map the
    test fills before building its cache entries."""
    by_id: dict[int, str] = {}

    def fake_channel(channel_id, access_hash):
        return FakeEntity(by_id[channel_id])

    def fake_chat(chat_id):
        return FakeEntity(by_id[chat_id])

    monkeypatch.setattr("tbi.entity_cache._input_channel", fake_channel)
    monkeypatch.setattr("tbi.entity_cache._input_peer_chat", fake_chat)
    return by_id


def _warm_cache(by_id, handles):
    """An in-memory EntityCache with one entry per handle."""
    entries = {}
    for i, handle in enumerate(handles):
        channel_id = 1000 + i
        by_id[channel_id] = handle
        entries[handle.lower()] = {
            "handle": handle,
            "id": channel_id,
            "access_hash": 111 + i,
            "type": "channel",
            "resolved_at": "2026-11-24T00:00:00+00:00",
        }
    return EntityCache(entries=entries)


def _book_msg(pid, filename="Dune - Frank Herbert.epub"):
    return FakeMessage(pid, file=FakeFile(filename, 1200000))


def _run(coro):
    return asyncio.run(coro)


# --- step 5: the entity cache must actually be used --------------------

def test_run_check_uses_warm_entity_cache_without_resolving(fake_input_peers):
    """A warm cache means ZERO ResolveUsernameRequest calls: the
    run reads the cached id + access hash only (the #632 fix —
    before this, live_sync never passed a cache at all)."""
    cache = _warm_cache(fake_input_peers, ["chanA", "chanB"])
    client = FakeClient({
        "chanA": [_book_msg(105), FakeMessage(104, "hello")],
        "chanB": [_book_msg(77, "Dune - Frank Herbert.pdf")],
    })
    books, new_cursor, failed, resolve_flood = _run(run_check(
        client,
        [("channel", "chanA", ""), ("channel", "chanB", "")],
        {"chanA": 100, "chanB": 70},
        delay=0,
        cache=cache,
    ))
    assert client.get_entity_calls == []
    assert [b["title"] for b in books] == ["Dune", "Dune"]
    assert new_cursor == {"chanA": 105, "chanB": 77}
    assert failed == []
    assert resolve_flood is None


def test_run_check_without_cache_resolves_every_handle(fake_input_peers):
    """Without a cache each source costs one resolve (the old
    behaviour — documents why the cache matters)."""
    client = FakeClient({
        "chanA": [_book_msg(105)],
        "chanB": [_book_msg(77)],
    })
    books, new_cursor, failed, resolve_flood = _run(run_check(
        client,
        [("channel", "chanA", ""), ("channel", "chanB", "")],
        {"chanA": 100, "chanB": 70},
        delay=0,
        cache=None,
    ))
    assert client.get_entity_calls == ["chanA", "chanB"]
    assert len(books) == 2
    assert resolve_flood is None


def test_run_check_seeds_cursor_from_newest_post(fake_input_peers):
    """A source with no cursor entry is seeded from its newest
    post id and nothing is indexed from it."""
    cache = _warm_cache(fake_input_peers, ["chanA"])
    client = FakeClient({"chanA": [_book_msg(105)]})
    books, new_cursor, failed, resolve_flood = _run(run_check(
        client,
        [("channel", "chanA", "")],
        {},
        delay=0,
        cache=cache,
    ))
    assert books == []
    assert new_cursor == {"chanA": 105}
    assert client.get_entity_calls == []


# --- resolve flood: stop the run, keep the partial results --------------

def test_run_check_stops_on_resolve_flood_wait(fake_input_peers):
    """A resolve flood wait is account-wide: the run STOPS
    immediately (chanC is never even resolved) instead of burning
    ~50 minutes source by source (run #632). The partial results
    collected so far are still returned."""
    client = FakeClient(
        {
            "chanA": [_book_msg(105)],
            "chanB": [_book_msg(77)],
            "chanC": [_book_msg(50)],
        },
        flood_on={"chanB"},
    )
    books, new_cursor, failed, resolve_flood = _run(run_check(
        client,
        [("channel", "chanA", ""), ("channel", "chanB", ""), ("channel", "chanC", "")],
        {"chanA": 100, "chanB": 70, "chanC": 40},
        delay=0,
        cache=None,
    ))
    assert isinstance(resolve_flood, ResolveFloodWait)
    assert resolve_flood.handle == "chanB"
    assert client.get_entity_calls == ["chanA", "chanB"]  # chanC untouched
    assert [b["title"] for b in books] == ["Dune"]  # chanA only
    assert new_cursor["chanA"] == 105
    # chanB/chanC keep their OLD cursor values — the flood stopped
    # the run before either was (re)checked.
    assert new_cursor["chanB"] == 70
    assert new_cursor["chanC"] == 40


# --- step 3: per-run monitoring -----------------------------------------

def test_write_summary_json_line_and_step_summary(tmp_path, monkeypatch, capsys):
    """The summary prints a machine-readable LIVE_SYNC_SUMMARY
    line and appends markdown to $GITHUB_STEP_SUMMARY."""
    summary_file = tmp_path / "step-summary.md"
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary_file))
    _write_summary(
        scan_run_id="123-20261124T000000Z",
        books=2,
        failed=["chanX"],
        total_sources=10,
        resolve_flood=None,
        batch="atomic",
        duration_s=42.5,
    )
    out = capsys.readouterr().out
    line = [ln for ln in out.splitlines() if ln.startswith("LIVE_SYNC_SUMMARY ")][0]
    data = json.loads(line[len("LIVE_SYNC_SUMMARY "):])
    assert data["scan_run_id"] == "123-20261124T000000Z"
    assert data["books"] == 2
    assert data["failed"] == 1
    assert data["batch"] == "atomic"
    assert data["flood_blind"] is False
    text = summary_file.read_text(encoding="utf-8")
    assert "## Live sync" in text
    assert "123-20261124T000000Z" in text
    assert "@chanX" in text
    assert "Flood-blind" not in text


def test_write_summary_flood_blind_warning(tmp_path, monkeypatch, capsys):
    """More than 30% of sources skipped = flood-blind: a
    ::warning:: annotation, a flood_blind flag in the JSON, and a
    warning block in the markdown — the run must not look green."""
    summary_file = tmp_path / "step-summary.md"
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary_file))
    _write_summary(
        scan_run_id="123-20261124T000000Z",
        books=0,
        failed=["a", "b", "c", "d"],
        total_sources=10,
        resolve_flood=None,
        batch="atomic",
        duration_s=300.0,
    )
    out = capsys.readouterr().out
    assert "::warning::live-sync flood-blind: 4/10 sources skipped" in out
    line = [ln for ln in out.splitlines() if ln.startswith("LIVE_SYNC_SUMMARY ")][0]
    assert json.loads(line[len("LIVE_SYNC_SUMMARY "):])["flood_blind"] is True
    assert "Flood-blind" in summary_file.read_text(encoding="utf-8")


def test_write_summary_without_actions_env_only_prints(capsys):
    """Outside GitHub Actions (no $GITHUB_STEP_SUMMARY) the file
    part is a no-op — the stdout line still prints."""
    _write_summary(
        scan_run_id="local-1",
        books=0,
        failed=[],
        total_sources=5,
        resolve_flood=None,
        batch="atomic",
        duration_s=1.0,
    )
    out = capsys.readouterr().out
    assert "LIVE_SYNC_SUMMARY " in out
    assert "Flood-blind" not in out


# --- scan_run_id ----------------------------------------------------------

def test_scan_run_id_uses_github_run_id(monkeypatch):
    monkeypatch.setenv("GITHUB_RUN_ID", "45200000001")
    rid = _scan_run_id()
    assert rid.startswith("45200000001-")
    assert rid.endswith("Z")


def test_scan_run_id_local_without_github_run_id(monkeypatch):
    monkeypatch.delenv("GITHUB_RUN_ID", raising=False)
    assert _scan_run_id().startswith("local-")
