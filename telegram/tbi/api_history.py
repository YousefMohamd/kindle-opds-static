"""Telegram API (MTProto / Telethon) history reader — optional, manual-only.

The public web preview (``t.me/s/``) cannot see groups at all, and it has
a coverage ceiling on large channels. The MTProto API can read a
channel's or group's **full message history** — including the old posts
the preview never serves. That is what this module does.

**Privacy model (hard condition, set by the owner):**
  * Credentials (``api_id``, ``api_hash``, session string) live ONLY as
    GitHub Actions **secrets** — encrypted by GitHub, never in the repo,
    never in any file that gets pushed, never in any log, never in the
    zip. They are managed only by the repo owner.
  * This module reads them **only from environment variables**
    (``TELEGRAM_API_ID``, ``TELEGRAM_API_HASH``,
    ``TELEGRAM_SESSION_STRING``). It never reads a file for them, never
    prints them, and never sends them anywhere except to Telegram's own
    servers when connecting.
  * The API job is **manual-only**: it runs only when the owner starts
    it (``tbi api-backfill`` / the ``telegram-api-backfill`` workflow's
    manual dispatch). It is NOT part of the daily scheduled job, so
    nothing runs continuously tied to the owner's account.
  * It reads **only configured channels/groups** (``channels.yaml``) —
    never the owner's personal chats. A handle that is not in the
    config is refused, and a resolved entity that turns out to be a
    person (a user account) is refused too.

**Metadata only, legal sources only, no file downloads** — the same
rule as the preview scraper. Each message is turned into a
:class:`tbi.scrape.Post` and consumed by the same store code, so the
API path and the preview path produce identical rows (same title/author
parsing, same dedup keys, same FTS).

**Entity cache (v0.4.8):** every API run used to resolve ALL 211
handles via ``ResolveUsernameRequest`` (each GitHub Actions run
starts with an empty Telethon entity cache), and on 2026-11-07 that
tripped a ~20-hour flood wait that failed the whole run in 24 s.
``iter_api_posts`` now resolves through :mod:`tbi.entity_cache`:
a cached handle is used WITHOUT any resolve call (an InputChannel
built from the stored id + access hash), and only a cache miss
resolves — once — and stores the result. A stale cached entry
(``ChannelInvalidError`` on use) is dropped and re-resolved once.

**Telethon is an optional dependency.** This module imports cleanly
without it installed; Telethon is imported lazily, only inside
:func:`create_client`, which is the single place a real client is
built. Everything else takes a duck-typed client (any object with
``get_entity`` / ``iter_messages``), so the whole reader is testable
offline with a fake client and no credentials.
"""

from __future__ import annotations

import asyncio
import os
from datetime import datetime
from typing import AsyncIterator, Optional

from .books import format_size
from .config import Config
from .entity_cache import EntityCache, _is_channel_invalid, resolve_entity
from .scrape import FileMeta, Post, normalize_link

API_ID_ENV = "TELEGRAM_API_ID"
API_HASH_ENV = "TELEGRAM_API_HASH"
SESSION_ENV = "TELEGRAM_SESSION_STRING"

# Messages are fetched in chunks of this size; a chunk is also the unit
# a flood-wait retry re-fetches (idempotent — the store upserts by
# (source, post id), so re-fetching a chunk never duplicates a post).
_CHUNK = 100
# A flood wait longer than this is capped before sleeping; the chunk is
# retried after the sleep instead of waiting out the full penalty.
_MAX_FLOOD_WAIT_S = 300.0
# Polite pause between chunks (the API is fast — this is a courtesy
# pause, not the preview's 1.5 s/page).
_CHUNK_DELAY_S = 0.5
# Retries of one chunk after a flood wait before giving up.
_CHUNK_RETRIES = 3


class ApiCredentialsError(ValueError):
    """Raised when the API credentials are missing or unusable.

    The message never contains a credential value — only the env var
    names and how to set them (GitHub repo Secrets, or the login
    script — see README "Telegram API history backfill").
    """


