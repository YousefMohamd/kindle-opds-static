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

Classification: a paper is Egyptian only when its name is in
:data:`KNOWN_PAPERS` as EG, a country hint in the post says Egypt, or
the source itself is the Egyptian-only channel. Ambiguous names
(``الأخبار`` — Egypt AND Lebanon; ``الوطن`` — Qatar AND Egypt;
``النهار`` is mapped LB, ``الشروق`` is mapped EG) are NEVER guessed:
with no hint they land in ``other`` with country ``XX`` (🌍) and are
listed in ``unmatched`` in the output so the map can grow from real
posts instead of guesses.

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
import json
import os
import re
import sys
import tempfile
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
                 "LB", "JO", "IQ", "SY", "YE", "SD", "LY", "TN", "DZ", "MA"]


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
    ("لندن", "GB"),
]

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
_DATE_NUM_RE = re.compile(
    r"(\d{1,2})[\s/\-.]+(\d{1,2})[\s/\-.]+(\d{4})"
)
_DATE_AR_RE = re.compile(
    r"(\d{1,2})\s+(" + "|".join(_ARABIC_MONTHS) + r")\s+(\d{4})"
)
_DIACRITICS_RE = re.compile(r"[\u064b-\u0652\u0640]")


def _norm_digits(text: str) -> str:
    return (text or "").translate(_ARABIC_DIGITS)


def normalize_arabic(text: str) -> str:
    """Normalize Arabic for name matching: digits, alef forms, diacritics."""
    text = _norm_digits(text or "")
    text = _DIACRITICS_RE.sub("", text)
    text = re.sub(r"[أإآٱ]", "ا", text)
    text = text.replace("ة", "ه")
    text = re.sub(r"\s+", " ", text).strip()
    return text


