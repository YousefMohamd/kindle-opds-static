// Test for the owner-only library monitor (functions/libraries-monitor.js).
// Standalone Node script — run from the repo root:
//   node functions/libraries-monitor.test.mjs
//
// Password gate (user decision 2026-11-28): ONE monitor link for the
// whole project, protected by a password the OWNER sets
// (MONITOR_PASSWORD secret) — the old ?fp= / ?key= auth is removed.
// Builds a LOCAL SQLite database (node:sqlite, same engine as D1)
// with a drive_libraries registry + books + drive_health rows, mocks
// RLIBOOK_KV with a Map, imports the real Function module, and calls
// onRequest(). Asserts: unauthenticated visitors get the login form
// only (no titles leaked), the old fingerprint/key auth is dead,
// login sets an HttpOnly session cookie holding SHA-256(password)
// (never the plaintext), wrong passwords get a generic 401, the
// session cookie opens the list and authorizes approve/reject POSTs,
// an unset MONITOR_PASSWORD locks the monitor (503, fail closed), and
// approve/reject still write the drive:surfaces-stale KV marker.
// No network, no production D1/KV. Exit 0 = all pass.
//
// NOTE: MON_PASSWORD below is a TEST-ONLY value, never a real password.

import { createHash } from "node:crypto";
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
const MON_PASSWORD = "monitor-test-password";
const MON_HASH = createHash("sha256").update(MON_PASSWORD).digest("hex");

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

async function call(env, path, method = "GET", form = null, headers = {}) {
  const init = { method, headers };
  if (form) {
    init.body = new FormData();
    for (const [k, v] of Object.entries(form)) init.body.append(k, v);
  }
  const req = new Request("https://example.com" + path, init);
  const res = await onRequest({ request: req, env, params: {} });
  return { status: res.status, headers: res.headers, text: await res.text() };
}
const env = (db, extra = {}) => ({
  TG_D1: mockD1(db), RLIBOOK_KV: mockKV(),
  MONITOR_PASSWORD: MON_PASSWORD, ...extra,
});

// Log in with the correct password; return the session cookie value.
async function loginCookie(e, db) {
  const { status, headers } = await call(e, "/libraries/monitor", "POST", { password: MON_PASSWORD });
  if (status !== 303) return null;
  const setCookie = headers.get("set-cookie") || "";
  const m = setCookie.match(/rlb_mon=([^;]+)/);
  return m ? m[1] : null;
}
const authHeaders = (token) => ({ Cookie: "rlb_mon=" + token });

// 1. Anonymous GET -> 200 login form, no titles leaked.
{
  const db = buildDb();
  const { status, text } = await call(env(db), "/libraries/monitor");
  check("1a anonymous GET -> 200 login form", status === 200, `status=${status}`);
  check("1b login form has a password field", text.includes('name="password"') && text.includes('type="password"'));
  check("1c anonymous sees no titles", !text.includes("مكتبة بانتظار") && !text.includes("نزهة الزمان"));
}

// 2. Old auth is dead: ?fp= and ?key= no longer open the monitor.
{
  const db = buildDb();
  const { status, text } = await call(env(db), "/libraries/monitor?fp=CCCCCCCCCCCCCCCCCCCCCC");
  check("2a old fp param -> login form, not the list", status === 200 && !text.includes("مكتبة بانتظار"), `status=${status}`);
  const { status: s2, text: t2 } = await call(env(db), "/libraries/monitor?key=monitor-test-key");
  check("2b old key param -> login form, not the list", s2 === 200 && !t2.includes("مكتبة بانتظار"), `status=${s2}`);
}

