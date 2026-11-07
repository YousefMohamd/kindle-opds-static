"""Tests for the persistent entity cache (v0.4.8).

The 2026-11-07 api-backfill run failed in 24 seconds: EVERY source
failed with ``A wait of 71998 seconds is required (caused by
ResolveUsernameRequest)`` — a ~20-hour flood wait, because every API
run resolved ALL 211 handles (each GitHub Actions run starts with an
empty Telethon entity cache). The cache (``entity-cache.json``,
committed to the repo) maps each handle to the id + access hash +
type it resolved to, so each handle is resolved ONCE and later runs
reuse the cached peer without any resolve call.

Everything here is offline: fake Telethon clients (duck-typed)
stand in for the real one, so no network and no credentials are
needed — and Telethon itself is never imported, except in the one
importorskip test that verifies the real input-peer factories build.
"""

import asyncio
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tbi import cli as cli_mod  # noqa: E402
from tbi import join_groups as jg  # noqa: E402
from tbi.api_history import iter_api_posts  # noqa: E402
from tbi.cli import main  # noqa: E402
from tbi.config import load_config  # noqa: E402
from tbi.entity_cache import (  # noqa: E402
    DEFAULT_ENTITY_CACHE,
    EntityCache,
    ResolveFloodWait,
    resolve_entity,
)

FOLDER = "📚كتب"
NOW = datetime(2026, 11, 7, 21, 0, tzinfo=timezone.utc)

# Stand-ins for Telethon errors: only the class NAME matters (the
# cache duck-types on it, the same seam iter_api_posts uses for
# FloodWaitError's .seconds).
ChannelInvalidError = type("ChannelInvalidError", (Exception,), {})


class _FloodWait(Exception):
    """Stand-in for Telethon's FloodWaitError (only `.seconds` matters)."""

    def __init__(self, seconds=0):
        super().__init__(f"flood wait {seconds}s")
        self.seconds = seconds


class FakeEntity:
    """A channel/group entity with a usable id + access hash."""

    def __init__(self, handle, entity_id, access_hash=None):
        self.handle = handle
        self.id = entity_id
        self.access_hash = (
            access_hash if access_hash is not None else 1000 + entity_id
        )


class FakeMessage:
    def __init__(self, pid, text=""):
        self.id = pid
        self.message = text
        self.file = None
        self.media = None
        self.date = datetime(2026, 11, 6, 10, 0, tzinfo=timezone.utc)


class FakeApiClient:
    """Duck-typed stand-in for a Telethon client (backfill path)."""

    def __init__(
        self,
        messages,
        *,
        entities=None,
        flood_wait_on_resolve=None,
        invalid_first_iter=False,
        user_handles=(),
    ):
        self._messages = sorted(messages, key=lambda m: m.id, reverse=True)
        self.entities = dict(entities or {})
        self.flood_wait_on_resolve = flood_wait_on_resolve
        self.invalid_first_iter = invalid_first_iter
        self._invalid_raised = False
        self.user_handles = set(user_handles)
        self.resolve_calls = []  # handles get_entity was called for
        self.started = False
        self.disconnected = False

    async def start(self):
        self.started = True

    async def disconnect(self):
        self.disconnected = True

    async def get_entity(self, handle):
        self.resolve_calls.append(handle)
        if (
            self.flood_wait_on_resolve is not None
            and handle == self.flood_wait_on_resolve
        ):
            raise _FloodWait(seconds=71998)
        if handle in self.user_handles:
            return type("User", (), {})()
        if handle not in self.entities:
            raise ValueError(
                f"Cannot find any entity corresponding to '{handle}'"
            )
        return self.entities[handle]

    async def iter_messages(self, entity, offset_id=0, limit=None):
        if self.invalid_first_iter and not self._invalid_raised:
            self._invalid_raised = True
            raise ChannelInvalidError("The channel is invalid")
        offset_id = max(offset_id, 0)
        msgs = [m for m in self._messages if offset_id == 0 or m.id < offset_id]
        if limit is not None:
            msgs = msgs[:limit]
        for m in msgs:
            yield m


@pytest.fixture
def fake_input_peers(monkeypatch):
    """Monkeypatch the lazy Telethon input-peer factories to
    duck-typed stand-ins, so the cache tests never import Telethon
    (the real factories are covered by test_real_input_peer_factories
    below, with importorskip)."""
    monkeypatch.setattr(
        "tbi.entity_cache._input_channel",
        lambda channel_id, access_hash: SimpleNamespace(
            kind="input_channel", channel_id=channel_id,
            access_hash=access_hash,
        ),
    )
    monkeypatch.setattr(
        "tbi.entity_cache._input_peer_chat",
        lambda chat_id: SimpleNamespace(kind="input_peer_chat", chat_id=chat_id),
    )


