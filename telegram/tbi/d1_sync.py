#!/usr/bin/env python3
"""Populate the RliBook Telegram-search D1 database from the published
Telegram catalog shards (Task 2).

Reads the manifest + shards the daily sync already publishes
(site/telegram/index.json + index-*.json) and generates SQL batch
files that load them into D1 (`rlibook-tg`, schema in
functions/api/tg-search-schema.sql). The endpoint
(functions/api/tg-search.js) reads D1; this script is the only writer.

Why batches: Workers Free allows 100,000 D1 rows written/day. Each
book costs 2 rows (one in `books`, one in `books_fts`), so the full
catalog (321,448 books) is ~643k rows = ~7 days at the free-tier
rate. Batches are ordered NEWEST FIRST (by the book's date), so day
1 already loads the newest ~50k books and the endpoint is useful
immediately; the rest follow one or two batches a day. There is no
paid step and no card involved — just time.

Batch size is 2,000 books per file (4,000 SQL statements) on purpose:
`wrangler d1 execute --file` is known to fail with "Network
connection lost" on files with 5000+ INSERT statements, so each file
stays well under that. Import up to 25 files/day (25 x 2,000 books =
50,000 books = 100,000 rows = the daily budget) with a shell loop;
the full catalog is 161 files.

Usage (run from the repo root):
  # Schema (once):
  wrangler d1 execute rlibook-tg --remote \
      --file functions/api/tg-search-schema.sql

  # Generate batches for the FULL catalog (newest first):
  python3 telegram/tbi/d1_sync.py --full --out-dir d1-batches
  # -> d1-batches/batch-0001.sql ... (default 2,000 books each)

  # Import, in order, at most 25 files/day (the daily write budget):
  for f in d1-batches/batch-0001.sql d1-batches/batch-0002.sql; do
    wrangler d1 execute rlibook-tg --remote --file "$f"
  done
  # (repeat the loop with the next 25 files the next day, etc.)

  # Incremental (after the daily catalog sync adds new books):
  # only books whose (url, filename) key is not in the state file
  # are emitted (a post can hold several files, so the key is
  # url + "|" + filename, not the URL alone).
  python3 telegram/tbi/d1_sync.py --incremental --out-dir d1-batches \
      --state d1-state.txt
  # then execute the new batch file(s) the same way, and update the
  # state file (the script appends imported (url|filename) keys to it
  # on --mark-done, or you pass --state and it rewrites it after a
  # successful run).

Normalization MUST match the endpoint (functions/api/tg-search.js):
NFKC, strip tashkeel/tatweel, unify alef/hamza/yeh, ة->ه, ى->ي,
lowercase, and strip a leading "ال" from a word when >=3 chars
remain. The FTS index stores the NORMALIZED title/author; the
`books` table stores the DISPLAY (original) title/author.

The endpoint's flag check reads KV `flag:<handle>:<post_id>`; this
script does not write flags (Block 7 populates them from the bot's
flags.ts list).

Write amplification (sync-fix v2, 2026-11-24) — WHY a book costs
~2 rows directly and possibly more: the `books` row (1) + the
`books_fts` row (1) + the FTS5 shadow tables (fts_data / fts_idx /
fts_content / fts_docsize / fts_config — several rows per insert,
amortised per segment flush inside one transaction). The shadow
cost is UNMEASURED (see the constants below — the import history
suggests ~2 rows/book total, the high estimates say 6-10; measure
it from the D1 dashboard). What CAN be coded away regardless is
emitting rows that do not change anything:
  * --incremental used to filter by KEY PRESENCE only — a book
    whose title/author/size/date CHANGED was silently skipped
    (never updated) while a re-imported book still emitted its
    (ignored) INSERTs. Now every book carries a content hash
    (title+author+ext+size+date+filename); only NEW or CHANGED
    books emit statements, and changed books emit an UPDATE +
    FTS DELETE+INSERT instead of an ignored INSERT pair.
  * --full after the initial load is refused when a state file
    exists (unless --force-full): a full re-import of 422k books
    is ~844k direct rows (~25-40 days of the free-tier budget at
    the low estimate, more at the high one) for zero new
    information.
  * Every run prints its estimated row-write range BEFORE
    writing, against the 100k/day budget, so a run that would
    blow the budget is visible before it starts.
The state file is v2: one "url|filename<TAB>sha1" line per book.
Old v1 state files (keys only, no hash) still load — their books
are treated as already-imported with unknown hash (skipped, the
old behaviour), never as changed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import unicodedata
from pathlib import Path

# D1 free tier: 100,000 rows written/day (the hard cap the whole
# project shares). One book DIRECTLY costs 2 rows (books +
# books_fts). FTS5 also writes its shadow tables (fts_data /
# fts_idx / fts_content / fts_docsize / fts_config) — how many
# rows that adds per book is NOT measured yet: estimates run from
# ~0 (amortised away inside one transaction) to 4-8. The honest
# position: the full catalog (422k books) WAS imported in about
# a week at ~50k books/day, which bounds the true average at
# roughly ~2 rows/book IF the cap was enforced as documented —
# so the old "25 files/day = 100k rows" arithmetic is probably
# right and the 6-15 rows/book estimates are probably wrong.
# Either way the fix is the same (emit only changed rows), and
# estimate_row_writes() reports the RANGE so the operator can
# compare it with the D1 dashboard's real rows-written counter
# instead of trusting either number. MEASURE before expanding.
D1_DAILY_ROW_BUDGET = 100_000
# FTS5 shadow-table rows per book: low/high of the estimated range.
FTS_SHADOW_ROWS_LOW = 0
FTS_SHADOW_ROWS_HIGH = 8

# --- normalization (must match functions/api/tg-search.js) -------------

_TASHKEEL = re.compile(r"[\u064B-\u0652\u0670\u0640]")


def normalize_arabic(text: str) -> str:
    """NFKC, strip tashkeel/tatweel, unify alef/hamza/yeh, ة->ه, ى->ي,
    and fold Persian letters (چ->ج, ک/گ->ك, پ->ب, ڤ->ف) so a query
    with ج finds a title stored with چ (e.g. نوستالچيا). NEVER fold
    س/ص, ت/ط, ذ/ز/ظ, ق/ك, ح/ه, ابن/بن — and NEVER strip a leading و
    ("وردة" stays "وردة"). Eastern Arabic numerals (٠-٩->0-9) are
    DEFERRED to day 2 (2026-11-21 follow-up): live books_fts still
    holds them in 15,370 rows and today's D1 write budget is fully
    used, so no batch rewrite was applied either."""
    s = unicodedata.normalize("NFKC", text or "")
    s = _TASHKEEL.sub("", s)
    s = (
        s.replace("أ", "ا")
        .replace("إ", "ا")
        .replace("آ", "ا")
        .replace("ٱ", "ا")
        .replace("ؤ", "و")
        .replace("ئ", "ي")
        .replace("ء", "")
        .replace("ى", "ي")
        .replace("ة", "ه")
        .replace("چ", "ج")
        .replace("ک", "ك")
        .replace("گ", "ك")
        .replace("پ", "ب")
        .replace("ڤ", "ف")
    )
    return s


def strip_al(word: str) -> str:
    """Strip a leading "ال" when >=3 chars remain (mirrors the JS)."""
    if word.startswith("ال") and len(word) >= 5:
        return word[2:]
    return word


def normalize_query(text: str) -> str:
    return normalize_arabic(text).lower().replace(" ", " ").strip()


def normalize_for_fts(text: str) -> str:
    """The text stored in books_fts: normalized, lowercased, "ال"-stripped
    per word, single spaces. Identical to the endpoint's query words
    joined back with spaces."""
    words = normalize_query(text).split()
    return " ".join(strip_al(w) for w in words if w)


# --- loading ------------------------------------------------------------


def load_catalog(site_telegram: Path) -> tuple[dict, list[dict]]:
    """Return (manifest, books). Each book is a dict with the shard
    fields: title, author, filename, ext, size, source, sources, date,
    url. `kind` is resolved from the manifest sources list."""
    manifest = json.loads((site_telegram / "index.json").read_text(encoding="utf-8"))
    kind_by_source = {
        s["name"]: s.get("kind", "channel") for s in manifest.get("sources", [])
    }
    books: list[dict] = []
    for shard in manifest.get("shards", []):
        path = site_telegram / shard["file"]
        if not path.is_file():
            print(f"warning: shard missing, skipped: {path}", file=sys.stderr)
            continue
        data = json.loads(path.read_text(encoding="utf-8"))
        for b in data.get("books", []):
            # Shard record format (2026-11-21, from
            # delta-work/delta_loader.py — the reference implementation):
            #   Nov 13 shards: 9 fields [title, author, filename,
            #     ext, size, source, sources_count, date, url] where
            #     [8] is the FULL https://t.me/... URL.
            #   Nov 20 shards: 10 fields [title, author, filename,
            #     ext, size, source, sources_count, date, source,
            #     post_id] where [8] is the source handle AGAIN and
            #     [9] is the numeric post id — the URL is rebuilt as
            #     https://t.me/{source}/{post_id}. Reading b[8] as
            #     the URL on a 10-field record produces garbage
            #     (url='noorlibrarykids'), so the length decides.
            #   Any other length is a corrupt record: fail loudly.
            if len(b) == 10:
                url = f"https://t.me/{b[5]}/{b[9]}"
            elif len(b) == 9:
                url = b[8] or ""
            else:
                raise ValueError(f"unknown shard record length {len(b)}: {b}")
            books.append(
                {
                    "title": b[0] or "",
                    "author": b[1] or "",
                    "filename": b[2] or "",
                    "ext": (b[3] or "").lower(),
                    "size": b[4] or "",
                    "source": b[5] or "",
                    "sources": b[6] or 1,
                    "date": b[7] or "",
                    "url": url,
                }
            )
    for b in books:
        b["kind"] = kind_by_source.get(b["source"], "channel")
    return manifest, books


def sql_escape(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


def state_key(b: dict) -> str:
    """Dedup key for one book: url + filename. A post can hold several
    files, so the URL alone is not unique (see the schema comment)."""
    return b["url"] + "|" + b["filename"]


def content_hash(b: dict) -> str:
    """Content hash of a book (sync-fix v2): everything the row
    stores except its id. Two records with the same key and the
    same hash are the same book — no write is needed. A different
    hash means the book CHANGED (retitle, fixed author, new size)
    and needs an UPDATE, not a skipped INSERT."""
    material = "\x00".join([
        b.get("title") or "",
        b.get("author") or "",
        b.get("ext") or "",
        b.get("size") or "",
        b.get("date") or "",
        b.get("filename") or "",
        b.get("source") or "",
        b.get("kind") or "",
    ])
    return hashlib.sha1(material.encode("utf-8")).hexdigest()


def estimate_row_writes(n_books: int) -> tuple[int, int]:
    """Estimated D1 row-writes for ``n_books`` (low, high): 2 direct
    rows/book + the unmeasured FTS5 shadow range. Compare with
    D1_DAILY_ROW_BUDGET (100k/day) BEFORE importing — and compare
    with the dashboard's real counter after, to pin the shadow
    cost down (see the module docstring)."""
    low = n_books * (2 + FTS_SHADOW_ROWS_LOW)
    high = n_books * (2 + FTS_SHADOW_ROWS_HIGH)
    return low, high


def load_state(path: Path) -> dict[str, Optional[str]]:
    """Load a state file into {key: hash-or-None}. v2 lines are
    "key<TAB>hash"; v1 lines (key only) map to None (unknown hash
    — treated as already-imported, never as changed)."""
    state: dict[str, Optional[str]] = {}
    if not path.is_file():
        return state
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        if "\t" in line:
            key, digest = line.split("\t", 1)
            state[key.strip()] = digest.strip() or None
        else:
            state[line] = None
    return state


def filter_changed(books: list[dict], state: dict[str, Optional[str]]
                   ) -> tuple[list[dict], list[dict], int]:
    """Split ``books`` into (new, changed, skipped): new = key not
    in state; changed = key in state with a KNOWN, DIFFERENT hash;
    skipped = key in state with the same hash, or with unknown
    (v1) hash. Pure function, unit-tested."""
    new: list[dict] = []
    changed: list[dict] = []
    skipped = 0
    for b in books:
        key = state_key(b)
        if key not in state:
            new.append(b)
        elif state[key] is not None and state[key] != content_hash(b):
            changed.append(b)
        else:
            skipped += 1
    return new, changed, skipped


def update_sql(b: dict) -> str:
    """UPDATE statements for one CHANGED book (sync-fix v2): the
    books row is updated in place (same id — the (url, filename)
    UNIQUE key is unchanged), the old FTS row is deleted and a
    fresh one inserted for the same rowid. No new id is consumed
    (unlike the INSERT path), so a changed book never shifts the
    id sequence."""
    fts_title = normalize_for_fts(b["title"])
    fts_author = normalize_for_fts(b["author"])
    return "\n".join([
        "UPDATE books SET "
        f"title={sql_escape(b['title'])},author={sql_escape(b['author'])},"
        f"source={sql_escape(b['source'])},kind={sql_escape(b['kind'])},"
        f"ext={sql_escape(b['ext'])},size={sql_escape(b['size'])},"
        f"date={sql_escape(b['date'])},filename={sql_escape(b['filename'])} "
        f"WHERE url={sql_escape(b['url'])} "
        f"AND filename={sql_escape(b['filename'])};",
        "DELETE FROM books_fts WHERE rowid = "
        f"(SELECT id FROM books WHERE url={sql_escape(b['url'])} "
        f"AND filename={sql_escape(b['filename'])});",
        "INSERT OR IGNORE INTO books_fts(rowid,title,author) "
        f"SELECT id,{sql_escape(fts_title)},{sql_escape(fts_author)} "
        f"FROM books WHERE url = {sql_escape(b['url'])} "
        f"AND filename = {sql_escape(b['filename'])};",
    ])


def batch_sql(books: list[dict], start_id: int, changed: Optional[list[dict]] = None
              ) -> tuple[str, int]:
    """One SQL batch: INSERTs into books + books_fts for these books.
    IDs are assigned sequentially from start_id (stable within a run;
    the (url, filename) UNIQUE constraint is the real dedup key). The
    FTS row references the ACTUAL books.id via a subquery on
    (url, filename), so a re-run (or a book that already exists) can
    never orphan or collide an FTS entry. Returns (sql_text, next_id).

    ``changed`` (sync-fix v2): books already in D1 whose content
    changed — emitted as UPDATEs (update_sql) in the same
    transaction, after the inserts. They consume no new ids.
    """
    lines = ["BEGIN TRANSACTION;"]
    next_id = start_id
    for b in books:
        bid = next_id
        next_id += 1
        title = b["title"]
        author = b["author"]
        url = b["url"]
        filename = b["filename"]
        lines.append(
            "INSERT OR IGNORE INTO books(id,title,author,source,kind,ext,size,date,url,filename) VALUES "
            f"({bid},{sql_escape(title)},{sql_escape(author)},"
            f"{sql_escape(b['source'])},{sql_escape(b['kind'])},"
            f"{sql_escape(b['ext'])},{sql_escape(b['size'])},"
            f"{sql_escape(b['date'])},{sql_escape(url)},{sql_escape(filename)});"
        )
        # FTS row: same book, NORMALIZED title/author (what the
        # endpoint searches). The rowid comes from the books row for
        # this (url, filename), so it is always correct even if the
        # book already existed (INSERT OR IGNORE then skips a
        # duplicate FTS row).
        fts_title = normalize_for_fts(title)
        fts_author = normalize_for_fts(author)
        lines.append(
            "INSERT OR IGNORE INTO books_fts(rowid,title,author) "
            f"SELECT id,{sql_escape(fts_title)},{sql_escape(fts_author)} "
            f"FROM books WHERE url = {sql_escape(url)} "
            f"AND filename = {sql_escape(filename)};"
        )
    for b in (changed or []):
        lines.append(update_sql(b))
    lines.append("COMMIT;")
    return "\n".join(lines) + "\n", next_id


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--site-telegram", default="site/telegram",
                    help="directory with index.json + index-*.json")
    ap.add_argument("--out-dir", required=True, help="write batch .sql files here")
    ap.add_argument("--batch-size", type=int, default=2000,
                    help="books per batch file (default 2000 = 4000 "
                         "statements; kept under the 5000-statement "
                         "wrangler d1 execute timeout limit)")
    ap.add_argument("--full", action="store_true",
                    help="emit batches for the whole catalog (newest first)")
    ap.add_argument("--incremental", action="store_true",
                    help="emit only books whose (url, filename) key is "
                         "not in --state")
    ap.add_argument("--state", default="",
                    help="state file listing already-imported books "
                         "(one 'url|filename' key per line)")
    ap.add_argument("--start-id", type=int, default=1,
                    help="first book id to assign (default 1; for --incremental "
                         "pass the next free id, or use --auto-start-id)")
    ap.add_argument("--auto-start-id", action="store_true",
                    help="derive start id as (count of URLs in --state) + 1; "
                         "only valid when every prior import used sequential ids")
    ap.add_argument("--force-full", action="store_true",
                    help="allow --full even when a state file exists "
                         "(default: --full is refused when --state names "
                         "an existing file — a full re-import burns "
                         "~25+ days of the D1 write budget for nothing)")
    args = ap.parse_args()
    if bool(args.full) == bool(args.incremental):
        ap.error("pass exactly one of --full or --incremental")
    if args.batch_size < 1:
        ap.error("--batch-size must be >= 1")

    site_telegram = Path(args.site_telegram)
    manifest, books = load_catalog(site_telegram)
    print(f"manifest: {manifest.get('totals', {})} "
          f"generated_at={manifest.get('generated_at')}")
    print(f"books in shards: {len(books)}")

    # Newest first, so day 1 already loads the most recent books.
    books.sort(key=lambda b: (b["date"] or "", b["title"]), reverse=True)

    changed: list[dict] = []
    if args.incremental:
        if not args.state:
            ap.error("--incremental needs --state")
        state_path = Path(args.state)
        state = load_state(state_path)
        before = len(books)
        # Dedup by (url, filename) + content hash (sync-fix v2):
        # only NEW or CHANGED books emit statements; unchanged
        # books emit nothing at all (the old code emitted ignored
        # INSERTs for them, and silently skipped real changes).
        new_books, changed, skipped = filter_changed(
            [b for b in books if b["url"]], state
        )
        books = new_books
        print(f"incremental: {skipped} unchanged (no statements), "
              f"{len(changed)} changed (UPDATE), {len(books)} new")
        start_id = (len(state) + 1) if args.auto_start_id else args.start_id
    else:
        if args.state and Path(args.state).is_file() and not args.force_full:
            ap.error(
                f"--full refused: state file {args.state} exists — the "
                "catalog is already imported; use --incremental (only "
                "new/changed books) or pass --force-full if you really "
                "mean to re-import the whole catalog."
            )
        start_id = args.start_id

    if not books and not changed:
        print("nothing to emit.")
        return 0

    # Write-budget estimate (sync-fix v2): print BEFORE writing so
    # a run that would blow the 100k/day D1 cap is visible first.
    # Changed books cost ~4 rows each (UPDATE + FTS DELETE +
    # INSERT + shadow); new books cost the estimate_row_writes
    # range. The operator splits the import across days when the
    # high end exceeds the remaining budget.
    emit_total = len(books) + len(changed)
    low, high = estimate_row_writes(len(books))
    changed_rows = len(changed) * 4
    print(f"estimate: {emit_total} books to emit ({len(books)} new + "
          f"{len(changed)} changed) ≈ {low + changed_rows}-{high + changed_rows} "
          f"D1 row-writes (budget {D1_DAILY_ROW_BUDGET}/day; high end "
          "assumes the unmeasured FTS shadow cost — check the "
          "dashboard after importing)")
    if high + changed_rows > D1_DAILY_ROW_BUDGET:
        print("WARNING: high-end estimate exceeds the daily D1 write "
              "budget — import only part of these batches today, or "
              "split --batch-size across days.", file=sys.stderr)

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    next_id = start_id
    nfiles = 0
    # Changed books ride in the FIRST batch file (same transaction
    # discipline as the inserts); the rest of the files are new
    # books only.
    pending_changed = list(changed)
    for i in range(0, len(books), args.batch_size):
        chunk = books[i:i + args.batch_size]
        take_changed = pending_changed if nfiles == 0 else []
        pending_changed = []
        sql, next_id = batch_sql(chunk, next_id, changed=take_changed)
        path = out_dir / f"batch-{nfiles + 1:04d}.sql"
        path.write_text(sql, encoding="utf-8")
        print(f"wrote {path} ({len(chunk)} books, ~{len(chunk) * 2} rows"
              + (f" + {len(take_changed)} changed" if take_changed else "") + ")")
        nfiles += 1
    if pending_changed:
        # No new books at all, only changes: they still need a file.
        sql, next_id = batch_sql([], next_id, changed=pending_changed)
        path = out_dir / f"batch-{nfiles + 1:04d}.sql"
        path.write_text(sql, encoding="utf-8")
        print(f"wrote {path} (0 new books, {len(pending_changed)} changed)")
        nfiles += 1
    print(f"total: {emit_total} books in {nfiles} batch file(s); "
          f"next free id {next_id}.")
    print("Import at most 25 batch files/day (25 x 2000 books = 100k "
          "rows = the free-tier daily write budget AT THE LOW "
          "ESTIMATE — check the dashboard; if the real cost is "
          "higher, import fewer files/day), in order:")
    print("  for f in d1-batches/batch-0001.sql d1-batches/batch-0002.sql; do")
    print("    wrangler d1 execute rlibook-tg --remote --file \"$f\"")
    print("  done")
    # State rewrite (sync-fix v2): after a successful incremental
    # emission, the state file records the CURRENT hash of every
    # book in the catalog (not just the emitted ones), so the next
    # run's filter is complete. The old code never rewrote it,
    # which is why --incremental could not detect changes at all.
    if args.incremental and args.state:
        state_path = Path(args.state)
        lines = []
        for b in load_catalog(site_telegram)[1]:
            if b["url"]:
                lines.append(f"{state_key(b)}\t{content_hash(b)}\n")
        state_path.write_text("".join(lines), encoding="utf-8")
        print(f"state rewritten: {args.state} ({len(lines)} keys)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