def parse_explicit_date(text: str):
    """A date written IN the post/filename -> datetime.date, or None.

    Accepts ``12/11/2026``, ``12-11-2026``, ``12.11.2026`` (day first —
    the Arabic convention) and ``12 نوفمبر 2026`` (Arabic month names,
    incl. Arabic-Indic digits). Two-digit years are not accepted.
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


def clean_filename(filename: str) -> str:
    """'الأهرام 12-11-2026.pdf' -> 'الأهرام' (name candidate, no date/ext)."""
    name = filename or ""
    name = re.sub(r"\.[A-Za-z0-9]{2,5}$", "", name.strip())
    name = _norm_digits(name)
    # Separators first: "12_11_2026" must become "12 11 2026" BEFORE the
    # date patterns run, or the date is never recognised as a date.
    name = re.sub(r"[_\-\.]+", " ", name)
    name = _DATE_NUM_RE.sub(" ", name)
    name = _DATE_AR_RE.sub(" ", name)
    name = re.sub(r"\b(pdf|PDF)\b", " ", name)
    name = re.sub(r"\s+", " ", name).strip()
    for prefix in ("صحيفة ", "جريدة ", "جريده ", "صحيفه "):
        if name.startswith(prefix):
            name = name[len(prefix):].strip()
            break
    return name


def _is_header_line(line: str) -> bool:
    norm = normalize_arabic(line)
    return any(norm == normalize_arabic(h) or norm.startswith(normalize_arabic(h) + " ") for h in HEADER_LINES)


def extract_names(post: Post) -> list[str]:
    """Paper-name candidates from one post, best first.

    Document filenames first (the hub puts the paper name on the file),
    then the post text's first content line. Header-only lines
    ("جرايد مصر") are skipped — they name no paper. A post with no
    file and no name line yields no candidate.
    """
    names: list[str] = []
    for f in post.files:
        if f.kind != "document":
            continue
        cleaned = clean_filename(f.filename)
        if cleaned and cleaned not in names:
            names.append(cleaned)
    for line in (post.text or "").splitlines():
        line = line.strip(" \t\r\n-–—•*")
        if not line or _is_header_line(line):
            continue
        # First content line only: later lines are usually the date,
        # a caption, or a link — not the paper name.
        cleaned = clean_filename(line)
        if cleaned and cleaned not in names:
            names.append(cleaned)
        break
    return names


def classify(raw_name: str, context_text: str = "", default_country=None):
    """(raw_name) -> (display name, country code).

    Order: KNOWN_PAPERS (longest match first) -> country hint in the
    name/context -> source default country -> unknown ("XX"). A hint
    never overrides a mapped name.
    """
    display = clean_filename(raw_name) or raw_name.strip()
    norm = normalize_arabic(display)
    # Longest match first: "الشرق الأوسط" must win over "الشرق", and
    # "الشروق التونسية" over "الشروق". Only a known name CONTAINED in
    # the raw name counts — never the reverse (a short raw name like
    # "الشرق" is Qatar's paper, not a substring-match for London's
    # "الشرق الأوسط").
    for known in sorted(KNOWN_PAPERS, key=len, reverse=True):
        if normalize_arabic(known) in norm:
            return display, KNOWN_PAPERS[known]
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
        "date": paper_date.isoformat(),
        "url": url,
        "handle": handle,
        "post_id": post.post_id,
        "source": source["key"],
    }


def build_data(today: date, entries: list[dict], source_reports: list[dict], generated_at=None) -> dict:
    """Assemble the output file: Egypt first, others grouped by region.

    De-duplicates on (name, date) — the same paper posted twice (hub +
    fallback) keeps its first (newest) link. Unmatched names (country
    XX) are kept in the listing AND in ``unmatched`` so the name map
    can grow from real posts. ``countries`` lists every country with at
    least one paper today (Egypt first, then Gulf, London, other Arab,
    unknown last) with its flag, Arabic name and count — the pages
    render one sub-link / section per country from it.
    """
    seen: set[tuple[str, str]] = set()
    egypt: list[dict] = []
    other: list[dict] = []
    unmatched: list[str] = []
    for entry in entries:
        key = (normalize_arabic(entry["name"]), entry["date"])
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
    }


def entries_from_posts(posts: list[Post], today: date, source: dict) -> list[dict]:
    """All of today's entries from one source's recent posts."""
    entries: list[dict] = []
    for post in posts:
        for raw_name in extract_names(post):
            entry = entry_for_date(post, raw_name, today, source)
            if entry is not None:
                entries.append(entry)
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
                found = entries_from_posts(posts, today, source)
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
                found = entries_from_posts(posts, today, source)
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
    return build_data(today, entries, reports)


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


def _parse_date_arg(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise argparse.ArgumentTypeError(f"not a YYYY-MM-DD date: {value!r}")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Generate site/newspapers.json — today's newspapers, link-out only (no PDFs stored)."
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
    args = parser.parse_args(argv)

    repo_root = Path(__file__).resolve().parent.parent.parent
    out = Path(args.out) if args.out else repo_root / "site" / "newspapers.json"
    today = args.date or datetime.now(CAIRO_TZ).date()

    if args.write_empty:
        data = empty_data(today, detail="--write-empty fallback (previous step failed)")
    else:
        data = collect(today, use_api=not args.no_api, max_pages=args.max_pages)
    write_data(data, out)
    n_eg = len(data["egypt"])
    n_other = len(data["other"])
    print(f"newspapers {data['date']}: {n_eg} Egyptian, {n_other} other"
          + (" — EMPTY DAY (لا يوجد جرائد اليوم)" if data["empty"] else ""))
    for rep in data["sources"]:
        print(f"  {rep['key']}: {rep['status']} (posts {rep['posts_seen']}, entries {rep['entries']})"
              + (f" — {rep['detail']}" if rep.get("detail") else ""))
    if data["unmatched"]:
        print(f"  unmatched names (country unknown, listed under 'other'): {', '.join(data['unmatched'])}")
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
