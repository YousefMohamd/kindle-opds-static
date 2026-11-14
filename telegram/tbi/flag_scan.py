"""Automatic commercial (flagged-book) scan for the RliBook catalog.

Flag detection was manual until now (the user flagged "الجلاد تحت جلدي"
by hand after telling us it was flagged). This module automates it:
for each distinct book in the local index it asks the public book
indexes whether the book is a recent commercial release, and records
the verdict. Flagged books are written to ``flag-list.jsonl`` — the
parent applies them to KV as ``flag:<handle>:<post_id>``. This module
never writes flags itself (no Cloudflare token here) and never touches
D1 or the bot source.

Sources (both free, no key):
  * Open Library search API — the working source. Good coverage of
    classics; weak coverage of recent commercial books (e.g.
    "الجلاد تحت جلدي" returns 0 results).
  * Google Books API — tried first at run start with ONE probe call.
    No-key requests from this environment are REJECTED (verified
    2026-11-14 by the bot, and again by this scan's probe: HTTP 429,
    "Quota exceeded", quota_limit_value "0"). On a 429 the source is
    disabled for the rest of the run and the scan continues with
    Open Library only. A GOOGLE_BOOKS_API_KEY is NOT used here —
    there is no secret handling in this module; if a key exists one
    day, pass it with --google-books-key is NOT supported on purpose:
    keys never go on a command line. (See docs/flag-scan.md.)

The rule mirrors the bot's submission check
(``rlibook_bot/bookcheck.py`` and ``src/bookcheck.ts`` in the worker):
a book is a recent commercial release when its first publication year
is within RECENT_YEARS (2) of the current year and it is not public
domain (published before PUBLIC_DOMAIN_YEAR, 1929). The scan is
CONSERVATIVE on top of that: it flags only when the evidence is
clear — a title+author match AND a publisher AND a usable year.
When in doubt it does NOT flag (a false flag blocks a legal book
from being read/downloaded on the site; a missed flag just waits
for manual review).

Verdicts:
  * "flag"      — clear recent-commercial evidence (see decide()).
  * "clear"     — checked, and the evidence says it is NOT a recent
                  commercial release (public domain, or an older
                  edition with a publisher).
  * "uncertain" — could not determine: no author/title in the index,
                  no match in any available API, a match with no
                  publisher/year, or an API error. Never flagged.

A leading track number in the parsed title ("01. ONYX STORM",
"001 - ...") is stripped for the API query only (query_title) —
Open Library returns nothing for the numbered form; the stored
title and the flag list keep the original text.

Batching / resume: the catalog is scanned in chunks of CHUNK_SIZE
(1,000) distinct books, in deterministic ``dedupe_key`` order.
Progress lives in a JSON file (default ``flag-scan-progress.json``):
completed chunks are summarized, the in-progress chunk keeps one
outcome per book, so a stopped run resumes without re-calling the
APIs for books already decided. A chunk that finishes appends its
flagged books to ``flag-list.jsonl`` and its full audit trail to
``flag-scan-log-chunkNNNN.jsonl``.

Rate limits: one request per second per API at most, a polite
User-Agent, 15 s timeouts. A 429 from Open Library stops the chunk
immediately (progress saved, exit code 2) — never retry blindly.
Five consecutive non-429 API errors also stop the chunk.

Only the standard library is used (urllib) — the telegram package
has no ``requests``/``httpx`` dependency and this module adds none.
The local index DB is opened READ-ONLY; D1 is never touched.

Run from the telegram/ directory, e.g.:
  python -m tbi.flag_scan --db /path/to/index.db --chunk 0
  python -m tbi.flag_scan --db /path/to/index.db --self-test
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

from tbi.books import normalize_arabic

GOOGLE_BOOKS_URL = "https://www.googleapis.com/books/v1/volumes"
OPEN_LIBRARY_URL = "https://openlibrary.org/search.json"

# Mirrors rlibook_bot/bookcheck.py (and src/bookcheck.ts in the worker):
# "recent" = published within the last 2 years; works published before
# 1929 are public domain (US). The scan reuses exactly these constants
# so the automatic flag agrees with the bot's submission check.
RECENT_YEARS = 2
PUBLIC_DOMAIN_YEAR = 1929

CHUNK_SIZE = 1000
REQUEST_DELAY_SECONDS = 1.0
REQUEST_TIMEOUT_SECONDS = 15
MAX_CONSECUTIVE_ERRORS = 5
USER_AGENT = "RliBook-flag-scan/1.0 (https://rlibook.tech)"

# Fields requested from Open Library search: the defaults omit
# publisher/publish_year, which the verdict needs.
OL_FIELDS = (
    "key,title,author_name,first_publish_year,publish_year,"
    "publisher,edition_count"
)

_YEAR_RE = re.compile(r"(\d{4})")
_NON_ALNUM = re.compile(r"[^a-z0-9\u0600-\u06FF]+")


class RateLimited(Exception):
    """An API answered 429: stop the chunk, do not retry blindly."""


class ApiError(Exception):
    """A non-429 API failure (network, timeout, bad response)."""


# ----------------------------------------------------------------------
# Matching
# ----------------------------------------------------------------------


# Leading track/file numbers some shares carry ("01. ONYX STORM",
# "001 - أخلاق حملة القرآن", "007 - جزء ..."): the parsed title keeps
# them, but Open Library finds nothing for "01. ONYX STORM" while
# "ONYX STORM" matches. Stripped for the API query ONLY — the stored
# title, the match check and the flag list keep the original text.
_LEADING_NUMBER_RE = re.compile(r"^\s*\d{1,3}\s*[.\-)–—]\s*")


def query_title(title: str) -> str:
    """Title as sent to the book indexes: a leading track number
    ("01. ", "001 - ") removed when something remains after it.
    A bare leading year or number is never stripped ("1984" has no
    separator, so it is untouched)."""
    stripped = _LEADING_NUMBER_RE.sub("", title or "")
    return stripped.strip() if stripped.strip() else (title or "").strip()


def _norm_tokens(text: str) -> list[str]:
    """Arabic-normalized (tashkeel stripped, alef forms unified),
    lowercased, punctuation-free word list. Display text is never
    changed — this is only for matching."""
    text = normalize_arabic(text or "").lower()
    text = _NON_ALNUM.sub(" ", text)
    return [w for w in text.split() if w]


def _norm_joined(text: str) -> str:
    return " ".join(_norm_tokens(text))


def _jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def titles_match(query: str, candidate: str) -> bool:
    """True when the candidate title is the queried title (allowing
    subtitles and extra words: either normalized title contains the
    other), or the word sets mostly overlap. Very short titles (< 3
    chars) must match exactly — "It" must not match everything."""
    q = _norm_joined(query)
    c = _norm_joined(candidate)
    if not q or not c:
        return False
    if q == c:
        return True
    if len(q) < 3 or len(c) < 3:
        return False
    if q in c or c in q:
        return True
    return _jaccard(set(q.split()), set(c.split())) >= 0.6


def authors_match(query: str, candidate: str) -> bool:
    """True when the candidate author name is the queried author
    (allowing extra name parts: "عماد راشد" matches
    "عماد راشد عثمان"). A single-word name must appear verbatim in
    the other name; multi-word names need containment or >= 0.5
    token overlap."""
    q = _norm_joined(query)
    c = _norm_joined(candidate)
    if not q or not c:
        return False
    if q == c or q in c or c in q:
        return True
    qt, ct = set(q.split()), set(c.split())
    if len(qt) == 1 or len(ct) == 1:
        return bool(qt & ct)
    return _jaccard(qt, ct) >= 0.5


# ----------------------------------------------------------------------
# API clients (fetcher-injectable so tests run offline)
# ----------------------------------------------------------------------


def _default_fetch(url: str) -> tuple[int, dict]:
    """One GET with the scan's User-Agent. Returns (status, parsed
    JSON). Raises RateLimited on 429, ApiError otherwise."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_SECONDS) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code == 429:
            raise RateLimited(
                "HTTP 429 from %s (quota/rate limit)" % url.split("?")[0]
            ) from exc
        raise ApiError("HTTP %s from %s" % (exc.code, url.split("?")[0])) from exc
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        raise ApiError("%s: %s" % (url.split("?")[0], exc)) from exc


