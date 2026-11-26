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

# --- sync-fix v2 (2026-11-24): the cache had NO update path -----------
# The file held 215 entries for 215 configured sources (43 channels
# + 172 groups, verified 2026-11-24) — coverage was complete, but
# every entry dated from 2026-11-08/10/15 and nothing ever refreshed
# them: a new handle added to channels.yaml, or a stale id/access
# hash, forced a live ResolveUsernameRequest on the hot path, and the
# refreshed value died with the ephemeral runner (the workflow
# deliberately never committed the file — a commit every 5 minutes
# would flood the repo). The fix, in three layers:
#   * TTL + opportunistic refresh: entries older than ENTITY_TTL_DAYS
#     are re-resolved oldest-first, inside a bounded per-run budget
#     (ResolveBudget) — live_sync does this, so the file heals
#     itself a few entries per run instead of all at once.
#   * Negative cache: a handle that fails to resolve is remembered
#     (failed_at + failures) for NEGATIVE_TTL_HOURS, so a dead handle
#     is not re-resolved every run (each attempt counts toward the
#     account's resolve rate limit).
#   * Durable truth: the D1 `entities` table (telegram/sql/
#     entities-schema.sql, tbi.d1_entities) holds the same mapping
#     by numeric id; the weekly refresh workflow commits the file
#     ONLY when it changed, and regenerates entities.sql alongside.
ENTITY_TTL_DAYS = 30
# A stale entry is re-resolved at most this often even when the TTL
# has passed and the budget is free — a source that keeps failing
# must not be retried every run.
NEGATIVE_TTL_HOURS = 24
# Fresh resolves per live_sync run (misses first, then stale
# refresh). 8 is deliberately small: at ~144 runs/day the whole
# 215-entry cache can turn over in under a day when it comes due,
# while a single run can never spend 8 resolves' worth of the
# account's resolve budget, let alone trip a FloodWait by itself.
DEFAULT_RESOLVE_BUDGET = 8


class ResolveBudgetExhausted(Exception):
    """Raised by resolve_entity when the run's resolve budget is
    spent. The caller SKIPS the handle (records it as
    failed:resolve-budget) instead of resolving — a skipped source
    keeps its old cursor and is retried next run; a resolve past
    the budget is how the account earns a FloodWait."""


def _parse_ts(value) -> Optional[datetime]:
    """Parse an ISO timestamp, or None when absent/unparseable."""
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def entry_age_days(entry: dict, now: Optional[datetime] = None) -> Optional[float]:
    """Days since the entry was last resolved (None when unknown —
    an entry with no resolved_at is treated as infinitely old)."""
    ts = _parse_ts(entry.get("resolved_at"))
    if ts is None:
        return None
    ref = now or datetime.now(timezone.utc)
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return (ref - ts).total_seconds() / 86400.0


def is_stale(entry: dict, ttl_days: float = ENTITY_TTL_DAYS,
             now: Optional[datetime] = None) -> bool:
    """True when the entry is older than the TTL (or has no
    timestamp at all). Stale does NOT mean unusable: the cached
    InputChannel is still tried first — staleness only schedules
    an opportunistic re-resolve inside the budget."""
    age = entry_age_days(entry, now)
    return age is None or age > ttl_days


