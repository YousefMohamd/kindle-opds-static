"""Tests for Drive indexing + health monitor (no network, fake client)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tbi"))

from drive_health import check_library, load_state, sql_escape  # noqa: E402
from drive_index import (  # noqa: E402
    BOOK_EXTS, FOLDER_MIME, list_recursive, parse_drive_folder_id,
    strip_transaction_statements, to_book,
)


class FakeDrive:
    """In-memory Drive tree: {folder_id: [items]}."""

    def __init__(self, tree, fail_get=None):
        self.tree = tree
        self.fail_get = fail_get or set()
        self.calls = 0

    def get_file(self, file_id):
        self.calls += 1
        if file_id in self.fail_get:
            from drive_index import DriveError
            raise DriveError("HTTP 404: not found")
        for items in self.tree.values():
            for it in items:
                if it["id"] == file_id:
                    return it
        for fid, items in self.tree.items():
            if fid == file_id:
                return {"id": fid, "name": "root", "mimeType": FOLDER_MIME}
        from drive_index import DriveError
        raise DriveError("HTTP 404: not found")

    def list_folder(self, folder_id, page_token=""):
        self.calls += 1
        return {"files": self.tree.get(folder_id, [])}


def _tree():
    return {
        "ROOT": [
            {"id": "SUB1", "name": "كتب", "mimeType": FOLDER_MIME},
            {"id": "F1", "name": "كتاب واحد.pdf", "mimeType": "application/pdf",
             "size": "1000", "modifiedTime": "2024-01-02T00:00:00.000Z"},
            {"id": "IMG1", "name": "غلاف.jpg", "mimeType": "image/jpeg",
             "size": "500", "modifiedTime": "2024-01-02T00:00:00.000Z"},
        ],
        "SUB1": [
            {"id": "F2", "name": "رواية.epub", "mimeType": "application/epub+zip",
             "size": "2000", "modifiedTime": "2024-02-03T00:00:00.000Z"},
            {"id": "F3", "name": "مخطوط 1864.pdf", "mimeType": "application/pdf",
             "size": "3000", "modifiedTime": "2024-03-04T00:00:00.000Z"},
        ],
    }


def test_parse_drive_folder_id():
    assert parse_drive_folder_id(
        "https://drive.google.com/drive/folders/AbC123_XyZ-99") == "AbC123_XyZ-99"
    assert parse_drive_folder_id(
        "https://drive.google.com/drive/folders/AbC123_XyZ-99?usp=sharing") == "AbC123_XyZ-99"
    assert parse_drive_folder_id(
        "https://drive.google.com/file/d/AbC123_XyZ-99/view") == "AbC123_XyZ-99"
    assert parse_drive_folder_id("AbC123_XyZ-99") == "AbC123_XyZ-99"
    assert parse_drive_folder_id("https://t.me/somechannel") is None
    assert parse_drive_folder_id("@somechannel") is None
    assert parse_drive_folder_id("") is None


def test_list_recursive_counts_only_metadata():
    stats: dict = {}
    files = list_recursive(FakeDrive(_tree()), "ROOT", stats)
    assert stats["folders"] == 1
    assert stats["files"] == 4  # 3 book files + 1 jpg
    assert stats["book_files"] == 3
    assert stats["max_depth"] == 1
    assert {f["id"] for f in files} == {"F1", "F2", "F3", "IMG1"}


def test_to_book_drive_shape():
    b = to_book({"id": "F2", "name": "رواية.epub", "size": "2000",
                 "modifiedTime": "2024-02-03T00:00:00.000Z"}, "ROOT")
    assert b["kind"] == "drive"
    assert b["source"] == "drive:ROOT"
    assert b["url"] == "https://drive.google.com/file/d/F2/view"
    assert b["title"] == "رواية" and b["ext"] == "epub"


def test_health_all_live():
    res = check_library(FakeDrive(_tree()), "ROOT", [
        {"folder_id": "ROOT", "file_id": "F1",
         "url": "https://drive.google.com/file/d/F1/view"},
        {"folder_id": "ROOT", "file_id": "F2",
         "url": "https://drive.google.com/file/d/F2/view"},
    ], "2026-11-22T00:00:00Z")
    assert res["folder_ok"] is True
    assert res["missing"] == [] and len(res["recovered"]) == 2


def test_health_missing_file_flagged_not_deleted():
    res = check_library(FakeDrive(_tree()), "ROOT", [
        {"folder_id": "ROOT", "file_id": "F1",
         "url": "https://drive.google.com/file/d/F1/view"},
        {"folder_id": "ROOT", "file_id": "DEAD",
         "url": "https://drive.google.com/file/d/DEAD/view"},
    ], "2026-11-22T00:00:00Z")
    assert len(res["missing"]) == 1
    assert res["missing"][0]["file_id"] == "DEAD"
    # The missing entry is RETURNED for marking — never dropped silently.


def test_health_dead_folder_marks_everything():
    res = check_library(FakeDrive(_tree(), fail_get={"ROOT"}), "ROOT", [
        {"folder_id": "ROOT", "file_id": "F1",
         "url": "https://drive.google.com/file/d/F1/view"},
    ], "2026-11-22T00:00:00Z")
    assert res["folder_ok"] is False
    assert len(res["missing"]) == 1  # whole library unavailable


def test_load_state_dedups(tmp_path):
    p = tmp_path / "s.jsonl"
    p.write_text(
        '{"folder_id": "R", "file_id": "F1", "url": "u1", "filename": "a.pdf"}\n'
        '{"folder_id": "R", "file_id": "F1", "url": "u1", "filename": "a.pdf"}\n',
        encoding="utf-8")
    assert len(load_state(p)["R"]) == 1


def test_sql_escape():
    assert sql_escape("o'clock") == "'o''clock'"
    assert "pdf" in BOOK_EXTS and "exe" not in BOOK_EXTS


def test_strip_transaction_statements():
    sql = ("BEGIN TRANSACTION;\n"
           "INSERT INTO books VALUES (1,'BEGIN TRANSACTION; inside a title','x');\n"
           "SAVEPOINT sp1;\n"
           "COMMIT;\n")
    out = strip_transaction_statements(sql)
    lines = out.splitlines()
    # Whole transaction lines are dropped; the INSERT survives ...
    assert len(lines) == 1 and lines[0].startswith("INSERT INTO books")
    # ... including a title that merely CONTAINS the words.
    assert "BEGIN TRANSACTION; inside a title" in out
    assert not any(l.strip().upper().startswith(("SAVEPOINT ", "RELEASE "))
                   for l in lines)


def test_main_no_transaction_writes_wrangler_ready_sql(monkeypatch, tmp_path):
    """--no-transaction: the emitted batch has no BEGIN/COMMIT, so
    `wrangler d1 execute` accepts it (Build 1 import path)."""
    import json
    import sys
    import drive_index

    folder = "ROOTFOLDER1234567890"
    tree = {folder: [
        {"id": "F1", "name": "كتاب واحد.pdf", "mimeType": "application/pdf",
         "size": "1000", "modifiedTime": "2024-01-02T00:00:00.000Z"},
    ]}
    monkeypatch.setattr(drive_index, "HttpDriveClient",
                        lambda **kw: FakeDrive(tree))
    out_dir = tmp_path / "batches"
    reg = tmp_path / "drive-libraries.json"
    monkeypatch.setattr(sys, "argv", ["drive_index.py",
        "--client", "http", "--folder", folder,
        "--out-dir", str(out_dir), "--state-file", str(tmp_path / "s.jsonl"),
        "--start-id", "100", "--submitter-tg-id", "111",
        "--visibility", "private", "--registry-json", str(reg),
        "--no-transaction"])
    assert drive_index.main() == 0
    sql = (out_dir / f"drive-{folder[:12]}.sql").read_text(encoding="utf-8")
    assert "BEGIN TRANSACTION" not in sql and "COMMIT;" not in sql
    assert "INSERT OR IGNORE INTO books" in sql
    books = json.loads((out_dir / f"drive-{folder[:12]}-books.json")
                       .read_text(encoding="utf-8"))
    assert len(books) == 1 and books[0]["title"] == "كتاب واحد"
    reg_data = json.loads(reg.read_text(encoding="utf-8"))
    assert reg_data["libraries"][0]["visibility"] == "private"
    assert reg_data["libraries"][0]["submitted_by"] == 111


def test_main_max_books_refuses_without_writing(monkeypatch, tmp_path):
    """--max-books: an oversized folder writes nothing (exit 4)."""
    import sys
    import drive_index

    folder = "ROOTFOLDER1234567890"
    tree = {folder: [
        {"id": "F1", "name": "a.pdf", "mimeType": "application/pdf",
         "size": "1", "modifiedTime": "2024-01-02T00:00:00.000Z"},
        {"id": "F2", "name": "b.pdf", "mimeType": "application/pdf",
         "size": "1", "modifiedTime": "2024-01-02T00:00:00.000Z"},
        {"id": "F3", "name": "c.pdf", "mimeType": "application/pdf",
         "size": "1", "modifiedTime": "2024-01-02T00:00:00.000Z"},
    ]}
    monkeypatch.setattr(drive_index, "HttpDriveClient",
                        lambda **kw: FakeDrive(tree))
    out_dir = tmp_path / "batches"
    monkeypatch.setattr(sys, "argv", ["drive_index.py",
        "--client", "http", "--folder", folder,
        "--out-dir", str(out_dir), "--start-id", "100",
        "--max-books", "2"])
    assert drive_index.main() == 4
    assert not out_dir.exists() or not list(out_dir.iterdir())


# --- Drive sync mode (--sync, Drive UX redesign) ----------------------

import sqlite3  # noqa: E402

from d1_sync import update_sql_by_url  # noqa: E402
from drive_index import file_id_from_url, sync_diff  # noqa: E402

SYNC_FOLDER = "SYNCFOLDER1234567890"


def _d1_url(fid):
    return f"https://drive.google.com/file/d/{fid}/view"


def _seed_sync_db():
    """In-memory D1-shaped DB (books + books_fts, same schema as
    functions/api/tg-search-schema.sql) seeded with three Drive
    books: F1 (id 101), F2 (id 102), F3 (id 103)."""
    db = sqlite3.connect(":memory:")
    db.executescript(
        "CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT NOT NULL,"
        " author TEXT NOT NULL DEFAULT '', source TEXT NOT NULL,"
        " kind TEXT NOT NULL DEFAULT 'channel', ext TEXT NOT NULL DEFAULT '',"
        " size TEXT NOT NULL DEFAULT '', date TEXT NOT NULL DEFAULT '',"
        " url TEXT NOT NULL, filename TEXT NOT NULL DEFAULT '',"
        " UNIQUE(url, filename));"
        "CREATE VIRTUAL TABLE books_fts USING fts5(title, author,"
        " tokenize='unicode61 remove_diacritics 1');")
    seed = [
        (101, "كتاب واحد", "", f"drive:{SYNC_FOLDER}", "drive", "pdf",
         "1000 B", "2024-01-02", _d1_url("F1"), "كتاب واحد.pdf"),
        (102, "رواية", "", f"drive:{SYNC_FOLDER}", "drive", "epub",
         "2.0 KB", "2024-02-03", _d1_url("F2"), "رواية.epub"),
        (103, "مخطوط قديم", "", f"drive:{SYNC_FOLDER}", "drive", "pdf",
         "3.0 KB", "2024-03-04", _d1_url("F3"), "مخطوط قديم.pdf"),
    ]
    db.executemany(
        "INSERT INTO books(id,title,author,source,kind,ext,size,date,url,filename)"
        " VALUES (?,?,?,?,?,?,?,?,?,?)", seed)
    db.executemany(
        "INSERT INTO books_fts(rowid,title,author) VALUES (?,?,?)",
        [(101, "كتاب واحد", ""), (102, "رواية", ""), (103, "مخطوط قديم", "")])
    db.commit()
    return db


def _sync_rows():
    return [
        {"id": 101, "url": _d1_url("F1"), "filename": "كتاب واحد.pdf"},
        {"id": 102, "url": _d1_url("F2"), "filename": "رواية.epub"},
        {"id": 103, "url": _d1_url("F3"), "filename": "مخطوط قديم.pdf"},
    ]


def _sync_tree():
    # F1 RENAMED on Drive, F2 unchanged, F4 brand new, F3 gone.
    return {SYNC_FOLDER: [
        {"id": "F1", "name": "كتاب واحد طبعة جديدة.pdf",
         "mimeType": "application/pdf", "size": "1100",
         "modifiedTime": "2024-01-02T00:00:00.000Z"},
        {"id": "F2", "name": "رواية.epub",
         "mimeType": "application/epub+zip", "size": "2000",
         "modifiedTime": "2024-02-03T00:00:00.000Z"},
        {"id": "F4", "name": "كتاب جديد.epub",
         "mimeType": "application/epub+zip", "size": "4000",
         "modifiedTime": "2024-04-05T00:00:00.000Z"},
    ]}


def test_file_id_from_url():
    assert file_id_from_url(_d1_url("AbC123_XyZ-99")) == "AbC123_XyZ-99"
    assert file_id_from_url("https://t.me/kotobkhana/7559") is None
    assert file_id_from_url("") is None


def test_sync_diff_rename_new_vanished():
    from drive_index import to_book
    fresh = [to_book(f, SYNC_FOLDER) for f in _sync_tree()[SYNC_FOLDER]]
    diff = sync_diff(_sync_rows(), fresh)
    assert [b["file_id"] for b in diff["new"]] == ["F4"]
    assert len(diff["changed"]) == 1
    changed_book, row_id = diff["changed"][0]
    assert changed_book["file_id"] == "F1"
    assert changed_book["filename"] == "كتاب واحد طبعة جديدة.pdf"
    assert row_id is None  # single D1 row: url-keyed update
    assert diff["unchanged"] == 1  # F2
    assert [r["id"] for r in diff["vanished"]] == [103]  # F3
    assert diff["duplicates"] == []


def test_sync_diff_duplicate_rows_pin_canonical():
    # A rename under the old flow left TWO D1 rows with one url
    # (ids 5 and 9): the update pins the max-id row; the older row
    # is reported as a duplicate and left untouched.
    from drive_index import to_book
    rows = [
        {"id": 5, "url": _d1_url("F1"), "filename": "كتاب واحد.pdf"},
        {"id": 9, "url": _d1_url("F1"), "filename": "كتاب واحد.pdf"},
    ]
    fresh = [to_book({"id": "F1", "name": "كتاب واحد طبعة جديدة.pdf",
                      "size": "1100", "modifiedTime": "2024-01-02T00:00:00.000Z"},
                     SYNC_FOLDER)]
    diff = sync_diff(rows, fresh)
    assert len(diff["changed"]) == 1
    assert diff["changed"][0][1] == 9  # canonical = max id
    assert [r["id"] for r in diff["duplicates"]] == [5]
    assert diff["vanished"] == []


def test_update_sql_by_url_renames_in_place():
    # Replay the emitted SQL against a real SQLite DB: exactly one
    # row for the fileId afterwards, same id, new filename/title,
    # and the FTS row rebuilt (new title searchable, old gone).
    db = _seed_sync_db()
    b = {"title": "كتاب واحد طبعة جديدة", "author": "",
         "source": f"drive:{SYNC_FOLDER}", "kind": "drive", "ext": "pdf",
         "size": "1.1 KB", "date": "2024-01-02", "url": _d1_url("F1"),
         "filename": "كتاب واحد طبعة جديدة.pdf"}
    db.executescript(update_sql_by_url(b))
    rows = db.execute(
        "SELECT id, title, filename FROM books WHERE url = ?",
        (_d1_url("F1"),)).fetchall()
    assert len(rows) == 1  # no duplicate row
    assert rows[0] == (101, "كتاب واحد طبعة جديدة", "كتاب واحد طبعة جديدة.pdf")
    fts = db.execute(
        "SELECT title FROM books_fts WHERE rowid = 101").fetchall()
    assert fts == [("كتاب واحد طبعه جديده",)]  # normalized new title
    assert db.execute(
        "SELECT count(*) FROM books_fts WHERE books_fts MATCH 'واحد طبعه'"
        ).fetchone()[0] == 1


def test_sync_main_end_to_end(monkeypatch, tmp_path):
    """--sync CLI: rename fixed in place, new file inserted at
    --start-id, vanished file untouched, report written, and NO
    registry upsert / books JSON (sync never touches the registry)."""
    import json
    import sys
    import drive_index

    monkeypatch.setattr(drive_index, "HttpDriveClient",
                        lambda **kw: FakeDrive(_sync_tree()))
    rows_file = tmp_path / "rows.json"
    rows_file.write_text(json.dumps(_sync_rows()), encoding="utf-8")
    out_dir = tmp_path / "batches"
    monkeypatch.setattr(sys, "argv", ["drive_index.py",
        "--client", "http", "--folder", SYNC_FOLDER,
        "--sync", "--rows", str(rows_file), "--start-id", "104",
        "--out-dir", str(out_dir), "--no-transaction"])
    assert drive_index.main() == 0
    sql = (out_dir / f"drive-{SYNC_FOLDER[:12]}-sync.sql").read_text(encoding="utf-8")
    assert "BEGIN TRANSACTION" not in sql and "COMMIT;" not in sql
    report = json.loads(
        (out_dir / f"drive-{SYNC_FOLDER[:12]}-sync-report.json")
        .read_text(encoding="utf-8"))
    assert report["folder_id"] == SYNC_FOLDER
    assert report["inserted"] == 1 and report["updated"] == 1
    assert report["unchanged"] == 1
    assert [r["id"] for r in report["vanished_left"]] == [103]
    assert report["duplicate_rows_left"] == []
    # No registry upsert, no books JSON in sync mode.
    assert not list(out_dir.glob("*-registry.sql"))
    assert not list(out_dir.glob("*-books.json"))

    db = _seed_sync_db()
    db.executescript(sql)
    # F1: renamed IN PLACE — same id, new filename, no duplicate.
    f1 = db.execute(
        "SELECT id, title, filename FROM books WHERE url = ?",
        (_d1_url("F1"),)).fetchall()
    assert f1 == [(101, "كتاب واحد طبعة جديدة", "كتاب واحد طبعة جديدة.pdf")]
    # F4: inserted at --start-id.
    f4 = db.execute(
        "SELECT id, title FROM books WHERE url = ?",
        (_d1_url("F4"),)).fetchall()
    assert f4 == [(104, "كتاب جديد")]
    # F3: vanished on Drive, row UNTOUCHED in D1.
    f3 = db.execute(
        "SELECT id, filename FROM books WHERE url = ?",
        (_d1_url("F3"),)).fetchall()
    assert f3 == [(103, "مخطوط قديم.pdf")]
    # FTS rebuilt for the renamed row, present for the new row.
    assert db.execute(
        "SELECT title FROM books_fts WHERE rowid = 101").fetchone()[0] == \
        "كتاب واحد طبعه جديده"
    assert db.execute(
        "SELECT title FROM books_fts WHERE rowid = 104").fetchone()[0] == \
        "كتاب جديد"
    assert db.execute("SELECT count(*) FROM books").fetchone()[0] == 4


def test_sync_main_keeps_transaction_wrapper_by_default(monkeypatch, tmp_path):
    """Without --no-transaction the sync SQL is a single
    BEGIN/COMMIT batch (local-SQLite importable as one unit)."""
    import json
    import sys
    import drive_index

    monkeypatch.setattr(drive_index, "HttpDriveClient",
                        lambda **kw: FakeDrive(_sync_tree()))
    rows_file = tmp_path / "rows.json"
    rows_file.write_text(json.dumps(_sync_rows()), encoding="utf-8")
    out_dir = tmp_path / "batches"
    monkeypatch.setattr(sys, "argv", ["drive_index.py",
        "--client", "http", "--folder", SYNC_FOLDER,
        "--sync", "--rows", str(rows_file), "--start-id", "104",
        "--out-dir", str(out_dir)])
    assert drive_index.main() == 0
    sql = (out_dir / f"drive-{SYNC_FOLDER[:12]}-sync.sql").read_text(encoding="utf-8")
    assert sql.startswith("BEGIN TRANSACTION;")
    assert sql.strip().endswith("COMMIT;")
    # And it replays as one batch against real SQLite.
    db = _seed_sync_db()
    db.executescript(sql)
    assert db.execute("SELECT count(*) FROM books").fetchone()[0] == 4


def test_sync_main_refuses_colliding_start_id(monkeypatch, tmp_path):
    """--start-id <= max D1 id is refused (exit 2, writes nothing):
    a colliding id would silently drop new books (INSERT OR IGNORE)."""
    import json
    import sys
    import drive_index

    monkeypatch.setattr(drive_index, "HttpDriveClient",
                        lambda **kw: FakeDrive(_sync_tree()))
    rows_file = tmp_path / "rows.json"
    rows_file.write_text(json.dumps(_sync_rows()), encoding="utf-8")
    out_dir = tmp_path / "batches"
    monkeypatch.setattr(sys, "argv", ["drive_index.py",
        "--client", "http", "--folder", SYNC_FOLDER,
        "--sync", "--rows", str(rows_file), "--start-id", "103",
        "--out-dir", str(out_dir)])
    assert drive_index.main() == 2
    assert not out_dir.exists() or not list(out_dir.iterdir())


def test_sync_main_needs_rows_and_start_id(monkeypatch, tmp_path):
    """--sync without --rows, or without --start-id, is refused."""
    import sys
    import drive_index

    monkeypatch.setattr(drive_index, "HttpDriveClient",
                        lambda **kw: FakeDrive(_sync_tree()))
    out_dir = tmp_path / "batches"
    monkeypatch.setattr(sys, "argv", ["drive_index.py",
        "--client", "http", "--folder", SYNC_FOLDER,
        "--sync", "--out-dir", str(out_dir), "--start-id", "104"])
    assert drive_index.main() == 2
    monkeypatch.setattr(sys, "argv", ["drive_index.py",
        "--client", "http", "--folder", SYNC_FOLDER,
        "--sync", "--rows", str(tmp_path / "rows.json"),
        "--out-dir", str(out_dir)])
    assert drive_index.main() == 2


def test_sync_rows_unwrap_accepts_wrangler_envelope():
    """--rows accepts the `wrangler d1 execute --json` envelope
    ([{results: [...]}]) as well as a bare list / {results: [...]}."""
    import drive_index

    rows = _sync_rows()
    assert drive_index._unwrap_rows(rows) == rows
    assert drive_index._unwrap_rows({"results": rows}) == rows
    assert drive_index._unwrap_rows([{"results": rows, "meta": {}}]) == rows
    assert drive_index._unwrap_rows({"n": 1}) is None
