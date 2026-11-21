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
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from pathlib import Path

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


def batch_sql(books: list[dict], start_id: int) -> tuple[str, int]:
    """One SQL batch: INSERTs into books + books_fts for these books.
    IDs are assigned sequentially from start_id (stable within a run;
    the (url, filename) UNIQUE constraint is the real dedup key). The
    FTS row references the ACTUAL books.id via a subquery on
    (url, filename), so a re-run (or a book that already exists) can
    never orphan or collide an FTS entry. Returns (sql_text, next_id)."""
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

    if args.incremental:
        if not args.state:
            ap.error("--incremental needs --state")
        state_path = Path(args.state)
        seen = set()
        if state_path.is_file():
            seen = {ln.strip() for ln in state_path.read_text(encoding="utf-8").splitlines() if ln.strip()}
        before = len(books)
        # Dedup by (url, filename): a post can hold several files.
        books = [b for b in books if state_key(b) not in seen and b["url"]]
        print(f"incremental: {before - len(books)} already imported, {len(books)} new")
        start_id = (len(seen) + 1) if args.auto_start_id else args.start_id
    else:
        start_id = args.start_id

    if not books:
        print("nothing to emit.")
        return 0

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    next_id = start_id
    nfiles = 0
    for i in range(0, len(books), args.batch_size):
        chunk = books[i:i + args.batch_size]
        sql, next_id = batch_sql(chunk, next_id)
        path = out_dir / f"batch-{nfiles + 1:04d}.sql"
        path.write_text(sql, encoding="utf-8")
        print(f"wrote {path} ({len(chunk)} books, ~{len(chunk) * 2} rows)")
        nfiles += 1
    print(f"total: {len(books)} books in {nfiles} batch file(s); "
          f"next free id {next_id}.")
    print("Import at most 25 batch files/day (25 x 2000 books = 100k "
          "rows = the free-tier daily write budget), in order:")
    print("  for f in d1-batches/batch-0001.sql d1-batches/batch-0002.sql; do")
    print("    wrangler d1 execute rlibook-tg --remote --file \"$f\"")
    print("  done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
