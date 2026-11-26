"""Tests for the sync-fix v2 radical fixes (2026-11-24).

Covers, offline (fake Telethon client, no network, no credentials):
  * entity cache TTL / refresh-due / negative cache / resolve budget
    / D1 merge (tbi.entity_cache, tbi.d1_entities)
  * outbox: seq numbers, cursor pagination (no loss), replay,
    prune, file round-trip (tbi.outbox)
  * live window: merge-with-dropped + seq assignment (tbi.live)
  * session guard: distinct sessions, same-value refusal, DO lease
    (tbi.session_guard)
  * live_sync v2: budget skip, deadline partial push, resolve-flood
    stop with partial results, catch-up gap detection
    (tbi.live_sync.run_check_v2)
  * D1 write amplification: changed-only filter, UPDATE path,
    estimate (tbi.d1_sync)
  * session-env selection (tbi.api_history.load_api_credentials)

The pre-existing tests (test_live.py, test_live_sync.py,
test_entity_cache.py) keep passing unchanged — run_check keeps its
old 4-tuple interface; run_check_v2 is the new one.
"""

import asyncio
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tbi import d1_entities as d1e  # noqa: E402
from tbi import d1_sync as d1s  # noqa: E402
from tbi.api_history import load_api_credentials  # noqa: E402
from tbi.entity_cache import (  # noqa: E402
    DEFAULT_RESOLVE_BUDGET,
    EntityCache,
    ResolveBudget,
    ResolveBudgetExhausted,
    ResolveFloodWait,
    is_negative_cached,
    is_stale,
    refresh_entry,
    resolve_entity,
)
from tbi.live import assign_seq, merge_live_books_with_dropped  # noqa: E402
from tbi.live_sync import find_gaps, run_check_v2  # noqa: E402
from tbi.outbox import (  # noqa: E402
    enqueue,
    load_outbox_file,
    outbox_document,
    paginate_books,
    parse_outbox,
    prune_outbox,
    replay_outbox,
    save_outbox_file,
)
from tbi.session_guard import (  # noqa: E402
    EXIT_REFUSED,
    SessionRefused,
    acquire_lease,
    check_sessions_distinct,
    lease_is_live,
    lease_value,
    read_lease,
    release_lease,
)

NOW = datetime(2026, 11, 24, 12, 0, tzinfo=timezone.utc)


def _iso(days_ago=0):
    return (NOW - timedelta(days=days_ago)).isoformat()


def _entry(handle, days_ago=0, **extra):
    e = {
        "handle": handle,
        "id": 1000 + abs(hash(handle)) % 100000,
        "access_hash": 12345,
        "type": "channel",
        "resolved_at": _iso(days_ago),
    }
    e.update(extra)
    return e


# --- fakes (same seams as test_live_sync.py) ----------------------------

class _FloodWait(Exception):
    def __init__(self, seconds=0):
        super().__init__(f"flood wait {seconds}s")
        self.seconds = seconds


class FakeEntity:
    def __init__(self, handle):
        self.handle = handle
        self.id = 1000 + abs(hash(handle)) % 100000
        self.access_hash = 999


class FakeMessage:
    def __init__(self, pid, text="", filename=None):
        self.id = pid
        self.message = text
        self.file = _FakeFile(filename) if filename else None
        self.media = None
        self.date = datetime(2026, 11, 6, 10, 0, tzinfo=timezone.utc)


class _FakeFile:
    def __init__(self, name):
        self.name = name
        self.size = 1200000
        self.ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""


class FakeClient:
    def __init__(self, by_handle, *, flood_on=(), fail_on=()):
        self.by_handle = by_handle
        self.flood_on = set(flood_on)
        self.fail_on = set(fail_on)
        self.get_entity_calls: list[str] = []

    async def get_entity(self, handle):
        self.get_entity_calls.append(handle)
        if handle in self.flood_on:
            raise _FloodWait(seconds=3000)
        if handle in self.fail_on:
            raise ValueError("no such handle")
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
    by_id: dict[int, str] = {}

    def fake_channel(channel_id, access_hash):
        return FakeEntity(by_id[channel_id])

    def fake_chat(chat_id):
        return FakeEntity(by_id[chat_id])

    monkeypatch.setattr("tbi.entity_cache._input_channel", fake_channel)
    monkeypatch.setattr("tbi.entity_cache._input_peer_chat", fake_chat)
    return by_id


