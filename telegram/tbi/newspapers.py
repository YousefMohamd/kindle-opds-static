"""Daily newspapers (``جرائد اليوم``) — direct message links only.

What this is: a tiny daily generator that reads the recent posts of the
newspaper hub channels on Telegram and emits ``site/newspapers.json``
— newspaper name + country/flag + date + a DIRECT LINK to the Telegram
message holding that paper's PDF. One click on an entry opens that
exact message (``t.me/<handle>/<post_id>``), so the PDF is right there
to download from Telegram. Nothing is downloaded, stored, or indexed
here: no newspaper PDF ever touches this repo or the site, and no entry
ever links to a bare channel page.

The link is built deterministically from the entry's own ``post_id``
and ``handle`` (see :func:`message_url_for_post`): for a channel with a
public username the link is ``t.me/<handle>/<post_id>``; for a channel
with no public username (invite-link sources) it is the
``t.me/c/<channel_id>/<post_id>`` form, using the numeric channel id
from the API invite check (the ``-100`` prefix stripped). A post for
which NEITHER form can be built yields no entry at all — a broken or
channel-page link is never emitted.

The flag on an entry is the COUNTRY's flag (🇪🇬 Egypt, 🇸🇦 Saudi
Arabia, 🇦🇪 UAE, 🇶🇦 Qatar, 🇰🇼 Kuwait, 🇬🇧 London/UK, ...), never a
per-newspaper flag. The output groups papers per country
(``countries`` list, Egypt first) so the pages can show one sub-link /
section per country.

Sources (verified 2026-11-12, read-only, no login, no join):
  * Hub — ``@arabJournalism`` ("الصحف الخليجية والعربية", ~8,625
    subscribers; directory listing: "قناة تعنى بنشر الصحف العربية
    اليومية PDF الصادرة من جميع اقطار الوطن العربي"). PUBLIC, but its
    ``t.me/s/`` preview currently serves only the info card — the
    preview 302-redirects to ``t.me/arabJournalism`` and renders ZERO
    posts (verified live; the control channel ``t.me/s/telegram``
    renders 20 posts from the same machine, so this is channel-side,
    not a fetcher problem). ``tbi.scrape.classify`` reports it as
    ``no_preview``. The preview path is still tried first every run
    (it may come back), and the API path below is what actually reads
    the hub today.
  * Fallback 1 — invite link ``t.me/joinchat/VGPv_tnlgUJlNjdl``
    ("الصحف اليومية - م.محمد" — daily Arab papers). Invite links have
    no ``t.me/s/`` preview at all, so this source is API-only. Its
    posts start with "جرايد مصر" and then the files follow, sometimes
    with no paper name in the file itself — see :func:`extract_names`.
  * Fallback 2 — invite link ``t.me/+5XWeEDd4wUczZTQ0`` ("Egyptian
    Newspapers (الجرائد المصرية)" — Egyptian papers as PDF). PRIVATE:
    the owner's join request is PENDING, not accepted. This generator
    NEVER attempts to join anything — the source is reported
    ``unavailable_pending_join`` until the owner is a member, and only
    then can the API path read it.

Reading paths (in order, per source):
  1. Public preview (``tbi.scrape``) — no credentials, same as the
     daily book sync. Username sources only.
  2. MTProto API (Telethon, optional) — only when the standard
     ``TELEGRAM_API_ID`` / ``TELEGRAM_API_HASH`` /
     ``TELEGRAM_SESSION_STRING`` env vars are present (the same
     GitHub Actions secrets as ``tbi api-backfill``; never in the
     repo, never logged). Reads recent messages only, metadata only,
     no file downloads. Invite-link sources are checked with
     ``CheckChatInviteRequest`` (read-only info, NOT a join) and read
     only if the account is ALREADY a member (``ChatInviteAlready``);
     ``ImportChatInviteRequest`` (join) is never called anywhere in
     this module. Without credentials the API sources report
     ``unavailable_no_credentials`` and are skipped.

Daily rotation: the generator OVERWRITES ``site/newspapers.json`` on
every run, so yesterday's papers disappear the moment today's are
written. If no source yields a paper for the day, the file is still
written — with empty lists and ``"empty": true`` — and the pages show
"لا يوجد جرائد اليوم" instead of rendering broken or stale papers.

Static pages (Kindle browser): the home page's newspapers card
(``index.html``) and the per-country page (``site/newspapers/index.html``)
do NOT fetch ``newspapers.json`` with JavaScript — the Kindle's
built-in browser has no ``fetch`` (old WebKit) and the fetch-based
pages failed with error 175 and showed nothing. Instead the generator
bakes the day's list directly into both pages as plain HTML at
generation time (see :func:`write_pages`): the pages carry
``<!-- NEWSPAPERS-STATIC-BEGIN -->`` / ``<!-- NEWSPAPERS-STATIC-END -->``
markers and only the content between them is replaced, so the rest of
each page is never touched. The JSON file is still written (other uses),
but no page depends on it. The daily workflow regenerates the pages
every morning, so the baked content stays fresh; it must commit the
two HTML pages alongside the JSON (see
``.github/workflows/telegram-newspapers.yml``).

Classification (Arab-wide, grouped by country — user decision
2026-11-14: ALL Arab papers are kept, Egyptian-only was rejected):
a paper's country comes first from an explicit country prefix in its
title (``الأردن الدستور`` → Jordan, ``الإمارات الفجر`` → UAE,
``مصر الأهرام`` → Egypt) — the hub's own ``COUNTRY PAPER`` format —
then from :data:`KNOWN_PAPERS`, then from a country hint in the post,
then from the source's default country. The prefix wins over the
paper map on purpose: ``الدستور`` alone is Egyptian, but ``الأردن
الدستور`` is Jordan's paper. Ambiguous names (``الأخبار`` — Egypt AND
Lebanon; ``الوطن`` — Qatar AND Egypt; ``النهار`` is mapped LB,
``الشروق`` is mapped EG) are NEVER guessed: with no hint they land in
``other`` with country ``XX`` (🌍) and are listed in ``unmatched`` in
the output so the map can grow from real posts instead of guesses.
Titles are cleaned first (see :func:`clean_filename`): dates (Arabic,
English, numeric), trailing numbers, emojis, section headers and
invisible characters are stripped, Latin all-caps / all-lowercase
titles are title-cased, and titles that are only a URL, a UUID, a
bare date, a flag emoji or a country name are dropped — they name no
paper — and recorded in the output's ``dropped`` list with a reason.
Names are NFC-normalized before matching (the hub posts combining
hamza U+0654/U+0655, which otherwise breaks every Arabic match).

Evening editions: a title containing ``مسائي`` / ``المسائي`` (or
``evening``) is an evening edition of that paper, NOT a morning one:
the entry carries ``"edition": "evening"`` and the pages render
evening papers in a separate ``المسائية`` group inside the same
country section, never mixed into the morning list. (``المساء`` on
its own is a paper name, not an evening marker.)

Run from the repo root (or pass ``--out``)::

    python3 -m tbi.newspapers --out site/newspapers.json
    python3 -m tbi.newspapers --out site/newspapers.json --date 2026-11-12
    python3 -m tbi.newspapers --out site/newspapers.json --no-api
    python3 -m tbi.newspapers --out site/newspapers.json --write-empty

Exit code is 0 whenever the file was written (even an empty-day file:
source failures are recorded in the file's ``sources`` list, not
raised). A non-zero exit means the file itself could not be written.
"""

from __future__ import annotations

import argparse
import asyncio
import html
import json
import os
import re
import sys
import tempfile
import unicodedata
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

try:
    from zoneinfo import ZoneInfo
except ImportError:  # Python < 3.9 — not expected (project needs >= 3.9)
    ZoneInfo = None  # type: ignore[assignment]

