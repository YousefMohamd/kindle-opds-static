"""Static-site export: turn the SQLite index into the files Cloudflare
Pages serves.

``tbi export-static`` reads the DB (read-only in effect — it never
writes to it) and writes, into the output directory:

* ``index.json`` — a small MANIFEST (totals, per-source totals, the
  list of formats, and the list of shard files). The search page loads
  this file first; it is tiny.
* ``index-<n>.json`` — SHARD files, one JSON object per file of the
  form ``{"books": [[title, author, filename, ext, size, source,
  sources, date, handle, post], ...]}`` (compact arrays, positional
  fields — the post URL is NOT stored, only handle + post id).
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

Flag filtering (v4.8.65): with ``--flags-json`` pointing at a
``flags:all`` blob (``{"flagged": ["handle:post", ...], "hidden":
[...] }``, the same shape the bot keeps in KV), books whose post
key appears in either list are EXCLUDED from the manifest and the
shards — the static search page links straight to the Telegram
post, so a flagged/hidden book listed there would be one tap away
from a download that bypasses every delivery gate. Flagged books
stay visible (with 🚩, no delivery) on the website search and in
the bot — the static page is a derived snapshot, not the canonical
surface, so dropping a row here deletes nothing. The manifest
reports the drop in ``filtered`` (``{"flagged": n, "hidden": m}``)
and ``totals.books`` is the FILTERED count, matching the list the
page actually searches. Without ``--flags-json`` the export is
unchanged (no filtering). Books whose post URL does not parse to
a public t.me post cannot be matched to a flag key and are kept —
the live delivery gates still protect them.

The search page itself (``site/telegram/index.html``) is a
hand-written static file in the repo, not generated — this module
only regenerates the data it loads. Writes are atomic (temp file +
rename) so a failed export never leaves a half-written file behind.
"""

from __future__ import annotations

import json
import re
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
# Workstream H: the raw post URL is no longer stored — only the
# channel handle + post id, so no shard (and no page that reads one)
# can link straight to a Telegram post. The search page understands
# both shapes until the next daily sync regenerates the shards.
BOOK_FIELDS = (
    "title",
    "author",
    "filename",
    "ext",
    "size",
    "source",
    "sources",
    "date",
    "handle",
    "post",
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# Public Telegram post URL -> (handle, post id). Private-group
# posts (t.me/c/<id>/<post>) and anything unparseable yield
# ("", "") — the search page falls back to /book?q=<title> for
# those instead of linking anywhere.
_POST_RE = re.compile(r"^https?://t\.me/([^/]+)/(\d+)/?$")


def _post_handle_post(obtain_url: str) -> tuple:
    m = _POST_RE.match(obtain_url or "")
    return (m.group(1), m.group(2)) if m else ("", "")


def _normalize_flag_keys(blob: dict) -> tuple:
    """A ``flags:all`` blob -> (flagged keys, hidden keys).

    Each key is ``"handle:post"`` with the handle lowercased:
    Telegram handles are lowercase in practice, but the bot never
    lowercases them at write time, so both sides normalize and a
    mixed-case handle in the blob still matches. Blank entries are
    ignored. A non-dict blob (or missing lists) yields empty sets
    rather than raising — the caller decides whether that is an
    error (load_flags_file raises on a malformed file instead).
    """
    def keys(names):
        out = set()
        for raw in names or []:
            s = str(raw).strip().lower()
            if s:
                out.add(s)
        return out
    if not isinstance(blob, dict):
        return set(), set()
    return keys(blob.get("flagged")), keys(blob.get("hidden"))


def load_flags_file(path: str | Path) -> tuple:
    """Load a ``flags:all`` blob from ``path`` (JSON).

    Returns (flagged keys, hidden keys) via _normalize_flag_keys.
    Raises FileNotFoundError when the file is missing and ValueError
    when it is not valid JSON or not a JSON object — a broken flags
    file must fail the export loudly, never silently export the
    catalog unfiltered.
    """
    path = Path(path)
    if not path.is_file():
        raise FileNotFoundError(f"Flags file not found: {path}")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"Flags file is not valid JSON: {path}: {exc}") from exc
    if not isinstance(data, dict):
        raise ValueError(f"Flags file is not a JSON object: {path}")
    return _normalize_flag_keys(data)


