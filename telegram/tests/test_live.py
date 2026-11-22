"""Tests for tbi.live — DO live-additions (real-time sync layer)."""

import json
import os
import sys
import urllib.error
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tbi.live import (  # noqa: E402
    LIVE_CURSOR_KEY,
    LIVE_KEY,
    LiveStateClient,
    append_live_books,
    live_books_from_post,
    live_totals,
    merge_live_books,
    parse_live,
    read_cursor,
    read_live,
    reset_live,
    write_cursor,
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


class _FakeStore:
    """LiveStateStore test double (in-memory dict)."""

    def __init__(self):
        self.data: dict[str, str] = {}

    def get(self, key):
        return self.data.get(key)

    def put(self, key, value):
        self.data[key] = value


def test_append_and_read_round_trip():
    kv = _FakeStore()
    assert read_live(kv)["books"] == []
    value = append_live_books(kv, [_book()])
    assert value["totals"] == {"posts": 1, "files": 1, "books": 1}
    assert read_live(kv)["books"] == [_book()]
    # Appending the same book again does not duplicate it.
    value = append_live_books(kv, [_book()])
    assert len(value["books"]) == 1
    assert value["totals"]["books"] == 1


def test_append_empty_is_a_no_op():
    kv = _FakeStore()
    assert append_live_books(kv, [])["books"] == []
    assert LIVE_KEY not in kv.data


def test_reset_live_clears_the_key():
    kv = _FakeStore()
    append_live_books(kv, [_book()])
    assert len(read_live(kv)["books"]) == 1
    reset_live(kv)
    assert read_live(kv)["books"] == []
    stored = json.loads(kv.data[LIVE_KEY])
    assert stored["books"] == []


def test_cursor_round_trip():
    store = _FakeStore()
    assert read_cursor(store) == {}
    write_cursor(store, {"chanA": 101, "chanB": 55})
    assert read_cursor(store) == {"chanA": 101, "chanB": 55}
    assert json.loads(store.data[LIVE_CURSOR_KEY]) == {"chanA": 101, "chanB": 55}


def test_live_state_requires_token():
    with patch.dict("os.environ", {}, clear=True):
        try:
            LiveStateClient()
        except RuntimeError as exc:
            assert "LIVE_SYNC_TOKEN" in str(exc)
        else:
            raise AssertionError("expected RuntimeError")
    # With the token set it constructs (default bot URL).
    with patch.dict(
        "os.environ", {"LIVE_SYNC_TOKEN": "tok"}, clear=True
    ):
        client = LiveStateClient()
        assert client.bot_url == LiveStateClient.DEFAULT_BOT_URL
    # RLIBOOK_BOT_URL overrides the bot URL.
    with patch.dict(
        "os.environ",
        {"LIVE_SYNC_TOKEN": "tok", "RLIBOOK_BOT_URL": "https://bot.example/"},
        clear=True,
    ):
        assert LiveStateClient().bot_url == "https://bot.example"


class _FakeResponse:
    """Minimal urlopen response (status + read + context manager)."""

    def __init__(self, status, body: bytes):
        self.status = status
        self._body = body

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _FakeHTTPError(urllib.error.HTTPError):
    """urllib.error.HTTPError with a canned body (what urlopen raises
    on a non-2xx status)."""

    def __init__(self, code, body: bytes):
        super().__init__(
            "https://bot.example/api/live-state", code, f"HTTP {code}", {}, None
        )
        self._body = body

    def read(self):
        return self._body


def _client_with_http(calls, responses):
    """LiveStateClient whose urlopen is stubbed.

    ``responses`` maps (method, key) -> (status, body); every call is
    recorded in ``calls`` as (method, url, body, auth_header). A
    non-2xx status is raised as _FakeHTTPError, like urlopen does.
    """
    from urllib.parse import unquote

    client = LiveStateClient(token="tok", bot_url="https://bot.example")

    def fake_urlopen(req, timeout=30):
        method = req.get_method()
        url = req.full_url
        key = unquote(url.split("key=", 1)[1])
        body = req.data or b""
        calls.append((method, url, body, req.get_header("Authorization")))
        status, payload = responses[(method, key)]
        if status >= 400:
            raise _FakeHTTPError(status, payload)
        return _FakeResponse(status, payload)

    patcher = patch("urllib.request.urlopen", side_effect=fake_urlopen)
    patcher.start()
    return client, patcher


def test_live_state_client_get_put_round_trip():
    calls = []
    doc = json.dumps({"since": "2026-11-22T00:00:00+00:00", "books": []})
    client, patcher = _client_with_http(
        calls,
        {
            ("GET", LIVE_KEY): (404, b""),
            ("PUT", LIVE_KEY): (200, b'{"ok":true}'),
        },
    )
    try:
        assert client.get(LIVE_KEY) is None
        client.put(LIVE_KEY, doc)
    finally:
        patcher.stop()
    assert len(calls) == 2
    method, url, body, auth = calls[1]
    assert method == "PUT"
    assert url == "https://bot.example/api/live-state?key=live%3Aadditions"
    assert body == doc.encode("utf-8")
    assert auth == "Bearer tok"


def test_live_state_client_get_returns_body():
    calls = []
    doc = json.dumps({"chanA": 101})
    client, patcher = _client_with_http(
        calls, {("GET", LIVE_CURSOR_KEY): (200, doc.encode("utf-8"))}
    )
    try:
        assert client.get(LIVE_CURSOR_KEY) == doc
    finally:
        patcher.stop()
    assert calls[0][0] == "GET"
    assert calls[0][3] == "Bearer tok"


def test_live_state_client_put_failure_raises():
    calls = []
    client, patcher = _client_with_http(
        calls, {("PUT", LIVE_KEY): (401, b'{"ok":false,"error":"unauthorized"}')}
    )
    try:
        try:
            client.put(LIVE_KEY, "{}")
        except RuntimeError as exc:
            assert "401" in str(exc)
        else:
            raise AssertionError("expected RuntimeError")
    finally:
        patcher.stop()


def test_live_state_client_sends_rlibook_user_agent():
    """Run #491: Cloudflare 1010 blocks python-urllib's default UA."""
    seen = {}

    def fake_urlopen(req, timeout=30):
        seen["ua"] = req.get_header("User-agent")
        seen["accept"] = req.get_header("Accept")
        return _FakeResponse(200, b"{}")

    client = LiveStateClient(token="tok", bot_url="https://bot.example")
    with patch("urllib.request.urlopen", side_effect=fake_urlopen):
        assert client.get(LIVE_CURSOR_KEY) == "{}"
    assert seen["ua"] == "RliBook/1.0 (+https://rlibook.tech)"
    assert seen["accept"] == "*/*"


def test_live_state_client_retries_transient_drop_then_succeeds():
    """Cloudflare intermittently drops python-urllib connections
    (RemoteDisconnected / IncompleteRead); one transient drop must
    not fail the sync — the client retries with backoff."""
    calls = []

    def fake_urlopen(req, timeout=30):
        calls.append(req.get_method())
        if len(calls) == 1:
            raise urllib.error.URLError("Remote end closed connection")
        return _FakeResponse(200, b'{"ok":true}')

    client = LiveStateClient(token="tok", bot_url="https://bot.example")
    with patch("urllib.request.urlopen", side_effect=fake_urlopen):
        assert client.get(LIVE_CURSOR_KEY) == '{"ok":true}'
    assert len(calls) == 2
