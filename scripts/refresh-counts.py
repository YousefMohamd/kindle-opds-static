#!/usr/bin/env python3
"""Refresh the static Telegram fallback counts in index.html from the manifest.

The home page (repo-root index.html) shows Telegram totals in two places
as static text, with a JS fetch of /telegram/index.json refreshing them
live at runtime:

  * the search intro: "مكتبات تيليجرام (219 مكتبة)"
  * the Telegram card: <p id="tgcount">219 مكتبة — 324,416 كتاب مميز،
    444,412 ملف — من قنوات وجروبات تيليجرام العامة.</p>

The static numbers go stale between daily syncs whenever the fetch
fails (or JS is off), so they must be regenerated from the manifest
(site/telegram/index.json) — never edited by hand. This script reads
the manifest totals and rewrites those two spots, plus the maintainer
comment above the fetch (which used to carry hardcoded numbers and a
date), from the manifest. No number is hardcoded here.

Run from the repo root after each manifest regeneration:

    python3 scripts/refresh-counts.py

Options (used by the daily sync workflow, which refreshes from the NEW
staging manifest before publishing it):

    --manifest PATH   manifest to read (default: site/telegram/index.json)
    --index PATH      index.html to rewrite (default: repo-root index.html)
    --check           exit 1 if index.html would change, without writing

Workflow hook (.github/workflows/telegram-sync.yml, "Build the static
site (staging)" step — the job's cwd is telegram/, so paths are ../):

    python3 ../scripts/refresh-counts.py --manifest ../site/telegram.new/index.json

The Publish step in that workflow must `git add index.html` for the
refresh to be committed — the refreshed home page is deployed with the
new manifest. Idempotent: re-running with the same manifest changes
nothing. Exits non-zero if any of the three anchored spots is not
found (the page changed shape — update the patterns, do not force it).
"""
import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "site" / "telegram" / "index.json"
INDEX_HTML = ROOT / "index.html"


def build_new_text(text, sources, books, files, generated):
    """Return (new_text, changed_spots) with the manifest totals applied."""
    changed = []

    # (1) Search intro: "مكتبات تيليجرام (219 مكتبة)".
    new, n = re.subn(
        r"مكتبات تيليجرام \(\d+ مكتبة\)",
        f"مكتبات تيليجرام ({sources} مكتبة)",
        text,
        count=1,
    )
    if n == 1:
        text, changed = new, changed + ["search-intro"]
    # (2) Telegram card fallback: <p id="tgcount">…</p> (may wrap lines).
    def _tgcount(_m):
        return (
            f'<p id="tgcount">{sources} مكتبة — {books:,} كتاب مميز، '
            f"{files:,} ملف — من قنوات\n"
            "  وجروبات تيليجرام العامة.</p>"
        )

    new, n = re.subn(
        r'<p id="tgcount">.*?</p>', _tgcount, text, count=1, flags=re.DOTALL
    )
    if n == 1:
        text, changed = new, changed + ["tgcount"]
    # (3) Maintainer comment above the fetch: everything from
    # "// NOTE for maintainers:" up to (not including) the fetch line.
    # The replacement starts with the same marker, so re-running the
    # script matches its own output and stays idempotent.
    note = (
        "// NOTE for maintainers: the static numbers above are regenerated\n"
        "// from site/telegram/index.json by scripts/refresh-counts.py — run\n"
        "// it after each manifest regeneration (the daily telegram-sync\n"
        "// workflow runs it with the new staging manifest). Never edit the\n"
        f"// numbers by hand. Manifest used here: generated {generated}.\n"
    )
    new, n = re.subn(
        r"// NOTE for maintainers:.*?\n(?=fetch\(\"/telegram/index\.json\"\))",
        lambda _m: note,
        text,
        count=1,
        flags=re.DOTALL,
    )
    if n == 1:
        text, changed = new, changed + ["maintainer-comment"]
    return text, changed


def main():
    parser = argparse.ArgumentParser(
        description="Refresh index.html Telegram fallback counts from the manifest."
    )
    parser.add_argument("--manifest", type=Path, default=MANIFEST)
    parser.add_argument("--index", type=Path, default=INDEX_HTML)
    parser.add_argument(
        "--check",
        action="store_true",
        help="exit 1 if index.html would change, without writing",
    )
    args = parser.parse_args()

    data = json.loads(args.manifest.read_text(encoding="utf-8"))
    totals = data.get("totals", {})
    try:
        sources = int(totals["sources"])
        books = int(totals["books"])
        files = int(totals["files"])
    except (KeyError, TypeError, ValueError) as exc:
        print(f"manifest {args.manifest} is missing totals: {exc}", file=sys.stderr)
        return 1
    generated = str(data.get("generated_at", "unknown"))

    text = args.index.read_text(encoding="utf-8")
    new_text, changed = build_new_text(text, sources, books, files, generated)
    missing = {"search-intro", "tgcount", "maintainer-comment"} - set(changed)
    if missing:
        print(
            f"index.html shape changed — could not find: {', '.join(sorted(missing))}",
            file=sys.stderr,
        )
        return 1

    summary = (
        f"{args.index}: {sources} sources, {books:,} books, {files:,} files "
        f"(manifest generated {generated})"
    )
    if new_text == text:
        print(summary + " — already up to date")
        return 0
    if args.check:
        print(summary + " — WOULD CHANGE (run without --check to apply)")
        return 1
    args.index.write_text(new_text, encoding="utf-8")
    print(summary + " — updated")
    return 0


if __name__ == "__main__":
    sys.exit(main())