def _warm_cache(by_id, handles, days_ago=0):
    entries = {}
    for i, handle in enumerate(handles):
        channel_id = 1000 + i
        by_id[channel_id] = handle
        entries[handle.lower()] = {
            "handle": handle,
            "id": channel_id,
            "access_hash": 111 + i,
            "type": "channel",
            "resolved_at": _iso(days_ago),
        }
    return EntityCache(entries=entries)


def _run(coro):
    return asyncio.run(coro)


class FakeStore:
    """Minimal LiveStateStore double (get/put only)."""

    def __init__(self):
        self.data: dict[str, str] = {}

    def get(self, key):
        return self.data.get(key)

    def put(self, key, value):
        self.data[key] = value


# --- 1. entity cache: TTL, refresh-due, negative cache, budget ---------

def test_entry_stale_after_ttl():
    assert is_stale(_entry("a", days_ago=31), now=NOW) is True
    assert is_stale(_entry("a", days_ago=29), now=NOW) is False
    assert is_stale({"handle": "a"}, now=NOW) is True  # no timestamp


def test_refresh_due_is_oldest_first_and_capped():
    cache = EntityCache(entries={
        "a": _entry("a", days_ago=60),
        "b": _entry("b", days_ago=31),
        "c": _entry("c", days_ago=5),
        "d": _entry("d", days_ago=90),
    })
    assert cache.refresh_due(limit=2, now=NOW) == ["d", "a"]


def test_negative_cache_skips_recent_failure():
    entry = _entry("dead", failed_at=_iso(0), failures=2)
    assert is_negative_cached(entry, now=NOW) is True
    old = _entry("dead", failed_at=(NOW - timedelta(hours=25)).isoformat())
    assert is_negative_cached(old, now=NOW) is False


def test_record_failure_keeps_good_entry_and_marks_it():
    cache = EntityCache(entries={"a": _entry("a")})
    cache.record_failure("a", ValueError("gone"))
    kept = cache.lookup("a")
    assert kept["id"] == _entry("a")["id"]
    assert kept["failures"] == 1
    assert "failed_at" in kept


def test_resolve_budget_spends_and_exhausts():
    budget = ResolveBudget(2)
    assert budget.try_acquire() is True
    assert budget.try_acquire() is True
    assert budget.try_acquire() is False
    assert budget.exhausted is True
    assert budget.remaining == 0


def test_resolve_entity_budget_exhausted_skips_without_calling(fake_input_peers):
    cache = EntityCache(entries={})
    budget = ResolveBudget(0)
    client = FakeClient({})
    with pytest.raises(ResolveBudgetExhausted):
        _run(resolve_entity(client, "newhandle", cache, budget=budget))
    assert client.get_entity_calls == []


def test_resolve_entity_negative_cached_skips_without_calling(fake_input_peers):
    # failed_at must be RECENT in real time: resolve_entity checks the
    # negative cache against datetime.now(), not the module's fixed NOW
    # (a fixed 2026-11-24 timestamp ages past the 24h negative TTL and
    # the test starts failing a day later — time-bomb fixed 2026-11-25).
    cache = EntityCache(entries={
        "dead": _entry(
            "dead",
            failed_at=datetime.now(timezone.utc).isoformat(),
            failures=1,
        ),
    })
    client = FakeClient({})
    with pytest.raises(ResolveBudgetExhausted):
        _run(resolve_entity(client, "dead", cache))
    assert client.get_entity_calls == []


def test_resolve_entity_miss_spends_budget_and_stores(fake_input_peers):
    cache = EntityCache(entries={})
    budget = ResolveBudget(1)
    client = FakeClient({})
    entity, from_cache = _run(resolve_entity(client, "newone", cache, budget=budget))
    assert from_cache is False
    assert budget.remaining == 0
    assert cache.lookup("newone") is not None


