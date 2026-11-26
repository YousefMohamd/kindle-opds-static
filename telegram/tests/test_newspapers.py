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
import shutil
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
# Static pages: the list is baked into the HTML at generation time (no
# fetch — the Kindle browser has no fetch()), per-country sub-links,
# empty-day notice, no served PDF links
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parent.parent.parent


def _sample_data():
    def ent(name, country, region, url):
        info = newspapers.COUNTRIES.get(country, newspapers.UNKNOWN_COUNTRY)
        return {"name": name, "country": country, "country_name": info["name"],
                "flag": info["flag"], "region": region, "date": "2026-11-12",
                "url": url, "source": "arabJournalism"}

    return newspapers.build_data(TODAY, [
        ent("الأهرام", "EG", "egypt", "https://t.me/arabJournalism/1"),
        ent("المصري اليوم", "EG", "egypt", "https://t.me/arabJournalism/7"),
        ent("الرياض", "SA", "gulf", "https://t.me/arabJournalism/3"),
        ent("الشرق الأوسط", "GB", "london", "https://t.me/arabJournalism/2"),
    ], [])


def test_render_home_static_contains_entries_and_no_fetch():
    html = newspapers.render_home_section(_sample_data())
    # The paper names and their direct message links are IN the HTML —
    # no JavaScript is needed to show them.
    assert "الأهرام" in html and "المصري اليوم" in html
    assert 'href="https://t.me/arabJournalism/1"' in html
    assert "🇪🇬" in html and "2026-11-12" in html
    assert "fetch(" not in html
    # The Egyptian list sits under an unmistakable "مصر" heading —
    # a non-Egyptian paper can never appear under it.
    assert "<h3>🇪🇬 مصر</h3>" in html
    assert html.index("🇪🇬 مصر") < html.index("الأهرام</a>")
    # Sub-links to the other countries' sections on /newspapers/.
    assert 'href="/newspapers/#country-SA"' in html
    assert "🇸🇦 السعودية (1)" in html
    assert 'href="/newspapers/#country-GB"' in html
    # Egypt itself gets no sub-link (its papers are on this page).
    assert "#country-EG" not in html


def test_render_home_static_egypt_empty_notice():
    data = _sample_data()
    data["egypt"] = []
    data["empty"] = False
    html = newspapers.render_home_section(data)
    assert "لا توجد جرائد مصرية اليوم" in html
    # No "مصر" section heading when there are no Egyptian papers.
    assert "<h3>🇪🇬 مصر</h3>" not in html
    # The other countries' papers are still reachable from here.
    assert 'href="/newspapers/#country-SA"' in html
    assert "fetch(" not in html


def test_render_static_empty_day_notice():
    data = newspapers.build_data(TODAY, [], [])
    assert data["empty"] is True
    for html in (newspapers.render_home_section(data),
                 newspapers.render_other_section(data)):
        assert "لا يوجد جرائد اليوم" in html
        assert "fetch(" not in html
        assert "<ul>" not in html


def test_render_other_static_sections_egypt_first():
    html = newspapers.render_other_section(_sample_data())
    assert "fetch(" not in html
    # Sub-link nav with counts, then one anchored section per country.
    assert 'href="#country-EG"' in html
    assert "🇪🇬 مصر (2)" in html and "🇸🇦 السعودية (1)" in html
    eg = html.index('id="country-EG"')
    sa = html.index('id="country-SA"')
    gb = html.index('id="country-GB"')
    assert eg < sa < gb  # Egypt first, then Gulf, then London.
    # Entries carry country name + date, linked to their post.
    assert "الأهرام" in html and 'href="https://t.me/arabJournalism/1"' in html
    assert "مصر — 2026-11-12" in html
    assert "الشرق الأوسط" in html and "لندن — 2026-11-12" in html
    assert not re.search(r'href="[^"]*\.pdf', html, re.IGNORECASE)


def test_render_static_escapes_names():
    data = newspapers.build_data(TODAY, [{
        "name": 'جريدة <script>alert("x")</script>', "country": "EG",
        "country_name": "مصر", "flag": "🇪🇬", "region": "egypt",
        "date": "2026-11-12", "url": "https://t.me/arabJournalism/1",
        "source": "arabJournalism"}], [])
    html = newspapers.render_home_section(data)
    assert "<script>" not in html
    assert "&lt;script&gt;" in html


def test_write_pages_roundtrip_and_idempotent(tmp_path):
    # Copy the real page templates into a scratch repo root, bake a
    # day's papers, and check the result renders with JS disabled.
    shutil.copy(REPO_ROOT / "index.html", tmp_path / "index.html")
    (tmp_path / "site" / "newspapers").mkdir(parents=True)
    shutil.copy(REPO_ROOT / "site" / "newspapers" / "index.html",
                tmp_path / "site" / "newspapers" / "index.html")
    data = _sample_data()
    written = newspapers.write_pages(data, tmp_path)
    assert len(written) == 2
    front = (tmp_path / "index.html").read_text(encoding="utf-8")
    other = (tmp_path / "site" / "newspapers" / "index.html").read_text(encoding="utf-8")
    for html in (front, other):
        assert "fetch(" not in html
        assert newspapers.STATIC_BEGIN in html and newspapers.STATIC_END in html
        assert not re.search(r'href="[^"]*\.pdf', html, re.IGNORECASE)
    assert "الأهرام" in front and 'href="https://t.me/arabJournalism/1"' in front
    assert 'id="country-EG"' in other and 'id="country-SA"' in other
    # Baking twice replaces the fragment instead of duplicating it.
    newspapers.write_pages(data, tmp_path)
    front2 = (tmp_path / "index.html").read_text(encoding="utf-8")
    assert front2.count("الأهرام") == front.count("الأهرام")
    assert front2.count(newspapers.STATIC_BEGIN) == 1


