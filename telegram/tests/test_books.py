"""Tests for tbi.books — title/author parsing and dedup keys."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tbi.books import (  # noqa: E402
    BOOK_EXTS,
    dedupe_key,
    normalize_arabic,
    parse_title_author,
)


def test_normalize_arabic_strips_tashkeel():
    assert normalize_arabic("مُتَوِّنُ طَالِبِ الْعِلْمِ") == "متون طالب العلم"
    assert normalize_arabic("الْعَقِيدَةُ أَوَّلًا") == "العقيده اولا"
    assert normalize_arabic("أحمد إبراهيم آمنة") == "احمد ابراهيم امنه"
    assert normalize_arabic("مكتبة") == "مكتبه"
    assert normalize_arabic("plain latin 123") == "plain latin 123"


def test_english_dash():
    assert parse_title_author("The Old Man and the Sea - Ernest Hemingway.pdf") == (
        "The Old Man and the Sea",
        "Ernest Hemingway",
    )


def test_author_first():
    assert parse_title_author("Ernest Hemingway - The Old Man and the Sea.epub") == (
        "The Old Man and the Sea",
        "Ernest Hemingway",
    )


def test_by():
    assert parse_title_author("Dune by Frank Herbert.mobi") == (
        "Dune",
        "Frank Herbert",
    )


def test_parens_author():
    assert parse_title_author("Dune (Frank Herbert).epub") == (
        "Dune",
        "Frank Herbert",
    )


def test_bare_title():
    title, author = parse_title_author("Dune.epub")
    assert title == "Dune"
    assert author == ""


def test_arabic_bare_title():
    title, author = parse_title_author("ألف ليلة وليلة.epub")
    assert title == "ألف ليلة وليلة"
    assert author == ""


def test_arabic_caption_author():
    title, author = parse_title_author(
        "حصن المسلم.pdf", caption="تأليف: سعيد بن علي بن وهف القحطاني"
    )
    assert title == "حصن المسلم"
    assert "القحطاني" in author


def test_noise_stripped():
    title, author = parse_title_author("[PDF] The Hobbit - J.R.R. Tolkien (2019).pdf")
    assert title == "The Hobbit"
    assert "Tolkien" in author


def test_dedupe_key():
    k1 = dedupe_key("Dune", "Frank Herbert", 123456)
    k2 = dedupe_key("dune", "frank herbert", 123456)
    k3 = dedupe_key("Dune", "Frank Herbert", 999)
    assert k1 == k2  # case-insensitive
    assert k1 != k3  # different size = different key
    assert dedupe_key("Dune", "Frank Herbert", None) == "dune|frank herbert"


def test_book_exts():
    # KFX is Amazon's current Kindle format (v0.3): the indexer and the
    # bot's channel-validation rule accept the same six formats.
    assert BOOK_EXTS == {"epub", "mobi", "azw3", "kfx", "pdf", "txt"}
