// Test for the Telegram-search endpoint (functions/api/tg-search.js).
// Standalone Node script — run from the repo root:
//   node functions/api/tg-search.test.mjs
//   TG_SEARCH_TEST_SHARD=site/telegram/index-0.json node functions/api/tg-search.test.mjs
//
// It builds a LOCAL SQLite database (node:sqlite, same FTS5 engine as
// D1) from a sample of the real published shard, wraps it in a minimal
// mock of the D1 binding API the Function uses
// (prepare().bind().first() / .all()), mocks RLIBOOK_KV with a Map,
// imports the real Function module, and calls onRequest() over HTTP
// semantics. It asserts the response contract for:
//   1. a known Telegram-only book (recent flagged title),
//   2. an author search,
//   3. Arabic normalization (diacritics + "ال" stripping),
//   4. a null author (author: null, not ""),
//   5. the flagged boolean (KV flag:<handle>:<post_id> present/absent),
//   6. empty query, missing D1 binding, and limit clamping.
// Exit 0 = all pass; non-zero + a message = failure.
// No network, no production D1/KV, no deploy.

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { onRequest, normalizeArabic, queryWords, parseFormatToken, gatedLinks, isBotRequest, validateSize, formatBytes, botDeepLink, parseFlagsBlob, ladderQueries, stripParticle, dedupeTitleKey, parseDriveFileUrl, driveFlagKey, d1LookupByPost, d1LookupByDriveFile, isDriveLookup, buildSearchCacheKey, buildSuggestCacheKey, searchCacheCounterKey, __resetSearchCacheCountersForTests, SEARCH_CACHE_TTL_SECONDS } from "./tg-search.js";

const SHARD = process.env.TG_SEARCH_TEST_SHARD || "site/telegram/index-0.json";
const SAMPLE = Number(process.env.TG_SEARCH_TEST_N || 5000);

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

// --- build a local DB from the real shard (same schema as D1) --------
// --- build a local DB from the real shard (same schema as D1) --------
// The live shard regenerates daily (newest-first), so a book the
// tests assert on can drift out of the first SAMPLE rows — the suite
// must not depend on the shard for its fixture books. FIXTURES below
// are the deterministic rows every assertion needs (inserted with
// high ids, after the shard sample); the shard sample stays for the
// real-data Arabic/FTS behaviour checks.
const FIXTURES = [
  // [title, author, source, kind, ext, size, date, url, filename]
  ["Everyone in This Bank Is a Thief", "Benjamin Stevenson", "kotobkhana", "channel", "epub", "1.2 MB", "2026-11-10", "https://t.me/kotobkhana/7559", "Everyone in This Bank Is a Thief.epub"],
  ["كل شخص هذا الكريسماس لديه سر ما", "", "kindle4kurd", "channel", "epub", "2.0 MB", "2026-11-09", "https://t.me/kindle4kurd/4102", "كل شخص هذا الكريسماس لديه سر ما.epub"],
  ["قصة كل شخص", "كاتب ما", "kotobkhana", "channel", "pdf", "3.1 MB", "2026-11-08", "https://t.me/kotobkhana/7558", "قصة كل شخص.pdf"],
  ["أليس الصبح بقريب", "بلال فضل", "kotobkhana", "channel", "epub", "1.5 MB", "2026-11-07", "https://t.me/kotobkhana/7557", "أليس الصبح بقريب.epub"],
  ["أنّا كارنينا", "ليو تولستوي", "kotobkhana", "channel", "epub", "4.0 MB", "2026-11-06", "https://t.me/kotobkhana/7556", "أنا كارنينا.epub"],
  // Persian-letter title (live D1 id 137839, L_alnader1): stored with
  // چ, must be found by a query with ج after the FTS migration.
  // (Live author is ''; the fixture gives it one so the author
  // search below has something to find.)
  ["روايه نوستالچيا لنور اسماعيل", "نور اسماعيل", "L_alnader1", "channel", "pdf", "1.0 MB", "2026-11-20", "https://t.me/L_alnader1/137839", "روايه نوستالچيا لنور اسماعيل.pdf"],
  // Smart-search ladder fixtures (2026-11-21): one Sindbad book for
  // the exact/prefix/typo/OR/particle tiers, a numeral title, and a
  // title-vs-author pair for the bm25 title>author check.
  ["مغامرات السندباد البحري", "كاتب ما", "ladderchan", "channel", "pdf", "1.0 MB", "2026-11-20", "https://t.me/ladderchan/100", "مغامرات السندباد البحري.pdf"],
  ["طبخ الزعفران", "مؤلف آخر", "ladderchan", "channel", "epub", "1.0 MB", "2026-11-20", "https://t.me/ladderchan/102", "طبخ الزعفران.epub"],
  ["كتاب آخر", "الزعفران", "ladderchan", "channel", "epub", "1.0 MB", "2026-11-20", "https://t.me/ladderchan/103", "كتاب آخر.epub"],
  // Search dedup fixtures (2026-11-21): the same book reposted in
  // three channels ('ام ميمي' x3 in the live complaint), the same
  // title with a DIFFERENT author (a different book — must stay),
  // a flagged-first / clean-second pair (the clean copy must win
  // the tile), and a 3-repost + 2-singleton set for the over-fetch
  // fill check. (The live shard holds 4 'ام ميمي' rows, but all sit
  // beyond the 5000-row test sample, so these fixtures are the only
  // 'ام ميمي' rows the test DB holds.)
  ["ام ميمي", "مؤلف مشترك", "dupchanA", "channel", "epub", "1.0 MB", "2026-11-20", "https://t.me/dupchanA/1", "ام ميمي.epub"],
  ["ام ميمي", "مؤلف مشترك", "dupchanB", "channel", "pdf", "1.0 MB", "2026-11-20", "https://t.me/dupchanB/2", "ام ميمي.pdf"],
  ["ام ميمي", "مؤلف مشترك", "dupchanC", "channel", "epub", "1.0 MB", "2026-11-20", "https://t.me/dupchanC/3", "ام ميمي.epub"],
  ["ام ميمي", "مؤلف مختلف", "dupchanD", "channel", "epub", "1.0 MB", "2026-11-20", "https://t.me/dupchanD/4", "ام ميمي.epub"],
  ["كتاب مكرر", "كاتب مكرر", "flagchan", "channel", "epub", "1.0 MB", "2026-11-20", "https://t.me/flagchan/50", "كتاب مكرر.epub"],
  ["كتاب مكرر", "كاتب مكرر", "cleanchan", "channel", "pdf", "1.0 MB", "2026-11-20", "https://t.me/cleanchan/51", "كتاب مكرر.pdf"],
  ["اختبار التكرار الأول", "كاتب أ", "repchan1", "channel", "epub", "1.0 MB", "2026-11-20", "https://t.me/repchan1/61", "اختبار التكرار الأول.epub"],
  ["اختبار التكرار الأول", "كاتب أ", "repchan1", "channel", "pdf", "1.0 MB", "2026-11-20", "https://t.me/repchan1/62", "اختبار التكرار الأول.pdf"],
  ["اختبار التكرار الأول", "كاتب أ", "repchan1", "channel", "epub", "1.0 MB", "2026-11-20", "https://t.me/repchan1/63", "اختبار التكرار الأول.epub"],
  ["اختبار التكرار الثاني", "كاتب ب", "repchan2", "channel", "epub", "1.0 MB", "2026-11-20", "https://t.me/repchan2/64", "اختبار التكرار الثاني.epub"],
  ["اختبار التكرار الثالث", "كاتب ج", "repchan3", "channel", "epub", "1.0 MB", "2026-11-20", "https://t.me/repchan3/65", "اختبار التكرار الثالث.epub"],
  // Drive fixtures (WAVE 4, WS8 §31): one book per visibility type.
  // No shard book contains "درايف", so q=الدرايف matches only these.
  ["كتاب الدرايف العام", "مؤلف الدرايف", "drive:1EFegWouzH4CXHzX2N-NfD18mJbtDLQAP", "drive", "epub", "1.0 MB", "2026-11-20", "https://drive.google.com/file/d/DRIVEPUBFILEID001/view", "كتاب الدرايف العام.epub"],
  ["كتاب الدرايف الخاص", "مؤلف الدرايف", "drive:PRIVFOLDERID1234567890", "drive", "pdf", "1.0 MB", "2026-11-20", "https://drive.google.com/file/d/DRIVEPRIVFILEID01/view", "كتاب الدرايف الخاص.pdf"],
  ["كتاب الدرايف المعلق", "مؤلف الدرايف", "drive:PENDFOLDERID1234567890", "drive", "epub", "1.0 MB", "2026-11-20", "https://drive.google.com/file/d/DRIVEPENDFILEID01/view", "كتاب الدرايف المعلق.epub"],
  ["كتاب الدرايف القديم", "مؤلف الدرايف", "drive:LEGACYFOLDER123456789", "drive", "epub", "1.0 MB", "2026-11-20", "https://drive.google.com/file/d/DRIVELEGFILEID001/view", "كتاب الدرايف القديم.epub"],
  // Removed / unavailable fixtures (Drive UX redesign, §31k): a
  // removed library and an unavailable one — hidden from EVERYONE,
  // submitter and owner included (metadata is never deleted, but
  // the books disappear from all surfaces).
  ["كتاب الدرايف المحذوف", "مؤلف الدرايف", "drive:REMFOLDERID1234567890", "drive", "epub", "1.0 MB", "2026-11-20", "https://drive.google.com/file/d/DRIVEREMFILEID01/view", "كتاب الدرايف المحذوف.epub"],
  ["كتاب الدرايف غير المتاح", "مؤلف الدرايف", "drive:UNAVFOLDERID123456789", "drive", "epub", "1.0 MB", "2026-11-20", "https://drive.google.com/file/d/DRIVEUNAVFILEID1/view", "كتاب الدرايف غير المتاح.epub"],
];
const shard = JSON.parse(readFileSync(SHARD, "utf-8"));
const rows = shard.books.slice(0, SAMPLE);
const db = new DatabaseSync(":memory:");
db.exec(`
  CREATE TABLE books (
    id INTEGER PRIMARY KEY, title TEXT NOT NULL, author TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'channel',
    ext TEXT NOT NULL DEFAULT '', size TEXT NOT NULL DEFAULT '',
    date TEXT NOT NULL DEFAULT '', url TEXT NOT NULL,
    filename TEXT NOT NULL DEFAULT '',
    UNIQUE(url, filename)
  );
  CREATE VIRTUAL TABLE books_fts USING fts5(title, author, tokenize='unicode61 remove_diacritics 1');
  CREATE INDEX idx_books_source ON books(source);
  CREATE TABLE drive_libraries (
    folder_id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '',
    visibility TEXT NOT NULL DEFAULT 'public',
    submitter_tg_id INTEGER, added_at TEXT NOT NULL DEFAULT ''
  );
`);
// Drive registry rows (WAVE 4, WS8 §31): one of each visibility, plus
// a legacy folder (F_LEG) with NO registry row — treated as public.
const F_PUB = "1EFegWouzH4CXHzX2N-NfD18mJbtDLQAP"; // Oriental Music (real)
const F_PRIV = "PRIVFOLDERID1234567890";
const F_PEND = "PENDFOLDERID1234567890";
const F_LEG = "LEGACYFOLDER123456789";
const F_REM = "REMFOLDERID1234567890";
const F_UNAV = "UNAVFOLDERID123456789";
const insLib = db.prepare(
  "INSERT INTO drive_libraries(folder_id,title,visibility,submitter_tg_id,added_at) VALUES (?,?,?,?,?)",
);
insLib.run(F_PUB, "Oriental Music", "public", null, "2026-11-22");
insLib.run(F_PRIV, "مكتبة خاصة", "private", 111, "2026-11-26");
insLib.run(F_PEND, "مكتبة معلقة", "pending_public", 111, "2026-11-26");
insLib.run(F_REM, "مكتبة محذوفة", "removed", 111, "2026-11-26");
insLib.run(F_UNAV, "مكتبة غير متاحة", "unavailable", 111, "2026-11-26");
// kind comes from the manifest; the test shard is one file, so resolve
// kind from a tiny built-in map of the sources present in the sample
// (channel unless the name is a known group in this sample).
const KIND = { julietbookstoregroup: "channel", kotobkhana: "channel" };
const norm = (s) =>
  normalizeArabic(s)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((w) => (w.startsWith("ال") && w.length >= 5 ? w.slice(2) : w))
    .join(" ");
const insBook = db.prepare(
  "INSERT INTO books(id,title,author,source,kind,ext,size,date,url,filename) VALUES (?,?,?,?,?,?,?,?,?,?)",
);
// The live shard can list the same (url, filename) twice (a multi-file
// post re-indexed — main HEAD index-0.json has 3 such pairs in the
// first 5000 rows, all rwaiaty4); the UNIQUE(url, filename) constraint
// used to crash the whole test run at setup. Shard rows use INSERT OR
// IGNORE and the FTS row follows only when the book row landed.
// Fixtures keep the strict INSERT (deterministic, unique).
const insBookIgnore = db.prepare(
  "INSERT OR IGNORE INTO books(id,title,author,source,kind,ext,size,date,url,filename) VALUES (?,?,?,?,?,?,?,?,?,?)",
);
const insFts = db.prepare("INSERT INTO books_fts(rowid,title,author) VALUES (?,?,?)");
rows.forEach((b, i) => {
  const id = i + 1;
  // Shard shape (both supported): old shards carry the post URL at
  // [8]; new shards (Workstream H) carry handle at [8] + post id at
  // [9] instead — rebuild the URL from those when [8] is not a URL.
  const postUrl = typeof b[8] === "string" && b[8].startsWith("http")
    ? b[8]
    : (b[8] && b[9] ? `https://t.me/${b[8]}/${b[9]}` : "");
  const res = insBookIgnore.run(id, b[0], b[1] || "", b[5], KIND[b[5]] || "channel", b[3], b[4], b[7], postUrl, b[2] || "");
  if (res.changes) insFts.run(id, norm(b[0]), norm(b[1] || ""));
});
// Deterministic fixtures (see above) — high ids, never colliding
// with the shard sample (1..SAMPLE).
FIXTURES.forEach((f, j) => {
  const id = 900001 + j;
  insBook.run(id, f[0], f[1], f[2], f[3], f[4], f[5], f[6], f[7], f[8]);
  insFts.run(id, norm(f[0]), norm(f[1]));
});
// Actual row count (OR IGNORE above may have skipped shard duplicates).
const TOTAL_ROWS = db.prepare("SELECT COUNT(*) AS n FROM books").get().n;
console.log(`test DB: ${rows.length} books from ${SHARD} + ${FIXTURES.length} fixtures`);

// --- minimal D1 mock (the exact API the Function uses) ---------------
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
// --- minimal KV mock --------------------------------------------------
function mockKV(entries = {}) {
  const m = new Map(Object.entries(entries));
  return { get: async (k) => (m.has(k) ? m.get(k) : null) };
}
// KV mock with put: records every write so tests can assert the
// coverage cache was populated (and with what).
function mockKVStore(entries = {}) {
  const m = new Map(Object.entries(entries));
  const writes = [];
  return {
    store: m,
    writes,
    get: async (k) => (m.has(k) ? m.get(k) : null),
    put: async (k, v, opts) => { m.set(k, v); writes.push({ key: k, value: v, opts }); },
  };
}
// KV mock with put + a log of every get() key (so tests can assert
// the flags:all blob costs exactly ONE KV get per search, not one
// per row — and that the legacy fallback really does per-row gets).
function countingKV(entries = {}) {
  const m = new Map(Object.entries(entries));
  const writes = [];
  const getCalls = [];
  return {
    store: m,
    writes,
    getCalls,
    get: async (k) => { getCalls.push(k); return m.has(k) ? m.get(k) : null; },
    put: async (k, v, opts) => { m.set(k, v); writes.push({ key: k, value: v, opts }); },
  };
}
// D1 mock that counts executions of the coverage refresh only
// (exact SQL "SELECT MAX(id) AS n FROM books") — the FTS and browse
// counts are different statements and must still run.
function countingD1(sqlite) {
  const base = mockD1(sqlite);
  let coverageRefreshQueries = 0;
  return {
    db: {
      prepare(sql) {
        if (sql === "SELECT MAX(id) AS n FROM books") coverageRefreshQueries++;
        return base.prepare(sql);
      },
    },
    get coverageRefreshQueries() { return coverageRefreshQueries; },
  };
}

async function call(env, path, headers = {}) {
  const req = new Request("https://example.com" + path, { method: "GET", headers });
  const res = await onRequest({ request: req, env, params: {} });
  return { status: res.status, body: await res.json() };
}

// Same as call(), but also returns the response headers (the cache
// tests assert x-rlibook-cache: HIT|MISS).
async function callRaw(env, path, headers = {}) {
  const req = new Request("https://example.com" + path, { method: "GET", headers });
  const res = await onRequest({ request: req, env, params: {} });
  return { status: res.status, headers: res.headers, body: await res.json() };
}

// A bot-authenticated call: the shared secret as the header + env var.
const BOT_KEY = "test-bot-key-0123456789abcdef";
async function botCall(path, key = BOT_KEY) {
  return call({ TG_D1: D1, TG_SEARCH_BOT_KEY: BOT_KEY }, path, { "x-rlibook-bot-key": key });
}

const D1 = mockD1(db);

