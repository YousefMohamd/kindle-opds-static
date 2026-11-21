// Cloudflare Pages Function: owner-only reports / flags monitor API
// (RliBook, 2026-11-21).
// Route: /api/admin-reports
//
//   GET  /api/admin-reports
//     -> 200 JSON { ok:true, pending:[...], flagged:[...],
//        hidden:[...], decisions:[...] } — the review queue, the
//        flagged books, the hidden books, and the decisions log.
//   POST /api/admin-reports  { action, rid?, handle?, postId? }
//     -> 200 JSON { ok:true, ... } — one owner decision:
//        approve | reject (a pending report), unflag, hide, unhide.
//
// OWNER GATE (fingerprint, no new secret): the caller proves they
// are the owner with the same fingerprint the catalog file carries
// (?fp=, the rlb_fp cookie set by /api/identify, or an
// Authorization: Bearer token). The fingerprint is verified against
// the SAME RLIBOOK_KV binding the bot uses — kv.get("fp:<token>")
// -> { tg_id } — exactly how functions/api/identify.js verifies
// it (Pages has no CATALOG_SECRET env var, so the HMAC cannot be
// re-checked here; the KV registry IS the verification, and the
// owner can revoke a fingerprint from the bot). The Telegram id
// must equal OWNER_TG_ID. A missing/unknown/revoked fingerprint,
// a non-owner fingerprint, or ANY KV failure while verifying
// answers 403 (unknown) or 503 (KV error) — never any data.
// Fail CLOSED everywhere: unlike functions/api/send-to-kindle.js,
// whose flag check fails OPEN on a KV error (documented there),
// this endpoint refuses when it cannot verify.
//
// KV EFFECTS — a mirror of the bot's Store (src/store.ts) and
// handlers (src/handlers.ts handleReportDecision / handleFlags /
// handleHide / handleUnhide / handleControlAction), key for key:
//   approve(rid): report:<rid> saved { status:"approved",
//     decidedAt, decidedBy } + rid removed from reports:pending
//     (JSON array) + report:pending:<handle>:<post> deleted (the
//     72h hold) + flag:<handle>:<post> = "1" + flag:ledger:
//     { action:"flag", reason: reasonText || reason,
//     source:"report:<rid>", at, by } + flags:all rebuilt.
//   reject(rid): the same minus the flag — report saved
//     { status:"rejected", ... } + pending index + hold cleared.
//     No ledger entry (the bot writes none on reject).
//   unflag: flag: deleted + ledger { action:"unflag",
//     reason:"panel unflag", source:"manual:<ownerId>" } +
//     flags:all rebuilt. Refused when the book is not flagged.
//   hide: hidden: = "manual:<ownerId>:<now>" + ledger
//     { action:"hide", reason:"owner hide",
//     source:"manual:<ownerId>" } + flags:all rebuilt. Refused
//     when already hidden.
//   unhide: hidden: deleted + ledger { action:"unhide",
//     reason:"panel unhide", source:"manual:<ownerId>" } +
//     flags:all rebuilt. Refused when not hidden.
//   flags:all = { flagged: ["handle:postId", ...], hidden: [...] }
//     sorted — the blob the website trusts (see
//     functions/api/tg-search.js); it is rebuilt after EVERY
//     mutation, exactly like the bot's rebuildFlagsAll, because a
//     stale blob fails open. When KV list() is unavailable the
//     mutation is refused BEFORE any write (503 E_NO_LIST) —
//     the bot instead throws after the flag landed, which this
//     endpoint avoids by pre-checking.
// ONE deliberate deviation from the bot: the ledger's `by` field
// is "web" here, not "bot" — it records the true channel of the
// decision (the bot's writeFlagLedger hardcodes "bot"). Same
// shape, same keys, same source/reason conventions otherwise.
//
// LISTS (GET): pending reports come from the reports:pending
// index (stale entries — record gone or already decided — are
// pruned on read, best-effort, like the bot's /reports).
// Flagged / hidden books come from KV list() over the flag: /
// hidden: prefixes (keys that do not parse as a book are skipped,
// never listed). The decisions log merges decided reports
// (report:<rid> records with status != "pending") with the
// flag:ledger: entries (latest decision per book), newest first,
// capped at MAX_DECISIONS. Titles come from the report records;
// flagged/hidden rows show the post link + ledger info — no title
// lookup (the single-book lookup drops hidden books and needs the
// bot key; the owner taps the post link to see the book).
// Channel names and post links appear here ONLY because the page
// is owner-gated (standing source-hiding rule: never on a public
// page).
//
// Env (Pages dashboard -> Settings -> Functions; no secrets):
//   RLIBOOK_KV (required) — the SAME KV namespace the bot uses.
//                Without it the endpoint refuses (503).
// No other env is needed: no email provider, no proxy, no secret.