@dataclass
class Candidate:
    """One API result that matched title+author (or not — the caller
    filters with titles_match/authors_match)."""

    title: str
    authors: list[str]
    publishers: list[str]
    first_year: int | None  # first publication year (OL) or earliest
    # edition year among the matched items (GB, a proxy — Google
    # Books has no first-publication field).
    source: str  # "open-library" | "google-books"


def _year_from_text(text) -> int | None:
    if not text:
        return None
    m = _YEAR_RE.search(str(text))
    return int(m.group(1)) if m else None


class OpenLibraryClient:
    def __init__(self, fetch=None):
        self._fetch = fetch or _default_fetch

    def search(self, title: str, author: str) -> list[Candidate]:
        params = {
            "title": query_title(title),
            "limit": "5",
            "fields": OL_FIELDS,
        }
        if author:
            params["author"] = author
        url = OPEN_LIBRARY_URL + "?" + urllib.parse.urlencode(params)
        _, data = self._fetch(url)
        out = []
        for doc in data.get("docs") or []:
            years = [y for y in (doc.get("publish_year") or []) if y]
            first = doc.get("first_publish_year") or (min(years) if years else None)
            out.append(
                Candidate(
                    title=str(doc.get("title") or ""),
                    authors=[str(a) for a in (doc.get("author_name") or [])],
                    publishers=[str(p) for p in (doc.get("publisher") or [])],
                    first_year=int(first) if first else None,
                    source="open-library",
                )
            )
        return out