def test_write_pages_skips_page_without_markers(tmp_path, capsys):
    (tmp_path / "index.html").write_text("<html>no markers</html>", encoding="utf-8")
    (tmp_path / "site" / "newspapers").mkdir(parents=True)
    (tmp_path / "site" / "newspapers" / "index.html").write_text(
        "<html>no markers</html>", encoding="utf-8")
    written = newspapers.write_pages(_sample_data(), tmp_path)
    assert written == []
    assert "no static markers" in capsys.readouterr().out


def test_main_write_empty_bakes_pages(tmp_path):
    (tmp_path / "site" / "newspapers").mkdir(parents=True)
    shutil.copy(REPO_ROOT / "index.html", tmp_path / "index.html")
    shutil.copy(REPO_ROOT / "site" / "newspapers" / "index.html",
                tmp_path / "site" / "newspapers" / "index.html")
    out = tmp_path / "site" / "newspapers.json"
    rc = newspapers.main(["--out", str(out), "--pages-root", str(tmp_path),
                          "--date", "2026-11-12", "--write-empty"])
    assert rc == 0
    front = (tmp_path / "index.html").read_text(encoding="utf-8")
    other = (tmp_path / "site" / "newspapers" / "index.html").read_text(encoding="utf-8")
    assert "لا يوجد جرائد اليوم" in front and "لا يوجد جرائد اليوم" in other
    assert "fetch(" not in front and "fetch(" not in other


def test_committed_pages_are_static_no_fetch():
    front = (REPO_ROOT / "index.html").read_text(encoding="utf-8")
    other = (REPO_ROOT / "site" / "newspapers" / "index.html").read_text(encoding="utf-8")
    for html in (front, other):
        # The list is baked in as plain HTML: no fetch(), no JS at all
        # is needed for the newspapers list to render.
        assert "fetch(" not in html
        assert newspapers.STATIC_BEGIN in html and newspapers.STATIC_END in html
        # The loading placeholder is gone — the page shows real content
        # (an empty-day notice, or the paper list) with JS disabled.
        assert "جارٍ تحميل جرائد اليوم" not in html
        assert ("لا يوجد جرائد اليوم" in html
                or "لا توجد جرائد مصرية اليوم" in html
                or ("<ul>" in html and "t.me/" in html))
        # No PDF link is ever served from our site.
        assert not re.search(r'href="[^"]*\.pdf', html, re.IGNORECASE)


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
    rc = newspapers.main(["--out", str(out), "--date", "2026-11-12", "--write-empty", "--no-pages"])
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


# ---------------------------------------------------------------------------
# Title cleaning + country classification fixes (live data 2026-11-14:
# 18 EG / 50 other / 33 XX, incl. a UUID, an invite URL, bare dates,
# ALL-CAPS Latin names, and country-prefixed names the old code
# misread — "الأردن الدستور" came out Egyptian, "الإمارات الفجر"
# came out Egyptian, "الأردن الرأي" came out XX).
# ---------------------------------------------------------------------------


def test_normalize_arabic_nfc_combining_hamza():
    # The hub posts combining hamza (alef + U+0654), not precomposed أ:
    # without NFC, "الأردن" never matched "الأردن" in the maps.
    assert newspapers.normalize_arabic("الا\u0654ردن") == newspapers.normalize_arabic("الأردن")
    assert newspapers.normalize_arabic("الا\u0655مارات") == newspapers.normalize_arabic("الإمارات")
    assert newspapers.normalize_arabic("الرأي") == newspapers.normalize_arabic("الرأي")
    # NOTE: normalize_arabic folds أ into ا, so "الرأي" (Jordan) and
    # "الراي" (Kuwait) normalize to the SAME string — exact matching
    # must not use it (see _norm_exact). classify() still tells them
    # apart, and the country prefix saves the qualified form.
    assert newspapers.classify("الرأي") == ("الرأي", "JO")
    assert newspapers.classify("الراي") == ("الراي", "KW")


def test_parse_explicit_date_english_months():
    assert newspapers.parse_explicit_date("14 Nov 2026") == date(2026, 11, 14)
    assert newspapers.parse_explicit_date("14 November 2026") == date(2026, 11, 14)
    assert newspapers.parse_explicit_date("Nov 14, 2026") == date(2026, 11, 14)
    assert newspapers.parse_explicit_date("QATAR GT 14 Nov 2026") == date(2026, 11, 14)
    assert newspapers.parse_explicit_date("14 Nov 26") is None  # two-digit year: no


def test_clean_filename_english_dates_and_trailing_numbers():
    # clean_filename only title-cases; the canonical "Qatar GT" form
    # comes from classify()'s display map (tested below).
    assert newspapers.clean_filename("QATAR GT 14 Nov 2026") == "Qatar Gt"
    assert newspapers.clean_filename("Saudi Gazette 14 Nov 2026") == "Saudi Gazette"
    assert newspapers.clean_filename("Arab News 14 Nov 2026") == "Arab News"
    assert newspapers.clean_filename("الجزيرة 13") == "الجزيرة"
    assert newspapers.clean_filename("الرياض 13") == "الرياض"
    assert newspapers.clean_filename("MASA 121338") == "Masa"
    assert newspapers.clean_filename("AL ahram 14 11") == "AL ahram"
    assert newspapers.clean_filename("Al Ahram m") == "Al Ahram"


def test_clean_filename_arabic_dates_weekdays_and_filler():
    assert newspapers.clean_filename("البوابة عدد 14 نوفمبر") == "البوابة"
    assert newspapers.clean_filename("عدد الشروق ليوم السبت 🤲") == "الشروق"
    assert newspapers.clean_filename("مصر الأهرام (ط2)") == "مصر الأهرام"
    assert newspapers.clean_filename("😄😁😄 صحف مصر 😄😁😄") == "صحف مصر"
    assert newspapers.clean_filename("الشرق الأوسط 14 نوفمبر") == "الشرق الأوسط"


