// Test for the owner-only monitor page (functions/admin/reports.js).
// Standalone Node script — run from the repo root:
//   node functions/admin/reports.test.mjs
//
// It imports the real Function module, wraps it in a minimal mock
// of the Pages Function environment (env.RLIBOOK_KV as a Map with
// get/put/delete/list), and calls onRequest() over HTTP semantics.
// It asserts the response contract for:
//   1. no fp / non-owner fp -> 403, no report data, no handles,
//      only the owner-entry instructions
//   2. owner fp via ?fp= -> 200 with all four sections (pending,
//      flagged, hidden, decisions), action buttons, and the
//      rlb_fp cookie set
//   3. owner via rlb_fp cookie -> 200 (no ?fp= needed)
//   4. missing KV -> 503; KV without list() -> 503
//   5. POST -> 405
//   6. HTML escaping (a report title containing markup is escaped)
//   7. empty states when nothing is pending / flagged / hidden
// Exit 0 = all pass; non-zero + a message = failure.
// No network, no production KV, no deploy.
// All fingerprints / ids below are FAKE test data.

import { onRequest } from "./reports.js";
import { OWNER_TG_ID } from "../api/admin-reports.js";

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

function makeKv(initial = {}, opts = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    async get(key, type) {
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
    ["report:" + RID1]: JSON.stringify({
      rid: RID1, handle: "books_p", postId: "11692",
      title: "كتاب مُبلَّغ عنه", author: "مؤلف تجريبي", source: "books_p",
      reporterId: 999, reason: "commercial", reasonText: "",
      status: "pending", createdAt: 1794000000000, decidedAt: null, decidedBy: null,
    }),
    ["reports:pending"]: JSON.stringify([RID1]),
    ["report:pending:books_p:11692"]: RID1,
    ["flag:flagchan:50"]: "1",
    ["flag:ledger:flagchan:50"]: JSON.stringify({
      action: "flag", reason: "commercial", source: "report:0123456789ab",
      at: "2026-11-20T10:00:00.000Z", by: "bot",
    }),
    ["hidden:hidechan:7"]: "manual:7283934644:1794000000000",
    ["flags:all"]: JSON.stringify({ flagged: ["flagchan:50"], hidden: ["hidechan:7"] }),
  });
}

const PAGE = "https://rlibook.tech/admin/reports";

async function call(env, url, opts = {}) {
  const res = await onRequest({
    request: new Request(url, {
      method: opts.method || "GET",
      headers: opts.headers || {},
    }),
    env,
  });
  return {
    status: res.status,
    text: await res.text(),
    setCookie: res.headers.get("set-cookie"),
    cacheControl: res.headers.get("cache-control"),
  };
}

// 1. Gate: no data leaks to a non-owner.
{
  const kv = seededKv();
  const noFp = await call({ RLIBOOK_KV: kv }, PAGE);
  check("1 no fp -> 403, no report data, no handles",
    noFp.status === 403
    && !noFp.text.includes("كتاب مُبلَّغ عنه")
    && !noFp.text.includes("books_p")
    && !noFp.text.includes("flagchan")
    && noFp.text.includes("للمالك فقط"));
  const other = await call({ RLIBOOK_KV: kv }, PAGE + "?fp=" + OTHER_FP);
  check("1 non-owner fp -> 403, no data",
    other.status === 403 && !other.text.includes("كتاب مُبلَّغ عنه"));
  const unknown = await call({ RLIBOOK_KV: kv }, PAGE + "?fp=zzzzzzzzzzzzzzzzzzzzzz");
  check("1 unknown fp -> 403", unknown.status === 403);
}

