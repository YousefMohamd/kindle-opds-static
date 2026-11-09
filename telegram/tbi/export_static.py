"""Static-site export: turn the SQLite index into the files Cloudflare
Pages serves.

``tbi export-static`` reads the DB (read-only in effect — it never
writes to it) and writes, into the output directory:

* ``index.json`` — a small MANIFEST (totals, per-source totals, the
  list of formats, and the list of shard files). The search page loads
  this file first; it is tiny.
* ``index-<n>.json`` — SHARD files, one JSON object per file of the
  form ``{"books": [[title, author, filename, ext, size, source,
  sources, date, url], ...]}`` (compact arrays, positional fields).
  Books are grouped by source (in the store's newest-first order)
  and a shard is closed before it would exceed ``SHARD_BYTES``, so
  every shard stays well under Cloudflare Pages' 25 MiB per-file
  limit. The search page loads only the shards it needs (one source's
  shards when a source is selected, all shards — in parallel, as they
  arrive — for a free-text search) and converts each array back to
  the object shape the renderer uses.

Why sharding (v0.6.1): the old single ``index.json`` held every
distinct book (197,304 books = 53.3 MiB) and Cloudflare Pages
rejects any file over 25 MiB, so the deployment failed with
"Pages only supports files up to 25 MiB in size" and the site served
stale data. Sharding keeps every deployed file small; the total data
is unchanged and the search covers every book.

* ``index-report.md`` — a copy of the latest run report, when one
  exists next to the DB (or at ``--report``).

The search page itself (``site/telegram/index.html``) is a
hand-written static file in the repo, not generated — this module
only regenerates the data it loads. Writes are atomic (temp file +
rename) so a failed export never leaves a half-written file behind.
"""

from __future__ import annotations

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from . import __version__
from .store import Store

# Cloudflare Pages rejects any file over 25 MiB. Shards are closed
# well below that (20 MiB by estimated bytes) so a shard can never
# approach the limit even if the estimate is slightly low.
SHARD_BYTES = 20 * 1024 * 1024