def _drain(coro_gen):
    async def _collect():
        return [p async for p in coro_gen]

    return asyncio.run(_collect())


def _cache(tmp_path, entries=None):
    """An EntityCache backed by a tmp file (save() writes there)."""
    cache = EntityCache(tmp_path / "entity-cache.json")
    for handle, entity in (entries or {}).items():
        cache.store(handle, entity)
    return cache


# --- the cache itself: load / store / round-trip ---------------------------

def test_cache_round_trips(tmp_path):
    """(f) save -> load -> the same entries (id, access hash, type,
    handle, timestamp)."""
    path = tmp_path / "entity-cache.json"
    cache = EntityCache(path)
    cache.store("testchan", FakeEntity("testchan", 123, 456))
    cache.store("EBook_Library", FakeEntity("EBook_Library", 789, 101112))
    assert len(cache) == 2
    loaded = EntityCache.load(path)
    assert len(loaded) == 2
    entry = loaded.lookup("testchan")
    assert entry["id"] == 123
    assert entry["access_hash"] == 456
    assert entry["type"] == "channel"
    assert entry["handle"] == "testchan"
    assert entry["resolved_at"]
    # Lookups are case-insensitive (Telegram usernames are).
    assert loaded.lookup("TESTCHAN")["id"] == 123
    assert loaded.lookup("ebook_library")["id"] == 789
    assert loaded.lookup("nope") is None


def test_cache_missing_file_loads_empty(tmp_path):
    """(e) a missing cache file loads as empty — never an error."""
    cache = EntityCache.load(tmp_path / "entity-cache.json")
    assert len(cache) == 0
    assert cache.lookup("testchan") is None


def test_cache_corrupt_file_loads_empty(tmp_path, capsys):
    """(e) a corrupt cache file loads as empty (and says so) — the
    run re-resolves and rebuilds it, it never crashes."""
    path = tmp_path / "entity-cache.json"
    path.write_text("{not json", encoding="utf-8")
    cache = EntityCache.load(path)
    assert len(cache) == 0
    assert "not valid JSON" in capsys.readouterr().out
    path.write_text('{"foo": 1}', encoding="utf-8")
    assert len(EntityCache.load(path)) == 0
    # And a cache loaded from the corrupt file still stores + saves.
    cache.store("testchan", FakeEntity("testchan", 1, 2))
    assert EntityCache.load(path).lookup("testchan")["id"] == 1


def test_cache_drop_removes_entry(tmp_path):
    path = tmp_path / "entity-cache.json"
    cache = _cache(tmp_path, {"a": FakeEntity("a", 1, 2)})
    assert len(cache) == 1
    cache.drop("a")
    assert len(cache) == 0
    assert EntityCache.load(path).lookup("a") is None
    cache.drop("a")  # dropping a missing entry is a no-op
    assert len(cache) == 0


def test_committed_entity_cache_file_is_valid():
    """The committed telegram/entity-cache.json is valid JSON with
    the v0.4.8 shape (version 1, an entries mapping); every entry
    has an id, an access hash (channels), a type, and a timestamp.
    It starts empty — the first API run populates it."""
    root = Path(__file__).resolve().parent.parent
    data = json.loads((root / "entity-cache.json").read_text(encoding="utf-8"))
    assert data["version"] == 1
    assert isinstance(data["entries"], dict)
    for handle, entry in data["entries"].items():
        assert isinstance(entry["id"], int)
        assert entry["type"] in ("channel", "chat")
        if entry["type"] == "channel":
            assert isinstance(entry["access_hash"], int)
        assert entry["resolved_at"]


# --- (a) a cached handle is used WITHOUT any resolve call -------------------

def test_cached_handle_used_without_resolve(tmp_path, fake_input_peers):
    cache = _cache(tmp_path, {"testchan": FakeEntity("testchan", 123, 456)})
    client = FakeApiClient(
        [FakeMessage(10), FakeMessage(9)],
        entities={"testchan": FakeEntity("testchan", 123, 456)},
    )
    posts = _drain(iter_api_posts(client, "testchan", cache=cache))
    assert [p.post_id for p in posts] == [10, 9]
    assert client.resolve_calls == []  # NO ResolveUsernameRequest at all


