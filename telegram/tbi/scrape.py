"""Minimal vendored scraper for the public Telegram web preview (t.me/s/).

Why vendored instead of depending on the ``telegram-channel-scraper``
(tgscraper) PyPI package:
  * tgscraper 2.0.0 crashes in proxied environments — httpx chokes on a
    ``NO_PROXY`` entry such as ``[::1]`` (``InvalidURL: Invalid port: ':1]'``),
    verified 2026-11-06. Our scraper uses stdlib urllib and is immune.
  * tgscraper's ``Media`` model has no file-size field; this tool needs
    filename + size for every document, so the document parsing is ours
    anyway.
  * The upstream is tiny (10 stars, 13 commits). The subset we need —
    fetch a preview page, parse posts, walk ``?before=`` — is ~200 lines
    and is covered by offline HTML-fixture tests, so we own the failure
    mode instead of inheriting a stranger's.

What it does NOT do (by design, per the research):
  * Public groups have no t.me/s/ preview — they are classified, warned
    about, and skipped here (see :func:`classify`). Groups are indexed
    from Telegram Desktop exports instead (see :mod:`tbi.exports`).
  * Documents have no public download link — we record filename, size,
    type and the post permalink; the file itself is obtained in Telegram.
"""

from __future__ import annotations

import re
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime
from typing import Iterator, List, Optional

from bs4 import BeautifulSoup

BASE = "https://t.me/s/"
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)
# t.me/s/ serves ~20 posts per page.
PAGE_SIZE = 20

_SIZE_RE = re.compile(
    r"(?P<num>\d+(?:[.,]\d+)?)\s*(?P<unit>KB|MB|GB|B)\b", re.IGNORECASE
)
_UNIT_BYTES = {"B": 1, "KB": 1024, "MB": 1024**2, "GB": 1024**3}


@dataclass
class FileMeta:
    """One file attached to a post (document or audio file).

    ``size_text``/``size_bytes`` are set only when the preview's extra
    line actually contains a size (``"12.3 MB"``). For audio files the
    extra line is the artist name, so it goes to ``extra_text`` instead
    (verified live 2026-11-06: an audio post's extra was "Antonin
    Dvorak", not a size). The preview also truncates long titles
    (``"American" ..``) — filenames from the preview can be incomplete.
    """

    filename: str
    ext: str = ""
    size_text: Optional[str] = None
    size_bytes: Optional[int] = None
    kind: str = "document"  # document | audio
    extra_text: Optional[str] = None

    def __post_init__(self) -> None:
        if "." in self.filename:
            self.ext = self.filename.rsplit(".", 1)[-1].lower()


@dataclass
class Post:
    """One public channel post."""

    channel: str
    post_id: int
    date: Optional[str] = None  # ISO 8601 from the <time datetime=...> attr
    text: str = ""
    url: str = ""  # t.me/<channel>/<id> permalink
    views: Optional[int] = None
    files: List[FileMeta] = field(default_factory=list)


def _parse_views(text: str) -> Optional[int]:
    """'2.04M' -> 2040000, '212K' -> 212000, '428' -> 428."""
    m = re.match(r"^\s*(\d+(?:[.,]\d+)?)\s*([KM])?\s*$", text, re.IGNORECASE)
    if not m:
        return None
    num = float(m.group(1).replace(",", "."))
    mult = {"K": 1_000, "M": 1_000_000}.get((m.group(2) or "").upper(), 1)
    return int(round(num * mult))


def parse_size(text: Optional[str]) -> tuple[Optional[str], Optional[int]]:
    """Parse '12.3 MB' / 'PDF, 1.2 GB' / '850 KB' -> (clean text, bytes)."""
    if not text:
        return None, None
    m = _SIZE_RE.search(text)
    if not m:
        return text.strip() or None, None
    num = float(m.group("num").replace(",", "."))
    unit = m.group("unit").upper()
    size_text = f"{m.group('num')} {unit}"
    return size_text, int(round(num * _UNIT_BYTES[unit]))


