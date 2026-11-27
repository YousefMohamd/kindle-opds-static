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

Sync-fix v2 (2026-11-24, this file) — the radical fixes:
  * TRIGGER OF TRUTH: the YAML ``*/5`` schedule is GONE. The
    only trigger is the 10-minute dispatcher cron (Muse cron
    rlibook-realtime-trigger), which skips a dispatch while the
    previous run is in_progress. A second trigger can no longer
    queue an overlapping identical scan on top of the ~10.75-min
    worst-case scan. The workflow ALSO fails fast when another
    run of itself is in_progress, and the run claims a DO lease
    (tbi.session_guard) before connecting.
  * TWO SESSIONS: this workflow uses TELEGRAM_SESSION_STRING
    only; newspapers uses TELEGRAM_SESSION_STRING_NEWS (a
    separate auth key, owner-generated). The guard refuses to
    start when both secrets hold the same value, and the lease
    refuses a second simultaneous session of either role.
  * RESOLVE BUDGET: at most 8 fresh resolves per run (misses
    first, stale refresh with what is left). Past the budget a
    source is SKIPPED (cursor kept), never resolved — a run can
    no longer spend its way into a resolve FloodWait.
  * ENTITY AUTO-REFRESH: entries older than 30 days are
    re-resolved oldest-first inside the leftover budget, so the
    cache heals itself; the workflow commits entity-cache.json
    ONLY when it changed. The D1 `entities` table
    (tbi.d1_entities) is the durable numeric-id truth.
  * RUN DEADLINE + CHECKPOINTS: the scan stops at 480 s and
    pushes its partial results (a chunk FloodWait used to stall
    a run past the job timeout and lose everything in memory);
    every 60 sources the partial batch is pushed, so a crash
    loses at most one checkpoint window.
  * OUTBOX: every book found is enqueued with a sequence number
    (tbi.outbox). A failed batch PUT saves the outbox to
    live-outbox.jsonl (committed by the workflow's failure-save
    step); the next run replays it before scanning. The 500-book
    live window is now lossy ONLY for display — the outbox is
    the lossless record, paginated by seq cursor.
  * CATCH-UP: --catch-up re-scans the sources the last scan
    recorded as failed (from live:last_scan) with a wider window,
    so a missed range is replayed instead of silently skipped.
  * FLOODWAIT, VERIFIED END TO END (2026-11-24): resolve flood
    -> ResolveFloodWait -> run_check stops -> partial results
    pushed -> exit 1. Chunk flood -> capped 300 s sleep, 3
    retries, then per-source failure (run continues). The new
    deadline is the third leg: even a run stuck in chunk
    retries pushes partial results instead of dying silent.

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
``--catch-up`` re-scans only the sources the last scan failed, then
runs the normal check for the rest.
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
    SESSION_ENV,
    create_client,
    iter_api_posts,
    load_api_credentials,
)
from .config import load_config
from .entity_cache import (
    DEFAULT_ENTITY_CACHE,
    DEFAULT_RESOLVE_BUDGET,
    ENTITY_TTL_DAYS,
    EntityCache,
    ResolveBudget,
    ResolveBudgetExhausted,
    ResolveFloodWait,
    refresh_entry,
)
from .live import (
    LiveStateClient,
    assign_seq,
    live_books_from_post,
    live_totals,
    merge_live_books_with_dropped,
    put_live_batch,
    read_cursor,
    read_live,
    read_outbox,
)
from .outbox import (
    enqueue,
    load_outbox_file,
    outbox_document,
    prune_outbox,
    replay_outbox,
    save_outbox_file,
)
from .session_guard import (
    EXIT_REFUSED,
    EXIT_SKIPPED,
    LeaseHeld,
    SessionRefused,
    acquire_lease,
    check_sessions_distinct,
    release_lease,
)
from .store import Store

log = logging.getLogger("tbi.live_sync")

