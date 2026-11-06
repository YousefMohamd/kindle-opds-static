"""Tests for tbi.scrape — parsing of real t.me/s/ fixtures.

Fixtures are REAL pages saved live 2026-11-06:
  * durov_page1.html — t.me/s/durov, 20 posts, ids 552..531.
  * document_page.html — t.me/s/telegram?before=59, 20 posts including
    an audio post (id 35, "String Quartet ...", artist in the extra line).
No network is used by these tests.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tbi import scrape  # noqa: E402

FIX = Path(__file__).parent / "fixtures"


def test_parse_size():
    assert scrape.parse_size("12.3 MB") == ("12.3 MB", int(round(12.3 * 1024**2)))
    assert scrape.parse_size("850 KB")[1] == 850 * 1024
    assert scrape.parse_size("1.2 GB")[1] == int(round(1.2 * 1024**3))
    assert scrape.parse_size("Antonin Dvorak") == ("Antonin Dvorak", None)
    assert scrape.parse_size(None) == (None, None)
    assert scrape.parse_size("") == (None, None)


def test_parse_views():
    assert scrape._parse_views("2.04M") == 2_040_000
    assert scrape._parse_views("212K") == 212_000
    assert scrape._parse_views("428") == 428
    assert scrape._parse_views("5.88M") == 5_880_000
    assert scrape._parse_views("") is None


def test_normalize_link():
    assert scrape.normalize_link("https://t.me/durov") == "durov"
    assert scrape.normalize_link("t.me/durov") == "durov"
    assert scrape.normalize_link("@durov") == "durov"
    assert scrape.normalize_link("durov") == "durov"
    assert scrape.normalize_link("https://t.me/jazz223k/12437") == "jazz223k"
    assert scrape.normalize_link("https://t.me/s/durov?before=531") == "durov"
    assert scrape.normalize_link("") is None


def test_parse_durov_fixture():
    posts = scrape.parse_page((FIX / "durov_page1.html").read_text(), "durov")
    assert len(posts) == 20
    assert posts[0].post_id == 552  # newest first
    assert posts[-1].post_id == 531
    assert all(p.date for p in posts)  # every post has a date
    assert all(p.views and p.views > 1000 for p in posts)
    assert posts[0].views == 2_040_000  # "2.04M"
    assert posts[0].url == "https://t.me/durov/552"
    assert all(p.channel == "durov" for p in posts)
    # durov page 1 has no file attachments.
    assert sum(len(p.files) for p in posts) == 0


def test_parse_document_fixture_audio_extra_is_artist():
    posts = scrape.parse_page((FIX / "document_page.html").read_text(), "telegram")
    docs = [p for p in posts if p.files]
    assert len(docs) == 1
    post = docs[0]
    assert post.post_id == 35
    assert post.date == "2016-04-12T07:05:41+00:00"
    f = post.files[0]
    assert f.kind == "audio"
    assert "String Quartet" in f.filename
    # The extra line of an AUDIO post is the artist, not a size.
    assert f.size_bytes is None
    assert f.size_text is None
    assert f.extra_text == "Antonin Dvorak"
    # The wrap links to the post permalink, not to a file download.
    assert post.url == "https://t.me/telegram/35"


def _post(pid):
    return scrape.Post(channel="c", post_id=pid, url=f"https://t.me/c/{pid}")


def test_walk_start_before_and_min_id(monkeypatch):
    pages = {
        None: [_post(i) for i in (105, 104, 103)],
        103: [_post(i) for i in (102, 101)],
        101: [],
    }

    def fake_fetch_page(channel, *, before=None, query=None, delay=1.5,
                        retries=3, timeout=30):
        return list(pages.get(before, []))

    monkeypatch.setattr(scrape, "fetch_page", fake_fetch_page)
    assert [p.post_id for p in scrape.walk("c")] == [105, 104, 103, 102, 101]
    # Resume below an already-indexed oldest post: skips 105..103.
    assert [p.post_id for p in scrape.walk("c", start_before=103)] == [102, 101]
    # Incremental: only posts newer than min_id.
    assert [p.post_id for p in scrape.walk("c", min_id=103)] == [105, 104]


def test_classify_with_mocked_fetch(monkeypatch):
    def fake_fetch(url, timeout=30):
        if "durov" in url:
            return 200, None, b'<div class="tgme_widget_message_wrap">x</div>'
        if "missing" in url:
            return 302, "https://t.me/missing", b""
        return 500, None, b""

    monkeypatch.setattr(scrape, "_fetch", fake_fetch)
    assert scrape.classify("durov") == "channel"
    assert scrape.classify("missing") == "no_preview"
    assert scrape.classify("other") == "unknown"