def load_api_credentials(env: Optional[dict] = None) -> tuple[int, str, str]:
    """Read (api_id, api_hash, session_string) from the environment.

    ``env`` is injectable for tests (defaults to ``os.environ``).
    Raises :class:`ApiCredentialsError` when anything is missing or
    ``api_id`` is not an integer. Values are never logged or returned
    anywhere except to the caller (the client constructor).
    """
    source = env if env is not None else os.environ
    missing = [
        name
        for name in (API_ID_ENV, API_HASH_ENV, SESSION_ENV)
        if not (source.get(name) or "").strip()
    ]
    if missing:
        raise ApiCredentialsError(
            "Telegram API credentials are missing: "
            + ", ".join(missing)
            + ". Set them as GitHub Actions secrets (repo Settings -> "
            "Secrets and variables -> Actions) or as environment "
            "variables, then run the API backfill manually. "
            "See README 'Telegram API history backfill' for the setup."
        )
    try:
        api_id = int(str(source[API_ID_ENV]).strip())
    except ValueError:
        raise ApiCredentialsError(
            f"{API_ID_ENV} must be an integer (the api_id from "
            "my.telegram.org)."
        )
    return (
        api_id,
        str(source[API_HASH_ENV]).strip(),
        str(source[SESSION_ENV]).strip(),
    )


def create_client(api_id: int, api_hash: str, session_string: str):
    """Build a Telethon client from a session string (not started).

    Telethon is imported here — and only here — so the module imports
    without it installed. Raises RuntimeError with install instructions
    when Telethon is missing. The caller starts the client
    (``await client.start()``) and disconnects it; a StringSession
    (in-memory) never writes a session file to disk.
    """
    try:
        from telethon import TelegramClient
        from telethon.sessions import StringSession
    except ImportError:
        raise RuntimeError(
            "Telethon is not installed — the API backfill needs it: "
            "pip install -e \".[api]\" (or pip install telethon)."
        )
    return TelegramClient(StringSession(session_string), api_id, api_hash)


def find_config_entry(cfg: Config, handle: str):
    """Resolve ``handle`` to a config entry: ("channel", entry) or
    ("group", entry), or None when it is not configured.

    The API job only reads configured sources — this is the gate. A
    channel matches by username (``normalize_link``); a group matches
    by its config ``name`` (which, for the groups in channels.yaml,
    is the handle — e.g. ``EBook_Library``).
    """
    name = normalize_link(handle) or ""
    if not name:
        return None
    for entry in cfg.channels:
        if entry.username == name:
            return ("channel", entry)
    for entry in cfg.groups:
        if entry.name == name or normalize_link(entry.name) == name:
            return ("group", entry)
    return None


def _message_files(msg) -> list[FileMeta]:
    """Book-file attachments of one Telethon message (duck-typed).

    Prefers ``msg.file`` (Telethon's document accessor: ``.name``,
    ``.size``, ``.ext``). Falls back to scanning
    ``msg.media.document.attributes`` for an attribute with a
    ``file_name`` (the shape Telethon's ``DocumentAttributeFilename``
    has) and the document's ``size``. Returns [] when the message has
    no document. The caller filters by ``BOOK_EXTS`` — this only
    reports what is attached.
    """
    f = getattr(msg, "file", None)
    if f is not None and getattr(f, "name", None):
        size = getattr(f, "size", None)
        return [
            FileMeta(
                filename=f.name,
                size_text=format_size(size) if size else None,
                size_bytes=size,
            )
        ]
    media = getattr(msg, "media", None)
    doc = getattr(media, "document", None) if media is not None else None
    if doc is None:
        return []
    size = getattr(doc, "size", None)
    for attr in getattr(doc, "attributes", []) or []:
        filename = getattr(attr, "file_name", None)
        if filename:
            return [
                FileMeta(
                    filename=filename,
                    size_text=format_size(size) if size else None,
                    size_bytes=size,
                )
            ]
    return []


def _post_from_message(handle: str, msg) -> Post:
    """One Telethon message -> :class:`tbi.scrape.Post`.

    ``date`` is the message's UTC datetime as ISO text (the store and
    the report already handle that shape from the preview walk).
    ``url`` is the ``t.me/<handle>/<id>`` permalink — the same obtain
    link the preview walk records, so search results are identical.
    """
    date = getattr(msg, "date", None)
    if isinstance(date, datetime):
        date_text = date.isoformat()
    elif isinstance(date, str):
        date_text = date
    else:
        date_text = None
    text = getattr(msg, "message", None) or getattr(msg, "text", None) or ""
    return Post(
        channel=handle,
        post_id=int(msg.id),
        date=date_text,
        text=text if isinstance(text, str) else "",
        url=f"https://t.me/{handle}/{msg.id}",
        files=_message_files(msg),
    )


