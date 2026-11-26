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


def _run_all(monkeypatch, tmp_path, registry, batch_files):
    """Run drive_opds.py --all with the given batch-dir contents.

    batch_files: {filename: text-or-object} under d1-batches-drive/.
    Returns (rc, out_dir, counts_path).
    """
    batch_dir = tmp_path / "d1-batches-drive"
    batch_dir.mkdir()
    for name, content in batch_files.items():
        p = batch_dir / name
        p.write_text(content if isinstance(content, str)
                     else json.dumps(content, ensure_ascii=False),
                     encoding="utf-8")
    reg_path = tmp_path / "drive-libraries.json"
    reg_path.write_text(json.dumps(registry, ensure_ascii=False), encoding="utf-8")
    out = tmp_path / "drive"
    counts = tmp_path / "counts.json"
    monkeypatch.setattr(sys, "argv", [
        "drive_opds.py", "--all",
        "--registry", str(reg_path), "--batch-dir", str(batch_dir),
        "--out", str(out), "--counts-out", str(counts),
    ])
    return drive_opds.main(), out, counts


def test_all_merges_two_public_libraries_and_excludes_private(monkeypatch, tmp_path):
    """--all writes ONE combined search index (the single-library
    path overwrites it with one library) + both feeds, and a private
    library never appears (Build 2)."""
    from d1_sync import batch_sql

    other_books = [{
        "title": "كتاب آخر", "author": "", "source": f"drive:{OTHER}",
        "kind": "drive", "ext": "pdf", "size": "1 KB", "date": "2025-01-01",
        "url": "https://drive.google.com/file/d/FILEOTHER12345678/view",
        "filename": "other.pdf", "file_id": "FILEOTHER12345678"}]
    sql, _ = batch_sql(other_books, 1)
    priv_folder = "PRIVLIB12345678901234"
    priv_books = [dict(BOOKS[0], folder_id=priv_folder,
                       library_title="Private Lib",
                       file_id="FILEPRIV1234567890", title="كتاب خاص")]
    rc, out, counts = _run_all(monkeypatch, tmp_path,
        {"libraries": [
            {"folder_id": FOLDER, "title": "Oriental Music", "visibility": "public"},
            {"folder_id": OTHER, "title": "B Library", "visibility": "public"},
            {"folder_id": priv_folder, "title": "Private Lib",
             "visibility": "private"},
        ]},
        {f"drive-{FOLDER[:12]}-books.json": BOOKS,
         f"drive-{OTHER[:12]}.sql": sql,
         f"drive-{priv_folder[:12]}-books.json": priv_books})
    assert rc == 0
    index = json.loads((out / "search-index.json").read_text(encoding="utf-8"))
    titles = [r["t"] for r in index]
    assert "نزهة الزمان" in titles and "كتاب آخر" in titles
    assert "كتاب خاص" not in titles
    nav = (out / "index.xml").read_text(encoding="utf-8")
    assert "Oriental Music" in nav and "B Library" in nav
    assert "Private Lib" not in nav
    assert "كتاب آخر" in (out / OTHER / "index.xml").read_text(encoding="utf-8")
    assert not (out / priv_folder).exists()
    counts_data = json.loads(counts.read_text(encoding="utf-8"))
    assert counts_data == {FOLDER: 1, OTHER: 1}


def test_all_skips_library_without_artifacts(monkeypatch, tmp_path):
    """A public library with no books JSON / batch SQL is warned
    about and skipped — the other libraries still publish."""
    rc, out, _ = _run_all(monkeypatch, tmp_path,
        {"libraries": [
            {"folder_id": FOLDER, "title": "Oriental Music", "visibility": "public"},
            {"folder_id": OTHER, "title": "Ghost Lib", "visibility": "public"},
        ]},
        {f"drive-{FOLDER[:12]}-books.json": BOOKS})
    assert rc == 0
    index = json.loads((out / "search-index.json").read_text(encoding="utf-8"))
    assert len(index) == 1 and index[0]["t"] == "نزهة الزمان"
    assert "Ghost Lib" not in (out / "index.xml").read_text(encoding="utf-8")


def test_all_no_public_libraries_writes_empty_surfaces(monkeypatch, tmp_path):
    """WAVE 7 retraction: the registry lists libraries but NONE is
    public anymore (the last public library flipped private) — --all
    writes EMPTY combined surfaces and exits 0, so the flip retracts
    instead of leaving the previous files live."""
    rc, out, counts = _run_all(monkeypatch, tmp_path,
        {"libraries": [
            {"folder_id": FOLDER, "title": "Oriental Music", "visibility": "private"},
        ]},
        {f"drive-{FOLDER[:12]}-books.json": BOOKS})
    assert rc == 0
    assert json.loads((out / "search-index.json").read_text(encoding="utf-8")) == []
    assert "Oriental Music" not in (out / "index.xml").read_text(encoding="utf-8")
    assert not (out / FOLDER).exists()
    assert json.loads(counts.read_text(encoding="utf-8")) == {}


def test_all_empty_registry_still_exits_2(monkeypatch, tmp_path):
    """A registry with NO entries at all is untrusted: --all still
    exits 2 and writes nothing (it must never nuke the live feeds
    on a missing/misconfigured registry)."""
    rc, out, _ = _run_all(monkeypatch, tmp_path, {"libraries": []}, {})
    assert rc == 2
    assert not (out / "search-index.json").exists()