from . import scrape
from .scrape import Post

CAIRO_TZ = ZoneInfo("Africa/Cairo") if ZoneInfo is not None else timezone(timedelta(hours=2))

# ---------------------------------------------------------------------------
# Sources
# ---------------------------------------------------------------------------

SOURCES = [
    {
        "key": "arabJournalism",
        "kind": "username",
        "label": "الصحافة العربية",
        "default_country": None,
    },
    {
        "key": "joinchat/VGPv_tnlgUJlNjdl",
        "kind": "invite",
        "invite_hash": "VGPv_tnlgUJlNjdl",
        "label": "الصحف اليومية - م.محمد",
        "default_country": None,
    },
    {
        "key": "+5XWeEDd4wUczZTQ0",
        "kind": "invite",
        "invite_hash": "5XWeEDd4wUczZTQ0",
        "label": "Egyptian Newspapers (الجرائد المصرية)",
        "default_country": "EG",
        "pending_join": True,
    },
]

# ---------------------------------------------------------------------------
# Countries, flags, regions
# ---------------------------------------------------------------------------

COUNTRIES = {
    "EG": {"name": "مصر", "flag": "🇪🇬", "region": "egypt"},
    "SA": {"name": "السعودية", "flag": "🇸🇦", "region": "gulf"},
    "AE": {"name": "الإمارات", "flag": "🇦🇪", "region": "gulf"},
    "QA": {"name": "قطر", "flag": "🇶🇦", "region": "gulf"},
    "KW": {"name": "الكويت", "flag": "🇰🇼", "region": "gulf"},
    "BH": {"name": "البحرين", "flag": "🇧🇭", "region": "gulf"},
    "OM": {"name": "عُمان", "flag": "🇴🇲", "region": "gulf"},
    "LB": {"name": "لبنان", "flag": "🇱🇧", "region": "arab"},
    "JO": {"name": "الأردن", "flag": "🇯🇴", "region": "arab"},
    "IQ": {"name": "العراق", "flag": "🇮🇶", "region": "arab"},
    "SY": {"name": "سوريا", "flag": "🇸🇾", "region": "arab"},
    "YE": {"name": "اليمن", "flag": "🇾🇪", "region": "arab"},
    "SD": {"name": "السودان", "flag": "🇸🇩", "region": "arab"},
    "LY": {"name": "ليبيا", "flag": "🇱🇾", "region": "arab"},
    "TN": {"name": "تونس", "flag": "🇹🇳", "region": "arab"},
    "DZ": {"name": "الجزائر", "flag": "🇩🇿", "region": "arab"},
    "MA": {"name": "المغرب", "flag": "🇲🇦", "region": "arab"},
    "PS": {"name": "فلسطين", "flag": "🇵🇸", "region": "arab"},
    "MR": {"name": "موريتانيا", "flag": "🇲🇷", "region": "arab"},
    "GB": {"name": "لندن", "flag": "🇬🇧", "region": "london"},
}
UNKNOWN_COUNTRY = {"name": "غير محدد", "flag": "🌍", "region": "other"}

# Region display order on the /newspapers/ page.
REGION_ORDER = ["gulf", "london", "arab", "other"]
REGION_LABELS = {
    "gulf": "صحف خليجية",
    "london": "صحف لندن",
    "arab": "صحف عربية أخرى",
    "other": "صحف أخرى (غير محدد بلدها)",
}

# Per-country display order for the ``countries`` list in the output
# and the sub-link nav on the pages: Egypt first, then the Gulf states
# (Saudi, UAE, Qatar, Kuwait, Bahrain, Oman), then London, then the
# other Arab countries, then unknown (XX) last.
COUNTRY_ORDER = ["EG", "SA", "AE", "QA", "KW", "BH", "OM", "GB",
                 "LB", "JO", "IQ", "SY", "YE", "SD", "LY", "TN", "DZ", "MA",
                 "PS", "MR"]


def message_url_for_post(post: Post):
    """(post) -> (url, handle), the DIRECT link to that exact message.

    ``https://t.me/<handle>/<post_id>`` when the post's channel is a
    public username; ``https://t.me/c/<channel_id>/<post_id>`` (numeric
    id, ``-100`` prefix stripped) when the channel has no public
    username but its numeric id is known (API invite-link sources).
    Returns ``(None, None)`` when neither form can be built — the
    caller drops such a post instead of emitting a channel-page or
    broken link. ``handle`` is the public username, or ``None`` for the
    ``t.me/c/`` form.
    """
    handle = (post.channel or "").strip()
    if handle and "/" not in handle and not handle.startswith("+"):
        return f"https://t.me/{handle}/{post.post_id}", handle
    channel_id = getattr(post, "channel_id", None)
    if channel_id:
        digits = str(channel_id)
        if digits.startswith("-100"):
            digits = digits[4:]
        elif digits.startswith("-"):
            digits = digits[1:]
        if digits.isdigit():
            return f"https://t.me/c/{digits}/{post.post_id}", None
    return None, None

# ---------------------------------------------------------------------------
# Newspaper name -> country.
#
# Only UNAMBIGUOUS names live here. Ambiguous names (الأخبار: مصر ولبنان؛
# الوطن: قطر ومصر؛ العرب: قطر ولندن؛ الصباح: تونس والعراق) are deliberately
# absent — with no country hint in the post they classify as unknown
# (country XX) instead of being guessed. Longer, country-qualified names
# are matched before their short form (see classify()).
# ---------------------------------------------------------------------------

KNOWN_PAPERS = {
    # Egypt
    "الأهرام": "EG",
    "الأهرام المسائي": "EG",
    "الجمهورية": "EG",
    "المصري اليوم": "EG",
    "الشروق": "EG",
    "اليوم السابع": "EG",
    "الدستور": "EG",
    "الوفد": "EG",
    "الفجر": "EG",
    "روز اليوسف": "EG",
    "روزاليوسف": "EG",
    "أكتوبر": "EG",
    "المساء": "EG",
    "صوت الأمة": "EG",
    "الأهالي": "EG",
    "البوابة": "EG",
    "التحرير": "EG",
    # Gulf
    "الرياض": "SA",
    "عكاظ": "SA",
    "الجزيرة": "SA",
    "المدينة": "SA",
    "الاقتصادية": "SA",
    "الوطن السعودية": "SA",
    "الاتحاد": "AE",
    "البيان": "AE",
    "الإمارات اليوم": "AE",
    "القبس": "KW",
    "الراي": "KW",
    "الأنباء": "KW",
    "السياسة": "KW",
    "الشرق": "QA",
    "الراية": "QA",
    "الوطن القطرية": "QA",
    # London
    "الشرق الأوسط": "GB",
    "القدس العربي": "GB",
    # Other Arab
    "النهار": "LB",
    "الأخبار اللبنانية": "LB",
    "الديار": "LB",
    "الرأي": "JO",
    "الدستور الأردنية": "JO",
    "الغد": "JO",
    "المدى": "IQ",
    "الشروق التونسية": "TN",
    "الحياة الجديدة": "PS",
    # English / transliterated names, as the hub posts them (matched
    # case-insensitively — see normalize_arabic). Observed live
    # 2026-11-14 on the Arabic_News_Papers posts: "AKHBAR ELYOUM",
    # "alwafd", "AL ahram 14 11", "MASA 121338", "Saudi Gazette",
    # "Arab News", "QATAR GT".
    "al ahram": "EG",
    "alwafd": "EG",
    "al wafd": "EG",
    "akhbar elyoum": "EG",
    "akhbar al youm": "EG",
    "akhbar alyoum": "EG",
    "masa": "EG",
    "saudi gazette": "SA",
    "arab news": "SA",
    "gulf times": "QA",
    "qatar gt": "QA",
}