import { parseCookies, COOKIE_NAME } from "./identify.js";

export const OWNER_TG_ID = 7283934644;
export const BOT_LINK = "https://t.me/RliBook_bot";

export const PENDING_REPORTS_KEY = "reports:pending";
export const FLAGS_ALL_KEY = "flags:all";
export const MAX_PENDING_REPORTS = 200;
export const LIST_KEYS_MAX = 1000;
export const LIST_BOOKS_MAX = 100;
export const MAX_DECISIONS = 50;
export const MAX_REPORT_GETS = 200;

export const HANDLE_RE = /^[A-Za-z0-9_]{1,64}$/;
export const POST_ID_RE = /^\d{1,20}$/;
export const RID_RE = /^[0-9a-f]{12}$/;
export const FP_RE = /^[A-Za-z0-9_-]{22}$/;

export function reportKey(rid) {
  return `report:${rid}`;
}
export function flagBookKey(handle, postId) {
  return `flag:${handle}:${postId}`;
}
export function hiddenBookKey(handle, postId) {
  return `hidden:${handle}:${postId}`;
}
export function reportPendingKey(handle, postId) {
  return `report:pending:${handle}:${postId}`;
}
export function flagLedgerKey(handle, postId) {
  return `flag:ledger:${handle}:${postId}`;
}

/** Parse a KV key name into a flagged book, or null (same regex
 *  as the bot's control-panel.ts parseFlagKey — flag:ledger: and
 *  flags:all never match). */
export function parseFlagKey(name) {
  const m = /^flag:([A-Za-z0-9_]{1,64}):(\d{1,20})$/.exec(name || "");
  return m ? { handle: m[1], postId: m[2] } : null;
}

/** Parse a KV key name into a hidden book, or null. */
export function parseHiddenKey(name) {
  const m = /^hidden:([A-Za-z0-9_]{1,64}):(\d{1,20})$/.exec(name || "");
  return m ? { handle: m[1], postId: m[2] } : null;
}

/** Parse a KV key name into a ledger entry's book, or null. */
export function parseLedgerKey(name) {
  const m = /^flag:ledger:([A-Za-z0-9_]{1,64}):(\d{1,20})$/.exec(name || "");
  return m ? { handle: m[1], postId: m[2] } : null;
}

/** Parse a KV key name into a report id, or null — reports:pending,
 *  report:pending: and report:dup: keys never match. */
export function parseReportKey(name) {
  const m = /^report:([0-9a-f]{12})$/.exec(name || "");
  return m ? m[1] : null;
}

/** The manual-hide value (bot control-panel.ts manualHideValue):
 *  who hid it, and when. */
export function manualHideValue(ownerId, now = Date.now()) {
  return `manual:${ownerId}:${now}`;
}

/** True when a hidden-key value is a manual /hide (not an
 *  approved report's rid) — same as the bot's isManualHide. */
export function isManualHide(value) {
  return (value || "").startsWith("manual:");
}