def _seed_public_surfaces(out):
    """Pretend the previous publish: one public library's feed +
    combined files, as drive_opds --all would have written them."""
    out.mkdir(parents=True, exist_ok=True)
    (out / FOLDER).mkdir(exist_ok=True)
    (out / FOLDER / "index.xml").write_text(
        acquisition_feed(FOLDER, "Oriental Music", BOOKS[:1]), encoding="utf-8")
    (out / "search-index.json").write_text(
        json.dumps(search_index_entries(BOOKS), ensure_ascii=False), encoding="utf-8")
    (out / "index.xml").write_text(
        navigation_feed([{"folder_id": FOLDER, "title": "Oriental Music",
                          "count": 1}]), encoding="utf-8")


def test_all_flip_retracts_feed_and_combined_files(monkeypatch, tmp_path):
    """Public -> private flip: the next --all deletes the orphan
    per-library feed AND empties the combined files (the feed is the
    hole --all used to leave live)."""
    batch_dir = tmp_path / "d1-batches-drive"
    batch_dir.mkdir()
    (batch_dir / f"drive-{FOLDER[:12]}-books.json").write_text(
        json.dumps(BOOKS, ensure_ascii=False), encoding="utf-8")
    reg_path = tmp_path / "drive-libraries.json"
    reg_path.write_text(json.dumps(
        {"libraries": [{"folder_id": FOLDER, "title": "Oriental Music",
                        "visibility": "private"}]}, ensure_ascii=False),
        encoding="utf-8")
    out = tmp_path / "drive"
    _seed_public_surfaces(out)
    counts = tmp_path / "counts.json"
    monkeypatch.setattr(sys, "argv", [
        "drive_opds.py", "--all",
        "--registry", str(reg_path), "--batch-dir", str(batch_dir),
        "--out", str(out), "--counts-out", str(counts),
    ])
    assert drive_opds.main() == 0
    assert not (out / FOLDER).exists()  # the orphan feed is gone
    assert json.loads((out / "search-index.json").read_text(encoding="utf-8")) == []
    assert "Oriental Music" not in (out / "index.xml").read_text(encoding="utf-8")
    assert json.loads(counts.read_text(encoding="utf-8")) == {}


def test_all_flip_keeps_other_public_library(monkeypatch, tmp_path):
    """One library flips private while another stays public: only
    the flipped feed is deleted; the public library's files and the
    combined index keep exactly its books."""
    from d1_sync import batch_sql

    other_books = [{
        "title": "كتاب آخر", "author": "", "source": f"drive:{OTHER}",
        "kind": "drive", "ext": "pdf", "size": "1 KB", "date": "2025-01-01",
        "url": "https://drive.google.com/file/d/FILEOTHER12345678/view",
        "filename": "other.pdf", "file_id": "FILEOTHER12345678"}]
    sql, _ = batch_sql(other_books, 1)
    # Seed the flipped library's stale feed BEFORE the run, as the
    # previous publish would have left it.
    out = tmp_path / "drive"
    (out / FOLDER).mkdir(parents=True)
    (out / FOLDER / "index.xml").write_text(
        acquisition_feed(FOLDER, "Oriental Music", BOOKS[:1]), encoding="utf-8")
    rc, out2, counts = _run_all(monkeypatch, tmp_path,
        {"libraries": [
            {"folder_id": FOLDER, "title": "Oriental Music", "visibility": "private"},
            {"folder_id": OTHER, "title": "B Library", "visibility": "public"},
        ]},
        {f"drive-{FOLDER[:12]}-books.json": BOOKS,
         f"drive-{OTHER[:12]}.sql": sql})
    assert rc == 0
    assert out2 == out
    assert not (out2 / FOLDER).exists()
    assert (out2 / OTHER / "index.xml").exists()
    index = json.loads((out2 / "search-index.json").read_text(encoding="utf-8"))
    assert [r["t"] for r in index] == ["كتاب آخر"]
    nav = (out2 / "index.xml").read_text(encoding="utf-8")
    assert "B Library" in nav and "Oriental Music" not in nav
    assert json.loads(counts.read_text(encoding="utf-8")) == {OTHER: 1}


def test_single_library_private_retracts_live_files(monkeypatch, tmp_path):
    """Single-library mode for a flipped library removes its feed,
    its navigation entry and its rows in the combined search index
    (it used to SKIP and leave all three live)."""
    books_path = tmp_path / "books.json"
    books_path.write_text(json.dumps(BOOKS, ensure_ascii=False), encoding="utf-8")
    reg_path = tmp_path / "drive-libraries.json"
    reg_path.write_text(json.dumps(
        {"libraries": [{"folder_id": FOLDER, "visibility": "private"}]},
        ensure_ascii=False), encoding="utf-8")
    out = tmp_path / "drive"
    _seed_public_surfaces(out)
    monkeypatch.setattr(sys, "argv", [
        "drive_opds.py", "--books", str(books_path),
        "--registry", str(reg_path), "--out", str(out),
    ])
    assert drive_opds.main() == 0
    assert not (out / FOLDER).exists()
    assert json.loads((out / "search-index.json").read_text(encoding="utf-8")) == []
    assert "Oriental Music" not in (out / "index.xml").read_text(encoding="utf-8")


def test_retract_orphan_feeds_ignores_non_folder_dirs(tmp_path):
    """The orphan sweep only touches directories named like a Drive
    folder id — anything else under drive/ is left alone."""
    out = tmp_path / "drive"
    (out / FOLDER).mkdir(parents=True)
    (out / FOLDER / "index.xml").write_text("<feed/>", encoding="utf-8")
    (out / "notes").mkdir()
    (out / "notes" / "index.xml").write_text("<feed/>", encoding="utf-8")
    removed = drive_opds.retract_orphan_feeds(out, set())
    assert removed == [FOLDER]
    assert not (out / FOLDER).exists()
    assert (out / "notes" / "index.xml").exists()