class GoogleBooksClient:
    def __init__(self, fetch=None):
        self._fetch = fetch or _default_fetch

    def search(self, title: str, author: str) -> list[Candidate]:
        q = "intitle:" + query_title(title)
        if author:
            q += "+inauthor:" + author
        params = {"q": q, "maxResults": "5"}
        url = GOOGLE_BOOKS_URL + "?" + urllib.parse.urlencode(params)
        _, data = self._fetch(url)
        out = []
        for item in data.get("items") or []:
            info = item.get("volumeInfo") or {}
            out.append(
                Candidate(
                    title=str(info.get("title") or ""),
                    authors=[str(a) for a in (info.get("authors") or [])],
                    publishers=[str(info.get("publisher"))] if info.get("publisher") else [],
                    first_year=_year_from_text(info.get("publishedDate")),
                    source="google-books",
                )
            )
        return out


# ----------------------------------------------------------------------
# Verdict
# ----------------------------------------------------------------------


@dataclass
class Verdict:
    verdict: str  # "flag" | "clear" | "uncertain"
    reason: str
    evidence: str = ""
    source: str = ""  # "open-library" | "google-books" | ""


def decide(
    title: str,
    author: str,
    ol_candidates: list[Candidate],
    gb_candidates: list[Candidate],
    *,
    current_year: int | None = None,
    recent_years: int = RECENT_YEARS,
    pd_year: int = PUBLIC_DOMAIN_YEAR,
) -> Verdict:
    """Decide one book from the candidates the clients returned.

    Conservative by design: flag only on a title+author match AND a
    publisher AND a usable year showing a recent commercial edition.
    ``current_year`` defaults to this year; ``recent_years`` is the
    bookcheck window (2) — pass None to flag any in-copyright
    commercial edition instead (see docs/flag-scan.md).
    """
    title = (title or "").strip()
    author = (author or "").strip()
    if not title:
        return Verdict("uncertain", "no-title: the index has no title")
    if not author:
        return Verdict("uncertain", "no-author: the index has no author")
    year_now = current_year or date.today().year

    ol_match = next(
        (
            c
            for c in ol_candidates
            if titles_match(title, c.title)
            and any(authors_match(author, a) for a in c.authors)
        ),
        None,
    )
    gb_matches = [
        c
        for c in gb_candidates
        if titles_match(title, c.title)
        and any(authors_match(author, a) for a in c.authors)
    ]

    # The year is authoritative from Open Library first (its
    # first_publish_year is a real first-publication year); Google
    # Books only has per-edition dates, so its earliest matching
    # edition year is a weaker proxy and only fills in when Open
    # Library has no usable year.
    year = ol_match.first_year if ol_match else None
    year_source = "open-library" if year is not None else ""
    if year is None and gb_matches:
        gb_years = [c.first_year for c in gb_matches if c.first_year]
        if gb_years:
            year = min(gb_years)
            year_source = "google-books"
    publishers: list[str] = []
    if ol_match:
        publishers += ol_match.publishers
    for c in gb_matches:
        publishers += c.publishers
    publishers = list(dict.fromkeys(p for p in publishers if p.strip()))

    def _pubs(pubs: list[str]) -> str:
        shown = [p for p in pubs if p.strip()][:5]
        text = ", ".join(shown) or "none listed"
        if len(pubs) > 5:
            text += " (+%d more)" % (len(pubs) - 5)
        return text

    def _evidence() -> str:
        bits = []
        if ol_match:
            bits.append(
                "Open Library: %r by %s, first published %s, publishers: %s"
                % (
                    ol_match.title,
                    ", ".join(ol_match.authors) or "?",
                    ol_match.first_year if ol_match.first_year else "?",
                    _pubs(ol_match.publishers),
                )
            )
        for c in gb_matches:
            bits.append(
                "Google Books: %r by %s, published %s, publisher: %s"
                % (
                    c.title,
                    ", ".join(c.authors) or "?",
                    c.first_year if c.first_year else "?",
                    ", ".join(c.publishers) or "none listed",
                )
            )
        return "; ".join(bits)

    if ol_match is None and not gb_matches:
        return Verdict(
            "uncertain",
            "no-match: no title+author match in any available API",
        )
    if year is None:
        return Verdict(
            "uncertain",
            "matched but no usable publication year",
            _evidence(),
            year_source,
        )
    if not publishers:
        return Verdict(
            "uncertain",
            "matched (%d) but no publisher recorded" % year,
            _evidence(),
            year_source,
        )
    if year < pd_year:
        return Verdict(
            "clear",
            "public domain: first published %d" % year,
            _evidence(),
            year_source,
        )
    if recent_years is None:
        return Verdict(
            "flag",
            "commercial edition: first published %d, publisher %s"
            % (year, publishers[0]),
            _evidence(),
            year_source,
        )
    if year >= year_now - recent_years:
        return Verdict(
            "flag",
            "recent commercial edition: first published %d, publisher %s"
            % (year, publishers[0]),
            _evidence(),
            year_source,
        )
    return Verdict(
        "clear",
        "not recent: first published %d (older than %d years)"
        % (year, recent_years),
        _evidence(),
        year_source,
    )


