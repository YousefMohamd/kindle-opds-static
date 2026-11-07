"""Persistent entity cache (v0.4.8) — resolve each handle ONCE.

The 2026-11-07 api-backfill run failed in 24 seconds: EVERY source
failed with ``A wait of 71998 seconds is required (caused by
ResolveUsernameRequest)`` — a ~20-hour flood wait on username
resolution. The cause: every API run resolved ALL 211 handles (43
channels + 168 groups) via ``ResolveUsernameRequest``, because each
GitHub Actions run starts with an EMPTY Telethon entity cache. The
session string carries the auth key, not the cached entities — the
entity cache lives in the ``.session`` file, which is never persisted
across ephemeral runners. The account had resolved the same 211
usernames repeatedly in a few hours (EBook_Library run, two
successful backfills, the failed 1h22m run, and the 24 s run), and
Telegram's flood control for ``ResolveUsernameRequest`` is strict.

This module is the fix: a small JSON file (``entity-cache.json``,
committed to the repo) that maps each configured handle to the
Telegram numeric id + access hash + entity type it resolved to.
The API paths look a handle up here first and only call
``ResolveUsernameRequest`` on a cache miss — so each handle is
resolved once, ever, and later runs reuse the cached id + access
hash (an ``InputChannel`` / ``InputPeerChat`` needs no resolution).

**What the cache holds — and what it never holds:** only public
handles, numeric ids, access hashes, entity types, and resolve
timestamps. An access hash is NOT a secret (it is useless without
the session), and no ``api_id`` / ``api_hash`` / session string
ever goes in here. The file is human-readable JSON, committed to
the repo alongside ``join-state.json``.

**Staleness:** a cached id + access hash can go stale (the source
was deleted/recreated, or the hash rotated). Telegram then answers
an operation on the cached peer with ``ChannelInvalidError``. The
callers (``iter_api_posts``, ``join_pending``) treat that as a stale
entry: drop it, re-resolve the handle ONCE, update the cache, and
retry the operation once with the fresh entity. Never a loop.

**Flood wait on resolve:** when ``ResolveUsernameRequest`` itself
is flood-limited, the resolver raises :class:`ResolveFloodWait`
(carrying the handle + seconds). That is distinct from a chunk
flood-wait (which ``iter_api_posts`` retries with a capped sleep):
a resolve flood-wait is account-wide and long, so the run must
STOP immediately rather than trying the next source (which would
hit the same wait). The CLI records it in the run's report and
stops; the joiner records it in the join state and stops.

**Robustness:** a missing or corrupt cache file is never fatal —
:func:`EntityCache.load` falls back to an empty cache (and the
next store rebuilds the file). The cache is saved atomically
(temp file + replace) immediately after every store/drop, so a
timeout kill never loses a resolved entry.

**Telethon is an optional dependency.** This module imports cleanly
without it; the ``InputChannel`` / ``InputPeerChat`` factories are
built lazily (the same seam the joiner uses for its request
factories), so the whole cache is testable offline with a fake
client and no credentials.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

# The cache file, next to channels.yaml in the telegram/ directory.
# Committed to the repo (like join-state.json) so it persists across
# ephemeral GitHub runners; the API workflows `git add` it in their
# Publish and failure-save steps.
DEFAULT_ENTITY_CACHE = "entity-cache.json"

# Cache file format version (bump only if the entry shape changes).
CACHE_VERSION = 1


class ResolveFloodWait(Exception):
    """A FloodWaitError raised by ResolveUsernameRequest (get_entity).

    Carries the handle and the required wait in seconds. Distinct
    from a chunk flood-wait (``iter_messages``), which the reader
    retries with a capped sleep: a resolve flood-wait is
    account-wide and long (the 2026-11-07 incident was ~20 hours),
    so the run must STOP immediately instead of trying the next
    source — which would hit the same wait and could extend it.
    """

    def __init__(self, handle: str, seconds: float):
        super().__init__(
            f"@{handle}: a wait of {seconds:g} seconds is required "
            "(ResolveUsernameRequest)"
        )
        self.handle = handle
        self.seconds = float(seconds)


def _normalize_handle(handle: str) -> str:
    """Cache key for a handle: Telegram usernames are case-insensitive,
    so the key is lowercased (the entry keeps the original spelling)."""
    return (handle or "").strip().lstrip("@").lower()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _flood_wait_seconds(exc) -> Optional[float]:
    """Seconds of a Telethon FloodWaitError, or None.

    Duck-typed on the ``.seconds`` attribute (the same seam
    ``iter_api_posts`` and the joiner use), so no Telethon import is
    needed.
    """
    seconds = getattr(exc, "seconds", None)
    if seconds is None:
        return None
    try:
        return float(seconds)
    except (TypeError, ValueError):
        return None


def _is_user_entity(entity) -> bool:
    """True when the resolved entity is a person (a user account).

    Duck-typed on the class name so no Telethon import is needed: the
    API paths must never read a personal chat, even if its handle
    somehow ended up in the config.
    """
    return type(entity).__name__ == "User"


def _is_channel_invalid(exc) -> bool:
    """True for Telethon's ChannelInvalidError — the cached id +
    access hash no longer resolves (stale cache entry).

    Duck-typed on the class name, the same seam the joiner uses for
    its error kinds.
    """
    return type(exc).__name__ == "ChannelInvalidError"


# --- Telethon input-peer factories (lazy import = testable offline) -------

def _input_channel(channel_id: int, access_hash: int):
    """Telethon's InputChannel, built lazily (see module docstring)."""
    from telethon.tl.types import InputChannel

    return InputChannel(channel_id=channel_id, access_hash=access_hash)


