"""Tests for tbi.export_static — the static site data export (offline)."""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tbi.export_static import (  # noqa: E402
    BOOK_FIELDS,
    SHARD_BYTES,
    build_index_json,
    build_shards,
    export_static,
    load_flags_file,
)
from tbi.newest import build_newest  # noqa: E402
from tbi.store import Store  # noqa: E402


def _seed(tmp_path):
    db = tmp_path / "index.db"
    store = Store(db)
    a = store.upsert_source("channel", "chanA")
    p1 = store.upsert_post(a, 100, "2026-11-06T10:00:00+00:00", "Book One",
                           "https://t.me/chanA/100")
    store.replace_files_for_post(p1, [{
        "filename": "Book One.epub", "ext": "epub",
        "size_text": "1.2 MB", "size_bytes": 1200000,
        "title": "Book One", "author": "Author A",
        "dedupe_key": "book one|author a|1200000",
        "obtain_url": "https://t.me/chanA/100",
    }])
    p2 = store.upsert_post(a, 101, "2026-11-06T11:00:00+00:00", "Book Two",
                           "https://t.me/chanA/101")
    store.replace_files_for_post(p2, [{
        "filename": "Book Two.pdf", "ext": "pdf",
        "size_text": None, "size_bytes": None,
        "title": "Book Two", "author": "",
        "dedupe_key": "book two|",
        "obtain_url": "https://t.me/chanA/101",
    }])
    # Same book shared in a second source: same dedupe key.
    b = store.upsert_source("channel", "chanB")
    p3 = store.upsert_post(b, 50, "2026-11-06T12:00:00+00:00", "Book One",
                           "https://t.me/chanB/50")
    store.replace_files_for_post(p3, [{
        "filename": "Book One.epub", "ext": "epub",
        "size_text": "1.2 MB", "size_bytes": 1200000,
        "title": "Book One", "author": "Author A",
        "dedupe_key": "book one|author a|1200000",
        "obtain_url": "https://t.me/chanB/50",
    }])
    # Two files with an empty dedupe key must NOT collapse together.
    p4 = store.upsert_post(b, 51, "2026-11-06T12:05:00+00:00", "untitled",
                           "https://t.me/chanB/51")
    store.replace_files_for_post(p4, [{
        "filename": "file-one.epub", "ext": "epub",
        "size_text": None, "size_bytes": None,
        "title": "", "author": "", "dedupe_key": "|",
        "obtain_url": "https://t.me/chanB/51",
    }])
    p5 = store.upsert_post(b, 52, "2026-11-06T12:06:00+00:00", "untitled",
                           "https://t.me/chanB/52")
    store.replace_files_for_post(p5, [{
        "filename": "file-two.epub", "ext": "epub",
        "size_text": None, "size_bytes": None,
        "title": "", "author": "", "dedupe_key": "|",
        "obtain_url": "https://t.me/chanB/52",
    }])
    store.commit()
    return store


def test_build_index_json_dedupes_books(tmp_path):
    store = _seed(tmp_path)
    try:
        data = build_index_json(store)
    finally:
        store.close()
    assert data["totals"] == {"posts": 5, "files": 5, "books": 4, "sources": 2}
    by_title = {b["title"]: b for b in data["books"]}
    assert set(by_title) == {
        "Book One", "Book Two", "file-one.epub", "file-two.epub",
    }
    one = by_title["Book One"]
    assert one["author"] == "Author A"
    assert one["ext"] == "epub"
    assert one["size"] == "1.2 MB"
    assert one["sources"] == 2  # shared in chanA and chanB
    # Workstream H: no raw post URL in the row — handle + post id
    # only. Book One's row is the newest file (chanB/50, 12:00).
    assert one["handle"] == "chanB"
    assert one["post"] == "50"
    assert by_title["Book Two"]["ext"] == "pdf"
    # Empty titles fall back to the filename for display.
    assert by_title["file-one.epub"]["title"] == "file-one.epub"


def test_export_static_writes_manifest_and_shards(tmp_path):
    store = _seed(tmp_path)
    store.close()
    (tmp_path / "index-report.md").write_text("# Index report\n", encoding="utf-8")
    stats = export_static(tmp_path / "index.db", tmp_path / "site")
    assert stats["books"] == 4
    assert stats["report_copied"] is True
    assert stats["shards"] == len(stats["shard_files"]) >= 1
    assert stats["max_shard_bytes"] <= SHARD_BYTES
    # The manifest (index.json) is small and holds totals + the shard list.
    manifest = json.loads((tmp_path / "site" / "index.json").read_text(encoding="utf-8"))
    assert manifest["totals"]["books"] == 4
    assert manifest["books"] == 4
    assert manifest["formats"] == ["epub", "pdf"]
    assert [s["file"] for s in manifest["shards"]] == stats["shard_files"]
    assert sum(s["books"] for s in manifest["shards"]) == 4
    # Every shard is a {"books": [[...], ...]} document whose arrays
    # map back to the same book objects (positional BOOK_FIELDS).
    all_books = []
    for fname in stats["shard_files"]:
        shard = json.loads((tmp_path / "site" / fname).read_text(encoding="utf-8"))
        for arr in shard["books"]:
            assert len(arr) == len(BOOK_FIELDS)
            all_books.append(dict(zip(BOOK_FIELDS, arr)))
    assert {b["title"] for b in all_books} == {
        "Book One", "Book Two", "file-one.epub", "file-two.epub",
    }
    assert (tmp_path / "site" / "index-report.md").read_text() == "# Index report\n"
    # Re-export is atomic: no temp files left behind.
    assert not list((tmp_path / "site").glob("*.tmp"))