# Canonical display form for the English / transliterated names above
# (keyed by normalized name): title-casing alone would give "Alwafd"
# or "Qatar Gt", so the known form wins for display.
ENGLISH_DISPLAY = {
    "al ahram": "Al Ahram",
    "alwafd": "Al Wafd",
    "al wafd": "Al Wafd",
    "akhbar elyoum": "Akhbar Elyoum",
    "akhbar al youm": "Akhbar Elyoum",
    "akhbar alyoum": "Akhbar Elyoum",
    "masa": "Masa",
    "saudi gazette": "Saudi Gazette",
    "arab news": "Arab News",
    "gulf times": "Gulf Times",
    "qatar gt": "Qatar GT",
}

# Country hint words in a post's text/filename -> country. Checked only
# when the name itself is not in KNOWN_PAPERS (a hint never overrides a
# mapped name — "الشروق التونسية" is in the map as TN already).
COUNTRY_HINTS = [
    ("مصر", "EG"),
    ("مصرية", "EG"),
    ("القاهرة", "EG"),
    ("السعودية", "SA"),
    ("الرياض", "SA"),
    ("جدة", "SA"),
    ("الإمارات", "AE"),
    ("دبي", "AE"),
    ("أبوظبي", "AE"),
    ("ابوظبي", "AE"),
    ("قطر", "QA"),
    ("الدوحة", "QA"),
    ("الكويت", "KW"),
    ("البحرين", "BH"),
    ("المنامة", "BH"),
    ("عمان", "OM"),
    ("مسقط", "OM"),
    ("لبنان", "LB"),
    ("بيروت", "LB"),
    ("الأردن", "JO"),
    ("العراق", "IQ"),
    ("بغداد", "IQ"),
    ("سوريا", "SY"),
    ("دمشق", "SY"),
    ("اليمن", "YE"),
    ("صنعاء", "YE"),
    ("السودان", "SD"),
    ("الخرطوم", "SD"),
    ("ليبيا", "LY"),
    ("طرابلس", "LY"),
    ("تونس", "TN"),
    ("الجزائر", "DZ"),
    ("المغرب", "MA"),
    ("الرباط", "MA"),
    ("فلسطين", "PS"),
    ("القدس", "PS"),
    ("غزة", "PS"),
    ("رام الله", "PS"),
    ("موريتانيا", "MR"),
    ("نواكشوط", "MR"),
    ("لندن", "GB"),
    # English hint words (matched on the lower-cased normalized text).
    ("egypt", "EG"),
    ("egyptian", "EG"),
    ("saudi", "SA"),
    ("emirates", "AE"),
    ("uae", "AE"),
    ("qatar", "QA"),
    ("kuwait", "KW"),
    ("bahrain", "BH"),
    ("oman", "OM"),
    ("lebanon", "LB"),
    ("jordan", "JO"),
    ("iraq", "IQ"),
    ("syria", "SY"),
    ("yemen", "YE"),
    ("sudan", "SD"),
    ("libya", "LY"),
    ("tunisia", "TN"),
    ("algeria", "DZ"),
    ("morocco", "MA"),
    ("palestine", "PS"),
    ("mauritania", "MR"),
    ("london", "GB"),
]

# Country-name prefix of a title -> country. The hub posts papers as
# "COUNTRY PAPER" ("مصر الأهرام", "الأردن الدستور", "الإمارات الفجر",
# "QATAR GT", "Saudi Gazette"): a leading country word is the
# strongest signal and is checked BEFORE the paper-name map, so a
# qualified name is never misread through its short form ("الدستور"
# alone is Egyptian, "الأردن الدستور" is Jordanian). Keys are
# NORMALIZED forms (see normalize_arabic: "الإمارات" -> "الامارات",
# "عُمان" -> "عمان", lower-cased Latin) and are matched at the start
# of the title on a word boundary. Multi-word forms ("saudi arabia")
# are tried longest-first.
COUNTRY_PREFIXES = [
    ("السعوديه", "SA"),
    ("الامارات", "AE"),
    ("الكويت", "KW"),
    ("البحرين", "BH"),
    ("السودان", "SD"),
    ("الجزاير", "DZ"),
    ("المغرب", "MA"),
    ("فلسطين", "PS"),
    ("موريتانيا", "MR"),
    ("الاردن", "JO"),
    ("العراق", "IQ"),
    ("سوريا", "SY"),
    ("اليمن", "YE"),
    ("ليبيا", "LY"),
    ("تونس", "TN"),
    ("لبنان", "LB"),
    ("عمان", "OM"),
    ("قطر", "QA"),
    ("مصر", "EG"),
    ("لندن", "GB"),
    ("saudi arabia", "SA"),
    ("egyptian", "EG"),
    ("emirates", "AE"),
    ("palestine", "PS"),
    ("mauritania", "MR"),
    ("algeria", "DZ"),
    ("morocco", "MA"),
    ("lebanon", "LB"),
    ("jordan", "JO"),
    ("tunisia", "TN"),
    ("bahrain", "BH"),
    ("egypt", "EG"),
    ("saudi", "SA"),
    ("qatar", "QA"),
    ("kuwait", "KW"),
    ("oman", "OM"),
    ("iraq", "IQ"),
    ("syria", "SY"),
    ("yemen", "YE"),
    ("sudan", "SD"),
    ("libya", "LY"),
    ("uae", "AE"),
    ("london", "GB"),
]

# Every normalized country word (for the "title is only a country
# name" junk check): a bare "مصر" / "Qatar" names no paper.
_COUNTRY_WORDS = frozenset(word for word, _ in COUNTRY_PREFIXES)

# Words that mark an EVENING edition of a paper ("الأهرام المسائي").
# "المساء" on its own is a paper name, not a marker — it is NOT here.
EVENING_WORDS = ("المسائي", "مسائي", "evening")

# Lines that are section headers, not paper names (the fallback channel
# posts "جرايد مصر" and then the files follow).
HEADER_LINES = (
    "جرايد مصر",
    "جرائد مصر",
    "جرايد",
    "جرائد",
    "صحف",
    "الصحف",
    "صحف اليوم",
    "صحف مصر",
    "جرائد اليوم",
)

