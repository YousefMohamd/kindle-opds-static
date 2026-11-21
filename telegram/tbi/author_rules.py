"""Self-maintaining author rules — the ONE canonical module.

The D1 catalog has a systematic author problem (verified 2026-11-14):
8,118 distinct single-word authors on 24,378 books (~49% of the
catalog). Many are NOT names — countries (الإمارات/مصر/الكويت),
generic words (مجلة/ملحق/موسوعة), junk (sk/lib.sk), pronouns
(في/فيها/من) — but many ARE real surnames (البخاري, الطبري,
السيوطي, الفوزان) that must NOT be cleared.

This module is the single source of truth for the author-cleaning
rules. Every path that writes a book into the catalog MUST apply
``clean_author`` to the parsed (title, author) BEFORE the book is
stored, so new books enter the catalog CLEAN instead of piling up
more wrong authors:

  * ``tbi.books.parse_title_author`` — the backfill + daily sync
    (``tbi.cli``) and the realtime sync (``tbi.live``) both call it,
    so one call site covers all three.
  * The bot's ``src/group-index.ts`` (``parseTitleAuthor``) is a
    TypeScript PORT of the same function and applies the same rules
    (``src/author-rules.ts`` — a mirror of this module, same
    denylist, same fragment rule) so a live book and a backfilled
    book for the same file parse to the same title/author/dedupe_key.
  * The bot's search display (``src/search.ts`` ``cleanAuthor``)
    applies the same rules at display time, so a stale D1 row with
    a denylisted/fragment author is dropped even before the
    maintenance pass cleans it.

The rules (cheap and deterministic — NO API calls at index time):

  (a) Title-fragment rule: a single-word author that appears as a
      word in the title is dropped (it is a fragment of the title,
      an indexer mis-parse, not a name). Port of the bot's
      ``isTitleFragmentAuthor`` (v4.8.27). A multi-word author is
      never a fragment, and a 1-letter author is never a fragment.
  (b) Denylist: a single-word author that is a country/place, a
      generic word, junk, or a pronoun/preposition is dropped.
      The denylist is CONSERVATIVE — it contains ONLY values that
      are clearly NOT a person's name. Real surnames (البخاري,
      الطبري, السيوطي, الفوزان, المزي, عثيمين, توفيق, محمد, أحمد,
      علي, نبيل, القاسم, ...) are NOT in it and stay.
  (c) Anything else (a plausible surname, a multi-word name) is
      LEFT ALONE at index time. The bot's runtime lookup
      (Open Library / Google Books, ``src/google-books.ts``)
      verifies single-word/empty authors at SEARCH time only —
      calling an API for every book at index time would be far too
      slow and too many calls for bulk indexing.

Normalization matches the bot's ``normalizeArabic`` / ``normalizeQuery``
(``src/search.ts``) and the D1 endpoint's normalization
(``tbi/d1_sync.py``): NFKC, strip tashkeel/tatweel, unify alef forms
(أ إ آ ٱ -> ا), ؤ -> و, ئ -> ي, ء removed, ة -> ه, ى -> ي,
lowercase. Bidi control characters are stripped too (a D1 author
"‎⁨مصر" with a bidi mark is still just "مصر").

The denylist is stored in its RAW display form and normalized at
import time (``_DENYLIST_NORM``), so matching is a set lookup on the
normalized author. The comparison "squashes" the author (removes
every non-letter/non-digit, so "sk," and "lib.sk)" match "sk" and
"libsk") — a multi-word author can only match if its whole squashed
form equals a denylist entry, which never happens for a real name.
"""

from __future__ import annotations

import re
import unicodedata

# Bidi / directional control characters (a D1 author can carry them).
_BIDI = re.compile(r"[\u200e\u200f\u202a-\u202e\u2066-\u2069]")
# Arabic diacritics (harakat, shadda, superscript alef) + tatweel.
_AR_DIACRITICS = re.compile(r"[\u064B-\u0652\u0670\u0640]")
# Anything that is not a letter or a digit (used to split / squash).
_NON_ALNUM = re.compile(r"[^\w\u0600-\u06FF]", re.UNICODE)