def _input_peer_chat(chat_id: int):
    """Telethon's InputPeerChat, built lazily (small groups only)."""
    from telethon.tl.types import InputPeerChat

    return InputPeerChat(chat_id=chat_id)


def _input_peer_from_entry(entry: dict):
    """An InputPeer for a cache entry — no network call, no resolve.

    ``type == "channel"`` (channels and supergroups/megagroups,
    which are Channel entities in MTProto) becomes an InputChannel;
    ``type == "chat"`` (small groups) becomes an InputPeerChat.
    """
    if entry.get("type") == "chat":
        return _input_peer_chat(int(entry["id"]))
    return _input_channel(int(entry["id"]), int(entry["access_hash"]))


def _entry_from_entity(handle: str, entity) -> Optional[dict]:
    """A cache entry for a freshly resolved entity, or None when the
    entity cannot be cached (no usable numeric id — the run still
    proceeds with the entity, it is simply resolved fresh next time).

    The type is duck-typed: an entity with an access hash is a
    Channel (channels + supergroups — the only kinds the config
    holds); one with an id but no access hash is a small-group Chat.
    A User is refused by the resolver before this is called.
    """
    entity_id = getattr(entity, "id", None)
    if not isinstance(entity_id, int):
        return None
    access_hash = getattr(entity, "access_hash", None)
    return {
        "handle": handle,
        "id": int(entity_id),
        "access_hash": int(access_hash) if access_hash is not None else None,
        "type": "channel" if access_hash is not None else "chat",
        "resolved_at": _now_iso(),
    }


# --- the cache ---------------------------------------------------------------