def test_clean_filename_invisible_chars_and_urls():
    assert newspapers.clean_filename("\u200eالجمهورية") == "الجمهورية"
    assert newspapers.clean_filename("https://t me/joinchat/VGPv tnlgUJlNjdl") == ""
    assert newspapers.clean_filename("https://t.me/joinchat/VGPv_tnlgUJlNjdl") == ""


def test_clean_filename_caps_normalization():
    assert newspapers.clean_filename("AKHBAR ELYOUM") == "Akhbar Elyoum"
    assert newspapers.clean_filename("alwafd") == "Alwafd"
    # Mixed case is left alone — classify() canonicalizes it.
    assert newspapers.clean_filename("Saudi Gazette") == "Saudi Gazette"


def test_junk_reason():
    assert newspapers.junk_reason("598a3cda a423 4645 b72d 3e29882a7f8b") == "uuid"
    assert newspapers.junk_reason("598a3cda-a423-4645-b72d-3e29882a7f8b") == "uuid"
    assert newspapers.junk_reason("https://t me/joinchat/VGPv tnlgUJlNjdl") == "url"
    assert newspapers.junk_reason("14 Nov 2026") == "bare_date"
    assert newspapers.junk_reason("14 نوفمبر 2026") == "bare_date"
    assert newspapers.junk_reason("🇪🇬") == "flag_or_emoji_only"
    assert newspapers.junk_reason("🇵🇸") == "flag_or_emoji_only"
    assert newspapers.junk_reason("😄😁😄 صحف اليوم السبت 14 11 26 😄😁😄") == "header"
    assert newspapers.junk_reason("😄😁😄 صحف مصر 😄😁😄") == "header"
    assert newspapers.junk_reason("مصر") == "country_only"
    # Real papers — even unclassifiable ones — are NEVER junk.
    assert newspapers.junk_reason("الأهرام") is None
    assert newspapers.junk_reason("كبسولة") is None
    assert newspapers.junk_reason("اليوم") is None
    assert newspapers.junk_reason("AKHBAR ELYOUM") is None


def test_extract_names_drops_junk_and_records_it():
    flag_post = _post(1, "2026-11-12T06:30:00+00:00", text="🇪🇬")
    dropped: list = []
    assert newspapers.extract_names(flag_post, dropped=dropped) == []
    assert dropped == [{"name": "🇪🇬", "reason": "flag_or_emoji_only"}]
    uuid_post = _post(2, "2026-11-12T06:30:00+00:00",
                      files=[_doc("598a3cda a423 4645 b72d 3e29882a7f8b.pdf")])
    dropped = []
    assert newspapers.extract_names(uuid_post, dropped=dropped) == []
    assert dropped[0]["reason"] == "uuid"


def test_classify_country_prefix_wins_over_paper_map():
    # The hub's "COUNTRY PAPER" format: the prefix is the country, even
    # when the short paper name maps elsewhere.
    assert newspapers.classify("الأردن الدستور") == ("الدستور", "JO")
    assert newspapers.classify("الإمارات الفجر") == ("الفجر", "AE")
    assert newspapers.classify("مصر الأخبار") == ("الأخبار", "EG")
    assert newspapers.classify("فلسطين الأيام") == ("الأيام", "PS")
    assert newspapers.classify("فلسطين الحياة الجديدة") == ("الحياة الجديدة", "PS")
    assert newspapers.classify("لندن الشرق الأوسط") == ("الشرق الأوسط", "GB")
    assert newspapers.classify("البحرين الوطن") == ("الوطن", "BH")
    assert newspapers.classify("البحرين أخبار الخليج") == ("أخبار الخليج", "BH")
    assert newspapers.classify("عُمان عُمان") == ("عُمان", "OM")
    assert newspapers.classify("السعودية الرياض") == ("الرياض", "SA")
    assert newspapers.classify("مصر صوت الأزهر") == ("صوت الأزهر", "EG")
    assert newspapers.classify("لندن العربي الجديد") == ("العربي الجديد", "GB")


def test_classify_whole_known_name_is_never_stripped():
    # "الإمارات اليوم" IS the paper — the leading country word is part
    # of its name, not a prefix to remove.
    assert newspapers.classify("الإمارات اليوم") == ("الإمارات اليوم", "AE")
    assert newspapers.classify("الإمارات الإمارات اليوم") == ("الإمارات اليوم", "AE")
    assert newspapers.classify("الشرق الأوسط") == ("الشرق الأوسط", "GB")


def test_classify_combining_hamza_titles():
    # Live titles with combining hamza (alef + U+0654/U+0655).
    assert newspapers.classify("الا\u0654ردن الرا\u0654ي") == ("الرأي", "JO")
    assert newspapers.classify("الا\u0655مارات الاتحاد") == ("الاتحاد", "AE")
    assert newspapers.classify("مصر الا\u0654هرام") == ("الأهرام", "EG")


def test_classify_english_and_transliterated_names():
    assert newspapers.classify("Saudi Gazette 14 Nov 2026") == ("Saudi Gazette", "SA")
    assert newspapers.classify("Arab News 14 Nov 2026") == ("Arab News", "SA")
    assert newspapers.classify("QATAR GT 14 Nov 2026") == ("Qatar GT", "QA")
    assert newspapers.classify("AKHBAR ELYOUM") == ("Akhbar Elyoum", "EG")
    assert newspapers.classify("alwafd") == ("Al Wafd", "EG")
    assert newspapers.classify("AL ahram 14 11") == ("Al Ahram", "EG")
    assert newspapers.classify("Al Ahram m") == ("Al Ahram", "EG")
    assert newspapers.classify("MASA 121338") == ("Masa", "EG")
    # A Latin paper whose name starts with a country word keeps its
    # full name (the country is the section, not a prefix to strip).
    assert newspapers.classify("Qatar Tribune") == ("Qatar Tribune", "QA")


