"""Unit tests for d1_incremental (staging).

Run from the work dir:
  PYTHONPATH=stage/telegram .venv/bin/python -m pytest tests/test_d1_incremental.py -q
stage/telegram/tbi/ holds verbatim copies of the repo's d1_sync.py
(verified byte-identical to live main 2026-11-26), books.py,
author_rules.py, __init__.py, plus a symlink to src/d1_incremental.py —
so the tests exercise the real d1_sync.batch_sql / content_hash /
load_catalog code as the tbi package the module will run in.
"""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "stage" / "telegram"))

from tbi import d1_incremental as di  # noqa: E402
from tbi import d1_sync  # noqa: E402


# --- fixtures ---------------------------------------------------------------

def live_book(**kw):
    b = {
        "id": "bookpdfepub:616650:pdf",
        "title": "Chainsaw Man Vol 5",
        "author": "Tatsuki Fujimoto",
        "source": "bookpdfepub",
        "kind": "group",
        "format": "PDF",
        "filename": "Chainsaw Man Vol 5.pdf",
        "size_text": "37.5 MB",
        "size_bytes": 39321600,
        "url": "https://t.me/bookpdfepub/616650",
        "post_id": 616650,
        "date": "2026-11-26T10:31:13Z",
        "added_at": "2026-11-26T10:31:14Z",
        "dedupe_key": "chainsaw man vol 5|tatsuki fujimoto|39321600",
    }
    b.update(kw)
    return b


def shard_book_dict(**kw):
    b = {
        "title": "Nov 21 Shard Book",
        "author": "Some Author",
        "filename": "Nov 21 Shard Book.pdf",
        "ext": "pdf",
        "size": "12.0 MB",
        "source": "rwaiaty4",
        "kind": "channel",
        "date": "2026-11-21",
        "url": "https://t.me/rwaiaty4/100",
    }
    b.update(kw)
    return b


class FakeD1:
    """In-memory stand-in for D1Client: rows are d1_sync book dicts."""

    def __init__(self, rows=None, meta=None):
        self.rows = list(rows or [])
        self.meta = dict(meta or {"delta_complete": "1"})

    def get_meta(self):
        return dict(self.meta)

    def get_max_id(self):
        return 422850  # live value 2026-11-26 (Drive import took it there)

    def fetch_existing(self, urls):
        out = {}
        for r in self.rows:
            if r["url"] in urls:
                out[d1_sync.state_key(r)] = dict(r)
        return out


def make_shard_dir(tmp_path, books_10field):
    """A minimal site/telegram dir with one 10-field shard."""
    d = tmp_path / "site-telegram"
    d.mkdir()
    manifest = {
        "generated_at": "2026-11-26T07:07:32Z",
        "totals": {"books": len(books_10field)},
        "sources": [{"name": "rwaiaty4", "kind": "channel"}],
        "shards": [{"file": "index-0.json"}],
    }
    (d / "index.json").write_text(json.dumps(manifest), encoding="utf-8")
    (d / "index-0.json").write_text(
        json.dumps({"books": books_10field}, ensure_ascii=False), encoding="utf-8"
    )
    return d


def shard_row(title, author, filename, source, date, post_id, size="12.0 MB"):
    # 10-field shard record: [title, author, filename, ext, size,
    # source, sources_count, date, source, post_id]
    return [title, author, filename, "pdf", size, source, 1, date, source, post_id]


# --- live_book_to_book ------------------------------------------------------


def test_live_mapping_truncates_date_and_lowercases_ext():
    b = di.live_book_to_book(live_book())
    assert b["date"] == "2026-11-26"  # ISO timestamp -> YYYY-MM-DD
    assert b["ext"] == "pdf"  # "PDF" -> "pdf"
    assert b["size"] == "37.5 MB"  # size_text, the D1 display format
    assert b["url"] == "https://t.me/bookpdfepub/616650"
    assert b["kind"] == "group"


def test_live_mapping_skips_bad_ext_and_empty_url():
    assert di.live_book_to_book(live_book(format="ZIP")) is None
    assert di.live_book_to_book(live_book(url="")) is None
    assert di.live_book_to_book(live_book(format="")) is None


