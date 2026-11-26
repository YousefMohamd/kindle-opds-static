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
