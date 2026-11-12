"""Tests for tbi.newspapers — daily newspapers, link-out only.

No network is used: the preview path is tested against the offline
``newspapers_preview.html`` fixture, the API path against a fake
Telethon client, and the no-preview case by monkeypatching
``tbi.scrape.classify``. Dates are fixed to 2026-11-12 (the fixture's
dates) so the tests are deterministic.
"""

import asyncio
import json
import re
import sys
from datetime import date
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tbi import newspapers, scrape  # noqa: E402
from tbi.scrape import FileMeta, Post  # noqa: E402

FIX = Path(__file__).parent / "fixtures"
TODAY = date(2026, 11, 12)
HUB = newspapers.SOURCES[0]
EG_CHANNEL = newspapers.SOURCES[2]


def _post(post_id, dt, text="", files=(), channel="arabJournalism"):
    return Post(
        channel=channel,
        post_id=post_id,
        date=dt,
        text=text,
        url=f"https://t.me/{channel}/{post_id}",
        files=list(files),
    )


def _doc(filename):
    return FileMeta(filename=filename)


# ---------------------------------------------------------------------------
# Date parsing
# ---------------------------------------------------------------------------


def test_parse_explicit_date_numeric():
    assert newspapers.parse_explicit_date("الأهرام 12-11-2026.pdf") == date(2026, 11, 12)
    assert newspapers.parse_explicit_date("12/11/2026") == date(2026, 11, 12)
    assert newspapers.parse_explicit_date("الخميس 12.11.2026") == date(2026, 11, 12)


def test_parse_explicit_date_arabic_month_and_digits():
    assert newspapers.parse_explicit_date("الخميس 12 نوفمبر 2026") == date(2026, 11, 12)
    assert newspapers.parse_explicit_date("١٢ نوفمبر ٢٠٢٦") == date(2026, 11, 12)
    assert newspapers.parse_explicit_date("1 يناير 2026") == date(2026, 1, 1)


def test_parse_explicit_date_invalid():
    assert newspapers.parse_explicit_date("لا يوجد تاريخ هنا") is None
    assert newspapers.parse_explicit_date("32/13/2026") is None
    assert newspapers.parse_explicit_date("") is None
    assert newspapers.parse_explicit_date(None) is None


def test_post_cairo_date():
    # 2026-11-12T06:30:00Z is 08:30 in Cairo (UTC+2 in November).
    post = _post(1, "2026-11-12T06:30:00+00:00")
    assert newspapers.post_cairo_date(post) == date(2026, 11, 12)
    # 23:30 UTC on the 11th is already the 12th in Cairo.
    post = _post(2, "2026-11-11T23:30:00+00:00")
    assert newspapers.post_cairo_date(post) == date(2026, 11, 12)
    assert newspapers.post_cairo_date(_post(3, None)) is None


# ---------------------------------------------------------------------------
# Filename cleaning / name extraction
# ---------------------------------------------------------------------------


def test_clean_filename():
    assert newspapers.clean_filename("الأهرام 12-11-2026.pdf") == "الأهرام"
    assert newspapers.clean_filename("الشرق الأوسط.pdf") == "الشرق الأوسط"
    assert newspapers.clean_filename("صحيفة الرياض 12_11_2026.PDF") == "الرياض"
    assert newspapers.clean_filename("جريدة المصري اليوم.pdf") == "المصري اليوم"


def test_extract_names_prefers_filename_over_text():
    post = _post(1, "2026-11-12T06:30:00+00:00", text="الأهرام",
                 files=[_doc("الأهرام 12-11-2026.pdf")])
    assert newspapers.extract_names(post) == ["الأهرام"]


def test_extract_names_skips_header_lines():
    # The fallback channel posts "جرايد مصر" and then the files follow.
    post = _post(1, "2026-11-12T06:30:00+00:00", text="جرايد مصر",
                 files=[_doc("الأهرام.pdf")])
    assert newspapers.extract_names(post) == ["الأهرام"]
    header_only = _post(2, "2026-11-12T06:30:00+00:00", text="جرايد مصر")
    assert newspapers.extract_names(header_only) == []