class EntityCache:
    """Resolved Telegram entities, backed by ``entity-cache.json``.

    ``path`` is the file (or None for an in-memory-only cache, used
    by tests — ``save()`` is then a no-op). The cache is a plain
    dict of normalized-handle -> entry, so it round-trips through
    JSON unchanged.
    """

    def __init__(self, path=None, entries=None):
        self.path = Path(path) if path is not None else None
        self.entries = dict(entries or {})

    # -- loading (never raises: missing/corrupt -> empty cache) -------

    @classmethod
    def load(cls, path) -> "EntityCache":
        """Load the cache file; an absent or corrupt file yields an
        empty cache (the next store rebuilds the file). Never raises
        and never refuses to run — a broken cache must not block an
        API run, it only costs re-resolves.
        """
        cache = cls(path)
        p = Path(path)
        if not p.is_file():
            return cache
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            print(
                f"[cache] {path}: not valid JSON — starting with an "
                "empty entity cache (handles will be re-resolved).",
                flush=True,
            )
            return cache
        if not isinstance(data, dict) or not isinstance(
            data.get("entries"), dict
        ):
            print(
                f"[cache] {path}: unexpected shape (expected a JSON "
                "object with an 'entries' mapping) — starting with an "
                "empty entity cache.",
                flush=True,
            )
            return cache
        entries = {}
        for key, entry in data["entries"].items():
            if not isinstance(entry, dict):
                continue
            try:
                entry_id = int(entry["id"])
            except (KeyError, TypeError, ValueError):
                continue
            if entry.get("type") == "channel" and entry.get("access_hash") is None:
                continue  # a channel entry without an access hash is unusable
            entries[_normalize_handle(str(key))] = dict(entry, id=entry_id)
        cache.entries = entries
        return cache

    # -- lookup / store / drop (store + drop persist immediately) -------

    def lookup(self, handle: str) -> Optional[dict]:
        """The cached entry for ``handle``, or None (cache miss)."""
        return self.entries.get(_normalize_handle(handle))

    def store(self, handle: str, entity) -> Optional[dict]:
        """Record a freshly resolved entity and save the file
        immediately (a timeout kill must not lose the entry).
        Returns the entry, or None when the entity cannot be cached
        (no usable id) — the caller still uses the entity, it is
        simply resolved fresh next time."""
        entry = _entry_from_entity(handle, entity)
        if entry is None:
            return None
        self.entries[_normalize_handle(handle)] = entry
        self.save()
        return entry

    def drop(self, handle: str) -> None:
        """Forget a (stale) entry and save immediately."""
        if _normalize_handle(handle) in self.entries:
            del self.entries[_normalize_handle(handle)]
            self.save()

    def __len__(self) -> int:
        return len(self.entries)

    # -- persistence -------------------------------------------------------

    def to_dict(self) -> dict:
        return {"version": CACHE_VERSION, "entries": dict(self.entries)}

    def save(self) -> None:
        """Save atomically (temp file + replace), so a kill mid-write
        never leaves a half-written cache behind. A no-op when the
        cache has no path (in-memory only)."""
        if self.path is None:
            return
        tmp = self.path.with_name(self.path.name + ".tmp")
        tmp.write_text(
            json.dumps(self.to_dict(), ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        os.replace(tmp, self.path)


# --- the resolver ------------------------------------------------------------

async def resolve_entity(client, handle: str, cache: Optional[EntityCache] = None):
    """Resolve ``handle`` to an entity (or input peer), via the cache.

    Returns ``(entity, from_cache)``. A cache hit returns an
    InputChannel / InputPeerChat built from the stored id + access
    hash — NO network call, NO ``ResolveUsernameRequest``. A cache
    miss calls ``client.get_entity(handle)`` once, stores the result
    (and saves the cache file immediately), and returns the fresh
    entity.

    Raises :class:`ResolveFloodWait` when the resolve itself is
    flood-limited (the caller must stop the run), and ValueError
    when the handle resolves to a personal chat (never cached, never
    read). Other resolve failures propagate unchanged (the caller
    records them per-source).
    """
    if cache is not None:
        entry = cache.lookup(handle)
        if entry is not None:
            return _input_peer_from_entry(entry), True
    try:
        entity = await client.get_entity(handle)
    except Exception as exc:  # noqa: BLE001 - flood wait is re-raised typed
        seconds = _flood_wait_seconds(exc)
        if seconds is not None:
            raise ResolveFloodWait(handle, seconds) from exc
        raise
    if _is_user_entity(entity):
        raise ValueError(
            f"@{handle} resolved to a personal chat — the API paths "
            "only read configured channels/groups, never personal chats."
        )
    if cache is not None:
        cache.store(handle, entity)
    return entity, False
