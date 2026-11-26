#!/usr/bin/env python3
"""Drive library registry for RliBook — the two-type model (WAVE 4, WS8).

A Drive library is one of two types (user decision 2026-11-26 ~14:26):

* PRIVATE (default for a newly submitted library): indexed in the
  background, visible ONLY to its submitter (their fingerprint /
  Telegram id) in search results. Nobody else sees its books — not
  in website search, not in the OPDS catalog, not on the libraries
  page.
* PUBLIC: visible to everyone, once the owner approves it. The
  submitter requests it ("make public" -> ``pending_public``), the
  owner approves or rejects from the library monitor page; a
  rejection leaves the library PRIVATE to the submitter (never
  deleted, never hidden from its owner).

Single source of truth: the D1 ``drive_libraries`` table (same table
drive_health.py creates; this module extends it with the visibility
columns). ``drive-libraries.json`` is the file mirror the indexer
and health workflow read — it carries the same fields.

Visibility values: ``public`` | ``private`` | ``pending_public``.
Legacy rows (Oriental Music, indexed 2026-11-22 before this table
existed) have no visibility value: they are treated as PUBLIC by
every reader (website search, OPDS export, libraries page) — the
backfill SQL in ``d1-batches-drive/drive-registry-backfill.sql``
(staged) records Oriental Music explicitly as public so the default
is never load-bearing.

Metadata is NEVER deleted: rejecting a public request, a dead link,
or a deleted folder only ever changes ``visibility`` / the
``drive_health`` availability flag. See drive_health.py.

Usage (library functions; the CLI below is for the manual D1 steps):
  python3 telegram/tbi/drive_registry.py --registry drive-libraries.json \
      --folder 1EFegWouzH4CXHzX2N-NfD18mJbtDLQAP --title "Oriental Music" \
      --submitter 0 --visibility public --out-dir d1-batches-drive
  # writes d1-batches-drive/drive-<folder12>-registry.sql + updates the JSON
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

VISIBILITIES = {"public", "private", "pending_public"}

# Full table (new databases). drive_health.py's SCHEMA_SQL creates the
# first five columns; this module's migrations add the rest to a
# database created by the old schema.
SCHEMA_SQL = """\
CREATE TABLE IF NOT EXISTS drive_libraries (
  folder_id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '',
  added_by TEXT NOT NULL DEFAULT '', added_at TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  submitter_tg_id INTEGER,
  visibility TEXT NOT NULL DEFAULT 'public',
  requested_at TEXT,
  reviewed_at TEXT);
"""

# Columns added after the first schema (drive_health.py). Applied by
# apply_migrations() after checking PRAGMA table_info — SQLite has no
# ADD COLUMN IF NOT EXISTS, so each is added only when missing.
MIGRATION_COLUMNS = [
    ("submitter_tg_id", "INTEGER"),
    ("visibility", "TEXT NOT NULL DEFAULT 'public'"),
    ("requested_at", "TEXT"),
    ("reviewed_at", "TEXT"),
]


def sql_escape(s: str) -> str:
    return "'" + str(s).replace("'", "''") + "'"


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def apply_migrations(conn: sqlite3.Connection) -> list[str]:
    """Add the visibility columns to an existing drive_libraries table.

    Returns the list of columns added (empty when already current).
    Safe to run on a fresh database too (CREATE TABLE first).
    """
    conn.executescript(SCHEMA_SQL)
    cols = {r[1] for r in conn.execute("PRAGMA table_info(drive_libraries)")}
    added = []
    for name, decl in MIGRATION_COLUMNS:
        if name not in cols:
            conn.execute(f"ALTER TABLE drive_libraries ADD COLUMN {name} {decl}")
            added.append(name)
    conn.commit()
    return added


def validate_visibility(v: str) -> str:
    v = (v or "").strip().lower()
    if v not in VISIBILITIES:
        raise ValueError(f"bad visibility {v!r} (want one of {sorted(VISIBILITIES)})")
    return v


def registry_upsert_sql(lib: dict) -> str:
    """INSERT ... ON CONFLICT upsert for one registry row.

    Re-indexing an existing library keeps its submitter + visibility
    (COALESCE to the stored value) unless the caller passes new ones
    explicitly — a re-list must never silently flip a private library
    public or orphan it from its submitter.
    """
    folder_id = lib["folder_id"]
    title = lib.get("title", "")
    added_by = lib.get("added_by", "")
    added_at = lib.get("added_at", "") or datetime.now(timezone.utc).date().isoformat()
    status = lib.get("status", "active")
    submitter = lib.get("submitter_tg_id")
    submitter_sql = "NULL" if submitter in (None, "", 0) else str(int(submitter))
    visibility = validate_visibility(lib.get("visibility", "public"))
    return (
        "INSERT INTO drive_libraries(folder_id, title, added_by, added_at, status,"
        " submitter_tg_id, visibility) VALUES ("
        f"{sql_escape(folder_id)}, {sql_escape(title)}, {sql_escape(added_by)},"
        f" {sql_escape(added_at)}, {sql_escape(status)}, {submitter_sql},"
        f" {sql_escape(visibility)}) ON CONFLICT(folder_id) DO UPDATE SET"
        " title=excluded.title, added_by=excluded.added_by,"
        " added_at=excluded.added_at, status=excluded.status,"
        " submitter_tg_id=COALESCE(drive_libraries.submitter_tg_id,"
        " excluded.submitter_tg_id),"
        " visibility=COALESCE(drive_libraries.visibility, excluded.visibility);"
    )


def set_visibility_sql(folder_id: str, visibility: str,
                       reviewed_at: str | None = None) -> str:
    """UPDATE one library's visibility (monitor approve/reject)."""
    visibility = validate_visibility(visibility)
    ts = reviewed_at or utcnow()
    requested = ""
    if visibility == "pending_public":
        requested = ", requested_at=" + sql_escape(ts)
    return (
        "UPDATE drive_libraries SET visibility=" + sql_escape(visibility)
        + ", reviewed_at=" + sql_escape(ts) + requested
        + " WHERE folder_id=" + sql_escape(folder_id) + ";"
    )