def test_extract_names_text_only_post():
    post = _post(1, "2026-11-12T06:30:00+00:00", text="الشرق الأوسط\nالخميس 12 نوفمبر 2026")
    assert newspapers.extract_names(post) == ["الشرق الأوسط"]


# ---------------------------------------------------------------------------
# Classification: Egypt-first, never guess ambiguous names
# ---------------------------------------------------------------------------


def test_classify_known_egyptian():
    assert newspapers.classify("الأهرام")[1] == "EG"
    assert newspapers.classify("المصري اليوم")[1] == "EG"
    assert newspapers.classify("الشروق")[1] == "EG"


def test_classify_known_gulf_and_london():
    assert newspapers.classify("الرياض")[1] == "SA"
    assert newspapers.classify("القبس")[1] == "KW"
    assert newspapers.classify("الشرق الأوسط")[1] == "GB"
    assert newspapers.classify("القدس العربي")[1] == "GB"
    assert newspapers.classify("النهار")[1] == "LB"


def test_classify_ambiguous_name_is_never_guessed():
    # الأخبار exists in Egypt AND Lebanon; الوطن in Qatar AND Egypt.
    assert newspapers.classify("الأخبار")[1] == "XX"
    assert newspapers.classify("الوطن")[1] == "XX"
    assert newspapers.classify("العرب")[1] == "XX"


def test_classify_country_hint_resolves_ambiguous_name():
    assert newspapers.classify("الأخبار", "صحيفة الأخبار اللبنانية")[1] == "LB"
    assert newspapers.classify("الوطن", "الوطن القطرية")[1] == "QA"
    assert newspapers.classify("جريدة مجهولة", "صحيفة مصرية")[1] == "EG"


def test_classify_source_default_country():
    # The Egyptian-only fallback channel: its papers are Egyptian even
    # when the filename carries no recognizable name.
    assert newspapers.classify("جريدة مجهولة", "", "EG")[1] == "EG"
    # ...but a mapped name is never overridden by the source default.
    assert newspapers.classify("الرياض", "", "EG")[1] == "SA"


def test_classify_longer_qualified_name_wins():
    assert newspapers.classify("الشروق التونسية")[1] == "TN"
    assert newspapers.classify("الأخبار اللبنانية")[1] == "LB"


# ---------------------------------------------------------------------------
# Entry building: today only, Egypt-first ordering, dedup
# ---------------------------------------------------------------------------


def test_entry_for_date_today_only():
    today_post = _post(1, "2026-11-12T06:30:00+00:00", text="الأهرام",
                      files=[_doc("الأهرام 12-11-2026.pdf")])
    entry = newspapers.entry_for_date(today_post, "الأهرام", TODAY, HUB)
    assert entry is not None
    assert entry["name"] == "الأهرام"
    assert entry["country"] == "EG"
    assert entry["flag"] == "🇪🇬"
    assert entry["region"] == "egypt"
    assert entry["date"] == "2026-11-12"
    assert entry["url"] == "https://t.me/arabJournalism/1"
    # No PDF is ever stored or linked directly — only the post link.
    assert entry["url"].startswith("https://t.me/")
    assert ".pdf" not in entry["url"]

    yesterday = _post(2, "2026-11-11T06:00:00+00:00", text="الأهرام",
                     files=[_doc("الأهرام 11-11-2026.pdf")])
    assert newspapers.entry_for_date(yesterday, "الأهرام", TODAY, HUB) is None


def test_entry_explicit_date_wins_when_close_to_post_date():
    # Posted late at night for the next day's paper: the date ON the
    # paper decides, so this is NOT today's paper.
    post = _post(1, "2026-11-11T23:00:00+00:00", text="الأهرام 13 نوفمبر 2026",
                 files=[_doc("الأهرام 13-11-2026.pdf")])
    assert newspapers.entry_for_date(post, "الأهرام", TODAY, HUB) is None


# ---------------------------------------------------------------------------
# Direct message links: t.me/<handle>/<post_id>, never a channel page
# ---------------------------------------------------------------------------


