"""Per-run report writer: ``index-report.md``.

Every ``tbi index`` run writes one, next to the DB, so the run's result
is a durable record — and the cloud workflow publishes it with the
static site. The format mirrors the interim report
(``index-report-2026-11-06.md``): summary, indexed channels, zero-book
channels, dropped channels, low-density channels, backfill status,
giants, failures, not-yet-indexed, groups, dead handles,
private invites. Everything in it comes from the DB + this run's
record + the config file's own commented inventory (the 168 groups,
10 dead handles, 6 private invites and the 8 dropped channels are
listed as comments in ``channels.yaml`` and are parsed from there,
never hard-coded).
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional

# A channel whose newest post id is at/above this is a "giant": a full
# uncapped walk of it is impractical (see estimate_full_walk_minutes).
GIANT_THRESHOLD = 50_000
# Preview serves ~20 posts per page (see tbi.scrape.PAGE_SIZE).
PAGE_SIZE = 20
# 1.5 s polite delay + fetch time per page (estimate for the giants).
SECONDS_PER_PAGE = 2.0
# A channel with this many posts and 0 book files is flagged loudly.
HUGE_ZERO_BOOK_THRESHOLD = 1_000
# A channel with book files but fewer than one per 100 posts is
# low-density: kept active, flagged in the report.
LOW_DENSITY_RATIO = 0.01

METHOD_LINE = (
    "public t.me/s/ previews only, page by page, metadata only "
    "(post text, file name/format/size, post link). No API, no login, "
    "no account. Book files are never downloaded."
)

_GROUP_NAME_RE = re.compile(
    r"^\s*#\s*-\s*name:\s*(?:\"([^\"]+)\"|(\S+))\s*$"
)
_DEAD_RE = re.compile(r"^\s*#\s*-\s*([A-Za-z0-9_]+)\s*$")
_INVITE_RE = re.compile(r"^\s*#\s*-\s*(t\.me/\+\S+)")
_DROPPED_RE = re.compile(r"^\s*#\s*-\s*([A-Za-z0-9_]+)\s*\((.*)\)\s*$")


@dataclass
class ChannelRun:
    """What one index run did for one channel."""

    username: str
    status: str  # ok | skip | error | interrupted | no_preview
    posts_new: int = 0
    files_new: int = 0
    scope: str = ""  # full | capped N | resumed | incremental | backfill | —
    note: str = ""
    error: str = ""
    # Backfill runs only: posts fetched in this run's backfill block,
    # and whether the channel is complete (block reached post 1 or
    # returned fewer than the block size).
    backfill_posts: int = 0
    backfill_complete: bool = False


@dataclass
class GroupRun:
    """What one index run did for one group (Desktop export)."""

    name: str
    status: str  # ok | skip | error
    posts_new: int = 0
    files_new: int = 0
    note: str = ""
    error: str = ""


@dataclass
class RunRecord:
    """One `tbi index` run, for the report."""

    started_at: str = ""
    finished_at: str = ""
    duration_s: float = 0.0
    mode: str = "incremental"  # full | capped N | incremental | new-only | backfill
    config: str = ""
    db: str = ""
    status: str = "ok"  # ok | partial | failed | interrupted
    note: str = ""  # run-level note (e.g. the backfill block rule)
    channels: List[ChannelRun] = field(default_factory=list)
    groups: List[GroupRun] = field(default_factory=list)


def estimate_full_walk_minutes(newest_post_id: int) -> float:
    """Rough minutes for an uncapped walk of a channel this big."""
    return (newest_post_id / PAGE_SIZE) * SECONDS_PER_PAGE / 60.0


def format_duration(seconds: float) -> str:
    """45 -> '45s'; 192 -> '3m 12s'; 3720 -> '1h 2m'."""
    seconds = max(0, int(round(seconds)))
    if seconds < 60:
        return f"{seconds}s"
    minutes, secs = divmod(seconds, 60)
    if minutes < 60:
        return f"{minutes}m {secs}s" if secs else f"{minutes}m"
    hours, minutes = divmod(minutes, 60)
    return f"{hours}h {minutes}m" if minutes else f"{hours}h"


def _fmt_minutes(minutes: float) -> str:
    if minutes < 1:
        return "~0"
    if minutes < 60:
        return f"~{int(round(minutes))} min"
    hours = minutes / 60.0
    return f"~{hours:.1f}h" if hours < 10 else f"~{int(round(hours))}h"


def parse_config_inventory(config_path: str | Path) -> dict:
    """Inventory from the config file's own commented sections.

    ``channels.yaml`` lists the 168 pending groups as commented
    ``- name: ...`` entries, the 10 dead handles under a ``# Dead``
    header, the 6 private invite links under a
    ``# Private invite links`` header, and the channels dropped for
    having 0 book files under a ``# Dropped`` header (each with its
    full-run counts in parentheses). Returns
    ``{"groups": [...], "dead": [...], "invites": [...],
    "dropped": [(name, note), ...]}`` — empty lists when the sections
    are absent, so the report degrades gracefully instead of failing.
    """
    out: dict = {"groups": [], "dead": [], "invites": [], "dropped": []}
    try:
        text = Path(config_path).read_text(encoding="utf-8")
    except OSError:
        return out
    section: Optional[str] = None
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("# Dropped"):
            section = "dropped"
            continue
        if stripped.startswith("# Dead"):
            section = "dead"
            continue
        if stripped.startswith("# Private invite links"):
            section = "invites"
            continue
        if stripped.startswith("#") and (
            stripped.startswith("# Batch")
            or stripped.startswith("# Groups")
            or stripped.startswith("# Channels")
        ):
            # A new commented section header ends the dead/invites/
            # dropped list.
            if section in ("dead", "invites", "dropped") and not stripped.startswith("# -"):
                section = None
            continue
        if not stripped:
            if section in ("dead", "invites", "dropped"):
                section = None
            continue
        m = _GROUP_NAME_RE.match(line)
        if m:
            out["groups"].append(m.group(1) or m.group(2))
            continue
        if section == "dead":
            m = _DEAD_RE.match(line)
            if m:
                out["dead"].append(m.group(1))
        elif section == "invites":
            m = _INVITE_RE.match(line)
            if m:
                out["invites"].append(m.group(1))
        elif section == "dropped":
            m = _DROPPED_RE.match(line)
            if m:
                out["dropped"].append((m.group(1), m.group(2).strip()))
    return out


def _link(name: str) -> str:
    return f"[{name}](https://t.me/{name})"


def build_report(store, run: RunRecord, cfg) -> str:
    """Render the run report as Markdown.

    ``store`` is an open :class:`tbi.store.Store`, ``run`` the record
    of the run that just finished, ``cfg`` the loaded config.
    """
    totals = store.counts()
    per_source = store.per_source_totals()
    by_name = {s["name"]: s for s in per_source}
    channels_db = [s for s in per_source if s["kind"] == "channel"]
    with_data = [s for s in channels_db if (s["post_count"] or 0) > 0]
    inventory = parse_config_inventory(run.config or cfg.path)
    dropped_names = {name for name, _note in inventory.get("dropped", [])}
    # Zero-book channels that are still active candidates; the dropped
    # ones have their own section below (their history stays in the DB).
    zero_book = [
        s for s in with_data
        if (s["file_count"] or 0) == 0 and s["name"] not in dropped_names
    ]
    # Book files but fewer than one per 100 posts: kept active, flagged.
    low_density = [
        s for s in with_data
        if (s["file_count"] or 0) > 0
        and (s["post_count"] or 0) > 0
        and s["file_count"] / s["post_count"] < LOW_DENSITY_RATIO
    ]
    giants = [
        s
        for s in with_data
        if s["newest_post_id"] and s["newest_post_id"] >= GIANT_THRESHOLD
    ]
    backfill_runs = [c for c in run.channels if c.scope == "backfill"]
    run_by_name = {c.username: c for c in run.channels}
    failures = [
        c
        for c in run.channels
        if c.status in ("error", "interrupted", "no_preview")
    ]
    failures += [g for g in run.groups if g.status == "error"]
    not_yet = [
        ch.username
        for ch in cfg.channels
        if ch.username not in by_name
    ]
    groups_indexed = [s for s in per_source if s["kind"] == "group"]

    lines: List[str] = []
    lines.append("# Index report — telegram-book-index")
    lines.append("")
    lines.append(
        f"**Date:** {run.finished_at or run.started_at} — "
        f"**Status:** {run.status} — **Mode:** {run.mode} — "
        f"**Duration:** {format_duration(run.duration_s)}"
    )
    lines.append(f"**Config:** `{run.config}` — **DB:** `{run.db}`")
    lines.append(f"**Method:** {METHOD_LINE}")
    if run.note:
        lines.append(f"**Note:** {run.note}")
    lines.append("")
    lines.append("## Summary so far")
    # The DB can hold channels the config no longer lists; never
    # print an impossible "1 of 0".
    walkable = max(len(cfg.channels), len(with_data))
    lines.append(
        f"- **Channels with data: {len(with_data)} of "
        f"{walkable} walkable** — **{totals['posts']} posts, "
        f"{totals['files']} book files** ({totals['books']} distinct books)"
    )
    lines.append(
        f"- **Channels with 0 book files: {len(zero_book)}** "
        "(drop candidates — see below)"
    )
    if inventory.get("dropped"):
        lines.append(
            f"- **Dropped channels: {len(inventory['dropped'])}** "
            "(0 book files in the full first run — history kept in the "
            "DB, no longer fetched; see below)"
        )
    if low_density:
        lines.append(
            f"- **Low-density channels: {len(low_density)}** "
            "(fewer than 1 book file per 100 posts — kept active, "
            "see below)"
        )
    lines.append(f"- **Not yet indexed: {len(not_yet)} channels**")
    lines.append(
        f"- **Failures this run: {len(failures)}** "
        "(see below; a failed channel keeps its last-good data)"
    )
    lines.append(
        f"- **Groups indexed from exports: {len(groups_indexed)}** — "
        f"{len(inventory['groups'])} more groups are commented out in "
        "channels.yaml, each needs a Desktop JSON export"
    )
    lines.append("")
    lines.append("## This run")
    if not run.channels and not run.groups:
        lines.append("Nothing was processed on this run.")
    else:
        lines.append("| Channel | New posts | New book files | Scope |")
        lines.append("|---|---|---|---|")
        for c in run.channels:
            scope = c.scope or "—"
            if c.scope == "backfill":
                scope = (
                    "backfill — complete"
                    if c.backfill_complete
                    else "backfill — more remain"
                )
            lines.append(
                f"| {_link(c.username)} | {c.posts_new} | {c.files_new} | "
                f"{scope} |"
            )
        for g in run.groups:
            lines.append(
                f"| {g.name} (group) | {g.posts_new} | {g.files_new} | "
                "export |"
            )
    lines.append("")
    if run.mode == "backfill":
        lines.append("## Backfill status")
        lines.append("")
        lines.append(
            "Each backfill run walks one block (3000 posts by default) "
            "below the oldest indexed post of every not-yet-complete "
            "channel, newest first. A channel is complete when a block "
            "reaches post 1 or returns fewer than the block size (the "
            "preview is exhausted). Once every channel is complete, "
            "backfill runs only check for new posts — the same as "
            "`--new-only` — and the workflow can be switched to it."
        )
        lines.append("")
        if not backfill_runs:
            lines.append("No channel was backfilled on this run.")
        for c in backfill_runs:
            rec = by_name.get(c.username, {})
            oldest = rec.get("oldest_post_id")
            lines.append(
                f"- {_link(c.username)} — block: {c.backfill_posts} posts, "
                f"oldest reached {oldest}, "
                + ("complete" if c.backfill_complete else "more remain")
            )
            if c.note:
                lines.append(f"  {c.note}")
        complete = sum(1 for c in backfill_runs if c.backfill_complete)
        lines.append("")
        lines.append(
            f"Complete this run: {complete} of {len(backfill_runs)} "
            "channels touched."
        )
        lines.append("")
    lines.append(f"## Indexed channels ({len(with_data)})")
    lines.append("")
    lines.append("| Channel | Posts | Book files | Scope |")
    lines.append("|---|---|---|---|")
    for s in sorted(with_data, key=lambda r: r["name"].lower()):
        scope = ""
        rec = run_by_name.get(s["name"])
        if rec is not None:
            scope = rec.scope or "—"
        else:
            scope = "—"
        lines.append(
            f"| {_link(s['name'])} | {s['post_count']} | "
            f"{s['file_count']} | {scope} |"
        )
    lines.append("")
    lines.append(
        f"## Channels with 0 book files — drop candidates ({len(zero_book)})"
    )
    lines.append("")
    if not zero_book:
        lines.append("None — every indexed channel has at least one book file.")
    for s in sorted(zero_book, key=lambda r: r["name"].lower()):
        flag = (
            " — HUGE FOR NOTHING"
            if (s["post_count"] or 0) >= HUGE_ZERO_BOOK_THRESHOLD
            else ""
        )
        lines.append(
            f"- {_link(s['name'])} — {s['post_count']} posts, "
            f"0 book files{flag}"
        )
    lines.append("")
    if inventory.get("dropped"):
        lines.append(
            f"## Dropped channels ({len(inventory['dropped'])})"
        )
        lines.append("")
        lines.append(
            "Removed from the active config after the full first run "
            "(2026-11-06): 0 book files each. Their history stays in "
            "index.db and remains searchable; they are simply not "
            "fetched anymore. To re-add one, move its line back to "
            "`channels:` in channels.yaml."
        )
        lines.append("")
        for name, note in sorted(inventory["dropped"]):
            lines.append(f"- {_link(name)} — {note}")
        lines.append("")
    if low_density:
        lines.append(
            f"## Low-density channels ({len(low_density)})"
        )
        lines.append("")
        lines.append(
            "Kept active, but they yield fewer than 1 book file per 100 "
            "posts — they cost walk time for almost no books. If a "
            "channel here stays this sparse, it is the next drop "
            "candidate."
        )
        lines.append("")
        for s in sorted(low_density, key=lambda r: r["name"].lower()):
            ratio = s["file_count"] / s["post_count"]
            lines.append(
                f"- {_link(s['name'])} — {s['post_count']} posts, "
                f"{s['file_count']} book files "
                f"({ratio:.3f} files/post)"
            )
        lines.append("")
    lines.append("## Giants (uncapped walk is impractical)")
    lines.append("")
    if not giants:
        lines.append("None indexed yet.")
    for s in sorted(
        giants, key=lambda r: r["newest_post_id"] or 0, reverse=True
    ):
        est = _fmt_minutes(
            estimate_full_walk_minutes(s["newest_post_id"])
        )
        lines.append(
            f"- {_link(s['name'])} — newest post id "
            f"{s['newest_post_id']} ≈ {est} for a full walk "
            f"(indexed {s['post_count']} posts, oldest reached "
            f"{s['oldest_post_id']})"
        )
    lines.append("")
    lines.append("## What failed so far")
    lines.append("")
    if not failures:
        lines.append("Nothing failed on this run.")
    for f in failures:
        if isinstance(f, ChannelRun):
            reason = f.error or f.note or f.status
            lines.append(f"- {_link(f.username)} — {reason}")
        else:
            reason = f.error or f.note or f.status
            lines.append(f"- {f.name} (group) — {reason}")
    # Persistent error rows that this run did not touch.
    touched = {c.username for c in run.channels} | {
        g.name for g in run.groups
    }
    for s in per_source:
        if s["status"] == "error" and s["name"] not in touched:
            lines.append(
                f"- {_link(s['name'])} — {s['note'] or 'error'} "
                "(from an earlier run)"
            )
    lines.append("")
    lines.append(f"## Not yet indexed — remaining {len(not_yet)} channels")
    lines.append("")
    if not not_yet:
        lines.append("None — every channel in the config has been indexed.")
    for name in sorted(not_yet, key=str.lower):
        lines.append(f"- {_link(name)}")
    lines.append("")
    lines.append(
        "## Not indexable live — groups (need a Desktop JSON export each)"
    )
    lines.append("")
    lines.append(
        "Reason: public groups have no t.me/s/ preview, so live scraping "
        "is impossible. Each group needs a Telegram Desktop 'Export chat "
        "history' as JSON (result.json), then its entry is uncommented in "
        "channels.yaml. No export has been produced yet for most groups."
    )
    lines.append("")
    if groups_indexed:
        for s in sorted(groups_indexed, key=lambda r: r["name"].lower()):
            lines.append(
                f"- {s['name']} — {s['post_count']} posts, "
                f"{s['file_count']} book files ({s['status']})"
            )
    if inventory["groups"]:
        lines.append("")
        lines.append(
            f"Pending exports ({len(inventory['groups'])} groups, "
            "commented out in channels.yaml):"
        )
        lines.append("")
        for name in inventory["groups"]:
            lines.append(f"- {_link(name)}")
    lines.append("")
    if inventory["dead"]:
        lines.append(
            f"## Dead — {len(inventory['dead'])} handles that do not exist "
            "(verified on two probes)"
        )
        lines.append("")
        for name in inventory["dead"]:
            lines.append(f"- {_link(name)}")
        lines.append("")
    if inventory["invites"]:
        lines.append(
            f"## Private invite links — {len(inventory['invites'])} "
            "(cannot be indexed without joining)"
        )
        lines.append("")
        for link in inventory["invites"]:
            lines.append(f"- [invite](https://{link})")
        lines.append("")
    lines.append("## Notes")
    lines.append("")
    lines.append(
        "- The preview has a coverage ceiling: on large/old channels the "
        "walk may stop before the first post; `tbi sources` records the "
        "oldest post id reached per channel."
    )
    lines.append(
        "- The index holds metadata only — no book files are downloaded "
        "or hosted. Files are obtained in Telegram via the post link."
    )
    lines.append(
        "- One non-Telegram site (archive.alsharekh.org, an Arabic "
        "magazine archive) is recorded separately in "
        "telegram-sources-batch2.md — not for this tool."
    )
    lines.append(
        "- Full source inventory (including the groups above) is in "
        "channels.yaml and telegram-sources-batch2.md."
    )
    lines.append("")
    return "\n".join(lines)


def write_report(path: str | Path, text: str) -> Path:
    """Write the report atomically (temp file + rename)."""
    path = Path(path)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)
    return path