def _flag_key(handle: str, post: str) -> str:
    """The flag key for one book row ("" when the post URL did not
    parse to a public t.me post — such rows can never match)."""
    if not handle or not post:
        return ""
    return f"{handle.lower()}:{post}"


def _book_rows(store: Store, flags=None) -> tuple:
    """One dict per distinct book (newest file's data), newest first.

    Returns (rows, filtered) where ``filtered`` counts the rows
    dropped by the flag filter: ``{"flagged": n, "hidden": m}``.
    With ``flags`` None (the default) nothing is filtered and the
    counts are zero. ``flags`` is the (flagged, hidden) key pair
    from load_flags_file; a row is dropped when its post key is in
    either set (flagged first, so a book in both counts once, as
    flagged).
    """
    flagged, hidden = flags if flags is not None else (set(), set())
    rows = []
    filtered = {"flagged": 0, "hidden": 0}
    for b in store.list_books():
        handle, post = _post_handle_post(b["obtain_url"] or "")
        key = _flag_key(handle, post)
        if key and key in flagged:
            filtered["flagged"] += 1
            continue
        if key and key in hidden:
            filtered["hidden"] += 1
            continue
        rows.append({
            "title": b["title"] or b["filename"],
            "author": b["author"] or "",
            "filename": b["filename"],
            "ext": b["ext"] or "",
            "size": b["size_text"] or "",
            "source": b["source_name"],
            "sources": b["source_count"],
            "date": (b["date"] or "")[:10],
            "handle": handle,
            "post": post,
        })
    return rows, filtered


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


def build_index_json(store: Store, flags=None) -> dict:
    """The full index as one dict (distinct books + sources).

    Kept for small DBs and for tests that check deduping. The
    deployed site no longer writes this as a single file (see
    ``build_shards``) because at 197k books it is 53 MiB, over
    Cloudflare Pages' 25 MiB per-file limit. ``flags`` (see
    _book_rows) drops flagged/hidden books; ``totals.books`` is
    the filtered count and ``filtered`` reports the drop.
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
    books, filtered = _book_rows(store, flags)
    return {
        "generated_at": _now_iso(),
        "tool": f"telegram-book-index {__version__}",
        "totals": {
            "posts": totals["posts"],
            "files": totals["files"],
            "books": totals["books"] - filtered["flagged"] - filtered["hidden"],
            "sources": totals["sources"],
        },
        "sources": sources,
        "filtered": filtered,
        "books": books,
    }


def build_shards(store: Store, flags=None, shard_bytes: int = SHARD_BYTES) -> tuple:
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
    books, filtered = _book_rows(store, flags)
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
            "books": totals["books"] - filtered["flagged"] - filtered["hidden"],
            "sources": totals["sources"],
        },
        "sources": sources,
        "formats": formats,
        "books": totals["books"] - filtered["flagged"] - filtered["hidden"],
        "filtered": filtered,
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
    flags_path: Optional[str | Path] = None,
) -> dict:
    """Generate the static site data into ``out_dir``.

    Writes ``index.json`` (manifest) plus ``index-<n>.json`` shards,
    and copies the report when present. ``flags_path`` (a
    ``flags:all`` JSON blob, see load_flags_file) excludes
    flagged/hidden books from the manifest and shards. Returns
    stats: ``{"books": N, "files": N, "posts": N, "sources": N,
    "shards": N, "shard_files": [...], "max_shard_bytes": N,
    "json_bytes": N (manifest), "filtered_flagged": N,
    "filtered_hidden": N, "report_copied": bool}`` — ``books`` is
    the FILTERED count. Raises FileNotFoundError when the DB (or
    the explicit report, or the flags file) does not exist, and
    ValueError when the flags file is malformed.
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
    flags = load_flags_file(flags_path) if flags_path else None

    store = Store(db_path)
    try:
        manifest, shards = build_shards(store, flags)
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
        "filtered_flagged": manifest["filtered"]["flagged"],
        "filtered_hidden": manifest["filtered"]["hidden"],
        "report_copied": report_copied,
    }
