// Cloudflare Pages Function: website identity (RliBook, auto-recognition).
// Route: GET /api/identify[?fp=<fingerprint> | ?code=<6-digit code>]
//
//   GET /api/identify?fp=<fp>
//     -> 200 JSON { ok:true, linked:true, email_masked:"mo***@kindle.com" }
//        (or email_masked:null when the fingerprint is valid but the user
//        never linked a Kindle email in the bot yet).
//   GET /api/identify?code=<code>
//     -> the same, after exchanging the one-time /link code for the
//        fingerprint (the code is deleted on use; a second use fails).
//   GET /api/identify
//     -> reads the rlb_fp cookie set by an earlier visit and returns
//        the same linked state (or { ok:true, linked:false }).
//
// WHY THIS EXISTS (Kindle auto-recognition, 2026-11-20): the user links
// their Kindle email ONCE in the Telegram bot; the bot stores it in KV
// (kindle_email:<tg_id>) keyed by the fingerprint (fp:<token> ->
// {"tg_id": N}). The personal catalog file carries the fingerprint in
// its website links (?fp=), so the FIRST visit from the catalog
// auto-links the website: this endpoint verifies the fingerprint
// against KV (Pages has no CATALOG_SECRET env var, so the HMAC cannot
// be re-checked here — the KV registry IS the verification: a
// fingerprint is valid only while its fp:<token> key exists, and the
// owner can revoke it from the bot), looks up the Kindle email, and
// sets a cookie (rlb_fp) on the Kindle browser. Later visits use the
// cookie — no re-ask. A direct visit without a cookie returns
// linked:false and the homepage shows the "link your account" box
// (open the catalog and tap the website link, or get a code from the
// bot with /link).
//
// PROTECTION (read-only identity): this endpoint NEVER sets or changes
// a Kindle email — it only reads the address the bot already stored.
// Changing the linked email needs the bot. The fingerprint only
// identifies the user for READING (prefill the email, show their
// books); it can only ever send books TO the owner's own Kindle
// email, never to anyone else's. A stolen fingerprint is bounded by
// the existing rate limits (5 downloads/day, email cap) and the owner
// can revoke/rotate it from the bot (new salt = new fingerprint, the
// old fp:<token> key is deleted).
//
// The 6-digit /link code is brute-forceable in principle (900k codes,
// 10-minute life), so code attempts are rate-limited per IP: 10
// attempts per 10 minutes (KV counter linkcode:attempt:<ip>, TTL
// 600s). Fingerprint and cookie checks are NOT rate-limited (a
// 22-char HMAC is unguessable; the cookie check is per-user).
//
// Env (Pages dashboard -> Settings -> Functions; secrets, never in repo):
//   RLIBOOK_KV (required) — the SAME KV namespace the bot uses.
//                Needed for the fp/code lookups. Without it the
//                endpoint refuses (503).
// No other env is needed: no email provider, no proxy, no secret.

// Cookie that remembers the linked fingerprint on the reader's browser.
// One year; HttpOnly so page JS cannot read the token (the homepage
// learns the linked state from this endpoint's JSON, never from the
// cookie value). No Secure flag: the old Kindle browser may mishandle
// it, and the site is HTTPS-only via Cloudflare anyway.
export const COOKIE_NAME = "rlb_fp";
export const COOKIE_MAX_AGE = 365 * 24 * 3600;

// Code-attempt rate limit: 10 attempts per IP per 10 minutes.
export const CODE_ATTEMPT_LIMIT = 10;
export const CODE_ATTEMPT_TTL_SECONDS = 600;

export function maskEmail(email) {
  const at = String(email || "").indexOf("@");
  if (at <= 0) return null;
  const local = String(email).slice(0, at);
  const domain = String(email).slice(at + 1);
  const shown = local.length >= 2 ? local.slice(0, 2) : "";
  return shown + "***@" + domain;
}

export function cookieHeader(fp) {
  return COOKIE_NAME + "=" + encodeURIComponent(fp)
    + "; Path=/; Max-Age=" + COOKIE_MAX_AGE + "; SameSite=Lax; HttpOnly";
}

