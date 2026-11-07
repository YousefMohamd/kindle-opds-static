"""Tests for tbi.report — the per-run index-report.md writer (offline)."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tbi.config import load_config  # noqa: E402
from tbi.report import (  # noqa: E402
    ChannelRun,
    RunRecord,
    build_report,
    estimate_full_walk_minutes,
    format_duration,
    parse_config_inventory,
    write_report,
)
from tbi.store import Store  # noqa: E402


def _seed_store(tmp_path):
    db = tmp_path / "index.db"
    store = Store(db)
    # Giant channel: 3000 posts, 40 book files, newest 211415.
    big = store.upsert_source("channel", "bigchan")
    for i in range(211415, 211415 - 3000, -1):
        p = store.upsert_post(big, i, "2026-11-06T10:00:00+00:00", "", "")
        if i % 75 == 0:
            store.replace_files_for_post(
                p,
                [{
                    "filename": f"Book {i}.epub", "ext": "epub",
                    "size_text": "1.0 MB", "size_bytes": 1000000,
                    "title": f"Book {i}", "author": "",
                    "dedupe_key": f"book {i}||1000000",
                    "obtain_url": f"https://t.me/bigchan/{i}",
                }],
            )
        else:
            store.replace_files_for_post(p, [])
    store.set_source_status(big, "ok", oldest=208416, newest=211415)
    # Zero-book channel with many posts: the HUGE FOR NOTHING flag.
    empty = store.upsert_source("channel", "emptychan")
    for i in range(1500, 0, -1):
        p = store.upsert_post(empty, i, "2026-11-06T10:00:00+00:00", "", "")
        store.replace_files_for_post(p, [])
    store.set_source_status(empty, "ok", oldest=1, newest=1500)
    # Small channel with books.
    small = store.upsert_source("channel", "smallchan")
    for i in range(10, 0, -1):
        p = store.upsert_post(small, i, "2026-11-06T10:00:00+00:00", "", "")
        store.replace_files_for_post(
            p,
            [{
                "filename": f"Small {i}.pdf", "ext": "pdf",
                "size_text": None, "size_bytes": None,
                "title": f"Small {i}", "author": "",
                "dedupe_key": f"small {i}|",
                "obtain_url": f"https://t.me/smallchan/{i}",
            }] if i <= 5 else [],
        )
    store.set_source_status(small, "ok", oldest=1, newest=10)
    # A channel in error state from an earlier run.
    bad = store.upsert_source("channel", "badchan")
    store.set_source_status(bad, "error", note="HTTP 429 for https://t.me/s/badchan")
    store.commit()
    return store


def _cfg(tmp_path):
    cfg = tmp_path / "channels.yaml"
    cfg.write_text(
        "channels:\n"
        "  - https://t.me/bigchan\n"
        "  - https://t.me/emptychan\n"
        "  - https://t.me/smallchan\n"
        "  - https://t.me/badchan\n"
        "  - https://t.me/notyet\n"
        "groups:\n"
        "  # - name: \"Pending Group One\"\n"
        "  #   export: ~/exports/Pending Group One/result.json\n"
        "  # - name: \"Pending Group Two\"\n"
        "  #   export: ~/exports/Pending Group Two/result.json\n"
        "# Dead — 2 handles that do not exist.\n"
        "# - deadone\n"
        "# - deadtwo\n"
        "\n"
        "# Private invite links — 1.\n"
        "# - t.me/+AAAA1111\n"
        "\n"
        "settings:\n"
        f"  db: {tmp_path / 'index.db'}\n"
        "  delay_seconds: 0\n"
        "  limit_per_channel: 0\n"
    )
    return load_config(cfg)


def _run(cfg_path):
    return RunRecord(
        started_at="2026-11-06T20:00:00+00:00",
        finished_at="2026-11-06T20:05:00+00:00",
        duration_s=300,
        mode="incremental",
        config=str(cfg_path),
        db="index.db",
        status="partial",
        channels=[
            ChannelRun("bigchan", "ok", posts_new=5, files_new=2, scope="resumed"),
            ChannelRun("emptychan", "ok", posts_new=0, files_new=0, scope="resumed"),
            ChannelRun("smallchan", "ok", posts_new=0, files_new=0, scope="resumed"),
            ChannelRun("badchan", "error", scope="resumed",
                       error="HTTP 429 for https://t.me/s/badchan"),
        ],
    )


def test_build_report_matches_interim_format(tmp_path):
    store = _seed_store(tmp_path)
    try:
        cfg = _cfg(tmp_path)
        text = build_report(store, _run(tmp_path / "channels.yaml"), cfg)
    finally:
        store.close()
    # Header + summary (same shape as the interim report).
    assert text.startswith("# Index report — telegram-book-index")
    assert "**Status:** partial" in text
    assert "**Mode:** incremental" in text
    assert "**Duration:** 5m" in text
    assert "## Summary so far" in text
    assert "Channels with data: 3 of 5 walkable" in text
    assert "4510 posts, 45 book files" in text
    # This run + indexed table.
    assert "## This run" in text
    assert "## Indexed channels (3)" in text
    assert "| [bigchan](https://t.me/bigchan) | 3000 | 40 |" in text
    # Zero-book drop candidates, with the huge flag.
    assert "## Channels with 0 book files — drop candidates (1)" in text
    assert "emptychan" in text and "HUGE FOR NOTHING" in text
    # Giants.
    assert "## Giants (uncapped walk is impractical)" in text
    assert "bigchan" in text and "211415" in text and "~5.9h" in text
    # Failures.
    assert "## What failed so far" in text
    assert "badchan" in text and "HTTP 429" in text
    # Not yet indexed.
    assert "## Not yet indexed — remaining 1 channels" in text
    assert "notyet" in text
    # Groups inventory (parsed from the config comments).
    assert "## Not indexable live — groups" in text
    assert "Pending exports (2 groups" in text
    assert "Pending Group One" in text
    assert "## Dead — 2 handles" in text
    assert "deadone" in text
    assert "## Private invite links — 1" in text
    assert "t.me/+AAAA1111" in text


def test_parse_config_inventory(tmp_path):
    cfg = tmp_path / "channels.yaml"
    cfg.write_text(
        "channels: []\n"
        "groups:\n"
        "  # - name: \"G1\"\n"
        "  #   export: ~/exports/G1/result.json\n"
        "  # - name: G2\n"
        "  #   export: ~/exports/G2/result.json\n"
        "# Dead — 1 handle.\n"
        "# - deadhandle\n"
        "\n"
        "# Private invite links — 1.\n"
        "# - t.me/+XYZ123\n"
        "\n"
        "# Dropped — 1 channel.\n"
        "# - droppedone  (3 posts, 0 book files)\n"
        "\n"
        "settings:\n  db: index.db\n"
    )
    inv = parse_config_inventory(cfg)
    assert inv["groups"] == ["G1", "G2"]
    assert inv["dead"] == ["deadhandle"]
    assert inv["invites"] == ["t.me/+XYZ123"]
    assert inv["dropped"] == [("droppedone", "3 posts, 0 book files")]


def test_parse_config_inventory_real_file():
    repo = Path(__file__).resolve().parent.parent
    inv = parse_config_inventory(repo / "channels.yaml")
    # v0.4.5: ALL 168 groups are active (via the API), so the pending
    # (commented-out) inventory is empty — 0 groups remain pending.
    assert len(inv["groups"]) == 0
    assert len(inv["dead"]) == 10
    assert len(inv["invites"]) == 6
    assert "EBook_Library" not in inv["groups"]
    assert "KOTOBPDFFF" in inv["dead"]
    # v0.3: the 8 zero-book channels moved out of the active list.
    assert len(inv["dropped"]) == 8
    assert "arabicEread" in [n for n, _ in inv["dropped"]]
    cfg = load_config(repo / "channels.yaml")
    assert len(cfg.channels) == 43
    # v0.4.5: all 168 groups are active (see also
    # test_real_config_all_groups_active_v045).
    assert len(cfg.groups) == 168
    assert "EBook_Library" in [g.name for g in cfg.groups]


def test_format_duration_and_walk_estimate():
    assert format_duration(45) == "45s"
    assert format_duration(192) == "3m 12s"
    assert format_duration(3720) == "1h 2m"
    # ekraly: 211415 posts -> ~352 min at 2 s/page.
    assert 340 < estimate_full_walk_minutes(211415) < 360
    assert estimate_full_walk_minutes(100) < 1


def test_write_report_atomic(tmp_path):
    path = tmp_path / "index-report.md"
    out = write_report(path, "# hi\n")
    assert out == path
    assert path.read_text() == "# hi\n"
    assert not list(tmp_path.glob("*.tmp"))


def _cfg_with_dropped(tmp_path):
    """The _cfg config, with emptychan moved to a Dropped section."""
    cfg = tmp_path / "channels.yaml"
    cfg.write_text(
        "channels:\n"
        "  - https://t.me/bigchan\n"
        "  - https://t.me/smallchan\n"
        "  - https://t.me/badchan\n"
        "  - https://t.me/notyet\n"
        "# Dropped — 1 channel with 0 book files.\n"
        "# - emptychan  (1500 posts, 0 book files)\n"
        "\n"
        "groups:\n"
        "  # - name: \"Pending Group One\"\n"
        "  #   export: ~/exports/Pending Group One/result.json\n"
        "# Dead — 2 handles that do not exist.\n"
        "# - deadone\n"
        "# - deadtwo\n"
        "\n"
        "# Private invite links — 1.\n"
        "# - t.me/+AAAA1111\n"
        "\n"
        "settings:\n"
        f"  db: {tmp_path / 'index.db'}\n"
        "  delay_seconds: 0\n"
        "  limit_per_channel: 0\n"
    )
    return load_config(cfg)


def test_build_report_dropped_low_density_backfill(tmp_path):
    store = _seed_store(tmp_path)
    try:
        # Low-density: 200 posts, 1 book file (0.005 files/post).
        low = store.upsert_source("channel", "lowchan")
        for i in range(200, 0, -1):
            p = store.upsert_post(low, i, "2026-11-06T10:00:00+00:00", "", "")
            store.replace_files_for_post(
                p,
                [{
                    "filename": "Low 200.epub", "ext": "epub",
                    "size_text": None, "size_bytes": None,
                    "title": "Low 200", "author": "",
                    "dedupe_key": "low 200|",
                    "obtain_url": "https://t.me/lowchan/200",
                }] if i == 200 else [],
            )
        store.set_source_status(low, "ok", oldest=1, newest=200)
        store.commit()
        cfg = _cfg_with_dropped(tmp_path)
        run = RunRecord(
            started_at="2026-11-06T20:00:00+00:00",
            finished_at="2026-11-06T20:05:00+00:00",
            duration_s=300,
            mode="backfill",
            config=str(tmp_path / "channels.yaml"),
            db="index.db",
            status="ok",
            note="Backfill: one block of 3000 posts per channel.",
            channels=[
                ChannelRun("bigchan", "ok", posts_new=5, files_new=2,
                           scope="backfill", backfill_posts=5,
                           backfill_complete=False),
                ChannelRun("lowchan", "ok", posts_new=1, files_new=1,
                           scope="backfill", backfill_posts=1,
                           backfill_complete=True),
            ],
        )
        text = build_report(store, run, cfg)
    finally:
        store.close()
    # The run note and backfill mode.
    assert "**Mode:** backfill" in text
    assert "Backfill: one block of 3000 posts" in text
    # Dropped: emptychan is in the Dropped section, not a candidate.
    assert "## Dropped channels (1)" in text
    assert "emptychan" in text and "1500 posts, 0 book files" in text
    assert "## Channels with 0 book files — drop candidates (0)" in text
    assert "None — every indexed channel has at least one book file." in text
    # Low-density.
    assert "## Low-density channels (1)" in text
    assert "lowchan" in text and "200 posts, 1 book files" in text
    # Backfill status.
    assert "## Backfill status" in text
    assert "backfill — more remain" in text
    assert "backfill — complete" in text
    assert "Complete this run: 1 of 2 channels touched." in text
