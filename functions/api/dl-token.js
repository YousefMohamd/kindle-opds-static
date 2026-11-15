// Cloudflare Pages Function: Block 2 download-token issuer (RliBook).
// Route: GET /api/dl-token?h=<handle>&p=<post_id>&f=<format>
//        (Telegram books, legacy form — no lib needed)
//        GET /api/dl-token?lib=<slug>&id=<book id>&f=<format>
//        (OPDS books — khazendar / sahwa / electronic / hindawi / doab)
//        GET /api/dl-token?lib=tg&h=<handle>&p=<post_id>&f=<format>
//
//   GET /api/dl-token?h=khazendar&p=12345&f=epub
//     -> 200 { ok: true, token: "v1....", exp: 179..., ttl: 600,
//              url: "https://<proxy>/dl?h=khazendar&p=12345&f=epub&t=v1....",
//              short: "/k/Ab3dEf9hJk2mNn4p" }
//   GET /api/dl-token?lib=hindawi&id=13028368&f=epub
//     -> 200 { ok: true, token: "v1....", exp: ..., ttl: 600,
//              url: null, short: "/k/..." }
//        (url is null for OPDS books: the Block 2 proxy verifies
//        tokens for Telegram posts only (its verify_token requires a
//        numeric post id), so there is no signed proxy URL for an
//        OPDS book yet. The `short` link IS the OPDS download path:
//        /k/<code> redirects to the book's public acquisition URL
//        (Drive / Hindawi / DOAB — the same public source the OPDS
//        feed already links to). A proxy change to accept lib:id
//        tokens is a separate proxy-repo task, not this file.)
//
// The token is the SAME scheme the download proxy verifies
// (rlibook-download-proxy/app/tokens.py, v1):
//   payload = {"exp":N,"f":"epub","h":"khazendar","p":12345}
//     — JSON, sorted keys, no spaces —
//   token = "v1." + base64url(payload_json)
//                + "." + base64url(HMAC-SHA256(PROXY_SIGNING_KEY, payload_b64))
// The proxy checks shape, signature, exact (h, p, f) match and expiry.
// A token is single-book: it cannot be reused for another channel,
// post or format. For OPDS books p is the book id STRING
// ({"h":"hindawi","p":"13028368"}) — same HMAC, same format; the
// proxy does not accept that form yet (see above).
//
// Flag gate — read this before wiring the button:
//   * If env.RLIBOOK_KV is bound, a KV key `flag:<handle>:<post_id>`
//     means the book IS flagged/commercial -> 403, no token.
//     (Block 7 populates those keys; the bot's flags.ts list is the
//     source of truth for which titles are flagged.)
//   * If the KV binding is missing, a token IS issued. That is the
//     honest v1 limit: there is no flag feed yet, so "not flagged"
//     currently means "not on the denylist". OPDS books (PD/CC
//     libraries) are never flagged.
//   * If the KV binding EXISTS but the flag lookup throws (KV
//     outage), the check fails CLOSED for Telegram books (403) —
//     a KV outage must never mint a token for a book that might be
//     flagged. OPDS books are unaffected (never flagged).
//   * The issuer does NOT prove the book exists, and does NOT prove
//     it is public-domain / CC. Do NOT present it as a completed
//     legal check.
//
// Mint caps (Kindle delivery, design §4.3 — same overLimit pattern
// as functions/api/send-to-kindle.js, same accepted KV race):
//   * 20 tokens/day per IP (all minting).
//   * 20 tokens/day per fingerprint (fp present — a catalog user).
//   * 5 tokens/day per IP when anonymous (no fp) — the bulk-scraping
//     vector is anonymous minting, so the anonymous budget is the
//     tight one. A refused mint (flag / not configured) never burns
//     quota: caps are checked AFTER validation, flag and config.
//   * No KV binding -> caps fail open (mint, count nothing), so a
//     missing KV binding never locks out legitimate users. Abuse in
//     that state is bounded by the 10-minute token life and the
//     proxy's own 30/min per-IP limit.
//
// Short links: a minted token also writes `k:<code>` in KV (10-min
// TTL) pointing at the download target, and the response carries
// `short: "/k/<code>"`. The delivery page (/kindle/get) shows that
// short link. No KV binding -> short is null (the token + url are
// still returned). The code is random (16 chars); it carries no part
// of the token, so nothing secret ever appears in a URL or a log.
//
// Env (Pages dashboard -> Settings -> Functions -> Environment variables;
// secrets, never in the repo, never in chat):
//   PROXY_SIGNING_KEY   (required) — the SAME value as the proxy's
//                         secret. Generate once (openssl rand -hex 32)
//                         and reuse it for both sides.
//   PROXY_BASE_URL      (required for Telegram books) — e.g.
//                         https://rlibook-download.injectcloud.space
//                         Unset -> Telegram minting is 503;
//                         OPDS minting is unaffected (its target is
//                         the public acquisition URL).
//   PROXY_TOKEN_TTL_SECONDS (optional, default 600, clamped 60..3600)
// KV binding (optional, same namespace the bot + OPDS feed use):
//   RLIBOOK_KV — flag denylist keys `flag:<handle>:<post_id>`,
//                mint counters `dlt:*:<YYYY-MM-DD>`,
//                short links `k:<code>`.
//
// Free-tier friendly: 1 KV get for the flag check + up to 2 counter
// ops + 1 short-link write per mint, no catalog fetch, no heavy work.
// Zero D1 writes.

