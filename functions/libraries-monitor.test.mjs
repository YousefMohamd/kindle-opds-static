// Test for the owner-only library monitor (functions/libraries-monitor.js).
// Standalone Node script — run from the repo root:
//   node functions/libraries-monitor.test.mjs
//
// Builds a LOCAL SQLite database (node:sqlite, same engine as D1)
// with a drive_libraries registry + books + drive_health rows, mocks
// RLIBOOK_KV with a Map, imports the real Function module, and calls
// onRequest(). Asserts: owner gating (fingerprint and key), no leak
// to anonymous callers, pending_public listed first with counts,
// samples and unavailable counts, approve/reject POSTs update the
// registry, and non-owners cannot write. No network, no production
// D1/KV. Exit 0 = all pass.

import { DatabaseSync } from "node:sqlite";
import { onRequest } from "./libraries-monitor.js";

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
const FP_OWNER = "CCCCCCCCCCCCCCCCCCCCCC";
const OWNER_ID = 7283934644;
const MON_KEY = "monitor-test-key";

function buildDb() {
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
    CREATE TABLE drive_health (
      file_id TEXT PRIMARY KEY, available INTEGER NOT NULL DEFAULT 1);
    INSERT INTO drive_libraries(folder_id, title, submitter_tg_id, visibility) VALUES
      ('${F_PUB}', 'Oriental Music', NULL, 'public'),
      ('${F_PRIV}', 'مكتبة خاصة', 111, 'private'),
      ('${F_PEND}', 'مكتبة بانتظار', 111, 'pending_public');
    INSERT INTO books(id,title,author,source,kind,ext,size,date,url,filename) VALUES
      (1, 'نزهة الزمان', '', 'drive:${F_PUB}', 'drive', 'PDF', '', '2025-07-03', 'https://drive.google.com/file/d/F1/view', 'a.pdf'),
      (2, 'كتاب ميت', '', 'drive:${F_PUB}', 'drive', 'PDF', '', '2025-07-03', 'https://drive.google.com/file/d/F9/view', 'd.pdf'),
      (3, 'كتاب خاص', '', 'drive:${F_PRIV}', 'drive', 'EPUB', '', '2025-07-03', 'https://drive.google.com/file/d/F2/view', 'b.epub'),
      (4, 'كتاب بانتظار', '', 'drive:${F_PEND}', 'drive', 'PDF', '', '2025-07-03', 'https://drive.google.com/file/d/F3/view', 'c.pdf');
    INSERT INTO drive_health(file_id, available) VALUES ('F9', 0);
  `);
  return db;
}

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
            run() {
              sqlite.prepare(sql).run(...params);
              return { success: true };
            },
          };
        },
      };
    },
  };
}
function mockKV(entries = {}) {
  const m = new Map(Object.entries(entries));
  const kv = {
    get: async (k) => (m.has(k) ? m.get(k) : null),
    put: async (k, v) => { m.set(k, v); },
  };
  kv._map = m;
  return kv;
}
const KV = mockKV({
  ["fp:" + FP_SUB]: JSON.stringify({ tg_id: 111, created_at: "2026-11-26" }),
  ["fp:" + FP_OWNER]: JSON.stringify({ tg_id: OWNER_ID, created_at: "2026-11-26" }),
});

async function call(env, path, method = "GET", form = null) {
  const init = { method };
  if (form) {
    init.body = new FormData();
    for (const [k, v] of Object.entries(form)) init.body.append(k, v);
  }
  const req = new Request("https://example.com" + path, init);
  const res = await onRequest({ request: req, env, params: {} });
  return { status: res.status, headers: res.headers, text: await res.text() };
}
const env = (db, extra = {}) => ({
  TG_D1: mockD1(db), RLIBOOK_KV: KV,
  RLIBOOK_OWNER_ID: String(OWNER_ID),
  LIBRARY_MONITOR_KEY: MON_KEY, ...extra,
});

// 1. Anonymous GET -> 403, no titles leaked.
{
  const db = buildDb();
  const { status, text } = await call(env(db), "/libraries/monitor");
  check("1a anonymous GET -> 403", status === 403, `status=${status}`);
  check("1b anonymous sees no titles", !text.includes("مكتبة بانتظار") && !text.includes("نزهة الزمان"));
}
// 2. Owner fingerprint GET -> 200, pending first, counts + samples.
{
  const db = buildDb();
  const { status, text } = await call(env(db), "/libraries/monitor?fp=" + FP_OWNER);
  check("2a owner fp GET -> 200", status === 200, `status=${status}`);
  check("2b pending listed (Arabic status label)", text.includes("مكتبة بانتظار") && text.includes("بانتظار النشر"));
  check("2b2 approve/reject form carries the fp as a hidden input",
    text.includes('name="fp"') && text.includes('name="folder_id"'));
  check("2c public + private listed", text.includes("Oriental Music") && text.includes("مكتبة خاصة"));
  check("2d pending before public", text.indexOf("مكتبة بانتظار") < text.indexOf("Oriental Music"));
  check("2e sample title shown", text.includes("نزهة الزمان"));
  check("2f unavailable count shown", text.includes("غير متاح") || text.includes("1 غير متاح"));
}
// 3. Key auth GET -> 200; submitter fp -> 403.
{
  const db = buildDb();
  const { status } = await call(env(db), "/libraries/monitor?key=" + MON_KEY);
  check("3a monitor key GET -> 200", status === 200, `status=${status}`);
  const { status: s2 } = await call(env(db), "/libraries/monitor?fp=" + FP_SUB);
  check("3b submitter fp GET -> 403", s2 === 403, `status=${s2}`);
  const { status: s3 } = await call(env(db), "/libraries/monitor?key=wrong");
  check("3c wrong key -> 403", s3 === 403, `status=${s3}`);
}
// 4. Approve: POST (owner fp) flips pending_public -> public, 303.
// POST auth comes from the form body (hidden fp/key inputs), and the
// folder field is `folder_id` — same shape the page's own form posts.
{
  const db = buildDb();
  const { status, headers } = await call(env(db), "/libraries/monitor", "POST", { action: "approve", folder_id: F_PEND, fp: FP_OWNER });
  check("4a approve POST -> 303 redirect", status === 303 && (headers.get("location") || "").includes("/libraries/monitor"), `status=${status}`);
  const row = db.prepare("SELECT visibility FROM drive_libraries WHERE folder_id = ?").get(F_PEND);
  check("4b registry now public", row.visibility === "public", JSON.stringify(row));
  const reviewed = db.prepare("SELECT reviewed_at FROM drive_libraries WHERE folder_id = ?").get(F_PEND);
  check("4c reviewed_at stamped", reviewed.reviewed_at !== null, JSON.stringify(reviewed));
}
// 5. Reject: POST flips pending_public -> private (stays with submitter).
{
  const db = buildDb();
  const { status } = await call(env(db), "/libraries/monitor", "POST", { action: "reject", folder_id: F_PEND, fp: FP_OWNER });
  check("5a reject POST -> 303", status === 303, `status=${status}`);
  const row = db.prepare("SELECT visibility FROM drive_libraries WHERE folder_id = ?").get(F_PEND);
  check("5b registry now private", row.visibility === "private", JSON.stringify(row));
}
// 6. Non-owner POST -> 403 and no write; bad folder -> 400.
{
  const db = buildDb();
  const { status } = await call(env(db), "/libraries/monitor", "POST", { action: "approve", folder_id: F_PEND, fp: FP_SUB });
  check("6a submitter POST -> 403", status === 403, `status=${status}`);
  const row = db.prepare("SELECT visibility FROM drive_libraries WHERE folder_id = ?").get(F_PEND);
  check("6b no write happened", row.visibility === "pending_public", JSON.stringify(row));
  const { status: s2 } = await call(env(db), "/libraries/monitor", "POST", { action: "approve", folder_id: "NOPEFOLDER1234567890", fp: FP_OWNER });
  check("6c unknown folder -> 400", s2 === 400, `status=${s2}`);
  const { status: s3 } = await call(env(db), "/libraries/monitor", "POST", { action: "explode", folder_id: F_PEND, fp: FP_OWNER });
  check("6d unknown action -> 400", s3 === 400, `status=${s3}`);
}

// 7. Build 2: approve/reject writes the drive:surfaces-stale KV
// marker (the telegram-drive sweep consumes it to regenerate the
// public surfaces); a KV failure never fails the approve itself.
{
  const db = buildDb();
  const kv = mockKV({
    ["fp:" + FP_OWNER]: JSON.stringify({ tg_id: OWNER_ID, created_at: "2026-11-26" }),
  });
  const e = env(db, { RLIBOOK_KV: kv });
  const { status } = await call(e, "/libraries/monitor", "POST", { action: "approve", folder_id: F_PEND, fp: FP_OWNER });
  check("7a approve POST -> 303", status === 303, `status=${status}`);
  const raw = kv._map.get("drive:surfaces-stale");
  check("7b marker written", typeof raw === "string", `marker=${raw}`);
  const marker = JSON.parse(raw || "{}");
  check("7c marker carries folder + new visibility + title",
    marker.folder_id === F_PEND && marker.visibility === "public" && marker.title === "مكتبة بانتظار",
    JSON.stringify(marker));
  check("7d marker carries the submitter", marker.submitter_tg_id === 111, JSON.stringify(marker));
}
{
  const db = buildDb();
  const kv = mockKV({
    ["fp:" + FP_OWNER]: JSON.stringify({ tg_id: OWNER_ID, created_at: "2026-11-26" }),
  });
  const e = env(db, { RLIBOOK_KV: kv });
  const { status } = await call(e, "/libraries/monitor", "POST", { action: "reject", folder_id: F_PEND, fp: FP_OWNER });
  check("7e reject POST -> 303", status === 303, `status=${status}`);
  const marker = JSON.parse(kv._map.get("drive:surfaces-stale") || "{}");
  check("7f reject marker says private", marker.visibility === "private", JSON.stringify(marker));
}
{
  const db = buildDb();
  const kv = {
    get: async (k) => (k === "fp:" + FP_OWNER ? JSON.stringify({ tg_id: OWNER_ID }) : null),
    put: async () => { throw new Error("kv down"); },
  };
  const e = env(db, { RLIBOOK_KV: kv });
  const { status } = await call(e, "/libraries/monitor", "POST", { action: "approve", folder_id: F_PEND, fp: FP_OWNER });
  check("7g KV-down approve still 303s", status === 303, `status=${status}`);
  const row = db.prepare("SELECT visibility FROM drive_libraries WHERE folder_id = ?").get(F_PEND);
  check("7h KV-down approve still updates D1", row.visibility === "public", JSON.stringify(row));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
