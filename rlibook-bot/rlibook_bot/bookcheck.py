"""Check a submitted book against public indexes of newly released books.

Uses the Google Books API and Open Library (both free, no key needed for
these read endpoints). If a book is a recent commercial release (published
within the last 2 years and not public-domain), the bot refuses it.
If the book is not found, or the check cannot be completed, the verdict is
"unknown" — never refuse on uncertainty; those go to manual review.
"""

from __future__ import annotations

import re
from datetime import date

GOOGLE_BOOKS_URL = "https://www.googleapis.com/books/v1/volumes"
OPEN_LIBRARY_URL = "https://openlibrary.org/search.json"

# A book published within the last N years is treated as a "new commercial
# release" candidate. Public-domain books are exempt regardless of age.
RECENT_YEARS = 2
# Public-domain cutoff (US): works published before 1929 are public domain.
PUBLIC_DOMAIN_YEAR = 1929

_YEAR_RE = re.compile(r"(\d{4})")


def _year_from_text(text):
    if not text:
        return None
    m = _YEAR_RE.search(str(text))
    return int(m.group(1)) if m else None


def _google_books_year(title, author, http_get):
    try:
        q = "intitle:" + title
        if author:
            q += "+inauthor:" + author
        resp = http_get(GOOGLE_BOOKS_URL, params={"q": q, "maxResults": 1}, timeout=10)
        data = resp.json()
        items = data.get("items") or []
        if not items:
            return None
        info = items[0].get("volumeInfo", {})
        return _year_from_text(info.get("publishedDate"))
    except Exception:
        return None


def _open_library_year(title, author, http_get):
    try:
        params = {"title": title, "limit": 1}
        if author:
            params["author"] = author
        resp = http_get(OPEN_LIBRARY_URL, params=params, timeout=10)
        data = resp.json()
        docs = data.get("docs") or []
        if not docs:
            return None
        doc = docs[0]
        year = doc.get("first_publish_year")
        if year:
            return int(year)
        return _year_from_text(doc.get("publish_date"))
    except Exception:
        return None


def check_book(title, author=None, http_get=None):
    """Check whether a book is a recent commercial release.

    Returns a dict: {"verdict": "ok"|"refuse"|"unknown", "reason": str,
    "year": int|None, "source": str|None}.
    """
    if http_get is None:
        import httpx

        http_get = httpx.get
    title = (title or "").strip()
    if not title:
        return {"verdict": "unknown", "reason": "No title given.", "year": None, "source": None}
    year = _google_books_year(title, author, http_get)
    source = "Google Books" if year else None
    if year is None:
        year = _open_library_year(title, author, http_get)
        source = "Open Library" if year else None
    if year is None:
        return {
            "verdict": "unknown",
            "reason": "Could not find this book in Google Books or Open Library, so it cannot be checked automatically. It will be reviewed manually.",
            "year": None,
            "source": None,
        }
    if year < PUBLIC_DOMAIN_YEAR:
        return {
            "verdict": "ok",
            "reason": "Published in %d (public domain)." % year,
            "year": year,
            "source": source,
        }
    current_year = date.today().year
    if year >= current_year - RECENT_YEARS:
        return {
            "verdict": "refuse",
            "reason": (
                "This book was published in %d (a recent commercial release, found via %s). "
                "RliBook only indexes public-domain, Creative Commons, and older "
                "non-commercial books, so this upload is refused." % (year, source)
            ),
            "year": year,
            "source": source,
        }
    return {
        "verdict": "ok",
        "reason": "Published in %d (not a recent release)." % year,
        "year": year,
        "source": source,
    }