def normalize_link(link: str) -> Optional[str]:
    """'https://t.me/durov', 't.me/durov', '@durov', 'durov' -> 'durov'."""
    link = (link or "").strip()
    if not link:
        return None
    link = re.sub(r"^https?://", "", link, flags=re.IGNORECASE)
    link = re.sub(r"^t\.me/(s/)?", "", link, flags=re.IGNORECASE)
    link = link.lstrip("@").split("/")[0].split("?")[0].strip()
    return link or None


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Capture the redirect target without following it."""

    def __init__(self) -> None:
        self.location: Optional[str] = None

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[override]
        self.location = newurl
        return None


def _fetch(url: str, timeout: int = 30) -> tuple[int, Optional[str], bytes]:
    """GET url. Returns (status, redirect_location, body_bytes).

    Uses urllib (stdlib): it honours the environment proxy correctly,
    unlike the httpx setup in tgscraper 2.0.0.
    """
    handler = _NoRedirect()
    opener = urllib.request.build_opener(handler)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with opener.open(req, timeout=timeout) as resp:
            return resp.status, handler.location, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, handler.location, exc.read() if hasattr(exc, "read") else b""


def classify(name: str, timeout: int = 30) -> str:
    """Classify a public t.me name by probing its preview page.

    Returns one of:
      * ``"channel"`` — t.me/s/<name> serves post HTML (live-scrapable).
      * ``"no_preview"`` — t.me/s/<name> redirects to the t.me/<name>
        info card. This covers public groups, private entities,
        preview-disabled channels, AND names that do not exist: the
        info card is a generic contact prompt in all those cases
        (verified 2026-11-06), so they cannot be told apart without
        a Telegram account. If the link is a group, index it from a
        Desktop export instead (see :mod:`tbi.exports`).
      * ``"unknown"`` — any other HTTP status (rate limit, network error).
    """
    name = normalize_link(name) or ""
    if not name:
        return "no_preview"
    status, location, body = _fetch(BASE + urllib.parse.quote(name), timeout=timeout)
    if status in (301, 302, 303, 307, 308):
        return "no_preview"
    if status != 200:
        return "unknown"
    if location and location.rstrip("/") != (BASE + name).rstrip("/"):
        return "no_preview"
    text = body.decode("utf-8", "replace")
    if "tgme_widget_message_wrap" in text:
        return "channel"
    if "tgme_channel" in text or "tgme_page_title" in text:
        # A channel page with no posts (empty channel) still counts.
        return "channel"
    return "no_preview"


def parse_page(html: str, channel: str) -> List[Post]:
    """Parse one t.me/s/ page into posts (newest first)."""
    soup = BeautifulSoup(html, "html.parser")
    posts: List[Post] = []
    for node in soup.select(".tgme_widget_message_wrap"):
        # data-post lives on the inner .tgme_widget_message div, not the wrap.
        post_el = node.select_one("[data-post]") or node
        post_attr = post_el.get("data-post", "")
        m = re.match(r"^[^/]+/(\d+)$", post_attr or "")
        if not m:
            continue
        post_id = int(m.group(1))
        # The post date is time[datetime] inside the date link. A plain
        # select_one("time") is wrong: video posts have a duration <time>
        # (e.g. "1:15", no datetime) before the date element.
        date_el = node.select_one(".tgme_widget_message_date time[datetime]")
        date = date_el.get("datetime") if date_el is not None else None
        text_el = node.select_one(".tgme_widget_message_text")
        text = text_el.get_text("\n", strip=True) if text_el is not None else ""
        views = None
        views_el = node.select_one(".tgme_widget_message_views")
        if views_el is not None:
            views = _parse_views(views_el.get_text(strip=True))
        files: List[FileMeta] = []
        for wrap in node.select(".tgme_widget_message_document_wrap"):
            title_el = wrap.select_one(".tgme_widget_message_document_title")
            extra_el = wrap.select_one(".tgme_widget_message_document_extra")
            title = title_el.get_text(strip=True) if title_el is not None else ""
            if not title:
                continue
            extra = (
                extra_el.get_text(" ", strip=True)
                if extra_el is not None
                else None
            )
            kind = "audio" if wrap.select_one(".audio") else "document"
            size_text, size_bytes = (None, None)
            if kind == "document":
                # Only accept the extra line as a size when it actually
                # looks like one; otherwise keep it verbatim.
                size_text, size_bytes = parse_size(extra)
                if size_bytes is None:
                    size_text = None
            files.append(
                FileMeta(
                    filename=title,
                    size_text=size_text,
                    size_bytes=size_bytes,
                    kind=kind,
                    extra_text=extra,
                )
            )
        posts.append(
            Post(
                channel=channel,
                post_id=post_id,
                date=date,
                text=text,
                url=f"https://t.me/{channel}/{post_id}",
                views=views,
                files=files,
            )
        )
    posts.sort(key=lambda p: p.post_id, reverse=True)
    return posts


def fetch_page(
    channel: str,
    *,
    before: Optional[int] = None,
    query: Optional[str] = None,
    delay: float = 1.5,
    retries: int = 3,
    timeout: int = 30,
) -> List[Post]:
    """Fetch one preview page. ``before`` walks backwards; ``query`` is
    Telegram's server-side search inside the channel (capped — see README).
    Retries 429/5xx with exponential backoff honouring Retry-After.
    """
    params: dict[str, str] = {}
    if before is not None:
        params["before"] = str(before)
    if query:
        params["q"] = query
    url = BASE + urllib.parse.quote(channel)
    if params:
        url += "?" + urllib.parse.urlencode(params)
    last_exc: Optional[Exception] = None
    for attempt in range(retries + 1):
        if attempt:
            wait = min(30.0, (2**attempt) * delay)
            time.sleep(wait)
        else:
            time.sleep(delay)
        try:
            status, location, body = _fetch(url, timeout=timeout)
        except Exception as exc:  # network-level failure
            last_exc = exc
            continue
        if status in (429, 500, 502, 503, 504):
            last_exc = RuntimeError(f"HTTP {status} for {url}")
            continue
        if status in (301, 302, 303, 307, 308) or status == 404:
            raise ValueError(
                f"Channel {channel!r} has no public preview "
                f"(HTTP {status}); it may be a group, private, or preview-disabled."
            )
        if status != 200:
            last_exc = RuntimeError(f"HTTP {status} for {url}")
            continue
        return parse_page(body.decode("utf-8", "replace"), channel)
    raise RuntimeError(f"Failed to fetch {url} after {retries + 1} attempts: {last_exc}")


def walk(
    channel: str,
    *,
    limit: Optional[int] = None,
    min_id: Optional[int] = None,
    start_before: Optional[int] = None,
    delay: float = 1.5,
) -> Iterator[Post]:
    """Walk a channel newest -> oldest via ``?before=``.

    ``limit`` caps the total posts returned (None = walk until the preview
    stops serving posts — note the preview has a coverage ceiling, so
    'until empty' is not a guarantee of full history; see README).
    ``min_id`` stops before that post id (used for incremental runs:
    only posts newer than ``min_id`` are yielded).
    ``start_before`` starts the walk below that post id instead of at
    the newest post (used to resume an interrupted full walk: posts at
    or above ``start_before`` are already indexed, so they are skipped
    without re-fetching their pages).
    Yields posts newest first, de-duplicated by id.
    """
    seen: set[int] = set()
    before: Optional[int] = start_before
    yielded = 0
    while True:
        page = fetch_page(channel, before=before, delay=delay)
        if not page:
            return
        new_posts = [p for p in page if p.post_id not in seen]
        if not new_posts:
            return
        for post in new_posts:
            if min_id is not None and post.post_id <= min_id:
                return
            seen.add(post.post_id)
            yield post
            yielded += 1
            if limit is not None and yielded >= limit:
                return
        before = min(p.post_id for p in new_posts)
        # NOTE: do NOT stop on a short page. The preview can return fewer
        # than 20 posts mid-walk (e.g. a deleted post leaves a gap —
        # durov's page 2 has 19 posts, id 530 missing) while older posts
        # still exist. Only an empty page or zero new posts ends the walk.


def search_channel(channel: str, query: str, *, limit: int = 50) -> List[Post]:
    """Server-side search inside one channel (``?q=``). Capped by Telegram
    to roughly one screen of results — use :func:`walk` + local FTS for a
    complete answer. Returns at most ``limit`` posts, newest first."""
    posts = fetch_page(channel, query=query, delay=1.5)
    return posts[:limit]