def test_cached_handle_builds_input_peer_from_entry(
    tmp_path, fake_input_peers
):
    """The cached peer carries the stored id + access hash."""
    cache = _cache(tmp_path, {"testchan": FakeEntity("testchan", 123, 456)})
    client = FakeApiClient([])
    entity, from_cache = asyncio.run(
        resolve_entity(client, "testchan", cache)
    )
    assert from_cache is True
    assert entity.channel_id == 123
    assert entity.access_hash == 456
    assert client.resolve_calls == []


# --- (b) a cache miss resolves once and stores the entry --------------------

def test_cache_miss_resolves_once_and_stores(tmp_path, fake_input_peers):
    cache = EntityCache(tmp_path / "entity-cache.json")
    client = FakeApiClient(
        [FakeMessage(10)],
        entities={"testchan": FakeEntity("testchan", 123, 456)},
    )
    posts = _drain(iter_api_posts(client, "testchan", cache=cache))
    assert [p.post_id for p in posts] == [10]
    assert client.resolve_calls == ["testchan"]  # resolved exactly once
    entry = cache.lookup("testchan")
    assert entry["id"] == 123
    assert entry["access_hash"] == 456
    assert entry["type"] == "channel"
    # And the entry was persisted to the file immediately.
    reloaded = EntityCache.load(tmp_path / "entity-cache.json")
    assert reloaded.lookup("testchan")["id"] == 123
    # A second run with the same cache resolves nothing.
    client2 = FakeApiClient(
        [FakeMessage(10)],
        entities={"testchan": FakeEntity("testchan", 123, 456)},
    )
    _drain(iter_api_posts(client2, "testchan", cache=reloaded))
    assert client2.resolve_calls == []


def test_uncacheable_entity_is_used_but_not_stored(tmp_path, fake_input_peers):
    """An entity without a usable id (e.g. a minimal test double)
    is still used for the walk — it is simply not cached, so the
    next run resolves it fresh. The run never crashes over the cache."""
    cache = EntityCache(tmp_path / "entity-cache.json")
    bare = type("BareEntity", (), {})()  # no .id at all
    client = FakeApiClient([FakeMessage(10)])
    client.entities = {"testchan": bare}
    posts = _drain(iter_api_posts(client, "testchan", cache=cache))
    assert [p.post_id for p in posts] == [10]
    assert cache.lookup("testchan") is None


# --- (c) a stale cached entry is dropped + re-resolved once ------------------

def test_stale_cached_entry_dropped_and_re_resolved_once(
    tmp_path, fake_input_peers
):
    """The cached id/access hash no longer resolves (Telegram
    answers ChannelInvalidError): the entry is dropped, the handle
    is re-resolved ONCE, the cache is updated, and the chunk is
    retried with the fresh entity — never a loop."""
    path = tmp_path / "entity-cache.json"
    cache = EntityCache(path)
    # A stale entry (old id/access hash) is already in the cache.
    cache.entries["testchan"] = {
        "handle": "testchan", "id": 999, "access_hash": 9999,
        "type": "channel", "resolved_at": "2026-11-01T00:00:00+00:00",
    }
    cache.save()
    # The live entity has a DIFFERENT id/access hash (recreated).
    client = FakeApiClient(
        [FakeMessage(10), FakeMessage(9)],
        entities={"testchan": FakeEntity("testchan", 123, 456)},
        invalid_first_iter=True,
    )
    posts = _drain(iter_api_posts(client, "testchan", cache=cache))
    assert [p.post_id for p in posts] == [10, 9]
    # Exactly one re-resolve (the stale entry was dropped first).
    assert client.resolve_calls == ["testchan"]
    # The cache now holds the FRESH entity, not the stale one.
    entry = EntityCache.load(path).lookup("testchan")
    assert entry["id"] == 123
    assert entry["access_hash"] == 456


def test_stale_entry_without_cache_is_a_plain_error(tmp_path, fake_input_peers):
    """Without a cache there is nothing to drop: a ChannelInvalidError
    is a plain per-source error (re-raised, not retried)."""
    client = FakeApiClient(
        [FakeMessage(10)],
        entities={"testchan": FakeEntity("testchan", 123, 456)},
        invalid_first_iter=True,
    )
    with pytest.raises(ChannelInvalidError):
        _drain(iter_api_posts(client, "testchan"))
    assert client.resolve_calls == ["testchan"]


