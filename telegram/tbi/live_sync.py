"""Frequent new-only check — the deployable real-time path.

Runs every 5 minutes from GitHub Actions (``telegram-realtime`` workflow)
and checks every configured channel/group for posts newer than the last
check, using the Telegram API (``tbi.api_history.iter_api_posts`` with
``min_id``). New book posts are written to the KV live-additions key
(``live:additions``) immediately — so the bot's /resources and search
see them without waiting for a Pages deploy — and the per-source cursor
(``live:cursor``) is saved so the next run only fetches posts newer
than this one.

Why the API and not the public preview: the preview (t.me/s/) cannot
see groups at all (168 of the 219 sources), and checking 219 sources
sequentially through the preview takes ~4-7 minutes — longer than the
5-minute interval. The API reads both channels and groups, one call
per source when nothing is new (~0.5s each, ~2 minutes for all 219),
and ``iter_api_posts`` already honours flood waits. The API route is
the same approved route as the manual backfill (GitHub Actions secrets,
never in the repo); this only reads new posts, never personal chats.

Latency: cron (up to 5 min) + check (~1-2 min) + KV write (~instant)
= ~5-7 minutes worst case. That is the best polling can do — it does
NOT meet the strict 1-minute goal. The true 1-minute path is the
Telethon listener (``tbi.listener``), which sees a new post the moment
Telegram delivers it (~2 seconds). This check is the safety net that
catches anything the listener missed (e.g. while it was down) and the
primary path until a host for the listener is approved.

Durability: this check does NOT commit ``index.db`` (the runner is
ephemeral and committing every 5 minutes would flood the repo). The
books are in KV immediately (visible) and the daily sync (03:00 UTC)
re-discovers the same new posts from the committed index.db and
commits them durably. The KV append dedupes by book id, so a book
found by both this check and the daily sync is never counted twice.

Usage (GitHub Actions — secrets from the repo settings)::

    TELEGRAM_API_ID=... TELEGRAM_API_HASH=... TELEGRAM_SESSION_STRING=... \
    CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... RLIBOOK_KV_ID=... \
    python -m tbi.live_sync --config channels.yaml

``--dry-run`` prints what would be indexed without writing KV.
``--once`` runs a single check and exits (the default); the workflow
runs it on a cron, so no loop is built in.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from datetime import datetime, timezone
from typing import Any, Optional

from .api_history import (
    create_client,
    iter_api_posts,
    load_api_credentials,
)
from .config import load_config
from .live import (
    CloudflareKV,
    append_live_books,
    live_books_from_post,
    read_cursor,
    read_live,
    write_cursor,
)
from .store import Store

log = logging.getLogger("tbi.live_sync")

# Small pause between sources so the API is not hammered; the
# per-source call is one chunk when nothing is new.
SOURCE_DELAY_S = 0.3
# Cap per source per run (a flood of new posts is still bounded).
MAX_NEW_PER_SOURCE = 50


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def check_source(
    client,
    kind: str,
    handle: str,
    min_id: Optional[int],
    *,
    limit: int = MAX_NEW_PER_SOURCE,
) -> tuple[list[dict[str, Any]], Optional[int]]:
    """New book posts in one source since ``min_id``.

    Returns (books, newest_post_id). ``newest_post_id`` is None when
    the source had no posts at all. A source that fails (flood wait
    exhausted, entity gone) raises — the caller records it and
    continues with the next source.
    """
    books: list[dict[str, Any]] = []
    newest: Optional[int] = None
    async for post in iter_api_posts(
        client, handle, min_id=min_id, limit=limit
    ):
        if newest is None or post.post_id > newest:
            newest = post.post_id
        books.extend(live_books_from_post(post, kind))
    return books, newest


def seed_cursor_from_db(store: Store, targets) -> dict[str, int]:
    """Initial cursor from the committed index.db: {handle: newest}.

    Used on the first run (no KV cursor yet) so the check does not
    re-index old posts. Sources absent from the DB are omitted (the
    caller seeds them from the live newest post instead).
    """
    cursor: dict[str, int] = {}
    for kind, handle, _ in targets:
        row = store.get_source(handle)
        if row is not None:
            newest = row["newest_post_id"]
            if newest:
                cursor[handle] = int(newest)
    return cursor


async def run_check(
    client,
    targets: list[tuple[str, str, str]],
    cursor: dict[str, int],
    *,
    delay: float = SOURCE_DELAY_S,
    dry_run: bool = False,
) -> tuple[list[dict[str, Any]], dict[str, int], list[str]]:
    """Check every source for new posts.

    Returns (new_books, updated_cursor, failed_handles). A source with
    no cursor entry is checked with ``min_id=None`` and ``limit=1`` —
    i.e. only its newest post id is recorded as the cursor (seed), and
    nothing is indexed from it (it will be picked up from the next
    run). Failures are recorded per source and never stop the run.
    """
    all_books: list[dict[str, Any]] = []
    new_cursor = dict(cursor)
    failed: list[str] = []
    for kind, handle, _ in targets:
        min_id = cursor.get(handle)
        try:
            if min_id is None:
                # Seed: record the newest post id, index nothing.
                _, newest = await check_source(
                    client, kind, handle, None, limit=1
                )
                if newest is not None:
                    new_cursor[handle] = newest
                log.info("seeded cursor @%s at %s", handle, newest)
                continue
            books, newest = await check_source(client, kind, handle, min_id)
            if newest is not None:
                new_cursor[handle] = newest
            if books:
                log.info("@%s: %d new book(s)", handle, len(books))
                all_books.extend(books)
        except Exception as exc:
            failed.append(handle)
            log.warning("@%s: check failed (%s); will retry next run", handle, exc)
        if delay:
            await asyncio.sleep(delay)
    return all_books, new_cursor, failed


async def amain(args: argparse.Namespace) -> int:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    try:
        cfg = load_config(args.config)
    except (FileNotFoundError, ValueError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2
    targets = [("channel", e.username, e.label) for e in cfg.channels]
    targets += [("group", e.name, e.label) for e in cfg.groups]
    if not targets:
        print(f"Error: no sources configured in {args.config}", file=sys.stderr)
        return 2
    try:
        api_id, api_hash, session = load_api_credentials()
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2
    try:
        client = create_client(api_id, api_hash, session)
    except RuntimeError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2

    kv: Optional[CloudflareKV] = None
    if not args.dry_run:
        try:
            kv = CloudflareKV()
        except RuntimeError as exc:
            print(f"Error: {exc}", file=sys.stderr)
            return 2

    # Cursor: KV first, else seed from the committed index.db.
    cursor: dict[str, int] = {}
    if kv is not None:
        cursor = read_cursor(kv)
    if not cursor and not args.no_db:
        try:
            store = Store(args.db or cfg.settings.db)
            cursor = seed_cursor_from_db(store, targets)
            log.info("seeded cursor from index.db: %d sources", len(cursor))
        except Exception as exc:
            log.warning("could not seed cursor from index.db: %s", exc)

    await client.connect()
    try:
        if not await client.is_user_authorized():
            print("Error: Telegram session is not authorized.", file=sys.stderr)
            return 2
        books, new_cursor, failed = await run_check(
            client, targets, cursor, dry_run=args.dry_run
        )
    finally:
        await client.disconnect()

    if args.dry_run:
        print(f"dry-run: {len(books)} new book(s) in {len(targets)} sources")
        for b in books[:20]:
            print(f"  {b['title']} — {b['author'] or '?'} [{b['format']}] @{b['source']}")
        if failed:
            print(f"failed sources ({len(failed)}): {', '.join('@' + h for h in failed)}")
        return 0

    if books and kv is not None:
        value = append_live_books(kv, books)
        log.info(
            "pushed %d new book(s) to KV live-additions "
            "(live total now %d)",
            len(books),
            len(value["books"]),
        )
    if kv is not None:
        write_cursor(kv, new_cursor)
    if failed:
        log.warning("failed sources this run: %s", ", ".join(failed))
    print(
        f"live-sync OK: {len(books)} new book(s), "
        f"{len(failed)} failed source(s), cursor saved."
    )
    return 0


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Frequent new-only check: index new book posts from "
        "every channel/group into KV live-additions (5-minute cron)."
    )
    parser.add_argument("--config", default="channels.yaml")
    parser.add_argument("--db", default=None, help="index.db path (default: from config)")
    parser.add_argument("--no-db", action="store_true", help="do not read index.db for the seed cursor")
    parser.add_argument("--dry-run", action="store_true", help="print what would be indexed, write nothing")
    args = parser.parse_args(argv)
    return asyncio.run(amain(args))


if __name__ == "__main__":
    raise SystemExit(main())