/** One provenance ledger entry (bot control-panel.ts
 *  FlagLedgerEntry): { action, reason, source, at, by }. `by` is
 *  "web" here — the true channel (the bot writes "bot"). */
export function ledgerEntry(action, reason, source) {
  return {
    action,
    reason: reason || "",
    source: source || "manual",
    at: new Date().toISOString(),
    by: "web",
  };
}

/** Validate a handle + post id pair, or null. */
export function validBook(handle, postId) {
  const h = String(handle || "").trim();
  const p = String(postId || "").trim();
  if (!HANDLE_RE.test(h) || !POST_ID_RE.test(p)) return null;
  return { handle: h, postId: p };
}

// --- owner gate -------------------------------------------------------

/** The fingerprint from the request: ?fp= wins, then an
 *  Authorization: Bearer token, then the rlb_fp cookie — the same
 *  sources /api/identify and /api/send-to-kindle accept. */
export function fingerprintFromRequest(request) {
  const url = new URL(request.url);
  const fpParam = (url.searchParams.get("fp") || "").trim();
  if (fpParam) return fpParam;
  const auth = (request.headers.get("Authorization") || "").trim();
  const bearer = /^Bearer\s+(\S+)$/i.exec(auth);
  if (bearer) return bearer[1].trim();
  return (parseCookies(request.headers.get("Cookie") || "")[COOKIE_NAME] || "").trim();
}

/** Verify the fingerprint against KV: { ok:true, tgId } when the
 *  fp:<token> record belongs to the owner; { ok:false,
 *  error:"E_NOT_OWNER" } when it is unknown, revoked, malformed,
 *  or another user's; { ok:false, error:"E_KV" } when KV itself
 *  failed — fail closed, never verified on a KV error. */
export async function verifyOwner(env, fp) {
  if (!fp || typeof fp !== "string" || fp.length > 128) {
    return { ok: false, error: "E_NOT_OWNER" };
  }
  let rec = null;
  try {
    rec = await env.RLIBOOK_KV.get("fp:" + fp, "json");
  } catch (e) {
    return { ok: false, error: "E_KV" };
  }
  const tgId = rec && Number.isSafeInteger(rec.tg_id) ? rec.tg_id : null;
  if (tgId !== OWNER_TG_ID) return { ok: false, error: "E_NOT_OWNER" };
  return { ok: true, tgId };
}

// --- KV helpers -------------------------------------------------------

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/** Key names under a prefix, paginated to `limit`. Null when the
 *  KV binding has no list() (the honest "list unavailable" the
 *  bot's /flags answers). Throws on a KV error — the caller
 *  answers 503, never an empty list. */
