#!/usr/bin/env python3
"""Drive OPDS + search-index generator for RliBook (WAVE 4, WS8).

Builds the static surfaces that make a Drive library visible WITHOUT
a Telegram shard or a D1 query:

* ``drive/search-index.json`` — the combined OPDS search
  (functions/opds/search.js) reads it as a sixth library
  (slug ``drive``, kind ``drive``): entries are
  ``{t: title, a: author, i: <Drive file id>, m: <mime>}`` — the
  same shape as the five static indexes, so the existing
  kind="drive" branch builds the ``uc?id=`` download link.
* ``drive/index.xml`` — OPDS navigation feed: one entry per Drive
  library (public ones only — see below), linking to its
  acquisition feed.
* ``drive/<folder_id>/index.xml`` — OPDS acquisition feed: one entry
  per book (title, author, file id, mime, updated date).

Input: the books JSON drive_index.py writes with --books-json
(``[{title, author, ext, size, date, file_id, url, folder_id,
library_title}]``), or a D1 batch SQL file parsed back via
drive_registry.parse_drive_books_sql (the Oriental Music backfill:
the batch is already imported; re-listing Drive would waste calls).

VISIBILITY: only ``public`` libraries are emitted. A private or
pending_public library's books NEVER appear in these static files —
they are visible only to the submitter through the D1-backed
/api/tg-search (fp-gated). The generator reads the registry
(drive-libraries.json, or --visibility overrides per folder) and
skips anything not public. Legacy registry entries without a
``visibility`` field count as public (same rule as the website).

Usage:
  python3 telegram/tbi/drive_opds.py --books d1-batches-drive/drive-1EFegWouzH4C-books.json \
      --registry drive-libraries.json --out drive
  python3 telegram/tbi/drive_opds.py --batch-sql d1-batches-drive/drive-1EFegWouzH4C.sql \
      --library-title "Oriental Music" --folder 1EFegWouzH4CXHzX2N-NfD18mJbtDLQAP \
      --visibility public --out drive
"""

from __future__ import annotations

import argparse
import html
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from drive_registry import load_registry, parse_drive_books_sql  # noqa: E402

MIME_BY_EXT = {
    "epub": "application/epub+zip",
    "pdf": "application/pdf",
    "mobi": "application/x-mobipocket-ebook",
    "azw3": "application/vnd.amazon.ebook",
    "kfx": "application/octet-stream",
    "txt": "text/plain",
    "doc": "application/msword",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "cbz": "application/x-cbz",
    "cbr": "application/x-cbr",
}

UPDATED = "2026-11-26T00:00:00Z"


def mime_for(ext: str) -> str:
    return MIME_BY_EXT.get((ext or "").lower(), "application/octet-stream")


def esc(s: str) -> str:
    return html.escape(s or "", quote=True)


def search_index_entries(books: list[dict]) -> list[dict]:
    """Books -> combined-search index rows [{t, a, i, m}]."""
    out = []
    for b in books:
        fid = b.get("file_id") or ""
        if not fid:
            continue
        out.append({
            "t": b.get("title", ""),
            "a": b.get("author", ""),
            "i": fid,
            "m": mime_for(b.get("ext", "")),
        })
    return out


def acquisition_feed(folder_id: str, title: str, books: list[dict]) -> str:
    """One OPDS acquisition feed for a single Drive library."""
    parts = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">',
        f"<title>{esc(title)}</title>",
        f"<id>urn:drive:library:{esc(folder_id)}</id>",
        f"<updated>{UPDATED}</updated>",
        f'<link rel="self" href="/drive/{esc(folder_id)}/index.xml" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>',
    ]
    for b in books:
        fid = b.get("file_id") or ""
        if not fid:
            continue
        date = (b.get("date") or "")[:10] or "2026-11-26"
        parts.append(
            f"<entry><title>{esc(b.get('title', ''))}</title>"
            f"<id>urn:drive:{esc(fid)}</id>"
            f"<updated>{esc(date)}T00:00:00Z</updated>"
            + (f"<author><name>{esc(b.get('author', ''))}</name></author>"
               if b.get("author") else "")
            + f'<link rel="http://opds-spec.org/acquisition" href="https://drive.google.com/uc?id={esc(fid)}&amp;export=download" type="{esc(mime_for(b.get("ext", "")))}"/>'
            f"</entry>"
        )
    parts.append("</feed>")
    return "".join(parts)


