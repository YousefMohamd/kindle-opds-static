// Cloudflare Pages Function: Drive library removal (RliBook, bot v4.8.84
// follow-up — Drive remove freedom + cleanup system).
// Route: POST /api/drive-remove
//
//   POST /api/drive-remove  { folder_id, fp }
//     -> 200 { ok: true, applied: true }            — D1 visibility is now 'removed'
//     -> 200 { ok: true, applied: true, already: true }
//                                                   — it was already removed (idempotent)
//     -> 200 { ok: true, applied: false, reason: "not_indexed" }
//                                                   — no D1 row yet: the library was never
//                                                      indexed. The bot keeps the KV-log
//                                                      record, and the sweep treats a
//                                                      newest "removed" record as a no-op
//                                                      (it never indexes a removed folder),
//                                                      so nothing more is needed.
//     -> 200 { ok: true, applied: false, reason: "unexpected_visibility" }
//                                                   — the row is in a state this endpoint
//                                                      does not flip.
//
// Why this endpoint exists: the bot's drive:remove: handler logs the
// removal to the KV submissions log (status "removed") and the bot
// hides the library from /mylibraries immediately — but D1 is the
// source of truth every surface reads (website search, OPDS, the
// libraries page, the mint/send gates), so the removal must land in
// the D1 registry too. The bot POSTs here first (best-effort — the
// KV log + the 2-hourly drive sweep backstop remain the durable
// record: the sweep applies the same guarded UPDATE from the
// manifest when the endpoint could not).
//
// Removal semantics (user decision 2026-11-27 ~16:42): the registry
// row flips to visibility='removed' and the books disappear from
// ALL surfaces. Metadata is NEVER deleted — the books rows stay in
// `books`, the registry row stays in `drive_libraries`. Re-adding
// the same folder later works: a new submission logs "pending_index"
// (newest-wins) and the sweep's to_restore backstop flips the row
// back to 'private' (guarded UPDATE — only from 'removed' /
// 'unavailable'); the books rows are still there, so no re-index
// is needed. The registry upsert keeps a stored visibility, so a
// re-index alone would NOT resurrect a removed library — the
// restore backstop is the path that does it (see drive_sweep.py).
//
// Auth (fail closed, no new secret): same as /api/drive-pubreq —
// the caller presents the tg-search shared secret `TG_SEARCH_BOT_KEY`
// as header `x-rlibook-bot-key`, then the submitter is verified by
// fingerprint against the shared KV (fp:<token> -> { tg_id }), and
// D1 ownership is checked: only the library's submitter (or the
// owner) may remove it.
//
// Data: D1 `drive_libraries` (registry). One SELECT + at most one
// UPDATE per request — no search, no counts, far inside the free
// D1 read budget.
//
// Env (Pages dashboard -> Settings -> Functions):
//   D1 binding  TG_D1            (required)
//   KV binding  RLIBOOK_KV       (required — fingerprint verification)
//   TG_SEARCH_BOT_KEY (secret, required — same value as the bot's)
//   RLIBOOK_OWNER_ID (var, optional — the owner's Telegram id)

const FP_RE = /^[A-Za-z0-9_-]{22}$/;
const FOLDER_RE = /^[A-Za-z0-9_-]{10,64}$/;

async function verifyFingerprint(env, fp) {
  if (!FP_RE.test(fp || "")) return null;
  const kv = env && env.RLIBOOK_KV;
  if (!kv || typeof kv.get !== "function") return null;
  try {
    const raw = await kv.get("fp:" + fp);
    if (!raw) return null;
    const v = JSON.parse(raw);
    const id = v && Number(v.tg_id);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch (e) {
    return null;
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });

  if (request.method !== "POST") {
    return json({ ok: false, error: "method not allowed" }, 405);
  }

  const db = env && env.TG_D1;
  if (!db) {
    return json({ ok: false, error: "search unavailable (TG_D1 not bound)" }, 503);
  }
  // Fail closed: without the shared bot secret configured on this
  // side, no caller can be authenticated — refuse, never accept.
  const wantKey = ((env && env.TG_SEARCH_BOT_KEY) || "").trim();
  if (!wantKey) {
    return json({ ok: false, error: "bot auth not configured" }, 503);
  }
  const gotKey = (request.headers.get("x-rlibook-bot-key") || "").trim();
  if (gotKey !== wantKey) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: "bad json" }, 400);
  }
  const folderId = String((body && body.folder_id) || "").trim();
  if (!FOLDER_RE.test(folderId)) {
    return json({ ok: false, error: "bad folder_id" }, 400);
  }
  const tgId = await verifyFingerprint(env, String((body && body.fp) || "").trim());
  if (!tgId) {
    return json({ ok: false, error: "unknown fingerprint" }, 401);
  }

  let row;
  try {
    row = await db
      .prepare("SELECT folder_id, visibility, submitter_tg_id FROM drive_libraries WHERE folder_id = ?")
      .bind(folderId)
      .first();
  } catch (e) {
    return json({ ok: false, error: "registry unavailable" }, 503);
  }
  if (!row) {
    // Not indexed yet — nothing to hide. The sweep owns this case:
    // a newest "removed" record is a no-op there (it never indexes
    // a removed folder), so the removal cannot be undone by a later
    // index run.
    return json({ ok: true, applied: false, reason: "not_indexed" });
  }
  const ownerRaw = Number((env && (env.RLIBOOK_OWNER_ID || env.OWNER_TG_ID)) || 0);
  const ownerTgId = Number.isSafeInteger(ownerRaw) && ownerRaw > 0 ? ownerRaw : 0;
  const submitter = Number(row.submitter_tg_id) || 0;
  const isOwner = !!(ownerTgId && tgId === ownerTgId);
  if (tgId !== submitter && !isOwner) {
    return json({ ok: false, error: "not your library" }, 403);
  }
  const visibility = String(row.visibility || "public").toLowerCase();
  if (visibility === "removed") {
    return json({ ok: true, applied: true, already: true });
  }
  if (visibility !== "public" && visibility !== "private" && visibility !== "pending_public") {
    return json({ ok: true, applied: false, reason: "unexpected_visibility" });
  }
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  try {
    // Guard the UPDATE with the expected live visibilities so a
    // concurrent change cannot resurrect a library that was just
    // removed (or flip an unexpected state). A concurrent approve
    // (private -> public) still matches the guard and is removed
    // anyway — the remover's intent is the newest.
    const res = await db
      .prepare(
        "UPDATE drive_libraries SET visibility = 'removed', reviewed_at = ?" +
          " WHERE folder_id = ? AND visibility IN ('public', 'private', 'pending_public')",
      )
      .bind(now, folderId)
      .run();
    const changed = res && res.meta && typeof res.meta.changes === "number" ? res.meta.changes : 1;
    if (changed === 0) {
      // Lost a race (removed between the SELECT and the UPDATE):
      // re-read and report the true state.
      const cur = await db
        .prepare("SELECT visibility FROM drive_libraries WHERE folder_id = ?")
        .bind(folderId)
        .first();
      const curVis = cur ? String(cur.visibility || "").toLowerCase() : "";
      if (curVis === "removed") return json({ ok: true, applied: true, already: true });
      return json({ ok: false, error: "concurrent update" }, 409);
    }
  } catch (e) {
    return json({ ok: false, error: "update failed" }, 503);
  }
  return json({ ok: true, applied: true });
}
