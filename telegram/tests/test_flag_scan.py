"""Tests for tbi.flag_scan — verdicts, clients, chunking, resume.

All offline: HTTP is injected through the clients' ``fetch``
callable, and the catalog is a temporary Store-seeded DB. No network
and no D1 access.
"""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tbi.flag_scan import (  # noqa: E402
    ApiError,
    Candidate,
    RateLimited,
    Scanner,
    decide,
    authors_match,
    enumerate_chunk,
    count_books,
    titles_match,
)
from tbi.store import Store  # noqa: E402


# ----------------------------------------------------------------------
# Matching
# ----------------------------------------------------------------------


def test_titles_match_exact_and_subtitle():
    assert titles_match("The Alchemist", "The Alchemist")
    assert titles_match("The Alchemist", "The Alchemist Graphic Novel")
    assert titles_match("The Alchemist Graphic Novel", "The Alchemist")
    assert not titles_match("The Alchemist", "The Pilgrimage")
    # Containment either way (the bot's flags.ts precedent): "Dune"
    # matches "Dune Messiah". decide() takes the FIRST matching
    # candidate and Open Library returns best matches first, so the
    # exact work normally wins; the evidence string always carries
    # the matched title so a human can catch a series mix-up.
    assert titles_match("Dune", "Dune Messiah")


def test_titles_match_arabic_normalization():
    assert titles_match("الجلاد تحت جلدي", "الجلاد تحت جلدي")
    assert titles_match("الجلاد تحت جلدي", "الجَلاد تحت جلدي")
    assert titles_match("مُتون طالب العلم", "متون طالب العلم")
    assert not titles_match("الجلاد تحت جلدي", "مقبرة الجلادين")


def test_titles_match_short_title_needs_exact():
    assert titles_match("It", "It")
    assert not titles_match("It", "Item")
    assert titles_match("Dune", "Dune")


def test_titles_match_reordered_words():
    assert titles_match("Old Man and the Sea", "The Sea and the Old Man")


def test_query_title_strips_leading_track_number():
    from tbi.flag_scan import query_title

    assert query_title("01. ONYX STORM") == "ONYX STORM"
    assert query_title("001 - أخلاق حملة القرآن") == "أخلاق حملة القرآن"
    assert query_title("007 - جزء فيه طرق") == "جزء فيه طرق"
    assert query_title("01) Dune") == "Dune"
    assert query_title("1984") == "1984"  # bare year, no separator: kept
    assert query_title("2001: A Space Odyssey") == "2001: A Space Odyssey"
    assert query_title("Onyx Storm") == "Onyx Storm"
    assert query_title("01.") == "01."  # nothing left: keep original
    assert query_title("") == ""


def test_authors_match_extra_name_parts():
    assert authors_match("عماد راشد", "عماد راشد عثمان")
    assert authors_match("عماد راشد عثمان", "عماد راشد")
    assert authors_match("Paulo Coelho", "Coelho, Paulo")
    assert not authors_match("Paulo Coelho", "Suzanne Collins")
    assert not authors_match("جاز", "عماد راشد")


def test_authors_match_single_word_must_appear():
    assert authors_match("جاز", "جاز المصري")
    assert not authors_match("جاز", "عماد راشد")


# ----------------------------------------------------------------------
# decide()
# ----------------------------------------------------------------------

NOW = 2026


def _ol(title, authors, year, publishers):
    return [
        Candidate(title, authors, publishers, year, "open-library")
    ]


def _gb(title, authors, year, publishers):
    return [
        Candidate(title, authors, publishers, year, "google-books")
    ]


def test_decide_flags_recent_commercial():
    v = decide(
        "Onyx Storm", "Rebecca Yarros",
        _ol("Onyx Storm", ["Rebecca Yarros"], 2025, ["Red Tower Books"]),
        [], current_year=NOW,
    )
    assert v.verdict == "flag"
    assert v.source == "open-library"
    assert "2025" in v.evidence and "Red Tower Books" in v.evidence


def test_decide_clears_old_commercial():
    v = decide(
        "The Alchemist", "Paulo Coelho",
        _ol("The Alchemist", ["Paulo Coelho"], 1988, ["HarperCollins"]),
        [], current_year=NOW,
    )
    assert v.verdict == "clear"
    assert "not recent" in v.reason


def test_decide_clears_public_domain():
    v = decide(
        "Pride and Prejudice", "Jane Austen",
        _ol("Pride and Prejudice", ["Jane Austen"], 1813, ["Penguin"]),
        [], current_year=NOW,
    )
    assert v.verdict == "clear"
    assert "public domain" in v.reason


def test_decide_uncertain_when_no_publisher():
    v = decide(
        "Some New Book", "A. Author",
        _ol("Some New Book", ["A. Author"], 2025, []),
        [], current_year=NOW,
    )
    assert v.verdict == "uncertain"
    assert "no publisher" in v.reason


