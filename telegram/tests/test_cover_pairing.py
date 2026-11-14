"""Tests for tbi.cover_pairing — no evidence = no cover.

Covers pair ONLY on high confidence: an image in the same post (0.99)
or a neighbouring image whose caption matches the title (0.90). A
neighbouring image without a matching caption (0.75) must NOT pair,
and a book with no image evidence at all gets NO cover.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tbi.cover_pairing import (  # noqa: E402
    CAPTION_MATCH_CONFIDENCE,
    HIGH_CONFIDENCE_THRESHOLD,
    NEIGHBOUR_NO_CAPTION_CONFIDENCE,
    REASON_NEIGHBOUR_NO_CAPTION,
    REASON_NO_IMAGE,
    SAME_POST_CONFIDENCE,
    BookFile,
    PostEvidence,
    caption_matches_title,
    pair_cover_for_book,
    pair_covers,
    summarize,
)


def _book(title="Dune", post_id=100, source="chan"):
    return BookFile(title=title, post_id=post_id, source=source,
                    url=f"https://t.me/{source}/{post_id}")


def _post(source, post_id, text="", has_image=False, files=None):
    return PostEvidence(
        source=source, post_id=post_id, text=text, has_image=has_image,
        image_ref=f"https://t.me/{source}/{post_id}" if has_image else "",
        files=files or [],
    )


def _by_key(posts):
    return {(p.source, p.post_id): p for p in posts}


def test_same_post_image_pairs():
    book = _book(post_id=100)
    posts = _by_key([
        _post("chan", 100, text="Dune by Frank Herbert",
              has_image=True, files=[book]),
    ])
    pair, reason = pair_cover_for_book(book, posts)
    assert pair is not None
    assert pair.confidence == SAME_POST_CONFIDENCE
    assert pair.confidence >= HIGH_CONFIDENCE_THRESHOLD
    assert pair.evidence == "same_post"
    assert pair.image_post_id == 100
    assert reason == ""


def test_caption_match_pairs():
    book = _book(title="Dune", post_id=100)
    posts = _by_key([
        _post("chan", 99, text="غلاف رواية Dune للكاتب فرانك هربرت",
              has_image=True),
        _post("chan", 100, text="", files=[book]),
    ])
    pair, reason = pair_cover_for_book(book, posts)
    assert pair is not None
    assert pair.confidence == CAPTION_MATCH_CONFIDENCE
    assert pair.evidence == "caption_match"
    assert pair.image_post_id == 99
    assert reason == ""


def test_caption_match_after_post_pairs():
    book = _book(title="ألف ليلة وليلة", post_id=100)
    posts = _by_key([
        _post("chan", 100, text="", files=[book]),
        _post("chan", 101, text="غلاف ألف ليلة وليلة", has_image=True),
    ])
    pair, _ = pair_cover_for_book(book, posts)
    assert pair is not None
    assert pair.image_post_id == 101


def test_low_confidence_neighbour_does_not_pair():
    book = _book(title="Dune", post_id=100)
    posts = _by_key([
        _post("chan", 99, text="صورة عشوائية لا علاقة لها بالكتاب",
              has_image=True),
        _post("chan", 100, text="", files=[book]),
        _post("chan", 101, text="اقتباس اليوم", has_image=True),
    ])
    pair, reason = pair_cover_for_book(book, posts)
    assert pair is None
    assert reason == REASON_NEIGHBOUR_NO_CAPTION
    # The 0.75 evidence exists but is below the pairing threshold.
    assert NEIGHBOUR_NO_CAPTION_CONFIDENCE < HIGH_CONFIDENCE_THRESHOLD


def test_no_evidence_gets_no_cover():
    book = _book(post_id=100)
    posts = _by_key([
        _post("chan", 99, text="اقتباس", has_image=False),
        _post("chan", 100, text="Dune", files=[book]),
        _post("chan", 101, text="اقتباس آخر", has_image=False),
    ])
    pair, reason = pair_cover_for_book(book, posts)
    assert pair is None
    assert reason == REASON_NO_IMAGE


def test_no_neighbour_posts_gets_no_cover():
    book = _book(post_id=100)
    posts = _by_key([_post("chan", 100, text="", files=[book])])
    pair, reason = pair_cover_for_book(book, posts)
    assert pair is None
    assert reason != ""


def test_caption_match_beats_bare_neighbour_image():
    # -1 has an image with no matching caption, +1 has one whose
    # caption matches: the match pairs (from +1), the bare image does not.
    book = _book(title="Dune", post_id=100)
    posts = _by_key([
        _post("chan", 99, text="صورة أخرى", has_image=True),
        _post("chan", 100, text="", files=[book]),
        _post("chan", 101, text="Dune — the cover", has_image=True),
    ])
    pair, _ = pair_cover_for_book(book, posts)
    assert pair is not None
    assert pair.image_post_id == 101


def test_other_channel_neighbour_does_not_count():
    # post_id +/- 1 in a DIFFERENT source is not a neighbour.
    book = _book(post_id=100, source="chan")
    posts = _by_key([
        _post("other", 99, text="Dune", has_image=True),
        _post("chan", 100, text="", files=[book]),
    ])
    pair, _ = pair_cover_for_book(book, posts)
    assert pair is None


def test_caption_match_arabic_diacritics():
    # The caption carries tashkeel, the title does not — still matches.
    assert caption_matches_title("غلاف مُتَوِّنُ طَالِبِ الْعِلْمِ", "متون طالب العلم")
    assert caption_matches_title("Dune by Frank Herbert", "Dune")
    assert not caption_matches_title("صورة عشوائية", "Dune")
    assert not caption_matches_title("غلاف كتاب آخر", "")
    assert not caption_matches_title("", "Dune")


def test_pair_covers_and_summarize():
    books = [_book("Dune", 100), _book("Foundation", 200), _book("Neuromancer", 300)]
    posts = [
        _post("chan", 100, text="Dune", has_image=True,
              files=[books[0]]),
        _post("chan", 199, text="Foundation cover", has_image=True),
        _post("chan", 200, text="", files=[books[1]]),
        _post("chan", 300, text="", files=[books[2]]),
    ]
    results = pair_covers(books, posts)
    assert len(results) == 3
    assert results[0][1] is not None  # same-post
    assert results[1][1] is not None  # caption match
    assert results[2][1] is None  # no evidence
    report = summarize(results)
    assert report["total_books"] == 3
    assert report["paired"] == 2
    assert report["same_post"] == 1
    assert report["caption_match"] == 1
    assert abs(report["pairing_rate"] - 2 / 3) < 1e-9
    assert report["unpaired_by_reason"] == {"no_neighbour_post": 1}


def test_cover_record_is_embedded_metadata():
    book = _book(post_id=100)
    posts = _by_key([
        _post("chan", 100, text="Dune", has_image=True, files=[book]),
    ])
    pair, _ = pair_cover_for_book(book, posts)
    rec = pair.to_record()
    assert rec["cover_ref"] == "https://t.me/chan/100"
    assert rec["cover_confidence"] == SAME_POST_CONFIDENCE
    assert rec["cover_evidence"] == "same_post"
    assert "http" not in rec.get("cover_url", "")  # no hotlink field stored
