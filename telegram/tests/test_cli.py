"""End-to-end CLI test (offline): index the export fixture as a group,
then search it. No network."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tbi import cli as cli_mod  # noqa: E402
from tbi.cli import main  # noqa: E402
from tbi.scrape import FileMeta, Post  # noqa: E402

FIX = Path(__file__).parent / "fixtures"


def test_index_and_search_offline(tmp_path, capsys):
    cfg = tmp_path / "channels.yaml"
    cfg.write_text(
        "channels: []\n"
        "groups:\n"
        f"  - name: \"Old Arabic Books\"\n"
        f"    export: {FIX / 'export_sample.json'}\n"
        "settings:\n"
        f"  db: {tmp_path / 'index.db'}\n"
        "  delay_seconds: 0\n"
        "  limit_per_channel: 0\n"
    )
    assert main(["index", "--config", str(cfg)]) == 0
    out = capsys.readouterr().out
    assert "5 posts, 3 book files" in out  # 5 posts; EPUB + PDF + EPUB dup

    assert main(["search", "ليلة", "--db", str(tmp_path / "index.db")]) == 0
    out = capsys.readouterr().out
    assert "ألف ليلة وليلة.epub" in out
    assert "t.me/c/1234567890/101" in out

    assert main(["search", "Hemingway", "--db", str(tmp_path / "index.db")]) == 0
    out = capsys.readouterr().out
    assert "Ernest Hemingway" in out

    assert main(["search", "Hemingway", "--format", "epub", "--db", str(tmp_path / "index.db")]) == 0
    out = capsys.readouterr().out
    assert "No matches" in out

    assert main(["sources", "--db", str(tmp_path / "index.db")]) == 0
    out = capsys.readouterr().out
    assert "Old Arabic Books" in out
    assert "5 posts" in out


def _channel_cfg(tmp_path):
    cfg = tmp_path / "channels.yaml"
    cfg.write_text(
        "channels:\n  - https://t.me/testchan\n"
        "groups: []\n"
        "settings:\n"
        f"  db: {tmp_path / 'index.db'}\n"
        "  delay_seconds: 0\n"
        "  limit_per_channel: 0\n"
    )
    return cfg


def test_index_resumes_below_oldest(tmp_path, capsys, monkeypatch):
    """Second run must not re-walk indexed posts: new posts first
    (min_id=newest), then continue below the stored oldest."""
    cfg = _channel_cfg(tmp_path)
    calls = []

    def fake_walk(name, *, limit=None, min_id=None, start_before=None, delay=1.5):
        calls.append((min_id, start_before))
        if min_id is not None:
            return iter([Post(channel=name, post_id=106,
                              url="https://t.me/testchan/106")])
        if start_before is not None:
            return iter([Post(channel=name, post_id=99,
                              url="https://t.me/testchan/99")])
        return iter([Post(channel=name, post_id=i,
                          url=f"https://t.me/testchan/{i}")
                     for i in (105, 104, 100)])

    monkeypatch.setattr(cli_mod, "walk", fake_walk)
    monkeypatch.setattr(cli_mod, "classify", lambda name, timeout=30: "channel")

    assert main(["index", "--config", str(cfg)]) == 0
    out = capsys.readouterr().out
    assert "[ok] @testchan: 3 posts" in out

    calls.clear()
    assert main(["index", "--config", str(cfg)]) == 0
    out = capsys.readouterr().out
    assert calls == [(105, None), (None, 100)]
    assert "resuming" in out
    assert "[ok] @testchan: 2 posts" in out

    assert main(["sources", "--db", str(tmp_path / "index.db")]) == 0
    out = capsys.readouterr().out
    assert "5 posts" in out  # all distinct, no duplicates


def test_index_prints_progress_every_20_posts(tmp_path, capsys, monkeypatch):
    """A long channel must print progress, so silence is never mistaken
    for a hang (the exact Ctrl+C that cut the first live run short)."""
    cfg = _channel_cfg(tmp_path)

    def fake_walk(name, *, limit=None, min_id=None, start_before=None, delay=1.5):
        return iter([Post(channel=name, post_id=i,
                          url=f"https://t.me/testchan/{i}")
                     for i in range(100, 75, -1)])

    monkeypatch.setattr(cli_mod, "walk", fake_walk)
    monkeypatch.setattr(cli_mod, "classify", lambda name, timeout=30: "channel")
    assert main(["index", "--config", str(cfg)]) == 0
    out = capsys.readouterr().out
    assert "[...] @testchan: 20 posts so far" in out
    assert "[ok] @testchan: 25 posts" in out


def _seeded_channel(tmp_path, monkeypatch):
    """Index 3 posts (each with one book file), then return (cfg, calls)
    for a second run."""
    cfg = _channel_cfg(tmp_path)
    calls = []

    def _post(name, pid):
        return Post(
            channel=name, post_id=pid,
            url=f"https://t.me/testchan/{pid}",
            files=[FileMeta(filename=f"Book {pid}.epub")],
        )

    def fake_walk(name, *, limit=None, min_id=None, start_before=None, delay=1.5):
        calls.append((limit, min_id, start_before))
        if min_id is not None:
            return iter([_post(name, 106)])
        if start_before is not None:
            return iter([_post(name, 99)])
        return iter([_post(name, i) for i in (105, 104, 100)])

    monkeypatch.setattr(cli_mod, "walk", fake_walk)
    monkeypatch.setattr(cli_mod, "classify", lambda name, timeout=30: "channel")
    assert main(["index", "--config", str(cfg)]) == 0
    calls.clear()
    return cfg, calls


def test_index_full_flag_forces_full_walk(tmp_path, capsys, monkeypatch):
    cfg, calls = _seeded_channel(tmp_path, monkeypatch)
    assert main(["index", "--config", str(cfg), "--full"]) == 0
    out = capsys.readouterr().out
    # One full walk from the top: no min_id, no start_before.
    assert calls == [(None, None, None)]
    assert "[ok] @testchan: 3 posts" in out
    report = (tmp_path / "index-report.md").read_text()
    assert "**Mode:** full" in report


def test_index_new_only_fetches_only_new_posts(tmp_path, capsys, monkeypatch):
    cfg, calls = _seeded_channel(tmp_path, monkeypatch)
    assert main(["index", "--config", str(cfg), "--new-only"]) == 0
    out = capsys.readouterr().out
    # Phase 1 only: min_id=newest, never start_before (no backfill).
    assert calls == [(None, 105, None)]
    assert "[ok] @testchan: 1 posts" in out
    report = (tmp_path / "index-report.md").read_text()
    assert "**Mode:** new-only" in report
    assert "incremental" in report


def test_index_writes_report_next_to_db(tmp_path, capsys, monkeypatch):
    cfg, _ = _seeded_channel(tmp_path, monkeypatch)
    report = tmp_path / "index-report.md"
    assert report.is_file()
    text = report.read_text()
    assert text.startswith("# Index report — telegram-book-index")
    assert "## Summary so far" in text
    assert "## Indexed channels (1)" in text
    assert "[testchan](https://t.me/testchan)" in text
    assert "## This run" in text


def test_index_all_channels_failed_returns_nonzero_and_reports(tmp_path, capsys, monkeypatch):
    cfg = _channel_cfg(tmp_path)

    def fake_walk(name, *, limit=None, min_id=None, start_before=None, delay=1.5):
        raise RuntimeError("network down")

    monkeypatch.setattr(cli_mod, "walk", fake_walk)
    monkeypatch.setattr(cli_mod, "classify", lambda name, timeout=30: "channel")
    assert main(["index", "--config", str(cfg)]) == 1
    report = (tmp_path / "index-report.md").read_text()
    assert "**Status:** failed" in report
    assert "network down" in report


def test_validate_ok_empty_and_json(tmp_path, capsys, monkeypatch):
    cfg, _ = _seeded_channel(tmp_path, monkeypatch)
    capsys.readouterr()  # clear the index run's output
    db = tmp_path / "index.db"
    assert main(["validate", "--db", str(db)]) == 0
    out = capsys.readouterr().out
    assert out.startswith("OK:")
    # Empty DB fails.
    empty = tmp_path / "empty.db"
    from tbi.store import Store
    Store(empty).close()
    assert main(["validate", "--db", str(empty)]) == 1
    # Generated JSON validates too.
    assert main(["export-static", "--db", str(db),
                 "--out", str(tmp_path / "site")]) == 0
    assert main(["validate", "--db", str(db),
                 "--json", str(tmp_path / "site" / "index.json")]) == 0
    assert main(["validate", "--db", str(db),
                 "--json", str(tmp_path / "missing.json")]) == 1


def test_export_static_cli(tmp_path, capsys, monkeypatch):
    cfg, _ = _seeded_channel(tmp_path, monkeypatch)
    db = tmp_path / "index.db"
    assert main(["export-static", "--db", str(db),
                 "--out", str(tmp_path / "site")]) == 0
    out = capsys.readouterr().out
    assert "Static export:" in out
    assert "report copied" in out
    import json
    data = json.loads((tmp_path / "site" / "index.json").read_text())
    assert data["totals"]["posts"] == 3
    assert data["totals"]["books"] == 3
    assert (tmp_path / "site" / "index-report.md").is_file()