def normalize_for_author(text: str) -> str:
    """Search normalization for author checks (mirrors the bot's
    ``normalizeArabic`` + lowercase + single spaces). Display text is
    never changed — this is only for the fragment/denylist checks."""
    s = unicodedata.normalize("NFKC", text or "")
    s = _BIDI.sub("", s)
    s = _AR_DIACRITICS.sub("", s)
    s = (
        s.replace("أ", "ا")
        .replace("إ", "ا")
        .replace("آ", "ا")
        .replace("ٱ", "ا")
        .replace("ؤ", "و")
        .replace("ئ", "ي")
        .replace("ء", "")
        .replace("ى", "ي")
        .replace("ة", "ه")
    )
    return re.sub(r"\s+", " ", s.lower()).strip()


def word_tokens(normalized: str) -> list[str]:
    """Split normalized text into word tokens (letters/digits only —
    punctuation, hyphens and separators are word boundaries).
    Mirrors the bot's ``wordTokens``."""
    return [t for t in _NON_ALNUM.split(normalized) if t]


def strip_definite_article(word: str) -> str:
    """Strip the Arabic definite article "ال" from the front of a
    word (a bare "ال" is left alone). Mirrors the bot."""
    return word[2:] if word.startswith("ال") and len(word) > 2 else word


def _squash(text: str) -> str:
    """Remove every non-letter/non-digit from the normalized text,
    so "sk," -> "sk" and "lib.sk)" -> "libsk". Used only for the
    denylist lookup."""
    return re.sub(r"[^\w\u0600-\u06FF]", "", normalize_for_author(text))


# --- the denylist ----------------------------------------------------------
# RAW display forms (normalized at import time into _DENYLIST_NORM).
# CONSERVATIVE: only values that are clearly NOT a person's name.
# Deliberately EXCLUDED (real surnames / first names — they stay):
#   البخاري, الطبري, السيوطي, الفوزان, المزي, عثيمين, توفيق, محمد,
#   أحمد, علي, نبيل, القاسم, مطهري, العباسي, العثماني (as a surname),
#   Noor, Jolly, فضل, فتح, السيد, الدين, الكريم.
# Each entry below was verified in the D1 audit (top single-word
# authors by count, 2026-11-14) as a non-name.

# Countries / places (Arabic).
_DENYLIST_COUNTRIES_AR = [
    "الإمارات", "مصر", "الكويت", "عمان", "البحرين", "قطر", "لندن",
    "اليمن", "فلسطين", "الأردن", "العراق", "لبنان", "السعودية",
    "دبي", "السعودي",
]
# Countries / places (English — lowercased by normalization).
_DENYLIST_COUNTRIES_EN = ["qatar", "oman", "kuwait"]
# Generic words — a magazine, a supplement, an encyclopedia, an
# ordinal, a language, a scripture, a subject, a title, a greeting.
# None of these is a person's name.
_DENYLIST_GENERIC = [
    "المتميزون", "مجلة", "ملحق", "موسوعة", "الثاني", "الأول", "الثالث",
    "العربي", "العربية", "الإسلامي", "الإسلامية", "الإسلام", "القرآن",
    "الحديث", "تفسير", "تاريخ", "الكتب", "سلسلة", "دراسة", "هجرية",
    "إعراب", "الخاصة", "حاشية", "السلام", "نظم", "نهاية", "النبوية",
    "عمدة", "أسلوبية", "الميزان", "للقراءة", "العثمانية", "الاضواء",
    "شرح", "مجموع", "المعاصر", "جريدة", "دكتور", "الله", "والسنة",
]
# Junk — domain fragments, file/website names, single letters.
_DENYLIST_JUNK = [
    "sk,", "sk", "lib.sk)", "lib", "Foulabook.com", "Science",
    "englishare", "almanahil", "A", "z", "s", "com", "،العدد",
]
# Pronouns / prepositions — clearly not a name.
_DENYLIST_PRONOUNS = ["في", "فيها", "من"]
# Known-wrong single-word authors from the user reports.
_DENYLIST_KNOWN = ["المصري", "وخاطئة"]

