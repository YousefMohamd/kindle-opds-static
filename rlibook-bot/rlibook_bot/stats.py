"""Fetch the live RliBook catalog resources from the published index report.

/resources shows only two numbers: the channel count and the distinct-book
count, both from the "Channels with data" line of the live index report.
Posts, files and groups are deliberately not returned.

Note on the book number: that report line carries the catalog-wide
distinct-book total (channels + groups) — the report does not publish a
per-kind distinct-book count. The label in the bot output is "Books",
matching what the report line reports.
"""

from __future__ import annotations

import re

INDEX_REPORT_URL = (
    "https://raw.githubusercontent.com/YousefMohamd/kindle-opds-static/main/telegram/index-report.md"
)

_CHANNELS_RE = re.compile(r"Channels with data: (\d+) of (\d+) walkable")
_BOOKS_RE = re.compile(r"\((\d[\d,]*) distinct books\)")


def _num(text):
    return int(text.replace(",", ""))


def fetch_stats(http_get=None):
    """Return {'channels': int, 'books': int} or None."""
    if http_get is None:
        import httpx

        http_get = httpx.get
    try:
        resp = http_get(INDEX_REPORT_URL, timeout=10)
        text = resp.text
    except Exception:
        return None
    c = _CHANNELS_RE.search(text)
    b = _BOOKS_RE.search(text)
    if not c or not b:
        return None
    return {
        "channels": _num(c.group(1)),
        "books": _num(b.group(1)),
    }


def format_resources(stats):
    if not stats:
        return "Catalog resources are unavailable right now. Please try again later."
    return (
        "📚 RliBook resources\n"
        "• Channels: %s\n" % format(stats["channels"], ",")
        + "• Books: %s\n" % format(stats["books"], ",")
        + "Search and download: https://kindle-opds-static.pages.dev"
    )
