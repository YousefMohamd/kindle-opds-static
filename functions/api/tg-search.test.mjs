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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
