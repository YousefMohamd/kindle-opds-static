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
//   1. a known Telegram-only book (recent commercial title),
//   2. an author search,
//   3. Arabic normalization (diacritics + "ال" stripping),
//   4. a null author (author: null, not ""),
//   5. the flagged boolean (KV flag:<handle>:<post_id> present/absent),
//   6. empty query, missing D1 binding, and limit clamping.
// Exit 0 = all pass; non-zero + a message = failure.
// No network, no production D1/KV, no deploy.

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { onRequest, normalizeArabic, queryWords } from "./tg-search.js";

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
  insBook.run(id, b[0], b[1] || "", b[5], KIND[b[5]] || "channel", b[3], b[4], b[7], b[8], b[2] || "");
  insFts.run(id, norm(b[0]), norm(b[1] || ""));
});
console.log(`test DB: ${rows.length} books from ${SHARD}`);

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

async function call(env, path) {
  const req = new Request("https://example.com" + path, { method: "GET" });
  const res = await onRequest({ request: req, env, params: {} });
  return { status: res.status, body: await res.json() };
}

const D1 = mockD1(db);

// 1. Known Telegram-only book (recent commercial title, kotobkhana).
{
  const { status, body } = await call({ TG_D1: D1 }, "/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"));
  check("1a status 200", status === 200, `got ${status}`);
  check("1b ok:true", body.ok === true);
  check("1c total>=1", body.total >= 1, `total=${body.total}`);
  const hit = (body.results || []).find((r) => r.title === "Everyone in This Bank Is a Thief");
  check("1d exact title found", !!hit, JSON.stringify((body.results || []).slice(0, 2)));
  check("1e author", hit && hit.author === "Benjamin Stevenson", hit && hit.author);
  check("1f source kotobkhana", hit && hit.source === "kotobkhana");
  check("1g kind channel", hit && hit.kind === "channel");
  check("1h formats [EPUB]", hit && JSON.stringify(hit.formats) === JSON.stringify(["EPUB"]));
  check("1i url is t.me post", hit && hit.url === "https://t.me/kotobkhana/7559", hit && hit.url);
  check("1j flagged false without KV", hit && hit.flagged === false);
  check("1k result shape keys", hit && ["title", "author", "source", "kind", "formats", "url", "flagged"].every((k) => k in hit));
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
  check("7c all results from that source", (body.results || []).every((r) => r.source === "kotobkhana"));
  const { body: bodyWrong } = await call({ TG_D1: D1 }, "/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief") + "&source=EBook_Library");
  check("7d wrong source finds nothing", bodyWrong.total === 0 && bodyWrong.results.length === 0, `total=${bodyWrong.total}`);
  const { body: bodyBrowse } = await call({ TG_D1: D1 }, "/api/tg-search?source=kotobkhana&limit=5");
  check("7e empty-q source browse lists books", bodyBrowse.ok === true && bodyBrowse.total >= 1 && bodyBrowse.results.length >= 1, `total=${bodyBrowse.total}`);
  check("7f browse results all from that source", (bodyBrowse.results || []).every((r) => r.source === "kotobkhana"));
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
// partial must be true while indexed < target (323,325).
{
  const { body } = await call({ TG_D1: D1 }, "/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"));
  check("9a search reply carries coverage", !!body.coverage, JSON.stringify(body.coverage));
  check("9b coverage.indexed is the D1 COUNT(*)",
    body.coverage && body.coverage.indexed === rows.length,
    `indexed=${body.coverage && body.coverage.indexed} rows=${rows.length}`);
  check("9c coverage.target is the D1 final-import target (323,325)",
    body.coverage && body.coverage.target === 323325,
    JSON.stringify(body.coverage));
  check("9d coverage.partial true while D1 is incomplete",
    body.coverage && body.coverage.partial === true, JSON.stringify(body.coverage));
  check("9e coverage never claims the manifest total as the D1 total",
    body.coverage && body.coverage.indexed !== 326149
    && body.coverage.target !== 326149, JSON.stringify(body.coverage));
  const { body: bodyEmpty } = await call({ TG_D1: D1 }, "/api/tg-search?q=");
  check("9f empty-q reply carries coverage too",
    bodyEmpty.coverage && bodyEmpty.coverage.indexed === rows.length
    && bodyEmpty.coverage.partial === true, JSON.stringify(bodyEmpty.coverage));
  const { body: bodyNo } = await call({ TG_D1: D1 }, "/api/tg-search?q=" + encodeURIComponent("zzzqqqxxyy"));
  check("9g no-match reply carries coverage too",
    bodyNo.coverage && bodyNo.coverage.indexed === rows.length
    && bodyNo.coverage.partial === true, JSON.stringify(bodyNo.coverage));
  const { body: bodyBrowse } = await call({ TG_D1: D1 }, "/api/tg-search?source=kotobkhana&limit=5");
  check("9h source-browse reply carries coverage too",
    bodyBrowse.coverage && bodyBrowse.coverage.indexed === rows.length,
    JSON.stringify(bodyBrowse.coverage));
  const noD1 = await call({}, "/api/tg-search?q=test");
  check("9i 503 (no D1) carries no coverage field",
    noD1.body.coverage === undefined, JSON.stringify(noD1.body));
}

