"""Static search index: a D1-free search index for the website.

``tbi build-search-index`` reads the seed SQLite DB (the same source
``tbi export-static`` reads — NEVER D1) and writes, into the output
directory (``site/telegram/search/`` when wired into the static
rebuild), two file sets plus a manifest:

* ``rec/<letter>.json`` — RECORD shards: one JSON object per file of
  the form ``{"books": [[title, author, filename, ext, size, source,
  handle, post, date], ...]}`` (compact positional arrays, the same
  shape as the export-static shards minus the fields the search API
  never returns). Books are grouped by the first letter of the
  NORMALIZED title (leading "ال" stripped, same rule as the query
  ``stripAl``), newest-first inside each letter. Every shard stays
  well under Cloudflare Pages' 25 MiB per-file limit (largest
  measured: 8.8 MiB for 408,541 books).
* ``idx/<letter>.json`` — WORD shards: one JSON object per file of
  the form ``{word: [ptr, ptr, ...]}`` where each word is a
  normalized, "ال"-stripped, len>=2 word from a book's title, author
  or filename, and each pointer is a single integer
  ``letter_index * 1_000_000 + row`` (row = the book's index inside
  its ``rec/<letter>.json`` file; the manifest's ``letters`` array
  defines the letter order, so the reader decodes a pointer without
  any other lookup). Postings are sorted ascending. Largest measured:
  4.4 MiB for 408,541 books (394,058 words, 2,503,365 postings).
* ``manifest.json`` — ``{generated_at, tool, totals{books, sources,
  filtered}, letters, rec_files, idx_files, max_rec_bytes,
  max_idx_bytes, total_bytes}``. ``totals.books`` is the FILTERED
  count (flagged/hidden excluded, same as export-static).

Why two tiers (measured 2026-11-27 on the live local shards, see
``tools/measure*.py``): a record-only index sharded by title letter
cannot answer "all words anywhere in the title" — a title whose
first word is not a query word lives in a different letter shard
(e.g. title "كتاب بيت الحرير", query "بيت الحرير"). The word tier
closes that gap: the reader intersects postings for the query words
(exact tier, same AND as the D1 ladder) and resolves only the
matching pointers. Measured totals for 408,541 books: rec 69.8 MiB
(+ date field: ~74 MiB), idx 37.8 MiB — ~108 MiB deployed, every
file < 9 MiB. The brief's "~15-30MB" estimate only fits a
title-only index (31.0 MiB measured) that cannot render results
(no author/ext/size) or filter by format — so the honest size is
the two-tier total; Pages has no total-size cap, only the 25 MiB
per-file cap, which every file satisfies with room.

Flag filtering: identical to export-static — with ``--flags-json``
pointing at a ``flags:all`` blob, books whose post key appears in
either list are EXCLUDED from the manifest, the rec shards AND the
word shards (a flagged word must not resolve to a flagged book).
Without it, no filtering (same default as export-static).

Coverage honesty: the seed DB lags D1 (groups never enter the seed;
realtime additions and Drive books live in D1 only). The static
index therefore covers the seed snapshot (~408k of ~427k books at
build time); the manifest's ``generated_at`` + ``totals.books`` say
exactly what it covers, and the reader marks its replies
``coverage.static`` so the website never claims full coverage.
"Newest" and mint stay on D1 by design (see DESIGN.md).
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from . import __version__
from .books import normalize_arabic
from .export_static import _flag_key, _post_handle_post, load_flags_file
from .store import Store

# One pointer per (letter, row): row < 1_000_000 always (largest
# measured letter holds 47,544 books), letter index < 64.
POINTER_ROW_MOD = 1_000_000

# Positional fields of a book entry in a rec shard. The search API
# (functions/api/tg-search.js toResult) returns title, author, ext,
# size, source (flagged only — static rows are never flagged),
# kind (always "channel" for seed rows), formats (from ext), and the
# gated links (built from handle+post). date is kept so the reader
# can rank newest-first globally; filename is kept because the
# static page's haystack (and the word tier) matches on it.
REC_FIELDS = (
    "title",
    "author",
    "filename",
    "ext",
    "size",
    "source",
    "handle",
    "post",
    "date",
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalize_query(text: str) -> str:
    """Mirror of JS normalizeQuery (functions/api/tg-search.js):
    Arabic-normalized, lowercased, single spaces. Must stay
    identical to tbi.books.normalize_arabic + the JS side."""
    return _collapse_ws(normalize_arabic(text or "").lower())


def _collapse_ws(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def strip_al(word: str) -> str:
    """Mirror of JS stripAl: strip a leading "ال" only when >=3 chars
    remain, so "كاتب" matches "الكاتب" while "الله" is left alone."""
    if word.startswith("ال") and len(word) >= 5:
        return word[2:]
    return word


def query_words(text: str) -> list:
    """Mirror of JS queryWords: normalized, "ال"-stripped, len >= 2.
    Space-split only — this is the QUERY side (what the endpoint
    passes to the reader). The INDEX side uses index_words below,
    which tokenizes like FTS5 unicode61 (see there)."""
    return [
        strip_al(w)
        for w in _collapse_ws(normalize_query(text)).split(" ")
        if len(strip_al(w)) >= 2
    ]


# Alphanumeric runs, FTS5 unicode61-style: Latin + digits (Western
# and Eastern Arabic-Indic) + the Arabic blocks. Used to split
# haystack text AND query words into index words — a hyphenated
# filename ("python-for-beginners.epub") indexes as
# python/for/beginners/epub, exactly as the D1 FTS tokenizes it.
# Must stay identical to the reader's splitWord character class.
_WORD_RE = re.compile(
    r"[0-9a-z\u0600-\u06ff\u0660-\u0669\u06f0-\u06f9"
    r"\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff]+"
)


def index_words(text: str) -> list:
    """Words of a haystack field (title/author/filename) for the
    word tier: normalized, split on non-alphanumeric runs (like
    FTS5 unicode61), "ال"-stripped, len >= 2, deduped per call site.
    NOTE: this is a SUPERSET of the D1 FTS text (which indexes
    title+author only) — the static page's haystack also matches on
    filenames, so the static index does too."""
    return [
        strip_al(w)
        for w in _WORD_RE.findall(normalize_query(text))
        if len(strip_al(w)) >= 2
    ]


def first_letter(title: str) -> str:
    """Shard key: first letter of the normalized title, leading "ال"
    stripped (same rule as stripAl), leading punctuation skipped.
    Latin -> lowercase letter, digits -> "0-9", other -> "#"."""
    t = normalize_query(title).strip()
    t = t.lstrip(" \"'‘’“”()[]{}<>«»-–—:;،؟!.")
    if not t:
        return "#"
    if t.startswith("ال") and len(t) >= 5:
        t = t[2:]
    if not t:
        return "#"
    c = t[0]
    if "a" <= c <= "z":
        return c
    if c.isdigit():
        return "0-9"
    if (
        "\u0600" <= c <= "\u06ff"
        or "\u0750" <= c <= "\u077f"
        or "\u08a0" <= c <= "\u08ff"
        or "\ufb50" <= c <= "\ufdff"
        or "\ufe70" <= c <= "\ufeff"
    ):
        return c
    return "#"


def word_letter(word: str) -> str:
    """IDX shard key: first character of an already-normalized word
    (query_words output), same classes as first_letter."""
    if not word:
        return "#"
    c = word[0]
    if "a" <= c <= "z":
        return c
    if c.isdigit():
        return "0-9"
    if (
        "\u0600" <= c <= "\u06ff"
        or "\u0750" <= c <= "\u077f"
        or "\u08a0" <= c <= "\u08ff"
        or "\ufb50" <= c <= "\ufdff"
        or "\ufe70" <= c <= "\ufeff"
    ):
        return c
    return "#"


def _book_rows(store: Store, flags=None) -> tuple:
    """One slim record per distinct book (newest file's data),
    newest-first — the same rows export_static writes, minus the
    fields the search API never returns (``sources`` count), plus
    the flag filter (identical to export_static._book_rows).

    Returns (rows, filtered) where rows are dicts keyed by
    REC_FIELDS and filtered counts the dropped rows:
    ``{"flagged": n, "hidden": m}``.
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
            "handle": handle,
            "post": post,
            "date": (b["date"] or "")[:10],
        })
    return rows, filtered


