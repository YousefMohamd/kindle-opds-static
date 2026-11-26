-- RliBook D1 `entities` table (sync-fix v2, 2026-11-24).
--
-- The durable, queryable copy of the Telegram entity cache: one row
-- per configured source, keyed by the NUMERIC Telegram id. The JSON
-- file (telegram/entity-cache.json) is the runner-local fast path;
-- this table is the source of truth the BOT side can read without
-- resolving anything — in particular the /dl token mint (see the
-- multi-AI plan §15/§16: the mint needs a numeric channel_id, and
-- resolving it per request is what flood-limits the account).
--
-- Sync direction (tbi.d1_entities):
--   cache -> SQL : `python -m tbi.d1_entities export --cache
--                  entity-cache.json --out entities.sql`
--                  then: wrangler d1 execute rlibook-tg --remote
--                        --file entities.sql
--   D1 -> cache  : wrangler d1 execute rlibook-tg --remote
--                  --command "SELECT ..." --json > entities.json
--                  then: `python -m tbi.d1_entities import
--                         --in entities.json --cache entity-cache.json`
--                  (merge wins only when newer — see EntityCache.merge)
--
-- The weekly refresh workflow regenerates entities.sql whenever
-- entity-cache.json changed and commits it; applying it to D1 stays
-- a manual owner step (wrangler, no new secrets in the repo).
-- Negative-cache placeholders (id 0) are NEVER exported: a failed
-- resolve is not an entity.
--
-- Flagged/hidden books stay OUT of this table's consumers: the
-- table holds SOURCES (channels/groups), not books, so the flag
-- policy (flag = not available, hiding per-case by owner decision,
-- flagged/hidden books excluded from the KOReader/static OPDS
-- export) is unaffected. Do not add book rows here.

CREATE TABLE IF NOT EXISTS entities (
  handle TEXT PRIMARY KEY,          -- lowercased cache key, e.g. 'ebook_library'
  display_handle TEXT NOT NULL,     -- original spelling, e.g. 'EBook_Library'
  channel_id INTEGER NOT NULL,      -- numeric Telegram id (InputChannel id)
  access_hash INTEGER,              -- NULL for small-group chats (InputPeerChat)
  type TEXT NOT NULL DEFAULT 'channel',  -- 'channel' | 'chat'
  resolved_at TEXT NOT NULL,        -- ISO UTC of the last successful resolve
  updated_at TEXT NOT NULL          -- ISO UTC of the last upsert
);

CREATE INDEX IF NOT EXISTS idx_entities_channel_id ON entities(channel_id);