const ALLOWED_FORMATS = new Set(["epub", "pdf", "mobi", "azw3", "kfx", "txt"]);
const DEFAULT_TTL_SECONDS = 600;
const SHORT_TTL_SECONDS = 600;
export const MINT_CAP_PER_IP = 20;
export const MINT_CAP_ANONYMOUS = 5;
export const MINT_CAP_FINGERPRINTED = 20;

// OPDS libraries — MIRRORED from functions/api/send-to-kindle.js
// (LIBS + resolveAcquisitionUrl). send-to-kindle.js is frozen (the
// email fallback is unchanged), so this file keeps its own copy;
// if a library is added there, add it here too. The id rules below
// are the same validation send-to-kindle.js applies before fetching.
export const OPDS_LIBS = {
  khazendar: { kind: "drive", label: "خازندار" },
  sahwa: { kind: "drive", label: "مكتبة صحوه" },
  electronic: { kind: "drive", label: "المكتبة الإلكترونية" },
  hindawi: { kind: "hindawi", label: "هنداوي" },
  doab: { kind: "doab", label: "DOAB" },
};

function opdsIdOk(kind, id) {
  if (kind === "drive") return /^[A-Za-z0-9_-]{10,80}$/.test(id);
  if (kind === "hindawi") return /^\d{1,12}$/.test(id);
  // doab: the id IS the full file URL (from the search index).
  return id.length <= 2048 && /^https:\/\/[^\s]+$/.test(id);
}

/** Where an OPDS book file comes from — the same acquisition URLs as
 *  functions/api/send-to-kindle.js resolveAcquisitionUrl: Drive
 *  download, Hindawi EPUB, or the DOAB URL. Returns null for a bad
 *  lib/id. Exported so /kindle/get and /read share it. */
export function resolveOpdsAcquisitionUrl(lib, id) {
  const l = OPDS_LIBS[lib];
  if (!l || !id) return null;
  if (l.kind === "drive") {
    if (!/^[A-Za-z0-9_-]{10,80}$/.test(id)) return null;
    return "https://drive.google.com/uc?id=" + id + "&export=download";
  }
  if (l.kind === "hindawi") {
    if (!/^\d{1,12}$/.test(id)) return null;
    return "https://www.hindawi.org/books/" + id + ".epub";
  }
  if (id.length > 2048 || !/^https:\/\/[^\s]+$/.test(id)) return null;
  return id;
}

