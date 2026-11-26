"""Tests for tbi.newest (the /new feed builder).

Regression (2026-11-26, verified live): the published newest.json
carried ``"url": "rwaiaty4"`` — the bare handle — on every book,
because newest.py read row[8] as the URL while the Workstream H
shards store ``[8] = handle, [9] = post``. The output URL must be
rebuilt as https://t.me/<handle>/<post>.

Live merge (same date, verified live): the shards top out at
2026-11-21 while the bot Worker's Durable Object ``live:additions``
holds books dated 2026-11-26, so a shards-only feed is days stale
even when generated today. ``--live-json`` merges the live snapshot
in front; the merged list is sorted newest-first and deduped.
"""

import json

import pytest

from tbi.newest import build_newest, load_live_books, main, row_url


def _shard(tmp_path, rows):
    d = tmp_path / "shards"
    d.mkdir()
    (d / "index-0.json").write_text(
        json.dumps({"books": rows}, ensure_ascii=False), encoding="utf-8"
    )
    return d


def _row10(title, date, handle="rwaiaty4", post="123", author="",
           fmt="pdf", source="rwaiaty4"):
    return [title, author, "file", fmt, "1 MB", source, 1, date, handle, post]


def _live(title, date, source="bookpdfepub", post="616635", fmt="PDF",
          author="", added_at=None):
    b = {
        "id": f"{source}:{post}:{fmt.lower()}",
        "title": title,
        "author": author,
        "source": source,
        "kind": "group",
        "format": fmt,
        "filename": title + "." + fmt.lower(),
        "url": f"https://t.me/{source}/{post}",
        "post_id": int(post),
        "date": date,
        "added_at": added_at or date,
    }
    return b


def _live_file(tmp_path, books):
    p = tmp_path / "live-additions.json"
    p.write_text(json.dumps({"since": "2026-11-19T21:15:14+00:00",
                             "books": books}, ensure_ascii=False),
                 encoding="utf-8")
    return p


def test_row_url_rebuilds_post_url_from_handle_and_post():
    assert row_url(_row10("T", "2026-11-25")) == "https://t.me/rwaiaty4/123"


def test_row_url_empty_when_handle_or_post_missing():
    assert row_url(_row10("T", "2026-11-25", handle="")) == ""
    assert row_url(_row10("T", "2026-11-25", post="")) == ""
    assert row_url(_row10("T", "2026-11-25", handle="", post="")) == ""


def test_row_url_legacy_9_field_row_keeps_stored_url():
    row9 = ["T", "", "file", "pdf", "1 MB", "src", 1, "2026-11-25",
            "https://t.me/oldsrc/42"]
    assert row_url(row9) == "https://t.me/oldsrc/42"


def test_build_newest_emits_real_post_urls(tmp_path):
    d = _shard(tmp_path, [
        _row10("Newest Book", "2026-11-25", post="999"),
        _row10("Older Book", "2026-11-21", post="111"),
    ])
    out = build_newest(d)
    assert out["count"] == 2
    assert out["books"][0]["title"] == "Newest Book"
    assert out["books"][0]["url"] == "https://t.me/rwaiaty4/999"
    assert out["books"][1]["url"] == "https://t.me/rwaiaty4/111"


def test_build_newest_private_book_without_handle_gets_empty_url(tmp_path):
    d = _shard(tmp_path, [
        _row10("Private Book", "2026-11-25", handle="", post=""),
    ])
    out = build_newest(d)
    assert out["books"][0]["url"] == ""


def test_build_newest_sorts_by_date_newest_first(tmp_path):
    d = _shard(tmp_path, [
        _row10("Old", "2026-11-21"),
        _row10("New", "2026-11-25"),
        _row10("Mid", "2026-11-23"),
    ])
    out = build_newest(d)
    assert [b["title"] for b in out["books"]] == ["New", "Mid", "Old"]


# --- live merge ---------------------------------------------------------


def test_load_live_books_normalizes_do_shape(tmp_path):
    p = _live_file(tmp_path, [
        _live("Fresh", "2026-11-26T10:28:49+00:00"),
        _live("NoDate", None, added_at="2026-11-25T09:00:00+00:00"),
        {"title": "  ", "author": "", "source": "x", "format": "PDF",
         "date": "2026-11-26", "url": "https://t.me/x/1"},
    ])
    books = load_live_books(p)
    assert [b["title"] for b in books] == ["Fresh", "NoDate"]
    assert books[0]["date"] == "2026-11-26"
    assert books[0]["url"] == "https://t.me/bookpdfepub/616635"
    assert books[0]["format"] == "PDF"
    # date falls back to added_at when the post date is missing.
    assert books[1]["date"] == "2026-11-25"


