"""Static-site export: turn the SQLite index into the files Cloudflare
Pages serves.

``tbi export-static`` reads the DB (read-only in effect — it never
writes to it) and writes, into the output directory:

* ``index.json`` — one entry per distinct book (title, author,
  filename, format, size, source, date, post link) plus per-source
  totals. The search page loads this file and searches client-side;
  there is no server.
* ``index-report.md`` — a copy of the latest run report, when one
  exists next to the DB (or at ``--report``).

The search page itself (``site/index.html``) is a hand-written static
file in the repo, not generated — this module only regenerates the
data it loads. Writes are atomic (temp file + rename) so a failed
export never leaves a half-written ``index.json`` behind.
"""

from __future__ import annotations

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from . import __version__
from .store import Store


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def build_index_json(store: Store) -> dict:
    """The JSON the search page loads: distinct books + sources."""
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
    books = [
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
        "books": books,
    }


def export_static(
    db_path: str | Path,
    out_dir: str | Path,
    report_path: Optional[str | Path] = None,
) -> dict:
    """Generate the static site data into ``out_dir``.

    Returns stats: ``{"books": N, "files": N, "posts": N, "sources": N,
    "json_path": ..., "json_bytes": N, "report_copied": bool}``.
    Raises FileNotFoundError when the DB (or the explicit report)
    does not exist.
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
        data = build_index_json(store)
    finally:
        store.close()

    json_path = out_dir / "index.json"
    tmp = json_path.with_suffix(".json.tmp")
    tmp.write_text(
        json.dumps(data, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    tmp.replace(json_path)

    report_copied = False
    if report_path is not None:
        shutil.copyfile(report_path, out_dir / "index-report.md")
        report_copied = True

    return {
        "books": len(data["books"]),
        "files": data["totals"]["files"],
        "posts": data["totals"]["posts"],
        "sources": data["totals"]["sources"],
        "json_path": str(json_path),
        "json_bytes": json_path.stat().st_size,
        "report_copied": report_copied,
    }
