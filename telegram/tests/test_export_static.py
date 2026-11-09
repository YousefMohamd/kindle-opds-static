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
)
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
    assert one["url"].startswith("https://t.me/")
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
