#!/usr/bin/env python3
"""Drive sweep: pending submissions (KV) -> indexed libraries (D1 + repo).

Build 1 (submit -> index automatically). The bot ALREADY writes
every Drive submission to the KV ``submissions`` log at submit time
(``src/handlers.ts`` handleAddDriveLibrary -> ``store.logSubmission``:
status ``"pending_index"``, title ``"drive:<folderId>"``) — that log
IS the pending queue, so no bot change was needed to close the gap.
This module is the consumer, run by ``telegram-drive.yml`` on a
2-hourly schedule:

  1. ``--plan``: read the submissions JSON (fetched from KV by the
     workflow with curl — the repo token's KV-read scope is proven),
     take the NEWEST record per folder (the log is newest-first,
     capped at 500), keep only type=channel + title ``drive:<id>`` +
     status ``pending_index``. Skip folders already in
     ``drive-libraries.json`` (indexed — the registry is the indexed
     marker, so the sweep never touches the submissions log itself:
     a concurrent bot append would make a KV rewrite racy) and
     folders in the failed set (``drive:failed:<id>`` keys — a folder
     that is not shared "Anyone with the link" fails verification
     every time; retrying it 12x/day would spam the Drive API).
  2. ``--run``: ``--plan``, then invoke ``drive_index.py`` per folder
     (``--client http --no-transaction --max-books``) with the next
     free D1 id (``--start-id``, advanced per folder by the books
     just indexed). Writes a manifest JSON: indexed [{folder_id,
     submitter_tg_id, books, batch_sql, registry_sql, books_json}]
     + failed [{folder_id, reason}] + deferred [{folder_id,
     reason}] (over ``--max-books``). The workflow imports the
     manifest's batch + registry SQL into D1 with wrangler, PUTs the
     failed keys to KV, and commits the files. Nothing is committed
     by this module; a failed import leaves nothing behind (the next
     run re-indexes — drive_index is idempotent, INSERT OR IGNORE).

Build 2 (approve -> visible everywhere) support:
  ``--sync-registry``: rewrite ``drive-libraries.json`` from D1 rows
  (``--d1-rows`` JSON: SELECT folder_id,title,added_by,added_at,
  status,submitter_tg_id,visibility FROM drive_libraries) — D1 is
  the source of truth the monitor writes. Falls back to applying the
  monitor's KV marker payload (``--marker`` JSON: {folder_id, title,
  visibility, submitter_tg_id}) when the D1 read failed, so the
  static surfaces still refresh. Used by the publish-surfaces job.

No network in this module except the drive_index.py subprocess
(which calls the Drive API with DRIVE_API_KEY from the environment).
No secrets are printed: folder ids and counts only.

Usage:
  python3 telegram/tbi/drive_sweep.py --plan --submissions subs.json \\
      --registry drive-libraries.json [--failed failed.json] [--out plan.json]
  python3 telegram/tbi/drive_sweep.py --run --submissions subs.json \\
      --registry drive-libraries.json [--failed failed.json] \\
      --out-dir d1-batches-drive --state-file drive-state.jsonl \\
      --start-id 422851 [--max-books 10000] --manifest manifest.json
  python3 telegram/tbi/drive_sweep.py --sync-registry \\
      --registry drive-libraries.json [--d1-rows d1rows.json] [--marker marker.json]
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from drive_registry import load_registry, upsert_registry_json, validate_visibility  # noqa: E402

# Same shape as the bot's parseLibraryArg (src/parse.ts): a Drive
# folder id is 10-64 base64url characters.
FOLDER_RE = re.compile(r"^[A-Za-z0-9_-]{10,64}$")
TITLE_RE = re.compile(r"^drive:([A-Za-z0-9_-]+)$", re.IGNORECASE)

# drive_index.py exit codes (see its main()).
EXIT_NOT_SHARED = 3
EXIT_OVER_MAX_BOOKS = 4

FAILED_KEY_PREFIX = "drive:failed:"


def folder_id_from_title(title: str) -> str | None:
    """'drive:<folderId>' -> folder id, or None (not a Drive title)."""
    if not title:
        return None
    m = TITLE_RE.match(title.strip())
    return m.group(1) if m else None


def parse_pending(records: list, indexed: set[str], failed: set[str]) -> dict:
    """Newest-wins pending queue from the submissions log.

    Returns {to_index, skipped_indexed, skipped_failed, invalid}:
    to_index is [{folder_id, submitter_tg_id, submitted_at}] in
    submission order (newest first — the log's own order). A folder
    is decided by its NEWEST record only: a later status (e.g. an
    owner rejection) supersedes the pending one. "Needs indexing"
    covers both ``pending_index`` (just submitted) and
    ``pending_public`` (the submitter asked for publication while
    the folder was still unindexed — /mylibraries shows the button
    for pending_index too, and the pubreq log entry is then the
    newest record; skipping it would leave the folder unindexed
    forever, with the monitor 400ing on approve for want of a
    registry row).
    """
    to_index: list[dict] = []
    skipped_indexed: list[str] = []
    skipped_failed: list[str] = []
    invalid: list[str] = []
    seen: set[str] = set()
    for rec in records or []:
        if not isinstance(rec, dict):
            continue
        folder_id = folder_id_from_title(str(rec.get("title") or ""))
        if folder_id is None:
            continue  # not a Drive submission (Telegram channel etc.)
        key = folder_id.lower()
        if key in seen:
            continue  # newest record already decided this folder
        seen.add(key)
        if not FOLDER_RE.match(folder_id):
            invalid.append(folder_id)
            continue
        if rec.get("type") != "channel" or rec.get("status") not in (
                "pending_index", "pending_public", "pending"):
            continue  # decided by a newer non-pending record
        if key in {f.lower() for f in indexed}:
            skipped_indexed.append(folder_id)
        elif key in {f.lower() for f in failed}:
            skipped_failed.append(folder_id)
        else:
            submitter = rec.get("user_id")
            to_index.append({
                "folder_id": folder_id,
                "submitter_tg_id": int(submitter) if isinstance(submitter, int) else 0,
                "submitted_at": str(rec.get("timestamp") or ""),
            })
    return {
        "to_index": to_index,
        "skipped_indexed": skipped_indexed,
        "skipped_failed": skipped_failed,
        "invalid": invalid,
    }


def load_failed(path: Path | None) -> set[str]:
    """Failed-folder set from a JSON file.

    Accepts the KV list shape ([{"key": "drive:failed:<id>"}]), a
    plain list of ids, or {"keys": [...]}. Missing file -> empty set.
    """
    if path is None or not path.exists():
        return set()
    data = json.loads(path.read_text(encoding="utf-8"))
    keys: list = []
    if isinstance(data, dict):
        keys = data.get("keys") or data.get("result") or []
    elif isinstance(data, list):
        keys = data
    out = set()
    for k in keys:
        if isinstance(k, dict):
            k = k.get("key") or k.get("name") or ""
        k = str(k)
        if k.startswith(FAILED_KEY_PREFIX):
            k = k[len(FAILED_KEY_PREFIX):]
        if FOLDER_RE.match(k):
            out.add(k)
    return out


def registry_folders(registry: dict) -> set[str]:
    return {str(e.get("folder_id") or "") for e in registry.get("libraries", [])}


def registry_from_d1_rows(rows: list) -> dict:
    """D1 drive_libraries rows -> drive-libraries.json structure.

    D1 is the source of truth the monitor writes; a row with an
    unknown visibility is skipped (with a warning) rather than
    failing the whole sync.
    """
    libs: list[dict] = []
    for r in rows or []:
        if not isinstance(r, dict):
            continue
        folder_id = str(r.get("folder_id") or "")
        if not FOLDER_RE.match(folder_id):
            print(f"WARNING: skipping registry row with bad folder_id {folder_id!r}",
                  file=sys.stderr)
            continue
        try:
            visibility = validate_visibility(str(r.get("visibility") or "public"))
        except ValueError:
            print(f"WARNING: skipping registry row {folder_id} with bad "
                  f"visibility {r.get('visibility')!r}", file=sys.stderr)
            continue
        entry: dict = {
            "folder_id": folder_id,
            "title": str(r.get("title") or ""),
            "added_by": str(r.get("added_by") or ""),
            "added_at": str(r.get("added_at") or ""),
            "status": str(r.get("status") or "active"),
            "visibility": visibility,
        }
        submitter = r.get("submitter_tg_id")
        if submitter not in (None, "", 0):
            try:
                entry["submitted_by"] = int(submitter)
            except (TypeError, ValueError):
                pass
        libs.append(entry)
    libs.sort(key=lambda e: (e.get("title") or e["folder_id"]).lower())
    return {"libraries": libs}


def apply_marker(registry: dict, marker: dict) -> dict:
    """Upsert the monitor's approve/reject marker into the registry.

    The marker carries the full new state for one library (the
    monitor knows it at approve time); it wins for visibility +
    title, and keeps the stored submitter unless the marker names
    one. Used when the D1 read failed — the static surfaces still
    refresh from the marker alone.
    """
    folder_id = str(marker.get("folder_id") or "")
    if not FOLDER_RE.match(folder_id):
        raise ValueError(f"bad marker folder_id {folder_id!r}")
    visibility = validate_visibility(str(marker.get("visibility") or "public"))
    lib: dict = {
        "folder_id": folder_id,
        "title": str(marker.get("title") or ""),
        "added_by": "",
        "added_at": "",
        "status": "active",
        "visibility": visibility,
    }
    submitter = marker.get("submitter_tg_id")
    if submitter not in (None, "", 0):
        lib["submitter_tg_id"] = int(submitter)
    return upsert_registry_json(registry, {**lib, "force_visibility": True})


def _d1_rows_from_json(data) -> list | None:
    """Unwrap a wrangler --json SELECT result (or a bare list)."""
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for key in ("results", "result", "rows"):
            v = data.get(key)
            if isinstance(v, list):
                return v
    return None


def run_index(folder_id: str, submitter_tg_id: int, start_id: int,
              out_dir: Path, state_file: str, registry_json: Path,
              max_books: int) -> dict:
    """Index one folder via drive_index.py; returns a manifest entry.

    On success: {folder_id, submitter_tg_id, books, batch_sql,
    registry_sql, books_json}. On failure: {folder_id, reason} with
    reason not_shared_or_missing (exit 3 — folder not shared
    "Anyone with the link" or not a folder), over_max_books (exit 4
    — deferred for a manual import), or index_error.
    """
    here = Path(__file__).resolve().parent
    cmd = [
        sys.executable, str(here / "drive_index.py"),
        "--client", "http",
        "--folder", folder_id,
        "--out-dir", str(out_dir),
        "--state-file", state_file,
        "--start-id", str(start_id),
        "--submitter-tg-id", str(submitter_tg_id),
        "--visibility", "private",
        "--registry-json", str(registry_json),
        "--no-transaction",
    ]
    if max_books:
        cmd += ["--max-books", str(max_books)]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
    sys.stdout.write(proc.stdout)
    if proc.stderr:
        sys.stderr.write(proc.stderr)
    if proc.returncode == 0:
        books_json = out_dir / f"drive-{folder_id[:12]}-books.json"
        try:
            books = json.loads(books_json.read_text(encoding="utf-8"))
            n = len(books)
        except Exception:
            n = 0
        return {
            "folder_id": folder_id,
            "submitter_tg_id": submitter_tg_id,
            "books": n,
            "batch_sql": str(out_dir / f"drive-{folder_id[:12]}.sql"),
            "registry_sql": str(out_dir / f"drive-{folder_id[:12]}-registry.sql"),
            "books_json": str(books_json),
        }
    if proc.returncode == EXIT_NOT_SHARED:
        return {"folder_id": folder_id, "reason": "not_shared_or_missing"}
    if proc.returncode == EXIT_OVER_MAX_BOOKS:
        return {"folder_id": folder_id, "reason": "over_max_books"}
    return {"folder_id": folder_id, "reason": "index_error"}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--plan", action="store_true",
                    help="print the pending plan JSON and exit")
    ap.add_argument("--run", action="store_true",
                    help="plan + index each pending folder, write a manifest")
    ap.add_argument("--sync-registry", action="store_true",
                    help="rewrite the registry JSON from D1 rows / marker")
    ap.add_argument("--submissions", default="",
                    help="submissions JSON file (KV `submissions` value)")
    ap.add_argument("--registry", default="drive-libraries.json")
    ap.add_argument("--failed", default="",
                    help="failed-folders JSON file (KV drive:failed:* list)")
    ap.add_argument("--out", default="",
                    help="write the plan JSON here (default: stdout)")
    ap.add_argument("--out-dir", default="d1-batches-drive")
    ap.add_argument("--state-file", default="drive-state.jsonl")
    ap.add_argument("--start-id", type=int, default=1,
                    help="first books.id for the first folder indexed")
    ap.add_argument("--max-books", type=int, default=10000,
                    help="defer folders over this many books (0 = no cap)")
    ap.add_argument("--manifest", default="",
                    help="write the run manifest JSON here (with --run)")
    ap.add_argument("--d1-rows", default="",
                    help="D1 SELECT result JSON (with --sync-registry)")
    ap.add_argument("--marker", default="",
                    help="monitor marker JSON (with --sync-registry)")
    args = ap.parse_args()

    registry_path = Path(args.registry)
    registry = load_registry(registry_path)

    if args.sync_registry:
        rows = None
        if args.d1_rows:
            data = json.loads(Path(args.d1_rows).read_text(encoding="utf-8"))
            rows = _d1_rows_from_json(data)
        if rows is not None:
            registry = registry_from_d1_rows(rows)
            registry_path.write_text(
                json.dumps(registry, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8")
            print(f"Synced {registry_path} from D1 ({len(registry['libraries'])} libraries)")
            return 0
        if args.marker:
            marker = json.loads(Path(args.marker).read_text(encoding="utf-8"))
            registry = apply_marker(registry, marker)
            registry_path.write_text(
                json.dumps(registry, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8")
            print(f"Applied marker to {registry_path} "
                  f"({marker.get('folder_id')} -> {marker.get('visibility')})")
            return 0
        print("ERROR: --sync-registry needs --d1-rows or --marker",
              file=sys.stderr)
        return 2

    if not args.submissions:
        print("ERROR: --submissions is required (with --plan / --run)",
              file=sys.stderr)
        return 2
    records = json.loads(Path(args.submissions).read_text(encoding="utf-8"))
    failed = load_failed(Path(args.failed) if args.failed else None)
    plan = parse_pending(records, registry_folders(registry), failed)

    if args.plan and not args.run:
        text = json.dumps(plan, ensure_ascii=False, indent=2)
        if args.out:
            Path(args.out).write_text(text + "\n", encoding="utf-8")
        else:
            print(text)
        print(f"Plan: {len(plan['to_index'])} to index, "
              f"{len(plan['skipped_indexed'])} already indexed, "
              f"{len(plan['skipped_failed'])} failed-known, "
              f"{len(plan['invalid'])} invalid", file=sys.stderr)
        return 0

    if args.run:
        if not args.manifest:
            print("ERROR: --run needs --manifest", file=sys.stderr)
            return 2
        manifest: dict = {
            "indexed": [], "failed": [], "deferred": [],
            "skipped_indexed": plan["skipped_indexed"],
            "skipped_failed": plan["skipped_failed"],
            "invalid": plan["invalid"],
        }
        start_id = args.start_id
        for item in plan["to_index"]:
            entry = run_index(
                item["folder_id"], item["submitter_tg_id"], start_id,
                Path(args.out_dir), args.state_file, registry_path,
                args.max_books)
            if "books" in entry:
                manifest["indexed"].append(entry)
                start_id += entry["books"]
                print(f"Indexed {entry['folder_id']}: {entry['books']} books "
                      f"(next start_id {start_id})")
            elif entry.get("reason") == "over_max_books":
                manifest["deferred"].append(entry)
                print(f"Deferred {entry['folder_id']}: over --max-books "
                      f"{args.max_books}", file=sys.stderr)
            else:
                manifest["failed"].append(entry)
                print(f"FAILED {entry['folder_id']}: {entry.get('reason')}",
                      file=sys.stderr)
        manifest["next_start_id"] = start_id
        Path(args.manifest).write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8")
        print(f"Run done: {len(manifest['indexed'])} indexed, "
              f"{len(manifest['failed'])} failed, "
              f"{len(manifest['deferred'])} deferred")
        return 0

    print("ERROR: pass one of --plan, --run, --sync-registry",
          file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
