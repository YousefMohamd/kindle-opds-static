// Cloudflare Pages Function: reader-token issuer (RliBook).
// Route: GET /api/read-token?lib=<slug>&id=<book id>&f=<fmt>
//        GET /api/read-token?lib=tg&h=<handle>&p=<post_id>&f=<fmt>
//
//   GET /api/read-token?lib=hindawi&id=13028368&f=epub
//     -> 200 { ok: true, token: "v1....", exp: ..., ttl: 3600,
//              url: "/read?lib=hindawi&id=13028368&f=epub&rtok=v1...." }
//
// The token opens ONE book in the plain-HTML reader (/read) for one
// hour. It is the same HMAC scheme as the download tokens
// (functions/api/dl-token.js makeReaderToken), plus the "k":"read"
// purpose field — the download proxy rejects it, so it can never
// download anything. Reading is free and unlimited: minting takes
// no KV counter and burns no download quota. The only gates are
// the flag denylist (Telegram books AND drive-kind OPDS books —
// WAVE 7 follow-up A2, same `flag:drive:<fileId>` key as the
// download mint), the owner-hide denylist (Workstream 2b — a hidden
// book gets no reader token either), the Drive visibility gate
// (WAVE 7 follow-up A4 — a private/pending Drive library's book
// gets a reader token only for its submitter, pending: + the owner;
// 403 "private_library") and the signing key being configured. No
// KV binding -> the flag/hide checks pass open
// (same posture as the reader itself) and the token is still minted.
//
// PERSONAL BOOKS (2026-11-16): `fp` + `t` (title) prove the book
// is the caller's own upload — verified server-side against the
// private feed (isPersonalBook). Own books skip the flag gate and
// get a token carrying "o":1, which /read uses for renewal without
// any flag re-check. The hide gate still applies to own books
// (hide is the owner's explicit removal — it wins). RENEWAL:
// `rtok` (a currently valid reader token for the same book) renews
// it — an own token renews as own (flag gate skipped); a library
// token renews through the normal flag/hide gates. The renewal is
// what keeps reading going past the 1-hour token life: /read's
// client script fetches this endpoint before the token expires.
//
// Env (same as dl-token.js):
//   PROXY_SIGNING_KEY (required) — the shared HMAC secret.
// KV binding (optional):
//   RLIBOOK_KV — flag denylist keys `flag:<handle>:<post_id>` and
//                `flag:drive:<fileId>` (drive-kind OPDS books),
//                hidden keys `hidden:<handle>:<post_id>` (owner
//                /hide only).
//
// Free-tier friendly: 1 KV get (flag check) + 1 KV get (hide check,
// Telegram books only), no writes, one HMAC.

