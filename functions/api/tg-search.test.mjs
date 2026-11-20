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
import { onRequest, normalizeArabic, queryWords, gatedLinks, isBotRequest, validateSize, formatBytes, botDeepLink } from "./tg-search.js";

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
  check("1f source kotobkhana", hit && hit.source === "kotobkhana");
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
// partial must be true while indexed < target (323,318).
{
  const { body } = await call({ TG_D1: D1 }, "/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"));
  check("9a search reply carries coverage", !!body.coverage, JSON.stringify(body.coverage));
  check("9b coverage.indexed is the D1 COUNT(*)",
    body.coverage && body.coverage.indexed === TOTAL_ROWS,
    `indexed=${body.coverage && body.coverage.indexed} rows=${TOTAL_ROWS}`);
  check("9c coverage.target is the D1 final-import target (323,318)",
    body.coverage && body.coverage.target === 323318,
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
    && bodyHit.coverage.target === 323318 && bodyHit.coverage.partial === true,
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

  // 10k: KV get throws -> fall back to the live COUNT(*), search works.
  const counted4 = countingD1(db);
  const kvThrow = { get: async () => { throw new Error("KV down"); }, put: async () => { throw new Error("KV down"); } };
  const { body: bodyThrow } = await call({ TG_D1: counted4.db, RLIBOOK_KV: kvThrow }, "/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"));
  check("10k KV failure falls back to the live COUNT(*)",
    bodyThrow.coverage && bodyThrow.coverage.indexed === TOTAL_ROWS
    && counted4.coverageCountQueries === 1, JSON.stringify(bodyThrow.coverage));

  // 10l: a cached value at/above the target reports partial: false —
  // the /book partial note self-removes from the cached value too.
  const kvDone = mockKVStore({ "tg-search:coverage": JSON.stringify({ indexed: 323318, at: Date.now() }) });
  const { body: bodyDone } = await call({ TG_D1: D1, RLIBOOK_KV: kvDone }, "/api/tg-search?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"));
  check("10l cached indexed == target -> partial false",
    bodyDone.coverage && bodyDone.coverage.indexed === 323318 && bodyDone.coverage.partial === false,
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