def test_classify_unclassifiable_stays_xx_and_is_kept():
    # Supplements / section names, not newspapers with a known country
    # — kept in the listing under XX, recorded in "unmatched", never
    # guessed and never dropped.
    for name in ("كبسولة", "اليوم", "الرحلة", "الكأس"):
        assert newspapers.classify(name)[1] == "XX"


# ---------------------------------------------------------------------------
# Evening editions: "مسائي" marks an evening edition — it is grouped
# separately, never mixed into the morning list of the same paper.
# ---------------------------------------------------------------------------


def test_is_evening_edition():
    assert newspapers.is_evening_edition("الأهرام المسائي") is True
    assert newspapers.is_evening_edition("مصر الأهرام المسائي") is True
    assert newspapers.is_evening_edition("Evening Standard") is True
    assert newspapers.is_evening_edition("الأهرام") is False
    # "المساء" on its own is a paper name, not an evening marker.
    assert newspapers.is_evening_edition("المساء") is False
    assert newspapers.is_evening_edition("مصر المساء") is False


def test_entry_evening_edition_is_separate_from_morning():
    morning = _post(1, "2026-11-12T06:30:00+00:00", text="الأهرام",
                    files=[_doc("الأهرام 12-11-2026.pdf")])
    evening = _post(2, "2026-11-12T18:30:00+00:00", text="الأهرام المسائي",
                    files=[_doc("الأهرام المسائي 12-11-2026.pdf")])
    m = newspapers.entry_for_date(morning, "الأهرام", TODAY, HUB)
    e = newspapers.entry_for_date(evening, "الأهرام المسائي", TODAY, HUB)
    assert m is not None and m["edition"] == "morning"
    assert e is not None and e["edition"] == "evening"
    assert e["name"] == "الأهرام المسائي" and e["country"] == "EG"
    # Morning and evening are different entries — the evening one does
    # not dedup away against the morning one.
    data = newspapers.build_data(TODAY, [m, e], [])
    assert len(data["egypt"]) == 2


def test_build_data_dedup_is_country_aware():
    def ent(name, country, region, url):
        info = newspapers.COUNTRIES.get(country, newspapers.UNKNOWN_COUNTRY)
        return {"name": name, "country": country, "country_name": info["name"],
                "flag": info["flag"], "region": region, "date": "2026-11-12",
                "url": url, "source": "arabJournalism"}

    # "الأيام" in Bahrain AND Palestine: same name, two papers.
    data = newspapers.build_data(TODAY, [
        ent("الأيام", "BH", "gulf", "https://t.me/arabJournalism/1"),
        ent("الأيام", "PS", "arab", "https://t.me/arabJournalism/2"),
        ent("الأيام", "BH", "gulf", "https://t.me/arabJournalism/3"),  # dup
    ], [])
    assert len(data["other"]) == 2
    assert {e["country"] for e in data["other"]} == {"BH", "PS"}


def test_build_data_records_dropped():
    data = newspapers.build_data(TODAY, [], [], dropped=[
        {"name": "598a3cda a423 4645 b72d 3e29882a7f8b", "reason": "uuid",
         "source": "arabJournalism"},
        {"name": "🇪🇬", "reason": "flag_or_emoji_only", "source": "arabJournalism"},
        {"name": "🇪🇬", "reason": "flag_or_emoji_only", "source": "arabJournalism"},
    ])
    assert data["dropped"] == [
        {"name": "598a3cda a423 4645 b72d 3e29882a7f8b", "reason": "uuid",
         "source": "arabJournalism"},
        {"name": "🇪🇬", "reason": "flag_or_emoji_only", "source": "arabJournalism"},
    ]
    assert newspapers.build_data(TODAY, [], [])["dropped"] == []


def test_render_evening_is_a_separate_group():
    def ent(name, country, region, url, edition="morning"):
        info = newspapers.COUNTRIES.get(country, newspapers.UNKNOWN_COUNTRY)
        return {"name": name, "country": country, "country_name": info["name"],
                "flag": info["flag"], "region": region, "edition": edition,
                "date": "2026-11-12", "url": url, "source": "arabJournalism"}

    data = newspapers.build_data(TODAY, [
        ent("الأهرام", "EG", "egypt", "https://t.me/arabJournalism/1"),
        ent("الأهرام المسائي", "EG", "egypt", "https://t.me/arabJournalism/2", "evening"),
        ent("الرياض", "SA", "gulf", "https://t.me/arabJournalism/3"),
    ], [])
    home = newspapers.render_home_section(data)
    assert "🌙 المسائية" in home
    assert "<h3>🇪🇬 مصر</h3>" in home
    assert home.index("🇪🇬 مصر") < home.index("الأهرام</a>") < home.index("المسائية")
    assert home.index("المسائية") < home.index("الأهرام المسائي")
    other = newspapers.render_other_section(data)
    assert "🌙 المسائية" in other
    assert other.index('id="country-EG"') < other.index("المسائية")
    assert other.index("المسائية") < other.index("الأهرام المسائي")


# ---------------------------------------------------------------------------
# Live-data replay (2026-11-14 titles, embedded — no network): the exact
# titles the user flagged, with the expected cleaned result.
# ---------------------------------------------------------------------------