export async function listKeyNames(kv, prefix, limit = LIST_KEYS_MAX) {
  if (!kv || typeof kv.list !== "function") return null;
  const names = [];
  let cursor;
  do {
    const page = await kv.list({ prefix, limit: Math.min(1000, limit), cursor });
    if (!page || !Array.isArray(page.keys)) return null;
    for (const k of page.keys) {
      if (k && typeof k.name === "string") names.push(k.name);
      if (names.length >= limit) return names;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return names;
}

/** Read a JSON record, or null when absent, malformed, or unreadable.
 *  A KV failure returns null too — callers that must distinguish
 *  treat a null record as "not found" (a decision on a missing
 *  record is refused either way). */
async function getJsonRecord(kv, key) {
  try {
    const rec = await kv.get(key, "json");
    return rec && typeof rec === "object" ? rec : null;
  } catch (e) {
    return null;
  }
}

/** Rebuild the flags:all blob from the flag: / hidden: keys —
 *  the bot's Store.rebuildFlagsAll, key for key. Throws when KV
 *  list() is unavailable (the caller refuses before any write)
 *  or when a KV write fails (the flag/hide itself already landed;
 *  the caller must surface it — a silently stale blob is worse
 *  than a loud error, and the daily sync reconciliation is the
 *  safety net). */
export async function rebuildFlagsAll(kv) {
  const flagNames = await listKeyNames(kv, "flag:");
  const hiddenNames = await listKeyNames(kv, "hidden:");
  if (flagNames === null || hiddenNames === null) {
    throw new Error("flags:all rebuild: KV list() unavailable");
  }
  const flagged = [];
  for (const name of flagNames) {
    const b = parseFlagKey(name);
    if (b) flagged.push(`${b.handle}:${b.postId}`);
  }
  const hidden = [];
  for (const name of hiddenNames) {
    const b = parseHiddenKey(name);
    if (b) hidden.push(`${b.handle}:${b.postId}`);
  }
  const blob = { flagged: flagged.sort(), hidden: hidden.sort() };
  await kv.put(FLAGS_ALL_KEY, JSON.stringify(blob));
  return blob;
}

/** True when KV list() is available — checked BEFORE any mutation
 *  that must rebuild flags:all, so a mutation is never half-done. */
export function canList(kv) {
  return !!kv && typeof kv.list === "function";
}

// --- reads ------------------------------------------------------------

/** Pending reports from the reports:pending index (newest first,
 *  capped). Stale entries (record gone, or already decided) are
 *  pruned on read when `prune` is true, best-effort, like the
 *  bot's /reports. A malformed index reads as empty and is never
 *  pruned (wiping it would destroy the queue). */
export async function readPendingReports(kv, prune = false) {
  let ids = null;
  // A KV failure throws (the caller answers 503) — only a
  // malformed index reads as empty, and is never pruned.
  const raw = await kv.get(PENDING_REPORTS_KEY);
  try {
    ids = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(ids)) ids = [];
  } catch (e) {
    return { reports: [], pruned: 0 };
  }
  const reports = [];
  const stale = [];
  for (const rid of ids.slice(0, MAX_PENDING_REPORTS)) {
    if (typeof rid !== "string" || !RID_RE.test(rid)) {
      stale.push(rid);
      continue;
    }
    const rec = await getJsonRecord(kv, reportKey(rid));
    if (!rec || rec.status !== "pending") {
      stale.push(rid);
      continue;
    }
    reports.push(rec);
  }
  if (prune && stale.length > 0) {
    try {
      await kv.put(
        PENDING_REPORTS_KEY,
        JSON.stringify(ids.filter((id) => !stale.includes(id))),
      );
    } catch (e) {
      // Best-effort only — the stale entries are simply re-shown.
    }
  }
  return { reports, pruned: stale.length };
}

/** Remove one rid from the reports:pending index (bot's
 *  Store.removePendingReportId). A missing index or a rid that
 *  is not in it is a no-op. */
export async function removePendingReportId(kv, rid) {
  let ids = null;
  try {
    const raw = await kv.get(PENDING_REPORTS_KEY);
    ids = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(ids)) return;
  } catch (e) {
    return;
  }
  if (!ids.includes(rid)) return;
  await kv.put(
    PENDING_REPORTS_KEY,
    JSON.stringify(ids.filter((id) => id !== rid)),
  );
}

/** Clear the pending hold (bot's Store.clearPendingReportHold):
 *  best-effort delete — a failed delete never breaks the decision,
 *  the 72h TTL clears it regardless. */
async function clearPendingReportHold(kv, handle, postId) {
  try {
    await kv.delete(reportPendingKey(handle, postId));
  } catch (e) {
    // Best-effort only.
  }
}

/** Flagged books: the flag: keys, each with its ledger entry
 *  (best-effort — a missing/unreadable ledger is null, never an
 *  error). Capped at LIST_BOOKS_MAX, in key order. */
export async function readFlaggedBooks(kv) {
  const names = await listKeyNames(kv, "flag:");
  if (names === null) return null;
  const books = [];
  for (const name of names) {
    const b = parseFlagKey(name);
    if (!b) continue;
    const ledger = await getJsonRecord(kv, flagLedgerKey(b.handle, b.postId));
    books.push({ ...b, ledger: ledger && ledger.action ? ledger : null });
    if (books.length >= LIST_BOOKS_MAX) break;
  }
  return books;
}

