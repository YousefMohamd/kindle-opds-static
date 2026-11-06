"""Tests for tbi.exports — Telegram Desktop JSON export parsing.

Fixture: tests/fixtures/export_sample.json, a realistic export of a
public supergroup "Old Arabic Books" (6 messages in the file).
Format per Telegram Desktop's JSON export; MUST be verified against
one real export (see README) — the fixture follows the documented
shape, not a captured file.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tbi import exports  # noqa: E402

FIX = Path(__file__).parent / "fixtures"


def test_flatten_text():
    assert exports.flatten_text("plain") == "plain"
    assert exports.flatten_text(
        [{"type": "plain", "text": "A "}, {"type": "bold", "text": "B"}]
    ) == "A B"
    assert exports.flatten_text(None) == ""


def test_parse_export_fixture():
    chat_name, posts = exports.parse_export(FIX / "export_sample.json")
    assert chat_name == "Old Arabic Books"
    # 6 messages in the file, 1 service message skipped -> 5 posts.
    assert len(posts) == 5
    assert [p.post_id for p in posts] == [101, 102, 103, 105, 106]

    # EPUB post with a plain-string caption.
    p101 = posts[0]
    assert len(p101.files) == 1
    assert p101.files[0].filename == "ألف ليلة وليلة.epub"
    assert p101.files[0].ext == "epub"
    assert p101.files[0].mime_type == "application/epub+zip"
    assert p101.text.startswith("Requested:")
    assert p101.url == "https://t.me/c/1234567890/101"

    # PDF post with entity-list text and NO file_name field (basename used).
    p102 = posts[1]
    assert p102.files[0].filename == "The Old Man and the Sea - Ernest Hemingway.pdf"
    assert p102.files[0].ext == "pdf"
    assert "The Old Man and the Sea" in p102.text

    # Text-only request post: no files, caption kept.
    p103 = posts[2]
    assert p103.files == []
    assert "حصن المسلم" in p103.text

    # Audio file is not a book file.
    p105 = posts[3]
    assert p105.files[0].ext == "mp3"
    assert not exports.is_book_file(p105.files[0])

    # Same EPUB re-uploaded: same filename, different post.
    p106 = posts[4]
    assert p106.files[0].filename == "ألف ليلة وليلة.epub"


def test_parse_export_malformed(tmp_path):
    bad = tmp_path / "bad.json"
    bad.write_text('{"nope": true}')
    try:
        exports.parse_export(bad)
    except ValueError as exc:
        assert "messages" in str(exc)
    else:
        raise AssertionError("expected ValueError")


def test_group_permalink():
    assert exports._group_permalink(-1001234567890, 101) == "https://t.me/c/1234567890/101"
    assert exports._group_permalink("not-a-number", 1) == ""
