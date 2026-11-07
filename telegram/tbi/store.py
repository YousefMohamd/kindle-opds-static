"""Local SQLite store with FTS5 full-text search.

Schema:
  sources  — one row per configured source (channel or group export).
             Records kind, display name, status, oldest/newest post id
             reached, and the coverage note (e.g. "walk stopped at the
             preview ceiling" or "export dated 2026-11-06").
  posts    — one row per indexed post (unique per source + post id).
  files    — one row per book file found in a post (title/author parsed
             by tbi.books; dedupe_key collapses the same book shared in
             several sources).
  files_fts — FTS5 virtual table over title/author/filename/caption,
             kept in sync by triggers, so `search` works across all
             sources in milliseconds. Both the indexed text and the
             query are Arabic-normalized (tbi.books.normalize_arabic:
             tashkeel stripped, alef forms unified), so a plain query
             like "متون" finds a filename stored as "مُتَوِّنُ".
             Displayed filenames/titles keep their original text.
  priority_requests — one row per user priority request: a book that
             was asked for and was not in the index yet. A request is
             a (channel, query) pair — metadata only, never a file.
             The backfill run processes channels with pending requests
             first, and a request is resolved when the book shows up
             in that channel's indexed books.

No server, no background process: the CLI opens the file, reads/writes,
closes it.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

from tbi.books import normalize_arabic

SCHEMA = """
CREATE TABLE IF NOT EXISTS sources (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,              -- 'channel' | 'group'
    name TEXT NOT NULL UNIQUE,       -- channel username or group chat name
    label TEXT,                      -- human label from the config
    status TEXT NOT NULL DEFAULT 'ok', -- ok | no_preview | error
    note TEXT,                       -- coverage / status detail
    oldest_post_id INTEGER,
    newest_post_id INTEGER,
    last_indexed TEXT,               -- ISO timestamp of the last index run
    post_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS priority_requests (
    id INTEGER PRIMARY KEY,
    channel TEXT NOT NULL,
    query TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',  -- pending | resolved
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    UNIQUE(channel, query, status)
);
CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY,
    source_id INTEGER NOT NULL REFERENCES sources(id),
    post_id INTEGER NOT NULL,
    date TEXT,
    text TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    UNIQUE (source_id, post_id)
);
CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY,
    post_id INTEGER NOT NULL REFERENCES posts(id),
    filename TEXT NOT NULL,
    ext TEXT NOT NULL DEFAULT '',
    size_text TEXT,
    size_bytes INTEGER,
    title TEXT NOT NULL DEFAULT '',
    author TEXT NOT NULL DEFAULT '',
    dedupe_key TEXT NOT NULL DEFAULT '',
    obtain_url TEXT NOT NULL DEFAULT ''  -- t.me permalink (open in Telegram)
);
CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
    title, author, filename, caption,
    content='files', content_rowid='id',
    tokenize='unicode61 remove_diacritics 1'
);
-- Triggers are dropped and recreated on every open, so an existing DB
-- always gets the current trigger definitions (they reference
-- normalize_arabic, registered per-connection by Store.__init__).
DROP TRIGGER IF EXISTS files_ai;
DROP TRIGGER IF EXISTS files_ad;
DROP TRIGGER IF EXISTS files_au;
CREATE TRIGGER IF NOT EXISTS files_ai AFTER INSERT ON files BEGIN
    INSERT INTO files_fts(rowid, title, author, filename, caption)
    VALUES (new.id, normalize_arabic(new.title),
            normalize_arabic(new.author), normalize_arabic(new.filename),
            normalize_arabic((SELECT text FROM posts WHERE id = new.post_id)));
END;
CREATE TRIGGER IF NOT EXISTS files_ad AFTER DELETE ON files BEGIN
    INSERT INTO files_fts(files_fts, rowid, title, author, filename, caption)
    VALUES ('delete', old.id, old.title, old.author, old.filename, '');
END;
CREATE TRIGGER IF NOT EXISTS files_au AFTER UPDATE ON files BEGIN
    INSERT INTO files_fts(files_fts, rowid, title, author, filename, caption)
    VALUES ('delete', old.id, old.title, old.author, old.filename, '');
    INSERT INTO files_fts(rowid, title, author, filename, caption)
    VALUES (new.id, normalize_arabic(new.title),
            normalize_arabic(new.author), normalize_arabic(new.filename),
            normalize_arabic((SELECT text FROM posts WHERE id = new.post_id)));