// 1. Known Telegram-only book (recent flagged title, kotobkhana).
{
  const { status, body } = await call({ TG_D1: D1 }, "/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"));
  check("1a status 200", status === 200, `got ${status}`);
  check("1b ok:true", body.ok === true);
  check("1c total>=1", body.total >= 1, `total=${body.total}`);
  const hit = (body.results || []).find((r) => r.title === "Everyone in This Bank Is a Thief");
  check("1d exact title found", !!hit, JSON.stringify((body.results || []).slice(0, 2)));
  check("1e author", hit && hit.author === "Benjamin Stevenson", hit && hit.author);
  check("1f source is null for a non-flagged book (source-hiding)", hit && hit.source === null, hit && JSON.stringify(hit.source));
  check("1g kind channel", hit && hit.kind === "channel");
  check("1h formats [EPUB]", hit && JSON.stringify(hit.formats) === JSON.stringify(["EPUB"]));
  // No-direct-download (Workstream H): a PUBLIC caller never gets the
  // raw t.me post URL — only the gated links. The post URL is a
  // direct, ungated download; handing it out would bypass the token
  // gate and the 5/day cap.
  check("1i no raw post URL for a public caller", hit && !("url" in hit), hit && JSON.stringify(Object.keys(hit)));
  check("1i2 gated Get link present (delivery page, not the file)",
    hit && hit.get === "/kindle/get?lib=tg&h=kotobkhana&p=7559&f=epub&t=Everyone%20in%20This%20Bank%20Is%20a%20Thief",
    hit && hit.get);
  check("1i3 gated Send link present",
    hit && hit.send === "/api/send-to-kindle?lib=tg&h=kotobkhana&p=7559&f=epub&t=Everyone%20in%20This%20Bank%20Is%20a%20Thief",
    hit && hit.send);
  check("1i4 reader link present (EPUB)", hit && hit.read !== null && hit.read.startsWith("/site/reader/?lib=tg&h=kotobkhana&p=7559&f=epub"), hit && hit.read);
  check("1j flagged false without KV", hit && hit.flagged === false);
  check("1k result shape keys (bot + size allowed, optional)",
    hit && ["title", "author", "source", "kind", "library", "formats", "flagged", "get", "send", "read", "bot"].every((k) => k in hit)
    && !("url" in hit)
    && Object.keys(hit).every((k) => ["title", "author", "source", "kind", "library", "formats", "flagged", "get", "send", "read", "bot", "size"].includes(k)));
}

// 2. Author search.
{
  const { body } = await call({ TG_D1: D1 }, "/api/tg-search?q=" + encodeURIComponent("Benjamin Stevenson"));
  check("2a author search finds the book", (body.results || []).some((r) => r.author === "Benjamin Stevenson"));
  const { body: bodyAr } = await call({ TG_D1: D1 }, "/api/tg-search?q=" + encodeURIComponent("بلال فضل"));
  check("2b Arabic author search", (bodyAr.results || []).some((r) => r.author === "بلال فضل" && r.title === "أليس الصبح بقريب"));
}

// 3. Arabic normalization: diacritics + "ال" stripping.
// "أنّا كارنينا" is stored with a shadda; query without diacritics.
{
  const { body } = await call({ TG_D1: D1 }, "/api/tg-search?q=" + encodeURIComponent("انا كارنينا"));
  check("3a diacritic-insensitive match", (body.results || []).some((r) => r.title.includes("كارنينا")), JSON.stringify((body.results || []).slice(0, 1)));
  // "كاتب" (no ال) should match a title containing "الكاتب".
  const { body: body2 } = await call({ TG_D1: D1 }, "/api/tg-search?q=" + encodeURIComponent("كل شخص"));
  check("3b multi-word AND (كل شخص)", body2.total >= 2, `total=${body2.total}`);
}

// 27. Persian-letter folding (Fix A — نوستالجيا): a query with ج must
// find a title stored with چ, and vice versa. The test DB's FTS rows
// are built with the fixed normalizeArabic (same as the migration
// rewrites live books_fts with), so this is the post-migration state.
{
  check("27a normalizeArabic folds چ -> ج", normalizeArabic("نوستالچيا") === "نوستالجيا");
  check("27b normalizeArabic folds ک/گ -> ك", normalizeArabic("کتاب") === "كتاب" && normalizeArabic("گربه") === "كربه");
  check("27c normalizeArabic folds پ -> ب, ڤ -> ف", normalizeArabic("پدر") === "بدر" && normalizeArabic("ڤيديو") === "فيديو");
  check("27d normalizeArabic keeps hamza folds", normalizeArabic("مؤمن") === "مومن" && normalizeArabic("شيء") === "شي");
  const { body } = await call({ TG_D1: D1 }, "/api/tg-search?q=" + encodeURIComponent("نوستالجيا"));
  check("27e query نوستالجيا (ج) finds title stored as نوستالچيا (چ)",
    (body.results || []).some((r) => r.title === "روايه نوستالچيا لنور اسماعيل"),
    JSON.stringify((body.results || []).slice(0, 2)));
  const { body: bodyCh } = await call({ TG_D1: D1 }, "/api/tg-search?q=" + encodeURIComponent("نوستالچيا"));
  check("27f query نوستالچيا (چ) finds the same book",
    (bodyCh.results || []).some((r) => r.title === "روايه نوستالچيا لنور اسماعيل"));
  const { body: bodyAu } = await call({ TG_D1: D1 }, "/api/tg-search?q=" + encodeURIComponent("نور اسماعيل"));
  check("27g author search finds the Persian-title book",
    (bodyAu.results || []).some((r) => r.author === "نور اسماعيل"));
}

// 4. Null author (not "").
{
  const { body } = await call({ TG_D1: D1 }, "/api/tg-search?q=" + encodeURIComponent("كل شخص هذا الكريسماس"));
  const hit = (body.results || []).find((r) => r.title === "كل شخص هذا الكريسماس لديه سر ما");
  check("4a book with no author found", !!hit);
  check("4b author is null", hit && hit.author === null, hit && JSON.stringify(hit.author));
}

// 5. Flagged boolean via KV flag:<handle>:<post_id>.
{
  const kv = mockKV({ "flag:kotobkhana:7559": "1" });
  const { body } = await call({ TG_D1: D1, RLIBOOK_KV: kv }, "/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"));
  const hit = (body.results || []).find((r) => r.title === "Everyone in This Bank Is a Thief");
  check("5a flagged true when KV key exists", hit && hit.flagged === true);
  const { body: body2 } = await call({ TG_D1: D1, RLIBOOK_KV: kv }, "/api/tg-search?q=" + encodeURIComponent("كل شخص هذا الكريسماس"));
  const hit2 = (body2.results || []).find((r) => r.title === "كل شخص هذا الكريسماس لديه سر ما");
  check("5b flagged false when no KV key", hit2 && hit2.flagged === false);
  // No KV binding at all -> all unflagged (honest v1 limit).
  const { body: body3 } = await call({ TG_D1: D1 }, "/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"));
  const hit3 = (body3.results || []).find((r) => r.title === "Everyone in This Bank Is a Thief");
  check("5c flagged false without KV binding", hit3 && hit3.flagged === false);
  // Workstream 2b: a flagged book carries the "View in bot" deep
  // link (and no delivery links); a non-flagged book carries
  // bot: null (it has get/send/read instead).
  check("5d flagged book carries the bot deep link",
    hit && hit.bot === "https://t.me/RliBook_bot?start=dl_kotobkhana_7559_any", hit && hit.bot);
  check("5e non-flagged book carries bot: null",
    hit2 && hit2.bot === null, hit2 && JSON.stringify(hit2.bot));
  // Source-hiding (2026-11-21): the handle is populated ONLY for
  // flagged books; a normal book carries source: null.
  check("5f flagged book carries its source handle",
    hit && hit.source === "kotobkhana", hit && JSON.stringify(hit.source));
  check("5g non-flagged book carries source: null",
    hit2 && hit2.source === null, hit2 && JSON.stringify(hit2.source));
}

// 5b. botDeepLink unit checks (exported helper).
{
  check("5b1 public post -> dl_ deep link",
    botDeepLink({ url: "https://t.me/kotobkhana/7559" })
    === "https://t.me/RliBook_bot?start=dl_kotobkhana_7559_any");
  check("5b2 private-group c/ link -> null", botDeepLink({ url: "https://t.me/c/123456/7" }) === null);
  check("5b3 missing URL -> null", botDeepLink({}) === null);
  check("5b4 tg:// link -> null", botDeepLink({ url: "tg://resolve?domain=x" }) === null);
}

// 6. Edge cases: empty query, missing D1, limit clamping, no match.
{
  const { status, body } = await call({ TG_D1: D1 }, "/api/tg-search?q=");
  check("6a empty q -> ok, 0 results", status === 200 && body.ok === true && body.total === 0 && body.results.length === 0);
  const noD1 = await call({}, "/api/tg-search?q=test");
  check("6b missing D1 -> 503", noD1.status === 503 && noD1.body.ok === false, `status=${noD1.status}`);
  const { body: bodyLim } = await call({ TG_D1: D1 }, "/api/tg-search?q=" + encodeURIComponent("كل") + "&limit=2");
  check("6c limit=2 respected", bodyLim.results.length <= 2 && bodyLim.limit === 2, `len=${bodyLim.results.length}`);
  const { body: bodyNo } = await call({ TG_D1: D1 }, "/api/tg-search?q=" + encodeURIComponent("zzzqqqxxyy"));
  check("6d no match -> 0 results", bodyNo.total === 0 && bodyNo.results.length === 0);
  // queryWords unit check (exported helper).
  check("6e queryWords strips ال", JSON.stringify(queryWords("الكاتب")) === JSON.stringify(["كاتب"]));
}

// 7. source= filter (per-library browse, /telegram/libraries.html).
// "Everyone in This Bank Is a Thief" is source kotobkhana in this sample.
{
  const { body } = await call({ TG_D1: D1 }, "/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief") + "&source=kotobkhana");
  check("7a source match finds the book", (body.results || []).some((r) => r.title === "Everyone in This Bank Is a Thief"));
  check("7b source echoed", body.source === "kotobkhana", JSON.stringify(body.source));
  check("7c all results hide their source (null, not the handle)", (body.results || []).every((r) => r.source === null));
  const { body: bodyWrong } = await call({ TG_D1: D1 }, "/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief") + "&source=EBook_Library");
  check("7d wrong source finds nothing", bodyWrong.total === 0 && bodyWrong.results.length === 0, `total=${bodyWrong.total}`);
  const { body: bodyBrowse } = await call({ TG_D1: D1 }, "/api/tg-search?source=kotobkhana&limit=5");
  check("7e empty-q source browse lists books", bodyBrowse.ok === true && bodyBrowse.total >= 1 && bodyBrowse.results.length >= 1, `total=${bodyBrowse.total}`);
  check("7f browse results hide their source too", (bodyBrowse.results || []).every((r) => r.source === null));
  const { body: bodyNone } = await call({ TG_D1: D1 }, "/api/tg-search?source=zzz_no_such_handle&limit=5");
  check("7g unknown source -> 0 results", bodyNone.total === 0 && bodyNone.results.length === 0);
}

// 8. Review fixes (Area 2): input validation + sanitized D1 errors.
{
  const { status, body } = await call({ TG_D1: D1 }, "/api/tg-search?q=test&source=BAD HANDLE!");
  check("8a bad source -> 400, not a D1 query", status === 400 && body.ok === false, `status=${status}`);
  const bad2 = await call({ TG_D1: D1 }, "/api/tg-search?q=test&source=ok_handle-1");
  check("8b source with a dash -> 400 (handles are letters/digits/underscore)",
    bad2.status === 400, `status=${bad2.status}`);
  const longQ = await call({ TG_D1: D1 }, "/api/tg-search?q=" + encodeURIComponent("x".repeat(201)));
  check("8c query >200 chars -> 400", longQ.status === 400 && longQ.body.ok === false, `status=${longQ.status}`);
  const okQ = await call({ TG_D1: D1 }, "/api/tg-search?q=" + encodeURIComponent("x".repeat(200)));
  check("8d query of exactly 200 chars -> searched, not rejected",
    okQ.status === 200, `status=${okQ.status}`);
  // A D1 failure is a generic 500: the database error (which can name
  // tables/columns) must never reach the caller.
  const brokenD1 = { prepare() { throw new Error("D1 boom: no such table books_secret"); } };
  const broken = await call({ TG_D1: brokenD1 }, "/api/tg-search?q=test");
  check("8e D1 failure -> 500 with a generic message",
    broken.status === 500 && broken.body.ok === false
    && broken.body.error === "search failed — try again later",
    `status=${broken.status} body=${JSON.stringify(broken.body)}`);
  check("8f D1 failure leaks no internals",
    !JSON.stringify(broken.body).includes("books_secret")
    && !JSON.stringify(broken.body).includes("boom"));
}

// 9. coverage: every ok:true reply reports the D1 snapshot honestly.
// `indexed` is the MAX(id) ESTIMATE (2026-11-26 read-budget fix),
// not an exact COUNT(*) — `books.id` is sequential in production,
// so the estimate overshoots by the id gaps only (live: 422,821
// books at MAX(id) 422,850). In THIS test DB the fixtures use sparse
// ids (900001+), so MAX(id) is 900022 while the DB holds only
// TOTAL_ROWS rows — that gap is the fixture layout, not a bug: the
// test asserts the endpoint returns the MAX(id) estimate, and §17i
// proves MAX(id) === COUNT(*) on dense (production-shaped) ids.
// `partial` is indexed < target, so it reads false here (900022 >
// 422,821); partial-true is still covered via a cached value (§10d).
{
  const MAX_ID = db.prepare("SELECT MAX(id) AS n FROM books").get().n;
  const { body } = await call({ TG_D1: D1 }, "/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"));
  check("9a search reply carries coverage", !!body.coverage, JSON.stringify(body.coverage));
  check("9b coverage.indexed is the D1 MAX(id) estimate",
    body.coverage && body.coverage.indexed === MAX_ID,
    `indexed=${body.coverage && body.coverage.indexed} maxId=${MAX_ID} rows=${TOTAL_ROWS}`);
  check("9c coverage.target is the D1 final-import target (422,821)",
    body.coverage && body.coverage.target === 422821,
    JSON.stringify(body.coverage));
  check("9d coverage.partial is indexed < target (false here: sparse fixture ids push MAX(id) past target)",
    body.coverage && body.coverage.partial === (MAX_ID < 422821), JSON.stringify(body.coverage));
  check("9e coverage never claims the manifest total as the D1 total",
    body.coverage && body.coverage.indexed !== 326149
    && body.coverage.target !== 326149, JSON.stringify(body.coverage));
  const { body: bodyEmpty } = await call({ TG_D1: D1 }, "/api/tg-search?q=");
  check("9f empty-q reply carries coverage too",
    bodyEmpty.coverage && bodyEmpty.coverage.indexed === MAX_ID
    && bodyEmpty.coverage.partial === (MAX_ID < 422821), JSON.stringify(bodyEmpty.coverage));
  const { body: bodyNo } = await call({ TG_D1: D1 }, "/api/tg-search?q=" + encodeURIComponent("zzzqqqxxyy"));
  check("9g no-match reply carries coverage too",
    bodyNo.coverage && bodyNo.coverage.indexed === MAX_ID
    && bodyNo.coverage.partial === (MAX_ID < 422821), JSON.stringify(bodyNo.coverage));
  const { body: bodyBrowse } = await call({ TG_D1: D1 }, "/api/tg-search?source=kotobkhana&limit=5");
  check("9h source-browse reply carries coverage too",
    bodyBrowse.coverage && bodyBrowse.coverage.indexed === MAX_ID,
    JSON.stringify(bodyBrowse.coverage));
  const noD1 = await call({}, "/api/tg-search?q=test");
  check("9i 503 (no D1) carries no coverage field",
    noD1.body.coverage === undefined, JSON.stringify(noD1.body));
}

// 10. coverage cache (P0-2 D1 read-budget fix): the coverage refresh
// (MAX(id) since 2026-11-26 — before that a full-table COUNT(*))
// is cached in KV for 6 h (key `tg-search:coverage`) and the live
// refresh runs only on a cache miss. The response shape is identical
// either way.
{
  const MAX_ID = db.prepare("SELECT MAX(id) AS n FROM books").get().n;
  // 10a: cache hit — the cached value is used (123456 != MAX_ID)
  // and the coverage refresh is NOT executed at all.
  const counted = countingD1(db);
  const kvHit = mockKVStore({ "tg-search:coverage": JSON.stringify({ indexed: 123456, at: Date.now() }) });
  const { body: bodyHit } = await call({ TG_D1: counted.db, RLIBOOK_KV: kvHit }, "/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"));
  check("10a cache hit uses the cached indexed value",
    bodyHit.coverage && bodyHit.coverage.indexed === 123456,
    JSON.stringify(bodyHit.coverage));
  check("10b cache hit runs ZERO coverage refreshes",
    counted.coverageRefreshQueries === 0,
    `coverage MAX(id) ran ${counted.coverageRefreshQueries} times`);
  check("10c cache hit still returns search results",
    bodyHit.total >= 1 && (bodyHit.results || []).length >= 1, `total=${bodyHit.total}`);
  check("10d cache-hit coverage shape is unchanged",
    bodyHit.coverage && Object.keys(bodyHit.coverage).sort().join(",") === "indexed,partial,target"
    && bodyHit.coverage.target === 422821 && bodyHit.coverage.partial === true,
    JSON.stringify(bodyHit.coverage));

  // 10e: cache miss — the live MAX(id) runs exactly once and the
  // value is written back to KV (so the next request is a hit).
  const counted2 = countingD1(db);
  const kvMiss = mockKVStore();
  const { body: bodyMiss } = await call({ TG_D1: counted2.db, RLIBOOK_KV: kvMiss }, "/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"));
  check("10e cache miss falls back to the live MAX(id)",
    bodyMiss.coverage && bodyMiss.coverage.indexed === MAX_ID,
    JSON.stringify(bodyMiss.coverage));
  check("10f cache miss runs the coverage MAX(id) exactly once",
    counted2.coverageRefreshQueries === 1,
    `ran ${counted2.coverageRefreshQueries} times`);
  const written = kvMiss.writes.find((w) => w.key === "tg-search:coverage");
  check("10g cache miss populates KV with the live estimate",
    !!written && JSON.parse(written.value).indexed === MAX_ID,
    JSON.stringify(written && written.value));
  check("10h cache write carries a 6 h TTL",
    !!written && written.opts && written.opts.expirationTtl === 21600,
    JSON.stringify(written && written.opts));

  // 10i: malformed cached value -> fall back to the live MAX(id).
  const counted3 = countingD1(db);
  const kvBad = mockKVStore({ "tg-search:coverage": "not-json{{" });
  const { body: bodyBad } = await call({ TG_D1: counted3.db, RLIBOOK_KV: kvBad }, "/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"));
  check("10i malformed cache falls back to the live MAX(id)",
    bodyBad.coverage && bodyBad.coverage.indexed === MAX_ID
    && counted3.coverageRefreshQueries === 1, JSON.stringify(bodyBad.coverage));
  const kvBad2 = mockKVStore({ "tg-search:coverage": JSON.stringify({ indexed: "abc" }) });
  const { body: bodyBad2 } = await call({ TG_D1: D1, RLIBOOK_KV: kvBad2 }, "/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"));
  check("10j non-numeric cached indexed falls back to the live MAX(id)",
    bodyBad2.coverage && bodyBad2.coverage.indexed === MAX_ID,
    JSON.stringify(bodyBad2.coverage));

  // 10k: KV failure NEVER triggers a live refresh any more
  // (resilience batch, 2026-11-20): a KV error + a live count
  // compounded and killed search on 2026-11-19. The coverage field
  // is omitted instead and the search itself still works.
  const counted4 = countingD1(db);
  const kvThrow = { get: async () => { throw new Error("KV down"); }, put: async () => { throw new Error("KV down"); } };
  const { body: bodyThrow } = await call({ TG_D1: counted4.db, RLIBOOK_KV: kvThrow }, "/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"));
  check("10k KV failure omits coverage (no field, not a stale count)",
    bodyThrow.coverage === undefined, JSON.stringify(bodyThrow.coverage));
  check("10k2 KV failure runs ZERO coverage refreshes",
    counted4.coverageRefreshQueries === 0,
    `coverage MAX(id) ran ${counted4.coverageRefreshQueries} times`);
  check("10k3 KV failure still returns search results",
    bodyThrow.total >= 1 && (bodyThrow.results || []).length >= 1, `total=${bodyThrow.total}`);
  check("10k4 KV failure degrades the flag check too (links disabled, never fail-open)",
    bodyThrow.flagStatus === "degraded"
    && (bodyThrow.results || []).every((r) => r.get === null && r.send === null && r.read === null && r.flagCheck === "degraded"),
    JSON.stringify({ flagStatus: bodyThrow.flagStatus, first: (bodyThrow.results || [])[0] }));

  // 10l: a cached value at/above the target reports partial: false —
  // the /book partial note self-removes from the cached value too.
  const kvDone = mockKVStore({ "tg-search:coverage": JSON.stringify({ indexed: 422821, at: Date.now() }) });
  const { body: bodyDone } = await call({ TG_D1: D1, RLIBOOK_KV: kvDone }, "/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"));
  check("10l cached indexed == target -> partial false",
    bodyDone.coverage && bodyDone.coverage.indexed === 422821 && bodyDone.coverage.partial === false,
    JSON.stringify(bodyDone.coverage));
}