function b64urlEncode(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function normalizeHandle(handle) {
  return (handle || "").trim().replace(/^@+/, "").toLowerCase();
}

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export async function makeToken(signingKey, handle, postId, fmt, ttlSeconds, nowSeconds) {
  const exp = nowSeconds + ttlSeconds;
  // Sorted keys, no spaces — byte-identical to Python
  // json.dumps(payload, separators=(",", ":"), sort_keys=True).
  // p is a NUMBER for Telegram books (proxy-verified, byte-identical
  // to the old form) and a STRING for OPDS books (the book id).
  const pJson = typeof postId === "number" ? String(postId) : JSON.stringify(postId);
  const payloadJson = `{"exp":${exp},"f":${JSON.stringify(fmt)},"h":${JSON.stringify(handle)},"p":${pJson}}`;
  const payloadB64 = b64urlEncode(new TextEncoder().encode(payloadJson));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payloadB64),
  );
  return `v1.${payloadB64}.${b64urlEncode(new Uint8Array(sig))}`;
}

/** Validate book identity from query params. Two forms, plus the
 *  legacy Telegram form (h+p with no lib — the originally documented
 *  /api/dl-token route, kept working):
 *    lib=tg & h=<handle> & p=<post_id>   -> { kind: "tg", handle, postId, fmt }
 *    h=<handle> & p=<post_id> (no lib)   -> same (legacy)
 *    lib=<opds slug> & id=<book id>      -> { kind: "opds", lib, id, fmt }
 *  `defaultFormat` fills in a missing f= (the delivery page and the
 *  reader default to epub); without it a missing/invalid f is
 *  bad_format. Returns { ok: false, error } on the first bad field.
 *  Exported for /kindle/get and /read, which validate identically. */
export function parseBookParams(params, opts = {}) {
  const lib = (params.get("lib") || "").trim().toLowerCase();
  const fmtRaw = (params.get("f") || "").trim().toLowerCase();
  const fmt = fmtRaw || (opts.defaultFormat || "");
  if (!ALLOWED_FORMATS.has(fmt)) {
    return { ok: false, error: "bad_format" };
  }
  const isTg = lib === "tg" || (!lib && (params.get("h") || params.get("p")));
  if (isTg) {
    const handle = normalizeHandle(params.get("h"));
    const postRaw = (params.get("p") || "").trim();
    if (!/^[a-z0-9_]{3,64}$/.test(handle)) {
      return { ok: false, error: "bad_handle" };
    }
    if (!/^\d{1,10}$/.test(postRaw)) {
      return { ok: false, error: "bad_post_id" };
    }
    const postId = Number(postRaw);
    if (!Number.isSafeInteger(postId) || postId < 1) {
      return { ok: false, error: "bad_post_id" };
    }
    return { ok: true, kind: "tg", handle, postId, fmt };
  }
  const libInfo = OPDS_LIBS[lib];
  if (!libInfo) {
    return { ok: false, error: "bad_lib" };
  }
  const id = (params.get("id") || "").trim();
  if (!id || !opdsIdOk(libInfo.kind, id)) {
    return { ok: false, error: "bad_id" };
  }
  return { ok: true, kind: "opds", lib, id, fmt };
}

/** Flag-denylist check for one Telegram book. True = flagged, no
 *  token. No KV binding -> false (no denylist configured, the v1
 *  posture). A KV error -> TRUE (fail closed: an outage must never
 *  mint a token for a book that might be flagged). OPDS books are
 *  never flagged and never reach this function. */
export async function isFlaggedBook(env, handle, postId) {
  if (!env.RLIBOOK_KV) return false;
  try {
    const v = await env.RLIBOOK_KV.get(`flag:${handle}:${postId}`);
    return v !== null && v !== undefined;
  } catch {
    return true;
  }
}

function counterKey(key) {
  return "dlt:" + key + ":" + new Date().toISOString().slice(0, 10);
}

