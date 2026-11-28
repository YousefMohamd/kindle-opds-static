"""Tests for tbi.build_search_index — the static search index (offline).

Repo destination: telegram/tests/test_build_search_index.py. The fixture
is tests/fixtures/search-index-books.json (37 rows) +
search-index-flags.json (1 flagged, 1 hidden). Expected index:
37 rows - 2 dedupe collapses - 1 flagged - 1 hidden = 33 books.
"""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tbi.books import normalize_arabic  # noqa: E402
from tbi.build_search_index import (  # noqa: E402
    POINTER_ROW_MOD,
    build_search_index,
    build_search_index_files,
    first_letter,
    index_words,
    query_words,
)
from tbi.store import Store  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures"


def _seed_db(tmp_path, fixture="search-index-books.json"):
    db = tmp_path / "index.db"
    store = Store(db)
    rows = json.loads((FIXTURES / fixture).read_text(encoding="utf-8"))["books"]
    sources = {}
    for row in rows:
        if row["source"] not in sources:
            sources[row["source"]] = store.upsert_source(row["kind"], row["source"])
        sid = sources[row["source"]]
        pid = store.upsert_post(
            sid, row["post_id"], row["date"], row["text"], row["url"]
        )
        store.replace_files_for_post(pid, [{
            "filename": row["filename"],
            "ext": row["ext"],
            "size_text": row["size_text"],
            "size_bytes": row["size_bytes"],
            "title": row["title"],
            "author": row["author"],
            "dedupe_key": row["dedupe_key"],
            "obtain_url": row["obtain_url"],
        }])
    store.commit()
    return store


def _all_rec_books(built):
    out = []
    for letter in built["manifest"]["letters"]:
        out.extend(built["rec"][letter])
    return out


def test_build_counts_and_flag_filter(tmp_path):
    store = _seed_db(tmp_path)
    try:
        built = build_search_index(store, flags=None)
        # No flags file: 37 rows - 2 dedupe collapses = 35 books.
        assert built["manifest"]["totals"]["books"] == 35
        assert built["manifest"]["filtered"] == {"flagged": 0, "hidden": 0}
        assert built["manifest"]["totals"]["sources"] == 3
        assert sum(len(v) for v in built["rec"].values()) == 35
    finally:
        store.close()

    flags_path = FIXTURES / "search-index-flags.json"
    from tbi.export_static import load_flags_file

    store = _seed_db(tmp_path)
    try:
        built = build_search_index(store, flags=load_flags_file(flags_path))
        # 35 - 1 flagged - 1 hidden = 33 books.
        assert built["manifest"]["totals"]["books"] == 33
        assert built["manifest"]["filtered"] == {"flagged": 1, "hidden": 1}
        titles = [b[0] for b in _all_rec_books(built)]
        assert "كتاب محظور" not in titles
        assert "كتاب مخفي" not in titles
    finally:
        store.close()


def test_dedup_newest_wins(tmp_path):
    store = _seed_db(tmp_path)
    try:
        built = build_search_index(store)
        rows = [b for b in _all_rec_books(built) if b[0] == "الكتاب الكبير"]
        assert len(rows) == 1
        # chanB's copy (2026-11-25) is newer than chanA's (2026-11-20).
        assert rows[0][6] == "chanB"  # handle
        assert rows[0][7] == "50"     # post
        assert rows[0][8] == "2026-11-25"  # date
    finally:
        store.close()


def test_first_letter_buckets(tmp_path):
    store = _seed_db(tmp_path)
    try:
        built = build_search_index(store)
        rec = built["rec"]
        assert any(b[0] == "الكتاب الكبير" for b in rec["ك"])  # ال stripped
        assert any(b[0] == "1984" for b in rec["0-9"])
        assert any(b[0] == "The Great Gatsby" for b in rec["t"])
        assert any(b[0] == "نوستالچيا" for b in rec["ن"])
        assert any(b[0] == "مُتَوِّنُ الأحكام" for b in rec["م"])
    finally:
        store.close()


