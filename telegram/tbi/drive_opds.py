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

RETRACTION (WAVE 7): a public -> private flip must not leave the
library's static files live. ``--all`` therefore also deletes the
per-library feed of every folder that is no longer public
(``drive/<folder_id>/index.xml``) and regenerates the combined
files from the remaining public libraries — so a flipped library
vanishes from drive/search-index.json, drive/index.xml AND its own
feed in one run. When the registry still lists libraries but NONE
is public anymore, --all writes EMPTY combined surfaces (empty
search index + empty navigation feed) instead of erroring, so the
last public library's flip retracts too; only a registry with NO
entries at all still exits 2 (nothing trusted to retract from).
The single-library path retracts the same way (feed + nav entry +
that library's rows in the combined search index) instead of
merely skipping. The publish-surfaces job's ``git add drive/``
stages the deletions, so no workflow change is needed.

Usage:
  python3 telegram/tbi/drive_opds.py --books d1-batches-drive/drive-1EFegWouzH4C-books.json \
      --registry drive-libraries.json --out drive
  python3 telegram/tbi/drive_opds.py --batch-sql d1-batches-drive/drive-1EFegWouzH4C.sql \
      --library-title "Oriental Music" --folder 1EFegWouzH4CXHzX2N-NfD18mJbtDLQAP \
      --visibility public --out drive
  # Rebuild ALL public libraries at once (sweep + approve flow):
  python3 telegram/tbi/drive_opds.py --all --registry drive-libraries.json \
      --batch-dir d1-batches-drive --out drive --counts-out /tmp/drive-counts.json
"""

from __future__ import annotations

import argparse
import html
import json
import re
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


def public_libraries(registry: dict) -> list[dict]:
    """Registry entries that may enter the static surfaces (public + active)."""
    out = []
    for e in registry.get("libraries", []):
        if (e.get("visibility") or "public").strip().lower() != "public":
            continue
        if e.get("status", "active") != "active":
            continue
        out.append(e)
    return out


def load_library_books(folder_id: str, batch_dir: Path) -> list[dict] | None:
    """Books for one library from its committed artifacts.

    Prefers the books JSON drive_index.py writes; falls back to
    parsing the D1 batch SQL back (the Oriental Music backfill path).
    Returns None when neither artifact exists (caller warns + skips
    the library rather than failing the whole regeneration).
    """
    books_json = batch_dir / f"drive-{folder_id[:12]}-books.json"
    if books_json.exists():
        books = json.loads(books_json.read_text(encoding="utf-8"))
        for b in books:
            b.setdefault("folder_id", folder_id)
        return books
    batch_sql = batch_dir / f"drive-{folder_id[:12]}.sql"
    if batch_sql.exists():
        books = parse_drive_books_sql(batch_sql)
        for b in books:
            b["folder_id"] = folder_id
        return books
    return None


def write_all_public(out_dir: Path, libs: list[dict]) -> dict:
    """Write the full public surface set for the given libraries.

    ``libs`` is [{folder_id, title, books}] — public only. Writes the
    COMBINED search-index.json (every public book — the single-library
    path overwrites this file with one library, so a multi-library
    catalog must go through here), one acquisition feed per library,
    and the navigation feed listing all of them. Returns
    {folder_id: book count} for the libraries page.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    all_rows: list[dict] = []
    counts: dict[str, int] = {}
    nav_libs: list[dict] = []
    for lib in sorted(libs, key=lambda l: (l["title"] or l["folder_id"]).lower()):
        folder_id = lib["folder_id"]
        books = lib["books"]
        rows = search_index_entries(books)
        all_rows.extend(rows)
        counts[folder_id] = len(rows)
        lib_dir = out_dir / folder_id
        lib_dir.mkdir(parents=True, exist_ok=True)
        (lib_dir / "index.xml").write_text(
            acquisition_feed(folder_id, lib["title"], books), encoding="utf-8")
        nav_libs.append({"folder_id": folder_id, "title": lib["title"],
                         "count": len(rows)})
    (out_dir / "search-index.json").write_text(
        json.dumps(all_rows, ensure_ascii=False), encoding="utf-8")
    (out_dir / "index.xml").write_text(
        navigation_feed(nav_libs), encoding="utf-8")
    return counts


# Same shape as the bot's parseLibraryArg (see drive_sweep.py): a
# Drive folder id is 10-64 base64url characters. Only directories
# matching this are ever treated as per-library feeds by the
# retraction sweep below — anything else under the out dir is left
# alone.
FOLDER_RE = re.compile(r"^[A-Za-z0-9_-]{10,64}$")

# One navigation-feed entry, as written by navigation_feed().
NAV_ENTRY_RE = re.compile(
    r"<entry><title>(.*?)</title><id>urn:static:libraries:drive:(.*?)</id>"
    r".*?<content type=\"text\">(\d+) book</content></entry>")


def parse_nav_entries(text: str) -> list[dict]:
    """Navigation feed XML -> [{folder_id, title, count}]."""
    out = []
    for m in NAV_ENTRY_RE.finditer(text or ""):
        out.append({"folder_id": m.group(2),
                    "title": html.unescape(m.group(1)),
                    "count": int(m.group(3))})
    return out


def retract_library_feed(out_dir: Path, folder_id: str) -> bool:
    """Delete one library's per-library OPDS feed, if present.

    Returns True when a file was actually removed. The directory
    itself is removed too when it becomes empty. Never raises for a
    missing file — retraction is idempotent.
    """
    feed = out_dir / folder_id / "index.xml"
    if not feed.exists():
        return False
    feed.unlink()
    try:
        (out_dir / folder_id).rmdir()  # only when now empty
    except OSError:
        pass
    return True


def retract_orphan_feeds(out_dir: Path, keep_folder_ids: set) -> list[str]:
    """Delete per-library feeds whose folder is not public anymore.

    ``keep_folder_ids`` is the set of folders that stay public.
    Only subdirectories whose name looks like a Drive folder id are
    considered; anything else under the out dir is left alone.
    Returns the folder ids whose feed was removed.
    """
    removed = []
    if not out_dir.is_dir():
        return removed
    for child in sorted(out_dir.iterdir()):
        if not child.is_dir():
            continue
        if not FOLDER_RE.match(child.name):
            continue
        if child.name in keep_folder_ids:
            continue
        if retract_library_feed(out_dir, child.name):
            removed.append(child.name)
    return removed


def retract_from_combined(out_dir: Path, folder_id: str,
                          file_ids: set) -> None:
    """Drop one library from the combined static files.

    Removes its entry from drive/index.xml (navigation feed) and its
    books (by file id) from drive/search-index.json. Files that do
    not exist are left alone — a fresh out dir retracts to nothing,
    which is the single-library SKIP case. NOTE: a file id shared by
    two libraries (the same Drive file in two folders) is removed
    from the combined index for both; the next --all rebuild restores
    the surviving library's row.
    """
    nav_path = out_dir / "index.xml"
    if nav_path.exists():
        kept = [e for e in parse_nav_entries(nav_path.read_text(encoding="utf-8"))
                if e["folder_id"] != folder_id]
        nav_path.write_text(navigation_feed(kept), encoding="utf-8")
    index_path = out_dir / "search-index.json"
    if index_path.exists() and file_ids:
        try:
            rows = json.loads(index_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return
        kept_rows = [r for r in rows if r.get("i") not in file_ids]
        if len(kept_rows) != len(rows):
            index_path.write_text(
                json.dumps(kept_rows, ensure_ascii=False), encoding="utf-8")


def retract_library(out_dir: Path, folder_id: str, file_ids: set) -> bool:
    """Full retraction for one flipped library: feed + combined files.

    Returns True when anything was actually removed.
    """
    removed_feed = retract_library_feed(out_dir, folder_id)
    before_nav = before_index = None
    nav_path = out_dir / "index.xml"
    index_path = out_dir / "search-index.json"
    if nav_path.exists():
        before_nav = nav_path.read_text(encoding="utf-8")
    if index_path.exists():
        before_index = index_path.read_text(encoding="utf-8")
    retract_from_combined(out_dir, folder_id, file_ids)
    changed = removed_feed
    if before_nav is not None and nav_path.exists():
        changed = changed or nav_path.read_text(encoding="utf-8") != before_nav
    if before_index is not None and index_path.exists():
        changed = changed or index_path.read_text(encoding="utf-8") != before_index
    return changed


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
    # --all (Drive sweep / approve flow, Build 2): rebuild EVERY
    # public library's surfaces at once from the committed artifacts
    # in --batch-dir, instead of one library's. A single-library run
    # overwrites drive/search-index.json with that library alone, so
    # it silently drops every other public library from the combined
    # search index — --all is the only correct multi-library path.
    ap.add_argument("--all", action="store_true",
                    help="rebuild all PUBLIC libraries' surfaces from "
                         "--batch-dir (books JSONs, else batch SQL)")
    ap.add_argument("--batch-dir", default="d1-batches-drive",
                    help="dir holding drive-<folder12>-books.json / .sql "
                         "(with --all)")
    ap.add_argument("--counts-out", default="",
                    help="also write {folder_id: book count} JSON here "
                         "(for generate-libraries.py --drive-counts)")
    args = ap.parse_args()

    if args.all:
        registry = load_registry(Path(args.registry)) if Path(args.registry).exists() else {"libraries": []}
        registry_entries = registry.get("libraries", [])
        public_ids = {str(e.get("folder_id") or "")
                      for e in public_libraries(registry)}
        out_dir = Path(args.out)
        # Retraction (WAVE 7): delete the per-library feed of every
        # folder that is no longer public — a public -> private flip
        # must not leave drive/<folder>/index.xml live. Only when
        # the registry is real (has entries): an empty/missing
        # registry must never nuke the live feeds. The keep set is
        # ALL public folders, not just the ones with books — a public
        # library whose artifacts are missing keeps its old feed.
        retracted = []
        if registry_entries:
            retracted = retract_orphan_feeds(out_dir, public_ids)
            for fid in retracted:
                print(f"RETRACTED: removed stale feed drive/{fid}/index.xml "
                      "(no longer public)")
        libs = []
        for entry in public_libraries(registry):
            folder_id = entry.get("folder_id") or ""
            books = load_library_books(folder_id, Path(args.batch_dir))
            if books is None:
                print(f"WARNING: no books JSON or batch SQL for public library "
                      f"{folder_id} in {args.batch_dir} — skipping it.",
                      file=sys.stderr)
                continue
            title = entry.get("title") or (books[0].get("library_title") if books else "") or folder_id
            for b in books:
                b.setdefault("library_title", title)
            libs.append({"folder_id": folder_id, "title": title, "books": books})
        if not libs:
            if public_ids:
                # Public libraries exist but none yielded books
                # (missing artifacts): unchanged behaviour — nothing
                # written; the retraction above already landed.
                print("ERROR: no public library with books found — nothing written.",
                      file=sys.stderr)
                return 2
            if not registry_entries:
                print("ERROR: no public library with books found — nothing written.",
                      file=sys.stderr)
                return 2
            # The registry lists libraries but NONE is public anymore
            # (e.g. the last public library flipped private): write
            # EMPTY combined surfaces so the flip retracts instead of
            # leaving the previous files live.
            counts = write_all_public(out_dir, [])
            if args.counts_out:
                Path(args.counts_out).write_text(
                    json.dumps(counts, ensure_ascii=False, indent=1), encoding="utf-8")
                print(f"Wrote {args.counts_out} (0 libraries)")
            print(f"Retracted {len(retracted)} stale feed(s); wrote empty "
                  f"{args.out}/search-index.json + {args.out}/index.xml "
                  "(no public libraries)")
            return 0
        counts = write_all_public(out_dir, libs)
        if args.counts_out:
            Path(args.counts_out).write_text(
                json.dumps(counts, ensure_ascii=False, indent=1), encoding="utf-8")
            print(f"Wrote {args.counts_out} ({len(counts)} libraries)")
        total = sum(counts.values())
        print(f"Wrote {args.out}/search-index.json ({total} books, "
              f"{len(libs)} libraries), feeds + {args.out}/index.xml")
        return 0

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
        # Retraction (WAVE 7): a private/pending library never enters
        # the static files — and a library that WAS public must have
        # its live files removed, not merely skipped. The feed, the
        # navigation entry and its rows in the combined search index
        # all go; a fresh out dir retracts to nothing (no writes).
        file_ids = {b.get("file_id") for b in books if b.get("file_id")}
        changed = retract_library(out_dir, folder_id, file_ids)
        print(f"RETRACTED: library {folder_id} is {visibility} — "
              "removed its static OPDS files"
              + (" (feed + combined entries)" if changed else " (nothing was live)")
              + "; private/pending libraries never enter the static OPDS files.")
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
        existing = nav_path.read_text(encoding="utf-8")
        for e in parse_nav_entries(existing):
            if e["folder_id"] != folder_id:
                nav_libs.append(e)
    nav_libs.sort(key=lambda l: l["title"].lower())
    nav_path.write_text(navigation_feed(nav_libs), encoding="utf-8")
    print(f"Wrote {out_dir}/search-index.json ({len(index_rows)} books), "
          f"{lib_dir}/index.xml, {nav_path} ({len(nav_libs)} libraries)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
