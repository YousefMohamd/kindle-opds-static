"""Tests for the Drive OPDS generator (WAVE 4 WS8).

No network, no D1: the generator runs on small book dicts in tmp
dirs. Pins the public-only rule — a private or pending library
must never enter the static OPDS/search-index files.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tbi"))

import drive_opds  # noqa: E402
from drive_opds import (  # noqa: E402
    acquisition_feed,
    navigation_feed,
    registry_visibility,
    search_index_entries,
)

FOLDER = "1EFegWouzH4CXHzX2N-NfD18mJbtDLQAP"
OTHER = "PRIVFOLDER1234567890"

BOOKS = [
    {"id": 1, "title": "نزهة الزمان", "author": "", "ext": "PDF",
     "file_id": "1I7rOn96NuAgIUQBdCjmGcZnM3BCwH6uX",
     "folder_id": FOLDER, "library_title": "Oriental Music"},
    {"id": 2, "title": "كتاب بلا ملف", "author": "", "ext": "EPUB",
     "file_id": "", "folder_id": FOLDER, "library_title": "Oriental Music"},
]


def test_search_index_entries_shape_and_skip():
    rows = search_index_entries(BOOKS)
    assert len(rows) == 1  # the row without a file id is skipped
    assert rows[0] == {
        "t": "نزهة الزمان", "a": "",
        "i": "1I7rOn96NuAgIUQBdCjmGcZnM3BCwH6uX",
        "m": "application/pdf",
    }


def test_registry_visibility_defaults_public():
    assert registry_visibility({"libraries": []}, FOLDER) == "public"
    assert registry_visibility({"libraries": [
        {"folder_id": FOLDER, "visibility": "private"}]}, FOLDER) == "private"


def test_acquisition_feed_has_uc_links():
    feed = acquisition_feed(FOLDER, "Oriental Music", BOOKS[:1])
    assert "نزهة الزمان" in feed
    assert "drive.google.com/uc?id=1I7rOn96NuAgIUQBdCjmGcZnM3BCwH6uX" in feed


def test_navigation_feed_lists_libraries():
    feed = navigation_feed([
        {"folder_id": FOLDER, "title": "Oriental Music", "count": 397},
        {"folder_id": OTHER, "title": "B Library", "count": 3},
    ])
    assert "Oriental Music" in feed and "B Library" in feed
    assert "/drive/" + FOLDER + "/index.xml" in feed


def _run_main(monkeypatch, tmp_path, registry, books):
    books_path = tmp_path / "books.json"
    books_path.write_text(json.dumps(books, ensure_ascii=False), encoding="utf-8")
    reg_path = tmp_path / "drive-libraries.json"
    reg_path.write_text(json.dumps(registry, ensure_ascii=False), encoding="utf-8")
    out = tmp_path / "drive"
    monkeypatch.setattr(sys, "argv", [
        "drive_opds.py", "--books", str(books_path),
        "--registry", str(reg_path), "--out", str(out),
    ])
    return drive_opds.main(), out


def test_main_public_writes_all_three_files(monkeypatch, tmp_path):
    rc, out = _run_main(monkeypatch, tmp_path,
                        {"libraries": [{"folder_id": FOLDER, "visibility": "public"}]},
                        BOOKS)
    assert rc == 0
    index = json.loads((out / "search-index.json").read_text(encoding="utf-8"))
    assert len(index) == 1 and index[0]["t"] == "نزهة الزمان"
    assert "نزهة الزمان" in (out / FOLDER / "index.xml").read_text(encoding="utf-8")
    assert "Oriental Music" in (out / "index.xml").read_text(encoding="utf-8")


def test_main_private_skips_without_writing(monkeypatch, tmp_path):
    rc, out = _run_main(monkeypatch, tmp_path,
                        {"libraries": [{"folder_id": FOLDER, "visibility": "private"}]},
                        BOOKS)
    assert rc == 0
    assert not (out / "search-index.json").exists()
    assert not (out / FOLDER / "index.xml").exists()
    assert not (out / "index.xml").exists()


def test_main_pending_skips_without_writing(monkeypatch, tmp_path):
    rc, out = _run_main(monkeypatch, tmp_path,
                        {"libraries": [{"folder_id": FOLDER, "visibility": "pending_public"}]},
                        BOOKS)
    assert rc == 0
    assert not (out / "search-index.json").exists()


def test_main_nav_feed_merges_existing_libraries(monkeypatch, tmp_path):
    rc, out = _run_main(monkeypatch, tmp_path,
                        {"libraries": [{"folder_id": FOLDER, "visibility": "public"}]},
                        BOOKS)
    assert rc == 0
    # Second public library: its run must keep the first in the nav feed.
    books2 = [dict(BOOKS[0], folder_id=OTHER, library_title="B Library",
                   file_id="FILEOTHER12345678", title="كتاب آخر")]
    rc2, _ = _run_main(monkeypatch, tmp_path,
                       {"libraries": [{"folder_id": OTHER, "visibility": "public"}]},
                       books2)
    assert rc2 == 0
    nav = (out / "index.xml").read_text(encoding="utf-8")
    assert "Oriental Music" in nav and "B Library" in nav