def test_idx_pointers_resolve(tmp_path):
    store = _seed_db(tmp_path)
    try:
        built = build_search_index(store)
        manifest = built["manifest"]
        letters = manifest["letters"]
        assert len(manifest["rec_files"]) == len(letters)
        assert len(manifest["idx_files"]) > 0
        # Every pointer decodes to a rec row whose haystack holds the word.
        checked = 0
        for bucket, words in built["idx"].items():
            for word, ptrs in words.items():
                assert ptrs == sorted(ptrs), f"postings for {word!r} not sorted"
                for ptr in ptrs:
                    li, row = divmod(ptr, POINTER_ROW_MOD)
                    letter = letters[li]
                    record = built["rec"][letter][row]
                    hay = (
                        index_words(record[0])
                        + index_words(record[1])
                        + index_words(record[2])
                    )
                    assert word in hay, f"{word!r} not in haystack of {record[0]!r}"
                    checked += 1
        assert checked > 0
        # No pointer out of range.
        for bucket, words in built["idx"].items():
            for word, ptrs in words.items():
                for ptr in ptrs:
                    li, row = divmod(ptr, POINTER_ROW_MOD)
                    assert 0 <= li < len(letters)
                    assert 0 <= row < len(built["rec"][letters[li]])
    finally:
        store.close()


def test_private_group_kept_with_empty_handle(tmp_path):
    store = _seed_db(tmp_path)
    try:
        built = build_search_index(store)
        rows = [b for b in _all_rec_books(built) if b[5] == "groupG"]
        assert len(rows) == 6
        # t.me/c/ URLs do not parse to handle+post — kept, handle "".
        assert all(b[6] == "" and b[7] == "" for b in rows)
        # Empty title falls back to the filename.
        assert any(b[0] == "ملف-بلا-عنوان.epub" for b in rows)
    finally:
        store.close()


def test_deterministic(tmp_path):
    store = _seed_db(tmp_path)
    try:
        first = build_search_index(store)
        second = build_search_index(store)
    finally:
        store.close()
    assert first["rec"] == second["rec"]
    assert first["idx"] == second["idx"]
    m1 = {k: v for k, v in first["manifest"].items() if k != "generated_at"}
    m2 = {k: v for k, v in second["manifest"].items() if k != "generated_at"}
    assert m1 == m2


def test_files_written_and_size_caps(tmp_path):
    store = _seed_db(tmp_path)
    store.close()
    out = tmp_path / "search"
    stats = build_search_index_files(
        tmp_path / "index.db", out, FIXTURES / "search-index-flags.json"
    )
    assert stats["books"] == 33
    assert stats["filtered_flagged"] == 1
    assert stats["filtered_hidden"] == 1
    assert (out / "manifest.json").is_file()
    manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["totals"]["books"] == 33
    assert manifest["letters"] == sorted(manifest["letters"])
    # letters_newest is parallel to letters and holds each letter's
    # newest rec date (the reader's fetch-order + prune key).
    assert len(manifest["letters_newest"]) == len(manifest["letters"])
    for letter, newest in zip(
        manifest["letters"], manifest["letters_newest"]
    ):
        recs = json.loads(
            (out / "rec" / f"{letter}.json").read_text(encoding="utf-8")
        )["books"]
        assert newest == (recs[0][8] if recs else "")
    for entry in manifest["rec_files"]:
        p = out / entry["file"]
        assert p.is_file()
        assert p.stat().st_size < 25 * 1024 * 1024
    for entry in manifest["idx_files"]:
        p = out / entry["file"]
        assert p.is_file()
        assert p.stat().st_size < 25 * 1024 * 1024
    assert stats["max_rec_bytes"] < 25 * 1024 * 1024
    assert stats["max_idx_bytes"] < 25 * 1024 * 1024
    assert stats["total_bytes"] > 0


def test_query_words_parity_with_js():
    # Spot-checks against the JS queryWords contract (see
    # functions/api/tg-search.js): tashkeel stripped, Persian
    # folded, ال stripped, len >= 2.
    assert query_words("مُتَوِّنُ الأحكام") == ["متون", "احكام"]
    assert "نوستالجيا" in query_words("نوستالچيا")
    assert query_words("الكتاب الكبير") == ["كتاب", "كبير"]
    assert query_words("الله") == ["الله"]  # short: ال NOT stripped
    assert query_words("a b") == []


def test_index_words_tokenizes_like_fts():
    # Haystack tokenization splits on non-alphanumeric runs, like
    # FTS5 unicode61 — a hyphenated filename indexes per word.
    assert index_words("python-for-beginners.epub") == [
        "python",
        "for",
        "beginners",
        "epub",
    ]
    assert index_words("مُتَوِّنُ الأحكام") == ["متون", "احكام"]
    assert index_words("الكتاب الكبير") == ["كتاب", "كبير"]