def test_decide_uncertain_when_no_match():
    v = decide("الجلاد تحت جلدي", "عماد راشد", [], [], current_year=NOW)
    assert v.verdict == "uncertain"
    assert "no-match" in v.reason


def test_decide_uncertain_when_no_author_or_title():
    assert decide("Title", "", [], [], current_year=NOW).verdict == "uncertain"
    assert decide("", "Author", [], [], current_year=NOW).verdict == "uncertain"
    assert decide("Title", "", [], [], current_year=NOW).reason.startswith("no-author")


def test_decide_google_books_flags_when_ol_silent():
    v = decide(
        "New Book", "A. Author", [],
        _gb("New Book", ["A. Author"], 2026, ["Big Publisher"]),
        current_year=NOW,
    )
    assert v.verdict == "flag"
    assert v.source == "google-books"


def test_decide_open_library_year_beats_google_books_edition():
    # OL says first published 1965 (old); GB's top edition is a 2025
    # reprint. The first-publication year wins: not recent.
    v = decide(
        "Dune", "Frank Herbert",
        _ol("Dune", ["Frank Herbert"], 1965, ["Ace Books"]),
        _gb("Dune", ["Frank Herbert"], 2025, ["Penguin"]),
        current_year=NOW,
    )
    assert v.verdict == "clear"


def test_decide_google_books_earliest_edition_is_the_proxy():
    # Two GB editions (2025 reprint, 2024 reprint): the earliest is
    # 2024 — still recent (2026 - 2), so it flags. If the earliest
    # edition were 2020 it would clear instead.
    v = decide(
        "New Book", "A. Author", [],
        _gb("New Book", ["A. Author"], 2025, ["Pub"])
        + _gb("New Book", ["A. Author"], 2024, ["Pub"]),
        current_year=NOW,
    )
    assert v.verdict == "flag"
    v2 = decide(
        "New Book", "A. Author", [],
        _gb("New Book", ["A. Author"], 2025, ["Pub"])
        + _gb("New Book", ["A. Author"], 2020, ["Pub"]),
        current_year=NOW,
    )
    assert v2.verdict == "clear"


def test_decide_recent_years_none_flags_any_copyrighted():
    v = decide(
        "The Alchemist", "Paulo Coelho",
        _ol("The Alchemist", ["Paulo Coelho"], 1988, ["HarperCollins"]),
        [], current_year=NOW, recent_years=None,
    )
    assert v.verdict == "flag"


def test_decide_ignores_non_matching_candidates():
    # Same series, different author: no title+author match.
    v = decide(
        "Dune", "Frank Herbert",
        _ol("Dune Messiah", ["Brian Herbert"], 2025, ["Ace Books"]),
        [], current_year=NOW,
    )
    assert v.verdict == "uncertain"


# ----------------------------------------------------------------------
# Clients (injected fetch)
# ----------------------------------------------------------------------


def _resp(payload, status=200):
    def fetch(url):
        return status, payload

    return fetch


def test_open_library_client_parses_docs():
    from tbi.flag_scan import OpenLibraryClient

    payload = {
        "docs": [
            {
                "title": "Onyx Storm",
                "author_name": ["Rebecca Yarros"],
                "first_publish_year": 2025,
                "publish_year": [2025],
                "publisher": ["Red Tower Books"],
            },
            {"title": "Other", "author_name": ["Nobody"]},
        ]
    }
    cands = OpenLibraryClient(_resp(payload)).search("Onyx Storm", "Rebecca Yarros")
    assert len(cands) == 2
    assert cands[0].first_year == 2025
    assert cands[0].publishers == ["Red Tower Books"]
    assert cands[0].source == "open-library"
    assert cands[1].first_year is None


def test_open_library_client_falls_back_to_min_publish_year():
    from tbi.flag_scan import OpenLibraryClient

    payload = {
        "docs": [
            {
                "title": "Old Book",
                "author_name": ["A"],
                "publish_year": [1999, 2005],
                "publisher": ["P"],
            }
        ]
    }
    cands = OpenLibraryClient(_resp(payload)).search("Old Book", "A")
    assert cands[0].first_year == 1999


