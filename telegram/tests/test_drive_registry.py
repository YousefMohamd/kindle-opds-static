"""Tests for the Drive registry (two-type model, WAVE 4 WS8).

No network, no D1 — a local sqlite3 connection executes the generated
SQL, so the upsert keep-rule and the visibility transitions are
verified against the real statements, not their text.
"""
import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tbi"))

from drive_registry import (  # noqa: E402
    apply_migrations,
    load_registry,
    parse_drive_books_sql,
    registry_upsert_sql,
    set_visibility_sql,
    upsert_registry_json,
    validate_visibility,
)

FOLDER = "1EFegWouzH4CXHzX2N-NfD18mJbtDLQAP"


def test_validate_visibility_accepts_the_three():
    assert validate_visibility("public") == "public"
    assert validate_visibility(" private ") == "private"
    assert validate_visibility("PENDING_PUBLIC") == "pending_public"


def test_validate_visibility_rejects_others():
    for bad in ("", "hidden", "owner", "PUBLICO"):
        with pytest.raises(ValueError):
            validate_visibility(bad)


def test_apply_migrations_fresh_db_has_all_columns():
    conn = sqlite3.connect(":memory:")
    added = apply_migrations(conn)
    assert added == []  # SCHEMA_SQL already includes them
    cols = {r[1] for r in conn.execute("PRAGMA table_info(drive_libraries)")}
    assert {"submitter_tg_id", "visibility", "requested_at", "reviewed_at"} <= cols


def test_apply_migrations_adds_columns_to_old_table():
    conn = sqlite3.connect(":memory:")
    conn.execute(
        "CREATE TABLE drive_libraries (folder_id TEXT PRIMARY KEY,"
        " title TEXT, added_by TEXT, added_at TEXT, status TEXT)"
    )
    added = apply_migrations(conn)
    assert set(added) == {"submitter_tg_id", "visibility", "requested_at", "reviewed_at"}
    assert apply_migrations(conn) == []  # idempotent


def test_reindex_keeps_stored_visibility_and_submitter():
    """A re-list must never silently flip a private library public
    or orphan it from its submitter (COALESCE keep-rule)."""
    conn = sqlite3.connect(":memory:")
    apply_migrations(conn)
    conn.executescript(registry_upsert_sql({
        "folder_id": FOLDER, "title": "Oriental Music",
        "submitter_tg_id": 111, "visibility": "private",
    }))
    conn.executescript(registry_upsert_sql({
        "folder_id": FOLDER, "title": "Oriental Music (re-indexed)",
        "submitter_tg_id": 222, "visibility": "public",
    }))
    row = conn.execute(
        "SELECT title, submitter_tg_id, visibility FROM drive_libraries"
        " WHERE folder_id = ?", (FOLDER,)).fetchone()
    assert row[0] == "Oriental Music (re-indexed)"  # title updates
    assert row[1] == 111  # submitter kept
    assert row[2] == "private"  # visibility kept


def test_set_visibility_sql_transitions():
    conn = sqlite3.connect(":memory:")
    apply_migrations(conn)
    conn.executescript(registry_upsert_sql({
        "folder_id": FOLDER, "title": "X", "visibility": "private",
    }))
    conn.executescript(set_visibility_sql(FOLDER, "pending_public"))
    row = conn.execute(
        "SELECT visibility, requested_at, reviewed_at FROM drive_libraries"
        " WHERE folder_id = ?", (FOLDER,)).fetchone()
    assert row[0] == "pending_public"
    assert row[1] is not None  # requested_at stamped on the request
    assert row[2] is not None  # reviewed_at stamped on the decision
    conn.executescript(set_visibility_sql(FOLDER, "public"))
    row = conn.execute(
        "SELECT visibility FROM drive_libraries WHERE folder_id = ?",
        (FOLDER,)).fetchone()
    assert row[0] == "public"


def test_upsert_registry_json_keeps_stored_visibility():
    registry = {"libraries": [
        {"folder_id": FOLDER, "title": "X", "visibility": "private",
         "submitted_by": 111}]}
    upsert_registry_json(registry, {
        "folder_id": FOLDER, "title": "X2", "submitter_tg_id": 222,
        "visibility": "public",
    })
    e = registry["libraries"][0]
    assert e["title"] == "X2"
    assert e["visibility"] == "private"  # kept unless force_visibility
    # NOTE: the JSON upsert REPLACES submitted_by when a new submitter
    # is passed explicitly (unlike the SQL upsert, which COALESCE-keeps
    # the stored one). Both are safe on the default re-index path
    # (submitter 0 is skipped here, kept in SQL) — pinned, not fixed.
    assert e["submitted_by"] == 222
    upsert_registry_json(registry, {
        "folder_id": FOLDER, "title": "X3", "visibility": "public",
        "force_visibility": True,
    })
    assert registry["libraries"][0]["visibility"] == "public"


def test_upsert_registry_json_appends_new_library():
    registry = load_registry(Path("/nonexistent-registry.json"))
    assert registry == {"libraries": []}
    upsert_registry_json(registry, {
        "folder_id": FOLDER, "title": "Oriental Music",
        "submitter_tg_id": 0, "visibility": "public",
    })
    assert len(registry["libraries"]) == 1
    assert "submitted_by" not in registry["libraries"][0]  # 0 = owner-added


def test_parse_drive_books_sql_handles_multiline_titles(tmp_path):
    """Two titles in the real Oriental Music batch contain a literal
    newline; a line-by-line parse found 395/397. Whole-file scan: 2/2."""
    sql = tmp_path / "batch.sql"
    sql.write_text(
        "INSERT OR IGNORE INTO books(id,title,author,source,kind,ext,size,date,url,filename)"
        " VALUES (422614,'عنوان\nمتعدد الأسطر','','drive:F','drive','PDF','','2025-07-03',"
        "'https://drive.google.com/file/d/FILEA1234567890/view','a.pdf');\n"
        "INSERT INTO books_fts(rowid, title, author) VALUES (422614, 'x', '');\n"
        "INSERT OR IGNORE INTO books(id,title,author,source,kind,ext,size,date,url,filename)"
        " VALUES (422700,'كتاب عادي','مؤلف','drive:F','drive','EPUB','','2025-07-03',"
        "'https://drive.google.com/file/d/FILEB1234567890/view','b.epub');\n",
        encoding="utf-8",
    )
    books = parse_drive_books_sql(sql)
    assert len(books) == 2  # the FTS line is skipped, not double-counted
    assert books[0]["id"] == 422614
    assert books[0]["title"] == "عنوان\nمتعدد الأسطر"
    assert books[0]["file_id"] == "FILEA1234567890"
    assert books[1]["ext"] == "EPUB"
