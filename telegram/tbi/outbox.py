"""Outbox (sync-fix v2, 2026-11-24) — a failed push never loses books.

The old failure mode: live_sync collected new books in memory and
pushed them in ONE batch PUT at the end. When that PUT failed (or
the job timed out mid-scan — a chunk FloodWait can stall a run for
15 minutes across its 3 capped retries), the books collected so far
were gone with the runner. The next run would re-discover them from
the cursor — UNLESS the cursor had already advanced past them, or
the run died before the cursor was written. The daily sync was the
only backstop, up to 24 hours later, and it re-discovers from the
index.db cursor, not from the live run's partial results.

The outbox closes that hole with three rules:

1. SEQUENCE NUMBERS. Every book that enters the outbox gets a
   monotonic ``seq`` (per scan-run id + a counter, assigned by the
   runner from the highest seq it has seen). Sequence numbers are
   the pagination cursor: a consumer asks for "everything after
   seq N" and gets a complete, gap-free page — never "the last 500"
   (the old live:additions window, which silently dropped the
   oldest books once 500 arrived between daily resets).

2. DURABLE, TWICE. The outbox lives in the DO as ``live:outbox``
   (companion Worker patch, bot-companion/ — the batch PUT carries
   it next to the additions + cursor, same transaction) AND, when
   the DO push itself fails, as a repo file ``live-outbox.jsonl``
   committed by the workflow's failure-save step (the same pattern
   telegram-sync already uses for index.db progress). Either copy
   is enough: the next run replays the outbox BEFORE scanning, so
   no book waits more than one tick. Entries older than
   OUTBOX_RETENTION_HOURS (48 h) are pruned — by then the daily
   sync has durably indexed them from index.db, so the outbox copy
   is redundant, not lost.

3. REPLAY IS IDEMPOTENT. Replaying merges by book ``id`` (the same
   dedupe live.py already does) and only advances the per-source
   cursor to the replayed books' post ids — a replayed outbox can
   never duplicate a book or move a cursor backwards.

This module is pure (no network, no Telethon): it operates on
plain lists/dicts and on a JSONL file, so it is fully unit-tested
offline. The DO transport lives in tbi.live (LiveStateClient +
put_live_batch carry an optional ``outbox`` payload).
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Optional

# A book that has sat in the outbox for 48 h is already in the
# durable catalog: the daily sync (03:00 UTC) re-discovers every
# post from the index.db cursor independently of the live path, so
# pruning the outbox entry loses nothing — it only stops the
# outbox growing without bound when the DO push is down for days.
OUTBOX_RETENTION_HOURS = 48
# Cap the DO outbox document: at ~600 bytes/book this is ~600 KB,
# well under the 2 MB batch cap, and ~2,800 books of backlog —
# about half a day at 5,000 books/day. Past the cap the oldest
# entries are dropped FIRST ONLY after the retention check: a
# backlog that big means the DO push has been down for hours, and
# the repo-file copy (failure-save commit) is the backstop then.
MAX_OUTBOX_ENTRIES = 1000


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


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


def next_seq(existing: Iterable[dict], scan_run_id: str) -> int:
    """The next sequence number after the highest seen. ``seq`` is
    a plain counter scoped to the outbox document (not to a run):
    the runner reads the current outbox, takes max(seq), and counts
    up from there, so numbers never repeat and never go backwards
    across runs. ``scan_run_id`` is recorded on each entry for
    tracing, not for ordering."""
    return max((int(e.get("seq") or 0) for e in existing), default=0) + 1


def enqueue(books: list[dict[str, Any]], existing: list[dict[str, Any]],
            scan_run_id: str) -> list[dict[str, Any]]:
    """Append ``books`` to the outbox (dedupe by book id against
    both the existing outbox and the new batch), assigning sequence
    numbers. Returns the new outbox list, capped at
    MAX_OUTBOX_ENTRIES (oldest first out — only after the retention
    prune; see prune_outbox). Pure function, unit-tested."""
    seen = {e.get("book", {}).get("id") for e in existing}
    out = list(existing)
    seq = max((int(e.get("seq") or 0) for e in out), default=0)
    for book in books:
        book_id = book.get("id")
        if not book_id or book_id in seen:
            continue
        seen.add(book_id)
        # A book that already carries a seq (assigned by
        # live.assign_seq from the outbox's max) keeps it — the
        # entry seq and the book seq are the same number, so a
        # replay orders books exactly as they were found. Only
        # books without one take the next counter value.
        entry_seq = int(book.get("seq") or 0)
        if entry_seq <= seq:
            seq += 1
            entry_seq = seq
        else:
            seq = entry_seq
        out.append({
            "seq": entry_seq,
            "scan_run_id": scan_run_id,
            "enqueued_at": _now_iso(),
            "book": dict(book),
        })
    return out[-MAX_OUTBOX_ENTRIES:]


def prune_outbox(entries: list[dict[str, Any]],
                 retention_hours: float = OUTBOX_RETENTION_HOURS,
                 now: Optional[datetime] = None) -> list[dict[str, Any]]:
    """Drop entries older than the retention window. An entry with
    no usable timestamp is KEPT (never prune what you cannot date
    — a missing timestamp is a bug, not an expiry)."""
    ref = now or datetime.now(timezone.utc)
    kept: list[dict[str, Any]] = []
    for entry in entries:
        ts = _parse_ts(entry.get("enqueued_at"))
        if ts is None:
            kept.append(entry)
            continue
        if (ref - ts).total_seconds() < retention_hours * 3600:
            kept.append(entry)
    return kept


def outbox_books(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The LiveBooks inside outbox entries, in seq order."""
    ordered = sorted(entries, key=lambda e: int(e.get("seq") or 0))
    return [dict(e["book"]) for e in ordered
            if isinstance(e.get("book"), dict) and e["book"].get("id")]


