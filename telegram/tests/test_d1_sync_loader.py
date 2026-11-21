"""Tests for tbi.d1_sync.load_catalog — the Nov 20 shard format.

Nov 13 shards: 9 fields, [8] is the FULL https://t.me/... URL.
Nov 20 shards: 10 fields, [8] is the source handle AGAIN and [9] is the
numeric post id — the URL is rebuilt as https://t.me/{source}/{post_id}.
Reading b[8] as the URL on a 10-field record produces garbage
(url='noorlibrarykids'). The fix (from delta-work/delta_loader.py)
detects the length; any other length fails loudly.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tbi.d1_sync import load_catalog  # noqa: E402


def _site(tmp_path, shards):
    site = tmp_path / "site-telegram"
    site.mkdir()
    manifest = {"sources": [{"name": "noorlibrarykids", "kind": "channel"}], "shards": []}
    for name, books in shards:
        (site / name).write_text(json.dumps({"books": books}), encoding="utf-8")
        manifest["shards"].append({"file": name})
    (site / "index.json").write_text(json.dumps(manifest), encoding="utf-8")
    return site


def test_load_catalog_rebuilds_url_for_10_field_records(tmp_path):
    site = _site(tmp_path, [("index-0.json", [
        ["Title A", "Author A", "Title A.epub", "epub", "1.0 MB",
         "noorlibrarykids", 1, "2026-11-20", "noorlibrarykids", 12345],
    ])])
    _, books = load_catalog(site)
    assert len(books) == 1
    assert books[0]["url"] == "https://t.me/noorlibrarykids/12345"
    assert books[0]["source"] == "noorlibrarykids"
    assert books[0]["kind"] == "channel"


def test_load_catalog_keeps_url_for_9_field_records(tmp_path):
    site = _site(tmp_path, [("index-0.json", [
        ["Title B", "Author B", "Title B.epub", "epub", "1.0 MB",
         "noorlibrarykids", 1, "2026-11-13", "https://t.me/noorlibrarykids/999"],
    ])])
    _, books = load_catalog(site)
    assert len(books) == 1
    assert books[0]["url"] == "https://t.me/noorlibrarykids/999"


def test_load_catalog_mixed_formats_in_one_run(tmp_path):
    site = _site(tmp_path, [("index-0.json", [
        ["New Book", "", "New Book.pdf", "pdf", "2.0 MB",
         "noorlibrarykids", 1, "2026-11-20", "noorlibrarykids", 7],
        ["Old Book", "", "Old Book.pdf", "pdf", "2.0 MB",
         "noorlibrarykids", 1, "2026-11-13", "https://t.me/noorlibrarykids/8"],
    ])])
    _, books = load_catalog(site)
    assert [b["url"] for b in books] == [
        "https://t.me/noorlibrarykids/7",
        "https://t.me/noorlibrarykids/8",
    ]


def test_load_catalog_rejects_unknown_record_length(tmp_path):
    import pytest

    site = _site(tmp_path, [("index-0.json", [
        ["Bad Book", "", "Bad Book.pdf", "pdf", "2.0 MB", "noorlibrarykids"],
    ])])
    with pytest.raises(ValueError, match="unknown shard record length"):
        load_catalog(site)