# Positional fields of a book entry in a shard (compact arrays).
# The search page maps them back to objects with these keys.
BOOK_FIELDS = (
    "title",
    "author",
    "filename",
    "ext",
    "size",
    "source",
    "sources",
    "date",
    "url",
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _book_rows(store: Store) -> list:
    """One dict per distinct book (newest file's data), newest first."""
    return [
        {
            "title": b["title"] or b["filename"],
            "author": b["author"] or "",
            "filename": b["filename"],
            "ext": b["ext"] or "",
            "size": b["size_text"] or "",
            "source": b["source_name"],
            "sources": b["source_count"],
            "date": (b["date"] or "")[:10],
            "url": b["obtain_url"] or "",
        }
        for b in store.list_books()
    ]


def _book_array(book: dict) -> list:
    return [book[f] for f in BOOK_FIELDS]


def _array_bytes(book_array: list) -> int:
    # Estimated bytes of one book entry inside a shard JSON document
    # (the JSON of the array itself, plus a separator/bracket share).
    # Count UTF-8 BYTES, not characters: Arabic titles are 2 bytes
    # per character on disk, and a character count would undercount
    # the real file size (at scale that put a 20 MiB estimate at
    # 23.8 MiB actual — too close to Pages' 25 MiB limit).
    return len(json.dumps(book_array, ensure_ascii=False).encode("utf-8")) + 2


def build_index_json(store: Store) -> dict:
    """The full index as one dict (distinct books + sources).

    Kept for small DBs and for tests that check deduping. The
    deployed site no longer writes this as a single file (see
    ``build_shards``) because at 197k books it is 53 MiB, over
    Cloudflare Pages' 25 MiB per-file limit.
    """
    totals = store.counts()
    sources = [
        {
            "name": s["name"],
            "kind": s["kind"],
            "status": s["status"],
            "posts": s["post_count"] or 0,
            "files": s["file_count"] or 0,
            "oldest": s["oldest_post_id"],
            "newest": s["newest_post_id"],
        }
        for s in store.per_source_totals()
    ]
    return {
        "generated_at": _now_iso(),
        "tool": f"telegram-book-index {__version__}",
        "totals": {
            "posts": totals["posts"],
            "files": totals["files"],
            "books": totals["books"],
            "sources": totals["sources"],
        },
        "sources": sources,
        "books": _book_rows(store),
    }


def build_shards(store: Store, shard_bytes: int = SHARD_BYTES) -> tuple:
    """Split the book list into a manifest + shard payloads.

    Returns ``(manifest, shards)`` where ``manifest`` is the small
    dict written as ``index.json`` and ``shards`` is a list of
    ``(filename, {"books": [[...], ...]})`` in load order. Books are
    grouped by source, then whole sources are packed into a shard
    until adding the next source would exceed ``shard_bytes`` (a
    single source larger than the budget is split by bytes across
    several shards). Every shard's estimated size is therefore <=
    ``shard_bytes`` (well under Pages' 25 MiB limit), and the shard
    count stays small (a few shards for the whole catalog, not one
    per book). The manifest lists, per shard, the sources it holds,
    so the search page loads only the shard(s) for the selected
    source — and all shards, in parallel, for a free-text search.
    """
    totals = store.counts()
    sources = [
        {
            "name": s["name"],
            "kind": s["kind"],
            "status": s["status"],
            "posts": s["post_count"] or 0,
            "files": s["file_count"] or 0,
            "oldest": s["oldest_post_id"],
            "newest": s["newest_post_id"],
        }
        for s in store.per_source_totals()
    ]
    books = _book_rows(store)
    formats = sorted({b["ext"] for b in books if b["ext"]})

    # Group by source, preserving the store's newest-first order
    # inside each source. (The store lists books newest-first
    # globally, so consecutive books usually belong to different
    # sources — grouping first is what keeps the shard count small.)
    by_source: dict = {}
    for book in books:
        by_source.setdefault(book["source"], []).append(book)

    # The order sources first appear in the newest-first list.
    source_order = list(by_source)

    shards = []
    current = []          # book dicts in the open shard
    current_sources = []  # source names in the open shard
    current_bytes = len(b'{"books":[') + len(b"]}")

    def _flush():
        nonlocal current, current_sources, current_bytes
        if not current:
            return
        filename = f"index-{len(shards)}.json"
        shards.append(
            (
                filename,
                {"books": [_book_array(b) for b in current]},
                list(current_sources),
                len(current),
            )
        )
        current = []
        current_sources = []
        current_bytes = len(b'{"books":[') + len(b"]}")

    for name in source_order:
        rows = by_source[name]
        arrays = [_book_array(b) for b in rows]
        sizes = [_array_bytes(a) for a in arrays]
        source_bytes = sum(sizes)
        if source_bytes <= shard_bytes:
            # Whole source: pack it into the open shard if it fits,
            # else close the shard and start a new one with it.
            if current and current_bytes + source_bytes > shard_bytes:
                _flush()
            current.extend(rows)
            current_sources.append(name)
            current_bytes += source_bytes
        else:
            # One source alone exceeds the budget: split its books
            # across shards by bytes.
            for book, size in zip(rows, sizes):
                if current and current_bytes + size > shard_bytes:
                    _flush()
                if name not in current_sources:
                    current_sources.append(name)
                current.append(book)
                current_bytes += size
    _flush()

    manifest = {
        "generated_at": _now_iso(),
        "tool": f"telegram-book-index {__version__}",
        "totals": {
            "posts": totals["posts"],
            "files": totals["files"],
            "books": totals["books"],
            "sources": totals["sources"],
        },
        "sources": sources,
        "formats": formats,
        "books": totals["books"],
        "shards": [
            {
                "file": filename,
                "sources": srcs,
                "books": count,
            }
            for filename, _payload, srcs, count in shards
        ],
    }
    return manifest, [(filename, payload) for filename, payload, _s, _c in shards]


def _write_json_atomic(path: Path, data: dict) -> int:
    """Write ``data`` as compact JSON to ``path`` atomically; return bytes."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(
        json.dumps(data, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    tmp.replace(path)
    return path.stat().st_size


def export_static(
    db_path: str | Path,
    out_dir: str | Path,
    report_path: Optional[str | Path] = None,
) -> dict:
    """Generate the static site data into ``out_dir``.

    Writes ``index.json`` (manifest) plus ``index-<n>.json`` shards,
    and copies the report when present. Returns stats: ``{"books": N,
    "files": N, "posts": N, "sources": N, "shards": N, "shard_files":
    [...], "max_shard_bytes": N, "json_bytes": N (manifest),
    "report_copied": bool}``. Raises FileNotFoundError when the DB
    (or the explicit report) does not exist.
    """
    db_path = Path(db_path)
    if not db_path.is_file():
        raise FileNotFoundError(f"Index DB not found: {db_path}")
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    if report_path is None:
        candidate = db_path.parent / "index-report.md"
        report_path = candidate if candidate.is_file() else None
    else:
        report_path = Path(report_path)
        if not report_path.is_file():
            raise FileNotFoundError(f"Report not found: {report_path}")

    store = Store(db_path)
    try:
        manifest, shards = build_shards(store)
    finally:
        store.close()

    # Remove stale shards from an older, larger export before writing
    # the new ones (a smaller catalog has fewer shards).
    for stale in out_dir.glob("index-*.json"):
        stale.unlink()
    for stale in out_dir.glob("index-*.json.tmp"):
        stale.unlink()

    manifest_bytes = _write_json_atomic(out_dir / "index.json", manifest)
    shard_files = []
    max_shard_bytes = 0
    for filename, payload in shards:
        size = _write_json_atomic(out_dir / filename, payload)
        shard_files.append(filename)
        max_shard_bytes = max(max_shard_bytes, size)

    report_copied = False
    if report_path is not None:
        shutil.copyfile(report_path, out_dir / "index-report.md")
        report_copied = True

    return {
        "books": manifest["totals"]["books"],
        "files": manifest["totals"]["files"],
        "posts": manifest["totals"]["posts"],
        "sources": manifest["totals"]["sources"],
        "shards": len(shard_files),
        "shard_files": shard_files,
        "max_shard_bytes": max_shard_bytes,
        "json_bytes": manifest_bytes,
        "report_copied": report_copied,
    }