def _record_array(book: dict) -> list:
    return [book[f] for f in REC_FIELDS]


def build_search_index(store: Store, flags=None) -> dict:
    """Build the whole index in memory.

    Returns a dict with keys: ``manifest`` (the manifest.json
    content), ``rec`` (``{letter: {"books": [[...], ...]}}``) and
    ``idx`` (``{letter: {word: [ptr, ...]}}``). Deterministic: the
    same DB always yields byte-identical files.
    """
    totals = store.counts()
    rows, filtered = _book_rows(store, flags)

    # Group records by title first letter, preserving the store's
    # newest-first order inside each letter.
    letters = sorted({first_letter(r["title"]) for r in rows})
    letter_index = {letter: i for i, letter in enumerate(letters)}
    rec: dict = {letter: [] for letter in letters}
    for row in rows:
        rec[first_letter(row["title"])].append(_record_array(row))

    # Word tier: word -> sorted list of pointers. A book's words
    # come from its title + author + filename (same haystack as the
    # static search page), tokenized unicode61-style (see
    # index_words); each word contributes once per book.
    idx: dict = {}
    for letter in letters:
        for row_pos, record in enumerate(rec[letter]):
            title, author, filename = record[0], record[1], record[2]
            ptr = letter_index[letter] * POINTER_ROW_MOD + row_pos
            seen = set()
            for w in (
                index_words(title) + index_words(author) + index_words(filename)
            ):
                if w in seen:
                    continue
                seen.add(w)
                bucket = word_letter(w)
                idx.setdefault(bucket, {}).setdefault(w, []).append(ptr)
    for bucket in idx:
        for word in idx[bucket]:
            idx[bucket][word].sort()

    manifest = {
        "generated_at": _now_iso(),
        "tool": f"telegram-book-index {__version__}",
        "totals": {
            "books": totals["books"] - filtered["flagged"] - filtered["hidden"],
            "sources": totals["sources"],
        },
        "filtered": filtered,
        "letters": letters,
        # Newest rec date per letter, parallel to `letters`. The
        # reader fetches matched letters in this order (newest
        # first), so if its MAX_REC_FILES cap ever binds, the kept
        # books are the newest letters' — not an alphabetical bias.
        "letters_newest": [
            rec[letter][0][8] if rec[letter] else "" for letter in letters
        ],
        "rec_files": [
            {"file": f"rec/{letter}.json", "letter": letter, "books": len(rec[letter])}
            for letter in letters
        ],
        "idx_files": [
            {"file": f"idx/{letter}.json", "letter": letter, "words": len(idx.get(letter, {}))}
            for letter in sorted(idx)
        ],
    }
    return {"manifest": manifest, "rec": rec, "idx": idx}