function sanitizeIp(ip) {
  return (ip || "unknown").trim().slice(0, 64).replace(/[^A-Za-z0-9.:-]/g, "_");
}

/** One mint counter: { over, counted }. Same pattern as
 *  send-to-kindle.js overLimit — a corrupt value counts as 0, and
 *  the KV race (two requests in the same millisecond both passing)
 *  is accepted because the daily caps bound the damage. */
async function takeCounter(kv, key, limit) {
  const fullKey = counterKey(key);
  let cur = Number((await kv.get(fullKey)) || "0");
  if (!Number.isFinite(cur) || cur < 0) cur = 0;
  if (cur >= limit) return { over: true, counted: false };
  await kv.put(fullKey, String(cur + 1), { expirationTtl: 86400 });
  return { over: false, counted: true };
}

async function refundCounter(kv, key) {
  try {
    const fullKey = counterKey(key);
    const cur = Number((await kv.get(fullKey)) || "0");
    if (Number.isFinite(cur) && cur > 0) {
      await kv.put(fullKey, String(cur - 1), { expirationTtl: 86400 });
    }
  } catch { /* best-effort */ }
}

function clampTtl(env) {
  let ttl = Number(env.PROXY_TOKEN_TTL_SECONDS || DEFAULT_TTL_SECONDS);
  if (!Number.isFinite(ttl)) ttl = DEFAULT_TTL_SECONDS;
  return Math.max(60, Math.min(3600, Math.floor(ttl)));
}

/** Mint a download token for one parsed book. The single minting
 *  implementation shared by GET /api/dl-token and the delivery page
 *  (/kindle/get). Order matters: config and flag refusals happen
 *  BEFORE any counter is taken, so a refused mint never burns quota.
 *  `opts.ip` is the client IP (cf-connecting-ip); `opts.fp` is the
 *  catalog fingerprint when present (a fingerprinted user gets the
 *  generous 20/day budget, an anonymous IP gets 5/day).
 *  Returns { ok: true, token, exp, ttl, url } or
 *  { ok: false, status, error } with error one of: not_configured,
 *  proxy_not_configured, flagged, mint_cap_ip, mint_cap_user.
 *  `url` is the signed proxy URL for Telegram books (null when the
 *  proxy base is unset — impossible here, that is proxy_not_configured)
 *  and null for OPDS books (see the file header: no proxy URL exists
 *  for OPDS yet; the short link is the OPDS download path). */
export async function mintTokenForBook(env, book, opts = {}) {
  const signingKey = (env.PROXY_SIGNING_KEY || "").trim();
  if (!signingKey) {
    return { ok: false, status: 503, error: "not_configured" };
  }
  const base = (env.PROXY_BASE_URL || "").trim().replace(/\/+$/, "");
  if (book.kind === "tg" && !base) {
    return { ok: false, status: 503, error: "proxy_not_configured" };
  }
  if (book.kind === "tg" && (await isFlaggedBook(env, book.handle, book.postId))) {
    return { ok: false, status: 403, error: "flagged" };
  }

  const ttl = clampTtl(env);
  const now = Math.floor(Date.now() / 1000);

  // Mint caps — KV-bound only; without KV they fail open (mint,
  // count nothing). The IP cap is checked first; if the user cap
  // then refuses, the IP count is refunded.
  let ipKey = null;
  let ipCounted = false;
  if (env.RLIBOOK_KV) {
    const ip = sanitizeIp(opts.ip);
    ipKey = "ip:" + ip;
    try {
      const ipCheck = await takeCounter(env.RLIBOOK_KV, ipKey, MINT_CAP_PER_IP);
      if (ipCheck.over) {
        return { ok: false, status: 429, error: "mint_cap_ip" };
      }
      ipCounted = ipCheck.counted;
      const fp = (opts.fp || "").trim().slice(0, 128);
      const userKey = fp ? "fp:" + fp : "anon:" + ip;
      const userLimit = fp ? MINT_CAP_FINGERPRINTED : MINT_CAP_ANONYMOUS;
      const userCheck = await takeCounter(env.RLIBOOK_KV, userKey, userLimit);
      if (userCheck.over) {
        if (ipCounted) await refundCounter(env.RLIBOOK_KV, ipKey);
        return { ok: false, status: 429, error: "mint_cap_user" };
      }
    } catch {
      // KV hiccup mid-count: fail open, mint the token, count nothing.
    }
  }

  const handle = book.kind === "tg" ? book.handle : book.lib;
  const postId = book.kind === "tg" ? book.postId : book.id;
  const token = await makeToken(signingKey, handle, postId, book.fmt, ttl, now);
  const exp = now + ttl;
  const dlUrl = book.kind === "tg"
    ? `${base}/dl?h=${encodeURIComponent(handle)}&p=${postId}&f=${encodeURIComponent(book.fmt)}&t=${encodeURIComponent(token)}`
    : null;
  return { ok: true, token, exp, ttl, url: dlUrl };
}