// 11. No-direct-download (Workstream H): the raw post URL leaves the
// endpoint ONLY for an authenticated bot caller; everyone else gets
// the gated links, and flagged books get no links at all.
{
  // 11a: correct bot key -> url present (as before).
  const { body: botBody } = await botCall("/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"));
  const botHit = (botBody.results || []).find((r) => r.title === "Everyone in This Bank Is a Thief");
  check("11a bot key -> url present", botHit && botHit.url === "https://t.me/kotobkhana/7559", botHit && botHit.url);
  check("11a2 bot key -> gated links still present", botHit && botHit.get !== null && botHit.send !== null);
  // 11b: wrong bot key -> no url.
  const { body: wrongBody } = await botCall("/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"), "wrong-key");
  const wrongHit = (wrongBody.results || []).find((r) => r.title === "Everyone in This Bank Is a Thief");
  check("11b wrong bot key -> no url", wrongHit && !("url" in wrongHit));
  // 11c: secret configured but no header -> no url.
  const { body: noHdrBody } = await call(
    { TG_D1: D1, TG_SEARCH_BOT_KEY: BOT_KEY },
    "/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"),
  );
  const noHdrHit = (noHdrBody.results || []).find((r) => r.title === "Everyone in This Bank Is a Thief");
  check("11c secret set but no header -> no url", noHdrHit && !("url" in noHdrHit));
  // 11d: flagged book, public caller -> no links at all, no url.
  const kvFlag = mockKV({ "flag:kotobkhana:7559": "1" });
  const { body: flagBody } = await call(
    { TG_D1: D1, RLIBOOK_KV: kvFlag },
    "/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"),
  );
  const flagHit = (flagBody.results || []).find((r) => r.title === "Everyone in This Bank Is a Thief");
  check("11d flagged public -> flagged true", flagHit && flagHit.flagged === true);
  check("11d2 flagged public -> no get/send/read links",
    flagHit && flagHit.get === null && flagHit.send === null && flagHit.read === null,
    flagHit && JSON.stringify({ get: flagHit.get, send: flagHit.send, read: flagHit.read }));
  check("11d3 flagged public -> no url", flagHit && !("url" in flagHit));
  // 11e: flagged book, bot caller -> url present (the bot's flagged
  // flow points at the source), gated links still null.
  const botFlag = await (async () => {
    const req = new Request("https://example.com/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"),
      { method: "GET", headers: { "x-rlibook-bot-key": BOT_KEY } });
    const res = await onRequest({ request: req, env: { TG_D1: D1, RLIBOOK_KV: kvFlag, TG_SEARCH_BOT_KEY: BOT_KEY }, params: {} });
    return { status: res.status, body: await res.json() };
  })();
  const botFlagHit = (botFlag.body.results || []).find((r) => r.title === "Everyone in This Bank Is a Thief");
  check("11e flagged bot -> url present", botFlagHit && botFlagHit.url === "https://t.me/kotobkhana/7559");
  check("11e2 flagged bot -> gated links null", botFlagHit && botFlagHit.get === null && botFlagHit.send === null && botFlagHit.read === null);
  // 11f: gatedLinks unit — MOBI gets no get/send/read; private-group
  // post gets none; PDF gets get+send but no read (EPUB only).
  check("11f MOBI -> no links",
    JSON.stringify(gatedLinks({ url: "https://t.me/s/1", ext: "mobi", title: "T" }, false))
    === JSON.stringify({ get: null, send: null, read: null }));
  check("11f2 private-group post -> no links",
    JSON.stringify(gatedLinks({ url: "https://t.me/c/123/4", ext: "epub", title: "T" }, false))
    === JSON.stringify({ get: null, send: null, read: null }));
  const pdfLinks = gatedLinks({ url: "https://t.me/s/9", ext: "pdf", title: "My Book" }, false);
  check("11f3 PDF -> get+send, no read",
    pdfLinks.get === "/kindle/get?lib=tg&h=s&p=9&f=pdf&t=My%20Book"
    && pdfLinks.send === "/api/send-to-kindle?lib=tg&h=s&p=9&f=pdf&t=My%20Book"
    && pdfLinks.read === null, JSON.stringify(pdfLinks));
  check("11f4 isBotRequest: no secret configured -> false even with a header",
    isBotRequest(new Request("https://x/", { headers: { "x-rlibook-bot-key": "anything" } }), {}) === false);
}

// 12. Single-book lookup by post (?h=&p=): the bot's dl_ deep link
// resolves the format through this instead of trusting the link.
{
  const { body } = await call({ TG_D1: D1 }, "/api/tg-search?h=kotobkhana&p=7559");
  check("12a lookup finds the book", body.ok === true && body.book && body.book.title === "Everyone in This Bank Is a Thief", JSON.stringify(body.book && body.book.title));
  check("12b lookup: no url for a public caller", body.book && !("url" in body.book));
  check("12c lookup: gated Get link present",
    body.book && body.book.get === "/kindle/get?lib=tg&h=kotobkhana&p=7559&f=epub&t=Everyone%20in%20This%20Bank%20Is%20a%20Thief",
    body.book && body.book.get);
  check("12d lookup carries coverage", !!body.coverage, JSON.stringify(body.coverage));
  const { body: botBook } = await botCall("/api/tg-search?h=kotobkhana&p=7559");
  check("12e lookup with bot key -> url present", botBook.book && botBook.book.url === "https://t.me/kotobkhana/7559");
  const { body: missing } = await call({ TG_D1: D1 }, "/api/tg-search?h=kotobkhana&p=999999999");
  check("12f unknown post -> book null (not 404)", missing.ok === true && missing.book === null, JSON.stringify(missing));
  const bad1 = await call({ TG_D1: D1 }, "/api/tg-search?h=BAD!HANDLE&p=7559");
  check("12g bad handle -> 400", bad1.status === 400, `status=${bad1.status}`);
  const bad2 = await call({ TG_D1: D1 }, "/api/tg-search?h=kotobkhana");
  check("12h handle without post -> 400", bad2.status === 400, `status=${bad2.status}`);
  const bad3 = await call({ TG_D1: D1 }, "/api/tg-search?p=7559");
  check("12i post without handle -> 400", bad3.status === 400, `status=${bad3.status}`);
}

// --- synthetic "Zebra" fixtures (Workstream 3b) -----------------------
// Inserted AFTER §1–§12 ran, so their coverage COUNT(*) expectations
// (TOTAL_ROWS) are untouched. Two files share ONE post (testchannel/
// 4242) so a single `hidden:` key must drop both; a third book on
// another post carries an empty size (no `size` key).
const ZEBRA = [
  ["Zebra Control Panel Book", "Zebra Author", "testchannel", "channel", "epub", "2.7 MB", "2026-11-16", "https://t.me/testchannel/4242", "Zebra Control Panel Book.epub"],
  ["Zebra Second File Book", "Zebra Author", "testchannel", "channel", "pdf", "1.1 MB", "2026-11-16", "https://t.me/testchannel/4242", "Zebra Second File Book.pdf"],
  ["Zebra Other Book", "Zebra Author", "otherchan", "channel", "epub", "", "2026-11-16", "https://t.me/otherchan/777", "Zebra Other Book.epub"],
];
ZEBRA.forEach((f, j) => {
  const id = 900101 + j;
  insBook.run(id, f[0], f[1], f[2], f[3], f[4], f[5], f[6], f[7], f[8]);
  insFts.run(id, norm(f[0]), norm(f[1]));
});

// 13. Hidden books (Workstream 2 + 3b control panel): a KV key
// `hidden:<handle>:<post_id>` removes the book from search entirely.
{
  const kvHidden = mockKV({ "hidden:kotobkhana:7559": "rpt-1" });
  const hiddenReq = new Request("https://example.com/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"), { method: "GET", headers: { "x-rlibook-bot-key": BOT_KEY } });
  const hiddenRes = await onRequest({ request: hiddenReq, env: { TG_D1: D1, TG_SEARCH_BOT_KEY: BOT_KEY, RLIBOOK_KV: kvHidden }, params: {} });
  const hiddenBody = await hiddenRes.json();
  check("13a hidden book drops out of search (bot sees no url match)",
    hiddenBody.ok === true && (hiddenBody.results || []).every((r) => r.url !== "https://t.me/kotobkhana/7559"),
    JSON.stringify((hiddenBody.results || []).map((r) => r.title)));
  const kvZ = mockKV({ "hidden:testchannel:4242": "manual:999:1" });
  const { body: bodyB } = await call({ TG_D1: D1, RLIBOOK_KV: kvZ }, "/api/tg-search?q=" + encodeURIComponent("Zebra Control Panel"));
  check("13b hidden post -> its only matching file is gone (total 0)",
    bodyB.total === 0 && bodyB.results.length === 0, `total=${bodyB.total}`);
  const { body: bodyC } = await call({ TG_D1: D1, RLIBOOK_KV: kvZ }, "/api/tg-search?q=" + encodeURIComponent("Zebra"));
  // NOTE (2026-11-26): main HEAD's shard contains a real book
  // "RM.DL.Z is for Zebra", so q=Zebra matches 3 books and hiding
  // the 2-file post leaves 2, not 1 — the total is shard-dependent,
  // the behaviour (both hidden files gone, other post remains) is not.
  check("13c one hidden key drops BOTH files on the post (other fixture post remains)",
    (bodyC.results || []).some((r) => r.title === "Zebra Other Book")
    && !(bodyC.results || []).some((r) => r.title === "Zebra Control Panel Book" || r.title === "Zebra Second File Book"),
    `total=${bodyC.total} titles=${JSON.stringify((bodyC.results || []).map((r) => r.title))}`);
  const { body: bodyD } = await call({ TG_D1: D1, RLIBOOK_KV: kvZ }, "/api/tg-search?source=testchannel&limit=5");
  check("13d browse of a hidden library drops to total 0",
    bodyD.total === 0 && bodyD.results.length === 0, `total=${bodyD.total}`);
  const { body: bodyE } = await call({ TG_D1: D1 }, "/api/tg-search?source=testchannel&limit=5");
  check("13e same browse without KV lists both files (total 2)",
    bodyE.total === 2 && bodyE.results.length === 2, `total=${bodyE.total}`);
  check("13f hidden book's title never leaks in the reply",
    !JSON.stringify(bodyB.results).includes("Zebra"), JSON.stringify(bodyB.results));
  const { body: bodyG } = await call({ TG_D1: D1 }, "/api/tg-search?q=" + encodeURIComponent("Zebra Control"));
  check("13g no KV binding -> nothing hidden, book found",
    (bodyG.results || []).some((r) => r.title === "Zebra Control Panel Book"));
  const kvBoth = mockKV({ "hidden:testchannel:4242": "manual:999:1", "flag:testchannel:4242": "1" });
  const { body: bodyH } = await call({ TG_D1: D1, RLIBOOK_KV: kvBoth }, "/api/tg-search?q=" + encodeURIComponent("Zebra Control"));
  check("13h hidden + flagged together -> still dropped (hidden wins in search)",
    bodyH.total === 0 && bodyH.results.length === 0, `total=${bodyH.total}`);
}

// 14. File size (Workstream 3): `size` when the index recorded one,
// no `size` key when it did not, never a `pages` key.
{
  const { body } = await call({ TG_D1: D1 }, "/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"));
  const hit = (body.results || []).find((r) => r.title === "Everyone in This Bank Is a Thief");
  check("14a search hit carries its size", hit && hit.size === "1.2 MB", hit && hit.size);
  const { body: look } = await call({ TG_D1: D1 }, "/api/tg-search?h=kotobkhana&p=7558");
  check("14b lookup carries size too", look.book && look.book.size === "3.1 MB" && JSON.stringify(look.book.formats) === JSON.stringify(["PDF"]), JSON.stringify(look.book));
  const { body: lookC } = await call({ TG_D1: D1 }, "/api/tg-search?h=otherchan&p=777");
  check("14c empty size -> no size key, no pages key",
    lookC.book && !("size" in lookC.book) && !("pages" in lookC.book), JSON.stringify(lookC.book));
  check("14d validateSize normalizes text",
    validateSize("2.7 MB") === "2.7 MB" && validateSize("888,9 KB") === "888.9 KB"
    && validateSize("  5 MB ") === "5 MB" && validateSize("1.2 mb") === "1.2 MB",
    `${validateSize("888,9 KB")} / ${validateSize("1.2 mb")}`);
  check("14e validateSize rejects junk",
    validateSize("") === "" && validateSize("huge") === "" && validateSize("12 XB") === ""
    && validateSize("-5 MB") === "" && validateSize("1.2.3 MB") === "",
    validateSize("12 XB"));
  check("14f validateSize accepts byte counts",
    validateSize(2831155) === "2.7 MB" && validateSize(0) === "0 B"
    && validateSize(-1) === "" && validateSize(NaN) === "",
    validateSize(2831155));
  check("14g formatBytes units",
    formatBytes(1024) === "1 KB" && formatBytes(1536) === "1.5 KB" && formatBytes(500) === "500 B",
    `${formatBytes(1024)} / ${formatBytes(1536)}`);
  check("14h a search result never carries a pages key", hit && !("pages" in hit));
}

// 15. Lookup + hidden/flagged/size (Workstream 3b): the lookup branch
// enforces the same gates as search.
{
  const { body } = await call({ TG_D1: D1 }, "/api/tg-search?h=testchannel&p=4242");
  check("15a lookup returns the first file on the post, with size",
    body.ok === true && body.book && body.book.title === "Zebra Control Panel Book"
    && body.book.size === "2.7 MB" && body.book.get !== null && !("url" in body.book),
    JSON.stringify(body.book));
  const kvH = mockKV({ "hidden:testchannel:4242": "manual:999:1" });
  const { body: hid } = await call({ TG_D1: D1, RLIBOOK_KV: kvH }, "/api/tg-search?h=testchannel&p=4242");
  check("15b hidden post -> lookup book null, no title leak",
    hid.ok === true && hid.book === null && !JSON.stringify(hid).includes("Zebra"), JSON.stringify(hid));
  const kvF = mockKV({ "flag:testchannel:4242": "1" });
  const { body: flg } = await call({ TG_D1: D1, RLIBOOK_KV: kvF }, "/api/tg-search?h=testchannel&p=4242");
  check("15c flagged post -> book present, flagged, no links",
    flg.book && flg.book.flagged === true && flg.book.get === null && flg.book.send === null && flg.book.read === null,
    JSON.stringify(flg.book));
  const kvB = mockKV({ "hidden:testchannel:4242": "manual:999:1", "flag:testchannel:4242": "1" });
  const { body: both } = await call({ TG_D1: D1, RLIBOOK_KV: kvB }, "/api/tg-search?h=testchannel&p=4242");
  check("15d hidden + flagged -> lookup null (hidden wins)",
    both.ok === true && both.book === null, JSON.stringify(both));
  const hidBotReq = new Request("https://example.com/api/tg-search?h=testchannel&p=4242", { method: "GET", headers: { "x-rlibook-bot-key": BOT_KEY } });
  const hidBotRes = await onRequest({ request: hidBotReq, env: { TG_D1: D1, TG_SEARCH_BOT_KEY: BOT_KEY, RLIBOOK_KV: kvH }, params: {} });
  const hidBot = await hidBotRes.json();
  check("15e bot key does NOT bypass a hide",
    hidBot.ok === true && hidBot.book === null, JSON.stringify(hidBot));
  const { body: other } = await call({ TG_D1: D1 }, "/api/tg-search?h=otherchan&p=777");
  check("15f lookup of the no-size book has no size/pages keys",
    other.book && !("size" in other.book) && !("pages" in other.book), JSON.stringify(other.book));
  check("15g lookup coverage is the MAX(id) estimate (Zebra fixtures push it past the row count)",
    body.coverage && body.coverage.indexed === db.prepare("SELECT MAX(id) AS n FROM books").get().n, JSON.stringify(body.coverage));
  const bad11 = await call({ TG_D1: D1 }, "/api/tg-search?h=testchannel&p=12345678901");
  check("15h 11-digit post id -> 400", bad11.status === 400, `status=${bad11.status}`);
}