def test_live_mapping_same_hash_as_shard_record():
    # The same file via live and via shard must hash identically, so
    # whichever source imports it first, the other sees "unchanged".
    live = di.live_book_to_book(live_book())
    shard = {
        "title": "Chainsaw Man Vol 5", "author": "Tatsuki Fujimoto",
        "filename": "Chainsaw Man Vol 5.pdf", "ext": "pdf",
        "size": "37.5 MB", "source": "bookpdfepub", "kind": "group",
        "date": "2026-11-26", "url": "https://t.me/bookpdfepub/616650",
    }
    assert d1_sync.content_hash(live) == d1_sync.content_hash(shard)


# --- classify / merge / shard_candidates ------------------------------------


def test_classify_new_changed_skipped():
    in_d1_same = shard_book_dict()
    in_d1_changed = shard_book_dict(
        title="Nov 21 Shard Book (retitled)",
        url="https://t.me/rwaiaty4/101",
    )
    # D1 holds the OLD title for the changed book's key.
    d1_old = shard_book_dict(
        title="Nov 21 Shard Book", url="https://t.me/rwaiaty4/101"
    )
    new_book = shard_book_dict(url="https://t.me/rwaiaty4/102")
    existing = {
        d1_sync.state_key(in_d1_same): in_d1_same,
        d1_sync.state_key(d1_old): d1_old,
    }
    new, changed, skipped = di.classify(
        [in_d1_same, in_d1_changed, new_book], existing
    )
    assert [b["url"] for b in new] == ["https://t.me/rwaiaty4/102"]
    assert [b["url"] for b in changed] == ["https://t.me/rwaiaty4/101"]
    assert skipped == 1


def test_merge_live_wins_over_shard_and_drops_no_url():
    live = di.live_book_to_book(live_book(title="Live Title"))
    shard_same_key = shard_book_dict(
        title="Shard Title", url="https://t.me/bookpdfepub/616650",
        filename="Chainsaw Man Vol 5.pdf",
    )
    no_url = shard_book_dict(url="")
    merged = di.merge_candidates([live], [shard_same_key, no_url])
    assert len(merged) == 1
    assert merged[0]["title"] == "Live Title"


def test_merge_newest_first():
    old = shard_book_dict(date="2026-11-19", url="https://t.me/rwaiaty4/1")
    new = shard_book_dict(date="2026-11-26", url="https://t.me/rwaiaty4/2")
    assert [b["date"] for b in di.merge_candidates([old], [new])] == [
        "2026-11-26", "2026-11-19",
    ]


def test_shard_candidates_watermark():
    books = [
        shard_book_dict(date="2026-11-18", url="https://t.me/rwaiaty4/1"),
        shard_book_dict(date="2026-11-21", url="https://t.me/rwaiaty4/2"),
        shard_book_dict(date="2026-11-22", url="https://t.me/rwaiaty4/3"),
    ]
    fresh, newest = di.shard_candidates(books, "2026-11-18")
    assert [b["date"] for b in fresh] == ["2026-11-21", "2026-11-22"]
    assert newest == "2026-11-22"
    fresh2, _ = di.shard_candidates(books, "2026-11-22")
    assert fresh2 == []


# --- D1Client ---------------------------------------------------------------


def test_resolve_database_id_by_name(monkeypatch):
    import io
    import urllib.request

    payload = json.dumps({"result": [
        {"name": "other-db", "uuid": "uuid-other"},
        {"name": "rlibook-tg", "uuid": "uuid-tg"},
    ]}).encode()

    class Resp:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return payload

    monkeypatch.setattr(
        urllib.request, "urlopen", lambda req, timeout=30: Resp()
    )
    assert di.D1Client.resolve_database_id("acct", "rlibook-tg", "tok") == "uuid-tg"


def test_d1client_without_env_raises(monkeypatch):
    monkeypatch.delenv("CLOUDFLARE_ACCOUNT_ID", raising=False)
    monkeypatch.delenv("CLOUDFLARE_API_TOKEN", raising=False)
    with pytest.raises(RuntimeError, match="CLOUDFLARE_API_TOKEN"):
        di.D1Client()


# --- run() end to end -------------------------------------------------------


def test_run_refuses_without_completed_delta(tmp_path):
    d1 = FakeD1(meta={"delta_complete": "0"})
    site = make_shard_dir(tmp_path, [])
    with pytest.raises(RuntimeError, match="delta_complete"):
        di.run(site_telegram=site, out_dir=tmp_path / "out", d1=d1,
               live_since_books=("2026-11-19T21:15:14Z", []), dry_run=True)


def test_run_dry_run_writes_nothing(tmp_path):
    site = make_shard_dir(tmp_path, [])
    out = tmp_path / "out"
    summary = di.run(
        site_telegram=site, out_dir=out, d1=FakeD1(),
        live_since_books=("2026-11-19T21:15:14Z", [live_book()]),
        dry_run=True,
    )
    assert summary["new"] == 1
    assert not out.exists()


