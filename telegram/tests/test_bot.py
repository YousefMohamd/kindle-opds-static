"""Tests for the RliBook bot (v0.5.1).

No network and no Telegram token are needed: HTTP calls are mocked.
The handler import test is skipped if python-telegram-bot is not installed
(pytest.importorskip); the pure modules (bookcheck, limits, stats, messages,
submissions) have no such dependency.
"""

import asyncio
import json
import sys
from pathlib import Path

import pytest

# The bot package lives in rlibook-bot/ at the repo root; the tests live in
# telegram/tests/. Add the bot directory to sys.path.
REPO_ROOT = Path(__file__).resolve().parents[2]
BOT_DIR = REPO_ROOT / "rlibook-bot"
if str(BOT_DIR) not in sys.path:
    sys.path.insert(0, str(BOT_DIR))

from rlibook_bot import __version__  # noqa: E402
from rlibook_bot.bookcheck import check_book  # noqa: E402
from rlibook_bot.limits import Limits, parse_referral, referral_link  # noqa: E402
from rlibook_bot.messages import (  # noqa: E402
    download_message,
    parse_addbook_args,
    parse_channel_arg,
    parse_download_link,
)
from rlibook_bot.stats import fetch_stats, format_resources  # noqa: E402
from rlibook_bot.submissions import HEADER, log_submission  # noqa: E402


class _Resp:
    def __init__(self, payload=None, text=""):
        self._payload = payload or {}
        self.text = text

    def json(self):
        return self._payload


def _google_books(year):
    def fake(url, params=None, timeout=None):
        if "googleapis" in url:
            if year is None:
                return _Resp({"items": []})
            return _Resp({"items": [{"volumeInfo": {"publishedDate": str(year)}}]})
        return _Resp({"docs": []})

    return fake


def _open_library(year):
    def fake(url, params=None, timeout=None):
        if "openlibrary" in url:
            if year is None:
                return _Resp({"docs": []})
            return _Resp({"docs": [{"first_publish_year": year}]})
        return _Resp({"items": []})

    return fake


def _both(google_year, ol_year):
    def fake(url, params=None, timeout=None):
        if "googleapis" in url:
            if google_year is None:
                return _Resp({"items": []})
            return _Resp({"items": [{"volumeInfo": {"publishedDate": str(google_year)}}]})
        if "openlibrary" in url:
            if ol_year is None:
                return _Resp({"docs": []})
            return _Resp({"docs": [{"first_publish_year": ol_year}]})
        raise AssertionError("unexpected url: " + url)

    return fake


# --- bookcheck ---


def test_version_is_0_5_1():
    assert __version__ == "0.5.1"


def test_bookcheck_recent_commercial_is_refused():
    result = check_book("Some New Bestseller", "A. Author", http_get=_both(2025, 2025))
    assert result["verdict"] == "refuse"
    assert result["year"] == 2025
    assert "recent" in result["reason"].lower()


def test_bookcheck_public_domain_is_ok():
    result = check_book("Pride and Prejudice", "Jane Austen", http_get=_both(1813, 1813))
    assert result["verdict"] == "ok"
    assert result["year"] == 1813
    assert "public domain" in result["reason"].lower()


def test_bookcheck_old_non_recent_is_ok():
    result = check_book("Some Book", "A. Author", http_get=_both(1998, 1998))
    assert result["verdict"] == "ok"
    assert result["year"] == 1998


def test_bookcheck_not_found_is_unknown_not_refused():
    result = check_book("A Book That Does Not Exist Anywhere", http_get=_both(None, None))
    assert result["verdict"] == "unknown"
    assert result["year"] is None


def test_bookcheck_google_fails_falls_back_to_open_library():
    def fake(url, params=None, timeout=None):
        if "googleapis" in url:
            raise ConnectionError("down")
        return _Resp({"docs": [{"first_publish_year": 1950}]})

    result = check_book("Some Book", http_get=fake)
    assert result["verdict"] == "ok"
    assert result["year"] == 1950
    assert result["source"] == "Open Library"


def test_bookcheck_empty_title_is_unknown():
    result = check_book("   ", http_get=_both(2025, 2025))
    assert result["verdict"] == "unknown"


