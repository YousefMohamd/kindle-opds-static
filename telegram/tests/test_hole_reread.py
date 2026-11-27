"""Tests for tbi.hole_reread (Nov 19-23 hole re-read).

Offline only: a fake Telethon client + fake messages, a fake DO
store, and a tiny config file. No network, no secrets, no live
state. Run from the hole dir:

    cd ~/workspace/tmp-fox/nov19-23-hole
    PYTHONPATH=~/workspace/tmp-fox/sync-fix/repo/telegram:. \
      ~/workspace/tmp-fox/newest-fix/stage/.venv/bin/python \
      -m pytest test_hole_reread.py -q

(The stage venv has telethon + pytest; system python3 has neither.)
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from tbi.hole_reread import (  # noqa: E402
    LeaseUnavailable,
    SessionRefused,
    acquire_or_refuse,
    dedupe_books,
    in_window,
    livebook_to_catalog,
    reread_source,
    window_date,
    main,
)
from tbi.session_guard import EXIT_SKIPPED  # noqa: E402
from tbi.d1_sync import batch_sql, state_key  # noqa: E402
from tbi.scrape import Post, FileMeta  # noqa: E402

START = datetime(2026, 11, 19, tzinfo=timezone.utc)
END = datetime(2026, 11, 24, 7, 40, 28, tzinfo=timezone.utc)


def post(handle, pid, iso_date, filename=None, text=""):
    files = [FileMeta(filename=filename, size_text="1.0 MB", size_bytes=1000)] \
        if filename else []
    return Post(channel=handle, post_id=pid, date=iso_date, text=text,
                url=f"https://t.me/{handle}/{pid}", files=files)


# --- pure helpers -------------------------------------------------------

def test_window_date_truncates_iso_to_day():
    assert window_date("2026-11-21T13:10:00+00:00") == "2026-11-21"
    assert window_date("2026-11-19T00:00:00Z") == "2026-11-19"
    assert window_date(None) is None
    assert window_date("garbage") is None
    assert window_date("") is None


def test_in_window_bounds():
    assert in_window("2026-11-19T00:00:00+00:00", START, END) is True
    assert in_window("2026-11-23T23:59:59+00:00", START, END) is True
    assert in_window("2026-11-18T23:59:59+00:00", START, END) is False
    assert in_window("2026-11-24T07:40:28+00:00", START, END) is False
    assert in_window("2026-11-24T07:40:27+00:00", START, END) is True
    assert in_window(None, START, END) is False
    assert in_window("garbage", START, END) is False


def test_livebook_to_catalog_mapping():
    book = {
        "title": "Chainsaw Man Vol 5", "author": "Tatsuki Fujimoto",
        "source": "bookpdfepub", "kind": "group", "format": "PDF",
        "filename": "Chainsaw Man Vol 5.pdf", "size_text": "37.5 MB",
        "size_bytes": 37500000, "url": "https://t.me/bookpdfepub/616650",
        "post_id": 616650, "date": "2026-11-26T10:31:13+00:00",
    }
    cat = livebook_to_catalog(book)
    assert cat == {
        "title": "Chainsaw Man Vol 5", "author": "Tatsuki Fujimoto",
        "filename": "Chainsaw Man Vol 5.pdf", "ext": "pdf",
        "size": "37.5 MB", "source": "bookpdfepub", "kind": "group",
        "date": "2026-11-26", "url": "https://t.me/bookpdfepub/616650",
    }


def test_dedupe_books_drops_within_run_and_existing():
    b1 = {"title": "A", "author": "", "source": "s", "kind": "channel",
          "format": "PDF", "filename": "a.pdf", "size_text": "1 MB",
          "url": "https://t.me/s/1", "post_id": 1, "date": "2026-11-20T00:00:00+00:00"}
    b2 = dict(b1, url="https://t.me/s/2", post_id=2, filename="b.pdf")
    b3 = dict(b1)  # exact duplicate of b1 (same url+filename)
    kept, dropped = dedupe_books([b1, b2, b3], set())
    assert [b["url"] for b in kept] == ["https://t.me/s/1", "https://t.me/s/2"]
    assert dropped == 1
    kept2, dropped2 = dedupe_books(
        [b1, b2], {state_key(livebook_to_catalog(b1))})
    assert [b["url"] for b in kept2] == ["https://t.me/s/2"]
    assert dropped2 == 1


# --- reread_source with a fake iterator ---------------------------------

def fake_iter_factory(posts_by_handle):
    """Build an iter_posts callable yielding canned Posts per handle,
    newest -> oldest, honouring start_before + limit like the real
    reader (but without any Telethon)."""
    async def fake_iter(client, handle, *, cache=None, budget=None,
                        limit=None, start_before=None, **kw):
        posts = posts_by_handle.get(handle, [])
        n = 0
        for p in posts:
            if start_before is not None and p.post_id >= start_before:
                continue
            yield p
            n += 1
            if limit is not None and n >= limit:
                return
    return fake_iter


class FakeClient:
    def __init__(self):
        self.connected = False
    async def connect(self):
        self.connected = True
    async def disconnect(self):
        self.connected = False
    async def is_user_authorized(self):
        return True


def test_reread_source_window_and_break():
    posts = [
        post("h", 300, "2026-11-24T07:00:00+00:00", "new.pdf"),   # in window
        post("h", 299, "2026-11-20T12:00:00+00:00", "mid.epub"),  # in window
        post("h", 298, "2026-11-19T00:00:00+00:00", "edge.mobi"), # in window (start)
        post("h", 297, "2026-11-18T23:59:00+00:00", "old.pdf"),   # before start -> break
        post("h", 296, "2026-11-17T00:00:00+00:00", "older.pdf"), # never reached
    ]
    books, status = asyncio.run(reread_source(
        FakeClient(), "h", "channel", 301, START, END,
        iter_posts=fake_iter_factory({"h": posts})))
    assert [b["filename"] for b in books] == ["new.pdf", "mid.epub", "edge.mobi"]
    assert status["posts_seen"] == 4
    assert status["in_window"] == 3
    assert status["stopped_at_start"] is True
    assert status["books"] == 3


def test_reread_source_skips_after_end_and_no_date():
    posts = [
        post("h", 300, "2026-11-25T00:00:00+00:00", "future.pdf"),  # >= end: skip
        post("h", 299, "2026-11-20T00:00:00+00:00"),                # no files
        post("h", 298, None, "nodate.pdf"),                         # no date: skip
        post("h", 297, "2026-11-19T05:00:00+00:00", "ok.pdf"),      # in window
    ]
    books, status = asyncio.run(reread_source(
        FakeClient(), "h", "group", 301, START, END,
        iter_posts=fake_iter_factory({"h": posts})))
    assert [b["filename"] for b in books] == ["ok.pdf"]
    assert status["in_window"] == 2  # future skipped, no-file post counted
    assert status["skipped_no_date"] == 1


def test_reread_source_non_book_ext_filtered():
    posts = [post("h", 300, "2026-11-20T00:00:00+00:00", "song.mp3")]
    books, status = asyncio.run(reread_source(
        FakeClient(), "h", "channel", 301, START, END,
        iter_posts=fake_iter_factory({"h": posts})))
    assert books == []
    assert status["in_window"] == 1
    assert status["books"] == 0


# --- lease: fail-closed ---------------------------------------------------

class FakeStore:
    """Dict-backed LiveStateStore double."""
    def __init__(self, initial=None, put_raises=None):
        self.data = dict(initial or {})
        self.put_raises = put_raises
        self.puts = []
    def get(self, key):
        return self.data.get(key)
    def put(self, key, value):
        self.puts.append(key)
        if self.put_raises is not None:
            raise self.put_raises
        self.data[key] = value


def test_acquire_or_refuse_ok_and_release():
    from tbi.session_guard import release_lease
    store = FakeStore()
    lease = acquire_or_refuse(store, "hole-reread", "run-1", 60)
    assert lease["holder"] == "hole-reread"
    assert release_lease(store, "run-1") is True


def test_acquire_or_refuse_live_lease_is_session_refused():
    store = FakeStore()
    acquire_or_refuse(store, "realtime", "run-0", 900)
    with pytest.raises(SessionRefused):
        acquire_or_refuse(store, "hole-reread", "run-1", 60)


def test_acquire_or_refuse_worker_400_is_lease_unavailable():
    # Worker rejects the key (companion patch missing): fail CLOSED.
    store = FakeStore(put_raises=RuntimeError("live-state PUT live:lease: HTTP 400"))
    with pytest.raises(LeaseUnavailable):
        acquire_or_refuse(store, "hole-reread", "run-1", 60)


# --- batch SQL: idempotent by (url, filename) ------------------------------

def test_batch_sql_idempotent_on_rerun():
    cat = [{
        "title": "A", "author": "", "filename": "a.pdf", "ext": "pdf",
        "size": "1 MB", "source": "s", "kind": "channel",
        "date": "2026-11-20", "url": "https://t.me/s/1",
    }]
    con = sqlite3.connect(":memory:")
    con.execute("CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT NOT NULL,"
                " author TEXT NOT NULL DEFAULT '', source TEXT NOT NULL,"
                " kind TEXT NOT NULL DEFAULT 'channel', ext TEXT NOT NULL DEFAULT '',"
                " size TEXT NOT NULL DEFAULT '', date TEXT NOT NULL DEFAULT '',"
                " url TEXT NOT NULL, filename TEXT NOT NULL DEFAULT '',"
                " UNIQUE(url, filename))")
    con.execute("CREATE VIRTUAL TABLE books_fts USING fts5(title, author)")
    sql, _ = batch_sql(cat, 422851)
    con.executescript(sql)
    con.executescript(sql)  # second run: INSERT OR IGNORE must add nothing
    n = con.execute("SELECT COUNT(*) FROM books").fetchone()[0]
    assert n == 1
    fts = con.execute("SELECT COUNT(*) FROM books_fts").fetchone()[0]
    assert fts == 1


# --- main(): end-to-end offline -------------------------------------------

def _write_test_config(tmp_path):
    cfg = tmp_path / "channels.yaml"
    cfg.write_text(
        "channels:\n"
        "  - https://t.me/chanA\n"
        "  - https://t.me/chanB\n"
        "groups:\n"
        "  - name: groupC\n"
        "settings:\n"
        "  db: index.db\n",
        encoding="utf-8",
    )
    return cfg


def test_main_dry_run_writes_artifacts_and_never_touches_live(monkeypatch, tmp_path):
    import os
    cfg = _write_test_config(tmp_path)
    posts = {
        "chanA": [post("chanA", 50, "2026-11-20T10:00:00+00:00", "a.pdf"),
                  post("chanA", 49, "2026-11-18T10:00:00+00:00", "old.pdf")],
        "chanB": [post("chanB", 70, "2026-11-21T10:00:00+00:00", "b.epub")],
        "groupC": [post("groupC", 90, "2026-11-22T10:00:00+00:00", "c.mobi")],
    }
    cursor = {"chanA": 51, "chanB": 71, "groupC": 91}
    store = FakeStore({
        "live:cursor": json.dumps(cursor),
        "live:additions": json.dumps({"since": "2026-11-19T21:15:14Z", "books": []}),
    })
    monkeypatch.setenv("TELEGRAM_API_ID", "1")
    monkeypatch.setenv("TELEGRAM_API_HASH", "dummy-hash")
    monkeypatch.setenv("TELEGRAM_SESSION_STRING", "dummy-session")
    out = tmp_path / "hole-out"
    code = main([
        "--config", str(cfg), "--start-id", "422851",
        "--out-dir", str(out), "--lease-ttl", "60",
    ], _client=FakeClient(), _store=store,
        _iter_posts=fake_iter_factory(posts))
    assert code == 0
    # Artifacts exist; 3 books recovered (old.pdf is before the window).
    counts = json.loads((out / "counts.json").read_text())
    assert counts["books_recovered"] == 3
    assert counts["per_date"] == {"2026-11-20": 1, "2026-11-21": 1, "2026-11-22": 1}
    assert counts["sources_done"] == 3
    sql = (out / "hole-batch-001.sql").read_text()
    assert "INSERT OR IGNORE INTO books" in sql
    assert "422851" in sql and "422853" in sql
    assert "2026-11-20" in sql
    # The script NEVER wrote live:additions or live:cursor — only the lease.
    assert store.puts == ["live:lease", "live:lease"]  # acquire + release
    assert json.loads(store.get("live:cursor")) == cursor
    assert json.loads(store.get("live:additions"))["books"] == []


def test_main_refuses_when_lease_held(monkeypatch, tmp_path):
    cfg = _write_test_config(tmp_path)
    store = FakeStore()
    acquire_or_refuse(store, "realtime", "other-run", 900)
    monkeypatch.setenv("TELEGRAM_API_ID", "1")
    monkeypatch.setenv("TELEGRAM_API_HASH", "dummy-hash")
    monkeypatch.setenv("TELEGRAM_SESSION_STRING", "dummy-session")
    code = main([
        "--config", str(cfg), "--start-id", "422851",
        "--out-dir", str(tmp_path / "out"), "--lease-ttl", "60",
    ], _client=FakeClient(), _store=store,
        _iter_posts=fake_iter_factory({}))
    assert code == EXIT_SKIPPED  # lease-held skip: quiet success, do not run


def test_main_fail_closed_when_lease_key_rejected(monkeypatch, tmp_path):
    cfg = _write_test_config(tmp_path)
    store = FakeStore(put_raises=RuntimeError("HTTP 400: bad key"))
    monkeypatch.setenv("TELEGRAM_API_ID", "1")
    monkeypatch.setenv("TELEGRAM_API_HASH", "dummy-hash")
    monkeypatch.setenv("TELEGRAM_SESSION_STRING", "dummy-session")
    code = main([
        "--config", str(cfg), "--start-id", "422851",
        "--out-dir", str(tmp_path / "out"), "--lease-ttl", "60",
    ], _client=FakeClient(), _store=store,
        _iter_posts=fake_iter_factory({}))
    assert code == 2  # fail-closed, never proceeds unguarded