LIVE_TITLES = [
    # (raw title, expected display, expected country, expected edition)
    ("الأردن الدستور", "الدستور", "JO", "morning"),
    ("الإمارات الفجر", "الفجر", "AE", "morning"),
    ("البوابة عدد 14 نوفمبر", "البوابة", "EG", "morning"),
    ("عدد الشروق ليوم السبت 🤲", "الشروق", "EG", "morning"),
    ("مصر الأخبار", "الأخبار", "EG", "morning"),
    ("مصر الأهرام", "الأهرام", "EG", "morning"),
    ("مصر الأهرام (ط2)", "الأهرام", "EG", "morning"),
    ("مصر الأهرام المسائي", "الأهرام المسائي", "EG", "evening"),
    ("مصر البوابة", "البوابة", "EG", "morning"),
    ("مصر الجمهورية", "الجمهورية", "EG", "morning"),
    ("مصر الشروق", "الشروق", "EG", "morning"),
    ("مصر المساء", "المساء", "EG", "morning"),
    ("مصر المصري اليوم", "المصري اليوم", "EG", "morning"),
    ("مصر النشرة اليومية مهرجان القاهرة", "النشرة اليومية مهرجان القاهرة", "EG", "morning"),
    ("مصر الوفد", "الوفد", "EG", "morning"),
    ("مصر صوت الأزهر", "صوت الأزهر", "EG", "morning"),
    ("\u200eالجمهورية", "الجمهورية", "EG", "morning"),
    ("الإمارات الاتحاد", "الاتحاد", "AE", "morning"),
    ("الإمارات البيان", "البيان", "AE", "morning"),
    ("البحرين الأيام", "الأيام", "BH", "morning"),
    ("البحرين البلاد", "البلاد", "BH", "morning"),
    ("البحرين الوطن", "الوطن", "BH", "morning"),
    ("البحرين أخبار الخليج", "أخبار الخليج", "BH", "morning"),
    ("الجزيرة 13", "الجزيرة", "SA", "morning"),
    ("الرياض 13", "الرياض", "SA", "morning"),
    ("عكاظ 13", "عكاظ", "SA", "morning"),
    ("الرياضية", "الرياضية", "SA", "morning"),
    ("عُمان عُمان", "عُمان", "OM", "morning"),
    ("قطر الراية", "الراية", "QA", "morning"),
    ("لندن الشرق الأوسط", "الشرق الأوسط", "GB", "morning"),
    ("لندن العرب", "العرب", "GB", "morning"),
    ("لندن العربي الجديد", "العربي الجديد", "GB", "morning"),
    ("لندن القدس العربي", "القدس العربي", "GB", "morning"),
    ("الأردن الغد", "الغد", "JO", "morning"),
    ("الأردن الرأي", "الرأي", "JO", "morning"),
    ("الإمارات الإمارات اليوم", "الإمارات اليوم", "AE", "morning"),
    ("الإمارات الخليج", "الخليج", "AE", "morning"),
    ("الإمارات الخليج الاقتصادي", "الخليج الاقتصادي", "AE", "morning"),
    ("الإمارات الوحدة", "الوحدة", "AE", "morning"),
    ("الإمارات الوطن", "الوطن", "AE", "morning"),
    ("فلسطين الأيام", "الأيام", "PS", "morning"),
    ("فلسطين الحياة الجديدة", "الحياة الجديدة", "PS", "morning"),
    ("AKHBAR ELYOUM", "Akhbar Elyoum", "EG", "morning"),
    ("AL ahram 14 11", "Al Ahram", "EG", "morning"),
    ("Al Ahram m", "Al Ahram", "EG", "morning"),
    ("Arab News 14 Nov 2026", "Arab News", "SA", "morning"),
    ("MASA 121338", "Masa", "EG", "morning"),
    ("QATAR GT 14 Nov 2026", "Qatar GT", "QA", "morning"),
    ("Saudi Gazette 14 Nov 2026", "Saudi Gazette", "SA", "morning"),
    ("alwafd", "Al Wafd", "EG", "morning"),
    ("كبسولة", "كبسولة", "XX", "morning"),
    ("اليوم", "اليوم", "XX", "morning"),
    ("الرحلة", "الرحلة", "XX", "morning"),
    ("الكأس", "الكأس", "XX", "morning"),
]

LIVE_DROPPED = [
    "598a3cda a423 4645 b72d 3e29882a7f8b",
    "https://t me/joinchat/VGPv tnlgUJlNjdl",
    "14 Nov 2026",
    "🇦🇪", "🇧🇭", "🇪🇬", "🇬🇧", "🇯🇴", "🇴🇲", "🇵🇸", "🇶🇦", "🇸🇦",
    "😄😁😄 صحف مصر 😄😁😄",
    "😄😁😄 صحف اليوم السبت 14 11 26 😄😁😄",
]


@pytest.mark.parametrize("raw,display,code,edition", LIVE_TITLES)
def test_live_titles_replay(raw, display, code, edition):
    assert newspapers.junk_reason(raw) is None, raw
    name, got_code = newspapers.classify(raw)
    assert (name, got_code) == (display, code), raw
    assert ("evening" if newspapers.is_evening_edition(name) else "morning") == edition


@pytest.mark.parametrize("raw", LIVE_DROPPED)
def test_live_junk_titles_are_dropped(raw):
    assert newspapers.junk_reason(raw) is not None, raw


# ---------------------------------------------------------------------------
# "مصر" label (user addition 2026-11-14 ~21:33): the Egyptian section
# must carry an unmistakable "مصر" label, and no non-Egyptian paper
# may ever appear under it. Labelling is on OUR side only (data +
# website) — nothing is posted to the @arabJournalism channel.
# ---------------------------------------------------------------------------


