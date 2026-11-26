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
import { onRequest, normalizeArabic, queryWords, parseFormatToken, gatedLinks, isBotRequest, validateSize, formatBytes, botDeepLink, parseFlagsBlob, ladderQueries, stripParticle, dedupeTitleKey } from "./tg-search.js";

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
`);
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
const insFts = db.prepare("INSERT INTO books_fts(rowid,title,author) VALUES (?,?,?)");
rows.forEach((b, i) => {
  const id = i + 1;
  // Shard shape (both supported): old shards carry the post URL at
  // [8]; new shards (Workstream H) carry handle at [8] + post id at
  // [9] instead — rebuild the URL from those when [8] is not a URL.
  const postUrl = typeof b[8] === "string" && b[8].startsWith("http")
    ? b[8]
    : (b[8] && b[9] ? `https://t.me/${b[8]}/${b[9]}` : "");
  insBook.run(id, b[0], b[1] || "", b[5], KIND[b[5]] || "channel", b[3], b[4], b[7], postUrl, b[2] || "");
  insFts.run(id, norm(b[0]), norm(b[1] || ""));
});
// Deterministic fixtures (see above) — high ids, never colliding
// with the shard sample (1..SAMPLE).
FIXTURES.forEach((f, j) => {
  const id = 900001 + j;
  insBook.run(id, f[0], f[1], f[2], f[3], f[4], f[5], f[6], f[7], f[8]);
  insFts.run(id, norm(f[0]), norm(f[1]));
});
const TOTAL_ROWS = rows.length + FIXTURES.length;
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
// D1 mock that counts executions of the coverage COUNT(*) only
// (exact SQL "SELECT COUNT(*) AS n FROM books") — the FTS and browse
// counts are different statements and must still run.
function countingD1(sqlite) {
  const base = mockD1(sqlite);
  let coverageCountQueries = 0;
  return {
    db: {
      prepare(sql) {
        if (sql === "SELECT COUNT(*) AS n FROM books") coverageCountQueries++;
        return base.prepare(sql);
      },
    },
    get coverageCountQueries() { return coverageCountQueries; },
  };
}

async function call(env, path, headers = {}) {
  const req = new Request("https://example.com" + path, { method: "GET", headers });
  const res = await onRequest({ request: req, env, params: {} });
  return { status: res.status, body: await res.json() };
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
    hit && ["title", "author", "source", "kind", "formats", "flagged", "get", "send", "read", "bot"].every((k) => k in hit)
    && !("url" in hit)
    && Object.keys(hit).every((k) => ["title", "author", "source", "kind", "formats", "flagged", "get", "send", "read", "bot", "size"].includes(k)));
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
// The test DB holds SAMPLE rows (5000 by default), so indexed must be
// exactly that — a direct COUNT(*), never the manifest total — and
// partial must be true while indexed < target (422,821).
{
  const { body } = await call({ TG_D1: D1 }, "/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"));
  check("9a search reply carries coverage", !!body.coverage, JSON.stringify(body.coverage));
  check("9b coverage.indexed is the D1 COUNT(*)",
    body.coverage && body.coverage.indexed === TOTAL_ROWS,
    `indexed=${body.coverage && body.coverage.indexed} rows=${TOTAL_ROWS}`);
  check("9c coverage.target is the D1 final-import target (422,821)",
    body.coverage && body.coverage.target === 422821,
    JSON.stringify(body.coverage));
  check("9d coverage.partial true while D1 is incomplete",
    body.coverage && body.coverage.partial === true, JSON.stringify(body.coverage));
  check("9e coverage never claims the manifest total as the D1 total",
    body.coverage && body.coverage.indexed !== 326149
    && body.coverage.target !== 326149, JSON.stringify(body.coverage));
  const { body: bodyEmpty } = await call({ TG_D1: D1 }, "/api/tg-search?q=");
  check("9f empty-q reply carries coverage too",
    bodyEmpty.coverage && bodyEmpty.coverage.indexed === TOTAL_ROWS
    && bodyEmpty.coverage.partial === true, JSON.stringify(bodyEmpty.coverage));
  const { body: bodyNo } = await call({ TG_D1: D1 }, "/api/tg-search?q=" + encodeURIComponent("zzzqqqxxyy"));
  check("9g no-match reply carries coverage too",
    bodyNo.coverage && bodyNo.coverage.indexed === TOTAL_ROWS
    && bodyNo.coverage.partial === true, JSON.stringify(bodyNo.coverage));
  const { body: bodyBrowse } = await call({ TG_D1: D1 }, "/api/tg-search?source=kotobkhana&limit=5");
  check("9h source-browse reply carries coverage too",
    bodyBrowse.coverage && bodyBrowse.coverage.indexed === TOTAL_ROWS,
    JSON.stringify(bodyBrowse.coverage));
  const noD1 = await call({}, "/api/tg-search?q=test");
  check("9i 503 (no D1) carries no coverage field",
    noD1.body.coverage === undefined, JSON.stringify(noD1.body));
}

