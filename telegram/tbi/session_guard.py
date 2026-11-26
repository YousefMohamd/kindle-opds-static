"""Session guard (sync-fix v2, 2026-11-24) — one Telegram session,
one process at a time.

The 2026-11-24 incident: realtime runs #702+ and newspapers runs
#508+ failed from 07:40 UTC with AuthKeyDuplicatedError — the single
TELEGRAM_SESSION_STRING was used by BOTH workflows (and, during the
owner's QR-login attempts, by extra verification copies), Telegram
revoked the auth key, and every API run died at connect time.

The fix has three layers, and this module is layers 1 and 2:

1. TWO DEDICATED SESSIONS. The realtime workflow reads
   TELEGRAM_SESSION_STRING; the newspapers workflow reads
   TELEGRAM_SESSION_STRING_NEWS. Each is a separate auth key for the
   same account, created by the OWNER with his Telegram code (the
   code never goes through this repo — see gen_session.py, run by
   the owner). The two secrets must never hold the same value: a
   same-value configuration is refused here, before any client is
   built (``check_sessions_distinct``).

2. A DO LEASE. Before connecting, the runner claims
   ``live:lease`` in the bot Worker's Durable Object
   ({holder, run_id, expires_at}) through the same /api/live-state
   endpoint the sync already uses. A second runner with the same
   session role — or any runner while the lease is live — refuses
   to start (exit 3, clear message) instead of connecting and
   risking a second AuthKeyDuplicatedError. The lease expires on
   its own (default 15 min, longer than any healthy scan), so a
   crashed run never blocks the next one forever; the holder
   releases it on a clean exit. The lease is best-effort: it needs
   the companion Worker patch (bot-companion/) that allows the
   ``live:lease`` key — when the Worker answers 400 (key not
   allowed yet) the guard logs a warning and proceeds, because the
   workflow-level guards (layer 3) still apply.

3. WORKFLOW-LEVEL GUARDS (not in this module — see the workflow
   files): the 10-minute dispatcher cron skips a dispatch while
   the previous run is still in_progress; each workflow's first
   step fails fast when another run of the SAME workflow is
   already in_progress; the concurrency group serialises what is
   left (cancel-in-progress stays false — a scan is never killed
   mid-write, it is skipped before it starts).

TRANSITION (2026-11-24, the code problem): the owner currently
receives NO Telegram login code anywhere, so the NEWS session
cannot be generated yet. Until TELEGRAM_SESSION_STRING_NEWS
exists, newspapers falls back to the shared session — but ONLY
under the lease: it claims the lease with holder "newspapers
(shared-session)" and refuses to start while a realtime lease is
live, and vice versa. The fallback is loud (::warning:: + a
marker in the run summary) and temporary; it is removed once the
NEWS secret exists. Simultaneous use is what kills sessions, not
sequential reuse — the lease is what makes sequential reuse safe.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from .api_history import SESSION_ENV, SESSION_ENV_NEWS

# A scan takes ~2 min healthy, ~11 min worst case (the old overlap
# was a ~10.75-min scan against a 10-min trigger). The lease must
# outlive a slow-but-healthy scan and still expire soon after a
# crash, so the next run is not blocked for long.
LEASE_TTL_SECONDS = 15 * 60
LEASE_KEY = "live:lease"

# Exit code for "refused to start" (distinct from 1 = failed run,
# 2 = bad usage): the dispatcher treats 3 as "skip, try next
# tick", not as a failure worth paging the owner about.
EXIT_REFUSED = 3


class SessionRefused(Exception):
    """Raised when this process must NOT start a Telegram session:
    the same secret in both roles, or a live lease held by another
    run. The message is the whole explanation — print it and exit 3."""


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_ts(value) -> Optional[datetime]:
    if not isinstance(value, str) or not value:
        return None
    try:
        ts = datetime.fromisoformat(value)
    except ValueError:
        return None
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return ts


def check_sessions_distinct(env: Optional[dict] = None) -> Optional[str]:
    """Refuse when both session secrets hold the SAME value.

    Returns the name of the session env var the caller should use
    (``TELEGRAM_SESSION_STRING_NEWS`` when it is set and different,
    else ``TELEGRAM_SESSION_STRING``), or raises SessionRefused
    when both are set to the same non-empty value — the exact
    misconfiguration that would recreate the 2026-11-24 incident.
    A missing NEWS secret is NOT an error here: it means the
    transition fallback (shared session, lease-guarded) — the
    caller logs that loudly. Never logs or returns a secret value.
    """
    source = env if env is not None else os.environ
    main = (source.get(SESSION_ENV) or "").strip()
    news = (source.get(SESSION_ENV_NEWS) or "").strip()
    if main and news and main == news:
        raise SessionRefused(
            f"{SESSION_ENV} and {SESSION_ENV_NEWS} hold the SAME "
            "value — the two workflows would share one Telegram "
            "session, which is the AuthKeyDuplicatedError of "
            "2026-11-24. Create a SECOND, dedicated session for "
            "newspapers (owner, with his Telegram code) and store "
            "it as a separate secret; never paste one session "
            "string into both secrets."
        )
    return SESSION_ENV_NEWS if news else SESSION_ENV


def lease_value(holder: str, run_id: str,
                ttl_seconds: int = LEASE_TTL_SECONDS) -> dict[str, Any]:
    """A lease document: who holds it, until when (ISO UTC)."""
    return {
        "holder": holder,
        "run_id": run_id,
        "acquired_at": _now().isoformat(),
        "expires_at": (_now() + timedelta(seconds=ttl_seconds)).isoformat(),
    }


def lease_is_live(lease: Optional[dict], now: Optional[datetime] = None) -> bool:
    """True when the lease document describes a live hold (a
    holder + an expiry in the future). Garbage / missing / expired
    leases are dead — a crashed run's stale lease never blocks the
    next run past its expiry."""
    if not isinstance(lease, dict):
        return False
    if not lease.get("holder") or not lease.get("expires_at"):
        return False
    expiry = _parse_ts(lease.get("expires_at"))
    if expiry is None:
        return False
    return expiry > (now or _now())


def read_lease(store) -> Optional[dict]:
    """Read the live lease from the DO (None when absent/unreadable
    as JSON). ``store`` is any LiveStateStore (LiveStateClient or a
    test double). A read failure propagates — the caller decides
    whether a dead endpoint is fail-open (lease unavailable) or
    fail-closed; live_sync treats it as fail-open with a warning,
    because the dispatcher + workflow guards still apply."""
    raw = store.get(LEASE_KEY)
    if raw is None:
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def acquire_lease(store, holder: str, run_id: str,
                  ttl_seconds: int = LEASE_TTL_SECONDS) -> dict[str, Any]:
    """Claim the lease, or raise SessionRefused when it is live.

    The claim is: read the current lease; refuse when live; else
    write ours. There is a small TOCTOU window (two runners
    reading an empty lease at the same instant) — accepted: the
    dispatcher + workflow in_progress checks make a simultaneous
    start near-impossible, and the lease is the LAST line of
    defence, not the only one. Returns the lease document written.
    Raises RuntimeError (not SessionRefused) when the Worker
    rejects the key (400 — companion patch not deployed yet): the
    caller treats that as "lease unavailable, proceed guarded".
    """
    current = read_lease(store)
    if lease_is_live(current):
        raise SessionRefused(
            f"live lease held by {current.get('holder')} "
            f"(run {current.get('run_id')}, until "
            f"{current.get('expires_at')}) — refusing to start a "
            "second Telegram session while one is running "
            "(AuthKeyDuplicatedError guard, 2026-11-24). This run "
            "is skipped, not failed; the next tick retries."
        )
    value = lease_value(holder, run_id, ttl_seconds)
    store.put(LEASE_KEY, json.dumps(value, ensure_ascii=False))
    return value


def release_lease(store, run_id: str) -> bool:
    """Release the lease, but ONLY when it is ours (same run_id).
    Never releases another run's lease. Returns True when released.
    A release failure is never fatal — the lease expires on its own."""
    try:
        current = read_lease(store)
    except Exception:
        return False
    if not isinstance(current, dict) or current.get("run_id") != run_id:
        return False
    try:
        store.put(LEASE_KEY, json.dumps({}, ensure_ascii=False))
    except Exception:
        return False
    return True