// 16. Merge regression tripwire (Workstream 3b): the three lineages
// (consolidated lookup + gated links, WS2 hidden, WS3 size) must all
// still be present in this one file — a wholesale copy of any single
// earlier file would drop one of them.
{
  const { body: look } = await call({ TG_D1: D1 }, "/api/tg-search?h=kotobkhana&p=7559");
  check("16a size kept", look.book && look.book.size === "1.2 MB", JSON.stringify(look.book));
  const kvH = mockKV({ "hidden:kotobkhana:7559": "rpt-1" });
  const hidReq = new Request("https://example.com/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"), { method: "GET", headers: { "x-rlibook-bot-key": BOT_KEY } });
  const hidRes = await onRequest({ request: hidReq, env: { TG_D1: D1, TG_SEARCH_BOT_KEY: BOT_KEY, RLIBOOK_KV: kvH }, params: {} });
  const hidBody = await hidRes.json();
  check("16b hide kept", hidBody.ok === true && (hidBody.results || []).every((r) => r.url !== "https://t.me/kotobkhana/7559"));
  const kvZ = mockKV({ "hidden:testchannel:4242": "manual:999:1" });
  const { body: lookH } = await call({ TG_D1: D1, RLIBOOK_KV: kvZ }, "/api/tg-search?h=testchannel&p=4242");
  check("16c lookup hides", lookH.ok === true && lookH.book === null, JSON.stringify(lookH));
  const { body: lookS } = await call({ TG_D1: D1 }, "/api/tg-search?h=testchannel&p=4242");
  check("16d lookup returns size", lookS.book && lookS.book.size === "2.7 MB", JSON.stringify(lookS.book));
  const { body: pub } = await call({ TG_D1: D1 }, "/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"));
  const hit = (pub.results || []).find((r) => r.title === "Everyone in This Bank Is a Thief");
  check("16e gated links kept (no raw url, Get link present)",
    hit && !("url" in hit) && hit.get !== null, hit && JSON.stringify(Object.keys(hit)));
  const { body: botBook } = await botCall("/api/tg-search?h=kotobkhana&p=7559");
  check("16f bot-key url kept", botBook.book && botBook.book.url === "https://t.me/kotobkhana/7559");
}

// 14. Owner-hide (Workstream 2b): a `hidden:` key (owner /hide)
// removes the book from search; an approved report NEVER hides
// (it flags instead — see §5). The browse (empty-q) path shares
// the visibleResults helper, so it is covered by the same unit
// logic; the fixture rows sit past page 1 in id order, so no
// browse assertion is made here.
{
  const q = "/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief");
  const { body: plain } = await call({ TG_D1: D1 }, q);
  const plainHit = (plain.results || []).find((r) => r.title === "Everyone in This Bank Is a Thief");
  check("14a baseline: the book is found without a hidden key", !!plainHit);
  const kvHidden = mockKV({ "hidden:kotobkhana:7559": "owner" });
  const { body } = await call({ TG_D1: D1, RLIBOOK_KV: kvHidden }, q);
  check("14b hidden book is dropped from results",
    !(body.results || []).some((r) => r.title === "Everyone in This Bank Is a Thief"),
    JSON.stringify((body.results || []).map((r) => r.title)));
  check("14c total is adjusted by the hidden row on this page",
    body.total === plain.total - 1, `total=${body.total} plain=${plain.total}`);
  // Hidden wins over flagged: a book with both keys is dropped,
  // never shown with the flag.
  const kvBoth = mockKV({ "hidden:kotobkhana:7559": "owner", "flag:kotobkhana:7559": "1" });
  const { body: both } = await call({ TG_D1: D1, RLIBOOK_KV: kvBoth }, q);
  check("14d hidden + flagged -> dropped, not shown flagged",
    !(both.results || []).some((r) => r.title === "Everyone in This Bank Is a Thief"));
  // Single-book lookup: a hidden post reads as unknown (null).
  const { body: lookupHidden } = await call({ TG_D1: D1, RLIBOOK_KV: kvHidden }, "/api/tg-search?h=kotobkhana&p=7559");
  check("14e lookup of a hidden post -> book null", lookupHidden.ok === true && lookupHidden.book === null);
  // ...while a flagged (not hidden) lookup still returns the book,
  // with the bot deep link and no delivery links.
  const kvFlag = mockKV({ "flag:kotobkhana:7559": "1" });
  const { body: lookupFlag } = await call({ TG_D1: D1, RLIBOOK_KV: kvFlag }, "/api/tg-search?h=kotobkhana&p=7559");
  check("14f lookup of a flagged post -> book with bot link",
    lookupFlag.book && lookupFlag.book.flagged === true
    && lookupFlag.book.bot === "https://t.me/RliBook_bot?start=dl_kotobkhana_7559_any"
    && lookupFlag.book.get === null && lookupFlag.book.send === null && lookupFlag.book.read === null
    && !("url" in lookupFlag.book), JSON.stringify(lookupFlag.book));
}

// 17. d1:guard (resilience batch): while the guard flag is set,
// the live MAX(id) refresh NEVER runs — the coverage field is omitted and
// the search itself is unaffected.
{
  const today = new Date().toISOString().slice(0, 10);
  const counterKey = `tg-search:coverage:refreshes:${today}`;
  const counted = countingD1(db);
  const kvGuard = mockKVStore({ "d1:guard": "D1 exhausted 2026-11-20 (watchdog)" });
  const { body } = await call({ TG_D1: counted.db, RLIBOOK_KV: kvGuard }, "/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"));
  check("17a guard set -> coverage omitted", body.coverage === undefined, JSON.stringify(body.coverage));
  check("17b guard set -> ZERO coverage refreshes", counted.coverageRefreshQueries === 0, `ran ${counted.coverageRefreshQueries} times`);
  check("17c guard set -> search results still returned", body.total >= 1 && (body.results || []).length >= 1, `total=${body.total}`);
  check("17d guard set -> no refresh counter written", !kvGuard.writes.some((w) => w.key === counterKey), JSON.stringify(kvGuard.writes.map((w) => w.key)));
}

// 18. Coverage refresh budget: at most 4 live MAX(id) refreshes per UTC day
// (one KV counter write per refresh). At 4 the refresh is barred;
// below 4 it runs once and the counter increments.
{
  const today = new Date().toISOString().slice(0, 10);
  const counterKey = `tg-search:coverage:refreshes:${today}`;
  // 18a: counter at 4 -> barred, no count, coverage omitted.
  const countedFull = countingD1(db);
  const kvFull = mockKVStore({ [counterKey]: "4" });
  const { body: bodyFull } = await call({ TG_D1: countedFull.db, RLIBOOK_KV: kvFull }, "/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"));
  check("18a counter at 4 -> coverage omitted", bodyFull.coverage === undefined, JSON.stringify(bodyFull.coverage));
  check("18b counter at 4 -> ZERO coverage refreshes", countedFull.coverageRefreshQueries === 0, `ran ${countedFull.coverageRefreshQueries} times`);
  check("18c counter at 4 -> search still works", bodyFull.total >= 1, `total=${bodyFull.total}`);
  // 18d: counter at 3 -> the count runs exactly once, the counter
  // is incremented to 4 (48 h TTL), and the cache is populated.
  const counted3 = countingD1(db);
  const kv3 = mockKVStore({ [counterKey]: "3" });
  const { body: body3 } = await call({ TG_D1: counted3.db, RLIBOOK_KV: kv3 }, "/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"));
  check("18d counter at 3 -> live MAX(id) runs once",
    body3.coverage && body3.coverage.indexed === db.prepare("SELECT MAX(id) AS n FROM books").get().n && counted3.coverageRefreshQueries === 1,
    JSON.stringify(body3.coverage));
  const counterWrite = kv3.writes.find((w) => w.key === counterKey);
  check("18e counter at 3 -> counter incremented to 4",
    !!counterWrite && counterWrite.value === "4", JSON.stringify(counterWrite && counterWrite.value));
  check("18f counter write carries a 48 h TTL",
    !!counterWrite && counterWrite.opts && counterWrite.opts.expirationTtl === 172800,
    JSON.stringify(counterWrite && counterWrite.opts));
  // 18g: first refresh of the day (no counter key) -> count runs,
  // counter written as "1".
  const counted0 = countingD1(db);
  const kv0 = mockKVStore();
  const { body: body0 } = await call({ TG_D1: counted0.db, RLIBOOK_KV: kv0 }, "/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"));
  check("18g no counter key -> live MAX(id) runs once",
    body0.coverage && body0.coverage.indexed === db.prepare("SELECT MAX(id) AS n FROM books").get().n && counted0.coverageRefreshQueries === 1,
    JSON.stringify(body0.coverage));
  const counterWrite0 = kv0.writes.find((w) => w.key === counterKey);
  check("18h no counter key -> counter written as 1",
    !!counterWrite0 && counterWrite0.value === "1", JSON.stringify(counterWrite0 && counterWrite0.value));
}

// 19. parseFlagsBlob (exported helper): shape validation.
{
  const good = parseFlagsBlob({ flagged: ["kotobkhana:7559", "books2023:125155"], hidden: ["testchannel:4242"] });
  check("19a valid blob -> Sets with the entries",
    good && good.flagged.has("kotobkhana:7559") && good.flagged.has("books2023:125155")
    && good.hidden.has("testchannel:4242") && good.flagged.size === 2 && good.hidden.size === 1,
    JSON.stringify(good && { f: [...good.flagged], h: [...good.hidden] }));
  check("19b junk entries dropped, good ones kept",
    (() => {
      const p = parseFlagsBlob({ flagged: ["kotobkhana:7559", "not a key", "bad-handle!:1", "x:abc", 42, null, "a:1:2"], hidden: [] });
      return p && p.flagged.size === 1 && p.flagged.has("kotobkhana:7559");
    })());
  check("19c missing arrays -> empty Sets (blob with only flagged is fine)",
    (() => {
      const p = parseFlagsBlob({ flagged: ["kotobkhana:7559"] });
      return p && p.flagged.size === 1 && p.hidden.size === 0;
    })());
  check("19d non-array flagged field -> null (malformed, caller falls back)",
    parseFlagsBlob({ flagged: "kotobkhana:7559", hidden: [] }) === null);
  check("19e non-object -> null", parseFlagsBlob(null) === null && parseFlagsBlob("x") === null && parseFlagsBlob([]) === null);
  check("19f empty object -> empty Sets", (() => {
    const p = parseFlagsBlob({});
    return p && p.flagged.size === 0 && p.hidden.size === 0;
  })());
}

// 20. flags:all blob: one KV get per search (not one per row), and
// the blob — not the per-row keys — decides flagged/hidden.
{
  const blob = JSON.stringify({ flagged: ["kotobkhana:7559"], hidden: ["testchannel:4242"] });
  const kv = countingKV({ "flags:all": blob });
  const { body } = await call({ TG_D1: D1, RLIBOOK_KV: kv }, "/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"));
  const hit = (body.results || []).find((r) => r.title === "Everyone in This Bank Is a Thief");
  check("20a blob flags the book", hit && hit.flagged === true, JSON.stringify(hit && hit.flagged));
  check("20b blob-flagged book has the bot link and no delivery links",
    hit && hit.bot === "https://t.me/RliBook_bot?start=dl_kotobkhana_7559_any"
    && hit.get === null && hit.send === null && hit.read === null, JSON.stringify(hit));
  check("20c flagStatus ok when the blob was used", body.flagStatus === "ok", JSON.stringify(body.flagStatus));
  check("20d exactly ONE KV get of flags:all",
    kv.getCalls.filter((k) => k === "flags:all").length === 1,
    JSON.stringify(kv.getCalls));
  check("20e ZERO per-row flag:/hidden: gets when the blob exists",
    kv.getCalls.filter((k) => k.startsWith("flag:") || k.startsWith("hidden:")).length === 0,
    JSON.stringify(kv.getCalls));
  // Hidden via the blob drops the book (Zebra post).
  const { body: bodyZ } = await call({ TG_D1: D1, RLIBOOK_KV: countingKV({ "flags:all": blob }) },
    "/api/tg-search?q=" + encodeURIComponent("Zebra Control Panel"));
  check("20f blob-hidden post -> its only matching file is gone (total 0)",
    bodyZ.total === 0 && bodyZ.results.length === 0, `total=${bodyZ.total}`);
  const { body: bodyZ2 } = await call({ TG_D1: D1, RLIBOOK_KV: countingKV({ "flags:all": blob }) },
    "/api/tg-search?q=" + encodeURIComponent("Zebra"));
  check("20g blob-hidden post drops BOTH files on it (other fixture post remains)",
    (bodyZ2.results || []).some((r) => r.title === "Zebra Other Book")
    && !(bodyZ2.results || []).some((r) => r.title === "Zebra Control Panel Book" || r.title === "Zebra Second File Book"),
    `total=${bodyZ2.total}`);
  // The blob wins over a stale per-row key: a flag: key that is NOT
  // in the blob does not flag the book (the blob is the denylist).
  const kvStale = countingKV({ "flags:all": JSON.stringify({ flagged: [], hidden: [] }), "flag:kotobkhana:7559": "1" });
  const { body: bodyS } = await call({ TG_D1: D1, RLIBOOK_KV: kvStale }, "/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"));
  const hitS = (bodyS.results || []).find((r) => r.title === "Everyone in This Bank Is a Thief");
  check("20h empty blob + stale per-row flag: key -> NOT flagged (blob is authoritative)",
    hitS && hitS.flagged === false, JSON.stringify(hitS && hitS.flagged));
}

// 21. Blob missing -> legacy per-row gets (rollout safety): the
// old flag:/hidden: keys still decide, so deploying the read side
// before the writer can never un-flag a book.
{
  const kv = countingKV({ "flag:kotobkhana:7559": "1", "hidden:testchannel:4242": "manual:999:1" });
  const { body } = await call({ TG_D1: D1, RLIBOOK_KV: kv }, "/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"));
  const hit = (body.results || []).find((r) => r.title === "Everyone in This Bank Is a Thief");
  check("21a no blob -> per-row flag: key still flags", hit && hit.flagged === true);
  check("21b no blob -> flagStatus legacy", body.flagStatus === "legacy", JSON.stringify(body.flagStatus));
  check("21c no blob -> per-row gets really ran",
    kv.getCalls.some((k) => k === "flag:kotobkhana:7559"), JSON.stringify(kv.getCalls));
  const { body: bodyZ } = await call({ TG_D1: D1, RLIBOOK_KV: countingKV({ "hidden:testchannel:4242": "manual:999:1" }) },
    "/api/tg-search?q=" + encodeURIComponent("Zebra Control Panel"));
  check("21d no blob -> per-row hidden: key still drops the book",
    bodyZ.total === 0 && bodyZ.results.length === 0, `total=${bodyZ.total}`);
}

// 22. Blob malformed (bad JSON, or a non-array field) -> legacy
// fallback, same as missing.
{
  const kvBad = countingKV({ "flags:all": "not-json{{", "flag:kotobkhana:7559": "1" });
  const { body } = await call({ TG_D1: D1, RLIBOOK_KV: kvBad }, "/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"));
  const hit = (body.results || []).find((r) => r.title === "Everyone in This Bank Is a Thief");
  check("22a malformed blob JSON -> legacy fallback still flags", hit && hit.flagged === true);
  check("22b malformed blob JSON -> flagStatus legacy", body.flagStatus === "legacy", JSON.stringify(body.flagStatus));
  const kvBad2 = countingKV({ "flags:all": JSON.stringify({ flagged: "kotobkhana:7559" }), "flag:kotobkhana:7559": "1" });
  const { body: body2 } = await call({ TG_D1: D1, RLIBOOK_KV: kvBad2 }, "/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"));
  const hit2 = (body2.results || []).find((r) => r.title === "Everyone in This Bank Is a Thief");
  check("22c non-array flagged field -> legacy fallback still flags", hit2 && hit2.flagged === true);
  check("22d non-array flagged field -> flagStatus legacy", body2.flagStatus === "legacy", JSON.stringify(body2.flagStatus));
}

// 23. KV failure on the denylist -> DEGRADED, never fail-open:
// results are returned (search works) but with NO delivery links,
// a flagCheck marker on every result, and flagStatus at the top —
// and the raw post URL is withheld even from the bot.
{
  const kvThrow = { get: async () => { throw new Error("KV down"); }, put: async () => { throw new Error("KV down"); } };
  const { body } = await call({ TG_D1: D1, RLIBOOK_KV: kvThrow }, "/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"));
  check("23a degraded -> flagStatus degraded", body.flagStatus === "degraded", JSON.stringify(body.flagStatus));
  check("23b degraded -> results still returned", body.total >= 1 && (body.results || []).length >= 1, `total=${body.total}`);
  check("23c degraded -> every result has NO links and flagCheck degraded",
    (body.results || []).every((r) => r.get === null && r.send === null && r.read === null && r.bot === null && r.flagCheck === "degraded"),
    JSON.stringify((body.results || [])[0]));
  check("23d degraded -> coverage omitted too (KV down bars the count)",
    body.coverage === undefined, JSON.stringify(body.coverage));
  // Bot caller, same KV failure -> still no raw url.
  const botReq = new Request("https://example.com/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"),
    { method: "GET", headers: { "x-rlibook-bot-key": BOT_KEY } });
  const botRes = await onRequest({ request: botReq, env: { TG_D1: D1, TG_SEARCH_BOT_KEY: BOT_KEY, RLIBOOK_KV: kvThrow }, params: {} });
  const botBody = await botRes.json();
  check("23e degraded bot caller -> no raw url, no links",
    botBody.flagStatus === "degraded"
    && (botBody.results || []).every((r) => !("url" in r) && r.get === null && r.send === null && r.read === null),
    JSON.stringify({ flagStatus: botBody.flagStatus, first: (botBody.results || [])[0] }));
}