def load_registry(path: Path) -> dict:
    if not path.exists():
        return {"libraries": []}
    return json.loads(path.read_text(encoding="utf-8"))


def upsert_registry_json(registry: dict, lib: dict) -> dict:
    """Upsert one entry in the drive-libraries.json structure in place.

    Same keep-rule as the SQL upsert: a re-index keeps the stored
    submitter + visibility unless the caller passes new ones.
    """
    libs = registry.setdefault("libraries", [])
    for e in libs:
        if e.get("folder_id") == lib["folder_id"]:
            e["title"] = lib.get("title", e.get("title", ""))
            e["added_by"] = lib.get("added_by", e.get("added_by", ""))
            e["added_at"] = lib.get("added_at", e.get("added_at", ""))
            e["status"] = lib.get("status", e.get("status", "active"))
            if lib.get("submitter_tg_id") not in (None, "", 0):
                e["submitted_by"] = int(lib["submitter_tg_id"])
            if lib.get("visibility"):
                e.setdefault("visibility", lib["visibility"])
                if lib.get("visibility") != e.get("visibility") and lib.get("force_visibility"):
                    e["visibility"] = lib["visibility"]
            return registry
    libs.append({
        "folder_id": lib["folder_id"],
        "title": lib.get("title", ""),
        "added_by": lib.get("added_by", ""),
        "added_at": lib.get("added_at", ""),
        "status": lib.get("status", "active"),
        "visibility": lib.get("visibility", "public"),
        **({"submitted_by": int(lib["submitter_tg_id"])}
           if lib.get("submitter_tg_id") not in (None, "", 0) else {}),
    })
    return registry


# --- Backfill: parse an existing D1 batch SQL file --------------------
# The Oriental Music batch (d1-batches-drive/drive-1EFegWouzH4C.sql)
# is already imported into D1; re-listing Drive to rebuild its book
# list would waste API calls. The batch file IS the book list — parse
# it back into book dicts for the OPDS/search-index generator
# (drive_opds.py). Only INSERT INTO books(...) VALUES (...) lines are
# read; FTS lines are skipped (same rows).

_BOOK_RE = re.compile(
    r"INSERT OR IGNORE INTO books\(id,title,author,source,kind,ext,size,date,url,filename\)"
    r" VALUES \((\d+),'(?P<title>(?:[^']|'')*)','(?P<author>(?:[^']|'')*)',"
    r"'(?P<source>(?:[^']|'')*)','(?P<kind>(?:[^']|'')*)','(?P<ext>(?:[^']|'')*)',"
    r"'(?P<size>(?:[^']|'')*)','(?P<date>(?:[^']|'')*)','(?P<url>(?:[^']|'')*)',"
    r"'(?P<filename>(?:[^']|'')*)'\);"
)


def _unq(s: str) -> str:
    return s.replace("''", "'")


def parse_drive_books_sql(path: Path) -> list[dict]:
    """Batch SQL -> [{id,title,author,source,kind,ext,size,date,url,filename,file_id}].

    Scans the whole file (not line by line): a title may contain a
    literal newline, so one INSERT can span several lines. Only
    INSERT INTO books(...) VALUES (...) statements are read; FTS
    lines are skipped (same rows).
    """
    text = path.read_text(encoding="utf-8")
    books = []
    for m in _BOOK_RE.finditer(text):
        b = {k: _unq(v) for k, v in m.groupdict().items()}
        b["id"] = int(re.match(
            r"INSERT OR IGNORE INTO books\(.*?VALUES \((\d+),",
            m.group(0), re.DOTALL).group(1))
        fid = re.search(r"/file/d/([A-Za-z0-9_-]+)/", b["url"])
        b["file_id"] = fid.group(1) if fid else ""
        books.append(b)
    return books


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--registry", default="drive-libraries.json")
    ap.add_argument("--folder", required=True)
    ap.add_argument("--title", default="")
    ap.add_argument("--added-by", default="owner")
    ap.add_argument("--submitter", type=int, default=0,
                    help="Telegram user id of the submitter (0 = owner/unknown)")
    ap.add_argument("--visibility", default="public",
                    choices=sorted(VISIBILITIES))
    ap.add_argument("--out-dir", default="d1-batches-drive")
    args = ap.parse_args()

    lib = {
        "folder_id": args.folder,
        "title": args.title,
        "added_by": args.added_by,
        "added_at": datetime.now(timezone.utc).date().isoformat(),
        "status": "active",
        "submitter_tg_id": args.submitter or None,
        "visibility": args.visibility,
    }
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    sql_file = out_dir / f"drive-{args.folder[:12]}-registry.sql"
    sql_file.write_text(SCHEMA_SQL.strip() + "\n" + registry_upsert_sql(lib) + "\n",
                        encoding="utf-8")
    print(f"Wrote {sql_file}")

    registry_path = Path(args.registry)
    registry = load_registry(registry_path)
    upsert_registry_json(registry, {**lib, "force_visibility": True})
    registry_path.write_text(json.dumps(registry, ensure_ascii=False, indent=2) + "\n",
                             encoding="utf-8")
    print(f"Updated {registry_path} ({lib['folder_id']} -> {lib['visibility']})")
    print("Import with: wrangler d1 execute rlibook-tg --remote --file "
          f"{sql_file}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
