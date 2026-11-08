"""Fetch the live RliBook catalog stats from the published index report."""

from __future__ import annotations

import re

INDEX_REPORT_URL = (
    "https://raw.githubusercontent.com/YousefMohamd/kindle-opds-static/main/telegram/index-report.md"
)

_POSTS_RE = re.compile(r"(\d[\d,]*) posts, (\d[\d,]*) book files")
_BOOKS_RE = re.compile(r"\((\d[\d,]*) distinct books\)")
_GROUPS_RE = re.compile(r"Groups indexed from exports: (\d+)")


def _num(text):
    return int(text.replace(",", ""))


def fetch_stats(http_get=None):
    """Return {'posts': int, 'files': int, 'books': int, 'groups': int} or None."""
    if http_get is None:
        import httpx

        http_get = httpx.get
    try:
        resp = http_get(INDEX_REPORT_URL, timeout=10)
        text = resp.text
    except Exception:
        return None
    m = _POSTS_RE.search(text)
    b = _BOOKS_RE.search(text)
    g = _GROUPS_RE.search(text)
    if not m or not b:
        return None
    return {
        "posts": _num(m.group(1)),
        "files": _num(m.group(2)),
        "books": _num(b.group(1)),
        "groups": _num(g.group(1)) if g else 0,
    }


def format_stats(stats):
    if not stats:
        return "Catalog stats are unavailable right now. Please try again later."
    return (
        "📚 RliBook catalog\n"
        "• Posts indexed: %s\n" % format(stats["posts"], ",")
        + "• Book files: %s\n" % format(stats["files"], ",")
        + "• Distinct books: %s\n" % format(stats["books"], ",")
        + "• Groups indexed: %d\n" % stats["groups"]
        + "Search and download: https://kindle-opds-static.pages.dev"
    )