_DENYLIST_RAW: list[str] = (
    _DENYLIST_COUNTRIES_AR
    + _DENYLIST_COUNTRIES_EN
    + _DENYLIST_GENERIC
    + _DENYLIST_JUNK
    + _DENYLIST_PRONOUNS
    + _DENYLIST_KNOWN
)

# Normalized (squashed) forms — the lookup set.
_DENYLIST_NORM: frozenset[str] = frozenset(_squash(e) for e in _DENYLIST_RAW)


def denylist_size() -> int:
    """Number of distinct normalized denylist entries."""
    return len(_DENYLIST_NORM)


def is_denylisted_author(author: str) -> bool:
    """True when the author (a single word) is in the denylist.
    A multi-word author is never denylisted (it can only match if
    its whole squashed form equals a denylist entry, which never
    happens for a real name)."""
    if not author or not author.strip():
        return False
    return _squash(author) in _DENYLIST_NORM


def is_title_fragment_author(author: str, title: str) -> bool:
    """True when the author is a single word that appears as a word
    in the title — i.e. the "author" is really a fragment of the
    title (an indexer mis-parse), not a real name. Compared on the
    normalized form, with the Arabic definite article "ال" stripped
    from both sides, so "جلاد" matches the title word "الجلاد".
    A multi-word author is never a fragment, and a 1-letter author
    is never a fragment. Port of the bot's ``isTitleFragmentAuthor``."""
    author_tokens = word_tokens(normalize_for_author(author))
    if len(author_tokens) != 1:
        return False
    author_word = strip_definite_article(author_tokens[0])
    if len(author_word) < 2:
        return False
    title_words = word_tokens(normalize_for_author(title))
    return any(strip_definite_article(w) == author_word for w in title_words)


def clean_author(title: str, author: str) -> str:
    """Clean an author for storage: "" when it is missing, a
    denylisted word, or a fragment of the title — unless a clear
    person's name can be recovered from the end of the title (see
    ``extract_author_from_title``). Otherwise the original author
    (stripped) is returned unchanged — a plausible surname or a
    multi-word name is never touched at index time (the bot's
    runtime lookup verifies it at search time)."""
    author = (author or "").strip()
    if not author:
        return extract_author_from_title(title)
    if is_denylisted_author(author):
        return extract_author_from_title(title)
    if is_title_fragment_author(author, title):
        return extract_author_from_title(title)
    return author


# --- title-embedded author extraction --------------------------------------
# Words that are never a person's name when they stand alone as a
# title part (prepositions, adverbs, demonstratives, quantifiers).
# Used ONLY by extract_author_from_title, so a title ending in
# "... - تحت - جلدي" is never mistaken for a person's name.
_TITLE_FUNCTION_WORDS = frozenset(
    normalize_for_author(w)
    for w in [
        "تحت", "فوق", "في", "من", "إلى", "على", "مع", "بعد", "قبل",
        "بين", "عند", "لدى", "دون", "غير", "كل", "هذا", "هذه",
        "ذلك", "تلك", "هو", "هي", "كان", "يكون", "قد", "لم", "لن",
        "ما", "لا", "نحو", "حول", "ضد", "عبر", "منذ", "حتى",
    ]
)


