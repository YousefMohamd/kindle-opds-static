"""Book title/author extraction from filenames and message captions.

The index stores files; this module turns a filename + caption into a
searchable (title, author) pair and a dedup key. It is heuristic by
nature — Telegram posts have no standard book format — so every rule
is conservative: when the author cannot be identified it stays empty
rather than guessing wrong.

Supported book formats (the ones the Kindle workflow uses):
EPUB, MOBI, AZW3, KFX, PDF, TXT. KFX is Amazon's current Kindle format;
shares of it are rare on Telegram, but a KFX file counts as a book
exactly like the others. Audio books (MP3/M4B) are out of scope.
"""

from __future__ import annotations

import re
import unicodedata

BOOK_EXTS = {"epub", "mobi", "azw3", "kfx", "pdf", "txt"}

# Noise removed from filenames/captions before parsing.
_NOISE_RES = [
    re.compile(r"\[(?:pdf|epub|mobi|azw3|kfx|kindle|book|ebook)\]", re.IGNORECASE),
    re.compile(r"\((?:pdf|epub|mobi|azw3|kfx|kindle|ebook)\)", re.IGNORECASE),
    re.compile(r"\b(?:pdf|epub|mobi|azw3|kfx)\b\s*$", re.IGNORECASE),
    re.compile(r"\b\d{4}\b\s*$"),  # trailing year ("Title 2019")
    re.compile(r"[\[\(]\d{4}[\]\)]"),  # parenthesised year "(2019)"
    re.compile(r"[\[\(]\s*(?:download|free|كتاب|رواية)\s*[\]\)]", re.IGNORECASE),
]
_SEPARATORS = re.compile(r"\s*[-–—_]\s*")


# Arabic diacritics (harakat, shadda, superscript alef) + tatweel.
_AR_DIACRITICS = re.compile(r"[\u064B-\u0652\u0670\u0640]")
_ALEF_MAP = str.maketrans({"أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا", "ة": "ه", "ى": "ي"})


def normalize_arabic(text: str) -> str:
    """Search normalization for Arabic: strip tashkeel (harakat, shadda,
    superscript alef) and tatweel, unify alef forms (أ إ آ ٱ -> ا),
    ة -> ه and ى -> ي. Display text is never changed — this is only
    for search/dedup, so a plain query like "متون" finds a filename
    stored as "مُتَوِّنُ"."""
    text = unicodedata.normalize("NFKC", text or "")
    text = _AR_DIACRITICS.sub("", text)
    return text.translate(_ALEF_MAP)


def normalize_filename(name: str) -> str:
    """Unicode-normalize, strip the extension's surrounding junk, keep the
    readable name. Does NOT remove the extension."""
    name = unicodedata.normalize("NFKC", name or "")
    name = name.replace("\u00a0", " ").strip()
    return name


def _clean(raw: str) -> str:
    text = normalize_filename(raw)
    # Drop the file extension for title parsing.
    text = re.sub(r"\.(?:epub|mobi|azw3|kfx|pdf|txt)$", "", text, flags=re.IGNORECASE)
    for rx in _NOISE_RES:
        text = rx.sub("", text)
    # Collapse repeated separators/spaces left by the removals.
    # NOTE: do not strip parentheses here — "(Author)" is structural
    # and the parens rule below needs the closing paren.
    text = re.sub(r"\s+", " ", text).strip(" -–—_[]")
    return text.strip()


def _looks_like_author(part: str, max_words: int = 4) -> bool:
    """A part looks like a person name: a few words, no digits, not a
    generic label. Arabic names with ibn-chains ("سعيد بن علي بن وهف
    القحطاني") run longer, so callers with an explicit author marker
    (e.g. "تأليف:") pass a larger max_words."""
    part = part.strip()
    if not part or len(part) > 60:
        return False
    if re.search(r"\d", part):
        return False
    words = part.split()
    if not (1 <= len(words) <= max_words):
        return False
    if part.lower() in {
        "download", "free", "ebook", "book", "pdf", "epub", "kindle",
        "كتاب", "رواية", "مجانا", "تحميل",
    }:
        return False
    return True


def parse_title_author(filename: str, caption: str = "") -> tuple[str, str]:
    """Return (title, author) from a filename, falling back to the caption.

    Handles the common shapes seen in book shares:
      * "Title - Author.ext" / "Author - Title.ext"
      * "Title by Author.ext"
      * "Title (Author).ext"
      * bare "Title.ext" (author empty; caption may supply it)
    The author is the part that looks like a person name; when both
    parts look like names, the LAST part is taken as the author (the
    "Title - Author" shape is the most common in these groups).
    """
    clean = _clean(filename)
    title, author = clean, ""
    # "Title (Author)"
    m = re.match(r"^(?P<title>.+?)\s*\((?P<author>[^()]{1,60})\)\s*$", clean)
    if m and _looks_like_author(m.group("author")):
        return m.group("title").strip(), m.group("author").strip()
    # "Title by Author"
    m = re.match(
        r"^(?P<title>.+?)\s+by\s+(?P<author>.+?)\s*$", clean, flags=re.IGNORECASE
    )
    if m and _looks_like_author(m.group("author")):
        return m.group("title").strip(), m.group("author").strip()
    # "A - B": pick the author-looking part; prefer the last part.
    parts = [p for p in _SEPARATORS.split(clean) if p.strip()]
    if len(parts) >= 2:
        if _looks_like_author(parts[-1]) and not _looks_like_author(parts[0]):
            return " - ".join(parts[:-1]).strip(), parts[-1].strip()
        if _looks_like_author(parts[-1]) and _looks_like_author(parts[0]):
            return " - ".join(parts[:-1]).strip(), parts[-1].strip()
        if _looks_like_author(parts[0]) and not _looks_like_author(parts[-1]):
            return " - ".join(parts[1:]).strip(), parts[0].strip()
    # Caption fallback: "author: ..." / "by ..." / "للكاتب ..."
    cap = (caption or "").strip()
    if cap:
        m = re.search(
            r"(?:author|by|للكاتب|للمؤلف|تأليف)\s*[:：]?\s*([^\n,؛]{2,60})",
            cap,
            flags=re.IGNORECASE,
        )
        if m and _looks_like_author(m.group(1), max_words=8):
            author = m.group(1).strip()
    return title, author


def _norm_key(text: str) -> str:
    """Normalize for dedup/search: NFKC, Arabic search normalization
    (diacritics stripped, alef forms unified), lowercase, collapse
    spaces, strip punctuation that varies between shares."""
    text = normalize_arabic(text or "").lower()
    text = re.sub(r"[^\w\s\u0600-\u06FF]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def dedupe_key(title: str, author: str, size_bytes: int | None) -> str:
    """Same book shared twice (same title + author, same size) collapses
    to one key. Size is included because two different books can share
    a title; when size is unknown the key is title+author only."""
    base = f"{_norm_key(title)}|{_norm_key(author)}"
    return f"{base}|{size_bytes}" if size_bytes else base


def format_size(size_bytes: int | None) -> str | None:
    """Bytes -> the display text the preview uses ("12.3 MB", "985.7 KB").

    The inverse of :func:`tbi.scrape.parse_size`: used when a size is
    known as bytes (API messages, submitted books) but no display text
    was given. Returns None for an unknown size.
    """
    if size_bytes is None:
        return None
    size = float(size_bytes)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            text = f"{size:.1f}".rstrip("0").rstrip(".")
            return f"{text} {unit}"
        size /= 1024
    return None