def test_message_url_for_post_username_form():
    post = _post(249200, "2026-11-12T06:30:00+00:00")
    url, handle = newspapers.message_url_for_post(post)
    assert url == "https://t.me/arabJournalism/249200"
    assert handle == "arabJournalism"


def test_message_url_for_post_channel_id_form():
    # A channel with no public username: the t.me/c/<id>/<post> form,
    # numeric id with the -100 prefix stripped.
    post = _post(100, "2026-11-12T06:30:00+00:00", channel="joinchat/VGPv_tnlgUJlNjdl")
    post.channel_id = -1001234567890
    url, handle = newspapers.message_url_for_post(post)
    assert url == "https://t.me/c/1234567890/100"
    assert handle is None


def test_message_url_for_post_no_link_is_none():
    # Invite key as channel, no numeric id: no direct link can be
    # built — never a bare channel page, never a broken invite link.
    post = _post(100, "2026-11-12T06:30:00+00:00", channel="joinchat/VGPv_tnlgUJlNjdl")
    assert newspapers.message_url_for_post(post) == (None, None)
    post2 = _post(100, "2026-11-12T06:30:00+00:00", channel="+5XWeEDd4wUczZTQ0")
    assert newspapers.message_url_for_post(post2) == (None, None)


def test_entry_carries_post_id_handle_and_direct_url():
    post = _post(249200, "2026-11-12T06:30:00+00:00", text="الأهرام",
                 files=[_doc("الأهرام 12-11-2026.pdf")])
    entry = newspapers.entry_for_date(post, "الأهرام", TODAY, HUB)
    assert entry is not None
    # The key data change: the entry carries its own post_id + handle,
    # and the url is rebuilt from them — a direct message link.
    assert entry["post_id"] == 249200
    assert entry["handle"] == "arabJournalism"
    assert entry["url"] == "https://t.me/arabJournalism/249200"
    assert entry["url"].endswith("/249200")
    assert ".pdf" not in entry["url"]


def test_entry_without_buildable_link_is_skipped():
    # A post whose channel is an invite key and whose numeric id is
    # unknown cannot be linked directly — it yields no entry at all
    # rather than a channel-page link.
    post = _post(100, "2026-11-12T06:30:00+00:00", text="الأهرام",
                 files=[_doc("الأهرام.pdf")], channel="joinchat/VGPv_tnlgUJlNjdl")
    assert newspapers.entry_for_date(post, "الأهرام", TODAY, HUB) is None


def test_entry_channel_id_form_from_api_post():
    post = _post(100, "2026-11-12T06:30:00+00:00", text="الأهرام",
                 files=[_doc("الأهرام.pdf")], channel="joinchat/VGPv_tnlgUJlNjdl")
    post.channel_id = -1001234567890
    entry = newspapers.entry_for_date(post, "الأهرام", TODAY, HUB)
    assert entry is not None
    assert entry["url"] == "https://t.me/c/1234567890/100"
    assert entry["handle"] is None
    assert entry["post_id"] == 100


# ---------------------------------------------------------------------------
# Country flags: the flag is the COUNTRY's flag, never per-newspaper
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("name,code,flag", [
    ("الأهرام", "EG", "🇪🇬"),
    ("الرياض", "SA", "🇸🇦"),
    ("الاتحاد", "AE", "🇦🇪"),
    ("الشرق", "QA", "🇶🇦"),
    ("القبس", "KW", "🇰🇼"),
    ("الشرق الأوسط", "GB", "🇬🇧"),
    ("النهار", "LB", "🇱🇧"),
    ("جريدة مجهولة", "XX", "🌍"),
])
def test_flag_is_country_flag(name, code, flag):
    post = _post(1, "2026-11-12T06:30:00+00:00", text=name,
                 files=[_doc(f"{name}.pdf")])
    entry = newspapers.entry_for_date(post, name, TODAY, HUB)
    assert entry is not None
    assert entry["country"] == code
    assert entry["flag"] == flag
    assert entry["country_name"] == newspapers.COUNTRIES.get(
        code, newspapers.UNKNOWN_COUNTRY)["name"]