def extract_author_from_title(title: str) -> str:
    """Recover a person's name embedded at the END of a title.

    Some filenames end with the author's name after the title, e.g.
    "الجلاد - تحت - جلدي - عماد - رشاد" (the book is by عماد رشاد).
    When the author is missing/wrong and the title's last two
    '-'-separated parts together form a plausible 2-word person's
    name, return it (in the title's own spelling). Otherwise "".

    Conservative by design:
      * needs at least 3 title parts (a title part + 2 name parts);
      * the FIRST of the two parts must be a common Arabic first
        name (``_FIRST_NAMES``) — this is what separates a person's
        name ("عماد رشاد") from a title phrase ("الشروط المجحفة");
      * the second part must be a SINGLE word, 2+ chars, no digits;
      * neither word may be denylisted or a title function word
        (prepositions etc. — "تحت جلدي" is never a name);
      * the returned name is the title's own spelling (e.g. "عماد
        رشاد" — the canonical spelling "عماد راشد" is a D1-cleanup /
        runtime-lookup concern, not an index-time guess).
    Returns "" whenever the pattern is not clear — better empty
    than a wrong author.
    """
    parts = [p.strip() for p in re.split(r"\s*[-–—_]\s*", title or "") if p.strip()]
    if len(parts) < 3:
        return ""
    last_two = parts[-2:]
    words = [word_tokens(normalize_for_author(p)) for p in last_two]
    if len(words[0]) != 1 or len(words[1]) != 1:
        return ""
    w1, w2 = words[0][0], words[1][0]
    if len(w1) < 2 or len(w2) < 2:
        return ""
    if re.search(r"\d", w1) or re.search(r"\d", w2):
        return ""
    if _squash(w1) in _DENYLIST_NORM or _squash(w2) in _DENYLIST_NORM:
        return ""
    if w1 in _TITLE_FUNCTION_WORDS or w2 in _TITLE_FUNCTION_WORDS:
        return ""
    if _squash(w1) not in _FIRST_NAMES_NORM:
        return ""
    return f"{last_two[0]} {last_two[1]}"


# Common Arabic first (given) names — the first word of a recovered
# 2-word author name must be one of these. This is what separates a
# person's name ("عماد رشاد") from a title phrase ("الشروط المجحفة").
# Curated, not exhaustive: a name missing from this list simply means
# no extraction (the author stays empty and the runtime lookup tries).
_FIRST_NAMES = [
    "عماد", "محمد", "أحمد", "علي", "حسن", "حسين", "مصطفى", "محمود",
    "إبراهيم", "يوسف", "خالد", "عمر", "سعيد", "سالم", "ناصر", "فهد",
    "راشد", "رشاد", "طارق", "زياد", "ماجد", "سامي", "هاني", "وليد",
    "عادل", "جمال", "كمال", "نبيل", "فارس", "ماهر", "باسم", "رامي",
    "شريف", "حاتم", "إيهاب", "أيمن", "أشرف", "هشام", "عصام", "بلال",
    "ياسر", "عمرو", "طه", "أنس", "حمزة", "جعفر", "قاسم", "عباس",
    "سفيان", "إسماعيل", "سليمان", "داود", "زكريا", "يحيى", "موسى",
    "عيسى", "آدم", "نوح", "أيوب", "يونس", "شعيب", "هود", "صالح",
    "إدريس", "إسحاق", "يعقوب", "هارون", "ذو", "لقمان", "إلياس",
    "اليسع", "عزير", "خضر", "عبد", "فاطمة", "عائشة", "خديجة",
    "مريم", "زينب", "أسماء", "سلمى", "ليلى", "نور", "هدى", "آية",
    "سارة", "منى", "هبة", "رنا", "دينا", "شيماء", "أمل", "إيمان",
    "سعاد", "نادية", "فريدة", "جميلة", "لطيفة", "عزيزة", "حليمة",
    "رشيدة", "سميرة", "كريمة", "نجاة", "سعيدة", "فوزية", "حنان",
]
_FIRST_NAMES_NORM: frozenset[str] = frozenset(_squash(n) for n in _FIRST_NAMES)