def test_export_static_without_report(tmp_path):
    store = _seed(tmp_path)
    store.close()
    stats = export_static(tmp_path / "index.db", tmp_path / "site")
    assert stats["report_copied"] is False
    assert (tmp_path / "site" / "index.json").is_file()
    assert stats["shards"] >= 1


def test_shards_group_by_source_and_respect_byte_budget(tmp_path):
    # One source with many long-titled books must split into several
    # shards, each under the byte budget; a second source starts a
    # new shard even when the current one still has room.
    db = tmp_path / "index.db"
    store = Store(db)
    a = store.upsert_source("channel", "bigSource")
    for i in range(30):
        p = store.upsert_post(a, 100 + i, "2026-11-06T10:00:00+00:00",
                              "Book Number %02d With A Fairly Long Title" % i,
                              "https://t.me/bigSource/%d" % (100 + i))
        store.replace_files_for_post(p, [{
            "filename": "Book Number %02d.epub" % i, "ext": "epub",
            "size_text": "1.0 MB", "size_bytes": 1000000,
            "title": "Book Number %02d With A Fairly Long Title" % i,
            "author": "Author A",
            "dedupe_key": "book number %02d|author a|1000000" % i,
            "obtain_url": "https://t.me/bigSource/%d" % (100 + i),
        }])
    b = store.upsert_source("channel", "smallSource")
    p = store.upsert_post(b, 1, "2026-11-06T10:00:00+00:00", "Tiny Book",
                          "https://t.me/smallSource/1")
    store.replace_files_for_post(p, [{
        "filename": "Tiny Book.pdf", "ext": "pdf",
        "size_text": None, "size_bytes": None,
        "title": "Tiny Book", "author": "",
        "dedupe_key": "tiny book|",
        "obtain_url": "https://t.me/smallSource/1",
    }])
    store.commit()
    try:
        manifest, shards = build_shards(store, shard_bytes=1500)
    finally:
        store.close()
    # The big source split into several shards; the small source is
    # packed into the last shard (never split across shards itself),
    # possibly sharing it with the tail of the big source.
    assert len(shards) >= 3
    assert "smallSource" in manifest["shards"][-1]["sources"]
    assert sum(s["books"] for s in manifest["shards"]) == 31
    # The small source's single book is whole in exactly one shard.
    assert sum(
        1 for _fname, payload in shards
        for arr in payload["books"] if arr[0] == "Tiny Book"
    ) == 1
    for _fname, payload in shards:
        size = len(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
        assert size <= 1500, size  # the byte budget is now exact
    # Every shard payload round-trips to the same books.
    titles = []
    for _fname, payload in shards:
        titles.extend(arr[0] for arr in payload["books"])
    assert len(titles) == 31
    assert len(set(titles)) == 31


def test_export_static_missing_db(tmp_path):
    with pytest.raises(FileNotFoundError):
        export_static(tmp_path / "nope.db", tmp_path / "site")


# --- flag filter (v4.8.65) ---------------------------------------------
# A flagged/hidden book must not reach the static catalog: the search
# page links straight to the Telegram post, so listing one there
# would hand out a download that bypasses every delivery gate.

def _seed_flags(tmp_path):
    db = tmp_path / "index.db"
    store = Store(db)
    a = store.upsert_source("channel", "chanA")
    p1 = store.upsert_post(a, 100, "2026-11-06T10:00:00+00:00",
                           "Flagged Book", "https://t.me/chanA/100")
    store.replace_files_for_post(p1, [{
        "filename": "Flagged Book.epub", "ext": "epub",
        "size_text": "1.0 MB", "size_bytes": 1000000,
        "title": "Flagged Book", "author": "Author A",
        "dedupe_key": "flagged book|author a|1000000",
        "obtain_url": "https://t.me/chanA/100",
    }])
    p2 = store.upsert_post(a, 101, "2026-11-06T11:00:00+00:00",
                           "Hidden Book", "https://t.me/chanA/101")
    store.replace_files_for_post(p2, [{
        "filename": "Hidden Book.pdf", "ext": "pdf",
        "size_text": "2.0 MB", "size_bytes": 2000000,
        "title": "Hidden Book", "author": "",
        "dedupe_key": "hidden book||2000000",
        "obtain_url": "https://t.me/chanA/101",
    }])
    b = store.upsert_source("channel", "chanB")
    p3 = store.upsert_post(b, 50, "2026-11-06T12:00:00+00:00",
                           "Kept Book", "https://t.me/chanB/50")
    store.replace_files_for_post(p3, [{
        "filename": "Kept Book.epub", "ext": "epub",
        "size_text": "1.0 MB", "size_bytes": 1000000,
        "title": "Kept Book", "author": "Author B",
        "dedupe_key": "kept book|author b|1000000",
        "obtain_url": "https://t.me/chanB/50",
    }])
    # Private-group post: the URL does not parse to a public handle
    # + post id, so no flag key can ever match it — it is kept.
    p4 = store.upsert_post(b, 51, "2026-11-06T12:05:00+00:00",
                           "Private Book", "https://t.me/c/123456/7")
    store.replace_files_for_post(p4, [{
        "filename": "Private Book.epub", "ext": "epub",
        "size_text": None, "size_bytes": None,
        "title": "Private Book", "author": "",
        "dedupe_key": "private book|",
        "obtain_url": "https://t.me/c/123456/7",
    }])
    store.commit()
    return store


def test_flag_filter_drops_flagged_and_hidden_from_index_json(tmp_path):
    store = _seed_flags(tmp_path)
    try:
        data = build_index_json(store, ({"chana:100"}, {"chana:101"}))
    finally:
        store.close()
    assert data["totals"]["books"] == 2
    assert data["filtered"] == {"flagged": 1, "hidden": 1}
    titles = {b["title"] for b in data["books"]}
    assert titles == {"Kept Book", "Private Book"}


def test_flag_filter_drops_flagged_and_hidden_from_shards(tmp_path):
    store = _seed_flags(tmp_path)
    try:
        manifest, shards = build_shards(store, ({"chana:100"}, {"chana:101"}))
    finally:
        store.close()
    assert manifest["totals"]["books"] == 2
    assert manifest["books"] == 2
    assert manifest["filtered"] == {"flagged": 1, "hidden": 1}
    rows = [arr for _fname, payload in shards for arr in payload["books"]]
    assert len(rows) == 2
    # Positional fields: handle [8], post [9] (BOOK_FIELDS). The
    # private-group book parses to handle/post "" (kept, unmatchable).
    assert {arr[BOOK_FIELDS.index("handle")] for arr in rows} == {"chanB", ""}
    assert {arr[BOOK_FIELDS.index("post")] for arr in rows} == {"50", ""}
    assert sum(s["books"] for s in manifest["shards"]) == 2


def test_flag_filter_is_case_insensitive(tmp_path):
    # The blob may carry a mixed-case handle; the match normalizes.
    flags_path = tmp_path / "flags.json"
    flags_path.write_text(
        json.dumps({"flagged": ["ChanA:100"], "hidden": []}),
        encoding="utf-8",
    )
    flagged, hidden = load_flags_file(flags_path)
    assert flagged == {"chana:100"}
    assert hidden == set()
    store = _seed_flags(tmp_path)
    try:
        data = build_index_json(store, (flagged, hidden))
    finally:
        store.close()
    assert {b["title"] for b in data["books"]} == {
        "Hidden Book", "Kept Book", "Private Book",
    }


def test_load_flags_file_errors(tmp_path):
    with pytest.raises(FileNotFoundError):
        load_flags_file(tmp_path / "missing.json")
    bad = tmp_path / "bad.json"
    bad.write_text("{not json", encoding="utf-8")
    with pytest.raises(ValueError):
        load_flags_file(bad)
    arr = tmp_path / "arr.json"
    arr.write_text("[\"chana:100\"]", encoding="utf-8")
    with pytest.raises(ValueError):
        load_flags_file(arr)
    empty = tmp_path / "empty.json"
    empty.write_text("{}", encoding="utf-8")
    assert load_flags_file(empty) == (set(), set())


def test_export_static_with_flags_json_end_to_end(tmp_path):
    store = _seed_flags(tmp_path)
    store.close()
    flags_path = tmp_path / "flags.json"
    flags_path.write_text(
        json.dumps({"flagged": ["chana:100"], "hidden": ["chana:101"]}),
        encoding="utf-8",
    )
    out = tmp_path / "site"
    stats = export_static(tmp_path / "index.db", out, flags_path=flags_path)
    assert stats["books"] == 2
    assert stats["filtered_flagged"] == 1
    assert stats["filtered_hidden"] == 1
    manifest = json.loads((out / "index.json").read_text(encoding="utf-8"))
    assert manifest["totals"]["books"] == 2
    assert manifest["filtered"] == {"flagged": 1, "hidden": 1}
    shard_rows = []
    for shard_file in stats["shard_files"]:
        payload = json.loads((out / shard_file).read_text(encoding="utf-8"))
        shard_rows.extend(payload["books"])
    assert len(shard_rows) == 2
    assert {arr[0] for arr in shard_rows} == {"Kept Book", "Private Book"}
    # newest.json is built by scanning the shards, so the flagged /
    # hidden books are absent there too, with no newest.py change.
    newest = build_newest(out)
    assert newest["count"] == 2
    assert {b["title"] for b in newest["books"]} == {
        "Kept Book", "Private Book",
    }