/** Hidden books: the hidden: keys, each with its stored value
 *  (manual:<ownerId>:<ts> vs a report rid) and its ledger entry.
 *  Capped at LIST_BOOKS_MAX, in key order. */
export async function readHiddenBooks(kv) {
  const names = await listKeyNames(kv, "hidden:");
  if (names === null) return null;
  const books = [];
  for (const name of names) {
    const b = parseHiddenKey(name);
    if (!b) continue;
    let value = null;
    try {
      value = await kv.get(hiddenBookKey(b.handle, b.postId));
    } catch (e) {
      value = null;
    }
    const ledger = await getJsonRecord(kv, flagLedgerKey(b.handle, b.postId));
    books.push({
      ...b,
      value,
      manual: isManualHide(value),
      ledger: ledger && ledger.action ? ledger : null,
    });
    if (books.length >= LIST_BOOKS_MAX) break;
  }
  return books;
}

/** The decisions log: decided reports (status != "pending") plus
 *  the flag:ledger: entries (latest decision per book), merged
 *  newest first, capped at MAX_DECISIONS. A report record that
 *  cannot be read is skipped, never listed. */
export async function readDecisions(kv) {
  const out = [];
  const reportNames = await listKeyNames(kv, "report:", MAX_REPORT_GETS);
  if (reportNames === null) return null;
  for (const name of reportNames) {
    const rid = parseReportKey(name);
    if (!rid) continue;
    const rec = await getJsonRecord(kv, reportKey(rid));
    if (!rec || rec.status === "pending" || !rec.decidedAt) continue;
    out.push({
      kind: "report",
      action: rec.status,
      rid: rec.rid,
      handle: rec.handle,
      postId: rec.postId,
      title: rec.title || null,
      reason: rec.reasonText || rec.reason || "",
      by: rec.decidedBy != null ? String(rec.decidedBy) : null,
      at: new Date(rec.decidedAt).toISOString(),
      atMs: rec.decidedAt,
    });
  }
  const ledgerNames = await listKeyNames(kv, "flag:ledger:", LIST_KEYS_MAX);
  if (ledgerNames === null) return null;
  for (const name of ledgerNames) {
    const b = parseLedgerKey(name);
    if (!b) continue;
    const entry = await getJsonRecord(kv, flagLedgerKey(b.handle, b.postId));
    if (!entry || !entry.action || !entry.at) continue;
    const atMs = Date.parse(entry.at);
    out.push({
      kind: "ledger",
      action: entry.action,
      rid: null,
      handle: b.handle,
      postId: b.postId,
      title: null,
      reason: entry.reason || "",
      source: entry.source || "",
      by: entry.by || null,
      at: entry.at,
      atMs: Number.isFinite(atMs) ? atMs : 0,
    });
  }
  out.sort((a, b) => b.atMs - a.atMs);
  return out.slice(0, MAX_DECISIONS).map(({ atMs, ...rest }) => rest);
}

// --- decisions ----------------------------------------------------------

/** Read one report record. Null when absent or malformed.
 *  Throws on a KV failure — the caller answers 503, never
 *  "not found", so an outage cannot masquerade as a missing
 *  report (a decision on a missing record is refused either
 *  way, but the reason must be honest). */
async function getReportRecord(kv, rid) {
  const rec = await kv.get(reportKey(rid), "json");
  return rec && typeof rec === "object" ? rec : null;
}

/** Decide one pending report — the bot's handleReportDecision,
 *  key for key. Returns { ok:true, report } or
 *  { ok:false, error, status }. An approve whose flags:all
 *  rebuild fails returns E_FLAGS_REBUILD with partial:true — the
 *  decision + flag already landed, only the blob is stale. */