def _write_json_atomic(path: Path, data: dict) -> int:
    """Write ``data`` as compact JSON to ``path`` atomically; return bytes."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(
        json.dumps(data, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    tmp.replace(path)
    return path.stat().st_size


def build_search_index_files(
    db_path: str | Path,
    out_dir: str | Path,
    flags_path: Optional[str | Path] = None,
) -> dict:
    """Generate the static search index into ``out_dir``.

    Writes ``manifest.json`` plus ``rec/<letter>.json`` and
    ``idx/<letter>.json``. ``flags_path`` (a ``flags:all`` JSON blob,
    see export_static.load_flags_file) excludes flagged/hidden books
    from the manifest, the rec shards AND the word shards. Returns
    stats: ``{"books", "sources", "rec_files", "idx_files",
    "max_rec_bytes", "max_idx_bytes", "total_bytes",
    "filtered_flagged", "filtered_hidden"}``. Raises FileNotFoundError
    when the DB (or the flags file) does not exist, and ValueError
    when the flags file is malformed.
    """
    db_path = Path(db_path)
    if not db_path.is_file():
        raise FileNotFoundError(f"Index DB not found: {db_path}")
    out_dir = Path(out_dir)
    (out_dir / "rec").mkdir(parents=True, exist_ok=True)
    (out_dir / "idx").mkdir(parents=True, exist_ok=True)
    flags = load_flags_file(flags_path) if flags_path else None

    store = Store(db_path)
    try:
        built = build_search_index(store, flags)
    finally:
        store.close()

    manifest = built["manifest"]
    # Remove stale shards from an older, larger build before writing
    # the new ones (a smaller catalog has fewer letter files).
    for stale in out_dir.glob("rec/*.json"):
        stale.unlink()
    for stale in out_dir.glob("idx/*.json"):
        stale.unlink()
    for stale in out_dir.glob("rec/*.json.tmp"):
        stale.unlink()
    for stale in out_dir.glob("idx/*.json.tmp"):
        stale.unlink()

    max_rec = 0
    for letter, payload in built["rec"].items():
        size = _write_json_atomic(out_dir / "rec" / f"{letter}.json", {"books": payload})
        max_rec = max(max_rec, size)
    max_idx = 0
    for letter, payload in built["idx"].items():
        size = _write_json_atomic(out_dir / "idx" / f"{letter}.json", payload)
        max_idx = max(max_idx, size)
    manifest_bytes = _write_json_atomic(out_dir / "manifest.json", manifest)
    total = manifest_bytes + sum(
        (out_dir / "rec" / f"{letter}.json").stat().st_size for letter in built["rec"]
    ) + sum(
        (out_dir / "idx" / f"{letter}.json").stat().st_size for letter in built["idx"]
    )
    return {
        "books": manifest["totals"]["books"],
        "sources": manifest["totals"]["sources"],
        "rec_files": len(built["rec"]),
        "idx_files": len(built["idx"]),
        "max_rec_bytes": max_rec,
        "max_idx_bytes": max_idx,
        "total_bytes": total,
        "filtered_flagged": manifest["filtered"]["flagged"],
        "filtered_hidden": manifest["filtered"]["hidden"],
    }


def cmd_build_search_index(args) -> int:
    """``tbi build-search-index`` — CLI wrapper (see cli.py wiring
    in builder/cli.patch)."""
    import sys

    try:
        stats = build_search_index_files(
            args.db, args.out, getattr(args, "flags_json", None)
        )
    except FileNotFoundError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2
    print(
        f"Search index: {stats['books']} books "
        f"({stats['rec_files']} rec shards, {stats['idx_files']} idx shards, "
        f"{stats['total_bytes']} bytes total, "
        f"largest rec {stats['max_rec_bytes']} bytes, "
        f"largest idx {stats['max_idx_bytes']} bytes)"
    )
    if stats["filtered_flagged"] or stats["filtered_hidden"]:
        print(
            f"  flag filter: excluded {stats['filtered_flagged']} flagged, "
            f"{stats['filtered_hidden']} hidden"
        )
    return 0
