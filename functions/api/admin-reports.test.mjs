// Test for the owner-only reports / flags monitor API
// (functions/api/admin-reports.js). Standalone Node script — run
// from the repo root:
//   node functions/api/admin-reports.test.mjs
//
// It imports the real Function module, wraps it in a minimal mock
// of the Pages Function environment (env.RLIBOOK_KV as a Map with
// get/put/delete/list), and calls onRequest() over HTTP semantics.
// It asserts the response contract for:
//   1. the owner gate: no fp / non-owner fp -> 403 with no data;
//      owner fp via ?fp=, cookie, or Bearer -> 200;
//      missing KV -> 503; KV failure while verifying -> 503
//   2. GET lists pending / flagged / hidden / decisions, prunes
//      stale pending entries, and refuses without list()
//   3. POST approve: the bot's exact KV effects — report saved
//      approved + decidedBy, pending index + 72h hold cleared,
//      flag: = "1", ledger { action:"flag",
//      source:"report:<rid>" }, flags:all rebuilt
//   4. POST reject: report saved rejected, hold cleared, NO flag
//      and NO ledger entry (the bot writes none on reject)
//   5. POST unflag / hide / unhide: the bot's exact KV effects
//      (hidden: = "manual:<ownerId>:<ts>", ledger reasons
//      "panel unflag" / "owner hide" / "panel unhide",
//      source "manual:<ownerId>"), flags:all rebuilt each time
//   6. refusals: already-decided (409), not-flagged / not-hidden
//      (404), already-hidden (409), bad ids (400), unknown
//      action (400), malformed JSON (400), wrong method (405)
//   7. no-list KV: a mutation is refused BEFORE any write
//      (503 E_NO_LIST, no flag: key created)
//   8. the ledger `by` field is "web" (the one deliberate
//      deviation from the bot, which writes "bot")
// Exit 0 = all pass; non-zero + a message = failure.
// No network, no production KV, no deploy.
// All fingerprints / ids below are FAKE test data.

import {
  onRequest,
  OWNER_TG_ID,
  parseFlagKey,
  parseHiddenKey,
  parseLedgerKey,
  parseReportKey,
  manualHideValue,
  ledgerEntry,
  verifyOwner,
} from "./admin-reports.js";

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log("  PASS " + name);
  } else {
    fail++;
    console.log("  FAIL " + name + (extra ? " — " + extra : ""));
  }
}

const OWNER_FP = "abcdefghijklmnopqrstuv"; // 22 chars, fake
const OTHER_FP = "0123456789abcdefghijkl"; // 22 chars, fake
const RID1 = "a1b2c3d4e5f6";
const RID2 = "b2c3d4e5f6a7";
const RID3 = "c3d4e5f6a7b8";

function report(rid, over = {}) {
  return {
    rid,
    handle: "books_p",
    postId: "11692",
    title: "كتاب مُبلَّغ عنه",
    author: "مؤلف تجريبي",
    source: "books_p",
    reporterId: 999,
    reason: "commercial",
    reasonText: "",
    status: "pending",
    createdAt: 1794000000000,
    decidedAt: null,
    decidedBy: null,
    ...over,
  };
}

// --- mocks -------------------------------------------------------------
function makeKv(initial = {}, opts = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    async get(key, type) {
      if (opts.failGet) throw new Error("KV down");
      const v = map.get(key);
      if (v === undefined) return null;
      if (type === "json") {
        try { return JSON.parse(v); } catch { return null; }
      }
      return v;
    },
    async put(key, value) { map.set(key, String(value)); },
    async delete(key) { map.delete(key); },
    ...(opts.noList ? {} : {
      async list({ prefix, limit = 1000, cursor } = {}) {
        const names = [...map.keys()]
          .filter((k) => k.startsWith(prefix || ""))
          .sort();
        const start = cursor ? Number(cursor) || 0 : 0;
        const page = names.slice(start, start + limit);
        const next = start + page.length;
        return {
          keys: page.map((name) => ({ name })),
          list_complete: next >= names.length,
          cursor: next >= names.length ? undefined : String(next),
        };
      },
    }),
  };
}