// 24. Single-book lookup under KV failure: same degraded contract.
{
  const kvThrow = { get: async () => { throw new Error("KV down"); }, put: async () => { throw new Error("KV down"); } };
  const { body } = await call({ TG_D1: D1, RLIBOOK_KV: kvThrow }, "/api/tg-search?h=kotobkhana&p=7559");
  check("24a lookup degraded -> book returned (not null), links disabled",
    body.book && body.book.title === "Everyone in This Bank Is a Thief"
    && body.book.get === null && body.book.send === null && body.book.read === null
    && body.book.flagCheck === "degraded" && body.flagStatus === "degraded",
    JSON.stringify(body.book));
  const botReq = new Request("https://example.com/api/tg-search?h=kotobkhana&p=7559",
    { method: "GET", headers: { "x-rlibook-bot-key": BOT_KEY } });
  const botRes = await onRequest({ request: botReq, env: { TG_D1: D1, TG_SEARCH_BOT_KEY: BOT_KEY, RLIBOOK_KV: kvThrow }, params: {} });
  const botBody = await botRes.json();
  check("24b lookup degraded bot caller -> no raw url",
    botBody.book && !("url" in botBody.book) && botBody.book.flagCheck === "degraded",
    JSON.stringify(botBody.book));
  // Lookup with a good blob still reports flagStatus.
  const kvBlob = countingKV({ "flags:all": JSON.stringify({ flagged: ["kotobkhana:7559"], hidden: [] }) });
  const { body: bodyF } = await call({ TG_D1: D1, RLIBOOK_KV: kvBlob }, "/api/tg-search?h=kotobkhana&p=7559");
  check("24c lookup with blob -> flagged, bot link, flagStatus ok",
    bodyF.book && bodyF.book.flagged === true && bodyF.flagStatus === "ok"
    && bodyF.book.bot === "https://t.me/RliBook_bot?start=dl_kotobkhana_7559_any"
    && bodyF.book.get === null, JSON.stringify(bodyF.book));
}

// 25. No KV binding at all: the honest v1 limit is unchanged —
// all unflagged, flagStatus ok, delivery links present.
{
  const { body } = await call({ TG_D1: D1 }, "/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"));
  const hit = (body.results || []).find((r) => r.title === "Everyone in This Bank Is a Thief");
  check("25a no KV -> flagged false, flagStatus ok",
    hit && hit.flagged === false && body.flagStatus === "ok", JSON.stringify({ flagged: hit && hit.flagged, flagStatus: body.flagStatus }));
  check("25b no KV -> delivery links present (nothing to distrust)",
    hit && hit.get !== null && hit.send !== null, JSON.stringify(hit && { get: hit.get, send: hit.send }));
  check("25c no KV -> no flagCheck marker on results",
    hit && !("flagCheck" in hit), JSON.stringify(Object.keys(hit)));
}

// 26. Edge cache (caches.default, 1 h): the second search in the
// hour serves flags:all from the edge cache — zero KV gets for
// flags. Runs LAST: it installs a fake global `caches` and removes
// it again in a finally, so no other section sees it.
{
  const edgeStore = new Map();
  globalThis.caches = {
    default: {
      match: async (url) => {
        const raw = edgeStore.get(String(url));
        return raw === undefined
          ? null
          : new Response(raw, { headers: { "content-type": "application/json" } });
      },
      put: async (url, res) => { edgeStore.set(String(url), await res.text()); },
    },
  };
  try {
    const blob = JSON.stringify({ flagged: ["kotobkhana:7559"], hidden: [] });
    const kv1 = countingKV({ "flags:all": blob });
    const { body: body1 } = await call({ TG_D1: D1, RLIBOOK_KV: kv1 }, "/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"));
    const hit1 = (body1.results || []).find((r) => r.title === "Everyone in This Bank Is a Thief");
    check("26a first search reads the blob from KV and flags the book",
      hit1 && hit1.flagged === true && kv1.getCalls.filter((k) => k === "flags:all").length === 1,
      JSON.stringify(kv1.getCalls));
    check("26b first search fills the edge cache", edgeStore.size === 1, `edge entries=${edgeStore.size}`);
    // Second search, fresh KV mock (same blob): the edge cache
    // answers, KV is never asked for flags:all.
    const kv2 = countingKV({ "flags:all": blob });
    const { body: body2 } = await call({ TG_D1: D1, RLIBOOK_KV: kv2 }, "/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"));
    const hit2 = (body2.results || []).find((r) => r.title === "Everyone in This Bank Is a Thief");
    check("26c second search still flags the book from the edge cache",
      hit2 && hit2.flagged === true, JSON.stringify(hit2 && hit2.flagged));
    check("26d second search makes ZERO KV gets for flags:all",
      kv2.getCalls.filter((k) => k === "flags:all").length === 0,
      JSON.stringify(kv2.getCalls));
  } finally {
    delete globalThis.caches;
  }
}

// 28. Smart-search ladder + bm25 ranking + source-hiding (2026-11-21).
// The ladder fixtures above are the deterministic rows; the shard
// sample never contains "السندباد"/"الزعفران"/"٥٥" titles, so the
// tier assertions are exact.
{
  const ladder = ladderQueries(["مغامرات", "سندباد"]);
  check("28a ladder order is exact, prefix, typo, any, word",
    JSON.stringify(ladder.map((t) => t.match)) === JSON.stringify(["exact", "prefix", "typo", "any", "word"]),
    JSON.stringify(ladder.map((t) => t.match)));
  check("28a2 ladder tier 4 is the longest word alone",
    ladder[4].expr === '"مغامرات"', ladder[4].expr);
  check("28a3 single-word query skips OR and longest-word (they add nothing)",
    JSON.stringify(ladderQueries(["سندباد"]).map((t) => t.match)) === JSON.stringify(["exact", "prefix", "typo"]),
    JSON.stringify(ladderQueries(["سندباد"]).map((t) => t.match)));
  // 28b: particle stripping is a ladder variant, never a fold.
  check("28b stripParticle: و/ف/بال/لل stripped when >=4 chars remain",
    stripParticle("والسندباد") === "السندباد" && stripParticle("فالمكتبة") === "المكتبة"
    && stripParticle("بالكتاب") === "كتاب" && stripParticle("للبيت") === "للبيت",
    `${stripParticle("والسندباد")} / ${stripParticle("بالكتاب")} / ${stripParticle("للبيت")}`);
  check("28b2 stripParticle NEVER folds و: 'وردة' stays 'وردة' (ة->ه still applies)",
    stripParticle("وردة") === "وردة" && normalizeArabic("وردة") === "ورده");
  // 28c: exact beats prefix — the same query that COULD prefix-match
  // reports match 'exact' and finds the book at tier 0.
  const { body: exactBody } = await call({ TG_D1: D1 }, "/api/tg-search?q=" + encodeURIComponent("مغامرات السندباد"));
  check("28c exact query reports match 'exact'",
    exactBody.match === "exact" && (exactBody.results || []).some((r) => r.title === "مغامرات السندباد البحري"),
    `match=${exactBody.match}`);
  // 28d: prefix finds a missing ending (last word truncated).
  const { body: prefixBody } = await call({ TG_D1: D1 }, "/api/tg-search?q=" + encodeURIComponent("مغامرات السندب"));
  check("28d prefix tier finds the missing ending, match 'prefix'",
    prefixBody.match === "prefix" && (prefixBody.results || []).some((r) => r.title === "مغامرات السندباد البحري"),
    `match=${prefixBody.match}`);
  // 28e: typo tier finds a mid-word substitution in the FIRST word
  // (tier 1 cannot — it prefixes only the last word).
  const { body: typoBody } = await call({ TG_D1: D1 }, "/api/tg-search?q=" + encodeURIComponent("السندباخ مغامرات"));
  check("28e typo tier finds the mid-word substitution, match 'typo'",
    typoBody.match === "typo" && (typoBody.results || []).some((r) => r.title === "مغامرات السندباد البحري"),
    `match=${typoBody.match}`);
  // 28f: OR finds a multi-word query with one wrong word. limit=20:
  // the live shard regenerates daily, and the fixture's bm25 rank in
  // the OR tier drifts with the sample (rank 15 in the 2026-11-21
  // shard, rank 1 in the older one) — the tier assertion is about
  // the tier firing + the book being found, not about it ranking in
  // the top 10, so the page is widened to keep that stable.
  const { body: orBody } = await call({ TG_D1: D1 }, "/api/tg-search?q=" + encodeURIComponent("مغامرات زقزوق") + "&limit=20");
  check("28f OR tier finds the book with one wrong word, match 'any'",
    orBody.match === "any" && (orBody.results || []).some((r) => r.title === "مغامرات السندباد البحري"),
    `match=${orBody.match}`);
  // 28g: longest-word fallback (unit — via d1SearchLadder's tier
  // list: the OR tier is a superset of it in FTS, so it fires only
  // when OR is skipped; the ladder still ends with it, kept from
  // today's fallback).
  const { body: noBody } = await call({ TG_D1: D1 }, "/api/tg-search?q=" + encodeURIComponent("زقزوق خربشة"));
  check("28g no tier matches -> match null, 0 results",
    noBody.match === null && noBody.total === 0 && noBody.results.length === 0,
    `match=${noBody.match} total=${noBody.total}`);
  // 28h: particle variant — "والسندباد" (و + السندباد) finds the book
  // at the exact tier via the stripped form.
  const { body: partBody } = await call({ TG_D1: D1 }, "/api/tg-search?q=" + encodeURIComponent("والسندباد"));
  check("28h particle variant finds the book, match 'exact'",
    partBody.match === "exact" && (partBody.results || []).some((r) => r.title === "مغامرات السندباد البحري"),
    `match=${partBody.match}`);
  // 28i: bm25 title>author — the title hit ranks above the author hit.
  const { body: bmBody } = await call({ TG_D1: D1 }, "/api/tg-search?q=" + encodeURIComponent("الزعفران"));
  check("28i bm25 ranks the title hit above the author hit",
    (bmBody.results || []).length >= 2 && bmBody.results[0].title === "طبخ الزعفران"
    && (bmBody.results || []).some((r) => r.title === "كتاب آخر" && r.author === "الزعفران"),
    JSON.stringify((bmBody.results || []).slice(0, 2).map((r) => r.title)));
  // 28j: Eastern numerals — DEFERRED to day 2 (2026-11-21 follow-up).
  // The ٠-٩ -> 0-9 fold is NOT in normalizeArabic yet: live
  // books_fts still holds Eastern numerals in 15,370 rows (counted
  // via d1_query_file.py, db ba378afe-4a2e-4d79-b6e9-ad73cf51e8fa)
  // and the D1 write budget for today is fully used, so no batch
  // rewrite was applied either. Folding the query now, without the
  // migration, would make Eastern-numeral queries MISS rows they
  // currently find. This check locks in the deferred state — it
  // MUST be flipped to the fold (and the migration run) on day 2.
  check("28j Eastern-numeral fold deferred: no fold yet (day 2)",
    normalizeArabic("٥٥") === "٥٥" && normalizeArabic("كتاب ١٢٣") === "كتاب ١٢٣");
  // 28k: source field — null for normal, populated for flagged
  // (lookup branch too).
  const kvFlag28 = mockKV({ "flag:kotobkhana:7559": "1" });
  const { body: flagLook } = await call({ TG_D1: D1, RLIBOOK_KV: kvFlag28 }, "/api/tg-search?h=kotobkhana&p=7559");
  check("28k flagged lookup carries its source handle",
    flagLook.book && flagLook.book.source === "kotobkhana", JSON.stringify(flagLook.book && flagLook.book.source));
  const { body: normLook } = await call({ TG_D1: D1 }, "/api/tg-search?h=kotobkhana&p=7559");
  check("28k2 normal lookup carries source: null",
    normLook.book && normLook.book.source === null, JSON.stringify(normLook.book && normLook.book.source));
}

// 29. Search dedup (2026-11-21): the same book reposted in several
// channels must collapse to ONE tile (live complaint: 'ام ميمي' 3
// times in 5 tiles); a different book that merely shares a title
// (different author) stays; a clean copy beats a flagged copy of
// the same book; and the page still fills to `limit` distinct books
// (over-fetch) instead of `limit` minus the duplicates.
{
  check("29a dedupeTitleKey: ال / diacritics do not split a title",
    dedupeTitleKey("الكتاب الكبير", "مؤلف مشترك") === dedupeTitleKey("كتاب الكبير", "مؤلف مشترك")
    && dedupeTitleKey("امّ ميمي", "مؤلف مشترك") === dedupeTitleKey("ام ميمي", "مؤلف مشترك")
    && dedupeTitleKey("ام ميمي", "مؤلف مشترك") !== dedupeTitleKey("ام ميمي", "مؤلف مختلف")
    && dedupeTitleKey("كتاب", "") !== dedupeTitleKey("كتاب", "كاتب"));
  const { body } = await call({ TG_D1: D1 }, "/api/tg-search?q=" + encodeURIComponent("ام ميمي") + "&limit=10");
  const mimi = (body.results || []).filter((r) => r.title === "ام ميمي");
  check("29b three reposts of 'ام ميمي' collapse to one tile (same author)",
    mimi.filter((r) => r.author === "مؤلف مشترك").length === 1,
    JSON.stringify(mimi.map((r) => [r.author, r.source])));
  check("29c same title, different author stays (a different book)",
    mimi.filter((r) => r.author === "مؤلف مختلف").length === 1,
    JSON.stringify(mimi.map((r) => r.author)));
  check("29d total stays the raw match count (not distinct titles)",
    body.total >= 4, `total=${body.total}`);
  // Flagged-first / clean-second: the tile that survives must be the
  // clean copy (delivery links present), whichever copy ranked first.
  const kvFlag = mockKV({ "flag:flagchan:50": "1" });
  const { body: flagBody } = await call({ TG_D1: D1, RLIBOOK_KV: kvFlag }, "/api/tg-search?q=" + encodeURIComponent("كتاب مكرر"));
  const rep = (flagBody.results || []).filter((r) => r.title === "كتاب مكرر");
  check("29e flagged copy loses to the clean copy of the same book",
    rep.length === 1 && rep[0].flagged === false && rep[0].get !== null && rep[0].get.includes("h=cleanchan"),
    JSON.stringify(rep.map((r) => [r.flagged, r.get])));
  // Over-fetch fill: limit=2 against 3 reposts + 2 singletons must
  // still return 2 DISTINCT titles (not 2 rows that dedupe to 1).
  const { body: fillBody } = await call({ TG_D1: D1 }, "/api/tg-search?q=" + encodeURIComponent("اختبار التكرار") + "&limit=2");
  const fillTitles = [...new Set((fillBody.results || []).map((r) => r.title))];
  check("29f limit=2 still returns 2 distinct titles after dedup",
    (fillBody.results || []).length === 2 && fillTitles.length === 2,
    JSON.stringify((fillBody.results || []).map((r) => r.title)));
  check("29g the 3 reposts of 'الأول' collapse to one tile",
    (fillBody.results || []).filter((r) => r.title === "اختبار التكرار الأول").length <= 1);
  // Browse path (empty q + source) dedupes the same way.
  const { body: browseBody } = await call({ TG_D1: D1 }, "/api/tg-search?source=repchan1");
  check("29h browse of one library collapses its reposts too",
    (browseBody.results || []).filter((r) => r.title === "اختبار التكرار الأول").length === 1,
    JSON.stringify((browseBody.results || []).map((r) => r.title)));
}

// 30. Format token (2026-11-26): a trailing known-format word is a
// filter on books.ext, not a search word — "قصة كل شخص pdf" must
// return only PDF rows, "قصة كل شخص epub" must return none (the
// fixture title exists as PDF only), and a bare "epub" must return
// nothing (never a whole-catalog browse).
{
  const p1 = parseFormatToken(["بيت", "الحرير", "epub"]);
  check("30a trailing epub is stripped + returned as the format",
    p1.format === "epub" && JSON.stringify(p1.words) === JSON.stringify(["بيت", "الحرير"]));
  const p2 = parseFormatToken(["قصة", "كل", "شخص"]);
  check("30b no format token: words pass through, format null",
    p2.format === null && JSON.stringify(p2.words) === JSON.stringify(["قصة", "كل", "شخص"]));
  const p3 = parseFormatToken(["epub"]);
  check("30c bare format token leaves no search words",
    p3.format === "epub" && p3.words.length === 0);
  const p4 = parseFormatToken(["كتاب", "PDF"]);
  check("30d token match is case-insensitive",
    p4.format === "pdf" && JSON.stringify(p4.words) === JSON.stringify(["كتاب"]));
  const p5 = parseFormatToken(["النشاطات", "المدرسية", "doc"]);
  check("30e doc IS a token here (indexer FMT_TRAIL omits it; search does not)",
    p5.format === "doc" && p5.words.length === 2);
  const p6 = parseFormatToken([]);
  check("30f empty words: no format", p6.format === null && p6.words.length === 0);

  const { body: pdfBody } = await call({ TG_D1: D1 }, "/api/tg-search?q=" + encodeURIComponent("قصة كل شخص pdf"));
  check("30g pdf query finds the PDF fixture",
    (pdfBody.results || []).some((r) => r.title === "قصة كل شخص"), JSON.stringify((pdfBody.results || []).slice(0, 2)));
  check("30h pdf query echoes format + every row is PDF",
    pdfBody.format === "pdf" && (pdfBody.results || []).length > 0
    && (pdfBody.results || []).every((r) => r.formats.includes("PDF")),
    `format=${pdfBody.format} total=${pdfBody.total}`);
  const { body: epubBody } = await call({ TG_D1: D1 }, "/api/tg-search?q=" + encodeURIComponent("قصة كل شخص epub"));
  check("30i same title as epub: every row is EPUB, the PDF fixture is excluded",
    (epubBody.results || []).length > 0
    && (epubBody.results || []).every((r) => r.formats.includes("EPUB"))
    && !(epubBody.results || []).some((r) => r.title === "قصة كل شخص")
    && epubBody.format === "epub",
    `total=${epubBody.total}`);
  const { body: bareBody } = await call({ TG_D1: D1 }, "/api/tg-search?q=epub");
  check("30j bare format token: total 0, never a catalog browse",
    bareBody.total === 0 && bareBody.format === "epub", `total=${bareBody.total}`);
  const { body: noTokBody } = await call({ TG_D1: D1 }, "/api/tg-search?q=" + encodeURIComponent("قصة كل شخص"));
  check("30k no token: no format field, fixture still found",
    !("format" in noTokBody) && (noTokBody.results || []).some((r) => r.title === "قصة كل شخص"));
  const { body: browseBody } = await call({ TG_D1: D1 }, "/api/tg-search?source=kotobkhana&q=epub");
  check("30l format token + source browses that library filtered to EPUB",
    browseBody.format === "epub" && (browseBody.results || []).length > 0
    && (browseBody.results || []).every((r) => r.formats.includes("EPUB")),
    `format=${browseBody.format} total=${browseBody.total}`);
}