export function clearCookieHeader() {
  return COOKIE_NAME + "=; Path=/; Max-Age=0; HttpOnly";
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

// Resolve a fingerprint to { tg_id, email } — null when the
// fingerprint is unknown/revoked. The email is null when the user
// never linked one in the bot yet.
async function resolveFp(env, fp) {
  if (!fp || fp.length > 128) return null;
  let rec = null;
  try {
    rec = await env.RLIBOOK_KV.get("fp:" + fp, "json");
  } catch { rec = null; }
  const tgId = rec && Number.isSafeInteger(rec.tg_id) ? rec.tg_id : null;
  if (!tgId) return null;
  let email = null;
  try {
    email = await env.RLIBOOK_KV.get("kindle_email:" + tgId);
  } catch { email = null; }
  return { tg_id: tgId, email: email && typeof email === "string" ? email.trim() : null };
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "GET") {
    return json({ ok: false, error: "E_METHOD" }, 405);
  }
  if (!env.RLIBOOK_KV) {
    return json({ ok: false, error: "E_NO_KV" }, 503);
  }
  const url = new URL(request.url);
  const fpParam = (url.searchParams.get("fp") || "").trim();
  const codeParam = (url.searchParams.get("code") || "").trim();

  // ---- one-time /link code ------------------------------------------
  if (codeParam) {
    if (!/^\d{6}$/.test(codeParam)) {
      return json({ ok: false, error: "E_BAD_CODE" }, 400);
    }
    // Rate-limit code attempts per IP (brute-force guard).
    const ip = (request.headers.get("CF-Connecting-IP") || "unknown").trim().slice(0, 64);
    const attemptKey = "linkcode:attempt:" + ip;
    let attempts = 0;
    try {
      attempts = Number(await env.RLIBOOK_KV.get(attemptKey)) || 0;
    } catch { attempts = 0; }
    if (attempts >= CODE_ATTEMPT_LIMIT) {
      return json({ ok: false, error: "E_TOO_MANY_ATTEMPTS" }, 429);
    }
    try {
      await env.RLIBOOK_KV.put(attemptKey, String(attempts + 1), { expirationTtl: CODE_ATTEMPT_TTL_SECONDS });
    } catch { /* best-effort */ }
    let rec = null;
    try {
      rec = await env.RLIBOOK_KV.get("linkcode:" + codeParam, "json");
    } catch { rec = null; }
    const fp = rec && typeof rec.fp === "string" ? rec.fp : null;
    const tgId = rec && Number.isSafeInteger(rec.tg_id) ? rec.tg_id : null;
    if (!fp || !tgId) {
      return json({ ok: false, error: "E_BAD_CODE" }, 400);
    }
    // One-time use: delete the code before answering.
    try { await env.RLIBOOK_KV.delete("linkcode:" + codeParam); } catch { /* best-effort */ }
    const resolved = await resolveFp(env, fp);
    if (!resolved) {
      return json({ ok: false, error: "E_BAD_CODE" }, 400);
    }
    return json(
      { ok: true, linked: true, email_masked: resolved.email ? maskEmail(resolved.email) : null },
      200,
      { "set-cookie": cookieHeader(fp) },
    );
  }

  // ---- fingerprint (catalog link, or the cookie) ----------------------
  let fp = fpParam;
  if (!fp) {
    fp = (parseCookies(request.headers.get("Cookie") || "")[COOKIE_NAME] || "").trim();
  }
  if (!fp) {
    return json({ ok: true, linked: false });
  }
  const resolved = await resolveFp(env, fp);
  if (!resolved) {
    // A revoked/unknown fingerprint: not linked — and clear a stale
    // cookie so the browser stops sending it.
    const headers = {};
    if (!fpParam) headers["set-cookie"] = clearCookieHeader();
    return json({ ok: true, linked: false }, 200, headers);
  }
  return json(
    { ok: true, linked: true, email_masked: resolved.email ? maskEmail(resolved.email) : null },
    200,
    { "set-cookie": cookieHeader(fp) },
  );
}
