"""Submit a single book to the index (individual indexing).

``tbi submit-book --source <link> --title "..."`` records ONE book with
its source — a ``t.me`` channel/group post link, or an external source
URL — in the same SQLite index the scrapers write to, so the book is
searchable (and published) like any other indexed book.

The bot (Phase 2) will call this when a user submits a book; the CLI
is the library version. **No file download or hosting** — metadata +
source link only, the same rule as every other indexer here, and
legal sources only.

A submitted book is idempotent: the same source URL always maps to the
same synthetic post, so submitting the same book twice does not
duplicate it (the post's files are replaced, exactly like a re-walked
post). A book that is already in the index from another source is
reported as such instead of being hidden.
"""

from __future__ import annotations

import hashlib
import re
import urllib.parse
from datetime import datetime, timezone
from typing import Optional

from .books import BOOK_EXTS, dedupe_key, format_size
from .scrape import normalize_link, parse_size
from .store import Store

# Synthetic post ids for submissions live above 2**30 — real Telegram
# post ids are sequential from 1 and cannot reach there, so a submitted
# book can never collide with (and overwrite) a real post.
_SYNTHETIC_BASE = 1 << 30

_HANDLE_RE = re.compile(r"^[A-Za-z0-9_]+$")


def _synthetic_post_id(url: str) -> int:
    """Deterministic post id for a source URL (idempotent submits)."""
    digest = hashlib.sha256(url.encode("utf-8")).digest()
    return _SYNTHETIC_BASE + (int.from_bytes(digest[:4], "big") % (1 << 30))


def validate_source(url: str) -> dict:
    """Validate a book's source link.

    Accepts:
      * a ``t.me`` link — ``https://t.me/<handle>`` or
        ``https://t.me/<handle>/<post_id>`` (scheme optional, ``t.me/``
        or ``www.t.me/``), kind ``"telegram"``;
      * any other ``http(s)`` URL with a real domain, kind
        ``"external"``.

    Returns ``{"kind", "url", "handle", "post_id", "domain"}``.
    Raises ValueError for anything else (ftp, javascript:, relative
    paths, empty strings, a bare scheme, a t.me link with no handle or
    a non-numeric post id). The normalized URL is what gets stored as
    the book's obtain link.
    """
    raw = (url or "").strip()
    if not raw:
        raise ValueError("source must be a t.me link or an http(s) URL")
    if " " in raw:
        raise ValueError(f"not a valid source link: {raw!r}")
    parsed = urllib.parse.urlparse(
        raw if re.match(r"^https?://", raw, re.IGNORECASE) else "https://" + raw
    )
    netloc = (parsed.netloc or "").lower()
    if netloc in ("t.me", "www.t.me"):
        parts = [p for p in parsed.path.split("/") if p]
        if not parts or not _HANDLE_RE.match(parts[0]):
            raise ValueError(
                f"not a valid t.me link (no channel/group handle): {raw!r}"
            )
        handle = parts[0]
        post_id: Optional[int] = None
        if len(parts) > 1:
            if not parts[1].isdigit():
                raise ValueError(
                    f"not a valid t.me post link (post id must be a "
                    f"number): {raw!r}"
                )
            post_id = int(parts[1])
        if len(parts) > 2:
            raise ValueError(f"not a valid t.me link: {raw!r}")
        return {
            "kind": "telegram",
            "url": f"https://t.me/{handle}"
            + (f"/{post_id}" if post_id is not None else ""),
            "handle": handle,
            "post_id": post_id,
            "domain": "t.me",
        }
    if parsed.scheme in ("http", "https") and netloc and "." in netloc:
        return {
            "kind": "external",
            "url": raw,
            "handle": None,
            "post_id": None,
            "domain": netloc,
        }
    raise ValueError(
        f"not a valid source link (need a t.me link or an http(s) URL "
        f"with a domain): {raw!r}"
    )


def submit_book(
    store: Store,
    source: str,
    title: str,
    author: str = "",
    format: str = "epub",
    size_bytes: Optional[int] = None,
    size_text: Optional[str] = None,
) -> dict:
    """Index one book with its source recorded. Returns the record.

    ``format`` must be one of ``BOOK_EXTS`` (EPUB, MOBI, AZW3, AZW, KFX,
    KEPUB, PDF, TXT, DOC, DOCX, DJVU, DJV, FB2, CBR, CBZ, RTF, PRC,
    ODT, CHM, LIT, LRF, PDB). ``size_bytes``/``size_text`` are optional — when only
    one is given the other is derived (``parse_size`` / ``format_size``).
    The book lands in the same ``posts``/``files`` tables as scraped
    books, with ``obtain_url`` = the source link, so search, the static
    export, and the published site treat it identically. The ``source``
    of a ``t.me`` link is its channel/group; an external URL is stored
    under a ``submitted`` source named after its domain.

    ``already_indexed_from`` counts how many sources already hold this
    book (same dedup key) — 0 means this submission is the first copy
    in the index.
    """
    info = validate_source(source)
    fmt = (format or "").strip().lower().lstrip(".")
    if fmt not in BOOK_EXTS:
        raise ValueError(
            f"unsupported format {format!r} — must be one of: "
            + ", ".join(sorted(BOOK_EXTS))
        )
    clean_title = (title or "").strip()
    if not clean_title:
        raise ValueError("title must not be empty")
    clean_author = (author or "").strip()
    if size_bytes is None and size_text:
        _, size_bytes = parse_size(size_text)
    if size_text is None and size_bytes is not None:
        size_text = format_size(size_bytes)
    key = dedupe_key(clean_title, clean_author, size_bytes)
    already = store.count_sources_with_key(key)

    if info["kind"] == "telegram":
        kind, name = "channel", info["handle"]
        post_id = (
            info["post_id"]
            if info["post_id"] is not None
            else _synthetic_post_id(info["url"])
        )
    else:
        kind, name = "submitted", info["domain"]
        post_id = _synthetic_post_id(info["url"])

    filename = clean_title
    if not filename.lower().endswith("." + fmt):
        filename = f"{filename}.{fmt}"
    sid = store.upsert_source(kind, name)
    db_pid = store.upsert_post(
        sid,
        post_id,
        datetime.now(timezone.utc).isoformat(),
        clean_title,
        info["url"],
    )
    # The title/author are supplied explicitly — use them as-is. (Do NOT
    # re-parse the synthetic filename: a title containing " - " would be
    # split into a wrong title/author pair by parse_title_author.)
    store.replace_files_for_post(
        db_pid,
        [
            {
                "filename": filename,
                "ext": fmt,
                "size_text": size_text,
                "size_bytes": size_bytes,
                "title": clean_title,
                "author": clean_author,
                "dedupe_key": key,
                "obtain_url": info["url"],
            }
        ],
    )
    store.commit()
    return {
        "title": clean_title,
        "author": clean_author,
        "format": fmt,
        "filename": filename,
        "source": name,
        "kind": kind,
        "obtain_url": info["url"],
        "dedupe_key": key,
        "already_indexed_from": already,
    }