# ----------------------------------------------------------------------
# Catalog enumeration (read-only)
# ----------------------------------------------------------------------


@dataclass
class Book:
    dedupe_key: str
    title: str
    author: str
    occurrences: list[tuple[str, int]] = field(default_factory=list)
    # (handle, post_id) per file row sharing this dedupe key.


def _connect_ro(db_path: str | Path) -> sqlite3.Connection:
    return sqlite3.connect("file:%s?mode=ro" % Path(db_path), uri=True)


def count_books(db_path: str | Path) -> int:
    """Distinct books, same rule as Store.list_books/counts: an empty
    dedupe key is one book per file, never collapsed together."""
    conn = _connect_ro(db_path)
    try:
        row = conn.execute(
            "SELECT COUNT(DISTINCT CASE WHEN dedupe_key IN ('', '|') "
            "THEN 'file:' || id ELSE dedupe_key END) FROM files"
        ).fetchone()
        return int(row[0])
    finally:
        conn.close()


def _chunk_keys(conn: sqlite3.Connection, chunk: int, chunk_size: int) -> list[str]:
    rows = conn.execute(
        "SELECT bkey FROM (SELECT DISTINCT CASE WHEN dedupe_key IN ('', '|') "
        "THEN 'file:' || id ELSE dedupe_key END AS bkey FROM files) "
        "ORDER BY bkey LIMIT ? OFFSET ?",
        (chunk_size, chunk * chunk_size),
    ).fetchall()
    return [r[0] for r in rows]