# Small pause between sources so the API is not hammered; the
# per-source call is one chunk when nothing is new.
SOURCE_DELAY_S = 0.3
# Cap per source per run (a flood of new posts is still bounded).
MAX_NEW_PER_SOURCE = 50
# Run deadline (sync-fix v2): a scan that runs past this stops and
# pushes its partial results. The job timeout is 10 min; 480 s
# leaves ~2 min for the final batch PUT + lease release. Without
# it, a run stuck in chunk-flood retries (300 s sleep x 3) dies on
# the job timeout with everything still only in memory.
SCAN_DEADLINE_S = 480
# Checkpoint cadence (sync-fix v2): push the partial batch after
# this many sources, so a crash loses at most one window. A batch
# PUT is 3 DO rows — 4 checkpoints/run is ~12 rows against the
# 100k/day DO cap: negligible.
CHECKPOINT_EVERY_SOURCES = 60
# Outbox file (sync-fix v2): the repo-file copy, written ONLY when
# the DO push fails; the workflow's failure-save step commits it,
# the next run replays it. Lives next to channels.yaml.
DEFAULT_OUTBOX_FILE = "live-outbox.jsonl"


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
    budget: Optional[ResolveBudget] = None,
) -> tuple[list[dict[str, Any]], Optional[int]]:
    """New book posts in one source since ``min_id``.

    Returns (books, newest_post_id). ``newest_post_id`` is None when
    the source had no posts at all. A source that fails (flood wait
    exhausted, entity gone) raises — the caller records it and
    continues with the next source. ``cache`` is the persistent
    entity cache (v4.8.63 — the #632 fix): without it every run
    resolves all ~219 handles via ResolveUsernameRequest, and
    Telegram flood-limits THAT (run #632: ~100 channels hit a
    ~50-minute account-level flood wait on resolve). ``budget``
    (sync-fix v2) caps fresh resolves: past the budget a cache
    miss raises ResolveBudgetExhausted instead of resolving.
    """
    books: list[dict[str, Any]] = []
    newest: Optional[int] = None
    async for post in iter_api_posts(
        client, handle, min_id=min_id, limit=limit, cache=cache, budget=budget
    ):
        if newest is None or post.post_id > newest:
            newest = post.post_id
        books.extend(live_books_from_post(post, kind))
    return books, newest


class ScanResult:
    """Everything one scan learned (sync-fix v2 — run_check_v2's
    return value). run_check keeps the old 4-tuple for the
    pre-existing tests; new code uses this."""

    def __init__(self):
        self.books: list[dict[str, Any]] = []
        self.cursor: dict[str, int] = {}
        self.failed: list[str] = []
        self.budget_skipped: list[str] = []
        self.resolve_flood: Optional[ResolveFloodWait] = None
        self.deadline_hit: bool = False
        self.sources_checked: int = 0


async def refresh_stale_entries(client, cache: EntityCache,
                                budget: ResolveBudget,
                                handles=None) -> tuple[int, list[str]]:
    """Opportunistically re-resolve stale cache entries (sync-fix
    v2): oldest first, inside the LEFTOVER budget after the scan.
    Returns (refreshed_count, failed_handles). A resolve flood
    here propagates as ResolveFloodWait — the caller stops the
    run the same way as a scan-time flood (the refresh is not
    worth a flooded account)."""
    refreshed = 0
    failed: list[str] = []
    due = cache.refresh_due(handles, limit=budget.remaining)
    for handle in due:
        if budget.exhausted:
            break
        budget.try_acquire()
        try:
            await refresh_entry(client, handle, cache)
            refreshed += 1
        except ResolveFloodWait:
            raise
        except Exception as exc:
            failed.append(handle)
            log.warning("@%s: stale refresh failed (%s)", handle, exc)
    return refreshed, failed


def find_gaps(last_scan: Optional[dict], cursor: dict[str, int],
              targets: list[tuple[str, str, str]]) -> list[str]:
    """Handles the last scan recorded as failed (sync-fix v2,
    catch-up input). ``last_scan`` is the live:last_scan document
    (its stats carry failed_handles). Unknown handles are ignored
    — a renamed source is not a gap. Returns the failed handles
    that are still configured targets, in config order."""
    if not isinstance(last_scan, dict):
        return []
    failed = last_scan.get("failed_handles")
    if not isinstance(failed, list):
        return []
    wanted = {str(h).lstrip("@") for h in failed if isinstance(h, str)}
    return [handle for _, handle, _ in targets if handle in wanted]


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


