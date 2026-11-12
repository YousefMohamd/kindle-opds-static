"""Tests for tbi.books — title/author parsing and dedup keys."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tbi.books import (  # noqa: E402
    BOOK_EXTS,
    dedupe_key,
    format_size,
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
    # All readable book/document formats (v0.5): the original six
    # Kindle-workflow formats plus DOC/DOCX, DJVU/DJV, FB2, CBR/CBZ,
    # RTF, AZW, PRC, ODT, CHM, LIT, LRF, PDB and KEPUB. Audio, video,
    # generic archives, images and HTML stay out.
    assert BOOK_EXTS == {
        "azw", "azw3", "cbr", "cbz", "chm", "djv", "djvu", "doc",
        "docx", "epub", "fb2", "kepub", "kfx", "lit", "lrf", "mobi",
        "odt", "pdf", "pdb", "prc", "rtf", "txt",
    }


def test_new_formats_parse_title_author():
    # A DOC/DJVU/FB2/CBZ filename parses to the right title/author/
    # format, exactly like an EPUB one.
    assert parse_title_author("متن طيبة النشر في القراءات العشر.doc") == (
        "متن طيبة النشر في القراءات العشر",
        "",
    )
    assert parse_title_author("Dune - Frank Herbert.docx") == (
        "Dune",
        "Frank Herbert",
    )
    assert parse_title_author("Dune (Frank Herbert).djvu") == (
        "Dune",
        "Frank Herbert",
    )
    assert parse_title_author("Dune by Frank Herbert.fb2") == (
        "Dune",
        "Frank Herbert",
    )
    assert parse_title_author("Watchmen - Alan Moore.cbz") == (
        "Watchmen",
        "Alan Moore",
    )
    assert parse_title_author("Old Book - Some Author.azw") == (
        "Old Book",
        "Some Author",
    )
    assert parse_title_author("Old Book - Some Author.prc") == (
        "Old Book",
        "Some Author",
    )
    assert parse_title_author("Old Book - Some Author.lrf") == (
        "Old Book",
        "Some Author",
    )
    assert parse_title_author("Old Book - Some Author.pdb") == (
        "Old Book",
        "Some Author",
    )
    assert parse_title_author("Old Book - Some Author.odt") == (
        "Old Book",
        "Some Author",
    )
    assert parse_title_author("Old Book - Some Author.rtf") == (
        "Old Book",
        "Some Author",
    )
    assert parse_title_author("Old Book - Some Author.chm") == (
        "Old Book",
        "Some Author",
    )
    assert parse_title_author("Old Book - Some Author.lit") == (
        "Old Book",
        "Some Author",
    )
    assert parse_title_author("Old Book - Some Author.kepub") == (
        "Old Book",
        "Some Author",
    )
    assert parse_title_author("Old Book - Some Author.cbr") == (
        "Old Book",
        "Some Author",
    )
    assert parse_title_author("Old Book - Some Author.djv") == (
        "Old Book",
        "Some Author",
    )


def test_new_format_noise_stripped():
    title, author = parse_title_author("[DOCX] The Hobbit - J.R.R. Tolkien (2019).docx")
    assert title == "The Hobbit"
    assert "Tolkien" in author
    # Trailing format tag ("Title djvu") is stripped like "Title pdf".
    title, author = parse_title_author("Dune djvu.djvu")
    assert title == "Dune"
    # Prefix extensions do not leave a leftover digit/letter: ".azw3"
    # strips fully, ".docx" does not leave an "x".
    assert parse_title_author("Dune.azw3")[0] == "Dune"
    assert parse_title_author("Dune.docx")[0] == "Dune"
    assert parse_title_author("Dune.djvu")[0] == "Dune"


def test_doc_lit_words_not_stripped():
    # "doc" and "lit" are ordinary English words: a title legitimately
    # ending in them must survive _clean (only bracket/paren tags and
    # the file extension are removed).
    assert parse_title_author("The Doc.doc")[0] == "The Doc"
    assert parse_title_author("Something Lit.lit")[0] == "Something Lit"


def test_non_book_exts_still_rejected():
    # Audio, video, generic archives, images and HTML are not books.
    for ext in ("mp3", "m4b", "m4a", "mp4", "mkv", "zip", "rar", "7z",
                "jpg", "png", "html", "exe"):
        assert ext not in BOOK_EXTS


def test_format_size():
    # Inverse of scrape.parse_size ("12.3 MB" -> bytes): used when a size
    # is known as bytes (API messages, submitted books) but no display
    # text was given (v0.4).
    assert format_size(None) is None
    assert format_size(0) == "0 B"
    assert format_size(1000) == "1000 B"
    assert format_size(1024) == "1 KB"
    assert format_size(1536) == "1.5 KB"
    assert format_size(1200000) == "1.1 MB"
    assert format_size(2048) == "2 KB"