_ARABIC_DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩", "0123456789")
_ARABIC_MONTHS = {
    "يناير": 1,
    "فبراير": 2,
    "مارس": 3,
    "أبريل": 4,
    "ابريل": 4,
    "مايو": 5,
    "يونيو": 6,
    "يوليو": 7,
    "أغسطس": 8,
    "اغسطس": 8,
    "سبتمبر": 9,
    "أكتوبر": 10,
    "اكتوبر": 10,
    "نوفمبر": 11,
    "ديسمبر": 12,
}
_EN_MONTHS = {
    "jan": 1, "january": 1,
    "feb": 2, "february": 2,
    "mar": 3, "march": 3,
    "apr": 4, "april": 4,
    "may": 5,
    "jun": 6, "june": 6,
    "jul": 7, "july": 7,
    "aug": 8, "august": 8,
    "sep": 9, "sept": 9, "september": 9,
    "oct": 10, "october": 10,
    "nov": 11, "november": 11,
    "dec": 12, "december": 12,
}
_EN_MONTH_NAMES = "|".join(sorted(_EN_MONTHS, key=len, reverse=True))
_ARABIC_WEEKDAYS = (
    "السبت", "الأحد", "الاحد", "الاثنين", "الإثنين", "الثلاثاء",
    "الأربعاء", "الاربعاء", "الخميس", "الجمعة",
)
_EN_WEEKDAYS = (
    "Saturday", "Sunday", "Monday", "Tuesday", "Wednesday",
    "Thursday", "Friday", "Sat", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri",
)
_DATE_NUM_RE = re.compile(
    r"(\d{1,2})[\s/\-.]+(\d{1,2})[\s/\-.]+(\d{4})"
)
_DATE_AR_RE = re.compile(
    r"(\d{1,2})\s+(" + "|".join(_ARABIC_MONTHS) + r")\s+(\d{4})"
)
_DATE_EN_RE = re.compile(
    r"(\d{1,2})\s+(" + _EN_MONTH_NAMES + r")\s+(\d{4})", re.IGNORECASE
)
_DATE_EN_RE2 = re.compile(
    r"(" + _EN_MONTH_NAMES + r")\s+(\d{1,2}),?\s+(\d{4})", re.IGNORECASE
)
# Day + month with NO year ("14 نوفمبر", "14 Nov") — not a paper date,
# so only used for stripping in clean_filename, never for dating.
_DATE_AR_SHORT_RE = re.compile(
    r"(\d{1,2})\s+(" + "|".join(_ARABIC_MONTHS) + r")(?!\s*\d)", re.IGNORECASE
)
_DATE_EN_SHORT_RE = re.compile(
    r"(\d{1,2})\s+(" + _EN_MONTH_NAMES + r")\b", re.IGNORECASE
)
_DATE_EN_SHORT_RE2 = re.compile(
    r"\b(" + _EN_MONTH_NAMES + r")\s+(\d{1,2})\b", re.IGNORECASE
)
_WEEKDAY_RE = re.compile(
    r"(?<!\S)(?:" + "|".join(_ARABIC_WEEKDAYS + _EN_WEEKDAYS) + r")(?!\S)",
    re.IGNORECASE,
)
# Combining marks the hub actually posts (U+0654 hamza above, U+0655
# hamza below — "الأردن" is alef + U+0654, not precomposed "أ"):
# NFC composes them, the regex below strips any that survive.
_DIACRITICS_RE = re.compile(r"[\u064b-\u0655\u0640]")
_INVISIBLE_RE = re.compile(r"[\u200b-\u200f\ufeff\u00ad]")
_EMOJI_RE = re.compile(
    "[\U0001F000-\U0001FAFF\u2600-\u27BF\u2B00-\u2BFF\u2190-\u21FF"
    "\u2300-\u23FF\u203C\u2049\u00A9\u00AE\u3030\u303D\uFE0F\u200D]"
)
_URL_RE = re.compile(r"(https?://|www\.|t\.me|\bt\s+me\b|joinchat)", re.IGNORECASE)
_UUID_RE = re.compile(
    r"\b[0-9a-fA-F]{8}[ \-]?[0-9a-fA-F]{4}[ \-]?[0-9a-fA-F]{4}"
    r"[ \-]?[0-9a-fA-F]{4}[ \-]?[0-9a-fA-F]{12}\b"
)
_EVENING_RE = re.compile(
    r"(?<!\S)(?:المسائي|مسائي|evening)(?!\S)", re.IGNORECASE
)


def _norm_digits(text: str) -> str:
    return (text or "").translate(_ARABIC_DIGITS)


def _strip_invisible(text: str) -> str:
    """NFC-compose (alef + combining hamza -> precomposed أ/إ) and drop
    invisible characters (LRM/RLM, zero-width, BOM)."""
    text = unicodedata.normalize("NFC", text or "")
    return _INVISIBLE_RE.sub("", text)


def normalize_arabic(text: str) -> str:
    """Normalize Arabic for name matching: NFC, digits, alef forms,
    diacritics, lower-cased Latin (so "AKHBAR ELYOUM" matches
    "akhbar elyoum")."""
    text = _strip_invisible(text or "")
    text = _norm_digits(text)
    text = _DIACRITICS_RE.sub("", text)
    text = re.sub(r"[أإآٱ]", "ا", text)
    text = text.replace("ة", "ه")
    text = re.sub(r"\s+", " ", text).strip().lower()
    return text


def parse_explicit_date(text: str):
    """A date written IN the post/filename -> datetime.date, or None.

    Accepts ``12/11/2026``, ``12-11-2026``, ``12.11.2026`` (day first —
    the Arabic convention), ``12 نوفمبر 2026`` (Arabic month names,
    incl. Arabic-Indic digits), and ``14 Nov 2026`` / ``Nov 14, 2026``
    (English month names). Two-digit years are not accepted.
    """
    if not text:
        return None
    text = _norm_digits(text)
    m = _DATE_NUM_RE.search(text)
    if m:
        try:
            return date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
        except ValueError:
            return None
    m = _DATE_AR_RE.search(text)
    if m:
        try:
            return date(int(m.group(3)), _ARABIC_MONTHS[m.group(2)], int(m.group(1)))
        except ValueError:
            return None
    m = _DATE_EN_RE.search(text)
    if m:
        try:
            return date(int(m.group(3)), _EN_MONTHS[m.group(2).lower()], int(m.group(1)))
        except ValueError:
            return None
    m = _DATE_EN_RE2.search(text)
    if m:
        try:
            return date(int(m.group(3)), _EN_MONTHS[m.group(1).lower()], int(m.group(2)))
        except ValueError:
            return None
    return None