def test_refresh_entry_forces_reresolve_even_when_cached(fake_input_peers):
    cache = _warm_cache(fake_input_peers, ["chanA"], days_ago=60)
    client = FakeClient({})
    entity, stored = _run(refresh_entry(client, "chanA", cache))
    assert client.get_entity_calls == ["chanA"]
    assert stored is True
    assert cache.lookup("chana")["resolved_at"] >= _iso(60)


def test_refresh_entry_flood_propagates_typed(fake_input_peers):
    cache = _warm_cache(fake_input_peers, ["chanA"], days_ago=60)
    client = FakeClient({}, flood_on={"chanA"})
    with pytest.raises(ResolveFloodWait):
        _run(refresh_entry(client, "chanA", cache))


def test_cache_merge_newer_wins_only():
    cache = EntityCache(entries={"a": _entry("a", days_ago=5)})
    incoming = {
        "a": _entry("a", days_ago=1),   # newer -> wins
        "b": _entry("b", days_ago=40),  # new -> added
        "c": {"handle": "c", "id": 0, "type": "unknown"},  # placeholder -> ignored
    }
    assert cache.merge(incoming) == 2
    assert cache.lookup("a")["resolved_at"] == _iso(1)
    assert cache.lookup("b") is not None
    assert cache.lookup("c") is None
    # A stale import must not roll the cache backwards.
    assert cache.merge({"a": _entry("a", days_ago=30)}) == 0
    assert cache.lookup("a")["resolved_at"] == _iso(1)


# --- 2. outbox: seq, pagination, replay, prune --------------------------

def _book(book_id, source="chanA", post_id=10, title="Dune"):
    return {"id": book_id, "title": title, "author": "Herbert",
            "source": source, "kind": "channel", "format": "EPUB",
            "filename": "Dune.epub", "post_id": post_id}


def test_enqueue_assigns_monotonic_seq_and_dedupes():
    out = enqueue([_book("a:1:epub"), _book("b:2:epub")], [], "run-1")
    assert [e["seq"] for e in out] == [1, 2]
    out2 = enqueue([_book("a:1:epub"), _book("c:3:epub")], out, "run-2")
    assert [e["seq"] for e in out2] == [1, 2, 3]
    assert out2[2]["book"]["id"] == "c:3:epub"


def test_paginate_books_is_lossless_over_600():
    books = [dict(_book(f"s:{i}:epub", post_id=i), seq=i) for i in range(1, 601)]
    seen = []
    after = 0
    pages = 0
    while True:
        page, after = paginate_books(books, after_seq=after, limit=100)
        seen.extend(b["id"] for b in page)
        pages += 1
        if after is None:
            break
    assert pages == 6
    assert len(seen) == 600
    assert len(set(seen)) == 600  # every book exactly once


def test_replay_is_idempotent_and_advances_cursor():
    entries = enqueue([_book("a:5:epub", post_id=5)], [], "run-1")
    books, cursor, remaining = replay_outbox(entries, [], {"chanA": 4})
    assert [b["id"] for b in books] == ["a:5:epub"]
    assert cursor == {"chanA": 5}
    assert len(remaining) == 1  # still needs a landing push
    # Second replay of the same entries after the cursor advanced:
    # the book is covered, so nothing is re-queued.
    books2, cursor2, remaining2 = replay_outbox(entries, books, cursor)
    assert books2 == books
    assert remaining2 == []


def test_prune_outbox_keeps_undated_and_drops_old():
    entries = [
        {"seq": 1, "enqueued_at": (NOW - timedelta(hours=49)).isoformat(),
         "book": _book("old:1:epub")},
        {"seq": 2, "enqueued_at": (NOW - timedelta(hours=1)).isoformat(),
         "book": _book("new:2:epub")},
        {"seq": 3, "book": _book("nodate:3:epub")},
    ]
    kept = prune_outbox(entries, now=NOW)
    assert [e["seq"] for e in kept] == [2, 3]