def enumerate_chunk(db_path: str | Path, chunk: int, chunk_size: int) -> list[Book]:
    """The distinct books of one chunk, in deterministic dedupe_key
    order, each with every (handle, post_id) occurrence. The
    representative title/author is the first occurrence's (alphabetical
    by handle, then post id)."""
    conn = _connect_ro(db_path)
    try:
        keys = _chunk_keys(conn, chunk, chunk_size)
        if not keys:
            return []
        placeholders = ",".join("?" for _ in keys)
        rows = conn.execute(
            "SELECT CASE WHEN f.dedupe_key IN ('', '|') "
            "THEN 'file:' || f.id ELSE f.dedupe_key END AS bkey, "
            "f.title, f.author, s.name, p.post_id "
            "FROM files f JOIN posts p ON p.id = f.post_id "
            "JOIN sources s ON s.id = p.source_id "
            "WHERE bkey IN (%s) ORDER BY bkey, s.name, p.post_id"
            % placeholders,
            keys,
        ).fetchall()
        books: list[Book] = []
        current: Book | None = None
        for bkey, title, author, handle, post_id in rows:
            if current is None or current.dedupe_key != bkey:
                current = Book(bkey, title or "", author or "")
                books.append(current)
            current.occurrences.append((handle, int(post_id)))
        return books
    finally:
        conn.close()


# ----------------------------------------------------------------------
# Progress file (resume state — local only, never committed)
# ----------------------------------------------------------------------


def load_progress(path: str | Path) -> dict:
    p = Path(path)
    if not p.exists():
        return {"version": 1, "chunks_done": [], "current": None}
    return json.loads(p.read_text(encoding="utf-8"))


