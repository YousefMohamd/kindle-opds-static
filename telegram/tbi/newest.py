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
``[title, author, filename, ext, size, source, sources, date, url]``.
Only title/author/source/format/date/url are kept in the output.
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
                    "url": row[8] or "",
                }
            )
    return books


def build_newest(shard_dir: str | os.PathLike, limit: int = DEFAULT_LIMIT) -> dict:
    """Newest ``limit`` books across all shards (post-date desc)."""
    books = load_all_books(shard_dir)
    # Newest first by post date; ties keep shard order (stable sort),
    # then title for determinism.
    books.sort(key=lambda b: (b["date"], b["title"]), reverse=True)
    seen: set[tuple[str, str, str]] = set()
    newest: list[dict] = []
    for b in books:
        key = (b["title"], b["author"], b["format"])
        if key in seen:
            continue
        seen.add(key)
        newest.append(b)
        if len(newest) >= limit:
            break
    return {"generated_at": _now_iso(), "count": len(newest), "books": newest}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--shard-dir", required=True, help="dir holding index-*.json shards")
    ap.add_argument("--out", required=True, help="output newest.json path")
    ap.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    args = ap.parse_args(argv)
    result = build_newest(args.shard_dir, args.limit)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    newest = result["books"][0]["date"] if result["books"] else "-"
    oldest = result["books"][-1]["date"] if result["books"] else "-"
    print(f"wrote {out} ({out.stat().st_size} bytes): "
          f"{result['count']} books, {newest} .. {oldest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
