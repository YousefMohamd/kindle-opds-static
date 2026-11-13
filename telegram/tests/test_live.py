"""Tests for tbi.live — KV live-additions (real-time sync layer)."""

import json
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tbi.live import (  # noqa: E402
    LIVE_KEY,
    CloudflareKV,
    append_live_books,
    live_books_from_post,
    live_totals,
    merge_live_books,
    parse_live,
    read_live,
    reset_live,
)
from tbi.scrape import FileMeta, Post  # noqa: E402


def _post(channel="testchan", post_id=123, files=None, text=""):
    return Post(
        channel=channel,
        post_id=post_id,
        date="2026-11-12T00:00:00+00:00",
        text=text,
        url=f"https://t.me/{channel}/{post_id}",
        files=files or [],
    )


def _book(**over):
    b = {
        "id": "testchan:123:epub",
        "title": "The Book of Tea",
        "author": "Kakuzo Okakura",
        "source": "testchan",
        "kind": "channel",
        "format": "EPUB",
        "filename": "The Book of Tea - Kakuzo Okakura.epub",
        "size_text": "1.2 MB",
        "size_bytes": 1234567,
        "url": "https://t.me/testchan/123",
        "post_id": 123,
        "date": "2026-11-12T00:00:00+00:00",
        "added_at": "2026-11-12T00:00:00+00:00",
        "dedupe_key": "the book of tea|kakuzo okakura|1234567",
    }
    b.update(over)
    return b


def test_live_books_from_post_parses_title_author():
    post = _post(files=[FileMeta(filename="The Book of Tea - Kakuzo Okakura.epub", ext="epub", size_bytes=1234567)])
    books = live_books_from_post(post, "channel")
    assert len(books) == 1
    assert books[0]["title"] == "The Book of Tea"
    assert books[0]["author"] == "Kakuzo Okakura"
    assert books[0]["format"] == "EPUB"
    assert books[0]["id"] == "testchan:123:epub"
    assert books[0]["source"] == "testchan"
    assert books[0]["kind"] == "channel"


def test_live_books_from_post_new_formats():
    # The expanded format list (v0.5): a DOCX/DJVU post becomes a live
    # book, while audio/video still do not.
    post = _post(files=[
        FileMeta(filename="Dune - Frank Herbert.docx", ext="docx", size_bytes=1200000),
        FileMeta(filename="Dune - Frank Herbert.djvu", ext="djvu", size_bytes=3400000),
        FileMeta(filename="song.mp3", ext="mp3", size_bytes=5000000),
    ])
    books = live_books_from_post(post, "channel")
    assert [b["format"] for b in books] == ["DOCX", "DJVU"]
    assert books[0]["title"] == "Dune"


def test_live_books_from_post_skips_non_book_files():
    post = _post(files=[
        FileMeta(filename="photo.jpg", ext="jpg"),
        FileMeta(filename="notes.txt", ext="txt"),
        FileMeta(filename="video.mp4", ext="mp4"),
    ])
    books = live_books_from_post(post, "group")
    # txt IS a book format; jpg and mp4 are not.
    assert [b["format"] for b in books] == ["TXT"]


def test_live_books_from_post_empty_author_when_unknown():
    post = _post(files=[FileMeta(filename="Some Random Book.pdf", ext="pdf")])
    books = live_books_from_post(post, "channel")
    assert books[0]["title"] == "Some Random Book"
    assert books[0]["author"] == ""


def test_merge_dedupes_by_id_and_puts_new_first():
    old = [_book()]
    new = [_book(), _book(id="testchan:124:pdf", title="Another", post_id=124)]
    merged = merge_live_books(old, new)
    assert [b["id"] for b in merged] == ["testchan:124:pdf", "testchan:123:epub"]


def test_merge_caps_at_max():
    existing = [_book(id=f"chan:{i}:epub", post_id=i) for i in range(5)]
    new = [_book(id="chan:99:epub", post_id=99)]
    merged = merge_live_books(existing, new, max_books=5)
    assert len(merged) == 5
    assert merged[0]["id"] == "chan:99:epub"
    assert merged[-1]["id"] == "chan:3:epub"  # oldest dropped


def test_live_totals_counts_posts_files_books():
    books = [
        _book(id="a:1:epub", post_id=1, dedupe_key="k1"),
        _book(id="a:1:pdf", post_id=1, dedupe_key="k1"),  # same book, 2nd format
        _book(id="a:2:epub", post_id=2, dedupe_key="k2"),
    ]
    assert live_totals(books) == {"posts": 2, "files": 3, "books": 2}


def test_parse_live_rejects_bad_shapes():
    assert parse_live(None)["books"] == []
    assert parse_live("junk")["books"] == []
    assert parse_live({"books": "nope"})["books"] == []
    assert parse_live({"books": [{"no": "id"}, _book()]})["books"] == [_book()]


class _FakeKV(CloudflareKV):
    """CloudflareKV with the HTTP layer stubbed (in-memory dict)."""

    def __init__(self):
        self.data: dict[str, str] = {}

    def _request(self, method, key, body=None):
        if method == "GET":
            if key not in self.data:
                return 404, b""
            return 200, self.data[key].encode("utf-8")
        if method == "PUT":
            self.data[key] = body.decode("utf-8") if body else ""
            return 200, b'{"success": true}'
        raise AssertionError(method)


def test_append_and_read_round_trip():
    kv = _FakeKV()
    assert read_live(kv)["books"] == []
    value = append_live_books(kv, [_book()])
    assert value["totals"] == {"posts": 1, "files": 1, "books": 1}
    assert read_live(kv)["books"] == [_book()]
    # Appending the same book again does not duplicate it.
    value = append_live_books(kv, [_book()])
    assert len(value["books"]) == 1
    assert value["totals"]["books"] == 1


def test_append_empty_is_a_no_op():
    kv = _FakeKV()
    assert append_live_books(kv, [])["books"] == []
    assert LIVE_KEY not in kv.data


def test_reset_live_clears_the_key():
    kv = _FakeKV()
    append_live_books(kv, [_book()])
    assert len(read_live(kv)["books"]) == 1
    reset_live(kv)
    assert read_live(kv)["books"] == []
    stored = json.loads(kv.data[LIVE_KEY])
    assert stored["books"] == []


def test_kv_requires_credentials():
    with patch.dict("os.environ", {}, clear=True):
        try:
            CloudflareKV()
        except RuntimeError as exc:
            assert "CLOUDFLARE_API_TOKEN" in str(exc)
        else:
            raise AssertionError("expected RuntimeError")