def save_progress(path: str | Path, progress: dict) -> None:
    p = Path(path)
    progress["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(progress, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(p)


# ----------------------------------------------------------------------
# Scanner
# ----------------------------------------------------------------------


@dataclass
class ScanSummary:
    chunk: int
    total_books: int
    considered: int
    flagged: int
    clear: int
    uncertain: int
    api_calls: int
    google_books_available: bool | None
    completed: bool
    stopped_reason: str = ""


class Scanner:
    def __init__(
        self,
        db_path: str | Path,
        *,
        chunk_size: int = CHUNK_SIZE,
        delay: float = REQUEST_DELAY_SECONDS,
        recent_years: int | None = RECENT_YEARS,
        pd_year: int = PUBLIC_DOMAIN_YEAR,
        fetch=None,
        current_year: int | None = None,
    ):
        self.db_path = Path(db_path)
        self.chunk_size = chunk_size
        self.delay = delay
        self.recent_years = recent_years
        self.pd_year = pd_year
        self.current_year = current_year or date.today().year
        self.ol = OpenLibraryClient(fetch)
        self.gb = GoogleBooksClient(fetch)
        self._fetch = fetch
        self._last_request_at = 0.0
        self._consecutive_errors = 0
        self._verdict_cache: dict[tuple[str, str], Verdict] = {}
        self.api_calls = 0
        self.google_books_available: bool | None = None  # None = unprobed

    # -- politeness ------------------------------------------------------
    def _wait(self) -> None:
        if self.delay <= 0:
            return
        wait = self.delay - (time.monotonic() - self._last_request_at)
        if wait > 0:
            time.sleep(wait)
        self._last_request_at = time.monotonic()

    # -- Google Books probe ----------------------------------------------
    def probe_google_books(self) -> bool:
        """ONE call to check whether no-key Google Books works at all.
        A 429 disables it for the run (verified 2026-11-14: no-key
        requests are rejected with quota 0 — do not waste calls)."""
        self._wait()
        try:
            self.gb.search("Dune", "Frank Herbert")
            self.google_books_available = True
            return True
        except RateLimited:
            self.google_books_available = False
            return False
        except ApiError:
            # Any other failure: treat as unavailable for this run,
            # Open Library carries the scan.
            self.google_books_available = False
            return False

    # -- one book ----------------------------------------------------------
    def check_book(self, book: Book) -> Verdict:
        title, author = book.title, book.author
        if not title.strip():
            return Verdict("uncertain", "no-title: the index has no title")
        if not author.strip():
            return Verdict("uncertain", "no-author: the index has no author")
        cache_key = (_norm_joined(title), _norm_joined(author))
        cached = self._verdict_cache.get(cache_key)
        if cached is not None:
            return cached
        ol_candidates: list[Candidate] = []
        gb_candidates: list[Candidate] = []
        self._wait()
        try:
            ol_candidates = self.ol.search(title, author)
            self.api_calls += 1
            self._consecutive_errors = 0
        except RateLimited:
            raise
        except ApiError as exc:
            self._consecutive_errors += 1
            return Verdict("uncertain", "api-error (open-library): %s" % exc)
        verdict = decide(
            title,
            author,
            ol_candidates,
            gb_candidates,
            current_year=self.current_year,
            recent_years=self.recent_years,
            pd_year=self.pd_year,
        )
        # Google Books is consulted ONLY when Open Library did not
        # decide the book (no match, or a match without a usable
        # year/publisher) — and only when the probe said it works.
        if verdict.verdict == "uncertain" and self.google_books_available:
            self._wait()
            try:
                gb_candidates = self.gb.search(title, author)
                self.api_calls += 1
                self._consecutive_errors = 0
            except RateLimited:
                # Google Books died mid-run: disable it, keep the
                # Open Library verdict (uncertain) for this book.
                self.google_books_available = False
                return verdict
            except ApiError as exc:
                self._consecutive_errors += 1
                return Verdict(
                    "uncertain", "api-error (google-books): %s" % exc
                )
            verdict = decide(
                title,
                author,
                ol_candidates,
                gb_candidates,
                current_year=self.current_year,
                recent_years=self.recent_years,
                pd_year=self.pd_year,
            )
        self._verdict_cache[cache_key] = verdict
        return verdict

    # -- chunk -------------------------------------------------------------
    def run_chunk(
        self,
        chunk: int,
        *,
        progress_path: str | Path,
        flag_list_path: str | Path,
        log_dir: str | Path,
        max_books: int | None = None,
    ) -> ScanSummary:
        total = count_books(self.db_path)
        progress = load_progress(progress_path)
        progress.setdefault("chunk_size", self.chunk_size)
        progress.setdefault("total_books", total)
        progress.setdefault("chunks_done", [])
        progress.setdefault("recent_years", self.recent_years)
        progress.setdefault("pd_year", self.pd_year)
        if self.google_books_available is None:
            self.probe_google_books()
        progress["google_books_available"] = self.google_books_available

        current = progress.get("current") or {}
        if current.get("chunk") != chunk:
            current = {"chunk": chunk, "next_index": 0, "outcomes": {}}
            progress["current"] = current
        outcomes: dict = current.setdefault("outcomes", {})
        next_index = int(current.get("next_index", 0))

        books = enumerate_chunk(self.db_path, chunk, self.chunk_size)
        if max_books is not None:
            books = books[:max_books]
        counts = {"flag": 0, "clear": 0, "uncertain": 0}
        for outcome in outcomes.values():
            counts[outcome["verdict"]] += 1

        stopped_reason = ""
        completed = False
        try:
            for idx in range(next_index, len(books)):
                book = books[idx]
                try:
                    verdict = self.check_book(book)
                except RateLimited:
                    stopped_reason = (
                        "rate-limited by Open Library (429): chunk stopped, "
                        "progress saved, resume with the same --chunk"
                    )
                    break
                if self._consecutive_errors >= MAX_CONSECUTIVE_ERRORS:
                    stopped_reason = (
                        "%d consecutive API errors: chunk stopped, progress saved"
                        % MAX_CONSECUTIVE_ERRORS
                    )
                    break
                outcomes[book.dedupe_key] = {
                    "verdict": verdict.verdict,
                    "reason": verdict.reason,
                    "evidence": verdict.evidence,
                    "source": verdict.source,
                    "title": book.title,
                    "author": book.author,
                    "occurrences": len(book.occurrences),
                }
                counts[verdict.verdict] += 1
                current["next_index"] = idx + 1
                save_progress(progress_path, progress)
            else:
                completed = True
        finally:
            if completed:
                self._finish_chunk(
                    progress, chunk, books, outcomes, flag_list_path, log_dir
                )
                save_progress(progress_path, progress)
            else:
                save_progress(progress_path, progress)

        return ScanSummary(
            chunk=chunk,
            total_books=total,
            considered=len(books),
            flagged=counts["flag"],
            clear=counts["clear"],
            uncertain=counts["uncertain"],
            api_calls=self.api_calls,
            google_books_available=self.google_books_available,
            completed=completed,
            stopped_reason=stopped_reason,
        )

    def _finish_chunk(
        self, progress: dict, chunk: int, books: list[Book], outcomes: dict,
        flag_list_path: str | Path, log_dir: str | Path,
    ) -> None:
        """Append this chunk's flagged books to flag-list.jsonl (one
        line per file occurrence, deduped against lines already in
        the file) and write the chunk's audit log, then record the
        chunk as done and clear the in-progress state."""
        flag_path = Path(flag_list_path)
        seen: set[tuple[str, int]] = set()
        if flag_path.exists():
            for line in flag_path.read_text(encoding="utf-8").splitlines():
                try:
                    row = json.loads(line)
                    seen.add((row["handle"], int(row["post_id"])))
                except (ValueError, KeyError):
                    continue
        by_key = {b.dedupe_key: b for b in books}
        new_lines = []
        for key, outcome in outcomes.items():
            if outcome["verdict"] != "flag":
                continue
            book = by_key.get(key)
            if book is None:
                continue
            for handle, post_id in book.occurrences:
                if (handle, post_id) in seen:
                    continue
                seen.add((handle, post_id))
                new_lines.append(
                    json.dumps(
                        {
                            "handle": handle,
                            "post_id": post_id,
                            "title": book.title,
                            "author": book.author,
                            "evidence": outcome["evidence"],
                            "source": outcome["source"] or "open-library",
                        },
                        ensure_ascii=False,
                    )
                )
        if new_lines:
            with flag_path.open("a", encoding="utf-8") as fh:
                fh.write("\n".join(new_lines) + "\n")

        log_path = Path(log_dir) / ("flag-scan-log-chunk%04d.jsonl" % chunk)
        with log_path.open("w", encoding="utf-8") as fh:
            for key, outcome in outcomes.items():
                fh.write(
                    json.dumps(
                        {"chunk": chunk, "dedupe_key": key, **outcome},
                        ensure_ascii=False,
                    )
                    + "\n"
                )

        progress["chunks_done"] = [
            c for c in progress["chunks_done"] if c["chunk"] != chunk
        ]
        progress["chunks_done"].append(
            {
                "chunk": chunk,
                "flagged": sum(1 for o in outcomes.values() if o["verdict"] == "flag"),
                "clear": sum(1 for o in outcomes.values() if o["verdict"] == "clear"),
                "uncertain": sum(
                    1 for o in outcomes.values() if o["verdict"] == "uncertain"
                ),
                "flag_list_lines_added": len(new_lines),
                "log": str(log_path),
            }
        )
        progress["current"] = None


# ----------------------------------------------------------------------
# Self-test: known books against the LIVE APIs (no writes)
# ----------------------------------------------------------------------

SELF_TEST_BOOKS = [
    # (title, author, expected verdict) — ground truth verified
    # 2026-11-14 against live Open Library (+ web sources for الجلاد).
    ("Onyx Storm", "Rebecca Yarros", "flag"),  # 2025, Red Tower Books
    ("Sunrise on the Reaping", "Suzanne Collins", "flag"),  # 2025, Scholastic
    ("The Women", "Kristin Hannah", "flag"),  # 2024, St. Martin's Press
    ("The Alchemist", "Paulo Coelho", "clear"),  # 1988, not recent
    ("Pride and Prejudice", "Jane Austen", "clear"),  # 1813, public domain
    ("الجلاد تحت جلدي", "عماد راشد", "uncertain"),  # 0 OL results; GB 429
]


def self_test(scanner: Scanner) -> list[dict]:
    """Check the known books against the live APIs. Returns one row
    per book with the verdict and whether it matched expectation.
    Writes nothing."""
    rows = []
    scanner.probe_google_books()
    for title, author, expected in SELF_TEST_BOOKS:
        try:
            verdict = scanner.check_book(Book("", title, author))
        except RateLimited:
            verdict = Verdict("uncertain", "rate-limited during self-test")
        rows.append(
            {
                "title": title,
                "author": author,
                "expected": expected,
                "verdict": verdict.verdict,
                "match": verdict.verdict == expected,
                "reason": verdict.reason,
                "evidence": verdict.evidence,
            }
        )
    return rows


# ----------------------------------------------------------------------
# CLI
# ----------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Flag-scan: find recent commercial books in the "
        "Telegram catalog (batched, resumable, conservative)."
    )
    p.add_argument("--db", help="path to the local index.db (read-only)")
    p.add_argument(
        "--chunk",
        type=int,
        default=None,
        help="chunk number to run (default: next unfinished chunk)",
    )
    p.add_argument(
        "--chunk-size", type=int, default=CHUNK_SIZE,
        help="distinct books per chunk (default %(default)s)",
    )
    p.add_argument(
        "--progress", default="flag-scan-progress.json",
        help="progress/resume file (default %(default)s)",
    )
    p.add_argument(
        "--flag-list", default="flag-list.jsonl",
        help="flag output file (default %(default)s)",
    )
    p.add_argument(
        "--log-dir", default=".",
        help="directory for per-chunk audit logs (default: current dir)",
    )
    p.add_argument(
        "--delay", type=float, default=REQUEST_DELAY_SECONDS,
        help="seconds between API requests (default %(default)s)",
    )
    p.add_argument(
        "--recent-years", type=int, default=RECENT_YEARS,
        help="flag window in years (default %(default)s, mirroring the "
        "bot's bookcheck); 0 flags any in-copyright commercial edition",
    )
    p.add_argument(
        "--pd-year", type=int, default=PUBLIC_DOMAIN_YEAR,
        help="public-domain cutoff year (default %(default)s)",
    )
    p.add_argument(
        "--max-books", type=int, default=None,
        help="only consider this many books of the chunk (testing)",
    )
    p.add_argument(
        "--self-test", action="store_true",
        help="check the known books against the live APIs and exit "
        "(no writes, no chunk run)",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    recent = None if args.recent_years == 0 else args.recent_years
    scanner = Scanner(
        args.db or "",
        chunk_size=args.chunk_size,
        delay=args.delay,
        recent_years=recent,
        pd_year=args.pd_year,
    )
    if args.self_test:
        rows = self_test(scanner)
        print("Google Books available (no key): %s" % scanner.google_books_available)
        bad = 0
        for r in rows:
            mark = "OK  " if r["match"] else "MISMATCH"
            if not r["match"]:
                bad += 1
            print(
                "[%s] %-32s %-20s expected=%-9s got=%-9s %s"
                % (mark, r["title"][:32], r["author"][:20], r["expected"],
                   r["verdict"], r["reason"])
            )
            if r["evidence"]:
                print("        evidence: %s" % r["evidence"])
        return 1 if bad else 0

    if not args.db:
        print("error: --db is required (path to the local index.db)", file=sys.stderr)
        return 1
    if args.chunk is None:
        progress = load_progress(args.progress)
        done = {c["chunk"] for c in progress.get("chunks_done", [])}
        chunk = 0
        while chunk in done:
            chunk += 1
        if progress.get("current"):
            chunk = progress["current"]["chunk"]
    else:
        chunk = args.chunk

    summary = scanner.run_chunk(
        chunk,
        progress_path=args.progress,
        flag_list_path=args.flag_list,
        log_dir=args.log_dir,
        max_books=args.max_books,
    )
    print(
        "chunk %d: considered=%d flagged=%d clear=%d uncertain=%d "
        "api_calls=%d google_books=%s completed=%s"
        % (
            summary.chunk, summary.considered, summary.flagged,
            summary.clear, summary.uncertain, summary.api_calls,
            summary.google_books_available, summary.completed,
        )
    )
    if summary.stopped_reason:
        print("STOPPED: %s" % summary.stopped_reason)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
