"""Nov 19-23 hole re-read (2026-11-26) — MTProto history re-read into D1.

Why this exists
---------------
Books posted 2026-11-19 .. 2026-11-24T07:40Z are in NEITHER D1 nor the
Durable Object live window:

* D1's one-shot delta completed 2026-11-22 with MAX(date)=2026-11-18;
  no incremental importer was ever scheduled, so 0 rows exist with
  date >= 2026-11-19 (verified live 2026-11-26).
* The realtime writer (``tbi.live_sync``) DID see those books and put
  them in DO ``live:additions`` — but that key is a 500-book rolling
  window, and by 2026-11-26 it holds only Nov 24-26 books (oldest
  2026-11-24T07:52:16Z). The Nov 19-23 books aged out of it.
* The public preview (t.me/s) cannot recover them: since ~Nov 22-23
  it renders no document blocks at all (0 files), and it never saw
  groups anyway.

The only remaining source is the Telegram history itself, read through
the same MTProto session the realtime sync uses (``iter_api_posts``).
This script re-reads, per source, the posts between the live cursor
(newest post id as of the last pre-outage scan, 2026-11-24 07:40:28Z)
and 2026-11-19T00:00:00Z, turns the book files into catalog rows with
the exact same record builders the realtime path uses
(``live_books_from_post``), and emits D1 SQL batches via
``d1_sync.batch_sql``. It writes NO D1 rows itself: the batches are
files, applied by a separate, reviewed step (workflow ``execute_d1``
input, or the operator from the VM). Default mode is dry-run: fetch
and generate, write nothing to D1.

Safety rules (do not weaken)
----------------------------
* MAIN session, ALONE. The script claims the DO lease
  (``live:lease``, holder ``hole-reread``) BEFORE connecting and
  releases it in ``finally``. It is FAIL-CLOSED, unlike
  ``live_sync``'s fail-open fallback: when the Worker answers 400
  (lease key not deployed) the script ABORTS (exit 2) instead of
  proceeding unguarded — a long exclusive hold without a lease is
  exactly what killed the session on 2026-11-24. When the lease is
  held by another run it exits 3 (skip, not failure).
* The script NEVER writes ``live:additions`` or ``live:cursor``.
  It only reads them (cursor = window upper bound; additions = a
  belt-and-braces dedupe set). Pushing ~1,100 recovered books into
  the 500-cap live window would evict the Nov 24-26 books, which
  are not in D1 either.
* Dedupe is by the D1 unique key ``(url, filename)``:
  within-run, against ``--existing-keys`` (the workflow gate dumps
  D1's window rows into that file first), against the live window,
  and finally by ``INSERT OR IGNORE`` in the generated SQL. A
  re-run after a partial import inserts nothing twice.
* Dates are normalised to ``YYYY-MM-DD`` (UTC), the format every
  existing D1 row uses. ``--start-id`` MUST come from a live
  ``MAX(id)+1`` query (``d1_sync_meta.next_free_id`` is stale:
  422454 vs real MAX(id) 422850 after the Nov 23 Drive import).
* No index.db, shard, or repo writes. No file/email sends of any
  kind. Metadata only, configured sources only, same privacy model
  as ``tbi api-backfill``.

Usage (from ``telegram/``, GitHub Actions; secrets from the env)
----------------------------------------------------------------
  python -m tbi.hole_reread --config channels.yaml \
      --start-id 422851 --out-dir hole-out
  # dry-run (default): fetch + generate hole-out/*.sql + report.
  # The workflow then applies the batches only when dispatched
  # with execute_d1=true; see .github/workflows/telegram-hole-reread.yml.

Exit codes: 0 ok, 1 failed run, 2 bad usage / fail-closed lease
unavailable, 3 refused (lease held by another run — skip, retry later).
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
from .d1_sync import batch_sql, estimate_row_writes, state_key
from .entity_cache import (
    DEFAULT_ENTITY_CACHE,
    DEFAULT_RESOLVE_BUDGET,
    EntityCache,
    ResolveBudget,
    ResolveBudgetExhausted,
    ResolveFloodWait,
)
from .live import LiveStateClient, live_books_from_post, read_cursor
from .session_guard import (
    EXIT_REFUSED,
    EXIT_SKIPPED,
    LeaseHeld,
    SessionRefused,
    acquire_lease,
    check_sessions_distinct,
    release_lease,
)

log = logging.getLogger("tbi.hole_reread")

# The hole, fixed by the evidence (see PLAN.md in
# ~/workspace/tmp-fox/nov19-23-hole/): books posted from Nov 19 00:00Z
# until the last pre-outage realtime scan finished (Nov 24 07:40:28Z).
# Posts AFTER the end are realtime's job (cursor-based, already covered).
WINDOW_START_DEFAULT = "2026-11-19T00:00:00Z"
WINDOW_END_DEFAULT = "2026-11-24T07:40:28Z"

# One lease for the whole run: the session must not be shared while
# this process is connected. 90 min covers the estimated 15-35 min
# fetch with ~3x margin; on a crash the lease expires on its own and
# realtime resumes (bounded freeze, never a permanent block).
LEASE_TTL_SECONDS = 90 * 60
LEASE_HOLDER = "hole-reread"

# Per-source backstop: no source posted anywhere near this many book
# posts in 5 days (busiest groups are ~50-150); the date break below
# is the real stop, this only bounds a pathological walk.
PER_SOURCE_LIMIT = 2000
# Fetch deadline (default 60 min): stop with partial results instead
# of dying on the job timeout with everything only in memory. The
# partial run still writes its artifacts + per-source status, so a
# second dispatch resumes the unchecked sources (dedupe makes the
# overlap harmless).
DEADLINE_SECONDS = 3600.0
# D1 batch size, same as the delta (2,000 books per .sql file).
BATCH_SIZE = 2000
# Pause between sources (same courtesy pause as the realtime scan).
SOURCE_DELAY_S = 0.3


class LeaseUnavailable(RuntimeError):
    """The DO lease could not be used at all (Worker 400 etc.).

    Fail-closed: a long exclusive hold without a lease risks the
    AuthKeyDuplicatedError of 2026-11-24, so the run aborts
    instead of proceeding unguarded.
    """


def _parse_ts(value: str) -> datetime:
    """Parse an ISO timestamp; trailing Z becomes +00:00."""
    ts = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return ts


def window_date(iso_text: Optional[str]) -> Optional[str]:
    """UTC ``YYYY-MM-DD`` of an ISO post date (the D1 date format).

    Returns None when the text is missing or unparsable — the caller
    counts that post as skipped, never as in-window.
    """
    if not iso_text:
        return None
    try:
        return _parse_ts(iso_text).date().isoformat()
    except ValueError:
        return None


def in_window(iso_text: Optional[str], start: datetime, end: datetime) -> bool:
    """True when the post date is in [start, end)."""
    if not iso_text:
        return False
    try:
        ts = _parse_ts(iso_text)
    except ValueError:
        return False
    return start <= ts < end


def livebook_to_catalog(book: dict[str, Any]) -> dict[str, Any]:
    """One LiveBook dict -> the catalog-book shape ``d1_sync.batch_sql``
    takes (the same fields ``load_catalog`` builds from shards).

    ``format`` is upper-case in a LiveBook (``PDF``); the catalog
    ``ext`` is lower-case. ``size`` is the human ``size_text``
    (``37.5 MB``), exactly as the shards store it. ``date`` is
    truncated to ``YYYY-MM-DD`` — every existing D1 row uses that
    format, and the window queries (``date >= '2026-11-19'``) rely
    on it.
    """
    date = window_date(book.get("date"))
    return {
        "title": book.get("title") or "",
        "author": book.get("author") or "",
        "filename": book.get("filename") or "",
        "ext": (book.get("format") or "").lower(),
        "size": book.get("size_text") or "",
        "source": book.get("source") or "",
        "kind": book.get("kind") or "channel",
        "date": date or "",
        "url": book.get("url") or "",
    }


def dedupe_books(
    books: list[dict[str, Any]],
    existing_keys: set[str],
) -> tuple[list[dict[str, Any]], int]:
    """Drop books whose ``(url, filename)`` key is already known.

    ``existing_keys`` is the union of the workflow gate's D1 dump
    (keys already in D1 inside the window) and the live window's
    keys. Within-run duplicates are dropped too. Returns
    (kept, n_dropped). Order is preserved (newest first per source
    walk); the SQL layer's ``INSERT OR IGNORE`` is the last guard.
    """
    kept: list[dict[str, Any]] = []
    seen = set(existing_keys)
    dropped = 0
    for b in books:
        key = state_key(livebook_to_catalog(b))
        if key in seen:
            dropped += 1
            continue
        seen.add(key)
        kept.append(b)
    return kept, dropped


def acquire_or_refuse(store, holder: str, run_id: str, ttl_seconds: int) -> dict:
    """Claim the DO lease, fail-closed.

    Returns the lease document. Raises :class:`LeaseHeld`
    (caller exits 0 — a quiet skip) when another run holds a
    live lease, and :class:`LeaseUnavailable` (caller exits 2)
    when the lease cannot be used at all — the run must NOT
    proceed unguarded.
    """
    try:
        return acquire_lease(store, holder, run_id, ttl_seconds)
    except SessionRefused:
        raise
    except Exception as exc:
        raise LeaseUnavailable(
            f"DO lease unavailable ({exc}) — refusing to hold the "
            "session without a lease (AuthKeyDuplicatedError guard, "
            "2026-11-24). If the Worker still answers 400 for "
            "live:lease, the companion patch is not deployed."
        ) from exc


async def reread_source(
    client,
    handle: str,
    kind: str,
    cursor_id: Optional[int],
    start: datetime,
    end: datetime,
    cache: Optional[EntityCache] = None,
    budget: Optional[ResolveBudget] = None,
    limit: int = PER_SOURCE_LIMIT,
    iter_posts=None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Re-read one source's window posts.

    Walks newest -> oldest from just below ``cursor_id`` (the live
    cursor: the newest post id as of the last pre-outage scan) and
    stops at the first post older than ``start`` — post ids grow
    with post dates, so everything after that is older still.
    Returns (books, status) where status carries the per-source
    counts the report needs (posts seen, in-window posts, books,
    skipped-no-date, stopped-early flag).

    ``iter_posts`` is a test seam (default ``iter_api_posts``).
    Raises :class:`ResolveFloodWait` (account-wide: the caller stops
    the whole run) and :class:`ResolveBudgetExhausted` (this source
    only: the caller skips it, cursor kept) like ``check_source``.
    """
    it = iter_posts or iter_api_posts
    books: list[dict[str, Any]] = []
    status = {
        "posts_seen": 0,
        "in_window": 0,
        "books": 0,
        "skipped_no_date": 0,
        "stopped_at_start": False,
        "limit_hit": False,
    }
    async for post in it(
        client, handle, cache=cache, budget=budget,
        limit=limit, start_before=cursor_id,
    ):
        status["posts_seen"] += 1
        if not post.date:
            status["skipped_no_date"] += 1
            continue
        try:
            ts = _parse_ts(post.date)
        except ValueError:
            status["skipped_no_date"] += 1
            continue
        if ts < start:
            status["stopped_at_start"] = True
            break
        if ts >= end:
            # Above the window: a post newer than the cursor bound
            # (should not happen — ids grow with dates — but never
            # trust it; skip, do not count).
            continue
        status["in_window"] += 1
        found = live_books_from_post(post, kind)
        books.extend(found)
        status["books"] += len(found)
        if status["posts_seen"] >= limit:
            status["limit_hit"] = True
            break
    return books, status


