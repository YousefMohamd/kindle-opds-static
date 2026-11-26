"""D1 entities table sync (sync-fix v2, 2026-11-24).

The ``entities`` table (telegram/sql/entities-schema.sql) is the
durable, queryable copy of the Telegram entity cache: one row per
configured source, keyed by the NUMERIC Telegram id. Two directions:

  export  cache JSON -> SQL upserts (applied with wrangler):
      python -m tbi.d1_entities export --cache entity-cache.json \\
          --out entities.sql
      wrangler d1 execute rlibook-tg --remote --file entities.sql

  import  D1 SELECT --json output -> cache JSON (merge, newer wins):
      wrangler d1 execute rlibook-tg --remote --command \\
          "SELECT handle, display_handle, channel_id, access_hash, \\
           type, resolved_at FROM entities" --json > entities.json
      python -m tbi.d1_entities import --in entities.json \\
          --cache entity-cache.json

Why a table at all, when the JSON file already exists: the file
lives in the repo and only the sync runners read it. The bot
Worker (and the /dl mint) cannot resolve a handle without spending
the account's resolve budget — but it CAN read a numeric id from
D1. The table is the bridge between the two halves of the project.

Rules enforced here (and in EntityCache.merge):
  * Negative-cache placeholders (id 0 / type 'unknown') are never
    exported — a failed resolve is not an entity.
  * An import never overwrites a fresher local entry (resolved_at
    decides); a stale export cannot roll the cache backwards.
  * No secrets, ever: handles, numeric ids and access hashes are
    public routing data (useless without the session), and no
    api_id / api_hash / session string is read or written here.

This module is offline and unit-tested (no wrangler, no network).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from .entity_cache import EntityCache, _normalize_handle


def sql_escape(s: str) -> str:
    return "'" + str(s).replace("'", "''") + "'"


def export_sql(cache: EntityCache) -> str:
    """SQL upserts for every good entry in the cache, oldest first
    (deterministic output — the file diffs cleanly in git)."""
    lines = ["BEGIN TRANSACTION;"]
    entries = sorted(cache.entries.items(), key=lambda kv: kv[0])
    for key, entry in entries:
        try:
            channel_id = int(entry.get("id"))
        except (TypeError, ValueError):
            continue
        if channel_id == 0:
            continue  # negative-cache placeholder, not an entity
        access_hash = entry.get("access_hash")
        access_sql = (
            str(int(access_hash)) if access_hash is not None else "NULL"
        )
        lines.append(
            "INSERT INTO entities(handle, display_handle, channel_id, "
            "access_hash, type, resolved_at, updated_at) VALUES ("
            f"{sql_escape(key)},"
            f"{sql_escape(entry.get('handle') or key)},"
            f"{channel_id},{access_sql},"
            f"{sql_escape(entry.get('type') or 'channel')},"
            f"{sql_escape(entry.get('resolved_at') or '')},"
            f"{sql_escape(entry.get('resolved_at') or '')}) "
            "ON CONFLICT(handle) DO UPDATE SET "
            "display_handle=excluded.display_handle, "
            "channel_id=excluded.channel_id, "
            "access_hash=excluded.access_hash, "
            "type=excluded.type, "
            "resolved_at=excluded.resolved_at, "
            "updated_at=excluded.updated_at;"
        )
    lines.append("COMMIT;")
    return "\n".join(lines) + "\n"


def parse_d1_json(data: Any) -> dict[str, dict]:
    """Parse `wrangler d1 execute --json` output into
    {cache_key: entry}. The --json shape is a list with one result
    object holding {"results": [rows...]} (wrangler wraps the D1
    response); a bare list of rows is accepted too. Rows missing a
    usable channel_id are skipped."""
    results = None
    if isinstance(data, list):
        for item in data:
            if isinstance(item, dict) and isinstance(item.get("results"), list):
                results = item["results"]
                break
        if results is None:
            results = data
    elif isinstance(data, dict) and isinstance(data.get("results"), list):
        results = data["results"]
    if not isinstance(results, list):
        return {}
    entries: dict[str, dict] = {}
    for row in results:
        if not isinstance(row, dict):
            continue
        try:
            channel_id = int(row.get("channel_id"))
        except (TypeError, ValueError):
            continue
        if channel_id == 0:
            continue
        handle = str(row.get("handle") or row.get("display_handle") or "")
        if not handle:
            continue
        key = _normalize_handle(handle)
        access_hash = row.get("access_hash")
        entries[key] = {
            "handle": row.get("display_handle") or handle,
            "id": channel_id,
            "access_hash": int(access_hash) if access_hash is not None else None,
            "type": row.get("type") or "channel",
            "resolved_at": row.get("resolved_at") or "",
        }
    return entries


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    ex = sub.add_parser("export", help="cache JSON -> SQL upserts")
    ex.add_argument("--cache", default="entity-cache.json")
    ex.add_argument("--out", required=True, help="SQL file to write")
    im = sub.add_parser("import", help="D1 --json -> cache JSON (merge)")
    im.add_argument("--in", dest="inp", required=True,
                    help="wrangler d1 execute --json output file")
    im.add_argument("--cache", default="entity-cache.json")
    args = ap.parse_args(argv)

    if args.cmd == "export":
        cache = EntityCache.load(args.cache)
        sql = export_sql(cache)
        Path(args.out).write_text(sql, encoding="utf-8")
        print(f"exported {len(cache)} cache entries -> {args.out}")
        return 0

    cache = EntityCache.load(args.cache)
    data = json.loads(Path(args.inp).read_text(encoding="utf-8"))
    entries = parse_d1_json(data)
    changed = cache.merge(entries)
    print(f"imported {len(entries)} D1 entities, "
          f"{changed} added/updated in {args.cache}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