async def iter_api_posts(
    client,
    handle: str,
    *,
    cache: Optional[EntityCache] = None,
    limit: Optional[int] = None,
    min_id: Optional[int] = None,
    start_before: Optional[int] = None,
    delay: float = _CHUNK_DELAY_S,
    chunk: int = _CHUNK,
) -> AsyncIterator[Post]:
    """Yield a channel/group's messages newest -> oldest via the API.

    ``limit`` caps the total posts yielded; ``min_id`` stops before
    that post id (incremental: only posts newer than the stored
    newest); ``start_before`` starts below that post id (backfill: one
    block below the stored oldest). These mirror
    :func:`tbi.scrape.walk`'s parameters, so the API command can offer
    the same modes (new-only / backfill / full).

    ``cache`` is the persistent entity cache
    (:mod:`tbi.entity_cache`): a cached handle is used WITHOUT any
    resolve call (an InputChannel built from the stored id + access
    hash); only a cache miss calls ``ResolveUsernameRequest`` — once —
    and stores the result. Without a cache the behaviour is exactly
    as before (resolve every time).

    Flood waits (Telegram's rate limit) are honoured: an exception
    with a ``seconds`` attribute (Telethon's ``FloodWaitError``) pauses
    the chunk — capped at ``_MAX_FLOOD_WAIT_S`` — and the chunk is
    retried from the same offset (idempotent: the store upserts by
    (source, post id)). After ``_CHUNK_RETRIES`` failed retries the
    error is re-raised and the run records it per-channel.

    A flood wait on the RESOLVE itself raises
    :class:`tbi.entity_cache.ResolveFloodWait` — it is NOT retried
    here: a resolve flood-wait is account-wide and long, so the
    caller (``tbi api-backfill``) stops the whole run instead of
    trying the next source.

    A stale cached entry (``ChannelInvalidError`` on use — the stored
    id + access hash no longer resolves) is dropped, the handle is
    re-resolved ONCE, the cache is updated, and the chunk is retried
    once with the fresh entity. Never a loop.
    """
    entity, from_cache = await resolve_entity(client, handle, cache)
    # offset_id must NEVER be None: real Telethon's iterator does
    # offset_id = max(offset_id, max_id) with max_id defaulting to 0,
    # so offset_id=None raises TypeError: '>' not supported between
    # instances of 'int' and 'NoneType' on the first chunk of every
    # channel (v0.4.2 bug — the first api-backfill run failed on all
    # 43 channels in ~90s). offset_id=0 is Telethon's "no offset"
    # (start from the newest message), which is what None meant here.
    offset: int = start_before if start_before is not None else 0
    yielded = 0
    re_resolved = False
    while True:
        # Fetch one chunk, retrying it after a flood wait.
        msgs: list = []
        for attempt in range(_CHUNK_RETRIES + 1):
            try:
                msgs = []
                async for m in client.iter_messages(
                    entity, offset_id=offset, limit=chunk
                ):
                    msgs.append(m)
                break
            except Exception as exc:  # flood wait, stale entry, or a real failure
                if (
                    _is_channel_invalid(exc)
                    and from_cache
                    and not re_resolved
                ):
                    # Stale cached entry: the stored id + access hash
                    # no longer resolves. Drop it, re-resolve once,
                    # and retry this chunk with the fresh entity.
                    if cache is not None:
                        cache.drop(handle)
                    print(
                        f"[stale] @{handle}: cached entity is stale — "
                        "re-resolving once.",
                        flush=True,
                    )
                    entity, from_cache = await resolve_entity(
                        client, handle, cache
                    )
                    re_resolved = True
                    continue
                seconds = getattr(exc, "seconds", None)
                if seconds is None or attempt == _CHUNK_RETRIES:
                    raise
                await asyncio.sleep(min(float(seconds), _MAX_FLOOD_WAIT_S))
        if not msgs:
            return
        for m in msgs:
            if min_id is not None and int(m.id) <= min_id:
                return
            yield _post_from_message(handle, m)
            yielded += 1
            if limit is not None and yielded >= limit:
                return
        offset = min(int(m.id) for m in msgs)
        if len(msgs) < chunk:
            return  # end of history: the last chunk came back short
        if delay:
            await asyncio.sleep(delay)