// 3. Login: wrong password -> 401 + generic error, no cookie;
//    correct password -> 303 + session cookie (SHA-256, not plaintext).
{
  const db = buildDb();
  const e = env(db);
  const { status, headers, text } = await call(e, "/libraries/monitor", "POST", { password: "wrong-password" });
  check("3a wrong password -> 401", status === 401, `status=${status}`);
  check("3b wrong password shows generic error", text.includes("غير صحيحة"));
  check("3c wrong password sets no cookie", !(headers.get("set-cookie") || "").includes("rlb_mon"));
  const { status: s2 } = await call(e, "/libraries/monitor", "POST", { password: "" });
  check("3d empty password -> 401", s2 === 401, `status=${s2}`);
  const { status: s3, headers: h3 } = await call(e, "/libraries/monitor", "POST", { password: MON_PASSWORD });
  check("3e correct password -> 303", s3 === 303, `status=${s3}`);
  const setCookie = h3.get("set-cookie") || "";
  check("3f cookie is HttpOnly + scoped to the monitor",
    setCookie.includes("HttpOnly") && setCookie.includes("Path=/libraries/monitor"), setCookie);
  check("3g cookie value is the SHA-256 hash, not the password",
    setCookie.includes("rlb_mon=" + MON_HASH) && !setCookie.includes(MON_PASSWORD), setCookie);
}

// 4. Authed GET (session cookie) -> 200 list, pending first, counts
//    + samples; approve/reject forms carry no fp/key hidden inputs.
{
  const db = buildDb();
  const e = env(db);
  const token = await loginCookie(e, db);
  check("4a login yields a session cookie", token === MON_HASH, `token=${token}`);
  const { status, text } = await call(e, "/libraries/monitor", "GET", null, authHeaders(token));
  check("4b authed GET -> 200", status === 200, `status=${status}`);
  check("4c pending listed (Arabic status label)", text.includes("مكتبة بانتظار") && text.includes("بانتظار النشر"));
  check("4d approve/reject form carries no fp/key hidden input",
    !text.includes('name="fp"') && !text.includes('name="key"') && text.includes('name="folder_id"'));
  check("4e public + private listed", text.includes("Oriental Music") && text.includes("مكتبة خاصة"));
  check("4f pending before public", text.indexOf("مكتبة بانتظار") < text.indexOf("Oriental Music"));
  check("4g sample title shown", text.includes("نزهة الزمان"));
  check("4h unavailable count shown", text.includes("غير متاح") || text.includes("1 غير متاح"));
  const { status: s2, text: t2 } = await call(e, "/libraries/monitor", "GET", null, authHeaders("deadbeef"));
  check("4i wrong cookie -> login form", s2 === 200 && !t2.includes("مكتبة بانتظار"), `status=${s2}`);
}

// 5. Approve: POST (session cookie) flips pending_public -> public, 303.
{
  const db = buildDb();
  const e = env(db);
  const token = await loginCookie(e, db);
  const { status, headers } = await call(e, "/libraries/monitor", "POST", { action: "approve", folder_id: F_PEND }, authHeaders(token));
  check("5a approve POST -> 303 redirect", status === 303 && (headers.get("location") || "") === "https://example.com/libraries/monitor", `status=${status} loc=${headers.get("location")}`);
  const row = db.prepare("SELECT visibility FROM drive_libraries WHERE folder_id = ?").get(F_PEND);
  check("5b registry now public", row.visibility === "public", JSON.stringify(row));
  const reviewed = db.prepare("SELECT reviewed_at FROM drive_libraries WHERE folder_id = ?").get(F_PEND);
  check("5c reviewed_at stamped", reviewed.reviewed_at !== null, JSON.stringify(reviewed));
}

// 6. Reject: POST flips pending_public -> private (stays with submitter).
{
  const db = buildDb();
  const e = env(db);
  const token = await loginCookie(e, db);
  const { status } = await call(e, "/libraries/monitor", "POST", { action: "reject", folder_id: F_PEND }, authHeaders(token));
  check("6a reject POST -> 303", status === 303, `status=${status}`);
  const row = db.prepare("SELECT visibility FROM drive_libraries WHERE folder_id = ?").get(F_PEND);
  check("6b registry now private", row.visibility === "private", JSON.stringify(row));
}

