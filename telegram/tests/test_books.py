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


def test_normalize_arabic_folds_persian_letters():
    # نوستالجيا: a query with ج must match a title stored with چ.
    assert normalize_arabic("نوستالچيا") == "نوستالجيا"
    assert (
        normalize_arabic("روايه نوستالچيا لنور اسماعيل")
        == "روايه نوستالجيا لنور اسماعيل"
    )
    assert normalize_arabic("کتاب") == "كتاب"
    assert normalize_arabic("پدر") == "بدر"
    assert normalize_arabic("گربه") == "كربه"
    assert normalize_arabic("ڤيديو") == "فيديو"


def test_normalize_arabic_eastern_numerals_deferred_to_day_2():
    # DEFERRED to day 2 (2026-11-21 follow-up): the ٠-٩ -> 0-9 fold
    # is NOT applied — live books_fts still holds Eastern numerals
    # in 15,370 rows and today's D1 write budget is fully used, so
    # no batch rewrite was applied either. Folding the query now,
    # without the migration, would make Eastern-numeral queries MISS
    # rows they currently find. This check locks in the deferred
    # state — it MUST be flipped to the fold (and the migration run)
    # on day 2.
    assert normalize_arabic("٥٥") == "٥٥"
    assert normalize_arabic("كتاب ١٢٣") == "كتاب ١٢٣"


def test_normalize_arabic_never_folds_waw():
    # NEGATIVE: a leading و is NEVER stripped — "وردة" stays "وردة"
    # (the particle prefixes و/ف/بال/لل are ladder variants in the
    # search endpoint only, never folds in the normalizer).
    assert normalize_arabic("وردة") == "ورده"
    assert normalize_arabic("والكتاب") == "والكتاب"
    # And the forbidden letter folds never happen either.
    assert normalize_arabic("صبر") == "صبر"
    assert normalize_arabic("طريق") == "طريق"
    assert normalize_arabic("ذهب") == "ذهب"
    assert normalize_arabic("قلب") == "قلب"
    assert normalize_arabic("ابن خلدون") == "ابن خلدون"


def test_normalize_for_fts_eastern_numerals_deferred_to_day_2():
    # Same deferral as normalize_arabic (see above): no fold yet.
    from tbi.d1_sync import normalize_for_fts  # noqa: E402

    assert normalize_for_fts("كتاب ٥٥ لغزا") == "كتاب ٥٥ لغزا"
    assert normalize_for_fts("سنة ٢٠٢٦") == "سنه ٢٠٢٦"


def test_normalize_arabic_folds_hamza_forms():
    # Same folds the JS normalizers already had (books.py lacked them).
    assert normalize_arabic("مؤمن") == "مومن"
    assert normalize_arabic("سائل") == "سايل"
    assert normalize_arabic("شيء") == "شي"
    # رؤوف keeps both waws: ؤ -> و, and the original و stays.
    assert normalize_arabic("رؤوف") == "رووف"


def test_normalize_for_fts_folds_persian():
    # The FTS text the migration rewrites (d1_sync.normalize_for_fts).
    from tbi.d1_sync import normalize_for_fts  # noqa: E402

    assert (
        normalize_for_fts("روايه نوستالچيا لنور اسماعيل")
        == "روايه نوستالجيا لنور اسماعيل"
    )
    # Persian ک composes with ال-stripping: الکتاب -> كتاب.
    assert normalize_for_fts("الکتاب") == "كتاب"
    assert normalize_for_fts("مؤمن") == "مومن"


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