import {
  parseBookParams,
  isFlaggedBook,
  isFlaggedDriveBook,
  OPDS_LIBS,
  isHiddenBook,
  isPersonalBook,
  makeReaderToken,
  verifyReaderToken,
  readerTokenOwn,
  READER_TOKEN_TTL_SECONDS,
  viewerTgIdFromFp,
  driveBookLibrary,
  driveLibraryAllows,
} from "./dl-token.js";

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "GET") {
    return json(405, { ok: false, error: "method_not_allowed" });
  }
  const url = new URL(request.url);
  const book = parseBookParams(url.searchParams, { defaultFormat: "epub" });
  if (!book.ok) {
    return json(400, { ok: false, error: book.error });
  }
  const signingKey = (env.PROXY_SIGNING_KEY || "").trim();
  if (!signingKey) {
    return json(503, { ok: false, error: "not_configured" });
  }
  // Personal book? `fp` + `t` verified server-side against the
  // private feed. Own books skip the flag AND hide gates below.
  // Renewal? A valid `rtok` for the same book renews it — an own
  // token renews as own (gates skipped), a library token goes
  // through the normal gates. Either proof suffices; both are
  // server-verified, never trusted from the claim alone.
  const fp = (url.searchParams.get("fp") || "").trim();
  const title = (url.searchParams.get("t") || "").trim();
  const rtok = (url.searchParams.get("rtok") || "").trim();
  let own = false;
  if (book.kind === "tg") {
    if (fp && title && (await isPersonalBook(env, fp, title))) own = true;
    if (!own && rtok && (await verifyReaderToken(signingKey, rtok, book))
      && (await readerTokenOwn(signingKey, rtok))) own = true;
  }
  if (!own && book.kind === "tg" && (await isFlaggedBook(env, book.handle, book.postId))) {
    return json(403, { ok: false, error: "flagged" });
  }
  // Drive-kind OPDS books (WAVE 7 follow-up A2): the reader mint
  // shared the download mint's hole — a flagged Drive book got a
  // reader token while the website showed it with no reader link.
  // Same `flag:drive:<fileId>` key, same 403, before any token is
  // made. `own` is Telegram-only here (never true for OPDS books),
  // so the gate is unconditional for drive-kind libs; a flagged
  // book's renewal (rtok) hits this same check and is refused too.
  // Hindawi / DOAB are never flagged and never reach this check.
  if (!own && book.kind === "opds" && OPDS_LIBS[book.lib].kind === "drive"
    && (await isFlaggedDriveBook(env, book.id))) {
    return json(403, { ok: false, error: "flagged" });
  }
  // Owner-hide (Workstream 2b): a hidden book gets no reader token
  // either. Same fail-closed shape as the flag check. This applies
  // even to own books: hide is the owner's explicit removal of the
  // catalog entry, and it wins (the private copy is still the
  // owner's file on their Drive — the catalog reader path is what
  // is closed).
  if (book.kind === "tg" && (await isHiddenBook(env, book.handle, book.postId))) {
    return json(403, { ok: false, error: "hidden" });
  }
  // Drive visibility gate (WAVE 7 follow-up A4 — the mint-side
  // counterpart of the serve-side gate in read.js). A reader token
  // for a private Drive book lets /read serve the chapter — the
  // serve-side gate there runs AFTER the token check, so an
  // already-minted token is the only thing standing between a
  // non-submitter and the chapter, and the /read gate itself does
  // refuse them — but minting the token at all also hands out a
  // fresh-renewal path, so the mint refuses first, same rule
  // (driveBookLibrary + driveLibraryAllows, shared from
  // dl-token.js), same 403 "private_library", before any token is
  // made. The viewer id comes from this file's `fp` (the catalog
  // fingerprint, via viewerTgIdFromFp); no fingerprint means no
  // identity and a private book is refused. Public / legacy (no
  // registry row) / unindexed file ids mint unchanged (fail open,
  // per driveLibraryAllows). `own` is Telegram-only here (never
  // true for OPDS books), so the gate is unconditional for
  // drive-kind libs; a flagged book's renewal hits the flag check
  // above, a private book's renewal hits this one.
  if (!own && book.kind === "opds" && OPDS_LIBS[book.lib] && OPDS_LIBS[book.lib].kind === "drive") {
    const viewerTgId = await viewerTgIdFromFp(env, fp);
    const ownerRaw = Number((env.RLIBOOK_OWNER_ID || env.OWNER_TG_ID) || 0);
    const ownerTgId = Number.isSafeInteger(ownerRaw) && ownerRaw > 0 ? ownerRaw : 0;
    const libInfo = await driveBookLibrary(env.TG_D1, book.id);
    if (!driveLibraryAllows(libInfo, viewerTgId, ownerTgId)) {
      return json(403, { ok: false, error: "private_library" });
    }
  }
  const handle = book.kind === "tg" ? book.handle : book.lib;
  const postId = book.kind === "tg" ? book.postId : book.id;
  const now = Math.floor(Date.now() / 1000);
  const token = await makeReaderToken(signingKey, handle, postId, book.fmt,
    READER_TOKEN_TTL_SECONDS, now, own);
  const query = book.kind === "tg"
    ? "lib=tg&h=" + encodeURIComponent(handle) + "&p=" + postId
    : "lib=" + encodeURIComponent(book.lib) + "&id=" + encodeURIComponent(book.id);
  return json(200, {
    ok: true,
    token,
    exp: now + READER_TOKEN_TTL_SECONDS,
    ttl: READER_TOKEN_TTL_SECONDS,
    url: "/read?" + query + "&f=" + book.fmt + "&rtok=" + encodeURIComponent(token),
  });
}