// 10. coverage cache (P0-2 D1 read-budget fix): the coverage COUNT(*)
// is a full-table scan (~150k rows), so it is cached in KV for 1 h
// (key `tg-search:coverage`) and the live COUNT(*) runs only on a
// cache miss. The response shape is identical either way.
{
  // 10a: cache hit — the cached value is used (123456 != rows.length)
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
    && bodyHit.coverage.target === 323325 && bodyHit.coverage.partial === true,
    JSON.stringify(bodyHit.coverage));

  // 10e: cache miss — the live COUNT(*) runs exactly once and the
  // value is written back to KV (so the next request is a hit).
  const counted2 = countingD1(db);
  const kvMiss = mockKVStore();
  const { body: bodyMiss } = await call({ TG_D1: counted2.db, RLIBOOK_KV: kvMiss }, "/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"));
  check("10e cache miss falls back to the live COUNT(*)",
    bodyMiss.coverage && bodyMiss.coverage.indexed === rows.length,
    JSON.stringify(bodyMiss.coverage));
  check("10f cache miss runs the coverage COUNT(*) exactly once",
    counted2.coverageCountQueries === 1,
    `ran ${counted2.coverageCountQueries} times`);
  const written = kvMiss.writes.find((w) => w.key === "tg-search:coverage");
  check("10g cache miss populates KV with the live count",
    !!written && JSON.parse(written.value).indexed === rows.length,
    JSON.stringify(written && written.value));
  check("10h cache write carries a 1 h TTL",
    !!written && written.opts && written.opts.expirationTtl === 3600,
    JSON.stringify(written && written.opts));

  // 10i: malformed cached value -> fall back to the live COUNT(*).
  const counted3 = countingD1(db);
  const kvBad = mockKVStore({ "tg-search:coverage": "not-json{{" });
  const { body: bodyBad } = await call({ TG_D1: counted3.db, RLIBOOK_KV: kvBad }, "/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"));
  check("10i malformed cache falls back to the live COUNT(*)",
    bodyBad.coverage && bodyBad.coverage.indexed === rows.length
    && counted3.coverageCountQueries === 1, JSON.stringify(bodyBad.coverage));
  const kvBad2 = mockKVStore({ "tg-search:coverage": JSON.stringify({ indexed: "abc" }) });
  const { body: bodyBad2 } = await call({ TG_D1: D1, RLIBOOK_KV: kvBad2 }, "/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"));
  check("10j non-numeric cached indexed falls back to the live COUNT(*)",
    bodyBad2.coverage && bodyBad2.coverage.indexed === rows.length,
    JSON.stringify(bodyBad2.coverage));

  // 10k: KV get throws -> fall back to the live COUNT(*), search works.
  const counted4 = countingD1(db);
  const kvThrow = { get: async () => { throw new Error("KV down"); }, put: async () => { throw new Error("KV down"); } };
  const { body: bodyThrow } = await call({ TG_D1: counted4.db, RLIBOOK_KV: kvThrow }, "/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"));
  check("10k KV failure falls back to the live COUNT(*)",
    bodyThrow.coverage && bodyThrow.coverage.indexed === rows.length
    && counted4.coverageCountQueries === 1, JSON.stringify(bodyThrow.coverage));

  // 10l: a cached value at/above the target reports partial: false —
  // the /book partial note self-removes from the cached value too.
  const kvDone = mockKVStore({ "tg-search:coverage": JSON.stringify({ indexed: 323325, at: Date.now() }) });
  const { body: bodyDone } = await call({ TG_D1: D1, RLIBOOK_KV: kvDone }, "/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"));
  check("10l cached indexed == target -> partial false",
    bodyDone.coverage && bodyDone.coverage.indexed === 323325 && bodyDone.coverage.partial === false,
    JSON.stringify(bodyDone.coverage));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