async def run_check_v2(
    client,
    targets: list[tuple[str, str, str]],
    cursor: dict[str, int],
    *,
    delay: float = SOURCE_DELAY_S,
    dry_run: bool = False,
    cache: Optional[EntityCache] = None,
    budget: Optional[ResolveBudget] = None,
    deadline_s: Optional[float] = None,
    limit: int = MAX_NEW_PER_SOURCE,
    on_checkpoint=None,
    clock=None,
) -> ScanResult:
    """Check every source for new posts (sync-fix v2).

    Returns a ScanResult. Failures are recorded per source and
    never stop the run — EXCEPT a resolve flood wait
    (:class:`ResolveFloodWait`): it is account-wide and long, so
    the run STOPS immediately instead of trying the next source
    (which would hit the same wait and could extend it — run #632
    burned ~50 minutes this way). The partial results collected
    so far are still returned (and pushed) — the unchecked sources
    keep their old cursor for the next run.

    New in v2:
      * ``budget`` — past the resolve budget a source is SKIPPED
        (budget_skipped), never resolved. A skip is not a failure:
        the cursor is kept and the source is retried next run.
      * ``deadline_s`` — seconds after which the scan stops and
        returns its partial results (deadline_hit). Without it a
        run stuck in chunk-flood retries dies on the job timeout
        with everything still only in memory.
      * ``on_checkpoint`` — called as
        ``await on_checkpoint(books_so_far, cursor_so_far,
        sources_done)`` every CHECKPOINT_EVERY_SOURCES sources
        (and only when at least one new book was found since the
        last checkpoint): the caller pushes the partial batch, so
        a crash loses at most one checkpoint window.
      * ``clock`` — injectable time source (default
        time.monotonic), a test seam so the deadline is provable
        without sleeping.
    """
    result = ScanResult()
    result.cursor = dict(cursor)
    clock = clock or time.monotonic
    started = clock()
    since_checkpoint = 0
    for kind, handle, _ in targets:
        if deadline_s is not None and (clock() - started) > deadline_s:
            result.deadline_hit = True
            log.warning(
                "scan deadline (%.0fs) hit after %d/%d sources — "
                "pushing partial results",
                deadline_s, result.sources_checked, len(targets),
            )
            break
        result.sources_checked += 1
        min_id = result.cursor.get(handle)
        try:
            if min_id is None:
                # Seed: record the newest post id, index nothing.
                _, newest = await check_source(
                    client, kind, handle, None, limit=1, cache=cache,
                    budget=budget,
                )
                if newest is not None:
                    result.cursor[handle] = newest
                log.info("seeded cursor @%s at %s", handle, newest)
                continue
            books, newest = await check_source(
                client, kind, handle, min_id, limit=limit, cache=cache,
                budget=budget,
            )
            if newest is not None:
                result.cursor[handle] = newest
            if books:
                log.info("@%s: %d new book(s)", handle, len(books))
                result.books.extend(books)
                since_checkpoint += len(books)
        except ResolveFloodWait as exc:
            # Account-wide resolve flood — stop the whole run now.
            result.failed.append(handle)
            result.resolve_flood = exc
            log.error("resolve flood wait (%s); stopping the run", exc)
            break
        except ResolveBudgetExhausted as exc:
            # Budget spent — skip, do NOT resolve, keep the cursor.
            result.budget_skipped.append(handle)
            log.warning("@%s: skipped (%s)", handle, exc)
        except Exception as exc:
            result.failed.append(handle)
            log.warning("@%s: check failed (%s); will retry next run", handle, exc)
        if (
            on_checkpoint is not None
            and since_checkpoint > 0
            and result.sources_checked % CHECKPOINT_EVERY_SOURCES == 0
        ):
            await on_checkpoint(
                list(result.books), dict(result.cursor),
                result.sources_checked,
            )
            since_checkpoint = 0
        if delay:
            await asyncio.sleep(delay)
    return result