def test_open_library_client_sends_stripped_title():
    from tbi.flag_scan import OpenLibraryClient

    seen: list = []

    def fetch(url):
        seen.append(url)
        return 200, {"docs": []}

    OpenLibraryClient(fetch).search("01. ONYX STORM", "Rebecca Yarros")
    assert "01" not in seen[0].split("title=")[1].split("&")[0]
    assert "ONYX" in seen[0]
    from tbi.flag_scan import GoogleBooksClient

    payload = {
        "items": [
            {"volumeInfo": {"title": "Dune", "authors": ["Frank Herbert"],
                            "publisher": "Ace", "publishedDate": "1965-08-01"}},
            {"volumeInfo": {"title": "Dune", "authors": ["Frank Herbert"],
                            "publisher": "Penguin", "publishedDate": "2019"}},
        ]
    }
    cands = GoogleBooksClient(_resp(payload)).search("Dune", "Frank Herbert")
    assert len(cands) == 2
    assert cands[0].first_year == 1965
    assert cands[0].publishers == ["Ace"]
    assert cands[1].first_year == 2019

    def fetch_429(url):
        raise RateLimited("HTTP 429")

    with pytest.raises(RateLimited):
        GoogleBooksClient(fetch_429).search("Dune", "Frank Herbert")


def test_default_fetch_raises_rate_limited_on_429(monkeypatch):
    import urllib.error
    from tbi import flag_scan

    def boom(req, timeout=None):
        raise urllib.error.HTTPError(req.full_url, 429, "Too Many", {}, None)

    monkeypatch.setattr(flag_scan.urllib.request, "urlopen", boom)
    with pytest.raises(RateLimited):
        flag_scan._default_fetch("https://openlibrary.org/search.json?title=x")


# ----------------------------------------------------------------------
# Scanner end-to-end on a seeded temp DB
# ----------------------------------------------------------------------


def _seed_db(path: Path) -> None:
    store = Store(path)
    try:
        ch = store.upsert_source("channel", "chan_a", "A")
        p1 = store.upsert_post(ch, 10, "2026-01-01T00:00:00+00:00", "", "https://t.me/chan_a/10")
        store.replace_files_for_post(
            p1,
            [{
                "filename": "Onyx Storm - Rebecca Yarros.epub", "ext": "epub",
                "size_text": None, "size_bytes": 111,
                "title": "Onyx Storm", "author": "Rebecca Yarros",
                "dedupe_key": "onyx storm|rebecca yarros|111",
                "obtain_url": "https://t.me/chan_a/10",
            }],
        )
        p2 = store.upsert_post(ch, 11, "2026-01-02T00:00:00+00:00", "", "https://t.me/chan_a/11")
        store.replace_files_for_post(
            p2,
            [{
                "filename": "Pride and Prejudice - Jane Austen.epub", "ext": "epub",
                "size_text": None, "size_bytes": 222,
                "title": "Pride and Prejudice", "author": "Jane Austen",
                "dedupe_key": "pride and prejudice|jane austen|222",
                "obtain_url": "https://t.me/chan_a/11",
            }],
        )
        p3 = store.upsert_post(ch, 12, "2026-01-03T00:00:00+00:00", "", "https://t.me/chan_a/12")
        store.replace_files_for_post(
            p3,
            [{
                "filename": "Some Old Book.pdf", "ext": "pdf",
                "size_text": None, "size_bytes": 333,
                "title": "Some Old Book", "author": "",
                "dedupe_key": "some old book||333",
                "obtain_url": "https://t.me/chan_a/12",
            }],
        )
        store.commit()
        store.conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        store.commit()
    finally:
        store.close()


def _fake_fetch_factory(calls: list):
    """Open Library answers by title; Google Books 429s (like the
    real no-key behaviour). Records every URL called."""

    def fetch(url):
        calls.append(url)
        if "googleapis" in url:
            raise RateLimited("HTTP 429 from googleapis")
        if "Onyx" in url or "onyx" in url.lower():
            return 200, {
                "docs": [{
                    "title": "Onyx Storm", "author_name": ["Rebecca Yarros"],
                    "first_publish_year": 2025, "publish_year": [2025],
                    "publisher": ["Red Tower Books"],
                }]
            }
        if "Pride" in url:
            return 200, {
                "docs": [{
                    "title": "Pride and Prejudice", "author_name": ["Jane Austen"],
                    "first_publish_year": 1813, "publish_year": [1813],
                    "publisher": ["Penguin"],
                }]
            }
        return 200, {"docs": []}

    return fetch


def test_chunk_run_flags_clear_and_uncertain(tmp_path):
    db = tmp_path / "t.db"
    _seed_db(db)
    calls: list = []
    scanner = Scanner(db, delay=0, fetch=_fake_fetch_factory(calls), current_year=2026)
    summary = scanner.run_chunk(
        0,
        progress_path=tmp_path / "progress.json",
        flag_list_path=tmp_path / "flag-list.jsonl",
        log_dir=tmp_path,
    )
    assert summary.completed is True
    assert (summary.flagged, summary.clear, summary.uncertain) == (1, 1, 1)
    assert summary.google_books_available is False  # probe hit the 429
    assert summary.considered == 3

    lines = (tmp_path / "flag-list.jsonl").read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1
    row = json.loads(lines[0])
    assert row == {
        "handle": "chan_a",
        "post_id": 10,
        "title": "Onyx Storm",
        "author": "Rebecca Yarros",
        "evidence": row["evidence"],
        "source": "open-library",
    }
    assert "2025" in row["evidence"] and "Red Tower Books" in row["evidence"]

    log = json.loads(
        (tmp_path / "flag-scan-log-chunk0000.jsonl").read_text(encoding="utf-8").splitlines()[0]
    )
    assert log["verdict"] == "flag"
    progress = json.loads((tmp_path / "progress.json").read_text(encoding="utf-8"))
    assert progress["chunks_done"][0]["chunk"] == 0
    assert progress["current"] is None