def test_run_emits_batches_and_watermark_with_ids_from_max_id(tmp_path):
    rows = [shard_row("Nov 21 Shard Book", "Some Author",
                      "Nov 21 Shard Book.pdf", "rwaiaty4", "2026-11-21", 100)]
    site = make_shard_dir(tmp_path, rows)
    out = tmp_path / "out"
    summary = di.run(
        site_telegram=site, out_dir=out, d1=FakeD1(),
        live_since_books=("2026-11-19T21:15:14Z", [live_book()]),
        dry_run=False,
    )
    assert summary["new"] == 2  # 1 live + 1 shard
    assert summary["next_free_id"] == 422853  # max_id 422850 + 2
    sql = (out / "batch-0001.sql").read_text(encoding="utf-8")
    assert "INSERT OR IGNORE INTO books(" in sql
    assert "INSERT OR IGNORE INTO books_fts(" in sql
    assert "422851" in sql and "422852" in sql
    assert "BEGIN TRANSACTION;" in sql and "COMMIT;" in sql
    wm = (out / "watermark.sql").read_text(encoding="utf-8")
    for key in ("incr_last_run_at", "incr_last_new", "incr_last_changed",
                "incr_last_skipped", "incr_last_max_date", "incr_shard_date",
                "incr_next_free_id", "incr_live_since"):
        assert key in wm
    assert "'2'" in wm  # incr_last_new = 2


def test_run_is_idempotent_second_run_emits_nothing(tmp_path):
    site = make_shard_dir(tmp_path, [])
    live = di.live_book_to_book(live_book())
    d1 = FakeD1(rows=[live])
    out = tmp_path / "out"
    summary = di.run(
        site_telegram=site, out_dir=out, d1=d1,
        live_since_books=("2026-11-19T21:15:14Z", [live_book()]),
        dry_run=False,
    )
    assert summary["new"] == 0 and summary["changed"] == 0
    assert summary["skipped"] == 1
    assert not list(out.glob("batch-*.sql"))


def test_run_changed_book_emits_update_not_insert(tmp_path):
    site = make_shard_dir(tmp_path, [])
    old = di.live_book_to_book(live_book())
    d1 = FakeD1(rows=[old])
    out = tmp_path / "out"
    summary = di.run(
        site_telegram=site, out_dir=out, d1=d1,
        live_since_books=("2026-11-19T21:15:14Z",
                          [live_book(title="Chainsaw Man Vol 5 (fixed)")]),
        dry_run=False,
    )
    assert summary["changed"] == 1 and summary["new"] == 0
    sql = (out / "batch-0001.sql").read_text(encoding="utf-8")
    assert "UPDATE books SET" in sql
    assert "DELETE FROM books_fts" in sql
    assert summary["next_free_id"] == 422851  # no new id consumed


def test_run_cap_defers_rest_and_holds_shard_watermark(tmp_path):
    rows = [
        shard_row("B1", "A", "B1.pdf", "rwaiaty4", "2026-11-21", 1),
        shard_row("B2", "A", "B2.pdf", "rwaiaty4", "2026-11-21", 2),
        shard_row("B3", "A", "B3.pdf", "rwaiaty4", "2026-11-22", 3),
    ]
    site = make_shard_dir(tmp_path, rows)
    out = tmp_path / "out"
    summary = di.run(
        site_telegram=site, out_dir=out, d1=FakeD1(),
        live_since_books=("2026-11-19T21:15:14Z", []),
        dry_run=False, max_books=1,
    )
    assert summary["new"] == 1
    assert summary["capped"] == 2
    # Only B3 (newest date) emitted; 2026-11-21 is only partly
    # emitted, so the watermark must NOT advance past 2026-11-18.
    assert summary["shard_date"] == "2026-11-18"


def test_watermark_sql_shape():
    sql = di.watermark_sql({
        "new": 3, "changed": 1, "skipped": 5, "max_date": "2026-11-26",
        "shard_date": "2026-11-21", "next_free_id": 422854,
        "live_since": "2026-11-19T21:15:14Z",
    })
    assert sql.startswith("BEGIN TRANSACTION;")
    assert sql.rstrip().endswith("COMMIT;")
    assert "incr_shard_date" in sql and "2026-11-21" in sql
    assert "incr_next_free_id" in sql and "422854" in sql
