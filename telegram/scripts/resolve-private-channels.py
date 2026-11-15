#!/usr/bin/env python3
"""Resolve the 4 joined private Telegram channels to entity-cache entries.

Why this exists
---------------
The owner joined 4 private (invite-only) Telegram channels (2026-11-14)
that must be indexed, but their invite links cannot go into
``channels.yaml`` as channel entries: ``normalize_link`` strips
``https://t.me/+S6gyO92-YHE-mMPs`` to the username ``+S6gyO92-YHE-mMPs``,
and Telethon ``get_entity`` cannot resolve that (it is not a valid
username). See ``~/workspace/rlibook-private-channels-backfill-blocker.md``.

The fix (Option A in that note): resolve each channel's NUMERIC entity
id + access hash ONCE, by calling Telethon ``get_entity`` with the FULL
invite URL (Telethon recognises it — ``parse_username`` returns
``(hash, is_join_chat=True)`` — and ``CheckChatInviteRequest`` returns
the chat when the account is already a member), then store the result
in ``telegram/entity-cache.json`` under a stable name. Later,
``tbi api-backfill --channel <name>`` resolves from the cache with NO
network call (``EntityCache.lookup`` + ``InputChannel``).

The 4 channels (KAYY's AUDIO LIBRARY is EXCLUDED permanently — it is
audio, not books — and is deliberately absent here):
  jami-al-kutub-al-musawwara  جامع الكتب المصورة      https://t.me/+S6gyO92-YHE-mMPs
  bookstoragebox              Bookstoragebox          https://t.me/+G2jHzF0MfaQ1ZWRi
  dar-maana                   دار معنى                https://t.me/+g8Z5W9H1-nA4ZTQy
  al-suhuf-wal-majallat-al-ajnabiya  الصحف والمجلات الأجنبية  https://t.me/+GtdlNb08E9FjMDVk

The cache keys above are the names the future ``channels.yaml`` group
entries MUST use (the ``name:`` field), so that
``tbi api-backfill --channel <name>`` finds them: ``find_config_entry``
matches a group by its config ``name``, and the cache lookup is the
lowercased name (``EntityCache._normalize_handle``). These slugs match
the project's group-page slugs.

How to run it
-------------
Normally via the one-off GitHub Actions workflow
``.github/workflows/resolve-private-channels.yml`` (workflow_dispatch):
it installs the indexer, runs this script with the repo secrets, and
commits the updated ``telegram/entity-cache.json`` back to main.

Locally (owner only, never in CI — the script needs the session):
    cd telegram
    pip install -e ".[api]"
    export TELEGRAM_API_ID=... TELEGRAM_API_HASH=... TELEGRAM_SESSION_STRING=...
    python3 scripts/resolve-private-channels.py

Idempotent: re-running re-resolves and overwrites the same 4 keys
(fresh ``resolved_at``); the cache file keeps its other entries.

Privacy
-------
Credentials come ONLY from environment variables (the indexer's
``load_api_credentials`` — values are never logged). This script
prints each channel's title, numeric id and access hash — an access
hash is NOT a secret (useless without the session; see the
``entity_cache`` module docstring). It NEVER prints or writes the
session string, api_id or api_hash.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

# The tbi package lives in telegram/ (the parent of this scripts/ dir).
# Insert it so the script works both installed (pip install -e ".[api]")
# and straight from a checkout.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tbi.api_history import create_client, load_api_credentials  # noqa: E402
from tbi.entity_cache import EntityCache  # noqa: E402

# (cache key / future channels.yaml group name, display title, invite URL)
CHANNELS: tuple[tuple[str, str, str], ...] = (
    (
        "jami-al-kutub-al-musawwara",
        "جامع الكتب المصورة",
        "https://t.me/+S6gyO92-YHE-mMPs",
    ),
    (
        "bookstoragebox",
        "Bookstoragebox",
        "https://t.me/+G2jHzF0MfaQ1ZWRi",
    ),
    (
        "dar-maana",
        "دار معنى",
        "https://t.me/+g8Z5W9H1-nA4ZTQy",
    ),
    (
        "al-suhuf-wal-majallat-al-ajnabiya",
        "الصحف والمجلات الأجنبية",
        "https://t.me/+GtdlNb08E9FjMDVk",
    ),
)

DEFAULT_CACHE = Path(__file__).resolve().parent.parent / "entity-cache.json"


def _flood_wait_seconds(exc) -> float | None:
    """Seconds of a Telethon FloodWaitError, or None (duck-typed)."""
    seconds = getattr(exc, "seconds", None)
    if seconds is None:
        return None
    try:
        return float(seconds)
    except (TypeError, ValueError):
        return None


def _is_user_entity(entity) -> bool:
    """True when the resolved entity is a person (duck-typed)."""
    return type(entity).__name__ == "User"


async def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Resolve the 4 joined private channels to entity-cache "
            "entries (see the module docstring)."
        )
    )
    parser.add_argument(
        "--cache",
        type=Path,
        default=DEFAULT_CACHE,
        help="entity-cache.json to update (default: telegram/entity-cache.json)",
    )
    args = parser.parse_args()

    try:
        api_id, api_hash, session = load_api_credentials()
    except Exception as exc:  # ApiCredentialsError — message has no values
        print(f"Error: {exc}", file=sys.stderr)
        return 2

    cache = EntityCache.load(args.cache)
    print(f"[resolve] cache: {args.cache} ({len(cache)} entries before)")

    client = create_client(api_id, api_hash, session)
    await client.start()
    resolved = updated = failed = 0
    try:
        for key, title, invite_url in CHANNELS:
            before = cache.lookup(key)
            try:
                # Full invite URL — Telethon recognises it (is_join_chat)
                # and returns the chat when the account is a member.
                # NOTE: do NOT use resolve_entity() here: it would store
                # the entry under the invite URL, not under `key`.
                entity = await client.get_entity(invite_url)
            except Exception as exc:  # noqa: BLE001 - handled below
                seconds = _flood_wait_seconds(exc)
                if seconds is not None:
                    # A resolve flood-wait is account-wide: stop now.
                    print(
                        f"[resolve] {title}: FLOOD WAIT — a wait of "
                        f"{seconds:g} seconds is required. Stopping "
                        "immediately (do not retry until it expires).",
                        file=sys.stderr,
                    )
                    return 2
                print(
                    f"[resolve] {title} ({key}): FAILED — "
                    f"{type(exc).__name__}: {exc}",
                    file=sys.stderr,
                )
                failed += 1
                continue
            if _is_user_entity(entity):
                print(
                    f"[resolve] {title} ({key}): FAILED — resolved to a "
                    "personal chat, refusing (never cached, never read).",
                    file=sys.stderr,
                )
                failed += 1
                continue
            entry = cache.store(key, entity)
            if entry is None:
                print(
                    f"[resolve] {title} ({key}): FAILED — no usable "
                    "numeric id on the resolved entity.",
                    file=sys.stderr,
                )
                failed += 1
                continue
            # An access hash is NOT a secret (useless without the
            # session) — printing id + hash is how the run is checked.
            status = "new" if before is None else "updated"
            if before is None:
                resolved += 1
            else:
                updated += 1
            print(
                f"[resolve] {title} [{key}] ({status}): "
                f"id={entry['id']} access_hash={entry['access_hash']} "
                f"type={entry['type']}"
            )
    finally:
        await client.disconnect()

    print(
        f"[resolve] done: {resolved} new, {updated} updated, "
        f"{failed} failed; cache now holds {len(cache)} entries "
        f"({args.cache})."
    )
    if failed:
        print(
            "[resolve] Some channels failed — the cache keeps the ones "
            "that resolved. Re-run after fixing the cause (a 'not a "
            "member' error means the indexer session is not in that "
            "channel).",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