def test_egypt_entries_always_carry_eg_and_masr():
    # Data guarantee: every entry in the "egypt" list has country EG,
    # country_name مصر and the 🇪🇬 flag — explicit, never blank or XX.
    def ent(name, country, region, url):
        info = newspapers.COUNTRIES.get(country, newspapers.UNKNOWN_COUNTRY)
        return {"name": name, "country": country, "country_name": info["name"],
                "flag": info["flag"], "region": region, "date": "2026-11-12",
                "url": url, "source": "arabJournalism"}

    data = newspapers.build_data(TODAY, [
        ent("الأهرام", "EG", "egypt", "https://t.me/arabJournalism/1"),
        ent("المصري اليوم", "EG", "egypt", "https://t.me/arabJournalism/7"),
        ent("الرياض", "SA", "gulf", "https://t.me/arabJournalism/3"),
        ent("جريدة مجهولة", "XX", "other", "https://t.me/arabJournalism/4"),
    ], [])
    assert all(e["country"] == "EG" for e in data["egypt"])
    assert all(e["country_name"] == "مصر" for e in data["egypt"])
    assert all(e["flag"] == "🇪🇬" for e in data["egypt"])
    assert all(e["country"] != "EG" for e in data["other"])


def test_country_sections_never_mix():
    # Each country is its own anchored section with its own header;
    # the unknown-country papers sit under a labelled "غير محدد"
    # section of their own — never under مصر or any other country.
    def ent(name, country, region, url):
        info = newspapers.COUNTRIES.get(country, newspapers.UNKNOWN_COUNTRY)
        return {"name": name, "country": country, "country_name": info["name"],
                "flag": info["flag"], "region": region, "date": "2026-11-12",
                "url": url, "source": "arabJournalism"}

    data = newspapers.build_data(TODAY, [
        ent("الأهرام", "EG", "egypt", "https://t.me/arabJournalism/1"),
        ent("الرياض", "SA", "gulf", "https://t.me/arabJournalism/3"),
        ent("جريدة مجهولة", "XX", "other", "https://t.me/arabJournalism/4"),
    ], [])
    html = newspapers.render_other_section(data)
    assert '<h2 id="country-EG">🇪🇬 مصر</h2>' in html
    assert '<h2 id="country-SA">🇸🇦 السعودية</h2>' in html
    assert '<h2 id="country-XX">🌍 غير محدد</h2>' in html
    eg = html.index('id="country-EG"')
    sa = html.index('id="country-SA"')
    xx = html.index('id="country-XX"')
    assert eg < html.index("الأهرام</a>") < sa
    assert sa < html.index("الرياض</a>") < xx
    assert xx < html.index("جريدة مجهولة</a>")
    # And the home page never shows a non-Egyptian paper at all.
    home = newspapers.render_home_section(data)
    assert "الأهرام" in home and "الرياض" not in home and "جريدة مجهولة" not in home


def test_newspapers_page_intro_names_egypt_first():
    # The /newspapers/ page's own intro (outside the baked fragment)
    # must not claim the page is "from outside Egypt" — Egypt has its
    # own section on this page, first.
    text = (REPO_ROOT / "site" / "newspapers" / "index.html").read_text(encoding="utf-8")
    assert "من خارج مصر" not in text
    assert "مصر أولاً" in text
    assert newspapers.STATIC_BEGIN in text and newspapers.STATIC_END in text


# ---------------------------------------------------------------------------
# Publish guard (guard_publish, G1-G7) + watch mode (--watch)
# ---------------------------------------------------------------------------


def _gent(name, country, region, day, url):
    info = newspapers.COUNTRIES.get(country, newspapers.UNKNOWN_COUNTRY)
    return {"name": name, "country": country, "country_name": info["name"],
            "flag": info["flag"], "region": region, "date": day.isoformat(),
            "edition": "morning", "url": url, "handle": "arabJournalism",
            "post_id": 1, "source": "arabJournalism"}


def _gdata(day, n_eg, n_other, statuses=("ok", "ok")):
    """A build_data dict with n_eg Egypt + n_other other entries for `day`."""
    entries = [_gent(f"ورقة مصر {i}", "EG", "egypt", day,
                     f"https://t.me/arabJournalism/{100 + i}") for i in range(n_eg)]
    entries += [_gent(f"ورقة {i}", "SA", "gulf", day,
                      f"https://t.me/arabJournalism/{200 + i}") for i in range(n_other)]
    reports = [{"key": k, "label": k, "status": s, "posts_seen": 1,
                "entries": 1, "detail": ""}
               for k, s in zip(("arabJournalism", "fallback"), statuses)]
    return newspapers.build_data(day, entries, reports)


def test_guard_no_previous_file_allows():
    new = _gdata(TODAY, 1, 0)
    assert newspapers.guard_publish(new, None, backstop=False)[0] is True
    assert newspapers.guard_publish(new, {}, backstop=False)[0] is True
    assert newspapers.guard_publish(new, "not-a-dict", backstop=False)[0] is True


def test_guard_new_day_with_entries_allows():
    old = _gdata(date(2026, 11, 11), 10, 68)
    new = _gdata(TODAY, 2, 1)
    allowed, reason = newspapers.guard_publish(new, old, backstop=False)
    assert allowed is True
    assert reason.startswith("G2")


def test_guard_backstop_empty_new_day_allowed():
    old = _gdata(date(2026, 11, 11), 10, 68)
    new = _gdata(TODAY, 0, 0)
    allowed, reason = newspapers.guard_publish(new, old, backstop=True)
    assert allowed is True
    assert reason.startswith("G3")


def test_guard_watch_empty_new_day_blocked():
    old = _gdata(date(2026, 11, 11), 10, 68)
    new = _gdata(TODAY, 0, 0)
    allowed, reason = newspapers.guard_publish(new, old, backstop=False)
    assert allowed is False
    assert reason.startswith("G3")


def test_guard_backstop_empty_blocked_when_a_source_errored():
    old = _gdata(date(2026, 11, 11), 10, 68)
    new = _gdata(TODAY, 0, 0, statuses=("ok", "error"))
    allowed, reason = newspapers.guard_publish(new, old, backstop=True)
    assert allowed is False
    assert reason.startswith("G3")