# --- (d) a flood wait on resolve stops the run immediately -------------------

def test_resolve_flood_wait_raises_typed(tmp_path, fake_input_peers):
    """A FloodWaitError from get_entity becomes a ResolveFloodWait
    (handle + seconds) — distinct from a chunk flood-wait, which the
    reader retries with a capped sleep."""
    cache = EntityCache(tmp_path / "entity-cache.json")
    client = FakeApiClient(
        [], entities={"testchan": FakeEntity("testchan", 123, 456)},
        flood_wait_on_resolve="testchan",
    )
    with pytest.raises(ResolveFloodWait) as exc:
        _drain(iter_api_posts(client, "testchan", cache=cache))
    assert exc.value.handle == "testchan"
    assert exc.value.seconds == 71998
    assert "71998" in str(exc.value)


def _env(monkeypatch):
    monkeypatch.setenv("TELEGRAM_API_ID", "12345")
    monkeypatch.setenv("TELEGRAM_API_HASH", "abcdef")
    monkeypatch.setenv("TELEGRAM_SESSION_STRING", "1A2B3C")


def _cfg(tmp_path, channels=("testchan", "otherchan")):
    path = tmp_path / "channels.yaml"
    lines = ["channels:"]
    for c in channels:
        lines.append(f"  - https://t.me/{c}")
    lines.append("settings:\n  db: index.db\n")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def test_api_backfill_stops_on_resolve_flood_wait(tmp_path, monkeypatch, capsys):
    """The 2026-11-07 incident replayed at small scale: the first
    source's resolve flood-waits (~20 h), so the run STOPS
    immediately — the second source is never attempted (it would hit
    the same wait), the flood wait is recorded in the report note,
    and the run exits failed (all processed sources errored)."""
    from tbi.store import Store

    db = tmp_path / "index.db"
    cfg = _cfg(tmp_path)
    _env(monkeypatch)
    client = FakeApiClient(
        [],
        entities={
            "testchan": FakeEntity("testchan", 123, 456),
            "otherchan": FakeEntity("otherchan", 124, 457),
        },
        flood_wait_on_resolve="testchan",
    )
    monkeypatch.setattr(cli_mod, "create_client", lambda *a: client)
    assert main([
        "api-backfill", "--config", str(cfg), "--db", str(db),
        "--entity-cache", str(tmp_path / "entity-cache.json"),
    ]) == 1
    # Only the first source was attempted — the run stopped.
    assert client.resolve_calls == ["testchan"]
    report = (tmp_path / "index-report.md").read_text(encoding="utf-8")
    assert "STOPPED by a Telegram flood-wait" in report
    assert "71998" in report
    assert "testchan" in report
    store = Store(db)
    try:
        assert store.counts()["posts"] == 0
    finally:
        store.close()


def test_join_groups_stops_on_resolve_flood_wait(
    tmp_path, monkeypatch, fake_input_peers
):
    """The joiner stops on a resolve flood-wait too (the same
    account-wide wait) — and records it in the join state."""
    cfg_path = tmp_path / "channels.yaml"
    cfg_path.write_text(
        "channels: []\n"
        "groups:\n"
        '  - name: "alpha"\n'
        '  - name: "beta"\n'
        "settings:\n  db: index.db\n",
        encoding="utf-8",
    )
    cfg = load_config(cfg_path)
    state = jg.build_initial_state(cfg)

    class FloodClient:
        def __init__(self):
            self.resolve_calls = []

        async def start(self):
            pass

        async def disconnect(self):
            pass

        async def get_entity(self, handle):
            self.resolve_calls.append(handle)
            raise _FloodWait(seconds=3600)

    client = FloodClient()
    result = asyncio.run(
        jg.join_pending(
            client, cfg, state, batch=2, delay_min=0, delay_max=0,
            folder_title=FOLDER, now=NOW,
            entity_cache=EntityCache(tmp_path / "entity-cache.json"),
        )
    )
    assert result.stopped_by_flood_wait is True
    assert result.flood_wait == ("alpha", 3600.0)
    assert result.attempted == ["alpha"]  # beta never attempted
    assert client.resolve_calls == ["alpha"]
    assert state["groups"]["alpha"]["status"] == "flood_wait"
    assert state["groups"]["beta"]["status"] == "pending"
    assert state["flood_wait_until"] == "2026-11-07T22:00:00+00:00"


# --- the joiner uses the cache too ------------------------------------------