def test_chunk_run_resumes_after_rate_limit(tmp_path):
    db = tmp_path / "t.db"
    _seed_db(db)
    calls: list = []
    state = {"fail_after": 1}  # OL 429s on the 2nd book-check call

    def flaky_fetch(url):
        calls.append(url)
        if "googleapis" in url:
            raise RateLimited("HTTP 429 from googleapis")
        if "search.json" in url:
            state["fail_after"] -= 1
            if state["fail_after"] < 0:
                raise RateLimited("HTTP 429 from openlibrary")
        return _fake_fetch_factory([])(url)

    scanner = Scanner(db, delay=0, fetch=flaky_fetch, current_year=2026)
    summary = scanner.run_chunk(
        0,
        progress_path=tmp_path / "progress.json",
        flag_list_path=tmp_path / "flag-list.jsonl",
        log_dir=tmp_path,
    )
    assert summary.completed is False
    assert "rate-limited" in summary.stopped_reason
    progress = json.loads((tmp_path / "progress.json").read_text(encoding="utf-8"))
    assert len(progress["current"]["outcomes"]) == 1  # only book 1 decided

    # Resume with a healthy fetcher: the decided book is NOT re-queried.
    calls2: list = []
    scanner2 = Scanner(db, delay=0, fetch=_fake_fetch_factory(calls2), current_year=2026)
    summary2 = scanner2.run_chunk(
        0,
        progress_path=tmp_path / "progress.json",
        flag_list_path=tmp_path / "flag-list.jsonl",
        log_dir=tmp_path,
    )
    assert summary2.completed is True
    assert (summary2.flagged, summary2.clear, summary2.uncertain) == (1, 1, 1)
    ol_calls = [u for u in calls2 if "search.json" in u]
    assert len(ol_calls) == 1  # only the undecided book (Pride) was queried
    # No duplicate flag lines from the interrupted + resumed run.
    lines = (tmp_path / "flag-list.jsonl").read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1


def test_verdict_cache_avoids_duplicate_api_calls(tmp_path):
    db = tmp_path / "t.db"
    store = Store(db)
    try:
        ch = store.upsert_source("channel", "chan_a", "A")
        for post_id, size in ((10, 111), (11, 222)):
            p = store.upsert_post(
                ch, post_id, "2026-01-01T00:00:00+00:00", "", "https://t.me/chan_a/%d" % post_id
            )
            store.replace_files_for_post(
                p,
                [{
                    "filename": "Onyx Storm - Rebecca Yarros.epub", "ext": "epub",
                    "size_text": None, "size_bytes": size,
                    "title": "Onyx Storm", "author": "Rebecca Yarros",
                    "dedupe_key": "onyx storm|rebecca yarros|%d" % size,
                    "obtain_url": "https://t.me/chan_a/%d" % post_id,
                }],
            )
        store.commit()
        store.conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        store.commit()
    finally:
        store.close()
    calls: list = []
    scanner = Scanner(db, delay=0, fetch=_fake_fetch_factory(calls), current_year=2026)
    summary = scanner.run_chunk(
        0,
        progress_path=tmp_path / "progress.json",
        flag_list_path=tmp_path / "flag-list.jsonl",
        log_dir=tmp_path,
    )
    assert summary.completed is True
    assert summary.flagged == 2  # both size variants flagged...
    ol_calls = [u for u in calls if "search.json" in u]
    assert len(ol_calls) == 1  # ...but the API was asked once
    lines = (tmp_path / "flag-list.jsonl").read_text(encoding="utf-8").splitlines()
    assert len(lines) == 2  # one line per file occurrence


def test_enumerate_chunk_is_deterministic(tmp_path):
    db = tmp_path / "t.db"
    _seed_db(db)
    assert count_books(db) == 3
    first = [(b.dedupe_key, b.title) for b in enumerate_chunk(db, 0, 10)]
    second = [(b.dedupe_key, b.title) for b in enumerate_chunk(db, 0, 10)]
    assert first == second
    assert [t for _, t in first] == [
        "Onyx Storm",
        "Pride and Prejudice",
        "Some Old Book",
    ]
    assert enumerate_chunk(db, 1, 10) == []  # past the end: empty chunk