def test_build_data_egypt_first_and_dedup():
    def ent(name, country, region, url):
        return {"name": name, "country": country, "country_name": "x",
                "flag": "🏳", "region": region, "date": "2026-11-12",
                "url": url, "source": "arabJournalism"}

    entries = [
        ent("الشرق الأوسط", "GB", "london", "https://t.me/arabJournalism/2"),
        ent("الأهرام", "EG", "egypt", "https://t.me/arabJournalism/1"),
        ent("الأهرام", "EG", "egypt", "https://t.me/arabJournalism/9"),  # dup
        ent("الرياض", "SA", "gulf", "https://t.me/arabJournalism/3"),
        ent("جريدة مجهولة", "XX", "other", "https://t.me/arabJournalism/4"),
    ]
    data = newspapers.build_data(TODAY, entries, [])
    assert [e["name"] for e in data["egypt"]] == ["الأهرام"]
    # Other papers: gulf before london before unknown.
    assert [e["name"] for e in data["other"]] == ["الرياض", "الشرق الأوسط", "جريدة مجهولة"]
    assert data["unmatched"] == ["جريدة مجهولة"]
    assert data["empty"] is False
    assert data["date"] == "2026-11-12"


def test_build_data_empty_day():
    data = newspapers.build_data(TODAY, [], [
        {"key": "arabJournalism", "label": "x", "status": "no_preview",
         "posts_seen": 0, "entries": 0, "detail": "d"}])
    assert data["empty"] is True
    assert data["egypt"] == [] and data["other"] == []
    assert data["sources"][0]["status"] == "no_preview"
    assert data["countries"] == []


def test_build_data_countries_egypt_first_with_counts():
    def ent(name, country, region, url):
        info = newspapers.COUNTRIES.get(country, newspapers.UNKNOWN_COUNTRY)
        return {"name": name, "country": country, "country_name": info["name"],
                "flag": info["flag"], "region": region, "date": "2026-11-12",
                "url": url, "source": "arabJournalism"}

    entries = [
        ent("الشرق الأوسط", "GB", "london", "https://t.me/arabJournalism/2"),
        ent("الأهرام", "EG", "egypt", "https://t.me/arabJournalism/1"),
        ent("الرياض", "SA", "gulf", "https://t.me/arabJournalism/3"),
        ent("الاتحاد", "AE", "gulf", "https://t.me/arabJournalism/5"),
        ent("القبس", "KW", "gulf", "https://t.me/arabJournalism/6"),
        ent("المصري اليوم", "EG", "egypt", "https://t.me/arabJournalism/7"),
        ent("جريدة مجهولة", "XX", "other", "https://t.me/arabJournalism/4"),
    ]
    data = newspapers.build_data(TODAY, entries, [])
    # Egypt first, then Gulf in SA/AE/QA/KW order, then London, unknown last.
    assert [(c["code"], c["count"]) for c in data["countries"]] == [
        ("EG", 2), ("SA", 1), ("AE", 1), ("KW", 1), ("GB", 1), ("XX", 1),
    ]
    assert data["countries"][0] == {"code": "EG", "name": "مصر", "flag": "🇪🇬", "count": 2}
    assert data["countries"][1]["flag"] == "🇸🇦"
    assert data["countries"][-1] == {"code": "XX", "name": "غير محدد", "flag": "🌍", "count": 1}


# ---------------------------------------------------------------------------
# Pages: per-country sub-links, empty-day notice, no served PDF links
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parent.parent.parent


def test_pages_render_country_sublinks_and_empty_notice():
    front = (REPO_ROOT / "index.html").read_text(encoding="utf-8")
    other = (REPO_ROOT / "site" / "newspapers" / "index.html").read_text(encoding="utf-8")
    for html in (front, other):
        # Both pages read the per-country list and show the empty-day
        # notice when nothing is found anywhere.
        assert "data.countries" in html
        assert "لا يوجد جرائد اليوم" in html
        assert "#country-" in html
        # No PDF link is ever served from our site.
        assert not re.search(r'href="[^"]*\.pdf', html, re.IGNORECASE)
    # Front page: Egypt first, sub-links to the other countries' sections.
    assert '"/newspapers/#country-" + c.code' in front
    assert 'c.code !== "EG"' in front
    # Other-papers page: one anchored section per country, Egypt first.
    assert 'h.id = "country-" + c.code' in other
    assert "data.egypt" in other and "data.other" in other


