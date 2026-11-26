// Cloudflare Pages Function: Drive make-public request (RliBook, WAVE 7 C-bot).
// Route: POST /api/drive-pubreq
//
//   POST /api/drive-pubreq  { folder_id, fp }
//     -> 200 { ok: true, applied: true }            — D1 visibility is now 'pending_public'
//     -> 200 { ok: true, applied: true, already: true }
//                                                   — it was already pending_public (idempotent)
//     -> 200 { ok: true, applied: false, reason: "not_indexed" }
//                                                   — no D1 row yet: the library is still
//                                                      indexing (or not submitted). The bot
//                                                      keeps the KV-log record; the 2-hourly
//                                                      drive sweep indexes it, then the
//                                                      sweep backstop flips it pending_public
//                                                      (see SWEEP_SPEC_pubreq.md in the bot
//                                                      wave-7 scratch).
//     -> 200 { ok: true, applied: false, reason: "already_public" }
//                                                   — nothing to do.
//
// Why this endpoint exists: the bot's drive:pubreq: handler used to
// log pending_public to the KV submissions log only, and the owner
// monitor (/libraries/monitor) reads D1 only — so a make-public
// request NEVER appeared in the owner queue (and the monitor link in
// the owner DM carried the submitter's fingerprint, which 403s — the
// monitor requires the owner's). The bot now POSTs here first
// (best-effort — the KV log + owner DM remain the durable record),
// and the DM link carries the owner's fingerprint (bot-side fix).
//
// Auth (fail closed, no new secret): the caller must present the
// tg-search shared secret `TG_SEARCH_BOT_KEY` as header
// `x-rlibook-bot-key` — the same secret the bot already sends to
// /api/tg-search, already set on the bot Worker and on Pages. A
// missing secret on either side is a 503, never an open door. The
// submitter is then verified by fingerprint against the shared KV
// (fp:<token> -> { tg_id }, same lookup as drive-libraries.js), and
// D1 ownership is checked: only the library's submitter (or the
// owner) may request publication.
//
// Data: D1 `drive_libraries` (registry). One SELECT + at most one
// UPDATE per request — no search, no counts, far inside the free
// D1 read budget. The monitor's approve/reject is unchanged and
// still the only path that makes a library public or rejects it.
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
    // Not indexed yet — the sweep owns this case (it indexes the
    // folder from the KV submissions log, then flips it).
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
  if (visibility === "public") {
    return json({ ok: true, applied: false, reason: "already_public" });
  }
  if (visibility === "pending_public") {
    return json({ ok: true, applied: true, already: true });
  }
  if (visibility !== "private") {
    return json({ ok: true, applied: false, reason: "unexpected_visibility" });
  }
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  try {
    // Guard the UPDATE with the expected current visibility so a
    // concurrent approve cannot be overwritten back to pending.
    const res = await db
      .prepare(
        "UPDATE drive_libraries SET visibility = 'pending_public', requested_at = ?" +
          " WHERE folder_id = ? AND visibility = 'private'",
      )
      .bind(now, folderId)
      .run();
    const changed = res && res.meta && typeof res.meta.changes === "number" ? res.meta.changes : 1;
    if (changed === 0) {
      // Lost a race with the monitor (approved/rejected between the
      // SELECT and the UPDATE): re-read and report the true state.
      const cur = await db
        .prepare("SELECT visibility FROM drive_libraries WHERE folder_id = ?")
        .bind(folderId)
        .first();
      const curVis = cur ? String(cur.visibility || "").toLowerCase() : "";
      if (curVis === "pending_public") return json({ ok: true, applied: true, already: true });
      if (curVis === "public") return json({ ok: true, applied: false, reason: "already_public" });
      return json({ ok: false, error: "concurrent update" }, 409);
    }
  } catch (e) {
    return json({ ok: false, error: "update failed" }, 503);
  }
  return json({ ok: true, applied: true });
}
