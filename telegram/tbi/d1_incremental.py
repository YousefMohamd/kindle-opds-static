#!/usr/bin/env python3
"""Recurring incremental importer: live DO window + shards -> D1 (RliBook).

Fills the gap the wave-2 diagnosis pinned: the one-shot delta COMPLETED
2026-11-22 (``d1_sync_meta.delta_complete=1``) and NO incremental importer
was ever scheduled, so D1 froze at ``MAX(date)=2026-11-18`` while the
realtime sync kept writing new books to the bot Worker's Durable Object
(``live:additions``, 500-cap window) and the daily sync kept publishing
shards. Search is ~8 days behind the DO.

Sources (both, every run):
  * DO ``live:additions`` — public GET ``/api/live-state?key=live:additions``
    on the bot Worker. No token, no Telegram session, no lease: this job
    never touches MTProto, so it cannot contend with the realtime sync
    (every 5 min) or newspapers for the session. A LiveBook already
    carries the full record (title/author/filename/format/size/url/
    post_id/date), because the realtime writer sees the real message
    objects — no preview scraping involved.
  * Shards (``site/telegram/index.json`` + ``index-*.json``) — via
    ``d1_sync.load_catalog``. Only books with ``date`` newer than the
    shard watermark advance; this is what catches the Nov 21 rwaiaty4
    batch (~304 files) the delta manifest predated, and any future
    shard-only book.

Dedup / idempotence:
  * Within a run, candidates dedupe by ``(url, filename)`` — live wins
    over shard on the same key (same parser, same record; live is the
    fresher source).
  * Against D1, candidates are checked with ONE indexed lookup per
    chunk of URLs (``SELECT ... WHERE url IN (...)`` on ``idx_books_url``)
    — a few hundred rows read, NOT a full-table scan. (A full
    ``COUNT(*)/MAX(date)`` reads all 422,821 rows — ~8.5% of the 5M/day
    free read budget for one query — so this importer never does one.)
    New books -> INSERT, changed books (same key, different content
    hash, per ``d1_sync.content_hash``) -> UPDATE + FTS DELETE+INSERT,
    unchanged -> nothing emitted at all.
  * Ids come from D1 ``MAX(id)+1`` (single indexed read), never from
    the stale ``d1_sync_meta.next_free_id`` watermark (422454 — the Nov 23
    Drive import already took ids to 422850).
  * SQL is emitted with ``d1_sync.batch_sql`` (``INSERT OR IGNORE`` +
    FTS subquery on ``(url, filename)``), so a re-run after a partial
    import is a no-op. The watermark (``d1_sync_meta`` ``incr_*`` keys)
    is written ONLY after every batch file executed — a failed run
    leaves the watermark behind and the next run re-imports the same
    books harmlessly.

Writes: this module EMITS batch ``.sql`` files + ``watermark.sql`` and
never executes them. The GitHub Actions workflow executes the files
with ``wrangler d1 execute rlibook-tg --remote`` (the documented path
in the schema header and in ``d1_sync.py``), in order, stopping on the
first failure, and runs ``watermark.sql`` last. ``--dry-run`` prints
the plan (counts + first rows) and writes nothing.

What this job deliberately does NOT do:
  * No ``reset_live()`` — the DO window must keep serving ``/new``
    until the DAILY SYNC publishes the same books into the static
    site; resetting here would orphan them from the live view.
    Reset stays with the daily sync, after publish (wave-2 verdict).
  * No flag filtering — flags are enforced at READ time by the search
    endpoint (KV ``flag:<handle>:<post_id>``), exactly as for the
    delta-imported books. Importing a flagged book into D1 is
    harmless: it is never served. Duplicating the flag scan here
    would add a KV dependency and a fail-closed mode for zero gain.
  * No Telegram session, no DO writes, no repo commits, no state
    file. Progress lives in D1 itself (``d1_sync_meta``); the
    38 MB local ``d1-state.txt`` (v1, keys only) is NOT needed —
    the per-run D1 lookup replaces it.
  * No full-catalog re-import: ``--full`` is refused here by design;
    use ``d1_sync.py --full`` if that is ever really needed.

Budgets (D1 free tier): 100k rows written/day, 5M rows read/day.
A daily live volume of ~200-500 books costs ~400-1,000 direct rows
(~2 rows/book; FTS shadow rows unmeasured, 0-8/book per
``d1_sync.estimate_row_writes``) — ~1% of the write budget — and a
few hundred indexed rows read. ``--max-books`` caps one run (default
5000) so a catch-up spike can never blow the write budget; the
remainder waits for the next run and the shard watermark only
advances over dates that were FULLY emitted.

Usage (from the repo root; this file lands at ``telegram/tbi/``):
  python -m tbi.d1_incremental --site-telegram site/telegram \\
      --out-dir d1-incr --dry-run
  python -m tbi.d1_incremental --site-telegram site/telegram \\
      --out-dir d1-incr
  # then, in order (workflow does this):
  #   for f in d1-incr/batch-*.sql; do
  #     wrangler d1 execute rlibook-tg --remote --file "$f" || exit 1
  #   done
  #   wrangler d1 execute rlibook-tg --remote --file d1-incr/watermark.sql
"""