def test_outbox_file_round_trip_with_corrupt_line(tmp_path):
    path = tmp_path / "live-outbox.jsonl"
    entries = enqueue([_book("a:1:epub")], [], "run-1")
    save_outbox_file(path, entries)
    # Corrupt one line in the middle: replay must skip it, not die.
    text = path.read_text(encoding="utf-8")
    path.write_text(text + "{not json\n", encoding="utf-8")
    loaded = load_outbox_file(path)
    assert [e["seq"] for e in loaded] == [1]
    assert load_outbox_file(tmp_path / "missing.jsonl") == []
    assert parse_outbox(outbox_document(entries)) == entries
    assert parse_outbox("garbage") == []


# --- 3. live window: cap drops are reported, seq assigned ---------------

def test_merge_with_dropped_reports_what_the_cap_loses():
    old = [dict(_book(f"o:{i}:epub"), seq=i) for i in range(5)]
    new = [_book("n:1:epub")]
    merged, dropped = merge_live_books_with_dropped(old, new, max_books=5)
    assert len(merged) == 5
    assert [d["id"] for d in dropped] == ["o:4:epub"]
    assert merged[0]["id"] == "n:1:epub"


def test_assign_seq_never_renumbers_replayed_books():
    books = [_book("a:1:epub"), dict(_book("b:2:epub"), seq=99)]
    numbered = assign_seq(books, 10)
    assert numbered[0]["seq"] == 10
    assert numbered[1]["seq"] == 99  # kept


# --- 4. session guard ----------------------------------------------------

def test_sessions_distinct_selects_news_when_set():
    env = {"TELEGRAM_SESSION_STRING": "AAA",
           "TELEGRAM_SESSION_STRING_NEWS": "BBB"}
    assert check_sessions_distinct(env) == "TELEGRAM_SESSION_STRING_NEWS"


def test_sessions_distinct_falls_back_to_main_when_news_missing():
    assert check_sessions_distinct({"TELEGRAM_SESSION_STRING": "AAA"}) \
        == "TELEGRAM_SESSION_STRING"


def test_same_session_value_in_both_roles_is_refused():
    env = {"TELEGRAM_SESSION_STRING": "SAME",
           "TELEGRAM_SESSION_STRING_NEWS": "SAME"}
    with pytest.raises(SessionRefused):
        check_sessions_distinct(env)


def test_lease_acquire_refuse_expire_release():
    store = FakeStore()
    value = acquire_lease(store, "realtime", "run-1", ttl_seconds=900)
    assert value["holder"] == "realtime"
    assert lease_is_live(read_lease(store)) is True
    with pytest.raises(SessionRefused):
        acquire_lease(store, "newspapers", "run-2")
    # Another run's release must not free our lease.
    assert release_lease(store, "run-2") is False
    assert lease_is_live(read_lease(store)) is True
    assert release_lease(store, "run-1") is True
    assert lease_is_live(read_lease(store)) is False
    # An expired lease never blocks the next run.
    store.put("live:lease", json.dumps(lease_value(
        "realtime", "run-old", ttl_seconds=-60)))
    assert lease_is_live(read_lease(store)) is False
    acquire_lease(store, "realtime", "run-3")
    assert read_lease(store)["run_id"] == "run-3"


def test_load_api_credentials_selects_session_env():
    env = {"TELEGRAM_API_ID": "123", "TELEGRAM_API_HASH": "h",
           "TELEGRAM_SESSION_STRING": "MAIN",
           "TELEGRAM_SESSION_STRING_NEWS": "NEWS"}
    _, _, session = load_api_credentials(
        env, session_env="TELEGRAM_SESSION_STRING_NEWS")
    assert session == "NEWS"
    _, _, session2 = load_api_credentials(env)
    assert session2 == "MAIN"


# --- 5. live_sync v2: budget, deadline, flood, catch-up -----------------