// 10. coverage cache (P0-2 D1 read-budget fix): the coverage COUNT(*)
// is a full-table scan (~150k rows), so it is cached in KV for 6 h
// (key `tg-search:coverage`) and the live COUNT(*) runs only on a
// cache miss. The response shape is identical either way.
{
  // 10a: cache hit — the cached value is used (123456 != TOTAL_ROWS)
  // and the coverage COUNT(*) is NOT executed at all.
  const counted = countingD1(db);
  const kvHit = mockKVStore({ "tg-search:coverage": JSON.stringify({ indexed: 123456, at: Date.now() }) });
  const { body: bodyHit } = await call({ TG_D1: counted.db, RLIBOOK_KV: kvHit }, "/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"));
  check("10a cache hit uses the cached indexed value",
    bodyHit.coverage && bodyHit.coverage.indexed === 123456,
    JSON.stringify(bodyHit.coverage));
  check("10b cache hit runs ZERO coverage COUNT(*)",
    counted.coverageCountQueries === 0,
    `coverage COUNT(*) ran ${counted.coverageCountQueries} times`);
  check("10c cache hit still returns search results",
    bodyHit.total >= 1 && (bodyHit.results || []).length >= 1, `total=${bodyHit.total}`);
  check("10d cache-hit coverage shape is unchanged",
    bodyHit.coverage && Object.keys(bodyHit.coverage).sort().join(",") === "indexed,partial,target"
    && bodyHit.coverage.target === 422821 && bodyHit.coverage.partial === true,
    JSON.stringify(bodyHit.coverage));

  // 10e: cache miss — the live COUNT(*) runs exactly once and the
  // value is written back to KV (so the next request is a hit).
  const counted2 = countingD1(db);
  const kvMiss = mockKVStore();
  const { body: bodyMiss } = await call({ TG_D1: counted2.db, RLIBOOK_KV: kvMiss }, "/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"));
  check("10e cache miss falls back to the live COUNT(*)",
    bodyMiss.coverage && bodyMiss.coverage.indexed === TOTAL_ROWS,
    JSON.stringify(bodyMiss.coverage));
  check("10f cache miss runs the coverage COUNT(*) exactly once",
    counted2.coverageCountQueries === 1,
    `ran ${counted2.coverageCountQueries} times`);
  const written = kvMiss.writes.find((w) => w.key === "tg-search:coverage");
  check("10g cache miss populates KV with the live count",
    !!written && JSON.parse(written.value).indexed === TOTAL_ROWS,
    JSON.stringify(written && written.value));
  check("10h cache write carries a 6 h TTL",
    !!written && written.opts && written.opts.expirationTtl === 21600,
    JSON.stringify(written && written.opts));

  // 10i: malformed cached value -> fall back to the live COUNT(*).
  const counted3 = countingD1(db);
  const kvBad = mockKVStore({ "tg-search:coverage": "not-json{{" });
  const { body: bodyBad } = await call({ TG_D1: counted3.db, RLIBOOK_KV: kvBad }, "/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"));
  check("10i malformed cache falls back to the live COUNT(*)",
    bodyBad.coverage && bodyBad.coverage.indexed === TOTAL_ROWS
    && counted3.coverageCountQueries === 1, JSON.stringify(bodyBad.coverage));
  const kvBad2 = mockKVStore({ "tg-search:coverage": JSON.stringify({ indexed: "abc" }) });
  const { body: bodyBad2 } = await call({ TG_D1: D1, RLIBOOK_KV: kvBad2 }, "/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"));
  check("10j non-numeric cached indexed falls back to the live COUNT(*)",
    bodyBad2.coverage && bodyBad2.coverage.indexed === TOTAL_ROWS,
    JSON.stringify(bodyBad2.coverage));

  // 10k: KV failure NEVER triggers a live COUNT(*) any more
  // (resilience batch, 2026-11-20): a KV error + a live count
  // compounded and killed search on 2026-11-19. The coverage field
  // is omitted instead and the search itself still works.
  const counted4 = countingD1(db);
  const kvThrow = { get: async () => { throw new Error("KV down"); }, put: async () => { throw new Error("KV down"); } };
  const { body: bodyThrow } = await call({ TG_D1: counted4.db, RLIBOOK_KV: kvThrow }, "/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"));
  check("10k KV failure omits coverage (no field, not a stale count)",
    bodyThrow.coverage === undefined, JSON.stringify(bodyThrow.coverage));
  check("10k2 KV failure runs ZERO coverage COUNT(*)",
    counted4.coverageCountQueries === 0,
    `coverage COUNT(*) ran ${counted4.coverageCountQueries} times`);
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
  check("13c one hidden key drops BOTH files on the post (only the other post remains)",
    bodyC.total === 1 && bodyC.results.length === 1 && bodyC.results[0].title === "Zebra Other Book",
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
  check("15g lookup coverage counts the Zebra fixtures too",
    body.coverage && body.coverage.indexed === TOTAL_ROWS + 3, JSON.stringify(body.coverage));
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
// the live COUNT(*) NEVER runs — the coverage field is omitted and
// the search itself is unaffected.
{
  const today = new Date().toISOString().slice(0, 10);
  const counterKey = `tg-search:coverage:refreshes:${today}`;
  const counted = countingD1(db);
  const kvGuard = mockKVStore({ "d1:guard": "D1 exhausted 2026-11-20 (watchdog)" });
  const { body } = await call({ TG_D1: counted.db, RLIBOOK_KV: kvGuard }, "/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"));
  check("17a guard set -> coverage omitted", body.coverage === undefined, JSON.stringify(body.coverage));
  check("17b guard set -> ZERO coverage COUNT(*)", counted.coverageCountQueries === 0, `ran ${counted.coverageCountQueries} times`);
  check("17c guard set -> search results still returned", body.total >= 1 && (body.results || []).length >= 1, `total=${body.total}`);
  check("17d guard set -> no refresh counter written", !kvGuard.writes.some((w) => w.key === counterKey), JSON.stringify(kvGuard.writes.map((w) => w.key)));
}