def test_generated_data_has_no_pdf_links(tmp_path):
    # End to end through the fixture: every emitted url is a direct
    # message link, never a PDF and never a bare channel page.
    html = (FIX / "newspapers_preview.html").read_text(encoding="utf-8")
    posts = scrape.parse_page(html, "arabJournalism")
    data = newspapers.build_data(TODAY, newspapers.entries_from_posts(posts, TODAY, HUB), [])
    for entry in data["egypt"] + data["other"]:
        assert re.match(r"^https://t\.me/([^/]+|c/\d+)/\d+$", entry["url"]), entry["url"]
        assert ".pdf" not in entry["url"]
        assert entry["url"] == f"https://t.me/{entry['handle']}/{entry['post_id']}"


# ---------------------------------------------------------------------------
# Fixture: offline preview page -> today's entries only
# ---------------------------------------------------------------------------


def test_fixture_preview_yields_todays_papers_only():
    html = (FIX / "newspapers_preview.html").read_text(encoding="utf-8")
    posts = scrape.parse_page(html, "arabJournalism")
    assert len(posts) == 4
    entries = newspapers.entries_from_posts(posts, TODAY, HUB)
    assert [(e["name"], e["country"]) for e in entries] == [
        ("الأهرام", "EG"),
        ("الشرق الأوسط", "GB"),
    ]
    # Yesterday's الأهرام and the header-only post yield nothing.
    assert all(e["date"] == "2026-11-12" for e in entries)


# ---------------------------------------------------------------------------
# collect(): preview no_preview is recorded, file still written
# ---------------------------------------------------------------------------


def test_collect_no_preview_records_status_and_stays_empty(monkeypatch, tmp_path):
    monkeypatch.setattr(scrape, "classify", lambda name: "no_preview")
    monkeypatch.setattr(newspapers, "_api_credentials_available", lambda: False)
    data = newspapers.collect(TODAY, use_api=True)
    assert data["empty"] is True
    hub = next(r for r in data["sources"] if r["key"] == "arabJournalism")
    assert hub["status"] == "no_preview"
    # The private channel is never attempted — pending join.
    eg = next(r for r in data["sources"] if r["key"] == "+5XWeEDd4wUczZTQ0")
    assert eg["status"] == "unavailable_pending_join"


def test_collect_preview_ok_writes_file(monkeypatch, tmp_path):
    html = (FIX / "newspapers_preview.html").read_text(encoding="utf-8")
    posts = scrape.parse_page(html, "arabJournalism")
    monkeypatch.setattr(scrape, "classify", lambda name: "channel")
    monkeypatch.setattr(scrape, "fetch_page", lambda channel, **kw: posts)
    out = tmp_path / "newspapers.json"
    data = newspapers.collect(TODAY, use_api=False)
    newspapers.write_data(data, out)
    loaded = json.loads(out.read_text(encoding="utf-8"))
    assert [e["name"] for e in loaded["egypt"]] == ["الأهرام"]
    assert [e["name"] for e in loaded["other"]] == ["الشرق الأوسط"]
    assert loaded["empty"] is False


def test_main_write_empty_flag(tmp_path):
    out = tmp_path / "newspapers.json"
    rc = newspapers.main(["--out", str(out), "--date", "2026-11-12", "--write-empty"])
    assert rc == 0
    data = json.loads(out.read_text(encoding="utf-8"))
    assert data["empty"] is True
    assert data["date"] == "2026-11-12"


# ---------------------------------------------------------------------------
# API path with a fake client (no Telethon, no credentials, no network)
# ---------------------------------------------------------------------------


class _FakeFile:
    def __init__(self, name):
        self.name = name
        self.size = 1024
        self.ext = "pdf"


class _FakeMsg:
    def __init__(self, msg_id, text, filename, dt):
        self.id = msg_id
        self.message = text
        self.date = dt
        self.file = _FakeFile(filename) if filename else None