// 31. Drive libraries (WAVE 4, WS8 — two-type model): visibility via
// the drive_libraries registry + the viewer's ?fp= fingerprint.
//   public (Oriental Music) + legacy-no-registry-row: everyone.
//   private: only its submitter (tg_id 111). pending_public:
//   submitter + owner (RLIBOOK_OWNER_ID 999) only.
// Fingerprints are 22-char tokens (same shape as the bot catalog
// fingerprint); the KV fp:<token> value is { tg_id, created_at }.
const FP_SUB = "1111111111111111111111"; // tg_id 111 (submitter)
const FP_OTHER = "2222222222222222222222"; // tg_id 222 (stranger)
const FP_OWNER = "3333333333333333333333"; // tg_id 999 (owner)
const DRIVE_Q = "/api/tg-search?q=" + encodeURIComponent("الدرايف");
function driveEnv(kvEntries = {}) {
  return { TG_D1: D1, RLIBOOK_KV: mockKV(kvEntries), RLIBOOK_OWNER_ID: "999" };
}
function fpEntries() {
  return {
    ["fp:" + FP_SUB]: JSON.stringify({ tg_id: 111, created_at: 1760000000 }),
    ["fp:" + FP_OTHER]: JSON.stringify({ tg_id: 222, created_at: 1760000000 }),
    ["fp:" + FP_OWNER]: JSON.stringify({ tg_id: 999, created_at: 1760000000 }),
  };
}
const driveTitles = (body) => (body.results || []).map((r) => r.title);
{
  // 31a anonymous: public + legacy only.
  const { body } = await call(driveEnv(fpEntries()), DRIVE_Q);
  check("31a anonymous sees the public Drive book", driveTitles(body).includes("كتاب الدرايف العام"), JSON.stringify(driveTitles(body)));
  check("31a2 anonymous sees the legacy (no registry row) Drive book", driveTitles(body).includes("كتاب الدرايف القديم"));
  check("31a3 anonymous does NOT see the private Drive book", !driveTitles(body).includes("كتاب الدرايف الخاص"));
  check("31a4 anonymous does NOT see the pending Drive book", !driveTitles(body).includes("كتاب الدرايف المعلق"));
  check("31a5 anonymous total is 2", body.total === 2, `total=${body.total}`);
  const pub = (body.results || []).find((r) => r.title === "كتاب الدرايف العام");
  check("31a6 public Drive book: kind drive + library name, source hidden",
    pub && pub.kind === "drive" && pub.library === "Oriental Music" && pub.source === null, JSON.stringify(pub));
  const leg = (body.results || []).find((r) => r.title === "كتاب الدرايف القديم");
  check("31a7 legacy Drive book: kind drive + library null (no registry row)",
    leg && leg.kind === "drive" && leg.library === null, JSON.stringify(leg));
  check("31a8 Drive EPUB: get link lib=drive (/kindle/get), send link, reader link",
    pub && pub.get !== null && pub.get.startsWith("/kindle/get?lib=drive&id=DRIVEPUBFILEID001&f=epub&t=")
    && pub.send !== null && pub.send.startsWith("/api/send-to-kindle?lib=drive&id=DRIVEPUBFILEID001&f=epub&t=")
    && pub.read !== null && pub.read.startsWith("/site/reader/?lib=drive&id=DRIVEPUBFILEID001&f=epub&title="),
    JSON.stringify(pub));
  // 31b submitter (fp=FP_SUB): all four.
  const { body: subBody } = await call(driveEnv(fpEntries()), DRIVE_Q + "&fp=" + FP_SUB);
  check("31b submitter sees all four Drive books",
    ["كتاب الدرايف العام", "كتاب الدرايف الخاص", "كتاب الدرايف المعلق", "كتاب الدرايف القديم"].every((t) => driveTitles(subBody).includes(t)),
    JSON.stringify(driveTitles(subBody)));
  const priv = (subBody.results || []).find((r) => r.title === "كتاب الدرايف الخاص");
  check("31b2 private Drive PDF: get + send link, no reader link (PDF is not readable online)",
    priv && priv.get !== null && priv.get.startsWith("/kindle/get?lib=drive&id=DRIVEPRIVFILEID01&f=pdf&t=")
    && priv.send !== null && priv.send.startsWith("/api/send-to-kindle?lib=drive&id=DRIVEPRIVFILEID01&f=pdf&t=")
    && priv.read === null, JSON.stringify(priv));
  // 31c stranger (fp=FP_OTHER): public + legacy only.
  const { body: othBody } = await call(driveEnv(fpEntries()), DRIVE_Q + "&fp=" + FP_OTHER);
  check("31c stranger sees public + legacy only",
    driveTitles(othBody).includes("كتاب الدرايف العام") && driveTitles(othBody).includes("كتاب الدرايف القديم")
    && !driveTitles(othBody).includes("كتاب الدرايف الخاص") && !driveTitles(othBody).includes("كتاب الدرايف المعلق"),
    JSON.stringify(driveTitles(othBody)));
  // 31d owner (fp=FP_OWNER): public + legacy + pending, NOT private.
  const { body: ownBody } = await call(driveEnv(fpEntries()), DRIVE_Q + "&fp=" + FP_OWNER);
  check("31d owner sees public + legacy + pending, NOT private",
    driveTitles(ownBody).includes("كتاب الدرايف العام") && driveTitles(ownBody).includes("كتاب الدرايف القديم")
    && driveTitles(ownBody).includes("كتاب الدرايف المعلق") && !driveTitles(ownBody).includes("كتاب الدرايف الخاص"),
    JSON.stringify(driveTitles(ownBody)));
  // 31e per-library browse (?source=drive:<folderId>, empty q).
  const { body: brPub } = await call(driveEnv(fpEntries()), "/api/tg-search?source=" + encodeURIComponent("drive:" + F_PUB));
  check("31e anonymous browses the public Drive library",
    brPub.total === 1 && driveTitles(brPub).includes("كتاب الدرايف العام"), `total=${brPub.total}`);
  const { body: brPriv } = await call(driveEnv(fpEntries()), "/api/tg-search?source=" + encodeURIComponent("drive:" + F_PRIV));
  check("31e2 anonymous browsing the private Drive library gets nothing",
    brPriv.total === 0 && (brPriv.results || []).length === 0, `total=${brPriv.total}`);
  // 31f flagged Drive book (legacy per-row flag:drive:<fileId> key):
  // shown with the flag, source populated, NO delivery links, and NO
  // bot deep link (the bot has no dl_drive_ link).
  const { body: flBody } = await call(
    driveEnv({ ...fpEntries(), "flag:drive:DRIVEPUBFILEID001": "1" }), DRIVE_Q);
  const fl = (flBody.results || []).find((r) => r.title === "كتاب الدرايف العام");
  check("31f flagged Drive book: flagged + source populated + no links + no bot link",
    fl && fl.flagged === true && fl.source === "drive:" + F_PUB
    && fl.get === null && fl.send === null && fl.read === null && fl.bot === null, JSON.stringify(fl));
  // 31g flagged Drive book via the flags:all blob (drive: entry).
  const blob = JSON.stringify({ flagged: ["drive:DRIVEPUBFILEID001"], hidden: [] });
  const { body: blBody } = await call(driveEnv({ ...fpEntries(), "flags:all": blob }), DRIVE_Q);
  const bl = (blBody.results || []).find((r) => r.title === "كتاب الدرايف العام");
  check("31g blob with a drive: entry flags the Drive book", bl && bl.flagged === true, JSON.stringify(bl && bl.flagged));
  // 31h unit checks: parseFlagsBlob accepts drive: entries; the
  // Drive URL helpers parse the file id and build the flag key.
  const pb = parseFlagsBlob({ flagged: ["drive:DRIVEPUBFILEID001", "kotobkhana:7559"], hidden: [] });
  check("31h parseFlagsBlob keeps drive: entries",
    pb && pb.flagged.has("drive:DRIVEPUBFILEID001") && pb.flagged.has("kotobkhana:7559"), JSON.stringify(pb && [...pb.flagged]));
  check("31h2 parseDriveFileUrl extracts the file id",
    JSON.stringify(parseDriveFileUrl("https://drive.google.com/file/d/DRIVEPUBFILEID001/view")) === JSON.stringify({ fileId: "DRIVEPUBFILEID001" }));
  check("31h3 parseDriveFileUrl returns null for a t.me URL",
    parseDriveFileUrl("https://t.me/kotobkhana/7559") === null);
  check("31h4 driveFlagKey builds drive:<fileId>",
    driveFlagKey("https://drive.google.com/file/d/DRIVEPUBFILEID001/view") === "drive:DRIVEPUBFILEID001"
    && driveFlagKey("https://t.me/kotobkhana/7559") === null);
  // 31i unit checks: gatedLinks for Drive rows.
  const gEpub = gatedLinks({ url: "https://drive.google.com/file/d/DRIVEPUBFILEID001/view", ext: "epub", title: "كتاب الدرايف العام" }, false);
  check("31i gatedLinks Drive EPUB: get + send + read",
    gEpub.get !== null && gEpub.get.startsWith("/kindle/get?lib=drive&id=DRIVEPUBFILEID001&f=epub")
    && gEpub.send !== null && gEpub.send.startsWith("/api/send-to-kindle?lib=drive&id=DRIVEPUBFILEID001&f=epub")
    && gEpub.read !== null && gEpub.read.startsWith("/site/reader/?lib=drive&id=DRIVEPUBFILEID001&f=epub"),
    JSON.stringify(gEpub));
  const gPdf = gatedLinks({ url: "https://drive.google.com/file/d/DRIVEPRIVFILEID01/view", ext: "pdf", title: "كتاب الدرايف الخاص" }, false);
  check("31i2 gatedLinks Drive PDF: get + send only", gPdf.get !== null && gPdf.get.startsWith("/kindle/get?lib=drive&id=DRIVEPRIVFILEID01&f=pdf") && gPdf.send !== null && gPdf.read === null, JSON.stringify(gPdf));
  const gFlag = gatedLinks({ url: "https://drive.google.com/file/d/DRIVEPUBFILEID001/view", ext: "epub", title: "كتاب الدرايف العام" }, true);
  check("31i3 gatedLinks flagged Drive: all null", gFlag.get === null && gFlag.send === null && gFlag.read === null, JSON.stringify(gFlag));
  // 31j bad Drive source: a folder id under 10 chars is a 400.
  const { status: badStatus } = await call(driveEnv(fpEntries()), "/api/tg-search?source=" + encodeURIComponent("drive:short"));
  check("31j source=drive:short -> 400", badStatus === 400, `status=${badStatus}`);
  // 31k removed / unavailable Drive libraries: hidden from
  // EVERYONE — anonymous, submitter, and owner alike (the books
  // rows stay in D1, but no surface shows them). Even a direct
  // browse of the removed library by its own submitter is empty.
  const { body: remAnon } = await call(driveEnv(fpEntries()), DRIVE_Q);
  check("31k anonymous does NOT see the removed Drive book", !driveTitles(remAnon).includes("كتاب الدرايف المحذوف"));
  check("31k2 anonymous does NOT see the unavailable Drive book", !driveTitles(remAnon).includes("كتاب الدرايف غير المتاح"));
  const { body: remSub } = await call(driveEnv(fpEntries()), DRIVE_Q + "&fp=" + FP_SUB);
  check("31k3 submitter does NOT see the removed Drive book", !driveTitles(remSub).includes("كتاب الدرايف المحذوف"), JSON.stringify(driveTitles(remSub)));
  check("31k4 submitter does NOT see the unavailable Drive book", !driveTitles(remSub).includes("كتاب الدرايف غير المتاح"));
  const { body: remOwn } = await call(driveEnv(fpEntries()), DRIVE_Q + "&fp=" + FP_OWNER);
  check("31k5 owner does NOT see the removed Drive book", !driveTitles(remOwn).includes("كتاب الدرايف المحذوف"));
  check("31k6 owner does NOT see the unavailable Drive book", !driveTitles(remOwn).includes("كتاب الدرايف غير المتاح"));
  const { body: brRem } = await call(driveEnv(fpEntries()), "/api/tg-search?source=" + encodeURIComponent("drive:" + F_REM) + "&fp=" + FP_SUB);
  check("31k7 submitter browsing the removed library gets nothing",
    brRem.total === 0 && (brRem.results || []).length === 0, `total=${brRem.total}`);
}

// 32. D1 read-budget fix (2026-11-26, wave 4 workstream 7):
// rows-first + conditional COUNT. d1Search used to run a COUNT(*)
// FIRST on every tier and then the rows query — two full
// enumerations of the match set per tier. Now the rows query runs
// first and the COUNT runs only when the returned page is full
// (rows.length === limit: the total may exceed the page) or empty
// past an offset (total < offset is the only other case an empty
// page can mean). When the page is NOT full, total = offset +
// rows.length exactly. The COUNT that still runs is a direct-FTS
// count when no source/format filter applies, and the join form
// only when a filter applies — or when a restricted (private /
// pending_public) Drive library exists (WAVE 7, wave-7 child A:
// the direct count cannot carry the visibility filter, so with a
// restricted library present the join form runs even unfiltered,
// and the full-page total can never overcount invisible Drive
// matches; with no restricted library the direct form stays).
// These checks count the actual
// SELECT COUNT(*) statements executed per request (coverage is a
// MAX(id) refresh, not a COUNT, so it never pollutes the count)
// and assert the totals stay exact.
const ZZCOUNT = [];
for (let i = 1; i <= 40; i++) {
  // Two-letter suffix (A1..A40): a 1-char suffix would be dropped by
  // queryWords (len>=2) and dedupeTitleKey would collapse all 40
  // fixtures to one tile — the page must hold 40 DISTINCT titles.
  ZZCOUNT.push([`ZZCount A${i}`, "ZZCount Author", "zzchan", "channel", "epub", "1.0 MB", "2026-11-20", `https://t.me/zzchan/${1000 + i}`, `ZZCount A${i}.epub`]);
}
ZZCOUNT.forEach((f, j) => {
  const id = 900201 + j;
  insBook.run(id, f[0], f[1], f[2], f[3], f[4], f[5], f[6], f[7], f[8]);
  insFts.run(id, norm(f[0]), norm(f[1]));
});
function recordingD1(sqlite) {
  const base = mockD1(sqlite);
  const statements = [];
  return {
    db: {
      prepare(sql) {
        statements.push(sql);
        return base.prepare(sql);
      },
    },
    statements,
    counts() { return statements.filter((s) => s.startsWith("SELECT COUNT(*)")); },
  };
}
{
  // Coverage is a KV hit here (indexed 422821), so d1Coverage runs
  // no D1 statement and only the search COUNTs are counted.
  const kvCov = mockKVStore({ "tg-search:coverage": JSON.stringify({ indexed: 422821, at: Date.now() }) });
  const rec = recordingD1(db);
  const env = { TG_D1: rec.db, RLIBOOK_KV: kvCov };
  const countStmts = () => rec.counts();
  // 32a: small result — ZERO COUNT, exact total. (The Nov 13 shard
  // sample holds a second copy of the fixture title, so the exact
  // total is the tier-0 FTS count from the DB, not 1.)
  let before = countStmts().length;
  const expectedSmall = db.prepare("SELECT COUNT(*) AS n FROM books_fts WHERE books_fts MATCH ?")
    .get(ladderQueries(queryWords("Everyone in This Bank Is a Thief"))[0].expr).n;
  const { body: small } = await call(env, "/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"));
  check("32a small result: ZERO COUNT statements, total still exact",
    countStmts().length - before === 0 && small.total === expectedSmall && expectedSmall >= 1,
    `counts=${countStmts().length - before} total=${small.total} expected=${expectedSmall}`);
  // 32b: full page (40 matches, fetchLimit 30) — exactly ONE COUNT,
  // total exact (40). WAVE 7 (wave-7 child A): the COUNT is the JOIN
  // form WITH the driveVisibility clause, not the direct-FTS form —
  // this test DB holds restricted Drive libraries (private +
  // pending_public fixtures from §31), so the direct count (which
  // cannot carry a books-table filter) must NOT run: it would
  // overcount invisible Drive matches. The statement-count intent
  // (ONE COUNT, exact total) is unchanged; only the form follows
  // the visibility state. The direct form is covered by 32b2 below
  // on a DB with no restricted library.
  before = countStmts().length;
  const { body: full } = await call(env, "/api/tg-search?q=zzcount&limit=10");
  const newCounts = countStmts().slice(before);
  check("32b full page: exactly ONE COUNT, JOIN form with visibility clause, total exact (40)",
    newCounts.length === 1
    && newCounts[0].startsWith("SELECT COUNT(*) AS n FROM books b")
    && newCounts[0].includes("WHERE b.id IN (SELECT rowid FROM books_fts")
    && newCounts[0].includes("drive_libraries")
    && full.total === 40 && (full.results || []).length === 10,
    `counts=${JSON.stringify(newCounts)} total=${full.total} results=${(full.results || []).length}`);
  // 32b2: direct-FTS form when NO restricted Drive library exists.
  // A separate mini-DB (same schema, one PUBLIC Drive library only,
  // 6 books sharing one word) — the unfiltered full-page COUNT must
  // be the direct form again, with an exact total.
  const db2 = new DatabaseSync(":memory:");
  db2.exec(`
    CREATE TABLE books (
      id INTEGER PRIMARY KEY, title TEXT NOT NULL, author TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'channel',
      ext TEXT NOT NULL DEFAULT '', size TEXT NOT NULL DEFAULT '',
      date TEXT NOT NULL DEFAULT '', url TEXT NOT NULL,
      filename TEXT NOT NULL DEFAULT '',
      UNIQUE(url, filename)
    );
    CREATE VIRTUAL TABLE books_fts USING fts5(title, author, tokenize='unicode61 remove_diacritics 1');
    CREATE INDEX idx_books_source ON books(source);
    CREATE TABLE drive_libraries (
      folder_id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '',
      visibility TEXT NOT NULL DEFAULT 'public',
      submitter_tg_id INTEGER, added_at TEXT NOT NULL DEFAULT ''
    );
  `);
  db2.prepare(
    "INSERT INTO drive_libraries(folder_id,title,visibility,submitter_tg_id,added_at) VALUES (?,?,?,?,?)",
  ).run(F_PUB, "Oriental Music", "public", null, "2026-11-22");
  const ins2Book = db2.prepare(
    "INSERT INTO books(id,title,author,source,kind,ext,size,date,url,filename) VALUES (?,?,?,?,?,?,?,?,?,?)",
  );
  const ins2Fts = db2.prepare("INSERT INTO books_fts(rowid,title,author) VALUES (?,?,?)");
  for (let i = 1; i <= 6; i++) {
    ins2Book.run(1000 + i, `ZZDirect A${i}`, "ZZDirect Author", "zzchan", "channel", "epub", "1.0 MB", "2026-11-20", `https://t.me/zzchan/${2000 + i}`, `ZZDirect A${i}.epub`);
    ins2Fts.run(1000 + i, norm(`ZZDirect A${i}`), norm("ZZDirect Author"));
  }
  const rec2 = recordingD1(db2);
  const kvCov2 = mockKVStore({ "tg-search:coverage": JSON.stringify({ indexed: 422821, at: Date.now() }) });
  const env2 = { TG_D1: rec2.db, RLIBOOK_KV: kvCov2 };
  const before2 = rec2.counts().length;
  const { body: direct } = await call(env2, "/api/tg-search?q=zzdirect&limit=2");
  const newCounts2 = rec2.counts().slice(before2);
  check("32b2 no restricted Drive library: exactly ONE COUNT, direct-FTS form, total exact (6)",
    newCounts2.length === 1
    && newCounts2[0] === "SELECT COUNT(*) AS n FROM books_fts WHERE books_fts MATCH ?"
    && direct.total === 6 && (direct.results || []).length === 2,
    `counts=${JSON.stringify(newCounts2)} total=${direct.total} results=${(direct.results || []).length}`);
  // 32c: wide page (limit 50 -> fetchLimit 50 > 40) — ZERO COUNT, total exact.
  before = countStmts().length;
  const { body: wide } = await call(env, "/api/tg-search?q=zzcount&limit=50");
  check("32c wide page (all 40 fit): ZERO COUNT, total exact (40)",
    countStmts().length - before === 0 && wide.total === 40 && (wide.results || []).length === 40,
    `counts=${countStmts().length - before} total=${wide.total}`);
  // 32d: partial last page (offset 30 -> 10 rows < fetchLimit) — ZERO COUNT.
  before = countStmts().length;
  const { body: last } = await call(env, "/api/tg-search?q=zzcount&limit=10&offset=30");
  check("32d partial last page: ZERO COUNT, total exact (40)",
    countStmts().length - before === 0 && last.total === 40 && (last.results || []).length === 10,
    `counts=${countStmts().length - before} total=${last.total}`);
  // 32e: empty page past the end (offset 45 > total 40) — ONE COUNT,
  // total stays 40 (not offset, not 0).
  before = countStmts().length;
  const { body: past } = await call(env, "/api/tg-search?q=zzcount&limit=10&offset=45");
  check("32e empty page past the end: ONE COUNT, total exact (40), no rows",
    countStmts().length - before === 1 && past.total === 40 && (past.results || []).length === 0,
    `counts=${countStmts().length - before} total=${past.total}`);
  // 32f: no-match query — all tiers miss on the rows query alone, ZERO COUNT.
  before = countStmts().length;
  const { body: none } = await call(env, "/api/tg-search?q=" + encodeURIComponent("zzzqqqxxyy"));
  check("32f no-match: ZERO COUNT statements, total 0",
    countStmts().length - before === 0 && none.total === 0 && none.match === null,
    `counts=${countStmts().length - before} total=${none.total}`);
  // 32g: source browse, small library (1 row < fetchLimit) — ZERO COUNT.
  before = countStmts().length;
  const { body: browse } = await call(env, "/api/tg-search?source=dupchanD&limit=5");
  check("32g small browse: ZERO COUNT, total exact (1)",
    countStmts().length - before === 0 && browse.total === 1 && (browse.results || []).length === 1,
    `counts=${countStmts().length - before} total=${browse.total}`);
  // 32h: filtered search (source present) with a full page — ONE COUNT,
  // JOIN form (the filter lives on `books`, so the count must join).
  before = countStmts().length;
  const { body: filt } = await call(env, "/api/tg-search?q=zzcount&source=zzchan&limit=10");
  const filtCounts = countStmts().slice(before);
  check("32h filtered full page: exactly ONE COUNT, JOIN form, total exact (40)",
    filtCounts.length === 1
    && filtCounts[0].startsWith("SELECT COUNT(*) AS n FROM books b")
    && filtCounts[0].includes("WHERE b.id IN (SELECT rowid FROM books_fts")
    && filt.total === 40,
    `counts=${JSON.stringify(filtCounts)} total=${filt.total}`);
  // 32i: MAX(id) premise — on dense (production-shaped) ids the
  // estimate IS the count.
  const dense = new DatabaseSync(":memory:");
  dense.exec("CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT)");
  const insDense = dense.prepare("INSERT INTO books(id,title) VALUES (?,?)");
  for (let i = 1; i <= 100; i++) insDense.run(i, `Book ${i}`);
  check("32i dense ids: MAX(id) === COUNT(*) (the estimator's premise)",
    dense.prepare("SELECT MAX(id) AS n FROM books").get().n === 100
    && dense.prepare("SELECT COUNT(*) AS n FROM books").get().n === 100);
}

