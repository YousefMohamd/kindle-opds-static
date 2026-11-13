-- Cloudflare D1 schema: Telegram-catalog search (RliBook, Task 2).
--
-- Apply once, before the first population:
--   wrangler d1 execute rlibook-tg --remote --file functions/api/tg-search-schema.sql
--
-- Tables:
--   books      — one row per DISTINCT Telegram book (321,448 at
--                 2026-11-11). Display values are stored as-is (original
--                 title/author, never normalized). The dedup key is
--                 (url, filename): one Telegram post can hold several
--                 book files (e.g. a trilogy in one post), so the t.me
--                 post URL alone is NOT unique per book — 15 URLs in
--                 shard 0 alone map to 2-3 books each. `filename` is
--                 the post's file name; together with `url` it
--                 identifies exactly one book file, so the incremental
--                 sync can upsert by (url, filename) and never
--                 duplicate or drop a book.
--   books_fts  — standalone FTS5 index over the NORMALIZED title +
--                 author (normalized by telegram/tbi/d1_sync.py with the
--                 same rules as the endpoint's normalizeArabic + stripAl:
--                 NFKC, strip tashkeel/tatweel, unify alef/hamza/yeh,
--                 ة->ه, ى->ي, lowercased, "ال" stripped from the front
--                 of a word when >=3 chars remain). rowid = books.id, so
--                 a search joins back to `books` for the display values.
--                 Stored WITHOUT the source/kind/ext/url/date columns —
--                 those live only in `books` and are fetched by join.
--
-- Why a standalone FTS5 table (not content='books' + triggers): D1
-- cannot register the custom normalize_arabic() SQL function the
-- indexer uses in its triggers, so the population script normalizes in
-- Python and inserts into BOTH tables explicitly. No triggers, no
-- custom functions — plain SQL the D1 API accepts.
--
-- Size (measured on a 3,000-book sample, extrapolated): ~81 MB for
-- 321,448 books — well under the 500 MB per-database cap on Workers
-- Free. Rows read per search: ~10-100 (5M/day free). Rows written:
-- the initial population is ~2 rows/book (books + books_fts) = ~643k
-- rows, so it is imported in daily batches under the 100k rows/day
-- free-tier write limit (see telegram/tbi/d1_sync.py --full).
-- Incremental sync (a few thousand new books/day) fits easily.

CREATE TABLE IF NOT EXISTS books (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'channel',
  ext TEXT NOT NULL DEFAULT '',
  size TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL,
  filename TEXT NOT NULL DEFAULT '',
  UNIQUE(url, filename)
);

CREATE VIRTUAL TABLE IF NOT EXISTS books_fts USING fts5(
  title, author,
  tokenize = 'unicode61 remove_diacritics 1'
);

CREATE INDEX IF NOT EXISTS idx_books_source ON books(source);
CREATE INDEX IF NOT EXISTS idx_books_date ON books(date);
CREATE INDEX IF NOT EXISTS idx_books_url ON books(url);

-- Sync bookkeeping: one row, the last fully-imported catalog snapshot
-- (the manifest generated_at the population script read). The
-- incremental sync updates it after each successful batch so a
-- re-run resumes instead of re-importing.
CREATE TABLE IF NOT EXISTS d1_sync_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