async def run_check(
    client,
    targets: list[tuple[str, str, str]],
    cursor: dict[str, int],
    *,
    delay: float = SOURCE_DELAY_S,
    dry_run: bool = False,
    cache: Optional[EntityCache] = None,
) -> tuple[list[dict[str, Any]], dict[str, int], list[str], Optional[ResolveFloodWait]]:
    """Check every source for new posts — the pre-v2 4-tuple
    interface, kept for the existing tests. New code uses
    run_check_v2 (budget, deadline, checkpoints, budget_skipped).
    With no budget passed, resolves are unbounded (the old
    behaviour) — amain always passes one."""
    result = await run_check_v2(
        client, targets, cursor, delay=delay, dry_run=dry_run, cache=cache,
    )
    return result.books, result.cursor, result.failed, result.resolve_flood


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
    budget_skipped: Optional[list[str]] = None,
    deadline_hit: bool = False,
    refreshed: int = 0,
    outbox_pending: int = 0,
    catch_up: Optional[list[str]] = None,
) -> None:
    """Per-run monitoring (v4.8.63, hardening step 3): a markdown
    summary in $GITHUB_STEP_SUMMARY (when running under Actions),
    a machine-readable LIVE_SYNC_SUMMARY JSON line on stdout, and
    a flood-blind warning when >30% of sources were skipped —
    a run that "succeeds" while blind to a third of the catalog
    must not look green. No-op outside Actions for the file part;
    the stdout line is always printed.

    Sync-fix v2 adds: budget_skipped (sources skipped for the
    resolve budget — counted as skipped for the flood-blind ratio,
    they are blind spots too), deadline_hit, cache entries
    refreshed, outbox entries still pending, and the catch-up list.
    """
    skipped = list(failed) + list(budget_skipped or [])
    failed_ratio = len(set(skipped)) / max(1, total_sources)
    flood_blind = failed_ratio > 0.30
    summary = {
        "scan_run_id": scan_run_id,
        "books": books,
        "failed": len(failed),
        "failed_handles": failed[:20],
        "budget_skipped": len(budget_skipped or []),
        "budget_skipped_handles": list(budget_skipped or [])[:20],
        "deadline_hit": deadline_hit,
        "cache_refreshed": refreshed,
        "outbox_pending": outbox_pending,
        "catch_up": list(catch_up or []),
        "total_sources": total_sources,
        "resolve_flood": str(resolve_flood) if resolve_flood else None,
        "batch": batch,
        "duration_s": round(duration_s, 1),
        "flood_blind": flood_blind,
    }
    print(f"LIVE_SYNC_SUMMARY {json.dumps(summary, ensure_ascii=False)}", flush=True)
    if flood_blind:
        print(
            f"::warning::live-sync flood-blind: {len(set(skipped))}/{total_sources} "
            "sources skipped (>30%) — the run cannot see a third of the catalog",
            flush=True,
        )
        log.warning(
            "flood-blind run: %d/%d sources failed", len(set(skipped)), total_sources
        )
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not path:
        return
    lines = [
        "## Live sync",
        "",
        f"- Scan: `{scan_run_id}`",
        f"- New books: **{books}**",
        f"- Sources: {total_sources - len(set(skipped))}/{total_sources} checked"
        + (f" ({len(set(skipped))} skipped)" if skipped else ""),
        f"- Resolve flood: {'YES — run stopped early' if resolve_flood else 'no'}",
        f"- Deadline hit: {'YES — partial results pushed' if deadline_hit else 'no'}",
        f"- Resolve budget skipped: {len(budget_skipped or [])}",
        f"- Entity cache refreshed: {refreshed}",
        f"- Outbox pending: {outbox_pending}",
        f"- Batch write: {batch}",
        f"- Duration: {duration_s:.1f}s",
    ]
    if catch_up:
        lines.append(f"- Catch-up re-scanned: {', '.join('@' + h for h in catch_up)}")
    if flood_blind:
        lines.append("")
        lines.append(
            "> ⚠️ **Flood-blind:** more than 30% of sources were skipped — "
            "treat this run's coverage as partial."
        )
    if failed:
        lines.append("")
        lines.append("Failed sources: " + ", ".join("@" + h for h in failed[:20]))
    if budget_skipped:
        lines.append("")
        lines.append(
            "Budget-skipped sources (retried next run): "
            + ", ".join("@" + h for h in list(budget_skipped)[:20])
        )
    try:
        with open(path, "a", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
    except OSError as exc:
        log.warning("could not write $GITHUB_STEP_SUMMARY: %s", exc)


def _push_batch(store, books, cursor, scan_run_id, stats,
                pending_outbox):
    """Push one batch (final or checkpoint) and maintain the outbox.

    Reads the current live additions, merges ``books`` (newest
    first, dedupe by id), assigns sequence numbers, and writes
    the atomic batch (additions + cursor + scan record + outbox
    document) in one DO transaction. Books the 500-cap drops are
    ENQUEUED into the outbox (the lossless record) — the cap is
    lossy for display only now. Returns (batch_label, merged,
    dropped, updated_pending_outbox). Raises on write failure —
    the caller saves the outbox to the repo file instead.
    """
    current = read_live(store)
    merged, dropped = merge_live_books_with_dropped(current["books"], books)
    seq_start = 0
    if pending_outbox:
        seq_start = max(int(e.get("seq") or 0) for e in pending_outbox)
    numbered = assign_seq(books, seq_start + 1)
    # The outbox keeps ONLY what the live window could not hold
    # (dropped by the cap) plus what was already pending and has
    # not landed yet. Books that landed in live:additions need no
    # outbox copy — replaying them would duplicate the window.
    # (Pending entries whose books ARE in this merged window are
    # cleared: they landed.)
    landed_ids = {b.get("id") for b in merged}
    pending = prune_outbox(
        [e for e in pending_outbox
         if (e.get("book") or {}).get("id") not in landed_ids]
    )
    dropped_numbered = [b for b in numbered if b.get("id") in
                        {d.get("id") for d in dropped}]
    pending = enqueue(dropped_numbered, pending, scan_run_id)
    value = {
        "since": current.get("since") or _now_iso(),
        "books": merged,
        "totals": live_totals(merged),
    }
    atomic = put_live_batch(
        store, value, cursor, scan_run_id, stats=stats,
        outbox=outbox_document(pending),
    )
    return ("atomic" if atomic else "fallback-sequential"), merged, dropped, pending


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

    # Session guard, layer 1 (sync-fix v2): the two session secrets
    # must not hold the same value, and this workflow uses its OWN
    # session (TELEGRAM_SESSION_STRING). A same-value refusal exits
    # 3 (a real misconfiguration, not a skip).
    try:
        session_env = check_sessions_distinct()
    except SessionRefused as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return EXIT_REFUSED
    try:
        api_id, api_hash, session = load_api_credentials(
            os.environ, session_env=session_env
        )
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
    # Sync-fix v2: the cache now ALSO auto-refreshes (stale entries
    # re-resolved inside the leftover budget, below) and the
    # workflow commits the file ONLY when it changed.
    cache_path = Path(args.config).parent / DEFAULT_ENTITY_CACHE
    cache = EntityCache.load(str(cache_path))
    log.info("entity cache: %d entries from %s", len(cache), cache_path)
    cache_before = len(cache)

    # Outbox replay (sync-fix v2): books a previous run could not
    # push (DO push failed, or the 500-cap dropped them) are
    # replayed FIRST — merged into this run's books and cursor —
    # so no book waits more than one tick. Sources: the DO copy
    # (when the companion Worker patch is live) + the repo file
    # (failure-save commits). Either copy is enough; both are
    # deduped by book id on merge.
    outbox_path = Path(args.config).parent / (args.outbox or DEFAULT_OUTBOX_FILE)
    pending_outbox: list[dict[str, Any]] = []
    replayed_books: list[dict[str, Any]] = []
    outbox_read = 0
    if store is not None:
        try:
            pending_outbox = read_outbox(store)
        except Exception as exc:
            log.warning("could not read DO outbox (%s) — using the file copy", exc)
    file_outbox = load_outbox_file(outbox_path)
    outbox_read = len(pending_outbox) + len(file_outbox)
    seen_ids = {(e.get("book") or {}).get("id") for e in pending_outbox}
    for entry in file_outbox:
        if (entry.get("book") or {}).get("id") not in seen_ids:
            pending_outbox.append(entry)
            seen_ids.add((entry.get("book") or {}).get("id"))
    if pending_outbox:
        replayed_books, cursor, pending_outbox = replay_outbox(
            pending_outbox, [], cursor
        )
        log.info("outbox replay: %d book(s) re-queued from %d entr(ies)",
                 len(replayed_books), outbox_read)

    # Catch-up (sync-fix v2): --catch-up re-scans the sources the
    # LAST scan recorded as failed (live:last_scan stats), with a
    # wider per-source window, BEFORE the normal check — a missed
    # range is replayed instead of silently skipped.
    catch_up_handles: list[str] = []
    if args.catch_up and store is not None:
        try:
            raw = store.get("live:last_scan")
            last_scan = json.loads(raw) if raw else None
            catch_up_handles = find_gaps(last_scan, cursor, targets)
        except Exception as exc:
            log.warning("could not read live:last_scan for catch-up: %s", exc)
    if catch_up_handles:
        log.info("catch-up: re-scanning %d failed source(s): %s",
                 len(catch_up_handles), ", ".join("@" + h for h in catch_up_handles))

    # Session guard, layer 2 (sync-fix v2): claim the DO lease
    # before connecting. A live lease held by another run refuses
    # this run (exit 0 — a quiet skip, not a failure; the next
    # tick retries). When the Worker answers 400 the lease
    # key is not deployed yet — warn and proceed: the dispatcher
    # + workflow in_progress checks still apply.
    scan_run_id = _scan_run_id()
    lease_held = False
    if store is not None and not args.no_lease:
        try:
            acquire_lease(store, "realtime", scan_run_id)
            lease_held = True
            log.info("lease acquired (realtime, %s)", scan_run_id)
        except LeaseHeld as exc:
            print(f"Error: {exc}", file=sys.stderr)
            return EXIT_SKIPPED
        except SessionRefused as exc:
            print(f"Error: {exc}", file=sys.stderr)
            return EXIT_REFUSED
        except Exception as exc:
            print(
                f"::warning::lease unavailable ({exc}) — proceeding "
                "without the DO lease; dispatcher + workflow guards apply",
                flush=True,
            )

    budget = ResolveBudget(args.resolve_budget)
    started = time.monotonic()
    books: list[dict[str, Any]] = list(replayed_books)
    new_cursor = dict(cursor)
    failed: list[str] = []
    budget_skipped: list[str] = []
    resolve_flood: Optional[ResolveFloodWait] = None
    deadline_hit = False
    refreshed = 0
    batch = "skipped-no-store"

    async def _checkpoint(books_so_far, cursor_so_far, sources_done):
        """Push the partial batch (sync-fix v2): a crash loses at
        most one checkpoint window. Best-effort — a failed
        checkpoint only logs; the final push (or the outbox file)
        still covers these books."""
        nonlocal batch, pending_outbox
        if store is None:
            return
        try:
            label, _, _, pending_outbox = _push_batch(
                store, list(books_so_far), dict(cursor_so_far),
                scan_run_id,
                stats={
                    "books_added": len(books_so_far),
                    "failed_sources": 0,
                    "total_sources": len(targets),
                    "resolve_flood": False,
                    "checkpoint": sources_done,
                },
                pending_outbox=pending_outbox,
            )
            batch = label
            log.info("checkpoint after %d sources: partial batch pushed (%s)",
                     sources_done, label)
        except Exception as exc:
            log.warning("checkpoint push failed (%s) — final push still covers it", exc)

    await client.connect()
    try:
        if not await client.is_user_authorized():
            print("Error: Telegram session is not authorized.", file=sys.stderr)
            return 2
        scan_targets = targets
        if catch_up_handles:
            gap = [t for t in targets if t[1] in catch_up_handles]
            rest = [t for t in targets if t[1] not in catch_up_handles]
            gap_result = await run_check_v2(
                client, gap, new_cursor, delay=0, cache=cache,
                budget=budget, deadline_s=args.deadline,
                limit=args.catch_up_limit,
            )
            books.extend(gap_result.books)
            new_cursor = gap_result.cursor
            failed.extend(gap_result.failed)
            budget_skipped.extend(gap_result.budget_skipped)
            if gap_result.resolve_flood is not None:
                resolve_flood = gap_result.resolve_flood
            deadline_hit = deadline_hit or gap_result.deadline_hit
            scan_targets = rest
        if resolve_flood is None and not deadline_hit:
            result = await run_check_v2(
                client, scan_targets, new_cursor, cache=cache,
                budget=budget, deadline_s=args.deadline,
                on_checkpoint=None if args.dry_run else _checkpoint,
            )
            books.extend(result.books)
            new_cursor = result.cursor
            failed.extend(result.failed)
            budget_skipped.extend(result.budget_skipped)
            if result.resolve_flood is not None:
                resolve_flood = result.resolve_flood
            deadline_hit = deadline_hit or result.deadline_hit
        # Stale-entry refresh (sync-fix v2): oldest first, inside
        # the LEFTOVER budget. A flood here stops the run the same
        # way as a scan-time flood — the refresh is never worth a
        # flooded account.
        if resolve_flood is None and budget.remaining > 0:
            try:
                refreshed, refresh_failed = await refresh_stale_entries(
                    client, cache, budget
                )
                failed.extend(refresh_failed)
                if refreshed:
                    log.info("entity cache: %d stale entr(ies) refreshed", refreshed)
            except ResolveFloodWait as exc:
                resolve_flood = exc
                log.error("resolve flood wait during refresh (%s); stopping", exc)
    finally:
        await client.disconnect()
        if lease_held and store is not None:
            release_lease(store, scan_run_id)
    duration_s = time.monotonic() - started

    if args.dry_run:
        print(f"dry-run: {len(books)} new book(s) in {len(targets)} sources")
        for b in books[:20]:
            print(f"  {b['title']} — {b['author'] or '?'} [{b['format']}] @{b['source']}")
        if failed:
            print(f"failed sources ({len(failed)}): {', '.join('@' + h for h in failed)}")
        if budget_skipped:
            print(f"budget-skipped ({len(budget_skipped)}): {', '.join('@' + h for h in budget_skipped)}")
        if resolve_flood is not None:
            print(f"resolve flood: {resolve_flood}")
        return 0

    # Atomic batch write (v4.8.63, step 2): the merged additions
    # + the new cursor + the scan record land in ONE DO
    # transaction. ALWAYS write — even with zero new books the
    # cursor must advance and live:last_scan must update, or
    # /health goes stale on a quiet run. On a resolve flood the
    # partial results still land (unchecked sources keep their
    # old cursor for the next run). Sync-fix v2: the batch ALSO
    # carries the outbox document; on a push FAILURE the books
    # are saved to the repo-file outbox instead (the workflow's
    # failure-save step commits it, the next run replays it).
    if store is not None:
        stats = {
            "books_added": len(books),
            "failed_sources": len(failed),
            "total_sources": len(targets),
            "resolve_flood": resolve_flood is not None,
            "budget_skipped": len(budget_skipped),
            "deadline_hit": deadline_hit,
            "cache_refreshed": refreshed,
            "failed_handles": failed[:20],
        }
        try:
            batch, merged, dropped, pending_outbox = _push_batch(
                store, books, new_cursor, scan_run_id, stats, pending_outbox
            )
            log.info(
                "pushed %d new book(s) to the DO live-additions "
                "(live total now %d, batch: %s, cap-dropped %d -> outbox, "
                "outbox pending %d)",
                len(books), len(merged), batch, len(dropped), len(pending_outbox),
            )
            # A landed batch clears the file copy: its books are
            # in the DO now (or in the DO outbox). The empty file
            # commits cleanly and the next run reads [].
            save_outbox_file(outbox_path, [])
        except Exception as exc:
            log.error("live-state batch PUT failed: %s", exc)
            print(f"Error: live-state batch PUT failed: {exc}", file=sys.stderr)
            # Outbox file fallback: everything found this run,
            # plus what was already pending, is saved for replay.
            # Sequence numbers continue from the pending outbox's
            # max seq — they must never restart at 1, or a replay
            # could order (or dedupe) two different books as one.
            seq_start = max(
                (int(e.get("seq") or 0) for e in pending_outbox), default=0
            )
            seq_books = assign_seq(books, seq_start + 1)
            file_entries = enqueue(
                [b for b in seq_books if b.get("id")],
                pending_outbox, scan_run_id,
            )
            try:
                save_outbox_file(outbox_path, file_entries)
                log.info("outbox file saved: %d entr(ies) for replay next run",
                         len(file_entries))
                pending_outbox = file_entries
            except OSError as save_exc:
                log.error("could not save outbox file: %s", save_exc)
            _write_summary(
                scan_run_id=scan_run_id,
                books=len(books),
                failed=failed,
                total_sources=len(targets),
                resolve_flood=resolve_flood,
                batch="failed",
                duration_s=duration_s,
                budget_skipped=budget_skipped,
                deadline_hit=deadline_hit,
                refreshed=refreshed,
                outbox_pending=len(pending_outbox),
                catch_up=catch_up_handles,
            )
            return 1
    if failed:
        log.warning("failed sources this run: %s", ", ".join(failed))
    if budget_skipped:
        log.warning("budget-skipped sources this run: %s", ", ".join(budget_skipped))
    if len(cache) != cache_before:
        log.info("entity cache changed: %d -> %d entries (workflow commits it)",
                 cache_before, len(cache))
    _write_summary(
        scan_run_id=scan_run_id,
        books=len(books),
        failed=failed,
        total_sources=len(targets),
        resolve_flood=resolve_flood,
        batch=batch,
        duration_s=duration_s,
        budget_skipped=budget_skipped,
        deadline_hit=deadline_hit,
        refreshed=refreshed,
        outbox_pending=len(pending_outbox),
        catch_up=catch_up_handles,
    )
    print(
        f"live-sync OK: {len(books)} new book(s), "
        f"{len(failed)} failed source(s), {len(budget_skipped)} budget-skipped, "
        f"cursor saved (batch: {batch})."
    )
    if deadline_hit:
        print(
            "::warning::live-sync hit its scan deadline — partial results "
            "pushed; unchecked sources keep their old cursor for next run",
            flush=True,
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
        "every channel/group into the DO live-additions (10-minute "
        "dispatcher trigger — the YAML schedule was removed in "
        "sync-fix v2; see the workflow file)."
    )
    parser.add_argument("--config", default="channels.yaml")
    parser.add_argument("--db", default=None, help="index.db path (default: from config)")
    parser.add_argument("--no-db", action="store_true", help="do not read index.db for the seed cursor")
    parser.add_argument("--dry-run", action="store_true", help="print what would be indexed, write nothing")
    parser.add_argument("--catch-up", action="store_true",
                        help="first re-scan the sources the last scan recorded as failed (live:last_scan), then run the normal check")
    parser.add_argument("--catch-up-limit", type=int, default=200,
                        help="max new posts per source on the catch-up pass (default 200)")
    parser.add_argument("--resolve-budget", type=int, default=DEFAULT_RESOLVE_BUDGET,
                        help="max fresh username resolves per run; past it, sources are skipped, never resolved (default 8)")
    parser.add_argument("--deadline", type=float, default=SCAN_DEADLINE_S,
                        help="scan deadline in seconds; the scan stops and pushes partial results past it (default 480)")
    parser.add_argument("--outbox", default=None,
                        help="outbox file name next to channels.yaml (default live-outbox.jsonl)")
    parser.add_argument("--no-lease", action="store_true",
                        help="do not claim the DO lease (debugging only — never in the workflow)")
    args = parser.parse_args(argv)
    return asyncio.run(amain(args))


if __name__ == "__main__":
    raise SystemExit(main())