function seededKv() {
  return makeKv({
    ["fp:" + OWNER_FP]: JSON.stringify({ tg_id: OWNER_TG_ID, created_at: "2026-11-20T00:00:00Z" }),
    ["fp:" + OTHER_FP]: JSON.stringify({ tg_id: 111, created_at: "2026-11-20T00:00:00Z" }),
    ["report:" + RID1]: JSON.stringify(report(RID1)),
    ["report:" + RID2]: JSON.stringify(report(RID2, {
      handle: "chan2", postId: "42", title: "كتاب محسوم",
      status: "approved", decidedAt: 1794000100000, decidedBy: OWNER_TG_ID,
    })),
    ["report:" + RID3]: JSON.stringify(report(RID3, {
      handle: "chan3", postId: "7", title: "كتاب مرفوض",
      reason: "wronginfo", reasonText: "",
    })),
    [ "reports:pending"]: JSON.stringify([RID1, RID2, "deadbeef1234", RID3]),
    ["report:pending:books_p:11692"]: RID1,
    ["report:pending:chan3:7"]: RID3,
    ["flag:flagchan:50"]: "1",
    ["flag:ledger:flagchan:50"]: JSON.stringify({
      action: "flag", reason: "commercial", source: "report:0123456789ab",
      at: "2026-11-20T10:00:00.000Z", by: "bot",
    }),
    ["hidden:hidechan:7"]: "manual:7283934644:1794000000000",
    ["flag:ledger:hidechan:7"]: JSON.stringify({
      action: "hide", reason: "owner hide", source: "manual:7283934644",
      at: "2026-11-20T11:00:00.000Z", by: "bot",
    }),
    ["flags:all"]: JSON.stringify({ flagged: ["flagchan:50"], hidden: ["hidechan:7"] }),
  });
}

function makeEnv(kv) {
  return kv === undefined ? {} : { RLIBOOK_KV: kv };
}

