"""Tests for `tbi index --backfill` (v0.3): block-capped walks of the
deep history, completion rule, and priority-first ordering (offline)."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tbi import cli as cli_mod  # noqa: E402
from tbi.cli import main  # noqa: E402
from tbi.scrape import FileMeta, Post  # noqa: E402


def _channel_cfg(tmp_path, channels=("https://t.me/testchan",)):
    cfg = tmp_path / "channels.yaml"
    lines = "channels:\n" + "".join(f"  - {c}\n" for c in channels)
    lines += (
        "groups: []\n"
        "settings:\n"
        f"  db: {tmp_path / 'index.db'}\n"
        "  delay_seconds: 0\n"
        "  limit_per_channel: 0\n"
    )
    cfg.write_text(lines)
    return cfg


def _post(name, pid):
    return Post(
        channel=name, post_id=pid,
        url=f"https://t.me/{name}/{pid}",
        files=[FileMeta(filename=f"Book {pid}.epub")],
    )


def _seeded_channel(tmp_path, monkeypatch):
    """Index 3 posts (105, 104, 100), then return (cfg, calls) for a
    second run."""
    cfg = _channel_cfg(tmp_path)
    calls = []

    def fake_walk(name, *, limit=None, min_id=None, start_before=None, delay=1.5):
        calls.append((limit, min_id, start_before))
        if min_id is not None:
            return iter([_post(name, 106)])
        if start_before is not None:
            # A full block (2 posts): the channel is NOT complete yet.
            return iter([_post(name, i) for i in (99, 98)])
        return iter([_post(name, i) for i in (105, 104, 100)])

    monkeypatch.setattr(cli_mod, "walk", fake_walk)
    monkeypatch.setattr(cli_mod, "classify", lambda name, timeout=30: "channel")
    assert main(["index", "--config", str(cfg)]) == 0
    calls.clear()
    return cfg, calls


def test_backfill_caps_phase_two_at_one_block(tmp_path, capsys, monkeypatch):
    cfg, calls = _seeded_channel(tmp_path, monkeypatch)
    assert main([
        "index", "--config", str(cfg),
        "--backfill", "--backfill-block", "2",
    ]) == 0
    out = capsys.readouterr().out
    # Phase 1: new posts above 105 (no limit). Phase 2: ONE block of 2
    # below the oldest (100) — never the whole history in one run.
    assert calls == [(None, 105, None), (2, None, 100)]
    assert "[ok] @testchan: 3 posts" in out  # 1 new + 2 backfilled
    report = (tmp_path / "index-report.md").read_text()
    assert "**Mode:** backfill" in report
    assert "backfill — more remain" in report
    assert "Backfill block: 2 posts" in report
    assert "## Backfill status" in report
    assert "Complete this run: 0 of 1 channels touched." in report


def test_backfill_complete_when_block_returns_less(tmp_path, capsys, monkeypatch):
    cfg, calls = _seeded_channel(tmp_path, monkeypatch)

    def fake_walk(name, *, limit=None, min_id=None, start_before=None, delay=1.5):
        calls.append((limit, min_id, start_before))
        if min_id is not None:
            return iter([])
        if start_before is not None:
            # The preview is exhausted: one post, the first one.
            return iter([_post(name, 1)])
        return iter([_post(name, i) for i in (105, 104, 100)])

    monkeypatch.setattr(cli_mod, "walk", fake_walk)
    assert main([
        "index", "--config", str(cfg),
        "--backfill", "--backfill-block", "3000",
    ]) == 0
    out = capsys.readouterr().out
    assert "[ok] @testchan: 1 posts" in out
    report = (tmp_path / "index-report.md").read_text()
    assert "backfill — complete" in report
    assert "Complete — reached the first post" in report
    assert "Complete this run: 1 of 1 channels touched." in report


def test_backfill_from_scratch_walks_one_block(tmp_path, capsys, monkeypatch):
    """A channel with no posts yet gets one block from the top."""
    cfg = _channel_cfg(tmp_path)
    calls = []

    def fake_walk(name, *, limit=None, min_id=None, start_before=None, delay=1.5):
        calls.append((limit, min_id, start_before))
        return iter([_post(name, i) for i in (50, 49, 48)])

    monkeypatch.setattr(cli_mod, "walk", fake_walk)
    monkeypatch.setattr(cli_mod, "classify", lambda name, timeout=30: "channel")
    assert main([
        "index", "--config", str(cfg),
        "--backfill", "--backfill-block", "3000",
    ]) == 0
    # No phase 1 (no stored newest); one block from the top, 3 posts
    # < 3000, so the channel is complete.
    assert calls == [(3000, None, None)]
    report = (tmp_path / "index-report.md").read_text()
    assert "backfill — complete" in report


def test_backfill_priority_channels_go_first(tmp_path, capsys, monkeypatch):
    """A channel with a pending priority request is walked before the
    others, in request order."""
    cfg = _channel_cfg(
        tmp_path,
        channels=("https://t.me/testchan", "https://t.me/otherchan"),
    )
    order = []

    def fake_walk(name, *, limit=None, min_id=None, start_before=None, delay=1.5):
        order.append(name)
        return iter([_post(name, 10)])

    monkeypatch.setattr(cli_mod, "walk", fake_walk)
    monkeypatch.setattr(cli_mod, "classify", lambda name, timeout=30: "channel")
    # Queue a priority request for otherchan (the second channel).
    from tbi.store import Store
    store = Store(tmp_path / "index.db")
    assert store.add_priority_request("otherchan", "Dune")
    store.commit()
    store.close()
    assert main([
        "index", "--config", str(cfg),
        "--backfill", "--backfill-block", "3000",
    ]) == 0
    out = capsys.readouterr().out
    assert order[0] == "otherchan"
    assert "[priority] channels with pending priority requests go first: @otherchan" in out


def test_backfill_conflicts_with_full_and_new_only(tmp_path, capsys):
    cfg = _channel_cfg(tmp_path)
    assert main([
        "index", "--config", str(cfg), "--backfill", "--new-only",
    ]) == 2
    assert main([
        "index", "--config", str(cfg), "--backfill", "--full",
    ]) == 2