class _FakeClient:
    """Duck-typed Telethon client: iter_messages + invite check."""

    def __init__(self, messages, invite_result=None):
        self._messages = messages
        self._invite_result = invite_result
        self.join_calls = 0

    async def iter_messages(self, entity, limit=None):
        for m in self._messages[:limit]:
            yield m

    async def __call__(self, request):
        # Only CheckChatInviteRequest is ever issued; a join request
        # would be a different type and must never appear.
        assert type(request).__name__ == "CheckChatInviteRequest", type(request)
        return self._invite_result


class _FakeInviteAlready:
    def __init__(self, username, chat_id=None):
        self.chat = type("Chat", (), {"username": username, "id": chat_id})()


class _FakeInviteNotMember:
    chat = None


def _run(coro):
    return asyncio.run(coro)


def test_api_username_source_reads_messages():
    from datetime import datetime, timezone as tz

    msgs = [_FakeMsg(100, "الأهرام", "الأهرام 12-11-2026.pdf",
                     datetime(2026, 11, 12, 6, 30, tzinfo=tz.utc))]
    client = _FakeClient(msgs)
    posts, report = _run(newspapers.collect_api_client(client, TODAY, HUB))
    assert report["status"] == "ok"
    entries = newspapers.entries_from_posts(posts, TODAY, HUB)
    assert [(e["name"], e["country"]) for e in entries] == [("الأهرام", "EG")]


def test_api_invite_not_member_is_reported_not_joined():
    from datetime import datetime, timezone as tz

    msgs = [_FakeMsg(100, "الأهرام", "الأهرام.pdf",
                     datetime(2026, 11, 12, 6, 30, tzinfo=tz.utc))]
    client = _FakeClient(msgs, invite_result=_FakeInviteNotMember())
    source = newspapers.SOURCES[1]  # fallback 1, invite link
    posts, report = _run(newspapers.collect_api_client(client, TODAY, source))
    assert posts == []
    assert report["status"] == "unavailable_not_member"


def test_api_invite_already_member_is_read():
    from datetime import datetime, timezone as tz

    msgs = [_FakeMsg(100, "الأهرام", "الأهرام.pdf",
                     datetime(2026, 11, 12, 6, 30, tzinfo=tz.utc))]
    client = _FakeClient(msgs, invite_result=_FakeInviteAlready("somechannel"))
    source = dict(newspapers.SOURCES[1])
    posts, report = _run(newspapers.collect_api_client(client, TODAY, source))
    assert report["status"] == "ok"
    entries = newspapers.entries_from_posts(posts, TODAY, source)
    assert entries[0]["name"] == "الأهرام"
    assert entries[0]["url"] == "https://t.me/somechannel/100"
    assert entries[0]["handle"] == "somechannel"
    assert entries[0]["post_id"] == 100


def test_api_invite_no_username_uses_channel_id_link():
    # A member channel with NO public username: the direct link is the
    # t.me/c/<id>/<post> form — never the invite link, never the
    # channel page.
    from datetime import datetime, timezone as tz

    msgs = [_FakeMsg(100, "الأهرام", "الأهرام.pdf",
                     datetime(2026, 11, 12, 6, 30, tzinfo=tz.utc))]
    client = _FakeClient(msgs, invite_result=_FakeInviteAlready(None, chat_id=-1001234567890))
    source = dict(newspapers.SOURCES[1])
    posts, report = _run(newspapers.collect_api_client(client, TODAY, source))
    assert report["status"] == "ok"
    entries = newspapers.entries_from_posts(posts, TODAY, source)
    assert len(entries) == 1
    assert entries[0]["url"] == "https://t.me/c/1234567890/100"
    assert entries[0]["handle"] is None
    assert entries[0]["post_id"] == 100


def test_api_pending_join_source_never_touches_the_client():
    client = _FakeClient([])
    posts, report = _run(newspapers.collect_api_client(client, TODAY, EG_CHANNEL))
    assert posts == []
    assert report["status"] == "unavailable_pending_join"