def test_load_live_books_missing_or_malformed_falls_back_empty(tmp_path):
    assert load_live_books(tmp_path / "nope.json") == []
    bad = tmp_path / "bad.json"
    bad.write_text("not-json{{", encoding="utf-8")
    assert load_live_books(bad) == []
    wrong = tmp_path / "wrong.json"
    wrong.write_text(json.dumps({"books": "nope"}), encoding="utf-8")
    assert load_live_books(wrong) == []


def test_build_newest_live_books_beat_stale_shards(tmp_path):
    """The 2026-11-26 live case: shards top out 2026-11-21, the live
    snapshot has 2026-11-26 books — the feed's newest date must be
    2026-11-26 with real post URLs."""
    d = _shard(tmp_path, [
        _row10("Shard Book", "2026-11-21", post="55211"),
    ])
    live = load_live_books(_live_file(tmp_path, [
        _live("Chainsaw Man Vol 1", "2026-11-26T10:28:49+00:00"),
        _live("The Intruder", "2026-11-26T10:12:40+00:00", post="616629",
              fmt="EPUB"),
    ]))
    out = build_newest(d, live_books=live)
    assert out["books"][0]["date"] == "2026-11-26"
    # Both live books share 2026-11-26, so title-desc decides their order.
    assert [b["title"] for b in out["books"]] == [
        "The Intruder", "Chainsaw Man Vol 1", "Shard Book"]
    assert out["books"][0]["url"] == "https://t.me/bookpdfepub/616629"
    assert out["books"][1]["url"] == "https://t.me/bookpdfepub/616635"
    assert out["books"][2]["url"] == "https://t.me/rwaiaty4/55211"


def test_build_newest_live_duplicate_of_shard_book_kept_once(tmp_path):
    d = _shard(tmp_path, [
        _row10("Same Book", "2026-11-21", handle="bookpdfepub",
               post="616635", source="bookpdfepub", fmt="pdf"),
    ])
    live = load_live_books(_live_file(tmp_path, [
        _live("Same Book", "2026-11-21T09:00:00+00:00"),
    ]))
    out = build_newest(d, live_books=live)
    assert out["count"] == 1
    # The live copy wins (it carries the full post URL).
    assert out["books"][0]["url"] == "https://t.me/bookpdfepub/616635"


def test_build_newest_old_live_book_sorts_behind_newer_shard(tmp_path):
    """The live window starts at the last publish, so it can hold
    books OLDER than the shards' newest — the final sort, not the
    merge order, must decide."""
    d = _shard(tmp_path, [_row10("Shard New", "2026-11-21", post="55211")])
    live = load_live_books(_live_file(tmp_path, [
        _live("Live Old", "2026-11-19T21:00:00+00:00", post="600001"),
    ]))
    out = build_newest(d, live_books=live)
    assert [b["title"] for b in out["books"]] == ["Shard New", "Live Old"]


def test_main_cli_live_json_end_to_end(tmp_path):
    d = _shard(tmp_path, [_row10("Shard Book", "2026-11-21", post="55211")])
    live_path = _live_file(tmp_path, [
        _live("Fresh", "2026-11-26T10:28:49+00:00"),
    ])
    out_path = tmp_path / "newest.json"
    rc = main(["--shard-dir", str(d), "--out", str(out_path),
               "--limit", "30", "--live-json", str(live_path)])
    assert rc == 0
    data = json.loads(out_path.read_text(encoding="utf-8"))
    assert data["count"] == 2
    assert data["books"][0]["date"] == "2026-11-26"
    assert data["books"][0]["url"] == "https://t.me/bookpdfepub/616635"
    assert data["books"][1]["url"] == "https://t.me/rwaiaty4/55211"


def test_main_cli_without_live_json_unchanged(tmp_path):
    d = _shard(tmp_path, [_row10("Shard Book", "2026-11-21", post="55211")])
    out_path = tmp_path / "newest.json"
    rc = main(["--shard-dir", str(d), "--out", str(out_path)])
    assert rc == 0
    data = json.loads(out_path.read_text(encoding="utf-8"))
    assert data["count"] == 1
    assert data["books"][0]["date"] == "2026-11-21"
    assert data["books"][0]["url"] == "https://t.me/rwaiaty4/55211"