# --- limits ---

DAY = "2026-11-08"


def test_limits_channel_5_per_day():
    lim = Limits()
    for _ in range(5):
        assert lim.can(111, "channel", DAY)
        lim.record(111, "channel", DAY)
    assert not lim.can(111, "channel", DAY)
    assert lim.used(111, "channel", DAY) == 5
    # A different user is unaffected, and a different day resets.
    assert lim.can(222, "channel", DAY)
    assert lim.can(111, "channel", "2026-11-09")


def test_limits_priority_3_per_day():
    lim = Limits()
    for _ in range(3):
        assert lim.can(111, "priority", DAY)
        lim.record(111, "priority", DAY)
    assert not lim.can(111, "priority", DAY)


def test_limits_owner_is_exempt():
    lim = Limits()
    for _ in range(9):
        assert lim.can(999, "channel", DAY, is_owner=True)
        lim.record(999, "channel", DAY)
    assert lim.can(999, "channel", DAY, is_owner=True)


def test_referral_grants_bonus_and_is_once_only():
    lim = Limits()
    assert lim.apply_referral(100, 200, DAY) is True
    assert lim.allowance(100, "channel", DAY) == 10  # 5 base + 5 referral
    assert lim.allowance(100, "priority", DAY) == 6  # 3 base + 3 referral
    assert lim.allowance(200, "channel", DAY) == 6  # 5 base + 1 new-user bonus
    assert lim.allowance(200, "priority", DAY) == 4  # 3 base + 1 new-user bonus
    # Same referral again does nothing.
    assert lim.apply_referral(100, 200, DAY) is False
    assert lim.allowance(100, "channel", DAY) == 10
    # Self-referral is rejected.
    assert lim.apply_referral(100, 100, DAY) is False


def test_referral_link_and_parse():
    assert referral_link("RliBook_bot", 123) == "https://t.me/RliBook_bot?start=ref_123"
    assert parse_referral("ref_123") == 123
    assert parse_referral("hello") is None
    assert parse_referral(None) is None
    assert parse_referral("ref_abc") is None


# --- resources (/resources: channels + books only) ---

SAMPLE_REPORT = (
    "# Index report — telegram-book-index\n\n"
    "## Summary so far\n"
    "- **Channels with data: 51 of 51 walkable** — **206270 posts, 57723 book files** (51930 distinct books)\n"
    "- **Groups indexed from exports: 168** — 0 more groups are commented out in channels.yaml\n"
)


def test_resources_parse_sample_report():
    stats = fetch_stats(http_get=lambda url, timeout=None: _Resp(text=SAMPLE_REPORT))
    assert stats == {"channels": 51, "books": 51930}
    formatted = format_resources(stats)
    assert "51" in formatted
    assert "51,930" in formatted
    assert "kindle-opds-static.pages.dev" in formatted
    # Only channels + books: no posts, files or groups.
    assert "206,270" not in formatted
    assert "57,723" not in formatted
    assert "168" not in formatted


def test_resources_unavailable_returns_none_and_message():
    def failing(url, timeout=None):
        raise ConnectionError("down")

    assert fetch_stats(http_get=failing) is None
    assert "unavailable" in format_resources(None).lower()
    assert fetch_stats(http_get=lambda url, timeout=None: _Resp(text="nothing here")) is None


# --- submissions log ---


def test_submissions_log_creates_file_with_header_and_appends(tmp_path):
    path = tmp_path / "submissions.jsonl"
    assert log_submission(
        111, "channel", "@books", "pending", "received; verification pending",
        path=str(path), timestamp="2026-11-10T08:00:00Z",
    ) is True
    lines = path.read_text(encoding="utf-8").splitlines()
    assert lines[0] == HEADER.rstrip("\n")
    rec = json.loads(lines[1])
    assert rec == {
        "timestamp": "2026-11-10T08:00:00Z",
        "user_id": 111,
        "type": "channel",
        "title": "@books",
        "status": "pending",
        "reason": "received; verification pending",
    }
    # Second append: header is not duplicated.
    assert log_submission(
        222, "book", "Dune", "accepted", "source: X; ok",
        path=str(path), timestamp="2026-11-10T08:01:00Z",
    ) is True
    lines = path.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 3
    assert lines[0].startswith("#")
    assert json.loads(lines[2])["title"] == "Dune"