END;
"""

# Migration 1: FTS content is now Arabic-normalized (diacritics stripped,
# alef forms unified) — see tbi.books.normalize_arabic. Triggers above
# are recreated on every open (DROP first), but rows indexed before this
# change keep the old un-normalized FTS text, so re-sync them once.
# NOTE: the re-sync must INSERT ... VALUES row by row, not INSERT ...
# SELECT — FTS5 external-content tables reject INSERT ... SELECT here
# because they try to fetch the `caption` column from the content table
# `files`, which does not have one ("no such column: T.caption").


@dataclass
class SearchHit:
    filename: str
    ext: str
    size_text: Optional[str]
    title: str
    author: str
    source_name: str
    source_kind: str
    date: Optional[str]
    obtain_url: str


class Store:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.conn = sqlite3.connect(self.path)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        # FTS triggers call this SQL function; it must be registered
        # before the schema (or any write) runs on this connection.
        self.conn.create_function(
            "normalize_arabic", 1, normalize_arabic, deterministic=True
        )
        self.conn.executescript(SCHEMA)
        self.conn.commit()
        version = self.conn.execute("PRAGMA user_version").fetchone()[0]
        if version < 1:
            # Clear the FTS with the special 'delete' command row by row:
            # a plain DELETE FROM files_fts — and even a bare SELECT
            # rowid FROM files_fts — fails on external-content tables
            # because FTS5 tries to read the `caption` column from the
            # content table `files` ("no such column: T.caption"). The
            # FTS rowids equal files.id by construction, so enumerate
            # them from `files` instead. (MATCH queries are unaffected:
            # they resolve against the FTS index itself.)
            rowids = [
                r[0] for r in self.conn.execute("SELECT id FROM files").fetchall()
            ]
            for rid in rowids:
                self.conn.execute(
                    "INSERT INTO files_fts(files_fts, rowid, title, "
                    "author, filename, caption) "
                    "VALUES ('delete', ?, '', '', '', '')",
                    (rid,),
                )
            rows = self.conn.execute(
                "SELECT f.id, f.title, f.author, f.filename, p.text "
                "FROM files f JOIN posts p ON p.id = f.post_id"
            ).fetchall()
            self.conn.executemany(
                "INSERT INTO files_fts(rowid, title, author, filename, "
                "caption) VALUES (?, ?, ?, ?, ?)",
                [
                    (
                        r[0],
                        normalize_arabic(r[1]),
                        normalize_arabic(r[2]),
                        normalize_arabic(r[3]),
                        normalize_arabic(r[4] or ""),
                    )
                    for r in rows
                ],
            )
            self.conn.execute("PRAGMA user_version = 1")
            self.conn.commit()

    def close(self) -> None:
        self.conn.close()

    # -- sources ---------------------------------------------------------
    def upsert_source(
        self, kind: str, name: str, label: Optional[str] = None
    ) -> int:
        cur = self.conn.execute(
            "INSERT INTO sources (kind, name, label) VALUES (?, ?, ?) "
            "ON CONFLICT(name) DO UPDATE SET kind=excluded.kind, "
            "label=COALESCE(excluded.label, label) RETURNING id",
            (kind, name, label),
        )
        row = cur.fetchone()
        self.conn.commit()
        return int(row[0])

    def set_source_status(
        self,
        source_id: int,
        status: str,
        note: Optional[str] = None,
        oldest: Optional[int] = None,
        newest: Optional[int] = None,
        last_indexed: Optional[str] = None,
    ) -> None:
        self.conn.execute(
            "UPDATE sources SET status=?, note=?, oldest_post_id=?, "
            "newest_post_id=?, last_indexed=?, post_count=(SELECT COUNT(*) "
            "FROM posts WHERE source_id=?) WHERE id=?",
            (status, note, oldest, newest, last_indexed, source_id, source_id),
        )
        self.conn.commit()

    def get_source(self, name: str) -> Optional[sqlite3.Row]:
        return self.conn.execute(
            "SELECT * FROM sources WHERE name=?", (name,)
        ).fetchone()

    def set_progress(
        self,
        source_id: int,
        oldest: Optional[int],
        newest: Optional[int],
    ) -> None:
        """Record how far a walk has reached, without touching the
        source's status or note. Called after every committed page so
        an interrupted run can resume instead of restarting."""
        self.conn.execute(
            "UPDATE sources SET oldest_post_id=?, newest_post_id=?, "
            "post_count=(SELECT COUNT(*) FROM posts WHERE source_id=?) "
            "WHERE id=?",
            (oldest, newest, source_id, source_id),
        )
        self.conn.commit()

    def list_sources(self) -> List[sqlite3.Row]:
        return list(
            self.conn.execute(
                "SELECT * FROM sources ORDER BY kind, name"
            ).fetchall()
        )

    def per_source_totals(self) -> List[dict]:
        """One row per source with its post and book-file counts.

        Used by the run report and the static export. ``file_count``
        counts book files (rows in ``files``), ``post_count`` is the
        maintained count in ``sources``.
        """
        rows = self.conn.execute(
            "SELECT s.name, s.kind, s.status, s.note, s.post_count, "
            "(SELECT COUNT(*) FROM files f JOIN posts p ON p.id = f.post_id "
            " WHERE p.source_id = s.id) AS file_count, "
            "s.oldest_post_id, s.newest_post_id, s.last_indexed "
            "FROM sources s ORDER BY s.kind, s.name"
        ).fetchall()
        return [dict(r) for r in rows]

    def list_books(self) -> List[dict]:
        """One row per distinct book (by ``dedupe_key``).

        For each book the newest file's data is returned, plus
        ``file_count`` (how many file rows share the key) and
        ``source_count`` (how many sources share it). Files with an
        empty dedupe key (no parseable title/author/size) are treated
        as unique per file so unrelated files never collapse together.
        Ordered newest first.
        """
        # NOTE: SQLite does not support DISTINCT inside window
        # functions, so the per-book counts are aggregated in a plain
        # GROUP BY first, then joined to the newest-file ranking.
        rows = self.conn.execute(
            "WITH keyed AS ("
            "  SELECT CASE WHEN f.dedupe_key IN ('', '|') "
            "              THEN 'file:' || f.id "
            "              ELSE f.dedupe_key END AS bkey, "
            "         f.title, f.author, f.filename, f.ext, f.size_text, "
            "         f.obtain_url, p.date, s.name AS source_name, "
            "         p.source_id "
            "  FROM files f "
            "  JOIN posts p ON p.id = f.post_id "
            "  JOIN sources s ON s.id = p.source_id"
            "), counts AS ("
            "  SELECT bkey, COUNT(*) AS file_count, "
            "         COUNT(DISTINCT source_id) AS source_count "
            "  FROM keyed GROUP BY bkey"
            "), ranked AS ("
            "  SELECT k.bkey, k.title, k.author, k.filename, k.ext, "
            "         k.size_text, k.obtain_url, k.date, k.source_name, "
            "         c.file_count, c.source_count, "
            "         ROW_NUMBER() OVER (PARTITION BY k.bkey "
            "                            ORDER BY k.date DESC, k.filename) AS rn "
            "  FROM keyed k JOIN counts c ON c.bkey = k.bkey"
            ") "
            "SELECT bkey AS dedupe_key, title, author, filename, ext, "
            "       size_text, obtain_url, date, source_name, file_count, "
            "       source_count "
            "FROM ranked WHERE rn = 1 ORDER BY date DESC, title"
        ).fetchall()
        return [dict(r) for r in rows]

    # -- posts / files ----------------------------------------------------
    def upsert_post(
        self,
        source_id: int,
        post_id: int,
        date: Optional[str],
        text: str,
        url: str,
    ) -> int:
        cur = self.conn.execute(
            "INSERT INTO posts (source_id, post_id, date, text, url) "
            "VALUES (?, ?, ?, ?, ?) ON CONFLICT(source_id, post_id) "
            "DO UPDATE SET date=excluded.date, text=excluded.text, "
            "url=excluded.url RETURNING id",
            (source_id, post_id, date, text, url),
        )
        row = cur.fetchone()
        return int(row[0])

    def replace_files_for_post(self, db_post_id: int, files: list[dict]) -> None:
        self.conn.execute("DELETE FROM files WHERE post_id=?", (db_post_id,))
        for f in files:
            self.conn.execute(
                "INSERT INTO files (post_id, filename, ext, size_text, "
                "size_bytes, title, author, dedupe_key, obtain_url) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    db_post_id,
                    f["filename"],
                    f.get("ext", ""),
                    f.get("size_text"),
                    f.get("size_bytes"),
                    f.get("title", ""),
                    f.get("author", ""),
                    f.get("dedupe_key", ""),
                    f.get("obtain_url", ""),
                ),
            )

    def commit(self) -> None:
        self.conn.commit()

    def count_sources_with_key(self, dedupe_key: str) -> int:
        """How many distinct sources already hold a book with this
        dedup key. Used by ``tbi submit-book`` to report whether the
        submitted book is already in the index from elsewhere."""
        row = self.conn.execute(
            "SELECT COUNT(DISTINCT p.source_id) AS n FROM files f "
            "JOIN posts p ON p.id = f.post_id WHERE f.dedupe_key = ?",
            (dedupe_key,),
        ).fetchone()
        return int(row[0])

    def counts(self) -> dict:
        # Empty dedupe keys ('', '|') are one file each, not one
        # book — the same rule list_books() uses, so the counts and
        # the exported book list agree.
        row = self.conn.execute(
            "SELECT (SELECT COUNT(*) FROM sources) AS sources, "
            "(SELECT COUNT(*) FROM posts) AS posts, "
            "(SELECT COUNT(*) FROM files) AS files, "
            "(SELECT COUNT(DISTINCT CASE "
            "   WHEN dedupe_key IN ('', '|') THEN 'file:' || id "
            "   ELSE dedupe_key END) FROM files) AS books"
        ).fetchone()
        return dict(row)

    # -- search ------------------------------------------------------------
    def search(
        self,
        query: str,
        *,
        ext: Optional[str] = None,
        source: Optional[str] = None,
        limit: int = 50,
    ) -> List[SearchHit]:
        """FTS5 search over title/author/filename/caption. ``query`` is
        matched as a phrase-AND of its words (each word must appear);
        an empty query lists the newest files."""
        where = ["1=1"]
        params: list = []
        if query.strip():
            words = [
                w for w in (normalize_arabic(w) for w in query.strip().split()) if w
            ]
            fts_q = " AND ".join(f'"{w}"' for w in words)
            where.append(
                "f.id IN (SELECT rowid FROM files_fts WHERE files_fts MATCH ?)"
            )
            params.append(fts_q)
        if ext:
            where.append("f.ext = ?")
            params.append(ext.lower().lstrip("."))
        if source:
            where.append("s.name = ?")
            params.append(source)
        sql = (
            "SELECT f.filename, f.ext, f.size_text, f.title, f.author, "
            "s.name AS source_name, s.kind AS source_kind, p.date, "
            "f.obtain_url FROM files f "
            "JOIN posts p ON p.id = f.post_id "
            "JOIN sources s ON s.id = p.source_id "
            f"WHERE {' AND '.join(where)} "
            "ORDER BY p.date DESC, f.filename LIMIT ?"
        )
        params.append(limit)
        rows = self.conn.execute(sql, params).fetchall()
        return [
            SearchHit(
                filename=r["filename"],
                ext=r["ext"],
                size_text=r["size_text"],
                title=r["title"],
                author=r["author"],
                source_name=r["source_name"],
                source_kind=r["source_kind"],
                date=r["date"],
                obtain_url=r["obtain_url"],
            )
            for r in rows
        ]

    # -- priority requests -------------------------------------------------
    # A priority request is a book a user asked for that was not in the
    # index yet (see README "Priority search"). The backfill run
    # processes channels with pending requests first, and a request is
    # resolved when the book shows up in that channel's indexed books.
    # Metadata only — a request is a (channel, query) pair, never a
    # file, and never a download.

    def add_priority_request(self, channel: str, query: str) -> bool:
        """Queue a priority request; True when it is new, False when an
        identical pending request already exists."""
        now = datetime.now(timezone.utc).isoformat()
        cur = self.conn.execute(
            "INSERT OR IGNORE INTO priority_requests"
            " (channel, query, status, created_at)"
            " VALUES (?, ?, 'pending', ?)",
            (channel, query.strip(), now),
        )
        return cur.rowcount == 1

    def list_pending_priority(self) -> List[dict]:
        """Pending requests, oldest first."""
        rows = self.conn.execute(
            "SELECT channel, query, created_at FROM priority_requests"
            " WHERE status = 'pending' ORDER BY created_at, id"
        ).fetchall()
        return [dict(r) for r in rows]

    def pending_priority_channels(self) -> List[str]:
        """Channels with pending requests, in request order."""
        seen: List[str] = []
        for row in self.list_pending_priority():
            if row["channel"] not in seen:
                seen.append(row["channel"])
        return seen

    def resolve_priority(self, channel: str, query: str) -> None:
        now = datetime.now(timezone.utc).isoformat()
        self.conn.execute(
            "UPDATE priority_requests SET status = 'resolved',"
            " resolved_at = ? WHERE channel = ? AND query = ?"
            " AND status = 'pending'",
            (now, channel, query.strip()),
        )

    def resolve_matching_priority(self, channel: str) -> List[str]:
        """Resolve every pending request on ``channel`` whose query now
        has a hit in that channel's indexed books. Returns the queries
        that were resolved."""
        resolved: List[str] = []
        for row in self.list_pending_priority():
            if row["channel"] != channel:
                continue
            if self.search(row["query"], limit=1, source=channel):
                self.resolve_priority(channel, row["query"])
                resolved.append(row["query"])
        return resolved
