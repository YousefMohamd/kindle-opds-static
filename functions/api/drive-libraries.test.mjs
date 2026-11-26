// Test for the Drive library list (functions/api/drive-libraries.js).
// Standalone Node script — run from the repo root:
//   node functions/api/drive-libraries.test.mjs
//
// Builds a LOCAL SQLite database (node:sqlite, same engine as D1)
// with a drive_libraries registry + books rows, mocks RLIBOOK_KV
// with a Map, imports the real Function module, and calls onRequest()
// over HTTP semantics. Asserts the two-type visibility rule:
// public for everyone, private/pending only for the submitter
// (pending also for the owner). No network, no production D1/KV.
// Exit 0 = all pass.

import { DatabaseSync } from "node:sqlite";
import { onRequest } from "./drive-libraries.js";

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${extra ? " — " + extra : ""}`);
  }
}

const F_PUB = "1EFegWouzH4CXHzX2N-NfD18mJbtDLQAP";
const F_PRIV = "PRIVFOLDER1234567890";
const F_PEND = "PENDFOLDER1234567890";
const FP_SUB = "AAAAAAAAAAAAAAAAAAAAAA";
const FP_OTHER = "BBBBBBBBBBBBBBBBBBBBBB";
const FP_OWNER = "CCCCCCCCCCCCCCCCCCCCCC";
const OWNER_ID = 7283934644;

const db = new DatabaseSync(":memory:");
db.exec(`
  CREATE TABLE books (
    id INTEGER PRIMARY KEY, title TEXT NOT NULL, author TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'channel',
    ext TEXT NOT NULL DEFAULT '', size TEXT NOT NULL DEFAULT '',
    date TEXT NOT NULL DEFAULT '', url TEXT NOT NULL,
    filename TEXT NOT NULL DEFAULT '', UNIQUE(url, filename));
  CREATE TABLE drive_libraries (
    folder_id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '',
    added_by TEXT NOT NULL DEFAULT '', added_at TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    submitter_tg_id INTEGER,
    visibility TEXT NOT NULL DEFAULT 'public',
    requested_at TEXT, reviewed_at TEXT);
  INSERT INTO drive_libraries(folder_id, title, submitter_tg_id, visibility) VALUES
    ('${F_PUB}', 'Oriental Music', NULL, 'public'),
    ('${F_PRIV}', 'مكتبة خاصة', 111, 'private'),
    ('${F_PEND}', 'مكتبة بانتظار', 111, 'pending_public');
  INSERT INTO books(id,title,author,source,kind,ext,size,date,url,filename) VALUES
    (1, 'نزهة الزمان', '', 'drive:${F_PUB}', 'drive', 'PDF', '', '2025-07-03', 'https://drive.google.com/file/d/F1/view', 'a.pdf'),
    (2, 'كتاب خاص', '', 'drive:${F_PRIV}', 'drive', 'EPUB', '', '2025-07-03', 'https://drive.google.com/file/d/F2/view', 'b.epub'),
    (3, 'كتاب بانتظار', '', 'drive:${F_PEND}', 'drive', 'PDF', '', '2025-07-03', 'https://drive.google.com/file/d/F3/view', 'c.pdf');
`);

function mockD1(sqlite) {
  return {
    prepare(sql) {
      return {
        bind(...params) {
          return {
            first() {
              const row = sqlite.prepare(sql).get(...params);
              return row === undefined ? null : row;
            },
            all() {
              return { results: sqlite.prepare(sql).all(...params) };
            },
          };
        },
      };
    },
  };
}
function mockKV(entries = {}) {
  const m = new Map(Object.entries(entries));
  return { get: async (k) => (m.has(k) ? m.get(k) : null) };
}
const KV = mockKV({
  ["fp:" + FP_SUB]: JSON.stringify({ tg_id: 111, created_at: "2026-11-26" }),
  ["fp:" + FP_OTHER]: JSON.stringify({ tg_id: 222, created_at: "2026-11-26" }),
  ["fp:" + FP_OWNER]: JSON.stringify({ tg_id: OWNER_ID, created_at: "2026-11-26" }),
});

async function call(env, path) {
  const req = new Request("https://example.com" + path, { method: "GET" });
  const res = await onRequest({ request: req, env, params: {} });
  return { status: res.status, body: await res.json() };
}
const env = (extra = {}) => ({ TG_D1: mockD1(db), RLIBOOK_KV: KV, RLIBOOK_OWNER_ID: String(OWNER_ID), ...extra });
const ids = (body) => (body.libraries || []).map((l) => l.folder_id);

// 1. Anonymous: public only, with count + samples.
{
  const { status, body } = await call(env(), "/api/drive-libraries");
  check("1a status 200", status === 200, `got ${status}`);
  check("1b ok:true + registry:true", body.ok === true && body.registry === true);
  check("1c anonymous sees only the public library", JSON.stringify(ids(body)) === JSON.stringify([F_PUB]), JSON.stringify(ids(body)));
  const pub = body.libraries[0];
  check("1d count + samples", pub.count === 1 && pub.samples.includes("نزهة الزمان"), JSON.stringify(pub));
  check("1e mine:false for anonymous", pub.mine === false);
}
// 2. Submitter sees their private + pending (mine:true).
{
  const { body } = await call(env(), "/api/drive-libraries?fp=" + FP_SUB);
  check("2a submitter sees all three", ids(body).length === 3, JSON.stringify(ids(body)));
  const priv = body.libraries.find((l) => l.folder_id === F_PRIV);
  check("2b private row mine:true", priv && priv.mine === true && priv.visibility === "private");
  check("2c pending row present for submitter", body.libraries.some((l) => l.folder_id === F_PEND));
}
// 3. Another user sees public only.
{
  const { body } = await call(env(), "/api/drive-libraries?fp=" + FP_OTHER);
  check("3a other user sees public only", JSON.stringify(ids(body)) === JSON.stringify([F_PUB]), JSON.stringify(ids(body)));
}
// 4. Owner sees pending (review) but not another user's private.
{
  const { body } = await call(env(), "/api/drive-libraries?fp=" + FP_OWNER);
  check("4a owner sees pending", ids(body).includes(F_PEND), JSON.stringify(ids(body)));
  check("4b owner does NOT see private", !ids(body).includes(F_PRIV));
}
// 5. No D1 binding -> 503; no registry table -> honest empty list.
{
  const { status, body } = await call({ RLIBOOK_KV: KV }, "/api/drive-libraries");
  check("5a missing D1 -> 503", status === 503 && body.ok === false, `status=${status}`);
  const empty = new DatabaseSync(":memory:");
  empty.exec("CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, source TEXT)");
  const { status: s2, body: b2 } = await call({ TG_D1: mockD1(empty), RLIBOOK_KV: KV }, "/api/drive-libraries");
  check("5b missing registry table -> ok:true, empty, registry:false",
    s2 === 200 && b2.ok === true && b2.libraries.length === 0 && b2.registry === false,
    `status=${s2} ${JSON.stringify(b2)}`);
}
// 6. POST -> 405.
{
  const req = new Request("https://example.com/api/drive-libraries", { method: "POST" });
  const res = await onRequest({ request: req, env: env(), params: {} });
  check("6a POST -> 405", res.status === 405, `status=${res.status}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