def parse_outbox(data: Any) -> list[dict[str, Any]]:
    """Parse a stored outbox value (the DO document shape:
    {"entries": [...]} or a bare list); malformed input yields []."""
    if isinstance(data, dict):
        entries = data.get("entries")
    else:
        entries = data
    if not isinstance(entries, list):
        return []
    return [e for e in entries
            if isinstance(e, dict) and isinstance(e.get("book"), dict)]


def outbox_document(entries: list[dict[str, Any]]) -> dict[str, Any]:
    """The DO document shape for an outbox list."""
    return {"entries": list(entries)}


def paginate_books(books: list[dict[str, Any]], after_seq: int = 0,
                   limit: int = 100) -> tuple[list[dict[str, Any]], Optional[int]]:
    """Cursor-based pagination over sequence-numbered books (the
    replacement for the old "last 500" window): returns (page,
    next_cursor), where next_cursor is the seq to pass as
    ``after_seq`` for the following page, or None when the page is
    the last one. A page is NEVER a lossy window: walking pages
    from after_seq=0 visits every book exactly once, in seq order.
    Books without a seq sort first (seq 0) so nothing is skipped
    for lacking the field."""
    ordered = sorted(books, key=lambda b: (int(b.get("seq") or 0), b.get("id") or ""))
    page = [b for b in ordered if int(b.get("seq") or 0) > after_seq][:limit]
    if not page:
        return page, None
    last_seq = int(page[-1].get("seq") or 0)
    max_seq = int(ordered[-1].get("seq") or 0)
    if last_seq >= max_seq:
        # The page holds the last book: there is no next page,
        # even when the page is exactly `limit` long (a full last
        # page must not produce an empty trailing page).
        return page, None
    return page, last_seq


# --- repo-file copy (failure-save path) -----------------------------------

def load_outbox_file(path) -> list[dict[str, Any]]:
    """Read the JSONL outbox file (one entry per line); a missing
    or corrupt file yields [] — and a corrupt LINE is skipped, not
    fatal (one bad line must not block the replay of the rest)."""
    p = Path(path)
    if not p.is_file():
        return []
    entries: list[dict[str, Any]] = []
    try:
        lines = p.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError):
        return []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if isinstance(entry, dict) and isinstance(entry.get("book"), dict):
            entries.append(entry)
    return entries


def save_outbox_file(path, entries: list[dict[str, Any]]) -> None:
    """Write the outbox file atomically (temp + replace). An empty
    outbox writes an empty file (not a deletion — the workflow's
    `git add` of a missing file would silently skip the cleanup;
    an empty file commits cleanly and the next run reads it as [])."""
    p = Path(path)
    tmp = p.with_name(p.name + ".tmp")
    tmp.write_text(
        "".join(json.dumps(e, ensure_ascii=False) + "\n" for e in entries),
        encoding="utf-8",
    )
    tmp.replace(p)


def replay_outbox(entries: list[dict[str, Any]],
                  books: list[dict[str, Any]],
                  cursor: dict[str, int]) -> tuple[list[dict[str, Any]], dict[str, int], list[dict[str, Any]]]:
    """Merge outbox entries into a run's books + cursor.

    Returns (merged_books, updated_cursor, remaining_outbox):
    entries whose books are already in ``books`` (same id) or
    whose post id is at/below the cursor are DROPPED from the
    outbox (already covered — replay is idempotent); the rest are
    prepended to the books (oldest seq first, so the DO merge
    keeps newest-first order overall) and the cursor advances to
    their post ids. The remaining outbox is what the run must
    re-enqueue (books the push still has not landed)."""
    have_ids = {b.get("id") for b in books}
    new_cursor = dict(cursor)
    replayed: list[dict[str, Any]] = []
    remaining: list[dict[str, Any]] = []
    for entry in sorted(entries, key=lambda e: int(e.get("seq") or 0)):
        book = entry.get("book") or {}
        book_id = book.get("id")
        source = book.get("source")
        post_id = book.get("post_id")
        covered = (
            not book_id
            or book_id in have_ids
            or (isinstance(source, str) and isinstance(post_id, int)
                and post_id <= int(new_cursor.get(source) or 0))
        )
        if covered:
            continue
        remaining.append(entry)
        replayed.append(dict(book))
        have_ids.add(book_id)
        if isinstance(source, str) and isinstance(post_id, int):
            new_cursor[source] = max(int(new_cursor.get(source) or 0), post_id)
    return replayed + list(books), new_cursor, remaining