// 2. Owner via ?fp=: all four sections + buttons + cookie.
{
  const kv = seededKv();
  const r = await call({ RLIBOOK_KV: kv }, PAGE + "?fp=" + OWNER_FP);
  check("2 owner -> 200", r.status === 200);
  check("2 pending section: title + approve/reject buttons",
    r.text.includes("بلاغات معلّقة (1)")
    && r.text.includes("كتاب مُبلَّغ عنه")
    && r.text.includes('data-action="approve"')
    && r.text.includes('data-action="reject"')
    && r.text.includes('data-rid="' + RID1 + '"'));
  check("2 flagged section: book + unflag/hide buttons",
    r.text.includes("كتب معلَّمة 🚩 (1)")
    && r.text.includes("flagchan/50")
    && r.text.includes('data-action="unflag"')
    && r.text.includes('data-action="hide"'));
  check("2 hidden section: book + unhide button",
    r.text.includes("كتب مخفية (1)")
    && r.text.includes("hidechan/7")
    && r.text.includes('data-action="unhide"'));
  check("2 decisions log section present",
    r.text.includes("سجل القرارات")
    && r.text.includes("تعليم 🚩"));
  check("2 owner ?fp= visit sets the rlb_fp cookie",
    (r.setCookie || "").startsWith("rlb_fp=" + OWNER_FP));
  check("2 owner page is no-store",
    r.cacheControl === "no-store");
}

// 3. Owner via cookie (no ?fp=).
{
  const kv = seededKv();
  const r = await call({ RLIBOOK_KV: kv }, PAGE, {
    headers: { Cookie: "rlb_fp=" + OWNER_FP },
  });
  check("3 owner via cookie -> 200 with the pending report",
    r.status === 200 && r.text.includes("كتاب مُبلَّغ عنه"));
  check("3 cookie visit sets no new cookie",
    r.setCookie === null || r.setCookie === "");
}

// 4. Missing KV / no list / wrong method.
{
  const noKv = await call({}, PAGE + "?fp=" + OWNER_FP);
  check("4 missing KV -> 503", noKv.status === 503);
  const noListKv = makeKv({
    ["fp:" + OWNER_FP]: JSON.stringify({ tg_id: OWNER_TG_ID }),
  }, { noList: true });
  const noList = await call({ RLIBOOK_KV: noListKv }, PAGE + "?fp=" + OWNER_FP);
  check("4 KV without list() -> 503", noList.status === 503);
  const post = await call({ RLIBOOK_KV: seededKv() }, PAGE + "?fp=" + OWNER_FP, { method: "POST" });
  check("4 POST -> 405", post.status === 405);
}

// 5. HTML escaping.
{
  const kv = seededKv();
  const evil = "a1b2c3d4e5f7";
  kv.map.set("report:" + evil, JSON.stringify({
    rid: evil, handle: "x", postId: "1",
    title: "<script>alert(1)</script>", author: "A & B", source: "x",
    reporterId: 1, reason: "other", reasonText: "<b>evil</b>",
    status: "pending", createdAt: 1794000000000, decidedAt: null, decidedBy: null,
  }));
  kv.map.set("reports:pending", JSON.stringify([evil]));
  const r = await call({ RLIBOOK_KV: kv }, PAGE + "?fp=" + OWNER_FP);
  check("5 title markup escaped",
    r.text.includes("&lt;script&gt;") && !r.text.includes("<script>alert"));
  check("5 reason text escaped",
    r.text.includes("&lt;b&gt;evil&lt;/b&gt;") && !r.text.includes("<b>evil</b>"));
  check("5 author ampersand escaped", r.text.includes("A &amp; B"));
}

// 6. Empty states.
{
  const kv = makeKv({
    ["fp:" + OWNER_FP]: JSON.stringify({ tg_id: OWNER_TG_ID }),
    ["reports:pending"]: JSON.stringify([]),
  });
  const r = await call({ RLIBOOK_KV: kv }, PAGE + "?fp=" + OWNER_FP);
  check("6 empty queue -> honest empty states",
    r.status === 200
    && r.text.includes("بلاغات معلّقة (0)")
    && r.text.includes("لا توجد بلاغات معلّقة")
    && r.text.includes("لا توجد كتب معلَّمة")
    && r.text.includes("لا توجد كتب مخفية")
    && r.text.includes("لا توجد قرارات بعد"));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
