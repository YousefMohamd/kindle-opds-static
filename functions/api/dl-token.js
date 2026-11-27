// Cloudflare Pages Function: Block 2 download-token issuer (RliBook).
// Route: GET /api/dl-token?h=<handle>&p=<post_id>&f=<format>
//        (Telegram books, legacy form — no lib needed)
//        GET /api/dl-token?lib=<slug>&id=<book id>&f=<format>
//        (OPDS books — khazendar / sahwa / electronic / hindawi / doab / drive)
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
//     means the book IS flagged -> 403, no token.
//     (Block 7 populates those keys; the bot's flags.ts list is the
//     source of truth for which titles are flagged.)
//   * Drive-kind OPDS books (lib=drive, khazendar, sahwa,
//     electronic — WAVE 7 follow-up A2) use the same gate with the
//     Drive key `flag:drive:<fileId>` (the key tg-search.js flags
//     Drive rows with and send-to-kindle.js checks for lib=drive).
//     The flag is on the Drive FILE, not the library that listed
//     it, so one key covers the same file under any drive-kind lib.
//     Hindawi / DOAB (PD/CC libraries) are never flagged.
//   * If the KV binding is missing, a token IS issued. That is the
//     honest v1 limit: there is no flag feed yet, so "not flagged"
//     currently means "not on the denylist".
//   * If the KV binding EXISTS but the flag lookup throws (KV
//     outage), the check fails CLOSED for Telegram AND drive-kind
//     books (403) — a KV outage must never mint a token for a book
//     that might be flagged. Hindawi / DOAB are unaffected (never
//     flagged).
//   * The issuer does NOT prove the book exists, and does NOT prove
//     it is public-domain / CC. Do NOT present it as a completed
//     legal check.
//
// Hidden gate (owner-only /hide, Workstream 2b): a KV key
// `hidden:<handle>:<post_id>` (set by the owner's /hide in the
// bot, or a manual KV put) means the book was REMOVED -> 403
// "hidden", no token. This is checked AFTER the flag gate and
// BEFORE any counter is taken (a refused mint never burns quota).
// Hidden is NOT flagged: a flagged book still mints nothing
// either (403 "flagged"), but the two refusals are distinct —
// flagged books are shown with 🚩 and the bot points at the source
// channel; hidden books are removed from search entirely. Like
// the flag check, a KV outage fails CLOSED for Telegram books.
// OPDS books are never hidden (they have no post identity to
// report). User reports NEVER hide: an approved report sets
// `flag:` instead — the hidden key is owner-only.
//
// Drive visibility gate (WAVE 7 follow-up A4): a private/pending
// Drive library's book mints ONLY for its submitter (pending: +
// the owner) — 403 "private_library", no token, no quota burned.
// Same lookup and rule as the serve-side gate in
// send-to-kindle.js / read.js (driveBookLibrary + driveLibraryAllows,
// shared from this file), because the /k/ short link bypasses the
// serve side entirely. Public / legacy (no registry row) /
// unindexed file ids mint unchanged (fail open on no D1 / D1 error).
// A caller with no fingerprint has no identity and is refused a
// private book; the viewer id comes from opts.fp via
// viewerTgIdFromFp (mirrors drive-libraries.js verifyFingerprint).
//
// Mint caps (Kindle delivery, design §4.3 — same overLimit pattern
// as functions/api/send-to-kindle.js, same accepted KV race):
//   * 5 tokens/day per IP (all minting).
//   * 5 tokens/day per fingerprint (fp present — a catalog user).
//   * 5 tokens/day per IP when anonymous (no fp).
//   The download cap is 5 books/day per user (2026-11-16: the
//   primary Kindle path is now Send-to-Kindle by email, which is
//   unlimited; the download path is the secondary route for
//   phone/computer users, capped at 5/day). A refused mint (flag /
//   hidden / not configured) never burns quota: caps are checked
//   AFTER validation, flag, hidden and config.
//   * No KV binding -> caps fail open (mint, count nothing), so a
//     missing KV binding never locks out legitimate users. Abuse in
//     that state is bounded by the 10-minute token life and the
//     proxy's own 30/min per-IP limit.
//
// Service-key exemption (E_LIMIT Option A, 2026-11-26): the bot
//   Worker mints from ONE shared egress IP, so the per-IP counter
//   above caps ALL bot deliveries at 5/day total across all users
//   (the per-fingerprint cap can never bind first for bot traffic).
//   A request carrying `Authorization: Bearer <DL_TOKEN_SERVICE_KEY>`
//   that matches the Pages secret EXACTLY (constant-time compare)
//   skips the per-IP counter only and is still counted against the
//   acting user's fingerprint cap (5/day) — the flag and hidden
//   gates still run first, unchanged. A wrong or missing key, or
//   an unset secret, falls through to the normal IP-counted path
//   (fail closed, no bypass, no error leak). Service-key mints are
//   counted best-effort in `dlt:svc:<YYYY-MM-DD>` for observability
//   only — that counter never refuses a mint. The bot is the only
//   caller that sends the header; browser / Mini App mints never
//   carry it and are unaffected.
//
// Short links: a minted token also writes `k:<code>` in KV (10-min
// TTL) pointing at the download target, and the response carries
// `short: "/k/<code>"`. The delivery page (/kindle/get) shows that
// short link. No KV binding -> short is null (the token + url are
// still returned). The code is random (16 chars); it carries no part
// of the token, so nothing secret ever appears in a URL or a log.
// SINGLE-USE (2026-11-16, reversal of D5): the /k/ resolver deletes
// the entry on first successful resolve (resolveAndConsumeShortLink),
// so a replay 404s. A failed first tap burns the link; the user
// mints a fresh one (1 of 5/day). The raw signed proxy URL inside
// the target stays replayable within its 10 minutes — closing that
// needs a proxy-repo change; the short link is the only link users
// ever see, so consuming it closes the realistic replay path.
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
//   DL_TOKEN_SERVICE_KEY (optional — E_LIMIT Option A, 2026-11-26)
//                         the shared service secret the bot Worker
//                         sends as `Authorization: Bearer <key>` on
//                         dl-token mints. Same value must be set as
//                         the bot Worker secret. Unset = the
//                         exemption never triggers (normal IP-counted
//                         path for every caller). Generate once
//                         (openssl rand -hex 32); never in the repo,
//                         never in chat.
//   PROXY_TOKEN_TTL_SECONDS (optional, default 600, clamped 60..3600)
// KV binding (optional, same namespace the bot + OPDS feed use):
//   RLIBOOK_KV — flag denylist keys `flag:<handle>:<post_id>`,
//                hidden keys `hidden:<handle>:<post_id>` (owner
//                /hide only — never set by user reports),
//                mint counters `dlt:*:<YYYY-MM-DD>`,
//                short links `k:<code>`.
//
// Free-tier friendly: 1 KV get for the flag check (Telegram books
// and drive-kind OPDS books — 1 get either way, never both) + 1 for
// the hidden check + up to 2 counter ops + 1 short-link write per
// mint, no catalog fetch, no heavy work. Zero D1 writes.