// 18. Coverage refresh budget: at most 4 live COUNT(*) per UTC day
// (one KV counter write per refresh). At 4 the count is barred;
// below 4 it runs once and the counter increments.
{
  const today = new Date().toISOString().slice(0, 10);
  const counterKey = `tg-search:coverage:refreshes:${today}`;
  // 18a: counter at 4 -> barred, no count, coverage omitted.
  const countedFull = countingD1(db);
  const kvFull = mockKVStore({ [counterKey]: "4" });
  const { body: bodyFull } = await call({ TG_D1: countedFull.db, RLIBOOK_KV: kvFull }, "/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"));
  check("18a counter at 4 -> coverage omitted", bodyFull.coverage === undefined, JSON.stringify(bodyFull.coverage));
  check("18b counter at 4 -> ZERO coverage COUNT(*)", countedFull.coverageCountQueries === 0, `ran ${countedFull.coverageCountQueries} times`);
  check("18c counter at 4 -> search still works", bodyFull.total >= 1, `total=${bodyFull.total}`);
  // 18d: counter at 3 -> the count runs exactly once, the counter
  // is incremented to 4 (48 h TTL), and the cache is populated.
  const counted3 = countingD1(db);
  const kv3 = mockKVStore({ [counterKey]: "3" });
  const { body: body3 } = await call({ TG_D1: counted3.db, RLIBOOK_KV: kv3 }, "/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"));
  check("18d counter at 3 -> live COUNT(*) runs once",
    body3.coverage && body3.coverage.indexed === TOTAL_ROWS + 3 && counted3.coverageCountQueries === 1,
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
  check("18g no counter key -> live COUNT(*) runs once",
    body0.coverage && body0.coverage.indexed === TOTAL_ROWS + 3 && counted0.coverageCountQueries === 1,
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
  check("20g blob-hidden post drops BOTH files on it (only the other post remains)",
    bodyZ2.total === 1 && bodyZ2.results.length === 1 && bodyZ2.results[0].title === "Zebra Other Book",
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