def test_guard_backstop_empty_blocked_when_nothing_read_ok():
    old = _gdata(date(2026, 11, 11), 10, 68)
    new = _gdata(TODAY, 0, 0, statuses=("no_preview", "unavailable_no_credentials"))
    allowed, reason = newspapers.guard_publish(new, old, backstop=True)
    assert allowed is False
    assert reason.startswith("G7")


def test_guard_same_day_empty_always_blocked():
    old = _gdata(TODAY, 10, 68)
    new = _gdata(TODAY, 0, 0)
    for backstop in (True, False):
        allowed, reason = newspapers.guard_publish(new, old, backstop=backstop)
        assert allowed is False
        assert reason.startswith("G4")


def test_guard_steep_drop_blocked():
    # The 2026-11-19 class: 78 published papers, a glitch read finds 10.
    old = _gdata(TODAY, 10, 68)
    new = _gdata(TODAY, 2, 8)
    allowed, reason = newspapers.guard_publish(new, old, backstop=True)
    assert allowed is False
    assert reason.startswith("G5")


def test_guard_steep_drop_boundary_exactly_half_passes():
    old = _gdata(TODAY, 10, 68)   # 78
    new = _gdata(TODAY, 10, 29)   # 39 == 78 // 2
    assert newspapers.guard_publish(new, old, backstop=True)[0] is True


def test_guard_small_old_total_not_over_guarded():
    old = _gdata(TODAY, 5, 4)     # 9 < 10: G5 does not apply
    new = _gdata(TODAY, 1, 0)
    assert newspapers.guard_publish(new, old, backstop=True)[0] is True


def test_guard_old_total_10_boundary():
    old = _gdata(TODAY, 5, 5)     # 10
    new = _gdata(TODAY, 2, 3)     # 5 == 10 // 2 -> passes
    assert newspapers.guard_publish(new, old, backstop=True)[0] is True
    new = _gdata(TODAY, 2, 2)     # 4 < 5 -> blocked
    allowed, reason = newspapers.guard_publish(new, old, backstop=True)
    assert allowed is False
    assert reason.startswith("G5")


def test_guard_egypt_section_lost_blocked():
    old = _gdata(TODAY, 10, 68)   # 78
    new = _gdata(TODAY, 0, 68)    # 68 passes G5 (68 >= 39) but loses Egypt
    allowed, reason = newspapers.guard_publish(new, old, backstop=True)
    assert allowed is False
    assert reason.startswith("G6")


def test_guard_egypt_zero_to_zero_is_not_a_loss():
    old = _gdata(TODAY, 0, 40)
    new = _gdata(TODAY, 0, 41)
    assert newspapers.guard_publish(new, old, backstop=True)[0] is True


def test_guard_egypt_one_to_zero_blocked():
    old = _gdata(TODAY, 1, 40)    # 41
    new = _gdata(TODAY, 0, 40)    # 40 passes G5 (40 >= 20), G6 blocks
    allowed, reason = newspapers.guard_publish(new, old, backstop=True)
    assert allowed is False
    assert reason.startswith("G6")


def test_guard_no_source_ok_always_blocked():
    old = _gdata(TODAY, 10, 68)
    new = _gdata(TODAY, 10, 70, statuses=("error", "error"))
    allowed, reason = newspapers.guard_publish(new, old, backstop=True)
    assert allowed is False
    assert reason.startswith("G7")


def _watch_hub_post(post_id):
    return _post(post_id, "2026-11-12T06:30:00+00:00",
                 text="الأهرام", files=[_doc("الأهرام 12-11-2026.pdf")])


def _watch_fallback_post(post_id):
    return _post(post_id, "2026-11-12T07:00:00+00:00",
                 text="الأهرام", files=[_doc("الأهرام 12-11-2026.pdf")],
                 channel="fallbackchan")


def _fake_watch_api(hub_posts, hub_status="ok", fb_posts=(), fb_status="ok"):
    async def _fake(today, sources, limit=15):
        return {
            "arabJournalism": (list(hub_posts),
                               {"key": "arabJournalism", "label": "hub",
                                "status": hub_status, "posts_seen": len(hub_posts),
                                "entries": 0, "detail": ""}),
            "joinchat/VGPv_tnlgUJlNjdl": (list(fb_posts),
                                          {"key": "joinchat/VGPv_tnlgUJlNjdl",
                                           "label": "fallback", "status": fb_status,
                                           "posts_seen": len(fb_posts), "entries": 0,
                                           "detail": ""}),
        }
    return _fake


def test_watch_new_post_is_changed(monkeypatch, tmp_path):
    out = tmp_path / "newspapers.json"
    newspapers.write_data(_gdata(TODAY, 1, 0), out)  # published: .../100
    monkeypatch.setattr(newspapers, "_watch_api_all",
                        _fake_watch_api([_watch_hub_post(101)]))
    state, new_entries, _reports = newspapers.watch_check(TODAY, out=out)
    assert state == "changed"
    assert [e["url"] for e in new_entries] == ["https://t.me/arabJournalism/101"]


def test_watch_identical_set_is_unchanged(monkeypatch, tmp_path):
    out = tmp_path / "newspapers.json"
    newspapers.write_data(_gdata(TODAY, 1, 0), out)  # published: .../100
    monkeypatch.setattr(newspapers, "_watch_api_all",
                        _fake_watch_api([_watch_hub_post(100)]))
    state, new_entries, _reports = newspapers.watch_check(TODAY, out=out)
    assert state == "unchanged"
    assert new_entries == []


def test_watch_hub_error_is_unknown(monkeypatch, tmp_path):
    out = tmp_path / "newspapers.json"
    newspapers.write_data(_gdata(TODAY, 1, 0), out)
    monkeypatch.setattr(newspapers, "_watch_api_all",
                        _fake_watch_api([_watch_hub_post(101)], hub_status="error"))
    state, _entries, _reports = newspapers.watch_check(TODAY, out=out)
    assert state == "unknown"