def navigation_feed(libraries: list[dict]) -> str:
    """OPDS navigation feed: one subsection entry per public library."""
    parts = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">',
        "<title>مكتبات Drive</title>",
        "<id>urn:static:libraries:drive</id>",
        f"<updated>{UPDATED}</updated>",
        '<link rel="self" href="/drive/index.xml" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>',
    ]
    for lib in libraries:
        parts.append(
            f"<entry><title>{esc(lib['title'])}</title>"
            f"<id>urn:static:libraries:drive:{esc(lib['folder_id'])}</id>"
            f"<updated>{UPDATED}</updated>"
            f'<link rel="subsection" href="/drive/{esc(lib["folder_id"])}/index.xml" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>'
            f"<content type=\"text\">{lib['count']} book</content></entry>"
        )
    parts.append("</feed>")
    return "".join(parts)


def registry_visibility(registry: dict, folder_id: str) -> str:
    for e in registry.get("libraries", []):
        if e.get("folder_id") == folder_id:
            return (e.get("visibility") or "public").strip().lower()
    return "public"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--books", default="",
                    help="books JSON (drive_index.py --books-json output)")
    ap.add_argument("--batch-sql", default="",
                    help="D1 batch SQL file to parse back (backfill path)")
    ap.add_argument("--folder", default="",
                    help="Drive folder id (required with --batch-sql)")
    ap.add_argument("--library-title", default="")
    ap.add_argument("--registry", default="drive-libraries.json")
    ap.add_argument("--visibility", default="",
                    choices=["", "public", "private", "pending_public"],
                    help="override the registry visibility for this library")
    ap.add_argument("--out", default="drive")
    args = ap.parse_args()

    if args.books:
        books = json.loads(Path(args.books).read_text(encoding="utf-8"))
        folder_id = books[0]["folder_id"] if books else args.folder
        title = (books[0].get("library_title") or args.library_title) if books else args.library_title
    elif args.batch_sql:
        if not args.folder:
            print("ERROR: --folder is required with --batch-sql", file=sys.stderr)
            return 2
        books = parse_drive_books_sql(Path(args.batch_sql))
        folder_id = args.folder
        title = args.library_title
    else:
        print("ERROR: pass --books or --batch-sql", file=sys.stderr)
        return 2
    if not books:
        print("ERROR: no books found", file=sys.stderr)
        return 2
    if not title:
        title = folder_id

    registry = load_registry(Path(args.registry)) if Path(args.registry).exists() else {"libraries": []}
    visibility = args.visibility or registry_visibility(registry, folder_id)
    out_dir = Path(args.out)
    if visibility != "public":
        print(f"SKIP: library {folder_id} is {visibility} — "
              "private/pending libraries never enter the static OPDS files.")
        return 0

    lib_dir = out_dir / folder_id
    lib_dir.mkdir(parents=True, exist_ok=True)
    index_rows = search_index_entries(books)
    (out_dir / "search-index.json").write_text(
        json.dumps(index_rows, ensure_ascii=False), encoding="utf-8")
    (lib_dir / "index.xml").write_text(
        acquisition_feed(folder_id, title, books), encoding="utf-8")
    nav_libs = [{
        "folder_id": folder_id, "title": title, "count": len(index_rows),
    }]
    # Keep other public libraries already in the navigation feed: the
    # feed is per-run for one library, so merge with an existing one.
    nav_path = out_dir / "index.xml"
    if nav_path.exists():
        import re as _re
        existing = nav_path.read_text(encoding="utf-8")
        for m in _re.finditer(
                r"<entry><title>(.*?)</title><id>urn:static:libraries:drive:(.*?)</id>.*?<content type=\"text\">(\d+) book</content></entry>",
                existing):
            if m.group(2) != folder_id:
                nav_libs.append({"folder_id": m.group(2), "title": html.unescape(m.group(1)),
                                 "count": int(m.group(3))})
    nav_libs.sort(key=lambda l: l["title"].lower())
    nav_path.write_text(navigation_feed(nav_libs), encoding="utf-8")
    print(f"Wrote {out_dir}/search-index.json ({len(index_rows)} books), "
          f"{lib_dir}/index.xml, {nav_path} ({len(nav_libs)} libraries)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
