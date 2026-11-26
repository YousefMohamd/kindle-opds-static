"""Build the newest-books feed (``newest.json``) for the /new page.

Why this file exists: the Telegram shards (``site/telegram/index-*.json``)
hold a post date per book, but they are grouped BY SOURCE (see
``tbi.export_static.build_shards``: sources are packed whole into a
shard) and newest-first only WITHIN each source — verified 2026-11-12:
books dated >= 2026-11-01 sit as deep as position 94,356 of shard 0,
so the head of a shard is NOT the global newest. A Pages Function
cannot fetch + parse a ~19 MiB shard anyway (the CDN ignores Range
requests and the free tier allows ~10 ms CPU/request — see
``functions/api/tg-search.js``). The OPDS search indexes carry no
date at all, and the ``live:additions`` KV key is empty until the
real-time sync writer is deployed. So no live source can answer
"newest books" cheaply today.

The cheap answer is a tiny static file, generated at publish time by
SCANNING all shard records (323k rows, ~65 MiB — a few seconds in the
same sync job that already loads the whole DB), sorting by post date,
and keeping the newest 30. The result is ~7 KB.
``functions/new.js`` fetches only this file.

Regeneration (daily sync): run right after ``tbi export-static`` in
``.github/workflows/telegram-sync.yml`` (the step that writes
``site/telegram.new/``), before the ``mv`` to ``site/telegram/``::

    python3 -m telegram.tbi.newest --shard-dir site/telegram.new \\
        --out site/telegram.new/newest.json --limit 30

Run from the repo root. The file is published with the rest of
``site/telegram/`` — no new infrastructure, no deploy of its own.

Record fields (same positions as ``tbi.export_static.BOOK_FIELDS``):
``[title, author, filename, ext, size, source, sources, date, handle, post]``
— the Workstream H 10-field shape (the raw post URL is NOT stored,
only handle + post id). A legacy 9-field row
``[title, author, filename, ext, size, source, sources, date, url]``
is still understood. Only title/author/source/format/date/url are
kept in the output; the output ``url`` is rebuilt as
``https://t.me/<handle>/<post>`` from the 10-field row — reading
row[8] as the URL (as the pre-H code did) yields the bare handle
(e.g. ``"rwaiaty4"``), which is not a link at all. Verified live
2026-11-26: the published newest.json has ``"url": "rwaiaty4"`` on
every book. A row with no usable handle/post (a private-channel
book whose post URL never parsed) gets ``url: ""`` — the /new page
then shows no link instead of a broken one.

Live merge (``--live-json``): the shard data itself can lag the real
catalog by days — verified 2026-11-26, the shards top out at
2026-11-21 while the real-time sync (MTProto, every 10 min) has
books dated 2026-11-26 in the bot Worker's Durable Object key
``live:additions``. Two gaps cause the lag, and neither is this
builder's fault: (1) groups (172 of 223 sources) have no t.me/s/
preview, so the daily sync's preview scrape can never see their new
posts — they only ever enter via the realtime writer; (2) the
preview scrape itself found ZERO new book files on the Nov 23, 24
and 25 daily runs (52/51/52 new posts seen, 0 files) although the
realtime writer saw book posts in channels in the same window
(e.g. darkromancenovels posts 6372/6374/6375/6377/6378, Nov 24-25)
— a separate scrape investigation is still open (see the newest-fix
report). Until the seed pipeline is fixed, the feed stays fresh by
merging the live snapshot in front of the shard books: the workflow
fetches the public endpoint (no secret — GET
``https://rlibook-bot.mohamedyou1357.workers.dev/api/live-state?key=live:additions``)
to ``live-additions.json`` and passes ``--live-json``; live books
are deduped against the shard books by (title, author, format) so a
book found by both paths appears once (the live copy wins — it
carries the full post URL), the merged list is sorted newest-first,
and the top ``limit`` are kept. When the snapshot is missing or
malformed the builder warns and falls back to shards alone, so a
live-endpoint outage can never break the daily publish. Flagged
books are NOT filtered here: ``functions/new.js`` flag-checks every
shown book at request time (KV ``flag:<handle>:<post_id>``), live or
static, so a flagged live book still renders flagged with no send
button — the same rule as the page's own live merge.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_LIMIT = 30


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def row_url(row: list) -> str:
    """The post URL for one shard row.

    10-field (current, Workstream H): ``[8]`` is the handle and
    ``[9]`` the post id — the URL is rebuilt from them. 9-field
    (legacy): ``[8]`` is the stored URL itself. Anything else was
    already filtered out by the caller. Empty handle/post (a
    private-channel book whose post URL never parsed) yields ""
    — no link, never a broken one.
    """
    if len(row) >= 10:
        handle = (row[8] or "").strip()
        post = (row[9] or "").strip()
        if handle and post:
            return f"https://t.me/{handle}/{post}"
        return ""
    return (row[8] or "").strip()


def load_all_books(shard_dir: str | os.PathLike) -> list[dict]:
    """Every book in every shard, as dicts (full scan — see header).

    A full scan is required: shards group by source, so the global
    newest books are scattered through the shards. ~323k rows, a few
    seconds; this runs at publish time, never in a Function.
    """
    books: list[dict] = []
    for path in sorted(glob.glob(str(Path(shard_dir) / "index-*.json"))):
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        for row in data.get("books", []):
            if not isinstance(row, list) or len(row) < 9:
                continue
            title = (row[0] or "").strip()
            if not title:
                continue
            books.append(
                {
                    "title": title,
                    "author": (row[1] or "").strip(),
                    "source": row[5] or "",
                    "format": (row[3] or "").upper(),
                    "date": (row[7] or "")[:10],
                    "url": row_url(row),
                }
            )
    return books


def load_live_books(path: str | os.PathLike) -> list[dict]:
    """Live books from a ``live:additions`` snapshot file.

    The snapshot is the value of the bot Worker's Durable Object key
    ``live:additions`` (``{"since": ..., "books": [LiveBook, ...]}``,
    newest first) — the same shape ``functions/new.js`` reads from
    the ``/api/live-state`` endpoint. A LiveBook carries the full
    post URL and a full ISO post ``date`` (falling back to
    ``added_at`` when the post date is missing). A missing,
    malformed, or wrong-shaped file yields ``[]`` — the caller falls
    back to shards alone and the publish is never blocked by it.
    """
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError) as exc:
        print(f"warning: live snapshot {path} unreadable ({exc}) — "
              "building from shards alone", file=sys.stderr)
        return []
    raw = data.get("books") if isinstance(data, dict) else None
    if not isinstance(raw, list):
        print(f"warning: live snapshot {path} has no 'books' list — "
              "building from shards alone", file=sys.stderr)
        return []
    books: list[dict] = []
    for b in raw:
        if not isinstance(b, dict):
            continue
        title = (b.get("title") or "").strip()
        if not title:
            continue
        date = (b.get("date") or "")[:10] or (b.get("added_at") or "")[:10]
        books.append(
            {
                "title": title,
                "author": (b.get("author") or "").strip(),
                "source": (b.get("source") or "").strip(),
                "format": (b.get("format") or "").strip().upper(),
                "date": date,
                "url": (b.get("url") or "").strip(),
            }
        )
    # Newest first by post date (the DO list already is, but sort
    # defensively — the merge below assumes newest-first order).
    books.sort(key=lambda b: (b["date"], b["title"]), reverse=True)
    return books


def build_newest(
    shard_dir: str | os.PathLike,
    limit: int = DEFAULT_LIMIT,
    live_books: list[dict] | None = None,
) -> dict:
    """Newest ``limit`` books across all shards (post-date desc).

    When ``live_books`` is given (see ``load_live_books``), they are
    merged with the shard books, deduped live-first, and the merged
    list is sorted newest-first — live books are usually the newest,
    but the live window can also hold books older than the shards'
    newest, so the final sort (not concatenation order) decides.
    """
    books = load_all_books(shard_dir)
    # Newest first by post date; ties keep shard order (stable sort),
    # then title for determinism.
    books.sort(key=lambda b: (b["date"], b["title"]), reverse=True)
    # Dedupe live-first (the live copy wins for a book found by both
    # paths), then sort the merged list — a live book can be OLDER
    # than the shards' newest (the live window starts at the last
    # daily publish), so concatenation order alone is not date order.
    seen: set[tuple[str, str, str]] = set()
    merged: list[dict] = []
    for b in (live_books or []) + books:
        key = (b["title"], b["author"], b["format"])
        if key in seen:
            continue
        seen.add(key)
        merged.append(b)
    merged.sort(key=lambda b: (b["date"], b["title"]), reverse=True)
    newest = merged[:limit]
    return {"generated_at": _now_iso(), "count": len(newest), "books": newest}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--shard-dir", required=True, help="dir holding index-*.json shards")
    ap.add_argument("--out", required=True, help="output newest.json path")
    ap.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    ap.add_argument("--live-json", default=None,
                    help="live:additions snapshot (JSON from the bot "
                         "Worker /api/live-state endpoint); merged in "
                         "front of the shard books. Missing/malformed "
                         "falls back to shards alone.")
    args = ap.parse_args(argv)
    live = load_live_books(args.live_json) if args.live_json else []
    result = build_newest(args.shard_dir, args.limit, live)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    newest = result["books"][0]["date"] if result["books"] else "-"
    oldest = result["books"][-1]["date"] if result["books"] else "-"
    print(f"wrote {out} ({out.stat().st_size} bytes): "
          f"{result['count']} books, {newest} .. {oldest} "
          f"(live merged: {len(live)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
