"""Tests for tbi.store — SQLite + FTS5 search (offline, tmp DB)."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tbi.store import Store  # noqa: E402


def _seed(store: Store) -> None:
    ch = store.upsert_source("channel", "durov", "Durov")
    gr = store.upsert_source("group", "Old Arabic Books")
    p1 = store.upsert_post(ch, 552, "2026-10-11T14:52:40+00:00", "AI design tools", "https://t.me/durov/552")
    store.replace_files_for_post(p1, [])
    p2 = store.upsert_post(gr, 101, "2024-03-02T18:12:00+00:00", "Requested: ألف ليلة وليلة", "https://t.me/c/1234567890/101")
    store.replace_files_for_post(
        p2,
        [{
            "filename": "ألف ليلة وليلة.epub", "ext": "epub",
            "size_text": None, "size_bytes": None,
            "title": "ألف ليلة وليلة", "author": "",
            "dedupe_key": "ألف ليلة وليلة|",
            "obtain_url": "https://t.me/c/1234567890/101",
        }],
    )
    p3 = store.upsert_post(gr, 102, "2024-03-02T18:20:00+00:00", "Hemingway PDF", "https://t.me/c/1234567890/102")
    store.replace_files_for_post(
        p3,
        [{
            "filename": "The Old Man and the Sea - Ernest Hemingway.pdf", "ext": "pdf",
            "size_text": "2.1 MB", "size_bytes": 2202009,
            "title": "The Old Man and the Sea", "author": "Ernest Hemingway",
            "dedupe_key": "the old man and the sea|ernest hemingway|2202009",
            "obtain_url": "https://t.me/c/1234567890/102",
        }],
    )
    store.commit()


def test_search_arabic_and_english(tmp_path):
    store = Store(tmp_path / "t.db")
    try:
        _seed(store)
        assert store.counts() == {"sources": 2, "posts": 3, "files": 2, "books": 2}
        hits = store.search("ليلة")
        assert len(hits) == 1
        assert hits[0].filename == "ألف ليلة وليلة.epub"
        hits = store.search("Hemingway")
        assert len(hits) == 1
        assert hits[0].author == "Ernest Hemingway"
        hits = store.search("Old Man Sea")
        assert len(hits) == 1
        hits = store.search("Old Man", ext="epub")
        assert hits == []
        hits = store.search("Old Man", ext="pdf")
        assert len(hits) == 1
        hits = store.search("Hemingway", source="durov")
        assert hits == []
        hits = store.search("")
        assert len(hits) == 2
    finally:
        store.close()


def test_search_arabic_diacritics_insensitive(tmp_path):
    """Live find (2026-11-06): channel filenames carry full tashkeel
    ("مُتَوِّنُ_طَالِبِ_الْعِلْمِ...epub") while users search plain
    ("متون"). The search must match despite the diacritics."""
    store = Store(tmp_path / "t.db")
    try:
        sid = store.upsert_source("channel", "KindleBooksRepository")
        pid = store.upsert_post(
            sid, 7682, "2026-11-01T10:00:00+00:00", "",
            "https://t.me/KindleBooksRepository/7682",
        )
        store.replace_files_for_post(pid, [{
            "filename": "مُتَوِّنُ_طَالِبِ_الْعِلْمِ_الْمُسْتَوَى_الْخَامِسُ.epub",
            "ext": "epub", "size_text": "1.8 MB", "size_bytes": 1887437,
            "title": "مُتَوِّنُ طَالِبِ الْعِلْمِ الْمُسْتَوَى الْخَامِسُ",
            "author": "", "dedupe_key": "x|1", "obtain_url": "https://t.me/KindleBooksRepository/7682",
        }])
        store.commit()
        assert len(store.search("متون")) == 1
        assert len(store.search("طالب العلم")) == 1
        assert len(store.search("العلم")) == 1
        # The displayed filename keeps its original diacritics.
        assert store.search("متون")[0].filename.startswith("مُتَوِّنُ")
    finally:
        store.close()


def test_upsert_post_is_idempotent(tmp_path):
    store = Store(tmp_path / "t.db")
    try:
        sid = store.upsert_source("channel", "durov")
        a = store.upsert_post(sid, 552, "2026-10-11T14:52:40+00:00", "v1", "https://t.me/durov/552")
        b = store.upsert_post(sid, 552, "2026-10-11T14:52:40+00:00", "v2", "https://t.me/durov/552")
        assert a == b
        assert store.counts()["posts"] == 1
    finally:
        store.close()
