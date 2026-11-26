#!/usr/bin/env python3
"""Google Drive library indexer for RliBook (Drive sources).

Design (user decisions, 2026-11-22 — do not re-litigate):
- A Drive folder link is a *library source*, added through the SAME
  /addchannel flow as Telegram channels (one unified button; the bot
  detects t.me vs drive.google.com automatically). See
  parseLibraryArg() in the bot (src/parse.ts).
- Drive sources are NOT reviewed for content — they are indexed as-is.
  Remaining protection is the DMCA hold (72h), the Report button and
  the flag system. A Drive library can therefore bring in-print books;
  that risk is accepted by the user, explicitly.
- NO backup copy to Yousef's Drive (user: will not download them to
  his Drive; all libraries are open now). Metadata index + link-health
  monitor only (see drive_health.py).
- Only METADATA is ever read (name, id, mimeType, size, modifiedTime).
  Book files themselves are never downloaded by the indexer.

How a Drive book reaches the catalog:
  1. User sends a Drive folder link to the bot (/addchannel).
     The bot validates the URL format, charges one daily channel slot
     (5/day), logs a pending submission and notifies the owner —
     exactly like a Telegram channel today.
  2. The owner runs the `telegram-drive.yml` workflow (workflow_dispatch
     with the folder URL) — or adds the folder to drive-libraries.json.
     The indexer verifies the folder with files.get (it must be shared
     "Anyone with the link can view", otherwise Drive returns 404/403
     and the library is rejected with that reason).
  3. The indexer lists the folder recursively (files.list, pageSize
     1000, metadata only), keeps book files (pdf/epub/mobi/azw3/kfx/
     txt/doc/docx/cbz/cbr), and emits D1 batch SQL in the SAME format
     as telegram/tbi/d1_sync.py batch_sql(): one row in `books` + one
     in `books_fts` per book. kind='drive', source='drive:<folderId>',
     url='https://drive.google.com/file/d/<fileId>/view'. It also
     emits a books JSON (--books-json, for drive_opds.py) and a
     drive_libraries registry upsert (--registry-sql). NEW libraries
     are PRIVATE to their submitter by default (--visibility private,
     --submitter-tg-id <tg id>); see drive_registry.py for the
     two-type model. Only PUBLIC libraries enter the static OPDS /
     search-index files (drive_opds.py enforces that).
  4. Download: Drive files shared "Anyone with the link" can be
     fetched WITHOUT user OAuth — via the Drive API with an API key
     (files.get?alt=media) or via https://drive.usercontent.google.com/
     download?id=<fileId>&export=download. The download proxy serves
     them behind the same HMAC mint token as Telegram books, so the
     bot/website delivery ladder is unchanged. (Files over ~100MB hit
     Google's virus-scan confirm page on the uc endpoint; the API-key
     path avoids it.)

Drive clients:
  - HatchCliDriveClient — local/VM use via /opt/hatch/bin/hatch_gws_cli
    (the connected Google account). Used for measurement and manual runs.
  - HttpDriveClient — GitHub Actions use: Drive REST API with an API
    key (DRIVE_API_KEY, public/link-shared files only) or a bearer
    access token (DRIVE_ACCESS_TOKEN, e.g. a service account token).

Usage:
  python3 telegram/tbi/drive_index.py --measure --folder 1EFegWouzH4CXHzX2N-NfD18mJbtDLQAP
  python3 telegram/tbi/drive_index.py --folder <id-or-url> --out-dir d1-batches-drive --start-id 422454
  python3 telegram/tbi/drive_index.py --folder <id-or-url> --dry-run
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from d1_sync import batch_sql  # noqa: E402  (same batch format + FTS norms)

FOLDER_MIME = "application/vnd.google-apps.folder"
BOOK_EXTS = {"pdf", "epub", "mobi", "azw3", "kfx", "txt", "doc", "docx", "cbz", "cbr"}

_FOLDER_RE = re.compile(
    r"(?:drive\.google\.com/drive/(?:folders/|u/\d+/folders/)|drive\.google\.com/open\?id=|drive\.google\.com/file/d/)"
    r"([A-Za-z0-9_-]{10,})"
)


def parse_drive_folder_id(text: str) -> str | None:
    """Extract a Drive folder/file id from a URL, or return the bare id."""
    if not text:
        return None
    t = text.strip()
    m = _FOLDER_RE.search(t)
    if m:
        return m.group(1)
    if re.fullmatch(r"[A-Za-z0-9_-]{10,}", t):
        return t
    return None


def human_size(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.1f} {unit}" if unit != "B" else f"{n} B"
        n /= 1024
    return f"{n:.1f} TB"


def strip_transaction_statements(sql: str) -> str:
    """Drop explicit transaction statements from emitted batch SQL.

    ``batch_sql`` wraps every batch in ``BEGIN TRANSACTION;`` ...
    ``COMMIT;`` (correct for local SQLite / the one-shot delta), but
    ``wrangler d1 execute --remote`` REJECTS explicit transaction
    statements — observed live 2026-11-26 (telegram-d1-incremental
    run 45821910503, wrangler 4.168.0): the whole file is refused
    before any statement runs. Same semantics as
    ``d1_incremental.strip_transaction`` (the canonical twin — keep
    the two in sync): only whole lines that ARE a transaction
    statement are dropped, so a title containing the words inside an
    INSERT line is untouched. The Drive sweep (telegram-drive.yml)
    imports batches with wrangler, so it passes --no-transaction.
    """
    drop = ("BEGIN TRANSACTION;", "COMMIT;")
    kept = []
    for line in sql.splitlines():
        s = line.strip().upper()
        if s in drop or s.startswith("SAVEPOINT ") or s.startswith("RELEASE "):
            continue
        kept.append(line)
    out = "\n".join(kept)
    return out + "\n" if sql.endswith("\n") else out


class DriveError(Exception):
    pass


class HatchCliDriveClient:
    """Drive API through the connected hatch_gws_cli (local/VM only)."""

    def __init__(self, cli: str = "/opt/hatch/bin/hatch_gws_cli"):
        self.cli = cli

    def _run(self, args: list[str]) -> dict:
        out = subprocess.run(
            [self.cli, *args], capture_output=True, text=True, timeout=120
        )
        if out.returncode != 0:
            raise DriveError(f"hatch_gws_cli failed: {(out.stderr or out.stdout)[:300]}")
        try:
            return json.loads(out.stdout)
        except json.JSONDecodeError as e:
            raise DriveError(f"hatch_gws_cli non-JSON output: {e}")

    def get_file(self, file_id: str) -> dict:
        return self._run([
            "drive", "files", "get", "--params",
            json.dumps({"fileId": file_id,
                        "fields": "id,name,mimeType,size,modifiedTime,owners"}),
        ])

    def list_folder(self, folder_id: str, page_token: str = "") -> dict:
        params: dict[str, object] = {
            "q": f"'{folder_id}' in parents and trashed=false",
            "pageSize": 1000,
            "fields": "nextPageToken,files(id,name,mimeType,size,modifiedTime)",
        }
        if page_token:
            params["pageToken"] = page_token
        return self._run(["drive", "files", "list", "--params", json.dumps(params)])


class HttpDriveClient:
    """Drive REST API with an API key (link-shared files) or bearer token."""

    BASE = "https://www.googleapis.com/drive/v3"

    def __init__(self, api_key: str = "", access_token: str = ""):
        if not api_key and not access_token:
            raise DriveError("HttpDriveClient needs DRIVE_API_KEY or DRIVE_ACCESS_TOKEN")
        self.api_key = api_key
        self.access_token = access_token

    def _get(self, path: str, params: dict[str, str]) -> dict:
        if self.api_key:
            params["key"] = self.api_key
        url = f"{self.BASE}{path}?{urllib.parse.urlencode(params)}"
        req = urllib.request.Request(url)
        if self.access_token:
            req.add_header("Authorization", f"Bearer {self.access_token}")
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            raise DriveError(f"Drive API HTTP {e.code} on {path}: {e.read()[:200]!r}")

    def get_file(self, file_id: str) -> dict:
        return self._get(f"/files/{file_id}",
                         {"fields": "id,name,mimeType,size,modifiedTime"})

    def list_folder(self, folder_id: str, page_token: str = "") -> dict:
        params = {
            "q": f"'{folder_id}' in parents and trashed=false",
            "pageSize": "1000",
            "fields": "nextPageToken,files(id,name,mimeType,size,modifiedTime)",
        }
        if page_token:
            params["pageToken"] = page_token
        return self._get("/files", params)


def list_recursive(client, folder_id: str, stats: dict | None = None) -> list[dict]:
    """BFS list of a folder tree (metadata only). Returns flat file list.

    stats (when given) is filled with: calls, folders, files, book_files,
    total_bytes, max_depth, per-call seconds, total_seconds.
    """
    t0 = time.perf_counter()
    st = stats if stats is not None else {}
    st.setdefault("calls", 0)
    st.setdefault("call_seconds", [])
    st.setdefault("folders", 0)
    st.setdefault("files", 0)
    st.setdefault("book_files", 0)
    st.setdefault("total_bytes", 0)
    st.setdefault("max_depth", 0)
    out: list[dict] = []
    queue: list[tuple[str, int]] = [(folder_id, 0)]
    seen: set[str] = set()
    while queue:
        fid, depth = queue.pop(0)
        if fid in seen:
            continue
        seen.add(fid)
        st["max_depth"] = max(st["max_depth"], depth)
        page_token = ""
        while True:
            ct0 = time.perf_counter()
            page = client.list_folder(fid, page_token)
            st["calls"] += 1
            st["call_seconds"].append(time.perf_counter() - ct0)
            for item in page.get("files", []):
                if item.get("mimeType") == FOLDER_MIME:
                    st["folders"] += 1
                    queue.append((item["id"], depth + 1))
                else:
                    st["files"] += 1
                    size = int(item.get("size") or 0)
                    st["total_bytes"] += size
                    ext = item.get("name", "").rsplit(".", 1)[-1].lower() if "." in item.get("name", "") else ""
                    item["_depth"] = depth
                    if ext in BOOK_EXTS:
                        st["book_files"] += 1
                    out.append(item)
            page_token = page.get("nextPageToken", "")
            if not page_token:
                break
    st["total_seconds"] = time.perf_counter() - t0
    return out


def to_book(item: dict, folder_id: str) -> dict:
    """One Drive file -> d1_sync book dict (display values as-is)."""
    name = item["name"]
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    title = name[: -len(ext) - 1] if ext and name.lower().endswith("." + ext) else name
    file_id = item["id"]
    return {
        "title": title,
        "author": "",
        "source": f"drive:{folder_id}",
        "kind": "drive",
        "ext": ext,
        "size": human_size(int(item.get("size") or 0)),
        "date": (item.get("modifiedTime") or "")[:10],
        "url": f"https://drive.google.com/file/d/{file_id}/view",
        "filename": name,
        "file_id": file_id,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--folder", required=True, help="Drive folder id or URL")
    ap.add_argument("--client", choices=["hatch", "http"], default="hatch")
    ap.add_argument("--measure", action="store_true",
                    help="only measure listing time; print the timing report")
    ap.add_argument("--dry-run", action="store_true",
                    help="list + build books, print counts, write nothing")
    ap.add_argument("--out-dir", default="d1-batches-drive",
                    help="where to write the D1 batch SQL file")
    ap.add_argument("--start-id", type=int, default=1,
                    help="first books.id to assign in the batch")
    ap.add_argument("--state-file", default="",
                    help="append one JSON line per indexed file "
                         "(folder_id, file_id, url, filename) — read back "
                         "by drive_health.py")
    # Two-type model (WAVE 4, WS8): a newly submitted library is
    # PRIVATE to its submitter by default; the owner makes it public
    # from the monitor page. The indexer records the submitter +
    # visibility in the D1 drive_libraries registry (registry SQL) and
    # in drive-libraries.json, and writes a books JSON for the static
    # OPDS/search-index generator (drive_opds.py) — which emits those
    # files ONLY for public libraries.
    ap.add_argument("--submitter-tg-id", type=int, default=0,
                    help="Telegram user id of the submitter (0 = owner/unknown)")
    ap.add_argument("--visibility", default="private",
                    choices=["public", "private", "pending_public"],
                    help="registry visibility for this library (default: private)")
    ap.add_argument("--books-json", default="",
                    help="also write the book list as JSON (default: "
                         "<out-dir>/drive-<folder12>-books.json)")
    ap.add_argument("--registry-sql", default="",
                    help="also write the drive_libraries upsert SQL (default: "
                         "<out-dir>/drive-<folder12>-registry.sql)")
    ap.add_argument("--registry-json", default="",
                    help="also upsert this library into a drive-libraries.json "
                         "file (default: skip — pass the repo file to update it)")
    # Drive sweep (telegram-drive.yml, Build 1): the sweep imports the
    # batch with `wrangler d1 execute --remote`, which refuses explicit
    # transaction statements — --no-transaction strips them from the
    # emitted file (see strip_transaction_statements). --max-books
    # refuses an oversized library BEFORE writing anything, so a
    # giant folder never eats the shared D1 daily write budget
    # (100k rows/day) in one unattended run; the sweep defers it for
    # a manual import instead.
    ap.add_argument("--no-transaction", action="store_true",
                    help="strip BEGIN TRANSACTION;/COMMIT; from the batch "
                         "SQL so wrangler d1 execute accepts it")
    ap.add_argument("--max-books", type=int, default=0,
                    help="refuse (exit 4, write nothing) when the folder "
                         "holds more than this many book files (0 = no cap)")
    args = ap.parse_args()

    folder_id = parse_drive_folder_id(args.folder)
    if not folder_id:
        print(f"ERROR: cannot parse a Drive folder id from: {args.folder!r}", file=sys.stderr)
        return 2

    if args.client == "hatch":
        client = HatchCliDriveClient()
    else:
        import os
        client = HttpDriveClient(api_key=os.environ.get("DRIVE_API_KEY", ""),
                                 access_token=os.environ.get("DRIVE_ACCESS_TOKEN", ""))

    # Verify-first: the folder must exist and be readable.
    try:
        meta = client.get_file(folder_id)
    except DriveError as e:
        print(f"ERROR: folder not reachable (must be shared 'Anyone with the link'): {e}",
              file=sys.stderr)
        return 3
    if meta.get("mimeType") != FOLDER_MIME:
        print(f"ERROR: id {folder_id} is not a folder (mimeType={meta.get('mimeType')})",
              file=sys.stderr)
        return 3
    print(f"Folder: {meta.get('name')} ({folder_id})")

    stats: dict = {}
    files = list_recursive(client, folder_id, stats)
    books = [to_book(f, folder_id) for f in files
             if (f["name"].rsplit(".", 1)[-1].lower() if "." in f["name"] else "") in BOOK_EXTS]
    calls = stats["calls"]
    total = stats["total_seconds"]
    avg_call = (sum(stats["call_seconds"]) / calls) if calls else 0
    print(f"Listing: {stats['folders']} folders, {stats['files']} files "
          f"({stats['book_files']} book files), {human_size(stats['total_bytes'])} total, "
          f"max depth {stats['max_depth']}")
    print(f"Timing: {calls} API calls in {total:.1f}s "
          f"(avg {avg_call:.2f}s/call, max {max(stats['call_seconds']):.2f}s)")
    if stats["book_files"]:
        per_book = total / stats["book_files"]
        print(f"Rate: {per_book:.2f}s per book file "
              f"(~{60 / per_book:.0f} books/min at this folder shape)")
        # Extrapolation: calls scale with folders, not files. This folder
        # averages book_files/max(1,folders) books per folder.
        per_folder = stats["book_files"] / max(1, stats["folders"])
        for target in (500, 2000):
            est_folders = max(1, round(target / max(per_folder, 1)))
            est_calls = est_folders + 1
            est_s = est_calls * avg_call
            print(f"Estimate for a {target}-book library (~{est_folders} folders): "
                  f"~{est_s:.0f}s listing ({est_calls} calls) + D1 import "
                  f"({target * 2} rows, one batch file, trivial vs 100k/day budget)")
    if args.measure or args.dry_run:
        print(f"Books that would be indexed: {len(books)}")
        return 0

    if args.max_books and len(books) > args.max_books:
        print(f"ERROR: folder holds {len(books)} book files, over --max-books "
              f"{args.max_books} — refusing to write; import manually.",
              file=sys.stderr)
        return 4

    sql, _ = batch_sql(books, args.start_id)
    if args.no_transaction:
        sql = strip_transaction_statements(sql)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / f"drive-{folder_id[:12]}.sql"
    out_file.write_text(sql, encoding="utf-8")
    print(f"Wrote {out_file} ({len(books)} books, {len(books) * 2} D1 rows)")
    # Books JSON for the static OPDS/search-index generator
    # (drive_opds.py emits those files only for public libraries).
    books_json = Path(args.books_json) if args.books_json else \
        out_dir / f"drive-{folder_id[:12]}-books.json"
    books_json.parent.mkdir(parents=True, exist_ok=True)
    books_json.write_text(json.dumps(
        [{**b, "folder_id": folder_id, "library_title": meta.get("name", "")}
         for b in books], ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"Wrote {books_json} ({len(books)} books)")
    # Registry upsert (D1 drive_libraries) + optional JSON mirror.
    from drive_registry import (SCHEMA_SQL as REG_SCHEMA, load_registry,
                                registry_upsert_sql, upsert_registry_json)
    lib = {
        "folder_id": folder_id,
        "title": meta.get("name", ""),
        "added_by": "owner" if not args.submitter_tg_id else str(args.submitter_tg_id),
        "added_at": date.today().isoformat(),
        "status": "active",
        "submitter_tg_id": args.submitter_tg_id or None,
        "visibility": args.visibility,
    }
    reg_sql = Path(args.registry_sql) if args.registry_sql else \
        out_dir / f"drive-{folder_id[:12]}-registry.sql"
    reg_sql.write_text(REG_SCHEMA.strip() + "\n" + registry_upsert_sql(lib) + "\n",
                       encoding="utf-8")
    print(f"Wrote {reg_sql} (visibility={args.visibility})")
    if args.registry_json:
        reg_path = Path(args.registry_json)
        registry = load_registry(reg_path)
        upsert_registry_json(registry, lib)
        reg_path.write_text(json.dumps(registry, ensure_ascii=False, indent=2) + "\n",
                            encoding="utf-8")
        print(f"Updated {reg_path}")
    if args.state_file:
        with open(args.state_file, "a", encoding="utf-8") as fh:
            for f in files:
                fh.write(json.dumps({
                    "folder_id": folder_id,
                    "file_id": f["id"],
                    "url": f"https://drive.google.com/file/d/{f['id']}/view",
                    "filename": f["name"],
                }, ensure_ascii=False) + "\n")
        print(f"Appended {len(files)} state lines to {args.state_file}")
    print("Import with: wrangler d1 execute rlibook-tg --remote --file "
          f"{out_file}   (<=25 batch files/day, 100k rows/day budget)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
