// Cloudflare Pages Function: Block 2 download-token issuer (RliBook).
// Route: GET /api/dl-token?h=<handle>&p=<post_id>&f=<format>
//
//   GET /api/dl-token?h=khazendar&p=12345&f=epub
//     -> 200 { ok: true, token: "v1....", exp: 179..., ttl: 600,
//              url: "https://<proxy>/dl?h=khazendar&p=12345&f=epub&t=v1...." }
//        (url is null until PROXY_BASE_URL is set — the Oracle VM does
//        not exist yet. The token alone is enough for the site to build
//        the link once the proxy URL is known.)
//
// The token is the SAME scheme the download proxy verifies
// (rlibook-download-proxy/app/tokens.py, v1):
//   payload = {"exp":N,"f":"epub","h":"khazendar","p":12345}
//     — JSON, sorted keys, no spaces —
//   token = "v1." + base64url(payload_json)
//                + "." + base64url(HMAC-SHA256(PROXY_SIGNING_KEY, payload_b64))
// The proxy checks shape, signature, exact (h, p, f) match and expiry.
// A token is single-book: it cannot be reused for another channel,
// post or format.
//
// Flag gate (v1) — read this before wiring the button:
//   * If env.RLIBOOK_KV is bound, a KV key `flag:<handle>:<post_id>`
//     means the book IS flagged/commercial -> 403, no token.
//     (Block 7 populates those keys; the bot's flags.ts list is the
//     source of truth for which titles are flagged.)
//   * If the KV binding is missing, or no flag key exists, a token IS
//     issued. That is the honest v1 limit: there is no flag feed yet,
//     so "not flagged" currently means "not on the denylist".
//     The issuer does NOT prove the book exists, and does NOT prove it
//     is public-domain / CC. Do NOT present it as a completed legal
//     check, and do NOT remove the tg:// links on the strength of v1
//     alone — wiring the download button to the proxy is a later step,
//     once the Block 7 flag feed populates the denylist.
//   * Issuing is unauthenticated by design (it backs a public download
//     button). Abuse is bounded by the token itself: 10-minute life,
//     one book, and the proxy's own per-IP rate limit (30/min).
//
// Env (Pages dashboard -> Settings -> Functions -> Environment variables;
// secrets, never in the repo, never in chat):
//   PROXY_SIGNING_KEY   (required) — the SAME value as the proxy's
//                         secret. Generate once (openssl rand -hex 32)
//                         and reuse it for both sides.
//   PROXY_BASE_URL      (optional) — e.g. https://<oracle-vm-ip>:8000
//                         or the Fly URL. Unset -> url is null.
//   PROXY_TOKEN_TTL_SECONDS (optional, default 600, clamped 60..3600)
// KV binding (optional, same namespace the bot + OPDS feed use):
//   RLIBOOK_KV — flag denylist keys `flag:<handle>:<post_id>`.
//
// Free-tier friendly: one KV get at most, no catalog fetch, no heavy work.

const ALLOWED_FORMATS = new Set(["epub", "pdf", "mobi", "azw3", "kfx", "txt"]);
const DEFAULT_TTL_SECONDS = 600;

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
  const payloadJson = `{"exp":${exp},"f":${JSON.stringify(fmt)},"h":${JSON.stringify(handle)},"p":${postId}}`;
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

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "GET") {
    return json(405, { ok: false, error: "method_not_allowed" });
  }

  const url = new URL(request.url);
  const handle = normalizeHandle(url.searchParams.get("h"));
  const postRaw = (url.searchParams.get("p") || "").trim();
  const fmt = (url.searchParams.get("f") || "").trim().toLowerCase();

  if (!/^[a-z0-9_]{3,64}$/.test(handle)) {
    return json(400, { ok: false, error: "bad_handle" });
  }
  if (!/^\d{1,10}$/.test(postRaw)) {
    return json(400, { ok: false, error: "bad_post_id" });
  }
  const postId = Number(postRaw);
  if (!Number.isSafeInteger(postId) || postId < 1) {
    return json(400, { ok: false, error: "bad_post_id" });
  }
  if (!ALLOWED_FORMATS.has(fmt)) {
    return json(400, { ok: false, error: "bad_format" });
  }

  const signingKey = (env.PROXY_SIGNING_KEY || "").trim();
  if (!signingKey) {
    return json(503, { ok: false, error: "not_configured" });
  }

  // Flag denylist (Block 7). One KV get; missing binding = no denylist.
  if (env.RLIBOOK_KV) {
    const flagged = await env.RLIBOOK_KV.get(`flag:${handle}:${postId}`);
    if (flagged !== null && flagged !== undefined) {
      return json(403, { ok: false, error: "flagged" });
    }
  }

  let ttl = Number(env.PROXY_TOKEN_TTL_SECONDS || DEFAULT_TTL_SECONDS);
  if (!Number.isFinite(ttl)) ttl = DEFAULT_TTL_SECONDS;
  ttl = Math.max(60, Math.min(3600, Math.floor(ttl)));

  const now = Math.floor(Date.now() / 1000);
  const token = await makeToken(signingKey, handle, postId, fmt, ttl, now);
  const exp = now + ttl;

  const base = (env.PROXY_BASE_URL || "").trim().replace(/\/+$/, "");
  const dlUrl = base
    ? `${base}/dl?h=${encodeURIComponent(handle)}&p=${postId}&f=${encodeURIComponent(fmt)}&t=${encodeURIComponent(token)}`
    : null;

  return json(200, { ok: true, token, exp, ttl, url: dlUrl });
}