const ALLOWED_FORMATS = new Set(["epub", "pdf", "mobi", "azw3", "kfx", "txt", "doc", "docx"]);
const DEFAULT_TTL_SECONDS = 600;
const SHORT_TTL_SECONDS = 600;
// Reader tokens (the plain-HTML reader, /read) live 1 hour: long
// enough to read several chapters, short enough that a shared link
// dies on its own. They are minted by /kindle/get and by
// /api/read-token, and verified by functions/read.js — never by the
// download proxy (the extra "k":"read" field makes the proxy reject
// them as download tokens, so a reader token can never download).
export const READER_TOKEN_TTL_SECONDS = 3600;
export const MINT_CAP_PER_IP = 5;
export const MINT_CAP_ANONYMOUS = 5;
export const MINT_CAP_FINGERPRINTED = 5;

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
  // Drive-library books (WAVE 7, wave-7 child A): lib=drive&id=<Drive
  // file id> — the generic Drive entry send-to-kindle.js already has
  // (same label). This is the one-liner that unlocks Drive download
  // (/api/dl-token mint + /k/ short link to the uc URL), the reader
  // token (/api/read-token) and /read for kind='drive' search
  // results: parseBookParams + resolveOpdsAcquisitionUrl already
  // handle kind "drive" (uc download URL), so no new fetch path is
  // needed. The id rule is the same Drive file-id shape as the
  // other drive-kind libs (opdsIdOk below).
  drive: { kind: "drive", label: "مكتبة Drive" },
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

