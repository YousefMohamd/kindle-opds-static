"""Frequent new-only check — the deployable real-time path.

Runs every 5 minutes from GitHub Actions (``telegram-realtime`` workflow)
and checks every configured channel/group for posts newer than the last
check, using the Telegram API (``tbi.api_history.iter_api_posts`` with
``min_id``). New book posts are written to the bot Worker's Durable
Object live-additions key (``live:additions``) immediately — so the
bot's /resources and search see them without waiting for a Pages
deploy — and the per-source cursor (``live:cursor``) is saved so the
next run only fetches posts newer than this one.

Why the API and not the public preview: the preview (t.me/s/) cannot
see groups at all (168 of the 219 sources), and checking 219 sources
sequentially through the preview takes ~4-7 minutes — longer than the
5-minute interval. The API reads both channels and groups, one call
per source when nothing is new (~0.5s each, ~2 minutes for all 219),
and ``iter_api_posts`` already honours flood waits. The API route is
the same approved route as the manual backfill (GitHub Actions secrets,
never in the repo); this only reads new posts, never personal chats.

Latency: cron (up to 5 min) + check (~1-2 min) + DO write (~instant)
= ~5-7 minutes worst case. That is the best polling can do — it does
NOT meet the strict 1-minute goal. The true 1-minute path is the
Telethon listener (``tbi.listener``), which sees a new post the moment
Telegram delivers it (~2 seconds). This check is the safety net that
catches anything the listener missed (e.g. while it was down) and the
primary path until a host for the listener is approved.

Durability: this check does NOT commit ``index.db`` (the runner is
ephemeral and committing every 5 minutes would flood the repo). The
books are in the DO immediately (visible) and the daily sync (03:00 UTC)
re-discovers the same new posts from the committed index.db and
commits them durably. The DO append dedupes by book id, so a book
found by both this check and the daily sync is never counted twice.

Hardening (v4.8.63 — run #632): the check loads the persistent
entity cache (``entity-cache.json`` next to channels.yaml) and
passes it to ``iter_api_posts``, so a cached handle is used WITHOUT
any ``ResolveUsernameRequest`` (before this, every run resolved
all ~219 handles and Telegram flood-limited the resolves); a
resolve flood wait stops the run immediately instead of burning
~50 minutes source by source; the books + cursor + scan record
are written in ONE atomic batch PUT (``tbi.live.put_live_batch``)
instead of two separate PUTs; and every run writes a
``$GITHUB_STEP_SUMMARY`` summary plus a ``LIVE_SYNC_SUMMARY``
JSON line, with a flood-blind warning when >30% of sources were
skipped.

Usage (GitHub Actions — secrets from the repo settings)::

    TELEGRAM_API_ID=... TELEGRAM_API_HASH=... TELEGRAM_SESSION_STRING=... \
    LIVE_SYNC_TOKEN=... \
    python -m tbi.live_sync --config channels.yaml

``LIVE_SYNC_TOKEN`` is the shared secret for the bot Worker's
``/api/live-state`` endpoint (the same value as the Worker's
``LIVE_SYNC_TOKEN`` secret); ``RLIBOOK_BOT_URL`` overrides the bot
Worker URL (default https://rlibook-bot.mohamedyou1357.workers.dev).

``--dry-run`` prints what would be indexed without writing the live state.
``--once`` runs a single check and exits (the default); the workflow
runs it on a cron, so no loop is built in.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from .api_history import (
    create_client,
    iter_api_posts,
    load_api_credentials,
)
from .config import load_config
from .entity_cache import (
    DEFAULT_ENTITY_CACHE,
    EntityCache,
    ResolveFloodWait,
)
from .live import (
    LiveStateClient,
    live_books_from_post,
    live_totals,
    merge_live_books,
    put_live_batch,
    read_cursor,
    read_live,
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
    cache: Optional[EntityCache] = None,
) -> tuple[list[dict[str, Any]], Optional[int]]:
    """New book posts in one source since ``min_id``.

    Returns (books, newest_post_id). ``newest_post_id`` is None when
    the source had no posts at all. A source that fails (flood wait
    exhausted, entity gone) raises — the caller records it and
    continues with the next source. ``cache`` is the persistent
    entity cache (v4.8.63 — the #632 fix): without it every run
    resolves all ~219 handles via ResolveUsernameRequest, and
    Telegram flood-limits THAT (run #632: ~100 channels hit a
    ~50-minute account-level flood wait on resolve).
    """
    books: list[dict[str, Any]] = []
    newest: Optional[int] = None
    async for post in iter_api_posts(
        client, handle, min_id=min_id, limit=limit, cache=cache
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
    cache: Optional[EntityCache] = None,
) -> tuple[list[dict[str, Any]], dict[str, int], list[str], Optional[ResolveFloodWait]]:
    """Check every source for new posts.

    Returns (new_books, updated_cursor, failed_handles,
    resolve_flood). A source with no cursor entry is checked with
    ``min_id=None`` and ``limit=1`` — i.e. only its newest post id
    is recorded as the cursor (seed), and nothing is indexed from
    it (it will be picked up from the next run). Failures are
    recorded per source and never stop the run — EXCEPT a resolve
    flood wait (:class:`ResolveFloodWait`): it is account-wide and
    long, so the run STOPS immediately instead of trying the next
    source (which would hit the same wait and could extend it —
    run #632 burned ~50 minutes this way). The partial results
    collected so far are still returned (and pushed) — the
    unchecked sources keep their old cursor for the next run.
    """
    all_books: list[dict[str, Any]] = []
    new_cursor = dict(cursor)
    failed: list[str] = []
    resolve_flood: Optional[ResolveFloodWait] = None
    for kind, handle, _ in targets:
        min_id = cursor.get(handle)
        try:
            if min_id is None:
                # Seed: record the newest post id, index nothing.
                _, newest = await check_source(
                    client, kind, handle, None, limit=1, cache=cache
                )
                if newest is not None:
                    new_cursor[handle] = newest
                log.info("seeded cursor @%s at %s", handle, newest)
                continue
            books, newest = await check_source(
                client, kind, handle, min_id, cache=cache
            )
            if newest is not None:
                new_cursor[handle] = newest
            if books:
                log.info("@%s: %d new book(s)", handle, len(books))
                all_books.extend(books)
        except ResolveFloodWait as exc:
            # Account-wide resolve flood — stop the whole run now.
            failed.append(handle)
            resolve_flood = exc
            log.error("resolve flood wait (%s); stopping the run", exc)
            break
        except Exception as exc:
            failed.append(handle)
            log.warning("@%s: check failed (%s); will retry next run", handle, exc)
        if delay:
            await asyncio.sleep(delay)
    return all_books, new_cursor, failed, resolve_flood


def _scan_run_id() -> str:
    """Unique id for this scan (GitHub run id when present). It is
    stored in live:last_scan by the batch PUT, so /health and the
    run summary can point at the exact run that last landed."""
    run = os.environ.get("GITHUB_RUN_ID") or "local"
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"{run}-{stamp}"


def _write_summary(
    *,
    scan_run_id: str,
    books: int,
    failed: list[str],
    total_sources: int,
    resolve_flood: Optional[ResolveFloodWait],
    batch: str,
    duration_s: float,
) -> None:
    """Per-run monitoring (v4.8.63, hardening step 3): a markdown
    summary in $GITHUB_STEP_SUMMARY (when running under Actions),
    a machine-readable LIVE_SYNC_SUMMARY JSON line on stdout, and
    a flood-blind warning when >30% of sources were skipped —
    a run that "succeeds" while blind to a third of the catalog
    must not look green. No-op outside Actions for the file part;
    the stdout line is always printed."""
    failed_ratio = len(failed) / max(1, total_sources)
    flood_blind = failed_ratio > 0.30
    summary = {
        "scan_run_id": scan_run_id,
        "books": books,
        "failed": len(failed),
        "failed_handles": failed[:20],
        "total_sources": total_sources,
        "resolve_flood": str(resolve_flood) if resolve_flood else None,
        "batch": batch,
        "duration_s": round(duration_s, 1),
        "flood_blind": flood_blind,
    }
    print(f"LIVE_SYNC_SUMMARY {json.dumps(summary, ensure_ascii=False)}", flush=True)
    if flood_blind:
        print(
            f"::warning::live-sync flood-blind: {len(failed)}/{total_sources} "
            "sources skipped (>30%) — the run cannot see a third of the catalog",
            flush=True,
        )
        log.warning(
            "flood-blind run: %d/%d sources failed", len(failed), total_sources
        )
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not path:
        return
    lines = [
        "## Live sync",
        "",
        f"- Scan: `{scan_run_id}`",
        f"- New books: **{books}**",
        f"- Sources: {total_sources - len(failed)}/{total_sources} checked"
        + (f" ({len(failed)} failed)" if failed else ""),
        f"- Resolve flood: {'YES — run stopped early' if resolve_flood else 'no'}",
        f"- Batch write: {batch}",
        f"- Duration: {duration_s:.1f}s",
    ]
    if flood_blind:
        lines.append("")
        lines.append(
            "> ⚠️ **Flood-blind:** more than 30% of sources were skipped — "
            "treat this run's coverage as partial."
        )
    if failed:
        lines.append("")
        lines.append("Failed sources: " + ", ".join("@" + h for h in failed[:20]))
    try:
        with open(path, "a", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
    except OSError as exc:
        log.warning("could not write $GITHUB_STEP_SUMMARY: %s", exc)


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

    store: Optional[LiveStateClient] = None
    if not args.dry_run:
        try:
            store = LiveStateClient()
        except RuntimeError as exc:
            print(f"Error: {exc}", file=sys.stderr)
            return 2

    # Cursor: DO first, else seed from the committed index.db.
    # NOTE (v4.8.63 fix): the seed used to rebind `store` itself
    # to the DB Store — which has no get/put — so on a run with
    # an empty DO cursor the later write_cursor crashed with
    # AttributeError. The DB store now lives in its own variable
    # and `store` stays the LiveStateClient.
    cursor: dict[str, int] = {}
    if store is not None:
        cursor = read_cursor(store)
    if not cursor and not args.no_db:
        try:
            db_store = Store(args.db or cfg.settings.db)
            cursor = seed_cursor_from_db(db_store, targets)
            log.info("seeded cursor from index.db: %d sources", len(cursor))
        except Exception as exc:
            log.warning("could not seed cursor from index.db: %s", exc)

    # Entity cache (v4.8.63, step 5): the persistent
    # entity-cache.json next to channels.yaml — a cached handle is
    # used WITHOUT any ResolveUsernameRequest. Without it every run
    # resolves all ~219 handles and Telegram flood-limits the
    # resolves (run #632: ~100 channels hit a ~50-minute
    # account-level flood wait on resolve). A missing file just
    # means an empty cache (EntityCache.load never raises).
    cache_path = Path(args.config).parent / DEFAULT_ENTITY_CACHE
    cache = EntityCache.load(str(cache_path))
    log.info("entity cache: %d entries from %s", len(cache), cache_path)

    started = time.monotonic()
    scan_run_id = _scan_run_id()
    await client.connect()
    try:
        if not await client.is_user_authorized():
            print("Error: Telegram session is not authorized.", file=sys.stderr)
            return 2
        books, new_cursor, failed, resolve_flood = await run_check(
            client, targets, cursor, dry_run=args.dry_run, cache=cache
        )
    finally:
        await client.disconnect()
    duration_s = time.monotonic() - started

    if args.dry_run:
        print(f"dry-run: {len(books)} new book(s) in {len(targets)} sources")
        for b in books[:20]:
            print(f"  {b['title']} — {b['author'] or '?'} [{b['format']}] @{b['source']}")
        if failed:
            print(f"failed sources ({len(failed)}): {', '.join('@' + h for h in failed)}")
        if resolve_flood is not None:
            print(f"resolve flood: {resolve_flood}")
        return 0

    # Atomic batch write (v4.8.63, step 2): the merged additions
    # + the new cursor + the scan record land in ONE DO
    # transaction. ALWAYS write — even with zero new books the
    # cursor must advance and live:last_scan must update, or
    # /health goes stale on a quiet run. On a resolve flood the
    # partial results still land (unchecked sources keep their
    # old cursor for the next run).
    batch = "skipped-no-store"
    if store is not None:
        current = read_live(store)
        merged = merge_live_books(current["books"], books)
        value = {
            "since": current.get("since") or _now_iso(),
            "books": merged,
            "totals": live_totals(merged),
        }
        try:
            atomic = put_live_batch(
                store,
                value,
                new_cursor,
                scan_run_id,
                stats={
                    "books_added": len(books),
                    "failed_sources": len(failed),
                    "total_sources": len(targets),
                    "resolve_flood": resolve_flood is not None,
                },
            )
            batch = "atomic" if atomic else "fallback-sequential"
            log.info(
                "pushed %d new book(s) to the DO live-additions "
                "(live total now %d, batch: %s)",
                len(books),
                len(merged),
                batch,
            )
        except Exception as exc:
            log.error("live-state batch PUT failed: %s", exc)
            print(f"Error: live-state batch PUT failed: {exc}", file=sys.stderr)
            _write_summary(
                scan_run_id=scan_run_id,
                books=len(books),
                failed=failed,
                total_sources=len(targets),
                resolve_flood=resolve_flood,
                batch="failed",
                duration_s=duration_s,
            )
            return 1
    if failed:
        log.warning("failed sources this run: %s", ", ".join(failed))
    _write_summary(
        scan_run_id=scan_run_id,
        books=len(books),
        failed=failed,
        total_sources=len(targets),
        resolve_flood=resolve_flood,
        batch=batch,
        duration_s=duration_s,
    )
    print(
        f"live-sync OK: {len(books)} new book(s), "
        f"{len(failed)} failed source(s), cursor saved (batch: {batch})."
    )
    if resolve_flood is not None:
        print(
            f"::error::live-sync stopped early: resolve flood wait ({resolve_flood})",
            file=sys.stderr,
        )
        return 1
    return 0


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Frequent new-only check: index new book posts from "
        "every channel/group into the DO live-additions (5-minute cron)."
    )
    parser.add_argument("--config", default="channels.yaml")
    parser.add_argument("--db", default=None, help="index.db path (default: from config)")
    parser.add_argument("--no-db", action="store_true", help="do not read index.db for the seed cursor")
    parser.add_argument("--dry-run", action="store_true", help="print what would be indexed, write nothing")
    args = parser.parse_args(argv)
    return asyncio.run(amain(args))


if __name__ == "__main__":
    raise SystemExit(main())