def _join_cfg(tmp_path, groups=("alpha", "beta")):
    path = tmp_path / "channels.yaml"
    lines = ["channels: []", "groups:"]
    for g in groups:
        lines.append(f'  - name: "{g}"')
    lines.append("settings:\n  db: index.db\n")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


class FakeJoinClient:
    """Duck-typed stand-in for a Telethon client (join path), with a
    resolve counter and InputChannel-aware request handling: a cached
    entity arrives as an input peer (channel_id, no .handle), so the
    handle is looked up from the channel id."""

    def __init__(self, handles, *, members=(), flood_wait_on_resolve=None,
                 invalid_channel_ids=()):
        self.entities = {
            h: FakeEntity(h, 100 + i) for i, h in enumerate(handles)
        }
        self.by_channel_id = {e.id: h for h, e in self.entities.items()}
        self.members = set(members)
        self.flood_wait_on_resolve = flood_wait_on_resolve
        # Channel ids whose participant check answers ChannelInvalidError
        # (a stale cached peer): the fresh entity has a different id.
        self.invalid_channel_ids = set(invalid_channel_ids)
        self.resolve_calls = []
        self.joins = []
        self.filters = []
        self.started = False
        self.disconnected = False

    async def start(self):
        self.started = True

    async def disconnect(self):
        self.disconnected = True

    def _handle_of(self, entity):
        handle = getattr(entity, "handle", None)
        if handle is not None:
            return handle
        return self.by_channel_id.get(getattr(entity, "channel_id", None))

    async def get_entity(self, handle):
        self.resolve_calls.append(handle)
        if handle == self.flood_wait_on_resolve:
            raise _FloodWait(seconds=3600)
        if handle not in self.entities:
            raise ValueError(
                f"Cannot find any entity corresponding to '{handle}'"
            )
        return self.entities[handle]

    async def get_input_entity(self, entity):
        if getattr(entity, "channel_id", None) is not None:
            return entity  # already an input peer (cached) — no resolve
        return SimpleNamespace(
            channel_id=entity.id, access_hash=entity.access_hash
        )

    async def __call__(self, request):
        kind = getattr(request, "kind", None)
        if kind == "join":
            handle = self._handle_of(request.channel)
            self.joins.append(handle)
            return self.entities[handle]
        if kind == "get_participant":
            handle = self._handle_of(request.channel)
            channel_id = getattr(request.channel, "channel_id", None)
            if channel_id in self.invalid_channel_ids:
                raise ChannelInvalidError("The channel is invalid")
            if handle in self.members:
                return SimpleNamespace()
            raise type("UserNotParticipantError", (Exception,), {})()
        if kind == "get_filters":
            return SimpleNamespace(filters=list(self.filters))
        if kind == "update_filter":
            return None
        raise AssertionError(f"unexpected request kind: {kind!r}")


@pytest.fixture
def fake_join_requests(monkeypatch):
    """Monkeypatch the joiner's lazy Telethon factories (same seam as
    test_join_groups.py) plus the cache's input-peer factories."""
    monkeypatch.setattr(
        jg, "_join_request",
        lambda entity: SimpleNamespace(kind="join", channel=entity),
    )
    monkeypatch.setattr(
        jg, "_get_participant_request",
        lambda entity: SimpleNamespace(
            kind="get_participant", channel=entity, participant="me"
        ),
    )
    monkeypatch.setattr(
        jg, "_get_filters_request",
        lambda: SimpleNamespace(kind="get_filters"),
    )
    monkeypatch.setattr(
        jg, "_update_filter_request",
        lambda fid, f: SimpleNamespace(kind="update_filter", id=fid, filter=f),
    )
    monkeypatch.setattr(
        jg, "_rebuild_filter",
        lambda old, include: SimpleNamespace(
            kind="dialog_filter", id=old.id, title=old.title,
            pinned_peers=old.pinned_peers,
            include_peers=list(include),
            exclude_peers=old.exclude_peers,
        ),
    )
    monkeypatch.setattr(
        "tbi.entity_cache._input_channel",
        lambda channel_id, access_hash: SimpleNamespace(
            kind="input_channel", channel_id=channel_id,
            access_hash=access_hash,
        ),
    )
    monkeypatch.setattr(
        "tbi.entity_cache._input_peer_chat",
        lambda chat_id: SimpleNamespace(kind="input_peer_chat", chat_id=chat_id),
    )