def test_run_check_v2_budget_skip_keeps_cursor(fake_input_peers):
    """Past the resolve budget a source is SKIPPED (not resolved,
    cursor kept) — the run finishes instead of flooding."""
    cache = EntityCache(entries={})  # every handle is a miss
    budget = ResolveBudget(1)
    client = FakeClient({
        "chanA": [FakeMessage(105, filename="Dune - Frank Herbert.epub")],
        "chanB": [FakeMessage(77, filename="Dune - Frank Herbert.pdf")],
        "chanC": [FakeMessage(9, filename="Dune - Frank Herbert.epub")],
    })
    result = _run(run_check_v2(
        client,
        [("channel", "chanA", ""), ("channel", "chanB", ""),
         ("channel", "chanC", "")],
        {"chanA": 100, "chanB": 70, "chanC": 5},
        delay=0, cache=cache, budget=budget,
    ))
    assert client.get_entity_calls == ["chanA"]  # only the budget
    assert result.budget_skipped == ["chanB", "chanC"]
    assert result.cursor["chanB"] == 70  # kept, not advanced
    assert result.cursor["chanC"] == 5
    assert result.resolve_flood is None


def test_run_check_v2_stops_on_resolve_flood_with_partial_results(fake_input_peers):
    cache = _warm_cache(fake_input_peers, ["chanA"])
    client = FakeClient(
        {"chanA": [FakeMessage(105, filename="Dune - Frank Herbert.epub")]},
        flood_on={"chanB"},
    )
    # chanB is uncached: its resolve floods. chanA's book must
    # still be in the partial results.
    result = _run(run_check_v2(
        client,
        [("channel", "chanA", ""), ("channel", "chanB", ""),
         ("channel", "chanC", "")],
        {"chanA": 100, "chanB": 70, "chanC": 5},
        delay=0, cache=cache, budget=ResolveBudget(8),
    ))
    assert len(result.books) == 1
    assert result.resolve_flood is not None
    assert result.failed == ["chanB"]
    assert "chanC" not in result.failed  # never attempted
    assert client.get_entity_calls == ["chanB"]


def test_run_check_v2_deadline_returns_partial_results(fake_input_peers):
    cache = _warm_cache(fake_input_peers, ["chanA", "chanB", "chanC"])
    client = FakeClient({
        "chanA": [FakeMessage(105, filename="Dune - Frank Herbert.epub")],
        "chanB": [FakeMessage(77, filename="Dune - Frank Herbert.pdf")],
        "chanC": [FakeMessage(9, filename="Dune - Frank Herbert.epub")],
    })
    # Fake the clock: run starts at t=0, the second iteration top
    # sees t=100 — past the 10 s deadline — so the scan stops
    # AFTER chanA's book, with its partial results intact.
    times = iter([0.0, 0.0, 100.0])  # started, 1st check, 2nd check

    def fake_clock():
        return next(times, 100.0)

    result = _run(run_check_v2(
        client,
        [("channel", "chanA", ""), ("channel", "chanB", ""),
         ("channel", "chanC", "")],
        {"chanA": 100, "chanB": 70, "chanC": 5},
        delay=0, cache=cache, deadline_s=10, clock=fake_clock,
    ))
    assert result.deadline_hit is True
    assert result.sources_checked == 1
    assert len(result.books) == 1
    assert result.cursor["chanA"] == 105
    assert result.cursor["chanB"] == 70  # untouched, kept for next run


def test_run_check_v2_zero_deadline_stops_before_first_source(fake_input_peers):
    cache = _warm_cache(fake_input_peers, ["chanA"])
    client = FakeClient({
        "chanA": [FakeMessage(105, filename="Dune - Frank Herbert.epub")],
    })
    result = _run(run_check_v2(
        client, [("channel", "chanA", "")], {"chanA": 100},
        delay=0, cache=cache, deadline_s=0,
    ))
    assert result.deadline_hit is True
    assert result.sources_checked == 0
    assert result.books == []


def test_refresh_stale_entries_uses_leftover_budget_only(fake_input_peers):
    from tbi.live_sync import refresh_stale_entries

    cache = _warm_cache(fake_input_peers, ["chanA", "chanB"], days_ago=60)
    budget = ResolveBudget(1)
    client = FakeClient({})
    refreshed, failed = _run(refresh_stale_entries(client, cache, budget))
    assert refreshed == 1
    assert failed == []
    assert budget.remaining == 0
    assert client.get_entity_calls == ["chanA"]  # budget 1: only the first due entry