export async function decideReport(kv, rid, approve) {
  if (typeof rid !== "string" || !RID_RE.test(rid)) {
    return { ok: false, error: "E_BAD_RID", status: 400 };
  }
  let report;
  try {
    report = await getReportRecord(kv, rid);
  } catch (e) {
    return { ok: false, error: "E_KV", status: 503 };
  }
  if (!report) return { ok: false, error: "E_NO_REPORT", status: 404 };
  if (report.status !== "pending") {
    return { ok: false, error: "E_DECIDED", status: 409 };
  }
  if (approve && !canList(kv)) {
    return { ok: false, error: "E_NO_LIST", status: 503 };
  }
  const decided = {
    ...report,
    status: approve ? "approved" : "rejected",
    decidedAt: Date.now(),
    decidedBy: OWNER_TG_ID,
  };
  await kv.put(reportKey(rid), JSON.stringify(decided));
  await removePendingReportId(kv, rid);
  await clearPendingReportHold(kv, report.handle, report.postId);
  if (approve) {
    await kv.put(flagBookKey(report.handle, report.postId), "1");
    await kv.put(
      flagLedgerKey(report.handle, report.postId),
      JSON.stringify(ledgerEntry(
        "flag",
        report.reasonText || String(report.reason),
        `report:${rid}`,
      )),
    );
    try {
      await rebuildFlagsAll(kv);
    } catch (e) {
      return { ok: false, error: "E_FLAGS_REBUILD", status: 502, partial: true, report: decided };
    }
  }
  return { ok: true, report: decided };
}

/** Un-flag a book — the bot's /flags panel tap (clearFlaggedBook
 *  with source manual:<ownerId>, reason "panel unflag"). */
export async function unflagBook(kv, handle, postId) {
  const book = validBook(handle, postId);
  if (!book) return { ok: false, error: "E_BAD_BOOK", status: 400 };
  if (!canList(kv)) return { ok: false, error: "E_NO_LIST", status: 503 };
  let flagged = false;
  try {
    flagged = (await kv.get(flagBookKey(book.handle, book.postId))) !== null;
  } catch (e) {
    return { ok: false, error: "E_KV", status: 503 };
  }
  if (!flagged) return { ok: false, error: "E_NOT_FLAGGED", status: 404 };
  await kv.delete(flagBookKey(book.handle, book.postId));
  await kv.put(
    flagLedgerKey(book.handle, book.postId),
    JSON.stringify(ledgerEntry("unflag", "panel unflag", `manual:${OWNER_TG_ID}`)),
  );
  try {
    await rebuildFlagsAll(kv);
  } catch (e) {
    return { ok: false, error: "E_FLAGS_REBUILD", status: 502, partial: true };
  }
  return { ok: true, ...book };
}

/** Hide a book — the bot's /hide (hideBook with source
 *  manual:<ownerId>, reason "owner hide"). */
export async function hideBook(kv, handle, postId) {
  const book = validBook(handle, postId);
  if (!book) return { ok: false, error: "E_BAD_BOOK", status: 400 };
  if (!canList(kv)) return { ok: false, error: "E_NO_LIST", status: 503 };
  let hidden = false;
  try {
    hidden = (await kv.get(hiddenBookKey(book.handle, book.postId))) !== null;
  } catch (e) {
    return { ok: false, error: "E_KV", status: 503 };
  }
  if (hidden) return { ok: false, error: "E_ALREADY_HIDDEN", status: 409 };
  await kv.put(
    hiddenBookKey(book.handle, book.postId),
    manualHideValue(OWNER_TG_ID),
  );
  await kv.put(
    flagLedgerKey(book.handle, book.postId),
    JSON.stringify(ledgerEntry("hide", "owner hide", `manual:${OWNER_TG_ID}`)),
  );
  try {
    await rebuildFlagsAll(kv);
  } catch (e) {
    return { ok: false, error: "E_FLAGS_REBUILD", status: 502, partial: true };
  }
  return { ok: true, ...book };
}

