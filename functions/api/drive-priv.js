// Cloudflare Pages Function: Drive make-private (RliBook, Drive UX redesign).
// Route: POST /api/drive-priv
//
//   POST /api/drive-priv  { folder_id, fp }
//     -> 200 { ok: true, applied: true }            — D1 visibility is now 'private'
//     -> 200 { ok: true, applied: true, already: true }
//                                                   — it was already private (idempotent)
//     -> 200 { ok: true, applied: false, reason: "not_indexed" }
//                                                   — no D1 row yet: the library was never
//                                                      indexed. The bot keeps the KV-log
//                                                      record; the sweep owns this case
//                                                      (a newest "sync_requested" /
//                                                      "pending_index" record indexes it
//                                                      as private by default).
//     -> 200 { ok: true, applied: false, reason: "unexpected_visibility" }
//                                                   — the row is in a state this endpoint
//                                                      does not flip (removed /
//                                                      unavailable / anything else).
//
// Why this endpoint exists: the /mylibraries "make private" button
// (the reverse of make-public) must land in the D1 registry — D1 is
// the source of truth every surface reads (website search, OPDS,
// the libraries page, the mint/send gates). The bot POSTs here first
// (best-effort — the KV log remains the durable record). This is the
// exact mirror of /api/drive-pubreq (same auth, same response shape,
// same guarded-UPDATE pattern); only the target visibility and the
// allowed source states differ.
//
// Auth (fail closed, no new secret): the caller must present the
// tg-search shared secret `TG_SEARCH_BOT_KEY` as header
// `x-rlibook-bot-key` — the same secret the bot already sends to
// /api/tg-search, already set on the bot Worker and on Pages. A
// missing secret on either side is a 503, never an open door. The
// submitter is then verified by fingerprint against the shared KV
// (fp:<token> -> { tg_id }, same lookup as drive-libraries.js), and
// D1 ownership is checked: only the library's submitter (or the
// owner) may make it private.
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
    // Not indexed yet — nothing to demote. A newest
    // "pending_index" / "sync_requested" record is indexed as
    // private by default, so the library lands private anyway.
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
  if (visibility === "private") {
    return json({ ok: true, applied: true, already: true });
  }
  if (visibility !== "public" && visibility !== "pending_public") {
    return json({ ok: true, applied: false, reason: "unexpected_visibility" });
  }
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  try {
    // Guard the UPDATE with the expected live visibilities so a
    // concurrent remove (or approve) cannot be overwritten back
    // to private. A concurrent approve (pending_public -> public)
    // still matches the guard and is made private anyway — the
    // demoter's intent is the newest.
    const res = await db
      .prepare(
        "UPDATE drive_libraries SET visibility = 'private', reviewed_at = ?" +
          " WHERE folder_id = ? AND visibility IN ('public', 'pending_public')",
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
      if (curVis === "private") return json({ ok: true, applied: true, already: true });
      return json({ ok: false, error: "concurrent update" }, 409);
    }
  } catch (e) {
    return json({ ok: false, error: "update failed" }, 503);
  }
  return json({ ok: true, applied: true });
}
