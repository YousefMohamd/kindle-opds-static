#!/usr/bin/env python3
"""Drive link-health monitor for RliBook (Drive sources).

What it does (user decision, 2026-11-22 — built, not just proposed):
- For every library in drive-libraries.json, re-lists the folder tree
  (metadata only, same BFS as drive_index.py) and compares the live
  file IDs against the indexed state (drive-state.jsonl, written by
  drive_index.py --state-file).
- A file that is gone (or a whole folder that returns 404/403 —
  owner revoked sharing / deleted the folder) is marked UNAVAILABLE:
  an INSERT OR REPLACE row in the `drive_health` table. The book's
  metadata is NEVER deleted from `books` — the endpoint shows it as
  «غير متاح» instead of serving a dead link. USER WORDING DECISION
  (2026-11-23): when the whole library is gone, the endpoint says
  «تم حذف المكتبة دي من المالك» + «غير متاح».
- Writes a JSON report + the SQL file, and prints the owner
  notification text (the workflow posts it to the run summary; the
  owner DM wiring is a later step).

Schema (new tables, applied once with the SQL this script emits):
  CREATE TABLE IF NOT EXISTS drive_libraries (
    folder_id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '',
    added_by TEXT NOT NULL DEFAULT '', added_at TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active');
  CREATE TABLE IF NOT EXISTS drive_health (
    url TEXT PRIMARY KEY, available INTEGER NOT NULL,
    checked_at TEXT NOT NULL);

Endpoint contract (for the website/bot, not implemented here): when
serving a book with kind='drive', look up drive_health by url;
available=0 -> show «تم حذف المكتبة دي من المالك — غير متاح» and hide
Download/Email buttons (keep the title/author visible + Report button).

Usage:
  python3 telegram/tbi/drive_health.py --registry drive-libraries.json \
      --state drive-state.jsonl --out-dir drive-health-out
  # exits 0 when everything is healthy, 1 when any file/folder is down
  # (so a scheduled workflow run goes red and the owner notices).
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from drive_index import (  # noqa: E402
    DriveError, HatchCliDriveClient, HttpDriveClient, list_recursive,
)

SCHEMA_SQL = """\
CREATE TABLE IF NOT EXISTS drive_libraries (
  folder_id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '',
  added_by TEXT NOT NULL DEFAULT '', added_at TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active');
CREATE TABLE IF NOT EXISTS drive_health (
  url TEXT PRIMARY KEY, available INTEGER NOT NULL,
  checked_at TEXT NOT NULL);
"""


def sql_escape(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


def load_state(state_file: Path) -> dict[str, list[dict]]:
    """state lines -> {folder_id: [entries]} (dedup by file_id, keep last)."""
    by_folder: dict[str, dict[str, dict]] = {}
    if not state_file.exists():
        return {}
    for line in state_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        e = json.loads(line)
        by_folder.setdefault(e["folder_id"], {})[e["file_id"]] = e
    return {k: list(v.values()) for k, v in by_folder.items()}


def check_library(client, folder_id: str, indexed: list[dict],
                  checked_at: str) -> dict:
    """Return {folder_id, folder_ok, live_ids, missing, recovered}."""
    try:
        meta = client.get_file(folder_id)
        folder_ok = meta.get("mimeType") == "application/vnd.google-apps.folder"
        folder_err = "" if folder_ok else f"not a folder ({meta.get('mimeType')})"
    except DriveError as e:
        return {"folder_id": folder_id, "folder_ok": False,
                "folder_error": str(e)[:200],
                "missing": indexed, "recovered": [], "live_count": 0}
    stats: dict = {}
    live = list_recursive(client, folder_id, stats)
    live_ids = {f["id"] for f in live}
    missing = [e for e in indexed if e["file_id"] not in live_ids]
    recovered = [e for e in indexed if e["file_id"] in live_ids]
    return {"folder_id": folder_id, "folder_ok": True, "folder_error": folder_err,
            "missing": missing, "recovered": recovered,
            "live_count": len(live)}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--registry", default="drive-libraries.json")
    ap.add_argument("--state", default="drive-state.jsonl")
    ap.add_argument("--out-dir", default="drive-health-out")
    ap.add_argument("--client", choices=["hatch", "http"], default="hatch")
    args = ap.parse_args()

    registry = json.loads(Path(args.registry).read_text(encoding="utf-8")) \
        if Path(args.registry).exists() else {"libraries": []}
    state = load_state(Path(args.state))
    if args.client == "hatch":
        client = HatchCliDriveClient()
    else:
        import os
        client = HttpDriveClient(api_key=os.environ.get("DRIVE_API_KEY", ""),
                                 access_token=os.environ.get("DRIVE_ACCESS_TOKEN", ""))

    checked_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    sql_lines = [SCHEMA_SQL.strip()]
    report: dict = {"checked_at": checked_at, "libraries": []}
    any_down = False

    for lib in registry.get("libraries", []):
        folder_id = lib["folder_id"]
        indexed = state.get(folder_id, [])
        res = check_library(client, folder_id, indexed, checked_at)
        lib_report = {"folder_id": folder_id,
                      "title": lib.get("title", ""),
                      "folder_ok": res["folder_ok"],
                      "indexed": len(indexed),
                      "live": res["live_count"],
                      "missing": len(res["missing"])}
        if not res["folder_ok"]:
            any_down = True
            lib_report["folder_error"] = res.get("folder_error", "")
            # Whole library down: every indexed file is unavailable.
            for e in indexed:
                sql_lines.append(
                    f"INSERT OR REPLACE INTO drive_health(url, available, checked_at) "
                    f"VALUES ({sql_escape(e['url'])}, 0, {sql_escape(checked_at)});")
        else:
            for e in res["missing"]:
                any_down = True
                sql_lines.append(
                    f"INSERT OR REPLACE INTO drive_health(url, available, checked_at) "
                    f"VALUES ({sql_escape(e['url'])}, 0, {sql_escape(checked_at)});")
            for e in res["recovered"]:
                sql_lines.append(
                    f"INSERT OR REPLACE INTO drive_health(url, available, checked_at) "
                    f"VALUES ({sql_escape(e['url'])}, 1, {sql_escape(checked_at)});")
        report["libraries"].append(lib_report)
        status = "OK" if res["folder_ok"] and not res["missing"] else "DOWN"
        print(f"[{status}] {lib.get('title') or folder_id}: "
              f"indexed={len(indexed)} live={res['live_count']} "
              f"missing={len(res['missing'])}")

    sql_file = out_dir / "drive-health.sql"
    sql_file.write_text("\n".join(sql_lines) + "\n", encoding="utf-8")
    report_file = out_dir / "drive-health-report.json"
    report_file.write_text(json.dumps(report, ensure_ascii=False, indent=2),
                           encoding="utf-8")
    print(f"Wrote {sql_file} + {report_file}")
    if any_down:
        print("OWNER NOTIFY: بعض كتب Drive بقت غير متاحة (لينك ميت/مشاركة اتلغت) — "
              "التفاصيل في drive-health-report.json. الميتاداتا محفوظة، مفيش حاجة اتحذفت.")
        return 1
    print("All Drive libraries healthy.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