def test_submissions_log_unwritable_path_returns_false(tmp_path):
    # A directory as the path: open() raises IsADirectoryError (an OSError).
    assert log_submission(
        111, "book", "Dune", "accepted", "ok", path=str(tmp_path)
    ) is False


# --- download deep link ---


def test_parse_download_link():
    assert parse_download_link("dl_kindel4_19969_pdf") == ("kindel4", "19969", "pdf")
    # Handles may contain underscores; the all-digit post id anchors the split.
    assert parse_download_link("dl_hazem_massaod_kindle_books_2834_epub") == (
        "hazem_massaod_kindle_books",
        "2834",
        "epub",
    )
    assert parse_download_link("dl_books_123_EPUB") == ("books", "123", "epub")
    assert parse_download_link("ref_123") is None
    assert parse_download_link("dl_books_pdf") is None
    assert parse_download_link("dl_books_abc_pdf") is None
    assert parse_download_link("") is None
    assert parse_download_link(None) is None


def test_download_message_has_post_link_and_no_false_promise():
    msg = download_message("kindel4", "19969", "pdf")
    assert "https://t.me/kindel4/19969" in msg
    assert "PDF" in msg
    assert "cannot" in msg.lower()
    assert "send you the file" in msg.lower()


# --- messages / parsing ---


def test_parse_addbook_args():
    assert parse_addbook_args("Pride and Prejudice | Jane Austen | Project Gutenberg") == (
        "Pride and Prejudice",
        "Jane Austen",
        "Project Gutenberg",
    )
    assert parse_addbook_args("Dune") == ("Dune", None, None)
    assert parse_addbook_args("Dune | Frank Herbert") == ("Dune", "Frank Herbert", None)
    assert parse_addbook_args("") == (None, None, None)
    assert parse_addbook_args("   ") == (None, None, None)
    assert parse_addbook_args(" | Author | Source") == (None, None, None)


def test_parse_channel_arg():
    assert parse_channel_arg("@books") == "books"
    assert parse_channel_arg("https://t.me/books") == "books"
    assert parse_channel_arg("http://t.me/books/") == "books"
    assert parse_channel_arg("books") == "books"
    assert parse_channel_arg("") is None
    assert parse_channel_arg("   ") is None


# --- handlers import (needs python-telegram-bot) ---


def test_handlers_and_main_import():
    pytest.importorskip("telegram")
    from rlibook_bot import handlers, main  # noqa: F401

    for name in ("start", "help_command", "kindle", "donate", "resources", "invite", "addchannel", "addbook", "priority"):
        assert callable(getattr(handlers, name)), name
    assert callable(main.main)


class _FakeMessage:
    def __init__(self):
        self.texts = []

    async def reply_text(self, text):
        self.texts.append(text)


class _FakeUser:
    def __init__(self, user_id):
        self.id = user_id


class _FakeUpdate:
    def __init__(self, user_id=111):
        self.effective_user = _FakeUser(user_id)
        self.message = _FakeMessage()


class _FakeContext:
    def __init__(self, args=None):
        self.args = args or []
        self.application = type("A", (), {"bot_data": {}})()


def test_start_download_deep_link():
    pytest.importorskip("telegram")
    from rlibook_bot import handlers

    update = _FakeUpdate()
    asyncio.run(handlers.start(update, _FakeContext(args=["dl_kindel4_19969_pdf"])))
    assert len(update.message.texts) == 1
    assert "https://t.me/kindel4/19969" in update.message.texts[0]


def test_resources_handler_shows_only_channels_and_books(monkeypatch):
    pytest.importorskip("telegram")
    from rlibook_bot import handlers

    monkeypatch.setattr(handlers, "fetch_stats", lambda: {"channels": 51, "books": 51930})
    update = _FakeUpdate()
    asyncio.run(handlers.resources(update, _FakeContext()))
    assert len(update.message.texts) == 1
    text = update.message.texts[0]
    assert "51" in text and "51,930" in text
    assert "Posts" not in text and "Groups" not in text