// 33. Drive single-book lookup + fp threading on ?h=&p= + the
// countTotal overcount fix (WAVE 7, wave-7 child A). The ?h=&p=
// path previously resolved Telegram posts only, so a Drive book
// was unreachable there at all; now ?h=drive&p=<fileId> resolves
// it, subject to the same ?fp= visibility as search — an invisible
// library's book reads as { book: null }, never as a title leak.
// Fixtures: 5 public + 1 private Drive books sharing one word, so
// the unfiltered full-page COUNT can be checked for overcounting.
const ZZDRIVE = [
  ["ZZDrive Pub A1", "ZZDrive Author", "drive:" + F_PUB, "drive", "epub", "1.0 MB", "2026-11-20", "https://drive.google.com/file/d/ZZDRIVEPUB0001/view", "ZZDrive Pub A1.epub"],
  ["ZZDrive Pub A2", "ZZDrive Author", "drive:" + F_PUB, "drive", "epub", "1.0 MB", "2026-11-20", "https://drive.google.com/file/d/ZZDRIVEPUB0002/view", "ZZDrive Pub A2.epub"],
  ["ZZDrive Pub A3", "ZZDrive Author", "drive:" + F_PUB, "drive", "epub", "1.0 MB", "2026-11-20", "https://drive.google.com/file/d/ZZDRIVEPUB0003/view", "ZZDrive Pub A3.epub"],
  ["ZZDrive Pub A4", "ZZDrive Author", "drive:" + F_PUB, "drive", "epub", "1.0 MB", "2026-11-20", "https://drive.google.com/file/d/ZZDRIVEPUB0004/view", "ZZDrive Pub A4.epub"],
  ["ZZDrive Pub A5", "ZZDrive Author", "drive:" + F_PUB, "drive", "epub", "1.0 MB", "2026-11-20", "https://drive.google.com/file/d/ZZDRIVEPUB0005/view", "ZZDrive Pub A5.epub"],
  ["ZZDrive Priv A1", "ZZDrive Author", "drive:" + F_PRIV, "drive", "epub", "1.0 MB", "2026-11-20", "https://drive.google.com/file/d/ZZDRIVEPRIV001/view", "ZZDrive Priv A1.epub"],
];
ZZDRIVE.forEach((f, j) => {
  const id = 900301 + j;
  insBook.run(id, f[0], f[1], f[2], f[3], f[4], f[5], f[6], f[7], f[8]);
  insFts.run(id, norm(f[0]), norm(f[1]));
});
{
  // 33a anonymous ?h=drive&p=<public fileId> -> the book, with a
  // /kindle/get link (lib=drive).
  const { status, body } = await call(driveEnv(fpEntries()), "/api/tg-search?h=drive&p=DRIVEPUBFILEID001");
  check("33a anonymous Drive lookup: public book + get link lib=drive",
    status === 200 && body.book && body.book.title === "كتاب الدرايف العام"
    && body.book.kind === "drive" && body.book.library === "Oriental Music"
    && body.book.get !== null && body.book.get.startsWith("/kindle/get?lib=drive&id=DRIVEPUBFILEID001&f=epub&t="),
    `status=${status} ` + JSON.stringify(body.book));
  // 33b anonymous ?h=drive&p=<private fileId> -> book null, no leak.
  const { body: privBody } = await call(driveEnv(fpEntries()), "/api/tg-search?h=drive&p=DRIVEPRIVFILEID01");
  check("33b anonymous Drive lookup: private book reads as null (no title leak)",
    privBody.book === null, JSON.stringify(privBody.book));
  // 33c submitter fp on the private file -> the book, with get link.
  const { body: subBook } = await call(driveEnv(fpEntries()), "/api/tg-search?h=drive&p=DRIVEPRIVFILEID01&fp=" + FP_SUB);
  check("33c submitter Drive lookup: private book + get link lib=drive",
    subBook.book && subBook.book.title === "كتاب الدرايف الخاص"
    && subBook.book.get !== null && subBook.book.get.startsWith("/kindle/get?lib=drive&id=DRIVEPRIVFILEID01&f=pdf&t="),
    JSON.stringify(subBook.book));
  // 33d pending file: owner sees it, stranger does not.
  const { body: ownPend } = await call(driveEnv(fpEntries()), "/api/tg-search?h=drive&p=DRIVEPENDFILEID01&fp=" + FP_OWNER);
  check("33d owner Drive lookup: pending book returned",
    ownPend.book && ownPend.book.title === "كتاب الدرايف المعلق", JSON.stringify(ownPend.book));
  const { body: othPend } = await call(driveEnv(fpEntries()), "/api/tg-search?h=drive&p=DRIVEPENDFILEID01&fp=" + FP_OTHER);
  check("33d2 stranger Drive lookup: pending book reads as null",
    othPend.book === null, JSON.stringify(othPend.book));
  // 33e validation: a short file id is a 400; a numeric p under
  // h=drive stays the Telegram path (channel "drive", unknown post
  // -> book null, not a 400).
  const badDrive = await call(driveEnv(fpEntries()), "/api/tg-search?h=drive&p=short");
  check("33e h=drive&p=short -> 400", badDrive.status === 400, `status=${badDrive.status}`);
  const numDrive = await call(driveEnv(fpEntries()), "/api/tg-search?h=drive&p=12345");
  check("33e2 h=drive&p=12345 (numeric) -> Telegram path, unknown post -> book null",
    numDrive.status === 200 && numDrive.body.book === null, `status=${numDrive.status} ` + JSON.stringify(numDrive.body.book));
  // 33f unit checks: isDriveLookup + d1LookupByDriveFile with vis.
  check("33f isDriveLookup: file id yes, numeric post no, other handle no, short no",
    isDriveLookup("drive", "DRIVEPUBFILEID001") === true
    && isDriveLookup("drive", "7559") === false
    && isDriveLookup("kotobkhana", "DRIVEPUBFILEID001") === false
    && isDriveLookup("drive", "short") === false);
  const VIS_ANON = { hasRegistry: true, hasRestrictedDrive: true, viewerTgId: -1, isOwner: false };
  const VIS_SUB = { hasRegistry: true, hasRestrictedDrive: true, viewerTgId: 111, isOwner: false };
  const VIS_OWNER = { hasRegistry: true, hasRestrictedDrive: true, viewerTgId: 999, isOwner: true };
  const legacyRow = await d1LookupByDriveFile(D1, "DRIVEPRIVFILEID01");
  check("33f2 d1LookupByDriveFile without vis: legacy no-filter row returned",
    legacyRow && legacyRow.title === "كتاب الدرايف الخاص", JSON.stringify(legacyRow && legacyRow.title));
  const anonRow = await d1LookupByDriveFile(D1, "DRIVEPRIVFILEID01", VIS_ANON);
  check("33f3 d1LookupByDriveFile with anon vis: private row -> null", anonRow === null, JSON.stringify(anonRow));
  const subRow = await d1LookupByDriveFile(D1, "DRIVEPRIVFILEID01", VIS_SUB);
  check("33f4 d1LookupByDriveFile with submitter vis: private row returned",
    subRow && subRow.title === "كتاب الدرايف الخاص", JSON.stringify(subRow && subRow.title));
  const ownPendRow = await d1LookupByDriveFile(D1, "DRIVEPENDFILEID01", VIS_OWNER);
  check("33f5 d1LookupByDriveFile with owner vis: pending row returned",
    ownPendRow && ownPendRow.title === "كتاب الدرايف المعلق", JSON.stringify(ownPendRow && ownPendRow.title));
  const noRow = await d1LookupByDriveFile(D1, "NOPEFILEID0001", VIS_ANON);
  check("33f6 d1LookupByDriveFile unknown file id -> null", noRow === null);
  const tgRow = await d1LookupByPost(D1, "kotobkhana", 7559, VIS_ANON);
  check("33f7 d1LookupByPost with vis still resolves a Telegram post",
    tgRow && tgRow.title !== undefined, JSON.stringify(tgRow && tgRow.title));
  // 33g the countTotal overcount fix: anonymous unfiltered search
  // matching 5 public + 1 private Drive books, full page
  // (limit=1 -> fetchLimit 3) — the ONE COUNT must be the join
  // form and the total must be 5, not 6. Submitter sees 6.
  const rec33 = recordingD1(db);
  const env33 = {
    TG_D1: rec33.db,
    RLIBOOK_KV: mockKVStore({ ...fpEntries(), "tg-search:coverage": JSON.stringify({ indexed: 422821, at: Date.now() }) }),
    RLIBOOK_OWNER_ID: "999",
  };
  let before33 = rec33.counts().length;
  const { body: anonCount } = await call(env33, "/api/tg-search?q=zzdrive&limit=1");
  const anonCounts = rec33.counts().slice(before33);
  check("33g anonymous full page over Drive books: ONE COUNT, JOIN form, total 5 (private excluded)",
    anonCounts.length === 1
    && anonCounts[0].startsWith("SELECT COUNT(*) AS n FROM books b")
    && anonCounts[0].includes("drive_libraries")
    && anonCount.total === 5 && (anonCount.results || []).length === 1,
    `counts=${JSON.stringify(anonCounts)} total=${anonCount.total}`);
  before33 = rec33.counts().length;
  const { body: subCount } = await call(env33, "/api/tg-search?q=zzdrive&limit=1&fp=" + FP_SUB);
  check("33g2 submitter full page over the same books: total 6 (private included)",
    subCount.total === 6 && (subCount.results || []).length === 1,
    `total=${subCount.total}`);
  // 34. rlb_fp cookie fallback (WAVE 7, A3): no ?fp= -> the cookie
  // is read server-side and verified through the same KV lookup;
  // ?fp= wins when present; unknown/malformed cookie -> anonymous.
  const FP_UNKNOWN = "4444444444444444444444"; // 22 chars, not in KV
  const { body: ckSub } = await call(driveEnv(fpEntries()), DRIVE_Q, { Cookie: "rlb_fp=" + FP_SUB });
  check("34a cookie-only submitter sees all four Drive books",
    ["كتاب الدرايف العام", "كتاب الدرايف الخاص", "كتاب الدرايف المعلق", "كتاب الدرايف القديم"].every((t) => driveTitles(ckSub).includes(t)),
    JSON.stringify(driveTitles(ckSub)));
  check("34a2 cookie-only submitter total is 4", ckSub.total === 4, `total=${ckSub.total}`);
  const { body: ckOth } = await call(driveEnv(fpEntries()), DRIVE_Q, { Cookie: "rlb_fp=" + FP_OTHER });
  check("34b cookie-only stranger sees public + legacy only",
    driveTitles(ckOth).includes("كتاب الدرايف العام") && driveTitles(ckOth).includes("كتاب الدرايف القديم")
    && !driveTitles(ckOth).includes("كتاب الدرايف الخاص") && !driveTitles(ckOth).includes("كتاب الدرايف المعلق"),
    JSON.stringify(driveTitles(ckOth)));
  const { status: sUnk, body: ckUnk } = await call(driveEnv(fpEntries()), DRIVE_Q, { Cookie: "rlb_fp=" + FP_UNKNOWN });
  check("34c unknown cookie -> 200, anonymous (public + legacy, total 2)",
    sUnk === 200 && ckUnk.total === 2 && !driveTitles(ckUnk).includes("كتاب الدرايف الخاص"),
    `status=${sUnk} total=${ckUnk.total} ${JSON.stringify(driveTitles(ckUnk))}`);
  const { body: ckWin } = await call(driveEnv(fpEntries()), DRIVE_Q + "&fp=" + FP_OTHER, { Cookie: "rlb_fp=" + FP_SUB });
  check("34d ?fp= wins over cookie (?fp= stranger + cookie submitter -> public + legacy only)",
    !driveTitles(ckWin).includes("كتاب الدرايف الخاص") && !driveTitles(ckWin).includes("كتاب الدرايف المعلق"),
    JSON.stringify(driveTitles(ckWin)));
  const { body: ckWin2 } = await call(driveEnv(fpEntries()), DRIVE_Q + "&fp=" + FP_SUB, { Cookie: "rlb_fp=" + FP_OTHER });
  check("34e ?fp= wins over cookie (?fp= submitter + cookie stranger -> all four)",
    ["كتاب الدرايف العام", "كتاب الدرايف الخاص", "كتاب الدرايف المعلق", "كتاب الدرايف القديم"].every((t) => driveTitles(ckWin2).includes(t)),
    JSON.stringify(driveTitles(ckWin2)));
  const { status: sBad, body: ckBad } = await call(driveEnv(fpEntries()), DRIVE_Q, { Cookie: "rlb_fp=%ZZ; other=x" });
  check("34f malformed cookie -> 200, anonymous (never a 500)",
    sBad === 200 && ckBad.total === 2 && !driveTitles(ckBad).includes("كتاب الدرايف الخاص"),
    `status=${sBad} total=${ckBad.total}`);
  const { body: ckNo } = await call(driveEnv(fpEntries()), DRIVE_Q, { Cookie: "other=1; session=abc" });
  check("34g unrelated cookies only -> anonymous (public + legacy, total 2)",
    ckNo.total === 2 && !driveTitles(ckNo).includes("كتاب الدرايف الخاص"),
    `total=${ckNo.total} ${JSON.stringify(driveTitles(ckNo))}`);
  // 35. Delivery links carry the verified fp (WAVE 7 merge fix):
  // /kindle/get and /api/send-to-kindle resolve identity from
  // ?fp= OR the rlb_fp cookie, and a search visitor may carry
  // ?fp= with no cookie set yet — so gatedLinks threads the
  // verified fp onto get + send. The read link never carries it
  // (the site reader has no server gate). Anonymous -> no fp in
  // any link; flagged -> no links at all, fp or not.
  const gFp = gatedLinks({ url: "https://drive.google.com/file/d/DRIVEPUBFILEID001/view", ext: "epub", title: "كتاب الدرايف العام" }, false, FP_SUB);
  check("35a gatedLinks Drive EPUB + fp: get + send carry &fp=, read does not",
    gFp.get !== null && gFp.get.endsWith("&fp=" + FP_SUB)
    && gFp.send !== null && gFp.send.endsWith("&fp=" + FP_SUB)
    && gFp.read !== null && !gFp.read.includes("fp="),
    JSON.stringify(gFp));
  const gNoFp = gatedLinks({ url: "https://drive.google.com/file/d/DRIVEPUBFILEID001/view", ext: "epub", title: "كتاب الدرايف العام" }, false);
  check("35b gatedLinks Drive EPUB, no fp: no &fp= in any link",
    gNoFp.get !== null && !gNoFp.get.includes("fp=") && !gNoFp.send.includes("fp=") && !gNoFp.read.includes("fp="),
    JSON.stringify(gNoFp));
  const gTgFp = gatedLinks({ url: "https://t.me/kotobkhana/7559", ext: "pdf", title: "T" }, false, FP_SUB);
  check("35c gatedLinks Telegram PDF + fp: get + send carry &fp=",
    gTgFp.get !== null && gTgFp.get.endsWith("&fp=" + FP_SUB) && gTgFp.send !== null && gTgFp.send.endsWith("&fp=" + FP_SUB),
    JSON.stringify(gTgFp));
  const gFlagFp = gatedLinks({ url: "https://drive.google.com/file/d/DRIVEPUBFILEID001/view", ext: "epub", title: "كتاب الدرايف العام" }, true, FP_SUB);
  check("35d gatedLinks flagged + fp: still all null",
    gFlagFp.get === null && gFlagFp.send === null && gFlagFp.read === null, JSON.stringify(gFlagFp));
  const { body: fpSub } = await call(driveEnv(fpEntries()), DRIVE_Q + "&fp=" + FP_SUB);
  const privRow = (fpSub.results || []).find((r) => r.title === "كتاب الدرايف الخاص");
  check("35e live search as submitter: private book get + send carry &fp=",
    !!privRow && privRow.get !== null && privRow.get.includes("&fp=" + FP_SUB)
    && privRow.send !== null && privRow.send.includes("&fp=" + FP_SUB),
    JSON.stringify(privRow));
  const { body: fpAnon } = await call(driveEnv(fpEntries()), DRIVE_Q);
  check("35f live anonymous search: no result link carries &fp=",
    (fpAnon.results || []).every((r) => !(r.get || "").includes("fp=") && !(r.send || "").includes("fp=")),
    JSON.stringify((fpAnon.results || []).map((r) => r.get)));
  const { body: fpLk } = await call(driveEnv(fpEntries()), "/api/tg-search?h=drive&p=DRIVEPRIVFILEID01&fp=" + FP_SUB);
  check("35g live lookup as submitter: private book get carries &fp=",
    fpLk.book && fpLk.book.get !== null && fpLk.book.get.includes("&fp=" + FP_SUB),
    JSON.stringify(fpLk.book));
}