// 7. Non-authed POST -> 403 and no write; bad folder/action -> 400.
{
  const db = buildDb();
  const e = env(db);
  const token = await loginCookie(e, db);
  const { status } = await call(e, "/libraries/monitor", "POST", { action: "approve", folder_id: F_PEND });
  check("7a no-cookie POST -> 403", status === 403, `status=${status}`);
  const row = db.prepare("SELECT visibility FROM drive_libraries WHERE folder_id = ?").get(F_PEND);
  check("7b no write happened", row.visibility === "pending_public", JSON.stringify(row));
  const { status: s2 } = await call(e, "/libraries/monitor", "POST", { action: "approve", folder_id: "NOPEFOLDER1234567890" }, authHeaders(token));
  check("7c unknown folder -> 400", s2 === 400, `status=${s2}`);
  const { status: s3 } = await call(e, "/libraries/monitor", "POST", { action: "explode", folder_id: F_PEND }, authHeaders(token));
  check("7d unknown action -> 400", s3 === 400, `status=${s3}`);
}

// 8. Approve/reject writes the drive:surfaces-stale KV marker (the
// telegram-drive sweep consumes it to regenerate the public
// surfaces); a KV failure never fails the approve itself.
{
  const db = buildDb();
  const kv = mockKV();
  const e = env(db, { RLIBOOK_KV: kv });
  const token = await loginCookie(e, db);
  const { status } = await call(e, "/libraries/monitor", "POST", { action: "approve", folder_id: F_PEND }, authHeaders(token));
  check("8a approve POST -> 303", status === 303, `status=${status}`);
  const raw = kv._map.get("drive:surfaces-stale");
  check("8b marker written", typeof raw === "string", `marker=${raw}`);
  const marker = JSON.parse(raw || "{}");
  check("8c marker carries folder + new visibility + title",
    marker.folder_id === F_PEND && marker.visibility === "public" && marker.title === "مكتبة بانتظار",
    JSON.stringify(marker));
  check("8d marker carries the submitter", marker.submitter_tg_id === 111, JSON.stringify(marker));
}
{
  const db = buildDb();
  const kv = mockKV();
  const e = env(db, { RLIBOOK_KV: kv });
  const token = await loginCookie(e, db);
  const { status } = await call(e, "/libraries/monitor", "POST", { action: "reject", folder_id: F_PEND }, authHeaders(token));
  check("8e reject POST -> 303", status === 303, `status=${status}`);
  const marker = JSON.parse(kv._map.get("drive:surfaces-stale") || "{}");
  check("8f reject marker says private", marker.visibility === "private", JSON.stringify(marker));
}
{
  const db = buildDb();
  const kv = {
    get: async () => null,
    put: async () => { throw new Error("kv down"); },
  };
  const e = env(db, { RLIBOOK_KV: kv });
  const token = await loginCookie(e, db);
  const { status } = await call(e, "/libraries/monitor", "POST", { action: "approve", folder_id: F_PEND }, authHeaders(token));
  check("8g KV-down approve still 303s", status === 303, `status=${status}`);
  const row = db.prepare("SELECT visibility FROM drive_libraries WHERE folder_id = ?").get(F_PEND);
  check("8h KV-down approve still updates D1", row.visibility === "public", JSON.stringify(row));
}

// 9. Fail CLOSED when MONITOR_PASSWORD is unset: no login form, no
// list, no fingerprint/key fallback — the monitor is locked.
{
  const db = buildDb();
  const e = env(db, { MONITOR_PASSWORD: undefined });
  delete e.MONITOR_PASSWORD;
  const { status, text } = await call(e, "/libraries/monitor");
  check("9a unset secret GET -> 503 locked", status === 503, `status=${status}`);
  check("9b locked page says the monitor is locked", text.includes("مقفولة"));
  check("9c locked page shows no login form", !text.includes('name="password"'));
  const { status: s2 } = await call(e, "/libraries/monitor", "POST", { password: MON_PASSWORD });
  check("9d unset secret login POST -> 503", s2 === 503, `status=${s2}`);
  const { status: s3 } = await call(e, "/libraries/monitor", "POST", { action: "approve", folder_id: F_PEND });
  check("9e unset secret action POST -> 503", s3 === 503, `status=${s3}`);
}
{
  const db = buildDb();
  const e = env(db, { MONITOR_PASSWORD: "" });
  const { status } = await call(e, "/libraries/monitor");
  check("9f empty secret GET -> 503 locked", status === 503, `status=${status}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