async function call(env, url, opts = {}) {
  const init = { method: opts.method || "GET", headers: opts.headers || {} };
  if (opts.body !== undefined) init.body = opts.body;
  const res = await onRequest({
    request: new Request(url, init),
    env,
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, text, body };
}

const API = "https://rlibook.tech/api/admin-reports";
const OWNER_Q = API + "?fp=" + OWNER_FP;

// --- 1. owner gate -------------------------------------------------------
{
  const kv = seededKv();
  const noFp = await call(makeEnv(kv), API);
  check("1 GET no fp -> 403, no data",
    noFp.status === 403 && noFp.body && noFp.body.error === "E_NOT_OWNER"
    && !noFp.text.includes("كتاب مُبلَّغ عنه") && !noFp.text.includes("books_p"));
  const other = await call(makeEnv(kv), API + "?fp=" + OTHER_FP);
  check("1 GET non-owner fp -> 403, no data",
    other.status === 403 && !other.text.includes("كتاب مُبلَّغ عنه"));
  const bad = await call(makeEnv(kv), API + "?fp=zzzzzzzzzzzzzzzzzzzzzz");
  check("1 GET unknown fp -> 403", bad.status === 403);
  const noKv = await call(makeEnv(undefined), OWNER_Q);
  check("1 GET missing KV -> 503 E_NO_KV",
    noKv.status === 503 && noKv.body.error === "E_NO_KV");
  const down = makeKv({
    ["fp:" + OWNER_FP]: JSON.stringify({ tg_id: OWNER_TG_ID }),
  }, { failGet: true });
  const kvDown = await call(makeEnv(down), OWNER_Q);
  check("1 GET KV failure while verifying -> 503 E_KV, no data",
    kvDown.status === 503 && kvDown.body.error === "E_KV"
    && !kvDown.text.includes("كتاب"));
  const v = await verifyOwner({ RLIBOOK_KV: kv }, OWNER_FP);
  check("1 verifyOwner: owner fp -> ok", v.ok === true && v.tgId === OWNER_TG_ID);
}

// --- 2. GET lists ----------------------------------------------------------
{
  const kv = seededKv();
  const r = await call(makeEnv(kv), OWNER_Q);
  check("2 GET owner -> 200 ok", r.status === 200 && r.body.ok === true);
  check("2 pending: only the pending report (decided + stale excluded)",
    Array.isArray(r.body.pending) && r.body.pending.length === 2
    && r.body.pending.some((x) => x.rid === RID1)
    && r.body.pending.some((x) => x.rid === RID3)
    && !r.body.pending.some((x) => x.rid === RID2));
  check("2 pending: report carries title + reason + reporter",
    r.body.pending.find((x) => x.rid === RID1).title === "كتاب مُبلَّغ عنه"
    && r.body.pending.find((x) => x.rid === RID1).reporterId === 999);
  check("2 stale pending entries pruned from the index",
    JSON.parse(kv.map.get("reports:pending")).length === 2
    && !kv.map.get("reports:pending").includes("deadbeef1234")
    && !kv.map.get("reports:pending").includes(RID2));
  check("2 flagged: flagchan:50 with its ledger entry",
    r.body.flagged.length === 1 && r.body.flagged[0].handle === "flagchan"
    && r.body.flagged[0].postId === "50"
    && r.body.flagged[0].ledger && r.body.flagged[0].ledger.action === "flag");
  check("2 hidden: hidechan:7, manual hide",
    r.body.hidden.length === 1 && r.body.hidden[0].handle === "hidechan"
    && r.body.hidden[0].manual === true
    && r.body.hidden[0].value.startsWith("manual:7283934644:"));
  check("2 decisions: decided report + ledger entries, newest first",
    Array.isArray(r.body.decisions) && r.body.decisions.length === 3
    && r.body.decisions[0].at >= r.body.decisions[1].at
    && r.body.decisions.some((d) => d.kind === "report" && d.rid === RID2 && d.action === "approved")
    && r.body.decisions.some((d) => d.kind === "ledger" && d.action === "flag")
    && r.body.decisions.some((d) => d.kind === "ledger" && d.action === "hide"));
  const cookie = await call(makeEnv(seededKv()), API, {
    headers: { Cookie: "rlb_fp=" + OWNER_FP },
  });
  check("2 GET via rlb_fp cookie -> 200", cookie.status === 200 && cookie.body.ok === true);
  const bearer = await call(makeEnv(seededKv()), API, {
    headers: { Authorization: "Bearer " + OWNER_FP },
  });
  check("2 GET via Authorization Bearer -> 200", bearer.status === 200 && bearer.body.ok === true);
  const noList = await call(makeEnv(makeKv({
    ["fp:" + OWNER_FP]: JSON.stringify({ tg_id: OWNER_TG_ID }),
  }, { noList: true })), OWNER_Q);
  check("2 GET without KV list() -> 503 E_NO_LIST",
    noList.status === 503 && noList.body.error === "E_NO_LIST");
}

// --- 3. POST approve -------------------------------------------------------
{
  const kv = seededKv();
  const r = await call(makeEnv(kv), OWNER_Q, {
    method: "POST",
    body: JSON.stringify({ action: "approve", rid: RID1 }),
  });
  check("3 approve -> 200 ok", r.status === 200 && r.body.ok === true && r.body.action === "approve");
  const saved = JSON.parse(kv.map.get("report:" + RID1));
  check("3 approve: report saved approved + decidedBy owner",
    saved.status === "approved" && saved.decidedBy === OWNER_TG_ID
    && Number.isSafeInteger(saved.decidedAt));
  check("3 approve: pending index + 72h hold cleared",
    !JSON.parse(kv.map.get("reports:pending")).includes(RID1)
    && !kv.map.has("report:pending:books_p:11692"));
  check("3 approve: flag: key set to \"1\"",
    kv.map.get("flag:books_p:11692") === "1");
  const ledger = JSON.parse(kv.map.get("flag:ledger:books_p:11692"));
  check("3 approve: ledger flag, source report:<rid>, reason = reason code",
    ledger.action === "flag" && ledger.source === "report:" + RID1
    && ledger.reason === "commercial" && ledger.by === "web" && !!ledger.at);
  const blob = JSON.parse(kv.map.get("flags:all"));
  check("3 approve: flags:all rebuilt with the new flag",
    blob.flagged.includes("books_p:11692") && blob.flagged.includes("flagchan:50")
    && blob.hidden.includes("hidechan:7"));
  const again = await call(makeEnv(kv), OWNER_Q, {
    method: "POST",
    body: JSON.stringify({ action: "approve", rid: RID1 }),
  });
  check("3 approve again -> 409 E_DECIDED, decidedAt unchanged",
    again.status === 409 && again.body.error === "E_DECIDED"
    && JSON.parse(kv.map.get("report:" + RID1)).decidedAt === saved.decidedAt);
}

// --- 4. POST reject ----------------------------------------------------------
{
  const kv = seededKv();
  const r = await call(makeEnv(kv), OWNER_Q, {
    method: "POST",
    body: JSON.stringify({ action: "reject", rid: RID3 }),
  });
  check("4 reject -> 200 ok", r.status === 200 && r.body.ok === true);
  const saved = JSON.parse(kv.map.get("report:" + RID3));
  check("4 reject: report saved rejected + decidedBy owner",
    saved.status === "rejected" && saved.decidedBy === OWNER_TG_ID);
  check("4 reject: pending index + hold cleared",
    !JSON.parse(kv.map.get("reports:pending")).includes(RID3)
    && !kv.map.has("report:pending:chan3:7"));
  check("4 reject: NO flag: key, NO ledger entry (bot writes none)",
    !kv.map.has("flag:chan3:7") && !kv.map.has("flag:ledger:chan3:7"));
  const blob = JSON.parse(kv.map.get("flags:all"));
  check("4 reject: flags:all untouched",
    blob.flagged.length === 1 && blob.hidden.length === 1);
}

// --- 5. unflag / hide / unhide ----------------------------------------------
{
  const kv = seededKv();
  const unflag = await call(makeEnv(kv), OWNER_Q, {
    method: "POST",
    body: JSON.stringify({ action: "unflag", handle: "flagchan", postId: "50" }),
  });
  check("5 unflag -> 200 ok", unflag.status === 200 && unflag.body.ok === true);
  check("5 unflag: flag: deleted",
    !kv.map.has("flag:flagchan:50"));
  const l1 = JSON.parse(kv.map.get("flag:ledger:flagchan:50"));
  check("5 unflag: ledger unflag, reason panel unflag, source manual:<owner>",
    l1.action === "unflag" && l1.reason === "panel unflag"
    && l1.source === "manual:" + OWNER_TG_ID && l1.by === "web");
  check("5 unflag: flags:all rebuilt without the flag",
    JSON.parse(kv.map.get("flags:all")).flagged.length === 0);

  const hide = await call(makeEnv(kv), OWNER_Q, {
    method: "POST",
    body: JSON.stringify({ action: "hide", handle: "newchan", postId: "99" }),
  });
  check("5 hide -> 200 ok", hide.status === 200 && hide.body.ok === true);
  check("5 hide: hidden: = manual:<owner>:<ts>",
    /^manual:7283934644:\d+$/.test(kv.map.get("hidden:newchan:99") || ""));
  const l2 = JSON.parse(kv.map.get("flag:ledger:newchan:99"));
  check("5 hide: ledger hide, reason owner hide",
    l2.action === "hide" && l2.reason === "owner hide"
    && l2.source === "manual:" + OWNER_TG_ID);
  check("5 hide: flags:all rebuilt with the hidden book",
    JSON.parse(kv.map.get("flags:all")).hidden.includes("newchan:99"));

  const hideAgain = await call(makeEnv(kv), OWNER_Q, {
    method: "POST",
    body: JSON.stringify({ action: "hide", handle: "newchan", postId: "99" }),
  });
  check("5 hide already-hidden -> 409 E_ALREADY_HIDDEN, value unchanged",
    hideAgain.status === 409 && hideAgain.body.error === "E_ALREADY_HIDDEN"
    && /^manual:7283934644:\d+$/.test(kv.map.get("hidden:newchan:99") || ""));

  const unhide = await call(makeEnv(kv), OWNER_Q, {
    method: "POST",
    body: JSON.stringify({ action: "unhide", handle: "hidechan", postId: "7" }),
  });
  check("5 unhide -> 200 ok", unhide.status === 200 && unhide.body.ok === true);
  check("5 unhide: hidden: deleted",
    !kv.map.has("hidden:hidechan:7"));
  const l3 = JSON.parse(kv.map.get("flag:ledger:hidechan:7"));
  check("5 unhide: ledger unhide, reason panel unhide",
    l3.action === "unhide" && l3.reason === "panel unhide"
    && l3.source === "manual:" + OWNER_TG_ID);
  check("5 unhide: flags:all rebuilt without the hidden book",
    !JSON.parse(kv.map.get("flags:all")).hidden.includes("hidechan:7"));
}

// --- 6. refusals ---------------------------------------------------------------
{
  const kv = seededKv();
  const cases = [
    ["6 unknown action -> 400 E_BAD_ACTION", { action: "explode" }, 400, "E_BAD_ACTION"],
    ["6 bad rid -> 400 E_BAD_RID", { action: "approve", rid: "xyz" }, 400, "E_BAD_RID"],
    ["6 unknown rid -> 404 E_NO_REPORT", { action: "approve", rid: "0123456789ab" }, 404, "E_NO_REPORT"],
    ["6 unflag not-flagged -> 404 E_NOT_FLAGGED", { action: "unflag", handle: "nope", postId: "1" }, 404, "E_NOT_FLAGGED"],
    ["6 unhide not-hidden -> 404 E_NOT_HIDDEN", { action: "unhide", handle: "nope", postId: "1" }, 404, "E_NOT_HIDDEN"],
    ["6 bad handle -> 400 E_BAD_BOOK", { action: "hide", handle: "bad handle!", postId: "1" }, 400, "E_BAD_BOOK"],
    ["6 bad post -> 400 E_BAD_BOOK", { action: "hide", handle: "ok", postId: "abc" }, 400, "E_BAD_BOOK"],
    ["6 reject decided report -> 409 E_DECIDED", { action: "reject", rid: RID2 }, 409, "E_DECIDED"],
  ];
  for (const [name, payload, status, error] of cases) {
    const r = await call(makeEnv(kv), OWNER_Q, { method: "POST", body: JSON.stringify(payload) });
    check(name, r.status === status && r.body.error === error, `got ${r.status} ${r.body && r.body.error}`);
  }
  const badJson = await call(makeEnv(kv), OWNER_Q, { method: "POST", body: "{not json" });
  check("6 malformed JSON body -> 400 E_BAD_JSON",
    badJson.status === 400 && badJson.body.error === "E_BAD_JSON");
  const put = await call(makeEnv(kv), OWNER_Q, { method: "PUT" });
  check("6 PUT -> 405 E_METHOD", put.status === 405 && put.body.error === "E_METHOD");
  // Non-owner POST writes nothing.
  const before = JSON.stringify([...seededKv().map.entries()].sort());
  const kv2 = seededKv();
  const denied = await call(makeEnv(kv2), API + "?fp=" + OTHER_FP, {
    method: "POST",
    body: JSON.stringify({ action: "approve", rid: RID1 }),
  });
  const after = JSON.stringify([...kv2.map.entries()].sort());
  check("6 non-owner POST -> 403 and KV unchanged",
    denied.status === 403 && before === after);
  // Fingerprint in the JSON body also gates.
  const bodyFp = await call(makeEnv(seededKv()), API, {
    method: "POST",
    body: JSON.stringify({ action: "reject", rid: RID3, fp: OWNER_FP }),
  });
  check("6 POST with fp in JSON body -> 200",
    bodyFp.status === 200 && bodyFp.body.ok === true);
}

// --- 7. no-list KV: mutation refused BEFORE any write ---------------------------
{
  const kv = makeKv({
    ["fp:" + OWNER_FP]: JSON.stringify({ tg_id: OWNER_TG_ID }),
    ["report:" + RID1]: JSON.stringify(report(RID1)),
    ["reports:pending"]: JSON.stringify([RID1]),
    ["report:pending:books_p:11692"]: RID1,
  }, { noList: true });
  const r = await call(makeEnv(kv), OWNER_Q, {
    method: "POST",
    body: JSON.stringify({ action: "approve", rid: RID1 }),
  });
  check("7 approve without KV list() -> 503 E_NO_LIST",
    r.status === 503 && r.body.error === "E_NO_LIST");
  check("7 no-list approve wrote NOTHING (no flag, report still pending)",
    !kv.map.has("flag:books_p:11692")
    && JSON.parse(kv.map.get("report:" + RID1)).status === "pending"
    && kv.map.has("report:pending:books_p:11692"));
  // Reject needs no rebuild, so it still works without list().
  const rej = await call(makeEnv(kv), OWNER_Q, {
    method: "POST",
    body: JSON.stringify({ action: "reject", rid: RID1 }),
  });
  check("7 reject without KV list() still works (no rebuild needed)",
    rej.status === 200 && rej.body.ok === true);
}

// --- 8. pure helpers --------------------------------------------------------------
{
  check("8 parseFlagKey: flag:ledger: never parses as a book",
    parseFlagKey("flag:ledger:books_p:11692") === null);
  check("8 parseFlagKey: flags:all never parses as a book",
    parseFlagKey("flags:all") === null);
  check("8 parseFlagKey: a real flag key parses",
    JSON.stringify(parseFlagKey("flag:books_p:11692")) === JSON.stringify({ handle: "books_p", postId: "11692" }));
  check("8 parseHiddenKey parses",
    JSON.stringify(parseHiddenKey("hidden:hidechan:7")) === JSON.stringify({ handle: "hidechan", postId: "7" }));
  check("8 parseLedgerKey parses",
    JSON.stringify(parseLedgerKey("flag:ledger:books_p:11692")) === JSON.stringify({ handle: "books_p", postId: "11692" }));
  check("8 parseReportKey: reports:pending / report:pending: / report:dup: never parse",
    parseReportKey("reports:pending") === null
    && parseReportKey("report:pending:books_p:11692") === null
    && parseReportKey("report:dup:books_p:11692:999") === null
    && parseReportKey("report:a1b2c3d4e5f6") === "a1b2c3d4e5f6");
  check("8 manualHideValue format",
    /^manual:7283934644:\d+$/.test(manualHideValue(7283934644)));
  const e = ledgerEntry("flag", "commercial", "report:a1b2c3d4e5f6");
  check("8 ledgerEntry shape (by is web, not bot)",
    e.action === "flag" && e.reason === "commercial"
    && e.source === "report:a1b2c3d4e5f6" && e.by === "web" && !!e.at);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