def post_cairo_date(post: Post):
    """A preview/API post's ``date`` (ISO, UTC) -> its Africa/Cairo date."""
    if not post.date:
        return None
    try:
        dt = datetime.fromisoformat(post.date.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(CAIRO_TZ).date()


def _title_case_latin(name: str) -> str:
    """Uniform-case Latin titles -> Title Case: "AKHBAR ELYOUM" ->
    "Akhbar Elyoum", "alwafd" -> "Alwafd". Mixed-case titles ("Saudi
    Gazette", "AL ahram") are left alone — the known-name display map
    in :func:`classify` canonicalizes those."""
    ascii_letters = [c for c in name if c.isascii() and c.isalpha()]
    if not ascii_letters:
        return name
    if all(c.isupper() for c in ascii_letters) or all(c.islower() for c in ascii_letters):
        return name.title()
    return name


def clean_filename(filename: str) -> str:
    """'الأهرام 12-11-2026.pdf' -> 'الأهرام' (name candidate, no date/ext).

    Also strips what the hub actually posts around names (observed
    live 2026-11-14): English dates ("14 Nov 2026"), trailing number
    runs ("الجزيرة 13", "MASA 121338", "AL ahram 14 11"), weekday
    names, "عدد" / "ليوم" filler words, edition markers in
    parentheses ("(ط2)"), emojis, a trailing single Latin letter
    ("Al Ahram m"), and invisible characters. A title that is only a
    URL is not a name at all and cleans to "" (see
    :func:`junk_reason`)."""
    name = _strip_invisible(filename or "")
    name = re.sub(r"\.[A-Za-z0-9]{2,5}$", "", name.strip())
    if _URL_RE.search(name):
        return ""
    name = _EMOJI_RE.sub(" ", name)
    name = _norm_digits(name)
    # Separators first: "12_11_2026" must become "12 11 2026" BEFORE the
    # date patterns run, or the date is never recognised as a date.
    name = re.sub(r"[_\-\.]+", " ", name)
    name = _DATE_NUM_RE.sub(" ", name)
    name = _DATE_AR_RE.sub(" ", name)
    name = _DATE_EN_RE.sub(" ", name)
    name = _DATE_EN_RE2.sub(" ", name)
    name = _DATE_AR_SHORT_RE.sub(" ", name)
    name = _DATE_EN_SHORT_RE.sub(" ", name)
    name = _DATE_EN_SHORT_RE2.sub(" ", name)
    name = re.sub(r"\b(pdf|PDF)\b", " ", name)
    # Filler words that are never part of a paper name.
    name = re.sub(r"(?<!\S)(?:عدد|ليوم)(?!\S)", " ", name)
    name = _WEEKDAY_RE.sub(" ", name)
    name = re.sub(r"\([^)]*\)", " ", name)
    name = re.sub(r"\s+", " ", name).strip()
    # Leading/trailing pure-number tokens ("13", "14 11", "121338").
    tokens = name.split(" ") if name else []
    while tokens and tokens[0].isdigit():
        tokens.pop(0)
    while tokens and tokens[-1].isdigit():
        tokens.pop()
    # Trailing single Latin letter ("Al Ahram m").
    if tokens and re.fullmatch(r"[A-Za-z]", tokens[-1]):
        tokens.pop()
    name = " ".join(tokens)
    for prefix in ("صحيفة ", "جريدة ", "جريده ", "صحيفه "):
        if name.startswith(prefix):
            name = name[len(prefix):].strip()
            break
    name = re.sub(r"\s+", " ", name).strip(" -–—•·")
    return _title_case_latin(name)


def junk_reason(raw_name: str):
    """(raw title) -> None when it can name a paper, else a short
    reason it must be dropped: "url" (invite/Telegram link),
    "uuid" (a bare UUID), "bare_date" (only a date), "header" (a
    section header like "صحف اليوم", incl. the emoji-decorated ones),
    "flag_or_emoji_only" (a lone flag emoji — the hub's per-country
    section marker), "country_only" (a bare country name), "empty".
    Anything this is unsure about returns None — the title is kept
    and recorded in ``unmatched`` instead of dropped."""
    raw = _strip_invisible(raw_name or "")
    if not raw.strip():
        return "empty"
    if _URL_RE.search(raw):
        return "url"
    if _UUID_RE.search(raw) or re.fullmatch(
            r"[0-9a-fA-F]{32}", re.sub(r"[\s\-]", "", raw.strip())):
        return "uuid"
    cleaned = clean_filename(raw)
    if not cleaned:
        if parse_explicit_date(raw) is not None:
            return "bare_date"
        if not _EMOJI_RE.sub("", raw).strip(" \t\r\n-–—•*·"):
            return "flag_or_emoji_only"
        return "empty"
    if _is_header_line(cleaned):
        return "header"
    if normalize_arabic(cleaned) in _COUNTRY_WORDS:
        return "country_only"
    return None


def is_evening_edition(display: str) -> bool:
    """True when the title marks an EVENING edition ("الأهرام
    المسائي", "evening"). "المساء" on its own is a paper name, not a
    marker, and does not match."""
    return bool(_EVENING_RE.search(normalize_arabic(display or "")))


def _is_header_line(line: str) -> bool:
    norm = normalize_arabic(line)
    return any(norm == normalize_arabic(h) or norm.startswith(normalize_arabic(h) + " ") for h in HEADER_LINES)


def extract_names(post: Post, dropped: list | None = None) -> list[str]:
    """Paper-name candidates from one post, best first.

    Document filenames first (the hub puts the paper name on the file),
    then the post text's first content line. Header-only lines
    ("جرايد مصر") are skipped — they name no paper. Junk titles (a
    URL, a UUID, a bare date, a lone flag emoji, a section header) are
    skipped and, when ``dropped`` is given, recorded there as
    ``{"name": raw, "reason": ...}`` so the run report shows what was
    dropped instead of silently losing it. A post with no file and no
    name line yields no candidate.
    """
    names: list[str] = []
    for f in post.files:
        if f.kind != "document":
            continue
        reason = junk_reason(f.filename)
        if reason is not None:
            if dropped is not None:
                dropped.append({"name": f.filename, "reason": reason})
            continue
        cleaned = clean_filename(f.filename)
        if cleaned and cleaned not in names:
            names.append(cleaned)
    for line in (post.text or "").splitlines():
        line = line.strip(" \t\r\n-–—•*")
        if not line or _is_header_line(line):
            continue
        reason = junk_reason(line)
        if reason is not None:
            if dropped is not None:
                dropped.append({"name": line, "reason": reason})
            continue
        # First content line only: later lines are usually the date,
        # a caption, or a link — not the paper name.
        cleaned = clean_filename(line)
        if cleaned and cleaned not in names:
            names.append(cleaned)
        break
    return names


def _drop_first_word(display: str) -> str:
    parts = display.split(" ", 1)
    return parts[1].strip() if len(parts) == 2 else display


def _strip_country_prefix(display: str, prefix_word: str, remainder_norm: str) -> str:
    """Drop the leading country word from the display name: the country
    is shown by the section the paper sits in, so "الأردن الدستور" ->
    "الدستور", "عُمان عُمان" -> "عُمان", "الإمارات الإمارات اليوم" ->
    "الإمارات اليوم", "لندن العربي الجديد" -> "العربي الجديد". Kept
    only when the remainder is Latin-only ("Qatar Tribune" — the
    paper's full name includes the country), so no real name is ever
    shortened by guessing. (Whole-title known names such as "الإمارات
    اليوم" never reach this function — the exact match in
    :func:`classify` runs first.)"""
    if not remainder_norm:
        return display
    has_arabic = any("\u0600" <= c <= "\u06FF" for c in remainder_norm)
    if has_arabic or remainder_norm == prefix_word:
        return _drop_first_word(display)
    return display


def _norm_exact(text: str) -> str:
    """Light normalization for EXACT name matching: NFC + strip +
    lower-case only — alef forms are NOT folded, so "الرأي" (Jordan)
    and "الراي" (Kuwait), which differ only in أ vs ا, stay distinct.
    (normalize_arabic folds them together, so it cannot be used for
    exact matches of those two names.)"""
    return _strip_invisible(text or "").strip().lower()


def classify(raw_name: str, context_text: str = "", default_country=None):
    """(raw_name) -> (display name, country code).

    Order: exact known name (the WHOLE title is the paper, so a
    country word inside it is never stripped) -> leading country
    prefix ("الأردن الدستور" -> JO — the prefix wins over the paper
    map) -> known name contained in the title (longest first) ->
    country hint in the name/context -> source default country ->
    unknown ("XX"). A hint never overrides a mapped name, and a
    prefix never overrides an exact known name ("الإمارات اليوم" stays
    the UAE paper, it does not become "اليوم").
    """
    display = clean_filename(raw_name) or raw_name.strip()
    display = _strip_invisible(display)
    canonical = ENGLISH_DISPLAY.get(normalize_arabic(display))
    if canonical:
        display = canonical
    norm = normalize_arabic(display)
    # 1. Exact known name (NFC-only comparison, so "الرأي" Jordan and
    #    "الراي" Kuwait stay distinct — see _norm_exact).
    exact = _norm_exact(display)
    for known, code in KNOWN_PAPERS.items():
        if _norm_exact(known) == exact:
            return display, code
    # 2. Leading country prefix (longest form first: "saudi arabia"
    #    before "saudi").
    for word, code in sorted(COUNTRY_PREFIXES, key=lambda wc: -len(wc[0])):
        if norm.startswith(word + " "):
            remainder = norm[len(word) + 1:]
            return _strip_country_prefix(display, word, remainder), code
    # 3. Known name contained in the title (longest first: "الشرق
    #    الأوسط" must win over "الشرق", "الشروق التونسية" over
    #    "الشروق"). Only a known name CONTAINED in the raw name counts
    #    — never the reverse.
    for known in sorted(KNOWN_PAPERS, key=len, reverse=True):
        if normalize_arabic(known) in norm:
            return display, KNOWN_PAPERS[known]
    # 4. Country hint in the name/context.
    haystack = normalize_arabic(display + " " + (context_text or ""))
    for word, code in COUNTRY_HINTS:
        if normalize_arabic(word) in haystack:
            return display, code
    if default_country:
        return display, default_country
    return display, "XX"


def entry_for_date(post: Post, raw_name: str, today: date, source: dict):
    """One candidate name -> a newspaper entry, or None (not today's paper).

    The entry's date is the explicit date written on the post/file when
    it is close to the post date (<= 2 days off — guards against a
    misparsed number), otherwise the post's Cairo date. Only papers
    dated ``today`` are kept: the daily file holds today's papers only.
    The entry's ``url`` is the DIRECT message link built from the
    post's own ``post_id`` + handle/channel id (see
    :func:`message_url_for_post`) — never ``post.url`` verbatim, and
    never a bare channel page. A post with no buildable direct link
    yields no entry. The entry also carries ``post_id`` and ``handle``
    so the link can be rebuilt and verified downstream.
    """
    post_date = post_cairo_date(post)
    if post_date is None:
        return None
    explicit = parse_explicit_date((post.text or "") + " " + " ".join(f.filename for f in post.files))
    if explicit is not None and abs((explicit - post_date).days) <= 2:
        paper_date = explicit
    else:
        paper_date = post_date
    if paper_date != today:
        return None
    url, handle = message_url_for_post(post)
    if url is None:
        return None
    name, code = classify(raw_name, post.text or "", source.get("default_country"))
    info = COUNTRIES.get(code, UNKNOWN_COUNTRY)
    return {
        "name": name,
        "country": code,
        "country_name": info["name"],
        "flag": info["flag"],
        "region": info["region"],
        "edition": "evening" if is_evening_edition(name) else "morning",
        "date": paper_date.isoformat(),
        "url": url,
        "handle": handle,
        "post_id": post.post_id,
        "source": source["key"],
    }


def build_data(today: date, entries: list[dict], source_reports: list[dict], generated_at=None, dropped: list[dict] | None = None) -> dict:
    """Assemble the output file: Egypt first, others grouped by region.

    De-duplicates on (name, country, date, edition) — the same paper
    posted twice (hub + fallback) keeps its first (newest) link, but
    the same name in two countries ("الأيام" in Bahrain AND Palestine)
    stays two entries. Unmatched names (country XX) are kept in the
    listing AND in ``unmatched`` so the name map can grow from real
    posts. ``dropped`` records junk titles skipped during extraction
    (URL / UUID / bare date / header / flag-only) with their reason,
    so nothing disappears silently. ``countries`` lists every country
    with at least one paper today (Egypt first, then Gulf, London,
    other Arab, unknown last) with its flag, Arabic name and count —
    the pages render one sub-link / section per country from it.
    """
    seen: set[tuple[str, str, str, str]] = set()
    egypt: list[dict] = []
    other: list[dict] = []
    unmatched: list[str] = []
    for entry in entries:
        key = (normalize_arabic(entry["name"]), entry["country"], entry["date"],
               entry.get("edition", "morning"))
        if key in seen:
            continue
        seen.add(key)
        if entry["country"] == "XX" and entry["name"] not in unmatched:
            unmatched.append(entry["name"])
        (egypt if entry["region"] == "egypt" else other).append(entry)
    egypt.sort(key=lambda e: normalize_arabic(e["name"]))
    other.sort(key=lambda e: (REGION_ORDER.index(e["region"]), normalize_arabic(e["name"])))

    def _country_rank(code: str) -> int:
        if code in COUNTRY_ORDER:
            return COUNTRY_ORDER.index(code)
        return len(COUNTRY_ORDER)  # XX (unknown) and anything else: last

    counts: dict[str, int] = {}
    for entry in egypt + other:
        counts[entry["country"]] = counts.get(entry["country"], 0) + 1
    countries = [
        {"code": code,
         "name": COUNTRIES.get(code, UNKNOWN_COUNTRY)["name"],
         "flag": COUNTRIES.get(code, UNKNOWN_COUNTRY)["flag"],
         "count": counts[code]}
        for code in sorted(counts, key=_country_rank)
    ]
    dropped_out: list[dict] = []
    seen_dropped: set[tuple] = set()
    for d in dropped or []:
        dkey = (d.get("name"), d.get("reason"))
        if dkey in seen_dropped:
            continue
        seen_dropped.add(dkey)
        dropped_out.append(d)
    return {
        "version": 2,
        "date": today.isoformat(),
        "generated_at": (generated_at or datetime.now(timezone.utc)).isoformat(),
        "sources": source_reports,
        "egypt": egypt,
        "other": other,
        "countries": countries,
        "empty": not egypt and not other,
        "unmatched": unmatched,
        "dropped": dropped_out,
    }


def entries_from_posts(posts: list[Post], today: date, source: dict, dropped: list | None = None) -> list[dict]:
    """All of today's entries from one source's recent posts. Junk
    titles skipped during extraction are appended to ``dropped`` (when
    given) with their source, for the run report."""
    entries: list[dict] = []
    for post in posts:
        post_dropped: list[dict] = []
        for raw_name in extract_names(post, dropped=post_dropped):
            entry = entry_for_date(post, raw_name, today, source)
            if entry is not None:
                entries.append(entry)
        if dropped is not None:
            for d in post_dropped:
                dropped.append({**d, "source": source["key"]})
    return entries


# ---------------------------------------------------------------------------
# Reading paths
# ---------------------------------------------------------------------------

def collect_preview(today: date, source: dict, max_pages: int = 3, delay: float = 1.5):
    """Read one username source via the public t.me/s/ preview.

    Returns (posts, report). A redirect / missing preview is the
    EXPECTED failure for preview-disabled channels — it is reported as
    ``no_preview``, not raised.
    """
    name = source["key"]
    try:
        kind = scrape.classify(name)
    except Exception as exc:  # network-level failure
        return [], {"key": name, "label": source["label"], "status": "error",
                    "posts_seen": 0, "entries": 0, "detail": f"preview probe failed: {exc}"}
    if kind != "channel":
        return [], {"key": name, "label": source["label"], "status": "no_preview",
                    "posts_seen": 0, "entries": 0,
                    "detail": "t.me/s/ serves no posts for this channel (redirect to info card); use the API path"}
    posts: list[Post] = []
    try:
        before = None
        for _ in range(max_pages):
            page = scrape.fetch_page(name, before=before, delay=delay)
            if not page:
                break
            posts.extend(page)
            before = min(p.post_id for p in page)
            oldest = min((post_cairo_date(p) for p in page if post_cairo_date(p)), default=None)
            if oldest is not None and oldest < today - timedelta(days=1):
                break
    except ValueError as exc:  # fetch_page: no public preview after all
        return [], {"key": name, "label": source["label"], "status": "no_preview",
                    "posts_seen": len(posts), "entries": 0, "detail": str(exc)}
    except Exception as exc:
        return posts, {"key": name, "label": source["label"], "status": "error",
                       "posts_seen": len(posts), "entries": 0, "detail": f"preview fetch failed: {exc}"}
    return posts, {"key": name, "label": source["label"], "status": "ok",
                   "posts_seen": len(posts), "entries": 0, "detail": ""}


async def collect_api_client(client, today: date, source: dict, limit: int = 60):
    """Read one source via an already-connected Telethon client (duck-typed).

    Username sources are read with ``client.iter_messages(handle)``.
    Invite-link sources are checked with ``CheckChatInviteRequest``
    (read-only info — never a join): only ``ChatInviteAlready`` (the
    account is already a member) is read; anything else reports
    ``unavailable_not_member`` (``unavailable_pending_join`` when the
    source is flagged as such). Returns (posts, report).

    Each post is stamped with its link identity: a public username
    (``post.channel``) gives ``t.me/<handle>/<post_id>``; a channel
    with no public username gets its numeric id (``post.channel_id``)
    so the direct link is built as ``t.me/c/<id>/<post_id>`` instead.
    """
    from .api_history import _post_from_message

    name = source["key"]
    label = source["label"]
    link_handle = None
    link_channel_id = None
    if source["kind"] == "invite":
        if source.get("pending_join"):
            return [], {"key": name, "label": label,
                        "status": "unavailable_pending_join", "posts_seen": 0,
                        "entries": 0,
                        "detail": "private channel — the owner's join request is pending; this tool never joins"}
        try:
            from telethon.tl.functions.messages import CheckChatInviteRequest

            result = await client(CheckChatInviteRequest(source["invite_hash"]))
        except Exception as exc:
            return [], {"key": name, "label": label, "status": "error",
                        "posts_seen": 0, "entries": 0, "detail": f"invite check failed: {exc}"}
        chat = getattr(result, "chat", None)
        if chat is None:
            return [], {"key": name, "label": label, "status": "unavailable_not_member",
                        "posts_seen": 0, "entries": 0,
                        "detail": "invite link is valid but the account is not a member; this tool never joins"}
        entity = chat
        link_handle = getattr(chat, "username", None)
        link_channel_id = getattr(chat, "id", None)
        handle = link_handle or name
    else:
        entity = name
        handle = name
        link_handle = name
    posts: list[Post] = []
    try:
        async for msg in client.iter_messages(entity, limit=limit):
            post = _post_from_message(handle, msg)
            # Link identity for the direct message link: a public
            # username, else the numeric channel id (t.me/c/ form).
            # _post_from_message's url is only right in the username
            # case; entry_for_date rebuilds it from these fields.
            post.channel = link_handle or name
            post.channel_id = link_channel_id
            posts.append(post)
    except Exception as exc:
        return posts, {"key": name, "label": label, "status": "error",
                       "posts_seen": len(posts), "entries": 0,
                       "detail": f"API read failed: {exc}"}
    return posts, {"key": name, "label": label, "status": "ok",
                   "posts_seen": len(posts), "entries": 0, "detail": ""}


def _api_credentials_available() -> bool:
    from .api_history import load_api_credentials

    try:
        load_api_credentials(os.environ)
        return True
    except Exception:
        return False


async def _collect_api_all(today: date, sources: list[dict], limit: int = 60):
    """API pass over the sources that still need one. Returns {key: (posts, report)}."""
    from .api_history import create_client, load_api_credentials

    api_id, api_hash, session = load_api_credentials(os.environ)
    client = create_client(api_id, api_hash, session)
    await client.connect()
    try:
        out = {}
        for source in sources:
            posts, report = await collect_api_client(client, today, source, limit=limit)
            out[source["key"]] = (posts, report)
        return out
    finally:
        try:
            await client.disconnect()
        except Exception:
            pass


def collect(today: date, *, use_api: bool = True, max_pages: int = 3, delay: float = 1.5):
    """Collect today's entries from all sources. Returns the data dict.

    Preview first for username sources; the API pass runs only for
    sources the preview could not read (and only when credentials are
    present — otherwise they report ``unavailable_no_credentials``).
    Invite-link sources are API-only by construction.
    """
    entries: list[dict] = []
    reports: list[dict] = []
    dropped: list[dict] = []
    api_needed: list[dict] = []

    def _report(report: dict) -> None:
        # One report per source: a later pass replaces the earlier one.
        reports[:] = [r for r in reports if r["key"] != report["key"]]
        reports.append(report)

    for source in SOURCES:
        if source["kind"] == "username":
            posts, report = collect_preview(today, source, max_pages=max_pages, delay=delay)
            if report["status"] in ("no_preview", "error") and use_api:
                api_needed.append(source)
                _report(report)  # replaced below if the API succeeds
            else:
                found = entries_from_posts(posts, today, source, dropped=dropped)
                report["entries"] = len(found)
                entries.extend(found)
                _report(report)
        else:
            api_needed.append(source)
    if api_needed and use_api:
        if not _api_credentials_available():
            for source in api_needed:
                existing = next((r for r in reports if r["key"] == source["key"]), None)
                if existing is not None:
                    # The preview already failed for this source — keep
                    # that status (it is the operative failure) and note
                    # the API fallback was unavailable too.
                    existing["detail"] = (existing.get("detail") or "") + \
                        " — API fallback unavailable (no Telegram API credentials in the environment)"
                    continue
                if source.get("pending_join"):
                    status, detail = "unavailable_pending_join", "private channel — the owner's join request is pending; this tool never joins"
                else:
                    status, detail = "unavailable_no_credentials", "no Telegram API credentials in the environment (TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_SESSION_STRING)"
                _report({"key": source["key"], "label": source["label"],
                         "status": status, "posts_seen": 0, "entries": 0, "detail": detail})
        else:
            api_results = asyncio.run(_collect_api_all(today, api_needed))
            for source in api_needed:
                posts, api_report = api_results[source["key"]]
                found = entries_from_posts(posts, today, source, dropped=dropped)
                api_report["entries"] = len(found)
                entries.extend(found)
                _report(api_report)
    elif api_needed:
        for source in api_needed:
            _report({"key": source["key"], "label": source["label"],
                     "status": "skipped_no_api", "posts_seen": 0, "entries": 0,
                     "detail": "API path disabled (--no-api)"})
    # Keep reports in SOURCES order.
    order = {s["key"]: i for i, s in enumerate(SOURCES)}
    reports.sort(key=lambda r: order.get(r["key"], 99))
    return build_data(today, entries, reports, dropped=dropped)


def write_data(data: dict, out: Path) -> Path:
    """Write the data file atomically (tmp + replace), so a crash never
    leaves a half-written newspapers.json behind."""
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=out.name + ".", dir=str(out.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        os.replace(tmp, out)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return out


def empty_data(today: date, detail: str = "") -> dict:
    """An empty-day file: the page shows 'لا يوجد جرائد اليوم'."""
    reports = [
        {"key": s["key"], "label": s["label"], "status": "skipped_empty_fallback",
         "posts_seen": 0, "entries": 0, "detail": detail or "generator fallback — no sources were read"}
        for s in SOURCES
    ]
    return build_data(today, [], reports)


# ---------------------------------------------------------------------------
# Static page rendering (no JavaScript, no fetch — Kindle browser)
#
# The two pages carry NEWSPAPERS-STATIC-BEGIN / -END markers; only the
# fragment between them is replaced, so the rest of each page (head,
# styles, other cards, footer) is never touched. The fragment is plain
# HTML: paper name + country flag + date + the direct message link.
# Design preserved from the old fetch-based pages: Egypt first / in
# front, per-country anchored sections on /newspapers/, sub-link nav
# with counts, the 'لا يوجد جرائد اليوم' notice for empty days, and
# the distinct 'لا توجد جرائد مصرية اليوم' notice when Egypt is empty
# but other countries have papers.
# ---------------------------------------------------------------------------

STATIC_BEGIN = "<!-- NEWSPAPERS-STATIC-BEGIN -->"
STATIC_END = "<!-- NEWSPAPERS-STATIC-END -->"


def _entry_li(entry: dict, detail: str) -> str:
    """One paper as a static list item: flag + name linked to its post."""
    return (
        '<li><a href="{url}" target="_blank" rel="noopener">{flag} {name}</a>'
        ' <span class="note"> — {detail}</span></li>'
    ).format(
        url=html.escape(entry["url"], quote=True),
        flag=html.escape(entry["flag"]),
        name=html.escape(entry["name"]),
        detail=html.escape(detail),
    )


def _split_editions(entries: list[dict]):
    """(morning, evening) — evening editions are never mixed into the
    morning list; they get their own "المسائية" group."""
    morning = [e for e in entries if e.get("edition", "morning") != "evening"]
    evening = [e for e in entries if e.get("edition", "morning") == "evening"]
    return morning, evening


def _entries_ul(entries: list[dict], detail_fn) -> str:
    items = "".join(_entry_li(e, detail_fn(e)) for e in entries)
    return f"<ul>{items}</ul>"


def render_home_section(data: dict) -> str:
    """Static fragment for the home page's newspapers card: Egypt's
    papers in front, under an unmistakable "🇪🇬 مصر" heading, plus
    sub-links to the other countries' sections on /newspapers/.
    Evening editions get their own "المسائية" group below the morning
    list. A paper with no country never appears here — it goes under
    the labelled "غير محدد" section on /newspapers/. No JavaScript,
    no fetch — the list is in the HTML."""
    parts: list[str] = []
    egypt = data.get("egypt") or []
    if data.get("empty"):
        parts.append('<p class="note">لا يوجد جرائد اليوم</p>')
    elif not egypt:
        parts.append('<p class="note">لا توجد جرائد مصرية اليوم — جرائد من دول أخرى بالأسفل.</p>')
    else:
        parts.append("<h3>🇪🇬 مصر</h3>")
        morning, evening = _split_editions(egypt)
        if morning:
            parts.append(_entries_ul(morning, lambda e: e["date"]))
        if evening:
            parts.append("<h3>🌙 المسائية</h3>")
            parts.append(_entries_ul(evening, lambda e: e["date"]))
    others = [c for c in (data.get("countries") or []) if c["code"] != "EG"]
    if others:
        links = " · ".join(
            '<a href="/newspapers/#country-{code}">{flag} {name} ({count})</a>'.format(
                code=html.escape(c["code"], quote=True),
                flag=html.escape(c["flag"]),
                name=html.escape(c["name"]),
                count=c["count"],
            )
            for c in others
        )
        parts.append(f'<p class="links">{links}</p>')
    return "\n".join(parts)


def render_other_section(data: dict) -> str:
    """Static fragment for /newspapers/: sub-link nav with counts, then
    one anchored section per country, Egypt first, each under its own
    unmistakable country header ("🇪🇬 مصر", "🇸🇦 السعودية", ...), each
    split into a morning list and — when present — a separate
    "المسائية" group. Papers with no country go under their own
    labelled "🌍 غير محدد" section, never mixed into مصر or any other
    country. No JavaScript."""
    all_entries = (data.get("egypt") or []) + (data.get("other") or [])
    if not all_entries:
        return '<p class="note">لا يوجد جرائد اليوم</p>'
    countries = data.get("countries") or []
    parts: list[str] = []
    nav = " · ".join(
        '<a href="#country-{code}">{flag} {name} ({count})</a>'.format(
            code=html.escape(c["code"], quote=True),
            flag=html.escape(c["flag"]),
            name=html.escape(c["name"]),
            count=c["count"],
        )
        for c in countries
    )
    parts.append(f'<p class="note">{nav}</p>')
    for c in countries:
        group = [e for e in all_entries if e["country"] == c["code"]]
        if not group:
            continue
        parts.append(
            '<h2 id="country-{code}">{flag} {name}</h2>'.format(
                code=html.escape(c["code"], quote=True),
                flag=html.escape(c["flag"]),
                name=html.escape(c["name"]),
            )
        )
        morning, evening = _split_editions(group)
        if morning:
            parts.append(_entries_ul(morning, lambda e: f'{e["country_name"]} — {e["date"]}'))
        if evening:
            parts.append("<h3>🌙 المسائية</h3>")
            parts.append(_entries_ul(evening, lambda e: f'{e["country_name"]} — {e["date"]}'))
    return "\n".join(parts)


def _atomic_write_text(path: Path, text: str) -> None:
    """Write text atomically (tmp + replace), like :func:`write_data`."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.name + ".", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def write_pages(data: dict, pages_root, *, warn=print) -> list[Path]:
    """Bake the day's papers into the two HTML pages as static HTML.

    ``pages_root`` is the repo root (``index.html`` at its top,
    ``site/newspapers/index.html`` under it). Each page must carry the
    STATIC_BEGIN / STATIC_END markers; only the fragment between them
    is replaced. A page that is missing or has no markers is skipped
    with a warning — the JSON output is unaffected. Returns the pages
    actually written.
    """
    root = Path(pages_root)
    targets = [
        (root / "index.html", render_home_section(data)),
        (root / "site" / "newspapers" / "index.html", render_other_section(data)),
    ]
    written: list[Path] = []
    for path, fragment in targets:
        if not path.exists():
            warn(f"newspapers pages: {path} not found — skipped")
            continue
        text = path.read_text(encoding="utf-8")
        if STATIC_BEGIN not in text or STATIC_END not in text:
            warn(f"newspapers pages: {path} has no static markers — skipped")
            continue
        start = text.index(STATIC_BEGIN) + len(STATIC_BEGIN)
        end = text.index(STATIC_END)
        _atomic_write_text(path, text[:start] + "\n" + fragment + "\n" + text[end:])
        written.append(path)
    return written


def _parse_date_arg(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise argparse.ArgumentTypeError(f"not a YYYY-MM-DD date: {value!r}")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Generate site/newspapers.json and bake the day's papers as static HTML "
                    "into index.html and site/newspapers/index.html (no fetch — Kindle browser)."
    )
    parser.add_argument("--out", default=None,
                        help="output file (default: <repo-root>/site/newspapers.json)")
    parser.add_argument("--date", type=_parse_date_arg, default=None,
                        help="Cairo date to collect for, YYYY-MM-DD (default: today)")
    parser.add_argument("--no-api", action="store_true",
                        help="do not use the Telegram API path (preview only)")
    parser.add_argument("--max-pages", type=int, default=3,
                        help="preview pages to walk per username source (default 3)")
    parser.add_argument("--write-empty", action="store_true",
                        help="write an empty-day file without reading any source (workflow fallback)")
    parser.add_argument("--pages-root", default=None,
                        help="repo root holding index.html and site/newspapers/index.html "
                             "(default: the repo root this module lives in)")
    parser.add_argument("--no-pages", action="store_true",
                        help="do not bake the static HTML pages (JSON only)")
    args = parser.parse_args(argv)

    repo_root = Path(__file__).resolve().parent.parent.parent
    out = Path(args.out) if args.out else repo_root / "site" / "newspapers.json"
    pages_root = Path(args.pages_root) if args.pages_root else repo_root
    today = args.date or datetime.now(CAIRO_TZ).date()

    if args.write_empty:
        data = empty_data(today, detail="--write-empty fallback (previous step failed)")
    else:
        data = collect(today, use_api=not args.no_api, max_pages=args.max_pages)
    write_data(data, out)
    if not args.no_pages:
        written = write_pages(data, pages_root)
        for path in written:
            print(f"baked static page {path}")
    n_eg = len(data["egypt"])
    n_other = len(data["other"])
    print(f"newspapers {data['date']}: {n_eg} Egyptian, {n_other} other"
          + (" — EMPTY DAY (لا يوجد جرائد اليوم)" if data["empty"] else ""))
    for rep in data["sources"]:
        print(f"  {rep['key']}: {rep['status']} (posts {rep['posts_seen']}, entries {rep['entries']})"
              + (f" — {rep['detail']}" if rep.get("detail") else ""))
    if data["unmatched"]:
        print(f"  unmatched names (country unknown, listed under 'other'): {', '.join(data['unmatched'])}")
    if data.get("dropped"):
        print(f"  dropped junk titles ({len(data['dropped'])}): "
              + ", ".join(f"{d['name']} ({d['reason']})" for d in data["dropped"]))
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