// 36. Search-response cache (v4.8.86, D1 root-fix step 1): a repeated
// search is served from caches.default (5 min) with no ladder D1
// read. Runs LAST: it installs a TTL-aware fake global `caches`
// (max-age honoured, injectable clock) and removes it in a finally,
// so no other section sees it. The per-request Drive-registry probes
// (sqlite_master + drive_libraries LIMIT 1, 2 tiny rows) still run
// on a HIT — they build the cache key — so the D1 proof is "no
// books/books_fts SQL", not "zero prepares".
function makeTtlEdgeCache() {
  const store = new Map(); // url -> { body, expiresAt }
  let now = Date.now();
  const cachesObj = {
    default: {
      match: async (url) => {
        const e = store.get(String(url));
        if (!e || now >= e.expiresAt) return null;
        return new Response(e.body, { headers: { "content-type": "application/json" } });
      },
      put: async (url, res) => {
        const cc = res.headers.get("cache-control") || "";
        const m = /max-age=(\d+)/.exec(cc);
        const maxAge = m ? parseInt(m[1], 10) : 0;
        store.set(String(url), { body: await res.text(), expiresAt: now + maxAge * 1000 });
      },
    },
  };
  return { cachesObj, store, advance: (ms) => { now += ms; } };
}

// D1 mock that records every prepared SQL (so the tests can prove a
// HIT ran no ladder query) instead of only counting one statement.
function countingAllD1(sqlite) {
  const base = mockD1(sqlite);
  const sqls = [];
  return {
    db: {
      prepare(sql) {
        sqls.push(sql);
        return base.prepare(sql);
      },
    },
    get sqls() { return sqls; },
    reset() { sqls.length = 0; },
  };
}

const SEARCH_Q = "/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief");
const isProbeSql = (s) => s.startsWith("SELECT 1 AS n");
{
  // 36a-c: key builder (pure).
  const baseKey = buildSearchCacheKey({ qn: "test", source: "", limit: 10, offset: 0, smart: false, botKey: false, viewerTgId: -1, isOwner: false });
  check("36a key folds spellings that normalize alike (tashkeel)",
    buildSearchCacheKey({ qn: "الجلّاد", source: "", limit: 10, offset: 0, smart: false, botKey: false, viewerTgId: -1, isOwner: false })
    === buildSearchCacheKey({ qn: "الجلاد", source: "", limit: 10, offset: 0, smart: false, botKey: false, viewerTgId: -1, isOwner: false }));
  check("36a2 key folds Persian letters (چ→ج, ک→ك)",
    buildSearchCacheKey({ qn: "نوستالچيا", source: "", limit: 10, offset: 0, smart: false, botKey: false, viewerTgId: -1, isOwner: false })
    === buildSearchCacheKey({ qn: "نوستالجيا", source: "", limit: 10, offset: 0, smart: false, botKey: false, viewerTgId: -1, isOwner: false }));
  check("36a3 key splits on limit/offset/source/smart/bot-key/viewer/owner",
    buildSearchCacheKey({ qn: "test", source: "", limit: 20, offset: 0, smart: false, botKey: false, viewerTgId: -1, isOwner: false }) !== baseKey
    && buildSearchCacheKey({ qn: "test", source: "", limit: 10, offset: 10, smart: false, botKey: false, viewerTgId: -1, isOwner: false }) !== baseKey
    && buildSearchCacheKey({ qn: "test", source: "kotobkhana", limit: 10, offset: 0, smart: false, botKey: false, viewerTgId: -1, isOwner: false }) !== baseKey
    && buildSearchCacheKey({ qn: "test", source: "", limit: 10, offset: 0, smart: true, botKey: false, viewerTgId: -1, isOwner: false }) !== baseKey
    && buildSearchCacheKey({ qn: "test", source: "", limit: 10, offset: 0, smart: false, botKey: true, viewerTgId: -1, isOwner: false }) !== baseKey
    && buildSearchCacheKey({ qn: "test", source: "", limit: 10, offset: 0, smart: false, botKey: false, viewerTgId: 111, isOwner: false }) !== baseKey
    && buildSearchCacheKey({ qn: "test", source: "", limit: 10, offset: 0, smart: false, botKey: false, viewerTgId: 999, isOwner: true }) !== baseKey);
  check("36a4 key never contains a secret (bot key value / fp token)",
    buildSearchCacheKey({ qn: "test", source: "", limit: 10, offset: 0, smart: false, botKey: BOT_KEY, viewerTgId: -1, isOwner: false }).indexOf(BOT_KEY) === -1
    && baseKey.indexOf(FP_SUB) === -1
    && buildSearchCacheKey({ qn: "test", source: "", limit: 10, offset: 0, smart: false, botKey: BOT_KEY, viewerTgId: -1, isOwner: false })
    === buildSearchCacheKey({ qn: "test", source: "", limit: 10, offset: 0, smart: false, botKey: true, viewerTgId: -1, isOwner: false }));
  check("36b suggest key folds spellings alike",
    buildSuggestCacheKey("الجلّاد") === buildSuggestCacheKey("الجلاد"));
  check("36c TTL is 300 seconds", SEARCH_CACHE_TTL_SECONDS === 300);

  const edge = makeTtlEdgeCache();
  globalThis.caches = edge.cachesObj;
  try {
    __resetSearchCacheCountersForTests();
    const counted = countingAllD1(db);
    const kv = mockKVStore({});
    const env = { TG_D1: counted.db, RLIBOOK_KV: kv };

    // 36d MISS then HIT.
    counted.reset();
    const first = await callRaw(env, SEARCH_Q);
    check("36d first search is a MISS", first.headers.get("x-rlibook-cache") === "MISS", first.headers.get("x-rlibook-cache"));
    check("36d first search ran the FTS ladder", counted.sqls.some((s) => s.includes("books_fts")), JSON.stringify(counted.sqls));
    counted.reset();
    const second = await callRaw(env, SEARCH_Q);
    check("36d second search is a HIT", second.headers.get("x-rlibook-cache") === "HIT", second.headers.get("x-rlibook-cache"));
    check("36d HIT body is identical to the MISS body", JSON.stringify(second.body) === JSON.stringify(first.body));
    check("36d HIT ran no ladder D1 read (registry probes only)",
      counted.sqls.length > 0 && counted.sqls.every(isProbeSql), JSON.stringify(counted.sqls));

    // 36e TTL expiry.
    edge.advance(299_000);
    const stillHit = await callRaw(env, SEARCH_Q);
    check("36e still a HIT at 299s", stillHit.headers.get("x-rlibook-cache") === "HIT", stillHit.headers.get("x-rlibook-cache"));
    edge.advance(2_000);
    counted.reset();
    const expired = await callRaw(env, SEARCH_Q);
    check("36e MISS again at 301s (TTL expired)", expired.headers.get("x-rlibook-cache") === "MISS", expired.headers.get("x-rlibook-cache"));
    check("36e expired search ran the ladder again", counted.sqls.some((s) => s.includes("books_fts")), JSON.stringify(counted.sqls));

    // 36f viewer split (fp tokens resolve to numeric ids in the key).
    edge.store.clear();
    const kvFp = mockKVStore(fpEntries());
    const envFp = { TG_D1: counted.db, RLIBOOK_KV: kvFp };
    const sub1 = await callRaw(envFp, SEARCH_Q + "&fp=" + FP_SUB);
    check("36f submitter search is a MISS", sub1.headers.get("x-rlibook-cache") === "MISS", sub1.headers.get("x-rlibook-cache"));
    const other = await callRaw(envFp, SEARCH_Q + "&fp=" + FP_OTHER);
    check("36f a different viewer is a MISS (no cross-user sharing)", other.headers.get("x-rlibook-cache") === "MISS", other.headers.get("x-rlibook-cache"));
    const sub2 = await callRaw(envFp, SEARCH_Q + "&fp=" + FP_SUB);
    check("36f the same viewer again is a HIT", sub2.headers.get("x-rlibook-cache") === "HIT", sub2.headers.get("x-rlibook-cache"));

    // 36g bot-key split.
    edge.store.clear();
    const envBot = { TG_D1: counted.db, RLIBOOK_KV: mockKVStore({}), TG_SEARCH_BOT_KEY: BOT_KEY };
    const pub1 = await callRaw(envBot, SEARCH_Q);
    check("36g public search is a MISS", pub1.headers.get("x-rlibook-cache") === "MISS", pub1.headers.get("x-rlibook-cache"));
    const bot1 = await callRaw(envBot, SEARCH_Q, { "x-rlibook-bot-key": BOT_KEY });
    check("36g bot search is a MISS (different key — the bot gets the raw URL)", bot1.headers.get("x-rlibook-cache") === "MISS", bot1.headers.get("x-rlibook-cache"));
    const botHit = (bot1.body.results || []).find((r) => r.title === "Everyone in This Bank Is a Thief");
    check("36g bot result carries the raw post URL", botHit && botHit.url === "https://t.me/kotobkhana/7559", JSON.stringify(botHit));
    const pubHit = (pub1.body.results || []).find((r) => r.title === "Everyone in This Bank Is a Thief");
    check("36g public result carries no raw post URL", pubHit && !("url" in pubHit));
    const bot2 = await callRaw(envBot, SEARCH_Q, { "x-rlibook-bot-key": BOT_KEY });
    check("36g bot search again is a HIT", bot2.headers.get("x-rlibook-cache") === "HIT", bot2.headers.get("x-rlibook-cache"));
    check("36g bot HIT body is identical to the bot MISS body", JSON.stringify(bot2.body) === JSON.stringify(bot1.body));

    // 36h h/p lookup bypass.
    counted.reset();
    const look1 = await callRaw(env, "/api/tg-search?h=kotobkhana&p=7559");
    counted.reset();
    const look2 = await callRaw(env, "/api/tg-search?h=kotobkhana&p=7559");
    check("36h lookup bodies are identical", JSON.stringify(look2.body) === JSON.stringify(look1.body));
    check("36h second lookup still reads D1 (bypassed, never cached)",
      counted.sqls.some((s) => s.includes("FROM books")), JSON.stringify(counted.sqls));

    // 36i flagged bypass.
    edge.store.clear();
    const blob = JSON.stringify({ flagged: ["kotobkhana:7559"], hidden: [] });
    const kvFlag = mockKVStore({ "flags:all": blob });
    const envFlag = { TG_D1: counted.db, RLIBOOK_KV: kvFlag };
    const flag1 = await callRaw(envFlag, SEARCH_Q);
    const flagHit = (flag1.body.results || []).find((r) => r.title === "Everyone in This Bank Is a Thief");
    check("36i flagged book is flagged in the reply", flagHit && flagHit.flagged === true, JSON.stringify(flagHit));
    check("36i flagged search is a MISS", flag1.headers.get("x-rlibook-cache") === "MISS", flag1.headers.get("x-rlibook-cache"));
    counted.reset();
    const flag2 = await callRaw(envFlag, SEARCH_Q);
    check("36i flagged search again is still a MISS (never stored)", flag2.headers.get("x-rlibook-cache") === "MISS", flag2.headers.get("x-rlibook-cache"));
    check("36i flagged search again still reads D1", counted.sqls.some((s) => s.includes("books_fts")), JSON.stringify(counted.sqls));

    // 36j degraded bypass (KV throws).
    edge.store.clear();
    const kvThrow = { get: async () => { throw new Error("KV down"); }, put: async () => {} };
    const envThrow = { TG_D1: counted.db, RLIBOOK_KV: kvThrow };
    const deg1 = await callRaw(envThrow, SEARCH_Q);
    check("36j degraded search reports flagStatus degraded", deg1.body.flagStatus === "degraded", deg1.body.flagStatus);
    check("36j degraded search is a MISS", deg1.headers.get("x-rlibook-cache") === "MISS", deg1.headers.get("x-rlibook-cache"));
    counted.reset();
    const deg2 = await callRaw(envThrow, SEARCH_Q);
    check("36j degraded search again is still a MISS", deg2.headers.get("x-rlibook-cache") === "MISS", deg2.headers.get("x-rlibook-cache"));
    check("36j degraded search again still reads D1", counted.sqls.some((s) => s.includes("books_fts")), JSON.stringify(counted.sqls));

    // 36k suggest caching.
    counted.reset();
    const sug1 = await callRaw(env, "/api/tg-search?suggest=" + encodeURIComponent("مغامرات"));
    check("36k first suggest is a MISS", sug1.headers.get("x-rlibook-cache") === "MISS", sug1.headers.get("x-rlibook-cache"));
    counted.reset();
    const sug2 = await callRaw(env, "/api/tg-search?suggest=" + encodeURIComponent("مغامرات"));
    check("36k second suggest is a HIT", sug2.headers.get("x-rlibook-cache") === "HIT", sug2.headers.get("x-rlibook-cache"));
    check("36k suggest HIT body identical", JSON.stringify(sug2.body) === JSON.stringify(sug1.body));
    check("36k suggest HIT ran zero D1 prepares", counted.sqls.length === 0, JSON.stringify(counted.sqls));

    // 36l empty-q caching (the no-D1 live-verification path).
    counted.reset();
    const eq1 = await callRaw(env, "/api/tg-search");
    check("36l first empty-q is a MISS", eq1.headers.get("x-rlibook-cache") === "MISS", eq1.headers.get("x-rlibook-cache"));
    check("36l empty-q body is the empty reply", eq1.body.ok === true && eq1.body.total === 0 && Array.isArray(eq1.body.results) && eq1.body.results.length === 0);
    counted.reset();
    const eq2 = await callRaw(env, "/api/tg-search");
    check("36l second empty-q is a HIT", eq2.headers.get("x-rlibook-cache") === "HIT", eq2.headers.get("x-rlibook-cache"));
    check("36l empty-q HIT body identical", JSON.stringify(eq2.body) === JSON.stringify(eq1.body));
    check("36l empty-q HIT ran no ladder D1 read (registry probes only)",
      counted.sqls.length > 0 && counted.sqls.every(isProbeSql), JSON.stringify(counted.sqls));

    // 36m counters: batched flush every 10 events.
    edge.store.clear();
    __resetSearchCacheCountersForTests();
    const kvCount = mockKVStore({});
    const envCount = { TG_D1: counted.db, RLIBOOK_KV: kvCount };
    const counterKey = searchCacheCounterKey();
    for (let i = 0; i < 9; i++) await callRaw(envCount, SEARCH_Q);
    check("36m no KV counter write before 10 events", !kvCount.store.has(counterKey), JSON.stringify([...kvCount.store.keys()]));
    await callRaw(envCount, SEARCH_Q);
    const counterRaw = kvCount.store.get(counterKey);
    check("36m counter flushed at 10 events", !!counterRaw, JSON.stringify([...kvCount.store.keys()]));
    const counter = counterRaw ? JSON.parse(counterRaw) : {};
    check("36m counter is 9 hits + 1 miss", counter.hit === 9 && counter.miss === 1, counterRaw);
  } finally {
    delete globalThis.caches;
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