def is_negative_cached(entry: dict, ttl_hours: float = NEGATIVE_TTL_HOURS,
                       now: Optional[datetime] = None) -> bool:
    """True when the entry records a recent resolve FAILURE
    (failed_at within the negative TTL). Such a handle is skipped
    without a resolve attempt — retrying a dead handle every run
    burns the account's resolve budget for nothing."""
    ts = _parse_ts(entry.get("failed_at"))
    if ts is None:
        return False
    ref = now or datetime.now(timezone.utc)
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return (ref - ts).total_seconds() < ttl_hours * 3600


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

    def lookup_valid(self, handle: str, ttl_days: float = ENTITY_TTL_DAYS,
                     now: Optional[datetime] = None) -> Optional[dict]:
        """The cached entry when it is usable WITHOUT a resolve:
        present, not negatively cached (recent failure), and not
        stale. Returns None when a resolve (or a skip) is the right
        move — the caller decides between the two via the budget.
        A stale entry is NOT returned here: the caller should use
        the cached peer for the read and schedule a refresh, not
        block the read on a re-resolve."""
        entry = self.lookup(handle)
        if entry is None:
            return None
        if is_negative_cached(entry, now=now):
            return None
        if is_stale(entry, ttl_days, now):
            return None
        return entry

    def refresh_due(self, handles=None, ttl_days: float = ENTITY_TTL_DAYS,
                    limit: int = DEFAULT_RESOLVE_BUDGET,
                    now: Optional[datetime] = None) -> list[str]:
        """Handles whose entries are stale and due a re-resolve,
        oldest first, capped at ``limit``. ``handles`` defaults to
        every cached handle. Negatively cached handles are never
        due (a recent failure is not retried until its TTL lapses).
        Pure selection — resolving is the caller's job, inside the
        budget."""
        ref = now or datetime.now(timezone.utc)
        keys = [_normalize_handle(h) for h in handles] if handles is not None else list(self.entries)
        due: list[tuple[float, str]] = []
        for key in keys:
            entry = self.entries.get(key)
            if entry is None:
                continue
            if is_negative_cached(entry, now=ref):
                continue
            if not is_stale(entry, ttl_days, ref):
                continue
            age = entry_age_days(entry, ref)
            # Return the entry's ORIGINAL handle spelling (not the
            # lowercased cache key): the re-resolve stores it back,
            # so the display spelling never degrades to lowercase.
            due.append((age if age is not None else float("inf"),
                        str(entry.get("handle") or key)))
        due.sort(key=lambda t: -t[0])
        return [handle for _, handle in due[:limit]]

    def record_failure(self, handle: str, exc: Exception) -> None:
        """Remember a failed resolve (negative cache): the handle
        keeps any good entry it had (a failure does not delete a
        working id/access hash), but gains failed_at + a failures
        counter, so the next runs skip it for NEGATIVE_TTL_HOURS
        instead of re-resolving a dead handle every run. A
        ResolveFloodWait is NOT recorded here — a flood is
        account-wide and the run stops anyway (live_sync handles
        it); recording it per-handle would be wrong."""
        if isinstance(exc, ResolveFloodWait):
            return
        key = _normalize_handle(handle)
        entry = self.entries.get(key)
        if entry is None:
            entry = {
                "handle": handle,
                "id": 0,
                "access_hash": None,
                "type": "unknown",
                "resolved_at": None,
            }
            self.entries[key] = entry
        entry["failed_at"] = _now_iso()
        entry["failures"] = int(entry.get("failures") or 0) + 1
        self.save()

    def merge(self, entries: dict) -> int:
        """Merge entries from another source of truth (the D1
        entities export — see tbi.d1_entities): an incoming entry
        wins only when it is NEWER (resolved_at) than the one held,
        so a stale export can never overwrite a fresher resolve.
        Returns the number of entries added or updated. Entries
        with id 0 (negative-cache placeholders) are never merged
        in and never overwrite a good entry."""
        changed = 0
        for key, incoming in (entries or {}).items():
            if not isinstance(incoming, dict):
                continue
            try:
                incoming_id = int(incoming.get("id"))
            except (TypeError, ValueError):
                continue
            if incoming_id == 0:
                continue
            norm = _normalize_handle(str(key))
            current = self.entries.get(norm)
            if current is not None:
                cur_ts = _parse_ts(current.get("resolved_at"))
                inc_ts = _parse_ts(incoming.get("resolved_at"))
                same_peer = (
                    current.get("id") == incoming_id
                    and current.get("access_hash") == incoming.get("access_hash")
                )
                # Skip only when nothing is newer: same peer AND
                # the incoming timestamp is not newer. A newer
                # timestamp for the SAME peer still updates (it
                # refreshes the TTL — that is the whole point of
                # the refresh), and a different peer always wins
                # when newer.
                if same_peer and (
                    inc_ts is None
                    or (cur_ts is not None and inc_ts <= cur_ts)
                ):
                    continue
                if (
                    not same_peer
                    and cur_ts is not None
                    and inc_ts is not None
                    and inc_ts <= cur_ts
                ):
                    continue
            self.entries[norm] = dict(incoming)
            changed += 1
        if changed:
            self.save()
        return changed

    def store(self, handle: str, entity) -> Optional[dict]:
        """Record a freshly resolved entity and save the file
        immediately (a timeout kill must not lose the entry).
        Returns the entry, or None when the entity cannot be cached
        (no usable id) — the caller still uses the entity, it is
        simply resolved fresh next time."""
        entry = _entry_from_entity(handle, entity)
        if entry is None:
            return None
        # A successful resolve clears any negative-cache markers
        # the handle carried (it is alive again).
        entry.pop("failed_at", None)
        entry.pop("failures", None)
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


# --- the resolve budget (sync-fix v2) --------------------------------------