from __future__ import annotations

import argparse
import http.client
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

# Importable both as ``tbi.d1_incremental`` (repo layout) and as a
# standalone file next to ``d1_sync.py`` (staging / tests).
try:
    from . import d1_sync
    from .books import BOOK_EXTS
except ImportError:  # pragma: no cover - staging layout
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import d1_sync  # type: ignore
    from books import BOOK_EXTS  # type: ignore

LIVE_STATE_URL = (
    "https://rlibook-bot.mohamedyou1357.workers.dev"
    "/api/live-state?key=live%3Aadditions"
)
D1_DATABASE_NAME = "rlibook-tg"
D1_REST_BASE = "https://api.cloudflare.com/client/v4"
# D1 free tier: 100,000 rows written/day, 5,000,000 rows read/day.
D1_DAILY_ROW_BUDGET = d1_sync.D1_DAILY_ROW_BUDGET
# URLs per existence-check query. 100 keeps the URL list short and
# the result small; a 500-book window needs ~5 queries.
EXISTING_CHECK_CHUNK = 100
# Cap on books emitted per run (new + changed). 5000 books is
# ~10k-50k rows at the low/high shadow estimate — inside one day's
# budget with room for the daily sync's own writes (it writes none
# to D1 today, but the cap is cheap insurance).
DEFAULT_MAX_BOOKS = 5000
USER_AGENT = "RliBook/1.0 (+https://rlibook.tech)"


# --- live books -> d1_sync book dicts -------------------------------------


def live_book_to_book(lb: dict[str, Any]) -> Optional[dict[str, Any]]:
    """One LiveBook -> a ``d1_sync`` book dict, or None when it is not
    an importable book (no URL, or an extension outside BOOK_EXTS).

    Field mapping (verified against live D1 rows 2026-11-26):
      * ``size`` = ``size_text`` ("594.6 KB") — D1 stores the display
        text, not bytes.
      * ``date`` = the DATE part of the live ISO timestamp
        ("2026-11-26T10:31:13Z" -> "2026-11-26") — D1 dates are
        YYYY-MM-DD, and truncating makes a live record hash-identical
        to the shard record for the same file, so whichever source
        imports it first, the other later sees it as unchanged.
      * ``ext`` = ``format`` lowercased ("PDF" -> "pdf").
    """
    url = (lb.get("url") or "").strip()
    ext = (lb.get("format") or "").strip().lower()
    if not url or ext not in BOOK_EXTS:
        return None
    date = (lb.get("date") or "")[:10]
    return {
        "title": lb.get("title") or "",
        "author": lb.get("author") or "",
        "filename": lb.get("filename") or "",
        "ext": ext,
        "size": lb.get("size_text") or "",
        "source": lb.get("source") or "",
        "kind": lb.get("kind") or "channel",
        "date": date,
        "url": url,
    }


