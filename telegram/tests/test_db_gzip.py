"""Tests for the compressed-seed round-trip (v0.4.1).

The repo stores the seed as telegram/index.db.gz (the raw index.db is
~26 MB, over Cloudflare Pages' 25 MB per-file limit, which broke the
deployment and left /telegram/ on a 404). The workflows decompress it
with `gunzip` at the start and re-compress it with `gzip -f` before
committing. These tests prove that round-trip is lossless for a real
Store DB: byte-identical after decompression, and the data reads back.
"""

import gzip
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tbi.store import Store  # noqa: E402

AR_TITLES = [
    "ألف ليلة وليلة", "القراءة المثمرة", "حصن المسلم", "فن التواصل",
    "علم التحكم", "قصة السينما في مصر", "البلاغة", "أخطاء اللغة العربية",
    "التغذية الصحية والجسم السليم", "المنخفض", "تاريخ الفلسفة",
    "مقدمة في علم الاجتماع",
]
EN_TITLES = [
    "The Old Man and the Sea", "Dune", "Thinking, Fast and Slow",
    "The Art of War", "A Brief History of Time", "The Little Prince",
]


def _seed(store: Store, n_posts: int = 500) -> None:
    """Seed a text-heavy DB: varied titles/captions so gzip has realistic
    (not one repeated string) content to compress."""
    sid = store.upsert_source("channel", "KindleBooksRepository")
    for pid in range(1, n_posts + 1):
        if pid % 3 == 0:
            title = EN_TITLES[pid % len(EN_TITLES)]
            author = "Ernest Hemingway" if pid % 2 else "Frank Herbert"
            caption = f"{title} — {author} (EPUB, {pid % 9 + 1}.{(pid % 9)} MB)"
        else:
            title = AR_TITLES[pid % len(AR_TITLES)]
            author = "عبد الكريم بكار" if pid % 2 else "ابن خلدون"
            caption = f"{title} — {author} كتاب جديد بصيغة الكيندل الجزء {pid % 7 + 1}"
        rowid = store.upsert_post(
            sid, pid, "2026-11-06T10:00:00+00:00", caption,
            f"https://t.me/KindleBooksRepository/{pid}",
        )
        # every post carries a book file, so both Arabic and English
        # titles/authors land in the FTS index and are searchable
        ext = "epub" if pid % 2 else "pdf"
        store.replace_files_for_post(rowid, [{
            "filename": title.replace(" ", "_") + f".{ext}",
            "ext": ext, "size_text": "2.1 MB",
            "size_bytes": 2_200_000 + pid,
            "title": title, "author": author,
            "dedupe_key": f"{title.lower()}|{author.lower()}|{pid}",
            "obtain_url": f"https://t.me/KindleBooksRepository/{pid}",
        }])
    store.commit()


def test_gzip_round_trip_is_byte_identical(tmp_path):
    """gzip -> gunzip returns the exact bytes, and the Store reads the
    decompressed DB back with the same rows and search results."""
    db = tmp_path / "index.db"
    store = Store(db)
    try:
        _seed(store, n_posts=200)
        counts_before = store.counts()
        hits_before = [h.filename for h in store.search("ليلة")]
    finally:
        store.close()

    raw = db.read_bytes()
    gz_path = tmp_path / "index.db.gz"
    gz_path.write_bytes(gzip.compress(raw, compresslevel=6))
    assert gz_path.stat().st_size < len(raw)

    rt_path = tmp_path / "index-rt.db"
    rt_path.write_bytes(gzip.decompress(gz_path.read_bytes()))
    assert rt_path.read_bytes() == raw  # byte-identical

    store2 = Store(rt_path)
    try:
        assert store2.counts() == counts_before
        assert [h.filename for h in store2.search("ليلة")] == hits_before
        assert len(store2.search("Hemingway")) > 0
    finally:
        store2.close()


def test_gzip_shrinks_text_heavy_db(tmp_path):
    """A text-heavy Store DB compresses far below its raw size (the
    measured ratio at full scale — 62,806 posts, same schema — is ~23%;
    this bound is deliberately loose so the test is not brittle)."""
    db = tmp_path / "index.db"
    store = Store(db)
    try:
        _seed(store, n_posts=500)
    finally:
        store.close()
    raw = db.read_bytes()
    gz = gzip.compress(raw, compresslevel=6)
    assert len(gz) < len(raw) * 0.5