def test_refresh_stale_entries_flood_propagates(fake_input_peers):
    from tbi.live_sync import refresh_stale_entries

    cache = _warm_cache(fake_input_peers, ["chanA"], days_ago=60)
    budget = ResolveBudget(5)
    client = FakeClient({}, flood_on={"chanA"})
    with pytest.raises(ResolveFloodWait):
        _run(refresh_stale_entries(client, cache, budget))


def test_find_gaps_reads_last_scan_failed_handles():
    targets = [("channel", "a", ""), ("channel", "b", ""),
               ("channel", "c", "")]
    last_scan = {"scan_run_id": "r1", "failed_handles": ["b", "zzz"]}
    assert find_gaps(last_scan, {"a": 1}, targets) == ["b"]
    assert find_gaps(None, {}, targets) == []
    assert find_gaps({}, {}, targets) == []


# --- 6. D1: changed-only, UPDATE path, estimate --------------------------

def _d1book(**kw):
    b = {"title": "Dune", "author": "Frank Herbert", "ext": "epub",
         "size": "1.2 MB", "date": "2026-11-20", "url": "https://t.me/a/5",
         "filename": "Dune.epub", "source": "a", "kind": "channel"}
    b.update(kw)
    return b


def test_content_hash_changes_with_title_only():
    a = _d1book()
    assert d1s.content_hash(a) == d1s.content_hash(_d1book())
    assert d1s.content_hash(a) != d1s.content_hash(_d1book(title="Dune 2"))


def test_filter_changed_splits_new_changed_skipped():
    state = {d1s.state_key(_d1book()): d1s.content_hash(_d1book())}
    books = [_d1book(),  # unchanged -> skipped
             _d1book(title="Dune 2"),  # same key, new hash -> changed
             _d1book(url="https://t.me/a/6", filename="Other.epub")]  # new
    new, changed, skipped = d1s.filter_changed(books, state)
    assert len(new) == 1 and len(changed) == 1 and skipped == 1
    # A v1 state (key only, hash unknown) never reports a change.
    new2, changed2, skipped2 = d1s.filter_changed(
        [_d1book()], {d1s.state_key(_d1book()): None})
    assert (new2, changed2, skipped2) == ([], [], 1)


def test_update_sql_updates_in_place_and_rebuilds_fts():
    sql = d1s.update_sql(_d1book(title="Dune 2"))
    assert "UPDATE books SET" in sql
    assert "DELETE FROM books_fts" in sql
    assert "INSERT OR IGNORE INTO books_fts" in sql
    assert "Dune 2" in sql


def test_batch_sql_with_changed_consumes_no_new_ids():
    sql, next_id = d1s.batch_sql([_d1book(url="https://t.me/a/6")],
                                 start_id=100,
                                 changed=[_d1book(title="Dune 2")])
    assert next_id == 101  # the changed book took no id
    assert sql.count("UPDATE books SET") == 1


def test_estimate_row_writes_range_and_budget():
    low, high = d1s.estimate_row_writes(5000)
    assert low == 10000  # 2 direct rows/book
    assert high == 50000  # + 8 shadow rows/book at the high end
    assert low <= d1s.D1_DAILY_ROW_BUDGET
    # 50,000 books: the low end fits the budget, the high end does
    # not — which is exactly why the estimate is printed.
    low50, high50 = d1s.estimate_row_writes(50000)
    assert low50 == 100000
    assert high50 > d1s.D1_DAILY_ROW_BUDGET


def test_load_state_reads_v1_and_v2(tmp_path):
    p = tmp_path / "state.txt"
    p.write_text("https://t.me/a/5|Dune.epub\tabc123\n"
                 "https://t.me/a/6|Other.epub\n", encoding="utf-8")
    state = d1s.load_state(p)
    assert state["https://t.me/a/5|Dune.epub"] == "abc123"
    assert state["https://t.me/a/6|Other.epub"] is None


# --- 7. D1 entities: export / import --------------------------------------

def test_entities_export_skips_placeholders_and_is_deterministic():
    cache = EntityCache(entries={
        "b": _entry("b"),
        "a": _entry("a"),
        "dead": {"handle": "dead", "id": 0, "type": "unknown"},
    })
    sql = d1e.export_sql(cache)
    assert sql.count("INSERT INTO entities") == 2
    assert "'dead'" not in sql
    assert sql.index("'a'") < sql.index("'b'")  # sorted
    assert "ON CONFLICT(handle) DO UPDATE" in sql