def fetch_live_books(bot_url: str = LIVE_STATE_URL) -> tuple[str, list[dict]]:
    """Public GET of ``live:additions``. No token (GET is public).
    urllib first (3 tries), then one curl fallback: python-urllib
    drops this Worker route mid-body sometimes (IncompleteRead —
    the same flake ``tbi/live.py`` retries around, where curl is
    10/10 on the same URL), so a run must not die on a transport
    flake. Raises only when both transports fail — a run with a
    stale/partial live window must fail loudly, not import half
    the window. Returns (since, raw LiveBook dicts)."""
    last: Optional[Exception] = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(
                bot_url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"}
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            books = data.get("books")
            if not isinstance(books, list):
                raise ValueError("live:additions has no 'books' list")
            return str(data.get("since") or ""), books
        except (
            urllib.error.URLError,
            OSError,
            ValueError,
            http.client.HTTPException,  # IncompleteRead / RemoteDisconnected
        ) as exc:
            last = exc
            time.sleep(attempt + 1)
    # curl fallback (ubuntu-latest has curl; same URL, same UA).
    try:
        out = subprocess.run(
            ["curl", "-fsS", "--max-time", "30",
             "-H", f"User-Agent: {USER_AGENT}", "-H", "Accept: */*",
             bot_url],
            capture_output=True, timeout=40, check=True,
        )
        data = json.loads(out.stdout.decode("utf-8"))
        books = data.get("books")
        if not isinstance(books, list):
            raise ValueError("live:additions has no 'books' list")
        return str(data.get("since") or ""), books
    except (subprocess.SubprocessError, OSError, ValueError) as exc:
        raise RuntimeError(
            "live:additions fetch failed (urllib x3 + curl): "
            f"urllib last={last!r}, curl={exc!r}"
        ) from exc


# --- D1 reads (REST /query; read-only) ------------------------------------


class D1Client:
    """Minimal read-only client for the D1 ``/query`` endpoint.

    Auth: ``CLOUDFLARE_API_TOKEN`` + ``CLOUDFLARE_ACCOUNT_ID`` from
    the environment (the same secrets the static-rebuild workflow
    already uses for KV reads). The token needs D1 read for this
    module and D1 edit for the workflow's ``wrangler d1 execute``
    step — if the repo secret lacks D1 scope the run fails here
    with a 403 and a clear message instead of importing blind.
    """

    def __init__(
        self,
        account_id: Optional[str] = None,
        database_id: Optional[str] = None,
        database_name: str = D1_DATABASE_NAME,
        token: Optional[str] = None,
    ) -> None:
        self.account_id = account_id or os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
        self.database_id = database_id or os.environ.get("RLIBOOK_D1_ID", "")
        self.database_name = database_name
        self.token = token or os.environ.get("CLOUDFLARE_API_TOKEN", "")
        if not self.account_id or not self.token:
            raise RuntimeError(
                "D1 read needs CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN "
                "in the environment (repo secrets — names only, never values)."
            )
        if not self.database_id:
            # Resolve the UUID by name so the workflow needs no new
            # secret and no hardcoded UUID: the name is the stable
            # identifier, the token is the secret.
            self.database_id = self.resolve_database_id(
                self.account_id, self.database_name, self.token
            )

    @staticmethod
    def resolve_database_id(account_id: str, name: str, token: str) -> str:
        """GET /accounts/{id}/d1/database?name=<name> -> UUID."""
        from urllib.parse import urlencode

        url = (
            f"{D1_REST_BASE}/accounts/{account_id}/d1/database?"
            + urlencode({"name": name})
        )
        req = urllib.request.Request(
            url,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            raise RuntimeError(
                f"D1 database lookup HTTP {exc.code}: {exc.read()[:200]!r} — "
                "check the CLOUDFLARE_API_TOKEN has D1 scope"
            ) from exc
        for db in payload.get("result") or []:
            if db.get("name") == name:
                return str(db["uuid"])
        raise RuntimeError(
            f"D1 database {name!r} not found in account {account_id}"
        )

    def query(self, sql: str, params: Optional[list] = None) -> list[dict]:
        body: dict[str, Any] = {"sql": sql}
        if params:
            body["params"] = params
        req = urllib.request.Request(
            f"{D1_REST_BASE}/accounts/{self.account_id}/d1/database/"
            f"{self.database_id}/query",
            data=json.dumps(body).encode("utf-8"),
            method="POST",
            headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            raise RuntimeError(
                f"D1 query HTTP {exc.code}: {exc.read()[:200]!r} — "
                "check the CLOUDFLARE_API_TOKEN has D1 scope"
            ) from exc
        results = payload.get("result") or []
        if not results or not results[0].get("success"):
            raise RuntimeError(f"D1 query failed: {str(payload)[:300]}")
        return results[0].get("results") or []

    def get_meta(self) -> dict[str, str]:
        rows = self.query(
            "SELECT key, value FROM d1_sync_meta ORDER BY key"
        )
        return {r["key"]: r["value"] for r in rows}

    def get_max_id(self) -> int:
        # Indexed aggregate on the PK; reads 1 row, not the table.
        rows = self.query("SELECT MAX(id) AS m FROM books")
        return int(rows[0]["m"] or 0)

    def fetch_existing(self, urls: list[str]) -> dict[str, dict]:
        """Rows already in D1 for these URLs, keyed by
        ``(url, filename)``. Chunked IN-list lookups on
        ``idx_books_url`` — a few hundred rows read per run, never
        a full-table scan. Returns {state_key: row} where row has
        the fields ``content_hash`` needs."""
        existing: dict[str, dict] = {}
        for i in range(0, len(urls), EXISTING_CHECK_CHUNK):
            chunk = urls[i : i + EXISTING_CHECK_CHUNK]
            placeholders = ",".join("?" for _ in chunk)
            rows = self.query(
                "SELECT url, filename, title, author, source, kind, "
                f"ext, size, date FROM books WHERE url IN ({placeholders})",
                params=list(chunk),
            )
            for r in rows:
                key = r["url"] + "|" + (r.get("filename") or "")
                existing[key] = r
        return existing


# --- classify / merge (pure) -----------------------------------------------


def classify(
    candidates: list[dict], existing: dict[str, dict]
) -> tuple[list[dict], list[dict], int]:
    """Split candidates into (new, changed, skipped-count).

    ``existing`` maps ``d1_sync.state_key`` -> D1 row. A candidate
    whose key is absent is NEW; one whose content hash differs from
    the D1 row's hash is CHANGED; anything else is SKIPPED (no
    statement emitted). Same rule as ``d1_sync.filter_changed``,
    but the state comes from D1 itself instead of a state file.
    """
    new: list[dict] = []
    changed: list[dict] = []
    skipped = 0
    for b in candidates:
        key = d1_sync.state_key(b)
        row = existing.get(key)
        if row is None:
            new.append(b)
        elif d1_sync.content_hash(b) != d1_sync.content_hash(row):
            changed.append(b)
        else:
            skipped += 1
    return new, changed, skipped


def merge_candidates(
    live_books: list[dict], shard_books: list[dict]
) -> list[dict]:
    """Merge the two sources into one candidate list, deduped by
    ``(url, filename)``. Live first: on a key collision the live
    record wins (same parser either way; live is the fresher
    source). Books with no URL are dropped (``d1_sync`` does the
    same for incremental runs). Newest first, so a capped run
    imports the newest books."""
    seen: dict[str, dict] = {}
    for b in live_books + shard_books:
        if not b.get("url"):
            continue
        seen.setdefault(d1_sync.state_key(b), b)
    out = list(seen.values())
    out.sort(key=lambda b: (b.get("date") or "", b.get("title") or ""), reverse=True)
    return out


def shard_candidates(
    shard_books: list[dict], watermark_date: str
) -> tuple[list[dict], str]:
    """Shard books newer than ``watermark_date`` (YYYY-MM-DD), plus
    the newest date that was FULLY present in that set. The caller
    only advances the stored shard watermark to the returned date
    when every book of that date was actually emitted (see run()).
    A run with no watermark (first run) uses the D1 boundary
    ``2026-11-18`` — i.e. everything the delta never saw."""
    fresh = [b for b in shard_books if (b.get("date") or "") > watermark_date]
    newest_full = max((b.get("date") or "" for b in fresh), default=watermark_date)
    return fresh, newest_full


def watermark_sql(summary: dict[str, Any]) -> str:
    """``d1_sync_meta`` upserts for one run. Executed LAST by the
    workflow, after every batch file succeeded — so a failed run
    never advances the watermark. ``incr_shard_date`` only moves
    when the run emitted every shard book of that date (the caller
    computes it); the live side needs no watermark because the
    per-run D1 lookup re-checks every live book by key."""
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    lines = ["BEGIN TRANSACTION;"]
    for key, value in [
        ("incr_last_run_at", now),
        ("incr_last_new", str(summary["new"])),
        ("incr_last_changed", str(summary["changed"])),
        ("incr_last_skipped", str(summary["skipped"])),
        ("incr_last_max_date", summary["max_date"]),
        ("incr_shard_date", summary["shard_date"]),
        ("incr_next_free_id", str(summary["next_free_id"])),
        ("incr_live_since", summary["live_since"]),
    ]:
        lines.append(
            "INSERT OR REPLACE INTO d1_sync_meta(key, value, updated_at) "
            f"VALUES ({d1_sync.sql_escape(key)}, "
            f"{d1_sync.sql_escape(value)}, "
            f"{d1_sync.sql_escape(now)});"
        )
    lines.append("COMMIT;")
    return "\n".join(lines) + "\n"


# --- run -------------------------------------------------------------------


def run(
    *,
    site_telegram: Path,
    out_dir: Path,
    d1: Any,  # D1Client, or a test double with its methods
    live_since_books: Optional[tuple[str, list[dict]]] = None,
    live_url: str = LIVE_STATE_URL,
    dry_run: bool = False,
    max_books: int = DEFAULT_MAX_BOOKS,
    batch_size: int = 2000,
) -> dict[str, Any]:
    """One incremental run. Returns the summary dict (also printed).

    ``d1`` supplies ``get_meta()``, ``get_max_id()`` and
    ``fetch_existing(urls)``. ``live_since_books`` overrides the
    live fetch (tests / dry-run fixtures); otherwise the live
    window is fetched from the bot Worker.
    """
    meta = d1.get_meta()
    if meta.get("delta_complete") != "1":
        raise RuntimeError(
            "refusing to run: d1_sync_meta.delta_complete != 1 — the "
            "one-shot delta has not completed; incremental import "
            "must not start on top of an unfinished full load."
        )
    shard_watermark = meta.get("incr_shard_date", "2026-11-18")

    if live_since_books is None:
        live_since, live_raw = fetch_live_books(live_url)
    else:
        live_since, live_raw = live_since_books
    live_books = [b for b in (live_book_to_book(lb) for lb in live_raw) if b]

    _, shard_books = d1_sync.load_catalog(site_telegram)
    fresh_shards, newest_shard_date = shard_candidates(shard_books, shard_watermark)

    candidates = merge_candidates(live_books, fresh_shards)
    print(
        f"candidates: {len(live_books)} live + {len(fresh_shards)} shard "
        f"(>{shard_watermark}) = {len(candidates)} unique"
    )
    existing = d1.fetch_existing(sorted({b["url"] for b in candidates}))
    new, changed, skipped = classify(candidates, existing)
    print(
        f"classify: {len(new)} new, {len(changed)} changed, "
        f"{skipped} already in D1 (no statements)"
    )

    # Cap: newest first, so a capped run imports the newest books
    # and leaves the rest for the next run. The shard watermark
    # only advances over dates FULLY emitted — if the cap cuts
    # inside a date, that date stays behind the watermark.
    emit_new = new[:max_books]
    emit_changed = changed[: max(0, max_books - len(emit_new))]
    capped = (len(new) - len(emit_new)) + (len(changed) - len(emit_changed))
    # A shard date advances only when EVERY fresh shard book of
    # that date was emitted.
    emitted_keys = {d1_sync.state_key(x) for x in emit_new + emit_changed}
    fresh_by_date = Counter(b.get("date") or "" for b in fresh_shards)
    emitted_by_date = Counter(
        b.get("date") or ""
        for b in fresh_shards
        if d1_sync.state_key(b) in emitted_keys
    )
    advanced_shard_date = shard_watermark
    for d in sorted(fresh_by_date):
        if emitted_by_date.get(d, 0) >= fresh_by_date[d] and d > advanced_shard_date:
            advanced_shard_date = d
        elif d > advanced_shard_date:
            break
    if capped:
        print(
            f"cap: {capped} books deferred to the next run "
            f"(max_books={max_books}); shard watermark holds at "
            f"{advanced_shard_date}"
        )

    low, high = d1_sync.estimate_row_writes(len(emit_new))
    changed_rows = len(emit_changed) * 4
    print(
        f"estimate: {len(emit_new)} new + {len(emit_changed)} changed "
        f"≈ {low + changed_rows}-{high + changed_rows} D1 row-writes "
        f"(budget {D1_DAILY_ROW_BUDGET}/day)"
    )
    if high + changed_rows > D1_DAILY_ROW_BUDGET:
        raise RuntimeError(
            "high-end row-write estimate exceeds the daily D1 budget — "
            "lower --max-books and re-run; nothing was emitted."
        )

    max_date = max((b.get("date") or "" for b in emit_new + emit_changed), default="")
    summary: dict[str, Any] = {
        "live_since": live_since,
        "live_books": len(live_books),
        "shard_fresh": len(fresh_shards),
        "candidates": len(candidates),
        "new": len(emit_new),
        "changed": len(emit_changed),
        "skipped": skipped,
        "capped": capped,
        "max_date": max_date,
        "shard_date": advanced_shard_date,
        "next_free_id": None,
        "files": [],
    }
    if dry_run:
        print("DRY-RUN: no files written, no D1 writes.")
        for b in (emit_new + emit_changed)[:10]:
            print(
                f"  would import: {b['date']} {b['source']} "
                f"{b['title'][:60]} [{b['ext']}] {b['size']}"
            )
        if len(emit_new) + len(emit_changed) > 10:
            print(f"  ... and {len(emit_new) + len(emit_changed) - 10} more")
        return summary

    if not emit_new and not emit_changed:
        print("nothing to emit.")
        return summary

    start_id = d1.get_max_id() + 1
    out_dir.mkdir(parents=True, exist_ok=True)
    next_id = start_id
    nfiles = 0
    pending_changed = list(emit_changed)
    for i in range(0, len(emit_new), batch_size):
        chunk = emit_new[i : i + batch_size]
        take_changed = pending_changed if nfiles == 0 else []
        pending_changed = []
        sql, next_id = d1_sync.batch_sql(chunk, next_id, changed=take_changed)
        path = out_dir / f"batch-{nfiles + 1:04d}.sql"
        path.write_text(sql, encoding="utf-8")
        print(f"wrote {path} ({len(chunk)} books"
              + (f" + {len(take_changed)} changed" if take_changed else "") + ")")
        nfiles += 1
    if pending_changed:
        sql, next_id = d1_sync.batch_sql([], next_id, changed=pending_changed)
        path = out_dir / f"batch-{nfiles + 1:04d}.sql"
        path.write_text(sql, encoding="utf-8")
        print(f"wrote {path} (0 new books, {len(pending_changed)} changed)")
        nfiles += 1
    summary["next_free_id"] = next_id
    summary["files"] = [f"batch-{n + 1:04d}.sql" for n in range(nfiles)]
    (out_dir / "watermark.sql").write_text(
        watermark_sql(summary), encoding="utf-8"
    )
    print(f"wrote {out_dir / 'watermark.sql'} (execute LAST, after all batches)")
    print(f"total: {len(emit_new) + len(emit_changed)} books in {nfiles} batch file(s); "
          f"next free id {next_id}.")
    return summary


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--site-telegram", default="site/telegram",
                    help="directory with index.json + index-*.json")
    ap.add_argument("--out-dir", required=True,
                    help="write batch .sql files + watermark.sql here")
    ap.add_argument("--live-url", default=LIVE_STATE_URL,
                    help="live:additions endpoint (default: bot Worker)")
    ap.add_argument("--live-json", default="",
                    help="read live:additions from this local JSON file "
                         "instead of the network (tests / offline runs)")
    ap.add_argument("--batch-size", type=int, default=2000)
    ap.add_argument("--max-books", type=int, default=DEFAULT_MAX_BOOKS)
    ap.add_argument("--dry-run", action="store_true",
                    help="print what WOULD be imported; write nothing")
    args = ap.parse_args()
    if args.batch_size < 1 or args.max_books < 1:
        ap.error("--batch-size and --max-books must be >= 1")

    if args.live_json:
        data = json.loads(Path(args.live_json).read_text(encoding="utf-8"))
        live_since_books = (str(data.get("since") or ""), data.get("books") or [])
    else:
        live_since_books = None

    d1 = D1Client()
    summary = run(
        site_telegram=Path(args.site_telegram),
        out_dir=Path(args.out_dir),
        d1=d1,
        live_since_books=live_since_books,
        live_url=args.live_url,
        dry_run=args.dry_run,
        max_books=args.max_books,
        batch_size=args.batch_size,
    )
    print(f"summary: {summary}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
