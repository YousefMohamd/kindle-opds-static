"""Live additions (real-time sync) — Cloudflare KV layer.

A new book posted in any channel/group must be visible in the bot's
/resources counts and in search within ~1 minute. The durable catalog
(the static site) only changes when a sync publishes (daily 03:00 UTC),
so new books are ALSO written here, to a Cloudflare KV key, the moment
they are indexed — by the Telethon listener (``tbi.listener``) or by
the frequent new-only check (``tbi.live_sync``).

KV key ``live:additions`` (JSON)::

    {
      "since": "<ISO UTC of the last daily publish>",
      "books": [ LiveBook, ... ]   # newest first, capped at 500
    }

A LiveBook is one book file (metadata only — never the file bytes)::

    {
      "id": "<source>:<post_id>:<ext>",   # unique per file
      "title": str, "author": str,        # "" when unknown
      "source": "<handle>", "kind": "channel" | "group",
      "format": "PDF",                    # ext, upper-case
      "filename": str,
      "size_text": "12.3 MB" | null, "size_bytes": 12345678 | null,
      "url": "https://t.me/<handle>/<post_id>",
      "post_id": 123, "date": "<ISO>" | null,
      "added_at": "<ISO UTC when indexed>",
      "dedupe_key": str
    }

Why KV and not a git commit + Pages deploy: a Pages deploy takes
~1-2 minutes, which already breaks the 1-minute goal, and committing
every few minutes would flood the repo. A KV write is ~100 ms and the
bot reads its own KV on every /resources call, so a new book is
visible the moment it is written. The daily sync (03:00 UTC) merges
these books into the durable static catalog and then resets this key
(see ``reset_live``) — so the key always holds "books added since the
last daily publish" and the bot never double-counts them.

The bot (rlibook-bot-worker) reads this key with ``store.getLiveAdditions``
and adds ``totals`` to the published manifest numbers in /resources;
the Telegram search endpoint reads ``books`` to include them in
search results. The exact contract is documented in
``rlibook-realtime-sync/DESIGN.md``.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any, Optional

from .books import BOOK_EXTS, dedupe_key, parse_title_author
from .scrape import FileMeta, Post

LIVE_KEY = "live:additions"
LIVE_CURSOR_KEY = "live:cursor"
MAX_LIVE_BOOKS = 500


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def live_book_id(source: str, post_id: int, ext: str) -> str:
    """Unique id for one book file (source + post + format)."""
    return f"{source}:{post_id}:{ext.lower()}"


def live_book_from_file(
    post: Post, f: FileMeta, kind: str, *, added_at: Optional[str] = None
) -> Optional[dict[str, Any]]:
    """One FileMeta -> a LiveBook dict, or None when it is not a book.

    Uses the exact same title/author parsing as the durable indexer
    (``_book_file_dict`` in ``tbi.cli``), so a live book and a
    backfilled book for the same file are identical.
    """
    ext = (f.ext or "").lower()
    if ext not in BOOK_EXTS:
        return None
    title, author = parse_title_author(f.filename, post.text or "")
    return {
        "id": live_book_id(post.channel, post.post_id, ext),
        "title": title,
        "author": author,
        "source": post.channel,
        "kind": kind,
        "format": ext.upper(),
        "filename": f.filename,
        "size_text": f.size_text,
        "size_bytes": f.size_bytes,
        "url": post.url,
        "post_id": post.post_id,
        "date": post.date,
        "added_at": added_at or _now_iso(),
        "dedupe_key": dedupe_key(title, author, f.size_bytes),
    }


def live_books_from_post(post: Post, kind: str) -> list[dict[str, Any]]:
    """All book files in one Post -> LiveBook dicts (newest file first)."""
    out: list[dict[str, Any]] = []
    for f in post.files or []:
        book = live_book_from_file(post, f, kind)
        if book is not None:
            out.append(book)
    return out


def live_totals(books: list[dict[str, Any]]) -> dict[str, int]:
    """Counts for a list of LiveBooks: distinct posts, files, books."""
    posts = {b["post_id"] for b in books}
    # A "book" here is a distinct title+author+size (the catalog's
    # distinct-book definition); files are the individual book files.
    keys = {b.get("dedupe_key") or b["id"] for b in books}
    return {"posts": len(posts), "files": len(books), "books": len(keys)}


def empty_live() -> dict[str, Any]:
    return {"since": _now_iso(), "books": []}


def merge_live_books(
    existing: list[dict[str, Any]],
    new: list[dict[str, Any]],
    *,
    max_books: int = MAX_LIVE_BOOKS,
) -> list[dict[str, Any]]:
    """Merge new LiveBooks into the existing list.

    Pure function (no network) so it is unit-testable. New books go
    first (newest first); a book already present (same ``id``) is NOT
    duplicated — the existing entry is kept. The list is capped at
    ``max_books`` (oldest dropped). Returns the merged list.
    """
    seen = {b["id"] for b in existing}
    merged = list(existing)
    fresh: list[dict[str, Any]] = []
    for b in new:
        if b["id"] not in seen:
            seen.add(b["id"])
            fresh.append(b)
    # Newest first: fresh books first, then the existing list.
    merged = fresh + merged
    return merged[:max_books]


def parse_live(data: Any) -> dict[str, Any]:
    """Parse a stored live-additions value; returns ``empty_live()`` when
    the value is missing, malformed, or has the wrong shape."""
    if not isinstance(data, dict):
        return empty_live()
    books = data.get("books")
    if not isinstance(books, list):
        return empty_live()
    clean = [b for b in books if isinstance(b, dict) and b.get("id")]
    since = data.get("since")
    return {
        "since": since if isinstance(since, str) else _now_iso(),
        "books": clean[:MAX_LIVE_BOOKS],
    }


class CloudflareKV:
    """Minimal Cloudflare KV client (urllib only, no extra deps).

    Credentials come from the environment (never in the repo):
    ``CLOUDFLARE_API_TOKEN``, ``CLOUDFLARE_ACCOUNT_ID``,
    ``RLIBOOK_KV_ID`` (the namespace id — the same RLIBOOK_KV the bot
    uses). The token needs "Workers KV Storage: Edit" on that
    namespace. Raises ``RuntimeError`` when the credentials are
    missing; a missing key reads as ``None`` (not an error).
    """

    BASE = "https://api.cloudflare.com/client/v4"

    def __init__(
        self,
        token: Optional[str] = None,
        account_id: Optional[str] = None,
        namespace_id: Optional[str] = None,
    ) -> None:
        self.token = token or os.environ.get("CLOUDFLARE_API_TOKEN", "")
        self.account_id = account_id or os.environ.get(
            "CLOUDFLARE_ACCOUNT_ID", ""
        )
        self.namespace_id = namespace_id or os.environ.get("RLIBOOK_KV_ID", "")
        if not (self.token and self.account_id and self.namespace_id):
            raise RuntimeError(
                "Cloudflare KV credentials missing: set "
                "CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and "
                "RLIBOOK_KV_ID (GitHub Actions secrets / host env vars)."
            )

    def _url(self, key: str) -> str:
        from urllib.parse import quote

        return (
            f"{self.BASE}/accounts/{self.account_id}/storage/kv/"
            f"namespaces/{self.namespace_id}/values/{quote(key, safe='')}"
        )

    def _request(self, method: str, key: str, body: Optional[bytes] = None):
        req = urllib.request.Request(
            self._url(key),
            data=body,
            method=method,
            headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read()

    def get(self, key: str) -> Optional[str]:
        """Read a key; None when the key does not exist (404)."""
        status, body = self._request("GET", key)
        if status == 404:
            return None
        if status != 200:
            raise RuntimeError(f"KV GET {key}: HTTP {status}: {body[:200]!r}")
        return body.decode("utf-8")

    def put(self, key: str, value: str) -> None:
        """Write a key (overwrites). Raises on failure."""
        status, body = self._request("PUT", key, body=value.encode("utf-8"))
        if status != 200:
            raise RuntimeError(f"KV PUT {key}: HTTP {status}: {body[:200]!r}")
        try:
            data = json.loads(body.decode("utf-8"))
        except ValueError:
            data = {}
        if isinstance(data, dict) and data.get("success") is False:
            raise RuntimeError(f"KV PUT {key}: {body[:300]!r}")


def read_live(kv: CloudflareKV) -> dict[str, Any]:
    """Read the live-additions value (empty when the key is absent)."""
    raw = kv.get(LIVE_KEY)
    if raw is None:
        return empty_live()
    try:
        return parse_live(json.loads(raw))
    except ValueError:
        return empty_live()


def append_live_books(kv: CloudflareKV, books: list[dict[str, Any]]) -> dict[str, Any]:
    """Append books to the live-additions key (dedupe + cap).

    Returns the stored value (with ``totals``). A no-op when ``books``
    is empty (no KV write). Raises on KV failure so the caller can
    retry or log it — the durable daily sync is the fallback.
    """
    if not books:
        return read_live(kv)
    current = read_live(kv)
    merged = merge_live_books(current["books"], books)
    value = {
        "since": current.get("since") or _now_iso(),
        "books": merged,
        "totals": live_totals(merged),
    }
    kv.put(LIVE_KEY, json.dumps(value, ensure_ascii=False))
    return value


def reset_live(kv: CloudflareKV) -> None:
    """Clear the live-additions key (called by the daily sync AFTER it
    has published the durable catalog — the books are then in the
    static site, so the live window starts fresh and the bot never
    double-counts them)."""
    kv.put(LIVE_KEY, json.dumps(empty_live(), ensure_ascii=False))


def read_cursor(kv: CloudflareKV) -> dict[str, int]:
    """Read the live-sync cursor: {handle: newest post_id checked}."""
    raw = kv.get(LIVE_CURSOR_KEY)
    if raw is None:
        return {}
    try:
        data = json.loads(raw)
    except ValueError:
        return {}
    if not isinstance(data, dict):
        return {}
    return {k: int(v) for k, v in data.items() if isinstance(v, int)}


def write_cursor(kv: CloudflareKV, cursor: dict[str, int]) -> None:
    kv.put(LIVE_CURSOR_KEY, json.dumps(cursor, ensure_ascii=False))
