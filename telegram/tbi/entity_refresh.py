"""Weekly entity-cache refresh (sync-fix v2, 2026-11-24).

Re-resolves every STALE cache entry (older than ENTITY_TTL_DAYS,
oldest first) inside a bounded budget, using the REALTIME session
under the DO lease — so it can never run at the same time as a
realtime scan (same session, same account). Run by the weekly
workflow (telegram-entity-refresh.yml, Sundays 04:00 UTC); the
workflow commits entity-cache.json ONLY when it changed, and
regenerates telegram/sql/entities.sql alongside (tbi.d1_entities
export) so the D1 table can be refreshed with one wrangler call.

This is the FULL sweep behind live_sync's opportunistic refresh:
live_sync re-resolves a few stale entries per run from its
LEFTOVER budget; this job spends a large budget (default 100) once
a week, so entries the in-run path never reaches — handles removed
from channels.yaml, entries that kept failing — are still retried
regularly instead of rotting forever.

Usage (GitHub Actions — the realtime session's three secrets)::

    TELEGRAM_API_ID=... TELEGRAM_API_HASH=... TELEGRAM_SESSION_STRING=... \
    LIVE_SYNC_TOKEN=... \
    python -m tbi.entity_refresh --config channels.yaml --budget 100

Exit codes: 0 ok (even when some entries failed — they are
recorded and retried next week), 1 a resolve flood stopped the
run (partial refresh kept), 2 bad usage / unauthorised session,
3 refused to start (lease live, or both session secrets hold the
same value). No new secrets, no new session: the refresh borrows
the realtime session sequentially, never simultaneously.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
from pathlib import Path
from typing import Optional

from .api_history import SESSION_ENV, create_client, load_api_credentials
from .config import load_config
from .entity_cache import (
    DEFAULT_ENTITY_CACHE,
    ENTITY_TTL_DAYS,
    EntityCache,
    ResolveBudget,
    ResolveFloodWait,
)
from .live import LiveStateClient
from .live_sync import _scan_run_id, refresh_stale_entries
from .session_guard import (
    EXIT_REFUSED,
    SessionRefused,
    acquire_lease,
    check_sessions_distinct,
    release_lease,
)

log = logging.getLogger("tbi.entity_refresh")


async def amain(args: argparse.Namespace) -> int:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    try:
        cfg = load_config(args.config)
    except (FileNotFoundError, ValueError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2
    try:
        session_env = check_sessions_distinct()
    except SessionRefused as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return EXIT_REFUSED
    if session_env != SESSION_ENV:
        print(
            f"Error: refusing to run the refresh with {session_env} — "
            "the refresh uses the realtime session only.",
            file=sys.stderr,
        )
        return 2
    try:
        api_id, api_hash, session = load_api_credentials(os.environ)
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2
    try:
        client = create_client(api_id, api_hash, session)
    except RuntimeError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2

    store: Optional[LiveStateClient] = None
    try:
        store = LiveStateClient()
    except RuntimeError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2

    cache_path = Path(args.config).parent / DEFAULT_ENTITY_CACHE
    cache = EntityCache.load(str(cache_path))
    due = cache.refresh_due(limit=args.budget)
    log.info("entity cache: %d entries, %d stale (TTL %d days)",
             len(cache), len(due), ENTITY_TTL_DAYS)
    if not due:
        print("entity-refresh: nothing stale — cache is fresh.")
        return 0

    scan_run_id = _scan_run_id()
    lease_held = False
    try:
        acquire_lease(store, "entity-refresh", scan_run_id)
        lease_held = True
    except SessionRefused as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return EXIT_REFUSED
    except Exception as exc:
        print(
            f"::warning::lease unavailable ({exc}) — proceeding "
            "without the DO lease; the workflow's own concurrency "
            "group still applies",
            flush=True,
        )

    budget = ResolveBudget(args.budget)
    await client.connect()
    refreshed = 0
    failed: list[str] = []
    flood: Optional[ResolveFloodWait] = None
    try:
        if not await client.is_user_authorized():
            print("Error: Telegram session is not authorized.", file=sys.stderr)
            return 2
        refreshed, failed = await refresh_stale_entries(client, cache, budget)
    except ResolveFloodWait as exc:
        flood = exc
        log.error("resolve flood wait during refresh (%s); stopping", exc)
    finally:
        await client.disconnect()
        if lease_held:
            release_lease(store, scan_run_id)

    print(f"entity-refresh: {refreshed} refreshed, {len(failed)} failed "
          f"(cache now {len(cache)} entries)")
    if failed:
        print("failed: " + ", ".join("@" + h for h in failed[:20]))
    if flood is not None:
        print(f"::error::entity-refresh stopped early: resolve flood ({flood})",
              file=sys.stderr)
        return 1
    return 0


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Weekly entity-cache refresh: re-resolve stale "
        "entries (TTL 30 days, oldest first) inside a bounded "
        "budget, under the DO lease."
    )
    parser.add_argument("--config", default="channels.yaml")
    parser.add_argument("--budget", type=int, default=100,
                        help="max fresh resolves this run (default 100)")
    args = parser.parse_args(argv)
    return asyncio.run(amain(args))


if __name__ == "__main__":
    raise SystemExit(main())