/** Un-hide a book — the bot's /unhide panel tap (unhideBook with
 *  source manual:<ownerId>, reason "panel unhide"). */
export async function unhideBook(kv, handle, postId) {
  const book = validBook(handle, postId);
  if (!book) return { ok: false, error: "E_BAD_BOOK", status: 400 };
  if (!canList(kv)) return { ok: false, error: "E_NO_LIST", status: 503 };
  let hidden = false;
  try {
    hidden = (await kv.get(hiddenBookKey(book.handle, book.postId))) !== null;
  } catch (e) {
    return { ok: false, error: "E_KV", status: 503 };
  }
  if (!hidden) return { ok: false, error: "E_NOT_HIDDEN", status: 404 };
  await kv.delete(hiddenBookKey(book.handle, book.postId));
  await kv.put(
    flagLedgerKey(book.handle, book.postId),
    JSON.stringify(ledgerEntry("unhide", "panel unhide", `manual:${OWNER_TG_ID}`)),
  );
  try {
    await rebuildFlagsAll(kv);
  } catch (e) {
    return { ok: false, error: "E_FLAGS_REBUILD", status: 502, partial: true };
  }
  return { ok: true, ...book };
}

// --- HTTP ---------------------------------------------------------------

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "GET" && request.method !== "POST") {
    return json({ ok: false, error: "E_METHOD" }, 405);
  }
  if (!env.RLIBOOK_KV) {
    return json({ ok: false, error: "E_NO_KV" }, 503);
  }
  const kv = env.RLIBOOK_KV;

  // The fingerprint may ride in the JSON body on POST (a
  // non-browser client); the URL / bearer / cookie win first.
  let body = null;
  if (request.method === "POST") {
    try {
      body = await request.json();
    } catch (e) {
      return json({ ok: false, error: "E_BAD_JSON" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json({ ok: false, error: "E_BAD_JSON" }, 400);
    }
  }
  const fp = fingerprintFromRequest(request)
    || (body && typeof body.fp === "string" ? body.fp.trim() : "");
  const gate = await verifyOwner(env, fp);
  if (!gate.ok) {
    // A KV failure while verifying is a 503 (fail closed, honest);
    // an unknown / non-owner fingerprint is a 403 with no data.
    return json(
      { ok: false, error: gate.error === "E_KV" ? "E_KV" : "E_NOT_OWNER" },
      gate.error === "E_KV" ? 503 : 403,
    );
  }

  if (request.method === "GET") {
    if (!canList(kv)) return json({ ok: false, error: "E_NO_LIST" }, 503);
    let pending, flagged, hidden, decisions;
    try {
      ({ reports: pending } = await readPendingReports(kv, true));
      flagged = await readFlaggedBooks(kv);
      hidden = await readHiddenBooks(kv);
      decisions = await readDecisions(kv);
    } catch (e) {
      return json({ ok: false, error: "E_KV" }, 503);
    }
    if (flagged === null || hidden === null || decisions === null) {
      return json({ ok: false, error: "E_NO_LIST" }, 503);
    }
    return json({ ok: true, pending, flagged, hidden, decisions });
  }

  // POST: one decision.
  const action = String((body && body.action) || "").trim();
  let result;
  if (action === "approve" || action === "reject") {
    result = await decideReport(kv, body.rid, action === "approve");
  } else if (action === "unflag") {
    result = await unflagBook(kv, body.handle, body.postId);
  } else if (action === "hide") {
    result = await hideBook(kv, body.handle, body.postId);
  } else if (action === "unhide") {
    result = await unhideBook(kv, body.handle, body.postId);
  } else {
    return json({ ok: false, error: "E_BAD_ACTION" }, 400);
  }
  if (!result.ok) {
    return json(
      { ok: false, error: result.error, partial: result.partial || undefined },
      result.status || 400,
    );
  }
  return json({ ok: true, action, ...result });
}