def _run_join(client, cfg, state, cache, **kwargs):
    kwargs.setdefault("delay_min", 0)
    kwargs.setdefault("delay_max", 0)
    kwargs.setdefault("folder_title", FOLDER)
    return asyncio.run(
        jg.join_pending(client, cfg, state, entity_cache=cache, **kwargs)
    )


def test_join_cached_group_without_resolve(
    tmp_path, fake_join_requests
):
    """(a, join path) a cached group is joined WITHOUT any resolve
    call — the membership check and the join both use the cached
    input peer."""
    cfg = load_config(_join_cfg(tmp_path))
    state = jg.build_initial_state(cfg)
    cache = _cache(
        tmp_path, {"alpha": FakeEntity("alpha", 100)}
    )
    client = FakeJoinClient(["alpha", "beta"])
    result = _run_join(client, cfg, state, cache, batch=1)
    assert result.joined == ["alpha"]
    assert client.resolve_calls == []  # NO ResolveUsernameRequest
    assert state["groups"]["alpha"]["status"] == "joined"


def test_join_cache_miss_resolves_once_and_stores(
    tmp_path, fake_join_requests
):
    """(b, join path) a cache miss resolves once, stores the entry,
    and the next run reuses it."""
    cfg = load_config(_join_cfg(tmp_path))
    state = jg.build_initial_state(cfg)
    cache = EntityCache(tmp_path / "entity-cache.json")
    client = FakeJoinClient(["alpha", "beta"])
    result = _run_join(client, cfg, state, cache, batch=1)
    assert result.joined == ["alpha"]
    assert client.resolve_calls == ["alpha"]
    assert cache.lookup("alpha")["id"] == 100
    # Second run, same cache file: no resolve at all.
    state2 = jg.build_initial_state(cfg)
    client2 = FakeJoinClient(["alpha", "beta"])
    result2 = _run_join(
        client2, cfg, state2,
        EntityCache.load(tmp_path / "entity-cache.json"), batch=1,
    )
    assert result2.joined == ["alpha"]
    assert client2.resolve_calls == []


def test_join_stale_cached_entry_dropped_and_re_resolved_once(
    tmp_path, fake_join_requests
):
    """(c, join path) the cached peer is stale (the membership check
    answers ChannelInvalidError): the entry is dropped, the handle
    is re-resolved ONCE, and the join is retried with the fresh
    entity — never a loop."""
    cfg = load_config(_join_cfg(tmp_path, groups=("alpha",)))
    state = jg.build_initial_state(cfg)
    path = tmp_path / "entity-cache.json"
    cache = EntityCache(path)
    # A stale entry (old id) is already in the cache.
    cache.entries["alpha"] = {
        "handle": "alpha", "id": 999, "access_hash": 9999,
        "type": "channel", "resolved_at": "2026-11-01T00:00:00+00:00",
    }
    cache.save()
    # The membership check fails with ChannelInvalidError for the
    # STALE peer (channel id 999) but works for the fresh one (100).
    client = FakeJoinClient(["alpha"], invalid_channel_ids={999})
    result = _run_join(client, cfg, state, cache, batch=1)
    assert result.joined == ["alpha"]
    assert client.resolve_calls == ["alpha"]  # exactly one re-resolve
    entry = EntityCache.load(path).lookup("alpha")
    assert entry["id"] == 100  # the fresh entity, not the stale 999
    assert entry["access_hash"] == 1100


# --- the real input-peer factories (importorskip) ---------------------------

def test_real_input_peer_factories_build():
    """The lazy factories build real TL objects that serialise —
    the cached peer the production runs use is a real InputChannel."""
    telethon = pytest.importorskip("telethon")
    from telethon.tl.types import InputChannel, InputPeerChat

    from tbi.entity_cache import _input_channel, _input_peer_chat
    from tbi.entity_cache import _input_peer_from_entry

    peer = _input_channel(123, 456)
    assert type(peer).__name__ == "InputChannel"
    assert peer.channel_id == 123
    assert peer.access_hash == 456
    bytes(peer)  # serialises
    chat = _input_peer_chat(77)
    assert type(chat).__name__ == "InputPeerChat"
    assert chat.chat_id == 77
    bytes(chat)
    entry_peer = _input_peer_from_entry(
        {"id": 123, "access_hash": 456, "type": "channel"}
    )
    assert isinstance(entry_peer, InputChannel)
    chat_peer = _input_peer_from_entry({"id": 77, "type": "chat"})
    assert isinstance(chat_peer, InputPeerChat)