def _run_id() -> str:
    """Unique id for this run (GitHub run id when present)."""
    gh = os.environ.get("GITHUB_RUN_ID") or ""
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"{gh}-{stamp}" if gh else f"hole-reread-{stamp}"


def _load_existing_keys(path: Optional[str]) -> set[str]:
    """Load the workflow gate's D1 dump: JSON list of
    ``url|filename`` keys already in D1 inside the window."""
    if not path:
        return set()
    p = Path(path)
    if not p.is_file():
        return set()
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (ValueError, OSError) as exc:
        print(f"Error: cannot read --existing-keys {path}: {exc}", file=sys.stderr)
        raise SystemExit(2)
    if not isinstance(data, list):
        print(f"Error: --existing-keys {path} is not a JSON list", file=sys.stderr)
        raise SystemExit(2)
    return {str(k) for k in data}


async def amain(args: argparse.Namespace, _client=None, _store=None,
                _iter_posts=None) -> int:
    """Async main. ``_client`` / ``_store`` / ``_iter_posts`` are test
    seams (like ``run_check_v2``'s ``clock``); production passes None
    and the real objects are built from the environment.
    """
    try:
        start = _parse_ts(args.window_start)
        end = _parse_ts(args.window_end)
    except ValueError as exc:
        print(f"Error: bad window timestamp: {exc}", file=sys.stderr)
        return 2
    if not start < end:
        print("Error: --window-start must be before --window-end", file=sys.stderr)
        return 2
    if args.start_id < 1:
        print("Error: --start-id must be >= 1 (use live MAX(id)+1)", file=sys.stderr)
        return 2

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

    # Session guard, layer 1: the two session secrets must not hold
    # the same value. (Same check live_sync does first.)
    try:
        session_env = check_sessions_distinct()
    except SessionRefused as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return EXIT_REFUSED

    store = _store
    if store is None:
        try:
            store = LiveStateClient()
        except RuntimeError as exc:
            print(f"Error: {exc}", file=sys.stderr)
            return 2

    existing_keys = _load_existing_keys(args.existing_keys)

    # Live window ids (belt-and-braces dedupe): the window dates do
    # not overlap the live window, so this should add nothing — but
    # if the window ever slides, a recovered book already visible
    # in /new must not be inserted twice.
    try:
        raw_live = store.get("live:additions")
        live_doc = json.loads(raw_live) if raw_live else None
        live_books = (live_doc or {}).get("books") or []
        live_keys = {
            state_key(livebook_to_catalog(b)) for b in live_books
        }
        log.info("live window: %d book(s) read for dedupe", len(live_books))
    except Exception as exc:
        log.warning("could not read live:additions for dedupe (%s) — continuing", exc)
        live_keys = set()
    existing_keys |= live_keys

    # Cursor: the window's upper bound per source. A source with no
    # cursor entry cannot be bounded — skip it (recorded, not silent).
    try:
        cursor = read_cursor(store)
    except Exception as exc:
        print(f"Error: could not read live:cursor: {exc}", file=sys.stderr)
        return 1
    log.info("live cursor: %d source(s)", len(cursor))

    cache_path = Path(args.config).parent / DEFAULT_ENTITY_CACHE
    cache = EntityCache.load(str(cache_path))
    log.info("entity cache: %d entries from %s", len(cache), cache_path)

    # Session guard, layer 2 — FAIL-CLOSED (see module docstring):
    # a live lease held by another run refuses this run (exit 0 —
    # a quiet skip, not a failure); a lease that cannot be used
    # at all aborts it (exit 2).
    run_id = _run_id()
    lease_held = False
    if not args.no_lease:
        try:
            acquire_or_refuse(store, LEASE_HOLDER, run_id, args.lease_ttl)
            lease_held = True
            log.info("lease acquired (hole-reread, %s, ttl %ds)",
                     run_id, args.lease_ttl)
        except LeaseHeld as exc:
            print(f"Error: {exc}", file=sys.stderr)
            return EXIT_SKIPPED
        except SessionRefused as exc:
            print(f"Error: {exc}", file=sys.stderr)
            return EXIT_REFUSED
        except LeaseUnavailable as exc:
            print(f"Error: {exc}", file=sys.stderr)
            return 2

    if _client is not None:
        client = _client
    else:
        try:
            api_id, api_hash, session = load_api_credentials(
                os.environ, session_env=session_env
            )
        except Exception as exc:
            print(f"Error: {exc}", file=sys.stderr)
            if lease_held:
                release_lease(store, run_id)
            return 2
        try:
            client = create_client(api_id, api_hash, session)
        except RuntimeError as exc:
            print(f"Error: {exc}", file=sys.stderr)
            if lease_held:
                release_lease(store, run_id)
            return 2

    budget = ResolveBudget(args.resolve_budget)
    started = time.monotonic()
    books: list[dict[str, Any]] = []
    per_source: dict[str, dict[str, Any]] = {}
    failed: list[str] = []
    budget_skipped: list[str] = []
    no_cursor: list[str] = []
    resolve_flood = None
    deadline_hit = False

    await client.connect()
    try:
        if not await client.is_user_authorized():
            print("Error: Telegram session is not authorized.", file=sys.stderr)
            return 2
        for kind, handle, _label in targets:
            if (time.monotonic() - started) > args.deadline:
                deadline_hit = True
                log.warning("deadline (%.0fs) hit — stopping with partial results",
                            args.deadline)
                break
            cursor_id = cursor.get(handle)
            if cursor_id is None:
                no_cursor.append(handle)
                per_source[handle] = {"status": "no-cursor"}
                log.warning("@%s: no live-cursor entry — skipped", handle)
                continue
            try:
                found, status = await reread_source(
                    client, handle, kind, cursor_id, start, end,
                    cache=cache, budget=budget,
                    limit=args.per_source_limit,
                    iter_posts=_iter_posts,
                )
            except ResolveFloodWait as exc:
                failed.append(handle)
                resolve_flood = exc
                per_source[handle] = {"status": "resolve-flood"}
                log.error("resolve flood wait (%s); stopping the run", exc)
                break
            except ResolveBudgetExhausted as exc:
                budget_skipped.append(handle)
                per_source[handle] = {"status": "budget-skipped"}
                log.warning("@%s: skipped (%s)", handle, exc)
                continue
            except Exception as exc:
                failed.append(handle)
                per_source[handle] = {"status": "failed", "error": str(exc)}
                log.warning("@%s: re-read failed (%s); will retry next run",
                            handle, exc)
                continue
            if found:
                log.info("@%s: %d book(s) in window", handle, len(found))
            books.extend(found)
            per_source[handle] = {"status": "done", **status}
            if args.source_delay:
                await asyncio.sleep(args.source_delay)
    finally:
        await client.disconnect()
        if lease_held:
            release_lease(store, run_id)
            log.info("lease released (%s)", run_id)
    duration_s = time.monotonic() - started

    # Dedupe (D1 unique key) then map to catalog rows.
    kept, n_dup = dedupe_books(books, existing_keys)
    catalog = [livebook_to_catalog(b) for b in kept]

    # Per-date counts (D1 date format) for the report.
    from collections import Counter
    per_date = Counter(b["date"] for b in catalog if b["date"])
    per_source_books = Counter(b["source"] for b in catalog)

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "recovered.jsonl").write_text(
        "".join(json.dumps(b, ensure_ascii=False) + "\n" for b in kept),
        encoding="utf-8",
    )
    # SQL batches, <= BATCH_SIZE books each, ids from --start-id.
    batch_files: list[str] = []
    next_id = args.start_id
    for i in range(0, len(catalog), BATCH_SIZE):
        chunk = catalog[i:i + BATCH_SIZE]
        sql_text, next_id = batch_sql(chunk, next_id)
        name = f"hole-batch-{i // BATCH_SIZE + 1:03d}.sql"
        (out_dir / name).write_text(sql_text, encoding="utf-8")
        batch_files.append(name)
    low, high = estimate_row_writes(len(catalog))

    counts = {
        "window": {"start": args.window_start, "end": args.window_end},
        "run_id": run_id,
        "duration_s": round(duration_s, 1),
        "sources_total": len(targets),
        "sources_done": sum(1 for s in per_source.values()
                            if s.get("status") == "done"),
        "sources_failed": failed,
        "sources_budget_skipped": budget_skipped,
        "sources_no_cursor": no_cursor,
        "resolve_flood": str(resolve_flood) if resolve_flood else None,
        "deadline_hit": deadline_hit,
        "books_found": len(books),
        "books_duplicate_skipped": n_dup,
        "books_recovered": len(kept),
        "per_date": dict(sorted(per_date.items())),
        "per_source_top": dict(per_source_books.most_common(20)),
        "per_source": per_source,
        "start_id": args.start_id,
        "next_free_id_after": next_id,
        "batch_files": batch_files,
        "estimated_d1_row_writes": {"low": low, "high": high,
                                    "daily_budget": 100000},
        "dry_run": args.dry_run,
    }
    (out_dir / "counts.json").write_text(
        json.dumps(counts, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    report_lines = [
        f"# Nov 19-23 hole re-read — {run_id}",
        "",
        f"Window: {args.window_start} .. {args.window_end} (UTC)",
        f"Duration: {duration_s:.0f}s. Sources: {len(targets)} total, "
        f"{counts['sources_done']} done, {len(failed)} failed, "
        f"{len(budget_skipped)} budget-skipped, {len(no_cursor)} no-cursor.",
        f"Books found: {len(books)}; duplicates skipped: {n_dup}; "
        f"recovered (new): {len(kept)}.",
        "",
        "## Per date (D1 date format)",
        "",
    ]
    for d in sorted(per_date):
        report_lines.append(f"- {d}: {per_date[d]}")
    report_lines += [
        "",
        "## D1 batches",
        "",
        f"Start id: {args.start_id}; next free id after: {next_id}.",
        f"Files: {', '.join(batch_files) or '(none — nothing recovered)'}",
        f"Estimated D1 row writes: {low}-{high} (daily budget 100,000).",
        "",
        "## Mode",
        "",
        ("DRY-RUN — batches generated, NOT applied to D1. Apply with "
         "the workflow's execute_d1 input or manually (see PLAN.md)."
         if args.dry_run else
         "Batches generated. The workflow applies them only when "
         "dispatched with execute_d1=true."),
        "",
    ]
    if failed:
        report_lines += ["## Failed sources (retry next run)", ""] + [
            f"- @{h}" for h in failed
        ] + [""]
    if budget_skipped:
        report_lines += ["## Budget-skipped sources", ""] + [
            f"- @{h}" for h in budget_skipped
        ] + [""]
    if no_cursor:
        report_lines += ["## No-cursor sources (cannot bound the window)", ""] + [
            f"- @{h}" for h in no_cursor
        ] + [""]
    if deadline_hit:
        report_lines.append(
            "## Deadline hit — partial results; re-dispatch to resume "
            "(dedupe makes the overlap harmless)."
        )
    (out_dir / "hole-report.md").write_text(
        "\n".join(report_lines), encoding="utf-8"
    )

    print(
        f"hole-reread OK: {len(kept)} recovered book(s) "
        f"({len(books)} found, {n_dup} duplicates skipped), "
        f"{len(failed)} failed source(s), "
        f"{len(budget_skipped)} budget-skipped, "
        f"{len(no_cursor)} no-cursor, "
        f"{len(batch_files)} batch file(s) in {out_dir}."
    )
    if resolve_flood is not None:
        print(
            f"::error::hole-reread stopped early: resolve flood wait "
            f"({resolve_flood})",
            file=sys.stderr,
        )
        return 1
    return 0


def main(argv: Optional[list[str]] = None, **seams) -> int:
    parser = argparse.ArgumentParser(
        description="MTProto history re-read for the Nov 19-23 hole: "
        "per-source window posts -> D1 SQL batches (dry-run default; "
        "writes no D1 rows, no live state — lease-guarded, main "
        "session alone)."
    )
    parser.add_argument("--config", default="channels.yaml")
    parser.add_argument("--window-start", default=WINDOW_START_DEFAULT,
                        help="inclusive window start, ISO UTC "
                        f"(default {WINDOW_START_DEFAULT})")
    parser.add_argument("--window-end", default=WINDOW_END_DEFAULT,
                        help="exclusive window end, ISO UTC "
                        f"(default {WINDOW_END_DEFAULT})")
    parser.add_argument("--start-id", type=int, required=True,
                        help="first D1 id for the batches — REQUIRED, "
                        "from live MAX(id)+1 (d1_sync_meta.next_free_id "
                        "is stale)")
    parser.add_argument("--existing-keys", default=None,
                        help="JSON list of url|filename keys already in "
                        "D1 inside the window (workflow gate dump)")
    parser.add_argument("--out-dir", default="hole-out",
                        help="where recovered.jsonl / counts.json / "
                        "hole-batch-*.sql / hole-report.md go")
    parser.add_argument("--lease-ttl", type=int, default=LEASE_TTL_SECONDS,
                        help="DO lease TTL in seconds (default 5400)")
    parser.add_argument("--no-lease", action="store_true",
                        help="do not claim the DO lease (debugging only "
                        "— never in the workflow)")
    parser.add_argument("--resolve-budget", type=int,
                        default=DEFAULT_RESOLVE_BUDGET,
                        help="max fresh username resolves per run "
                        "(default 8; the entity cache covers all 215)")
    parser.add_argument("--per-source-limit", type=int,
                        default=PER_SOURCE_LIMIT,
                        help="max posts walked per source (default 2000)")
    parser.add_argument("--deadline", type=float, default=DEADLINE_SECONDS,
                        help="fetch deadline in seconds (default 3600)")
    parser.add_argument("--source-delay", type=float, default=SOURCE_DELAY_S,
                        help="pause between sources in seconds "
                        "(default 0.3)")
    parser.add_argument("--dry-run", action="store_true", default=True,
                        help="fetch + generate only (default; the "
                        "script never writes D1 itself)")
    parser.add_argument("--no-dry-run", dest="dry_run", action="store_false",
                        help="mark the artifacts as apply-ready (the "
                        "workflow still applies them separately)")
    args = parser.parse_args(argv)
    return asyncio.run(amain(args, **seams))


if __name__ == "__main__":
    raise SystemExit(main())