def test_watch_fallback_only_new_post_is_changed(monkeypatch, tmp_path):
    out = tmp_path / "newspapers.json"
    newspapers.write_data(_gdata(TODAY, 1, 0), out)  # hub .../100 only
    monkeypatch.setattr(newspapers, "_watch_api_all",
                        _fake_watch_api([_watch_hub_post(100)],
                                        fb_posts=[_watch_fallback_post(201)]))
    state, new_entries, _reports = newspapers.watch_check(TODAY, out=out)
    assert state == "changed"
    assert [e["url"] for e in new_entries] == ["https://t.me/fallbackchan/201"]


def test_watch_missing_published_file_is_changed(monkeypatch, tmp_path):
    out = tmp_path / "newspapers.json"  # does not exist: first run
    monkeypatch.setattr(newspapers, "_watch_api_all",
                        _fake_watch_api([_watch_hub_post(101)]))
    state, new_entries, _reports = newspapers.watch_check(TODAY, out=out)
    assert state == "changed"
    assert len(new_entries) == 1


def test_main_watch_unchanged_writes_nothing(monkeypatch, tmp_path):
    out = tmp_path / "newspapers.json"
    monkeypatch.setattr(newspapers, "_api_credentials_available", lambda: True)
    monkeypatch.setattr(newspapers, "watch_check",
                        lambda today, limit=15, out=None: ("unchanged", [], []))
    rc = newspapers.main(["--out", str(out), "--date", "2026-11-12",
                          "--watch", "--no-pages"])
    assert rc == 0
    assert not out.exists()


def test_main_watch_no_credentials_skips(monkeypatch, tmp_path):
    out = tmp_path / "newspapers.json"
    monkeypatch.setattr(newspapers, "_api_credentials_available", lambda: False)
    rc = newspapers.main(["--out", str(out), "--date", "2026-11-12",
                          "--watch", "--no-pages"])
    assert rc == 0
    assert not out.exists()


def test_main_watch_changed_publishes(monkeypatch, tmp_path):
    out = tmp_path / "newspapers.json"
    newspapers.write_data(_gdata(date(2026, 11, 11), 10, 68), out)
    new = _gdata(TODAY, 2, 1)
    monkeypatch.setattr(newspapers, "_api_credentials_available", lambda: True)
    monkeypatch.setattr(newspapers, "watch_check",
                        lambda today, limit=15, out=None:
                        ("changed", new["egypt"] + new["other"], []))
    monkeypatch.setattr(newspapers, "collect", lambda *a, **k: new)
    rc = newspapers.main(["--out", str(out), "--date", "2026-11-12",
                          "--watch", "--no-pages"])
    assert rc == 0
    written = json.loads(out.read_text(encoding="utf-8"))
    assert written["date"] == "2026-11-12"
    assert len(written["egypt"]) == 2


def test_main_backstop_blocks_steep_drop(monkeypatch, tmp_path):
    out = tmp_path / "newspapers.json"
    newspapers.write_data(_gdata(TODAY, 10, 68), out)  # 78 published
    glitch = _gdata(TODAY, 2, 8)  # API glitch finds 10
    monkeypatch.setattr(newspapers, "collect", lambda *a, **k: glitch)
    rc = newspapers.main(["--out", str(out), "--date", "2026-11-12",
                          "--force", "--no-pages"])
    assert rc == 0
    kept = json.loads(out.read_text(encoding="utf-8"))
    assert len(kept["egypt"]) + len(kept["other"]) == 78


def test_main_write_empty_over_good_file_is_blocked(tmp_path):
    out = tmp_path / "newspapers.json"
    newspapers.write_data(_gdata(TODAY, 10, 68), out)
    rc = newspapers.main(["--out", str(out), "--date", "2026-11-12",
                          "--write-empty", "--no-pages"])
    assert rc == 0
    kept = json.loads(out.read_text(encoding="utf-8"))
    assert kept["empty"] is False
    assert len(kept["egypt"]) + len(kept["other"]) == 78


def test_workflow_has_no_write_empty_step_and_new_schedule():
    text = (REPO_ROOT / ".github" / "workflows" / "telegram-newspapers.yml"
            ).read_text(encoding="utf-8")
    # No step may RUN --write-empty (the header comment may mention it
    # as the removed crash fallback — that is documentation, not a step).
    runnable = "\n".join(line for line in text.splitlines()
                         if not line.strip().startswith("#"))
    assert "--write-empty" not in runnable
    assert '"0 6 * * *"' not in text
    # Sync-fix v2.1 (2026-11-24): SINGLE TRIGGER OF TRUTH — the YAML
    # schedules are GONE (the 09:30 + 15:00 backstops moved to the
    # 10-minute dispatcher cron, which is the only trigger for both
    # workflows). The backstop times stay documented in the header
    # comment; the workflow itself must have no `schedule:` block.
    assert '"30 9 * * *"' not in text
    assert '"0 15 * * *"' not in text
    assert "\n  schedule:" not in text
    assert "09:30" in text and "15:00" in text  # backstops documented
    assert "mode" in text and "watch" in text


def test_realtime_workflow_has_no_yaml_schedule():
    # Sync-fix v2.1: the realtime workflow's `*/5` YAML schedule was
    # a second trigger on top of the dispatcher cron — with a
    # ~10.75-min worst-case scan against a 10-min trigger, the two
    # triggers queued overlapping identical scans. The dispatcher
    # cron is the only trigger now.
    text = (REPO_ROOT / ".github" / "workflows" / "telegram-realtime.yml"
            ).read_text(encoding="utf-8")
    assert '"*/5 * * * *"' not in text
    assert "\n  schedule:" not in text
    assert "workflow_dispatch" in text