def test_entities_parse_d1_json_both_shapes():
    rows = [{"handle": "ebook_library", "display_handle": "EBook_Library",
             "channel_id": 1370655968, "access_hash": 5,
             "type": "channel", "resolved_at": _iso(2)},
            {"handle": "bad", "channel_id": 0},
            {"handle": "nope"}]
    wrapped = [{"results": rows, "success": True, "meta": {}}]
    parsed = d1e.parse_d1_json(wrapped)
    assert list(parsed) == ["ebook_library"]
    assert parsed["ebook_library"]["id"] == 1370655968
    assert d1e.parse_d1_json(rows) == parsed  # bare list also works
    assert d1e.parse_d1_json({"nonsense": 1}) == {}


def test_entities_import_merges_newer_only(tmp_path):
    cache_path = tmp_path / "entity-cache.json"
    cache = EntityCache(path=str(cache_path),
                        entries={"a": _entry("a", days_ago=5)})
    cache.save()
    data = [{"results": [
        {"handle": "a", "display_handle": "a", "channel_id": 555,
         "access_hash": 1, "type": "channel",
         "resolved_at": _iso(1)},
        {"handle": "b", "display_handle": "b", "channel_id": 777,
         "access_hash": 2, "type": "channel",
         "resolved_at": _iso(1)},
    ]}]
    changed = EntityCache.load(str(cache_path)).merge(d1e.parse_d1_json(data))
    assert changed == 2  # 'a' updated (newer), 'b' added
    reloaded = EntityCache.load(str(cache_path))
    assert reloaded.lookup("a")["id"] == 555
    assert reloaded.lookup("b")["id"] == 777


def test_exit_refused_is_distinct_from_failure():
    assert EXIT_REFUSED == 3
    assert DEFAULT_RESOLVE_BUDGET == 8


# --- 8. newspapers: dedicated NEWS session + lease wrapper -------------

def test_news_credentials_use_news_session_when_set(monkeypatch):
    from tbi import newspapers as np

    env = {"TELEGRAM_API_ID": "123", "TELEGRAM_API_HASH": "h",
           "TELEGRAM_SESSION_STRING": "MAIN",
           "TELEGRAM_SESSION_STRING_NEWS": "NEWS"}
    _, _, session = np._load_news_credentials(env)
    assert session == "NEWS"


def test_news_credentials_fall_back_to_shared_session_loudly(monkeypatch, capsys):
    from tbi import newspapers as np

    env = {"TELEGRAM_API_ID": "123", "TELEGRAM_API_HASH": "h",
           "TELEGRAM_SESSION_STRING": "MAIN"}
    _, _, session = np._load_news_credentials(env)
    assert session == "MAIN"  # transition fallback (NEWS not created yet)
    assert "TELEGRAM_SESSION_STRING_NEWS is not set" in capsys.readouterr().out


def test_news_credentials_refuse_same_value_in_both(monkeypatch):
    from tbi import newspapers as np

    env = {"TELEGRAM_API_ID": "123", "TELEGRAM_API_HASH": "h",
           "TELEGRAM_SESSION_STRING": "SAME",
           "TELEGRAM_SESSION_STRING_NEWS": "SAME"}
    with pytest.raises(SessionRefused):
        np._load_news_credentials(env)


def test_news_lease_skipped_without_live_sync_token(monkeypatch):
    from tbi import newspapers as np

    monkeypatch.delenv("LIVE_SYNC_TOKEN", raising=False)
    assert np._acquire_news_lease() == (None, None, False)


def test_news_lease_refuses_same_session_value(monkeypatch):
    from tbi import newspapers as np

    monkeypatch.setenv("LIVE_SYNC_TOKEN", "tok")
    monkeypatch.setenv("TELEGRAM_SESSION_STRING", "SAME")
    monkeypatch.setenv("TELEGRAM_SESSION_STRING_NEWS", "SAME")
    with pytest.raises(SessionRefused):
        np._acquire_news_lease()