class ResolveBudget:
    """Bounded fresh resolves per run (sync-fix v2).

    The account's ResolveUsernameRequest budget is the scarcest
    resource in the sync: one flood wait there stops the whole run
    for hours. The budget caps how many NEW resolves a run may
    spend (cache misses first, stale refresh with what is left).
    Cache HITS cost nothing. When the budget is spent the run
    SKIPS the remaining unknown handles instead of resolving them
    — a skipped source keeps its old cursor for the next run.
    """

    def __init__(self, max_fresh: int = DEFAULT_RESOLVE_BUDGET):
        self.max_fresh = max(0, int(max_fresh))
        self.spent = 0

    @property
    def remaining(self) -> int:
        return max(0, self.max_fresh - self.spent)

    @property
    def exhausted(self) -> bool:
        return self.remaining <= 0

    def try_acquire(self) -> bool:
        """Spend one resolve, or False when the budget is gone."""
        if self.exhausted:
            return False
        self.spent += 1
        return True


async def refresh_entry(client, handle: str, cache: EntityCache):
    """Force a re-resolve of ``handle`` (stale-entry refresh):
    calls ``client.get_entity`` even when the cache holds the
    handle, stores the fresh entity, and returns (entity, True)
    — or (None, False) when the entity cannot be cached (the
    caller still proceeds; the entry is simply not refreshed).
    Raises ResolveFloodWait on a resolve flood (the caller stops
    the run) and ValueError for a personal chat. Any other failure
    is recorded as a negative-cache failure and re-raised.
    Unlike resolve_entity, this NEVER returns the cached peer:
    its whole point is to replace a stale one."""
    try:
        entity = await client.get_entity(handle)
    except Exception as exc:  # noqa: BLE001 - flood wait is re-raised typed
        seconds = _flood_wait_seconds(exc)
        if seconds is not None:
            raise ResolveFloodWait(handle, seconds) from exc
        cache.record_failure(handle, exc)
        raise
    if _is_user_entity(entity):
        raise ValueError(
            f"@{handle} resolved to a personal chat — the API paths "
            "only read configured channels/groups, never personal chats."
        )
    stored = cache.store(handle, entity)
    return entity, stored is not None


# --- the resolver ------------------------------------------------------------

async def resolve_entity(client, handle: str, cache: Optional[EntityCache] = None,
                         budget: Optional[ResolveBudget] = None):
    """Resolve ``handle`` to an entity (or input peer), via the cache.

    Returns ``(entity, from_cache)``. A cache hit returns an
    InputChannel / InputPeerChat built from the stored id + access
    hash — NO network call, NO ``ResolveUsernameRequest``. A cache
    miss calls ``client.get_entity(handle)`` once, stores the result
    (and saves the cache file immediately), and returns the fresh
    entity.

    ``budget`` (sync-fix v2): when given, a cache miss first spends
    one unit; when the budget is exhausted it raises
    :class:`ResolveBudgetExhausted` INSTEAD of resolving (the
    caller skips the handle). A negatively cached handle (failed
    recently) also raises ResolveBudgetExhausted without spending
    — there is nothing to gain by retrying it this run.

    Raises :class:`ResolveFloodWait` when the resolve itself is
    flood-limited (the caller must stop the run), and ValueError
    when the handle resolves to a personal chat (never cached, never
    read). Other resolve failures propagate unchanged (the caller
    records them per-source).
    """
    if cache is not None:
        entry = cache.lookup(handle)
        if entry is not None:
            if is_negative_cached(entry):
                raise ResolveBudgetExhausted(
                    f"@{handle}: resolve failed recently — negative "
                    "cache, skipping this run"
                )
            return _input_peer_from_entry(entry), True
    if budget is not None and not budget.try_acquire():
        raise ResolveBudgetExhausted(
            f"@{handle}: per-run resolve budget spent "
            f"({budget.max_fresh}) — skipping, cursor kept for next run"
        )
    try:
        entity = await client.get_entity(handle)
    except ResolveBudgetExhausted:
        raise
    except Exception as exc:  # noqa: BLE001 - flood wait is re-raised typed
        seconds = _flood_wait_seconds(exc)
        if seconds is not None:
            raise ResolveFloodWait(handle, seconds) from exc
        if cache is not None:
            cache.record_failure(handle, exc)
        raise
    if _is_user_entity(entity):
        raise ValueError(
            f"@{handle} resolved to a personal chat — the API paths "
            "only read configured channels/groups, never personal chats."
        )
    if cache is not None:
        cache.store(handle, entity)
    return entity, False