const SHORT_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** A random 16-char short-link code. Random, not derived from the
 *  token — no part of the token ever appears in a URL or a log. */
export function makeShortCode() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let code = "";
  for (const b of bytes) code += SHORT_ALPHABET[b % SHORT_ALPHABET.length];
  return code;
}

/** Store a short-link entry: `k:<code>` -> { v: 1, url, exp } with a
 *  10-minute TTL (the entry dies on its own; the token inside the
 *  target URL also expires). Returns true when stored. */
export async function storeShortLink(env, code, targetUrl, exp) {
  if (!env.RLIBOOK_KV) return false;
  try {
    await env.RLIBOOK_KV.put("k:" + code,
      JSON.stringify({ v: 1, url: targetUrl, exp }),
      { expirationTtl: SHORT_TTL_SECONDS });
    return true;
  } catch {
    return false;
  }
}

/** Resolve a short code to its target, or null when unknown, expired
 *  or malformed. Expired entries are null even if KV has not evicted
 *  them yet (the TTL deletes them within 10 minutes anyway). */
export async function resolveShortLink(env, code) {
  if (!env.RLIBOOK_KV) return null;
  let entry = null;
  try {
    entry = await env.RLIBOOK_KV.get("k:" + code, "json");
  } catch {
    return null;
  }
  if (!entry || entry.v !== 1 || typeof entry.url !== "string" || !entry.url) return null;
  if (!Number.isFinite(entry.exp) || entry.exp * 1000 <= Date.now()) return null;
  return { url: entry.url, exp: entry.exp };
}

/** Build the short link for a freshly minted token: the download
 *  target is the signed proxy URL for Telegram books and the public
 *  acquisition URL for OPDS books. Returns "/k/<code>" or null when
 *  there is no KV binding, no target, or the store failed — in which
 *  case the caller falls back to showing the target URL itself. */
export async function issueShortLink(env, book, mintResult) {
  if (!env.RLIBOOK_KV) return null;
  const target = book.kind === "tg"
    ? mintResult.url
    : resolveOpdsAcquisitionUrl(book.lib, book.id);
  if (!target) return null;
  const code = makeShortCode();
  if (!(await storeShortLink(env, code, target, mintResult.exp))) return null;
  return "/k/" + code;
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "GET") {
    return json(405, { ok: false, error: "method_not_allowed" });
  }

  const url = new URL(request.url);
  const book = parseBookParams(url.searchParams);
  if (!book.ok) {
    return json(400, { ok: false, error: book.error });
  }

  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const fp = (url.searchParams.get("fp") || "").trim();
  const result = await mintTokenForBook(env, book, { ip, fp });
  if (!result.ok) {
    return json(result.status, { ok: false, error: result.error });
  }

  const short = await issueShortLink(env, book, result);
  return json(200, {
    ok: true,
    token: result.token,
    exp: result.exp,
    ttl: result.ttl,
    url: result.url,
    short,
  });
}
