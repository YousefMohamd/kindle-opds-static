"""Tests for `tbi submit-book` (v0.4): source validation and individual
indexing with the source recorded. Offline, no credentials."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tbi.cli import main  # noqa: E402
from tbi.store import Store  # noqa: E402
from tbi.submit import submit_book, validate_source  # noqa: E402


# --- validate_source -------------------------------------------------------

@pytest.mark.parametrize(
    "raw, kind, handle, post_id, url",
    [
        ("https://t.me/testchan/42", "telegram", "testchan", 42,
         "https://t.me/testchan/42"),
        ("https://t.me/testchan", "telegram", "testchan", None,
         "https://t.me/testchan"),
        ("t.me/testchan/42", "telegram", "testchan", 42,
         "https://t.me/testchan/42"),
        ("www.t.me/testchan", "telegram", "testchan", None,
         "https://t.me/testchan"),
        ("https://example.com/books/dune.epub", "external", None, None,
         "https://example.com/books/dune.epub"),
        ("http://example.org/book.pdf", "external", None, None,
         "http://example.org/book.pdf"),
        ("example.com/book.epub", "external", None, None,
         "example.com/book.epub"),
    ],
)
def test_validate_source_accepts(raw, kind, handle, post_id, url):
    info = validate_source(raw)
    assert info["kind"] == kind
    assert info["handle"] == handle
    assert info["post_id"] == post_id
    assert info["url"] == url


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "   ",
        "not a url",
        "ftp://example.com/x.epub",
        "javascript:alert(1)",
        "@testchan",          # a bare handle is not a link
        "testchan",           # neither t.me nor a domain
        "https://t.me/",      # no handle
        "https://t.me/testchan/abc",   # post id must be a number
        "https://t.me/testchan/42/extra",
        "http://",            # no domain
        "https://t.me/testchan/42 with spaces",
    ],
)
def test_validate_source_rejects(raw):
    with pytest.raises(ValueError):
        validate_source(raw)


# --- submit_book -----------------------------------------------------------

def test_submit_book_telegram_post_link(tmp_path):
    db = tmp_path / "index.db"
    store = Store(db)
    try:
        record = submit_book(
            store, "https://t.me/testchan/42", "Dune",
            author="Frank Herbert", format="epub", size_bytes=1200000,
        )
        assert record["kind"] == "channel"
        assert record["source"] == "testchan"
        assert record["obtain_url"] == "https://t.me/testchan/42"
        assert record["filename"] == "Dune.epub"
        assert record["already_indexed_from"] == 0
        assert store.counts()["files"] == 1
        assert store.counts()["books"] == 1
        hits = store.search("Dune")
        assert len(hits) == 1
        assert hits[0].filename == "Dune.epub"
        assert hits[0].author == "Frank Herbert"
        assert hits[0].obtain_url == "https://t.me/testchan/42"
        assert hits[0].size_text == "1.1 MB"
    finally:
        store.close()


def test_submit_book_idempotent(tmp_path):
    db = tmp_path / "index.db"
    store = Store(db)
    try:
        submit_book(store, "https://t.me/testchan/42", "Dune", format="epub")
        submit_book(store, "https://t.me/testchan/42", "Dune", format="epub")
        assert store.counts()["files"] == 1
        assert store.counts()["posts"] == 1
    finally:
        store.close()


def test_submit_book_external_source(tmp_path):
    db = tmp_path / "index.db"
    store = Store(db)
    try:
        record = submit_book(
            store, "https://example.com/books/dune.pdf", "Dune",
            format="pdf",
        )
        assert record["kind"] == "submitted"
        assert record["source"] == "example.com"
        assert record["obtain_url"] == "https://example.com/books/dune.pdf"
        hits = store.search("Dune")
        assert len(hits) == 1
        assert hits[0].source_name == "example.com"
    finally:
        store.close()


def test_submit_book_reports_already_indexed(tmp_path):
    db = tmp_path / "index.db"
    store = Store(db)
    try:
        # The same book already in the index from a channel walk.
        sid = store.upsert_source("channel", "otherchan")
        pid = store.upsert_post(
            sid, 7, "2026-11-06T10:00:00+00:00", "", ""
        )
        store.replace_files_for_post(pid, [{
            "filename": "Dune.epub", "ext": "epub",
            "size_text": "1.1 MB", "size_bytes": 1200000,
            "title": "Dune", "author": "Frank Herbert",
            "dedupe_key": "dune|frank herbert|1200000",
            "obtain_url": "https://t.me/otherchan/7",
        }])
        store.commit()
        record = submit_book(
            store, "https://t.me/testchan/42", "Dune",
            author="Frank Herbert", format="epub", size_bytes=1200000,
        )
        assert record["already_indexed_from"] == 1
        assert store.counts()["books"] == 1  # still one distinct book
        assert store.counts()["files"] == 2  # now in two sources
    finally:
        store.close()


def test_submit_book_validation_errors(tmp_path):
    db = tmp_path / "index.db"
    store = Store(db)
    try:
        with pytest.raises(ValueError, match="not a valid source"):
            submit_book(store, "ftp://example.com/x.epub", "Dune")
        with pytest.raises(ValueError, match="unsupported format"):
            submit_book(store, "https://t.me/testchan/1", "Dune", format="mp3")
        with pytest.raises(ValueError, match="title must not be empty"):
            submit_book(store, "https://t.me/testchan/1", "   ")
    finally:
        store.close()


def test_submit_book_size_text_derives_bytes(tmp_path):
    db = tmp_path / "index.db"
    store = Store(db)
    try:
        submit_book(
            store, "https://t.me/testchan/1", "Dune",
            format="epub", size_text="1.2 MB",
        )
        # "1.2 MB" parses to 1.2 * 1024**2 bytes (parse_size); the
        # display text is kept as given.
        row = store.conn.execute(
            "SELECT size_bytes, size_text FROM files"
        ).fetchone()
        assert row["size_bytes"] == 1258291
        assert row["size_text"] == "1.2 MB"
        assert store.search("Dune")[0].size_text == "1.2 MB"
    finally:
        store.close()


# --- CLI -------------------------------------------------------------------

def test_submit_book_cli(tmp_path, capsys):
    db = tmp_path / "index.db"
    assert main([
        "submit-book", "--source", "https://t.me/testchan/42",
        "--title", "Dune", "--author", "Frank Herbert",
        "--format", "epub", "--size", "1200000", "--db", str(db),
    ]) == 0
    out = capsys.readouterr().out
    assert "Indexed: Dune" in out
    assert "Frank Herbert" in out
    assert "https://t.me/testchan/42" in out
    assert main(["search", "Dune", "--db", str(db)]) == 0
    assert "Dune.epub" in capsys.readouterr().out


def test_submit_book_cli_rejects_bad_source(tmp_path, capsys):
    db = tmp_path / "index.db"
    assert main([
        "submit-book", "--source", "ftp://example.com/x.epub",
        "--title", "Dune", "--db", str(db),
    ]) == 2
    assert "not a valid source" in capsys.readouterr().err


def test_submit_book_cli_rejects_bad_format(tmp_path, capsys):
    db = tmp_path / "index.db"
    assert main([
        "submit-book", "--source", "https://t.me/testchan/42",
        "--title", "Dune", "--format", "mp3", "--db", str(db),
    ]) == 2
    assert "unsupported format" in capsys.readouterr().err