function b64urlDecode(str) {
  const clean = String(str).replace(/-/g, "+").replace(/_/g, "/");
  const padded = clean + "=".repeat((4 - (clean.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
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

/** Mint a reader token for one parsed book (the /read gate).
 *  Same v1 scheme as makeToken, plus the "k":"read" purpose field,
 *  so a reader token is useless as a download token and vice versa.
 *  Single-book, 1-hour life (READER_TOKEN_TTL_SECONDS). No KV, no
 *  caps: reading is free and unlimited — the gate only proves the
 *  link came from /kindle/get or /api/read-token within the hour.
 *  `own` (personal books, 2026-11-16): when true the payload carries
 *  "o":1 — the reader treats the book as the user's own file (no
 *  flag gate on renewal, no download cap on the download mint that
 *  produced the link). The flag is set ONLY from a server-side
 *  isPersonalBook check (fp + title against the private feed), never
 *  from a client claim. Exported for /kindle/get, /api/read-token
 *  and tests. */
export async function makeReaderToken(signingKey, handle, postId, fmt,
  ttlSeconds = READER_TOKEN_TTL_SECONDS, nowSeconds = Math.floor(Date.now() / 1000),
  own = false) {
  const exp = nowSeconds + ttlSeconds;
  const pJson = typeof postId === "number" ? String(postId) : JSON.stringify(postId);
  const payloadJson = `{"exp":${exp},"f":${JSON.stringify(fmt)},"h":${JSON.stringify(handle)},"k":"read","p":${pJson}${own ? `,"o":1` : ""}}`;
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

/** Verify a reader token for one parsed book. The signature is
 *  checked FIRST (over the raw payload segment, before the payload
 *  is trusted at all); then expiry, purpose, format and the exact
 *  book identity. Any failure — bad shape, bad signature, expired,
 *  wrong book, wrong purpose — is false, never a throw. */
export async function verifyReaderToken(signingKey, token, book,
  nowSeconds = Math.floor(Date.now() / 1000)) {
  try {
    if (!signingKey || typeof token !== "string") return false;
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== "v1") return false;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(signingKey),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const sigOk = await crypto.subtle.verify(
      "HMAC",
      key,
      b64urlDecode(parts[2]),
      new TextEncoder().encode(parts[1]),
    );
    if (!sigOk) return false;
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
    if (!payload || payload.k !== "read") return false;
    if (!Number.isFinite(payload.exp) || payload.exp <= nowSeconds) return false;
    if (payload.f !== book.fmt) return false;
    const handle = book.kind === "tg" ? book.handle : book.lib;
    const postId = book.kind === "tg" ? book.postId : book.id;
    if (payload.h !== handle) return false;
    if (String(payload.p) !== String(postId)) return false;
    return true;
  } catch {
    return false;
  }
}

/** Is this reader token a PERSONAL-book token (payload "o":1)?
 *  Verifies the signature + expiry + purpose first (the same checks
 *  as verifyReaderToken, minus the book-identity match — the caller
 *  already verified the token for THIS book). Any failure is false,
 *  never a throw. Used by /read for renewal: an own token renews
 *  without any flag re-check. */
export async function readerTokenOwn(signingKey, token,
  nowSeconds = Math.floor(Date.now() / 1000)) {
  try {
    if (!signingKey || typeof token !== "string") return false;
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== "v1") return false;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(signingKey),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const sigOk = await crypto.subtle.verify(
      "HMAC",
      key,
      b64urlDecode(parts[2]),
      new TextEncoder().encode(parts[1]),
    );
    if (!sigOk) return false;
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
    if (!payload || payload.k !== "read") return false;
    if (!Number.isFinite(payload.exp) || payload.exp <= nowSeconds) return false;
    return payload.o === 1;
  } catch {
    return false;
  }
}

/** Is this book the caller's OWN (personal upload)? Verifies the
 *  server-side private feed: `fp:<fp>` -> { tg_id }, then
 *  `priv:<tg_id>` -> [{ title, ... }]. True when one private record
 *  has the same title (case-insensitive, trimmed). No KV binding,
 *  bad fingerprint, or no match -> false. A KV error fails CLOSED
 *  (false — the caller falls back to the library rules).
 *  KNOWN CAVEAT (title match, not identity): priv records carry no
 *  handle/post (OPDS FEED FINDING 1), so the match is by title only.
 *  A flagged catalog book sharing a title with one of the user's
 *  private books bypasses the flag gate FOR THAT USER ONLY (their
 *  own copy is what they read). A future bot change recording
 *  handle/post/format in priv records would close it. */
export async function isPersonalBook(env, fp, title) {
  const fpClean = (fp || "").trim();
  const titleClean = (title || "").trim().toLowerCase();
  if (!fpClean || !titleClean) return false;
  const kv = env && env.RLIBOOK_KV;
  if (!kv) return false;
  try {
    const fpRec = await kv.get("fp:" + fpClean, "json");
    const tgId = fpRec && (fpRec.tg_id ?? fpRec.tgId);
    if (!tgId) return false;
    const priv = await kv.get("priv:" + tgId, "json");
    if (!Array.isArray(priv)) return false;
    return priv.some((r) => r && typeof r.title === "string"
      && r.title.trim().toLowerCase() === titleClean);
  } catch {
    return false;
  }
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
    // A "handle" here is a channel KEY: a public Telegram handle OR a
    // private-channel slug (jami-al-kutub-al-musawwara, bookstoragebox,
    // dar-maana, al-suhuf-wal-majallat-al-ajnabiya). Slugs contain
    // hyphens, so the pattern allows "-" — rejecting it made /kindle/get
    // 400 for private channels while public handles minted fine. The
    // download proxy resolves a slug to its numeric channel id through
    // its entity map; this function only validates shape.
    if (!/^[a-z0-9_-]{3,64}$/.test(handle)) {
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

/** Flag-denylist check for one Drive-kind book (lib=drive,
 *  khazendar, sahwa, electronic — WAVE 7 follow-up A2). True =
 *  flagged, no token. Same shape as isFlaggedBook: no KV binding
 *  -> false, a KV error -> TRUE (fail closed). The key is
 *  `flag:drive:<fileId>` — the same key tg-search.js flags Drive
 *  rows with (driveFlagKey) and send-to-kindle.js checks for
 *  lib=drive. One key covers the file under ANY drive-kind lib:
 *  the flag is on the Drive file, not the library that listed it.
 *  Hindawi / DOAB books never reach this function (never flagged). */
export async function isFlaggedDriveBook(env, fileId) {
  if (!env.RLIBOOK_KV) return false;
  try {
    const v = await env.RLIBOOK_KV.get(`flag:drive:${fileId}`);
    return v !== null && v !== undefined;
  } catch {
    return true;
  }
}

/** The canonical D1 `books.url` for a Drive file id (see
 *  telegram/tbi/drive_index.py to_book: every kind='drive' row is
 *  stored as https://drive.google.com/file/d/<fileId>/view, with
 *  source='drive:<folderId>'). Moved here from send-to-kindle.js
 *  (WAVE 7 follow-up A4) so the mint side shares the serve side's
 *  lookup — one definition, same semantics everywhere. */
export function driveFileUrl(fileId) {
  return "https://drive.google.com/file/d/" + fileId + "/view";
}

/** Look up the Drive library a file id belongs to (WAVE 7).
 *
 *  fileId -> D1 `books` (kind='drive', url = the canonical form
 *  above) -> source 'drive:<folderId>' -> D1 `drive_libraries`
 *  (visibility + submitter_tg_id). Returns { folderId, visibility,
 *  submitter } or null when the file is not an indexed Drive book
 *  (unknown id, a non-Drive URL shape, no D1 binding, or a D1
 *  error). Null means "no library to protect" and the caller
 *  treats it as public — see driveLibraryAllows for the fail-open
 *  posture. Two cheap indexed D1 reads (the url equality uses
 *  idx_books_url; the registry lookup is a PK read), never a scan.
 */
export async function driveBookLibrary(db, fileId) {
  if (!db || typeof db.prepare !== "function") return null;
  if (!/^[A-Za-z0-9_-]{10,80}$/.test(fileId || "")) return null;
  try {
    const row = await db.prepare(
      "SELECT source FROM books WHERE kind = 'drive' AND url = ? LIMIT 1",
    ).bind(driveFileUrl(fileId)).first();
    if (!row || !row.source) return null;
    const m = /^drive:([A-Za-z0-9_-]{10,64})$/.exec(String(row.source));
    if (!m) return null;
    const folderId = m[1];
    const reg = await db.prepare(
      "SELECT visibility, submitter_tg_id FROM drive_libraries WHERE folder_id = ? LIMIT 1",
    ).bind(folderId).first();
    // No registry row = a legacy library (khazendar / sahwa /
    // electronic, or Oriental Music before the registry existed):
    // public, by the same rule every other reader uses.
    if (!reg) return { folderId, visibility: "public", submitter: 0 };
    return {
      folderId,
      visibility: String(reg.visibility || "public").toLowerCase(),
      submitter: Number(reg.submitter_tg_id) || 0,
    };
  } catch {
    return null; // D1 hiccup: fail open — see driveLibraryAllows.
  }
}

/** May this viewer (Telegram id, or null when unknown) receive a
 *  book from this Drive library? Same rule as /api/drive-libraries
 *  and tg-search.js: public for everyone; private for its submitter
 *  only; pending_public for the submitter + the owner. A null lib
 *  (not an indexed Drive book, or the D1 lookup failed) allows —
 *  the fail-open posture matches the serve-side gate: during a D1
 *  outage the gate cannot run, and closing ALL Drive mints/sends
 *  whenever D1 hiccups would break the public libraries too. The
 *  residual risk is documented in send-to-kindle.js: "private" is
 *  unlisted, not access-controlled — the uc fetch itself needs only
 *  the file id, and the file must be "Anyone with the link" public
 *  for the fetch to work at all. An unknown visibility value is
 *  treated as public (legacy rule).
 */
export function driveLibraryAllows(lib, viewerTgId, ownerTgId) {
  if (!lib) return true;
  if (lib.visibility === "public") return true;
  const isSubmitter = !!(viewerTgId && lib.submitter && viewerTgId === lib.submitter);
  if (lib.visibility === "private") return isSubmitter;
  if (lib.visibility === "pending_public") {
    return isSubmitter || !!(viewerTgId && ownerTgId && viewerTgId === ownerTgId);
  }
  return true;
}

const FP_RE = /^[A-Za-z0-9_-]{22}$/;

/** Resolve a catalog fingerprint to the viewer's Telegram id (WAVE
 *  7 follow-up A4 — the mint-side visibility gate). Mirrors
 *  functions/api/drive-libraries.js verifyFingerprint exactly: the
 *  fingerprint must be 22 chars, KV `fp:<fp>` -> { tg_id }, and
 *  anything missing, malformed or erroring is null (unknown viewer),
 *  never a throw. A null viewer is refused a private book by
 *  driveLibraryAllows, so a bad fingerprint can never mint one. */
export async function viewerTgIdFromFp(env, fp) {
  if (!FP_RE.test(fp || "")) return null;
  const kv = env && env.RLIBOOK_KV;
  if (!kv || typeof kv.get !== "function") return null;
  try {
    const raw = await kv.get("fp:" + fp);
    if (!raw) return null;
    const v = JSON.parse(raw);
    const id = v && Number(v.tg_id);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
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

/** Hidden check for one Telegram book (owner-only /hide,
 *  Workstream 2b). True = hidden/removed, no token. Same shape as
 *  isFlaggedBook: no KV binding -> false, a KV error -> TRUE (fail
 *  closed: an outage must never mint a token for a book that might
 *  be hidden). OPDS books are never hidden and never reach this
 *  function. Reports never set the hidden key. */
export async function isHiddenBook(env, handle, postId) {
  if (!env.RLIBOOK_KV) return false;
  try {
    const v = await env.RLIBOOK_KV.get(`hidden:${handle}:${postId}`);
    return v !== null && v !== undefined;
  } catch {
    return true;
  }
}

/** Constant-time string equality (E_LIMIT Option A): the compare
 *  runs over every character so a wrong key does not fail faster
 *  than a nearly-right one. A length mismatch returns false (the
 *  key length is not itself secret). Never throws. */
export function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Is this request an authenticated bot-service mint (E_LIMIT
 *  Option A)? True only when env.DL_TOKEN_SERVICE_KEY is set AND
 *  the request carries `Authorization: Bearer <key>` matching it
 *  exactly. Anything else — missing secret, missing header, wrong
 *  scheme, wrong key — is false: the caller falls through to the
 *  normal IP-counted path. The header value is never logged. */
export function isServiceKeyRequest(request, env) {
  const expected = (env.DL_TOKEN_SERVICE_KEY || "").trim();
  if (!expected) return false;
  const header = request.headers.get("authorization") || "";
  if (!header.toLowerCase().startsWith("bearer ")) return false;
  return timingSafeEqual(header.slice(7).trim(), expected);
}

/** Mint a download token for one parsed book. The single minting
 *  implementation shared by GET /api/dl-token and the delivery page
 *  (/kindle/get). Order matters: config, flag and hidden refusals happen
 *  BEFORE any counter is taken, so a refused mint never burns quota.
 *  `opts.ip` is the client IP (cf-connecting-ip); `opts.fp` is the
 *  catalog fingerprint when present. Every user gets 5 downloads/day
 *  (per IP and per fingerprint — the same 5/day budget either way).
 *  `opts.service` (E_LIMIT Option A, 2026-11-26): when true the
 *  request authenticated with DL_TOKEN_SERVICE_KEY (checked in
 *  onRequest via isServiceKeyRequest, never trusted from the
 *  caller) — the per-IP counter is SKIPPED (the bot Worker's single
 *  egress IP must not cap all bot deliveries) while the
 *  fingerprint/anonymous user cap below STILL applies, and the
 *  flag/hidden gates above still run first. A service mint is
 *  counted best-effort in `dlt:svc:<date>` for observability only.
 *  `opts.own` (personal books, 2026-11-16): when true the book is
 *  the caller's own file (server-verified via isPersonalBook, never
 *  a client claim) — the flag check and the mint counters are
 *  SKIPPED (your own file: no cap, no flag gate). The hidden check
 *  still applies: an owner-hidden book stays hidden even for its
 *  owner. Returns { ok: true, token, exp, ttl, url } or
 *  { ok: false, status, error } with error one of: not_configured,
 *  proxy_not_configured, flagged, hidden, private_library,
 *  mint_cap_ip, mint_cap_user.
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
  const own = opts.own === true;
  if (!own && book.kind === "tg" && (await isFlaggedBook(env, book.handle, book.postId))) {
    return { ok: false, status: 403, error: "flagged" };
  }
  // Drive-kind OPDS books (WAVE 7 follow-up A2): the wave-7
  // one-liner unlocked lib=drive (and khazendar / sahwa /
  // electronic were already drive-kind) for minting, but the flag
  // gate above is Telegram-only — a flagged Drive book minted
  // freely through a direct /api/dl-token call while the website
  // showed it with no links. Same key send-to-kindle.js checks
  // (`flag:drive:<fileId>`), same 403, same position (before any
  // counter, so a refused mint never burns quota). The `!own`
  // prefix is the same personal-book rule as the Telegram gate:
  // your own file (server-verified via isPersonalBook, title
  // match — the documented caveat) skips the flag gate. The
  // hidden check below stays Telegram-only: there is no
  // `hidden:drive:` mechanism (tg-search / send-to-kindle flag
  // Drive rows only, never hide them).
  if (!own && book.kind === "opds" && OPDS_LIBS[book.lib].kind === "drive"
    && (await isFlaggedDriveBook(env, book.id))) {
    return { ok: false, status: 403, error: "flagged" };
  }
  if (book.kind === "tg" && (await isHiddenBook(env, book.handle, book.postId))) {
    return { ok: false, status: 403, error: "hidden" };
  }
  // Drive visibility gate (WAVE 7 follow-up A4 — the mint-side
  // counterpart of the serve-side gate in send-to-kindle.js /
  // read.js). A non-submitter minting a dl-token for a private
  // Drive book got a /k/ short link resolving straight to the uc
  // URL — the serve-side gates never see it, so the mint IS the
  // enforcement point for downloads. Same placement as the flag
  // gate above (before any counter, so a refused mint never burns
  // quota), same OPDS_LIBS kind condition, same lookup
  // (driveBookLibrary) and rule (driveLibraryAllows) as the serve
  // side, so mint and serve can never disagree. The viewer id
  // comes from opts.fp (the catalog fingerprint, resolved via
  // viewerTgIdFromFp); a caller with no fingerprint has no
  // identity and is refused a private book. Public / legacy (no
  // registry row) / unindexed file ids mint unchanged (fail open,
  // per driveLibraryAllows). `!own` is the same personal-book rule
  // as the flag gate: your own file (server-verified) skips it.
  if (!own && book.kind === "opds" && OPDS_LIBS[book.lib] && OPDS_LIBS[book.lib].kind === "drive") {
    const viewerTgId = await viewerTgIdFromFp(env, opts.fp);
    const ownerRaw = Number((env.RLIBOOK_OWNER_ID || env.OWNER_TG_ID) || 0);
    const ownerTgId = Number.isSafeInteger(ownerRaw) && ownerRaw > 0 ? ownerRaw : 0;
    const libInfo = await driveBookLibrary(env.TG_D1, book.id);
    if (!driveLibraryAllows(libInfo, viewerTgId, ownerTgId)) {
      return { ok: false, status: 403, error: "private_library" };
    }
  }

  const ttl = clampTtl(env);
  const now = Math.floor(Date.now() / 1000);

  // Mint caps — KV-bound only; without KV they fail open (mint,
  // count nothing). The IP cap is checked first; if the user cap
  // then refuses, the IP count is refunded. SKIPPED entirely for
  // own books (opts.own): your own file costs no quota.
  // E_LIMIT Option A: a service-key mint (opts.service) skips the
  // IP counter only — the per-user cap below still binds, so one
  // identity can never mint unboundedly. The svc observability
  // counter is best-effort and never refuses.
  const service = opts.service === true;
  let ipKey = null;
  let ipCounted = false;
  if (!own && env.RLIBOOK_KV) {
    const ip = sanitizeIp(opts.ip);
    try {
      if (!service) {
        ipKey = "ip:" + ip;
        const ipCheck = await takeCounter(env.RLIBOOK_KV, ipKey, MINT_CAP_PER_IP);
        if (ipCheck.over) {
          return { ok: false, status: 429, error: "mint_cap_ip" };
        }
        ipCounted = ipCheck.counted;
      } else {
        await takeCounter(env.RLIBOOK_KV, "svc", Number.MAX_SAFE_INTEGER);
      }
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
 *  them yet (the TTL deletes them within 10 minutes anyway).
 *  READ-ONLY: it does not consume the link — the /k/ resolver uses
 *  resolveAndConsumeShortLink below. Tests use this one. */
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

/** Resolve AND CONSUME a short code: the first successful resolve
 *  deletes `k:<code>` from KV, so a replay (a shared or re-tapped
 *  link) 404s. This is the single-use gate the /k/ resolver uses
 *  (2026-11-16: REVERSAL of design decision D5 — D5 kept links
 *  re-usable for 10 minutes on the grounds that a failed first tap
 *  would burn the link; the research review concluded a single-use
 *  link + per-device 5/day budget is the stronger free-tier gate.
 *  Tradeoff, stated plainly: a failed first tap (a dropped download)
 *  DOES burn the link — the user mints a fresh one from the delivery
 *  page, costing 1 of their 5/day. A delete failure never blocks the
 *  redirect: the 10-minute expiry still bounds the link.
 *  HONEST LIMIT: KV has no atomic get-and-delete, so two requests in
 *  the same instant can both read before either deletes. Single-use
 *  holds for every normal tap/share/replay; it is not a cryptographic
 *  guarantee. AND the raw signed proxy URL inside the target is
 *  itself replayable within its 10-minute life — true single-use of
 *  the underlying token needs a change in the download-proxy repo
 *  (out of scope here); the short link is the only link users see,
 *  so consuming it closes the realistic replay path. */
export async function resolveAndConsumeShortLink(env, code) {
  const entry = await resolveShortLink(env, code);
  if (!entry) return null;
  if (env.RLIBOOK_KV) {
    try {
      await env.RLIBOOK_KV.delete("k:" + code);
    } catch {
      // Delete failed — the redirect still happens; the entry dies
      // on its 10-minute TTL. Never fail a legitimate download.
    }
  }
  return entry;
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
  // Personal books (2026-11-16): `fp` + `t` (title) let the caller
  // prove the book is their own upload — verified server-side
  // against the private feed (isPersonalBook), never trusted from
  // the claim alone. Own books skip the flag gate and the mint caps
  // in mintTokenForBook (the hidden check still applies).
  const own = await isPersonalBook(env, fp, url.searchParams.get("t") || "");
  // E_LIMIT Option A: the service key is verified here, server-side,
  // and passed to mintTokenForBook as a boolean — the caller can
  // never claim it. Wrong/missing key = normal IP-counted path.
  const service = isServiceKeyRequest(request, env);
  const result = await mintTokenForBook(env, book, { ip, fp, own, service });
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
