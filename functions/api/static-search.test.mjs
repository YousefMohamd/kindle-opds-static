// Tests for functions/api/static-search.mjs — the static index reader.
// Run from the repo root (the fixture index must exist —
// tests/run_tests.sh builds it):
//   STATIC_SEARCH_INDEX_DIR=<path-to>/tests/out/index \
//     node --test functions/api/static-search.test.mjs
//
// Words passed to searchStaticIndex are the normalized words
// tg-search.js queryWords would produce for the query (ال-stripped,
// len >= 2) — e.g. "الحرير" -> ["حرير"], "بيت الحرير" ->
// ["بيت", "حرير"].

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  searchStaticIndex,
  wordLetter,
  decodePointer,
  POINTER_ROW_MOD,
} from "./static-search.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_DIR =
  process.env.STATIC_SEARCH_INDEX_DIR || path.join(HERE, "out", "index");
const BASE = "https://example.invalid/search";

async function fetchJson(url) {
  if (!url.startsWith(BASE)) throw new Error(`unexpected base in ${url}`);
  const rel = decodeURIComponent(url.slice(BASE.length));
  try {
    const data = await readFile(path.join(INDEX_DIR, rel), "utf-8");
    return JSON.parse(data);
  } catch (e) {
    // Missing shard file = 404, the reader's documented contract
    // (a letter with no words/books has no file at all).
    if (e.code === "ENOENT") {
      const err = new Error(`not found: ${rel}`);
      err.status = 404;
      throw err;
    }
    throw e;
  }
}

let manifest = null;
async function loadManifest() {
  if (!manifest) manifest = await fetchJson(`${BASE}/manifest.json`);
  return manifest;
}

async function search(words, extra = {}) {
  return searchStaticIndex({
    fetchJson,
    base: BASE,
    manifest: await loadManifest(),
    words,
    limit: 10,
    offset: 0,
    ...extra,
  });
}

function titles(res) {
  return res.rows.map((r) => r.title);
}

test("wordLetter + decodePointer units", () => {
  assert.equal(wordLetter("كتاب"), "ك");
  assert.equal(wordLetter("great"), "g");
  assert.equal(wordLetter("1984"), "0-9");
  assert.equal(wordLetter(""), "#");
  assert.deepEqual(decodePointer(2 * POINTER_ROW_MOD + 7, ["ا", "ب", "ت"]), {
    letter: "ت",
    row: 7,
  });
});

test("manifest covers the fixture (33 books, flags excluded)", async () => {
  const m = await loadManifest();
  assert.equal(m.totals.books, 33);
  assert.deepEqual(m.filtered, { flagged: 1, hidden: 1 });
  assert.ok(Array.isArray(m.letters) && m.letters.length > 0);
});

test("exact: two-word Arabic, middle-word recall via the word tier", async () => {
  // "بيت الحرير": finds بيت الحرير AND كتاب بيت الحرير (whose title
  // starts with ك, not ب) — the word tier closes the letter gap.
  // الحرير والذهب has حرير but not بيت, so it is excluded.
  const res = await search(["بيت", "حرير"]);
  assert.equal(res.match, "exact");
  assert.equal(res.total, 2);
  assert.deepEqual(titles(res), ["بيت الحرير", "كتاب بيت الحرير"]);
});

test("exact: single word across letters", async () => {
  const res = await search(["حرير"]);
  assert.equal(res.match, "exact");
  assert.equal(res.total, 3);
  assert.deepEqual(titles(res), ["بيت الحرير", "الحرير والذهب", "كتاب بيت الحرير"]);
});

test("exact: ال-stripped word + author-only match", async () => {
  const res = await search(["جلاد"]);
  assert.equal(res.match, "exact");
  assert.deepEqual(titles(res), ["رواية الجلاد", "الجلاد"]);
  // "أحمد" normalizes to "احمد" (أ -> ا) before it reaches the reader.
  // 5 books: أحمد محمد (الكتاب الكبير)، ليلى أحمد، أحمد خالد،
  // الخليل بن أحمد، أحمد بايثون.
  const byAuthor = await search(["احمد"]);
  assert.equal(byAuthor.total, 5);
});

test("exact: cross-language normalization parity (tashkeel + Persian)", async () => {
  // The Python builder indexed "مُتَوِّنُ" under "متون" and
  // "نوستالچيا" under "نوستالجيا"; the reader queries the folded form.
  const tashkeel = await search(["متون"]);
  assert.equal(tashkeel.total, 1);
  assert.equal(tashkeel.rows[0].title, "مُتَوِّنُ الأحكام");
  const persian = await search(["نوستالجيا"]);
  assert.equal(persian.total, 1);
  assert.equal(persian.rows[0].title, "نوستالچيا");
});

test("prefix tier: last word as a prefix (D1 rule, len >= 4)", async () => {
  // "مجموع" (6 chars) is not an index word; as the LAST word it
  // prefixes "مجموعه". (A 3-char last word like "حري" would NOT
  // qualify — D1 needs len >= 4 — and falls through to typo.)
  const res = await search(["كتاب", "مجموع"]);
  assert.equal(res.match, "prefix");
  assert.equal(res.total, 1);
  assert.deepEqual(titles(res), ["كتاب المجموعة الأول"]);
  // Single-word prefix works the same way (last = only word).
  const latin = await search(["gats"]);
  assert.equal(latin.match, "prefix");
  assert.equal(latin.total, 1);
  assert.equal(latin.rows[0].title, "The Great Gatsby");
});

test("typo tier: truncated word as a prefix (D1 rule)", async () => {
  // "مجموعهه" (7 chars) truncates to its first 6, "مجموعه".
  const res = await search(["مجموعهه"]);
  assert.equal(res.match, "typo");
  assert.equal(res.total, 2);
  assert.deepEqual(titles(res), ["كتاب المجموعة الأول", "رواية المجموعة"]);
});

test("particle tier: و-prefixed query finds the bare word (D1 rule)", async () => {
  // "والسندباد" is not indexed; stripped to "سندباد" it matches.
  const res = await search(["والسندباد"]);
  assert.equal(res.match, "exact");
  assert.equal(res.total, 1);
  assert.equal(res.rows[0].title, "سندباد البحري");
});

test("hyphenated query words split like the FTS tokenizer", async () => {
  const res = await search(["python-for-beginners"]);
  assert.equal(res.match, "exact");
  assert.equal(res.total, 1);
  assert.equal(res.rows[0].title, "Python للمبتدئين");
});

test("filename words are indexed", async () => {
  const res = await search(["beginners"]);
  assert.equal(res.total, 1);
  assert.equal(res.rows[0].title, "Python للمبتدئين");
});

test("format filter", async () => {
  const res = await search(["حرير"], { format: "pdf" });
  assert.equal(res.total, 1);
  assert.equal(res.rows[0].title, "الحرير والذهب");
  assert.equal(res.rows[0].formats, undefined); // D1 shape has no formats here; ext is on the row
  assert.equal(res.rows[0].ext, "pdf");
});

test("source filter (channel handle)", async () => {
  const res = await search(["تاريخ"], { source: "chanB" });
  assert.equal(res.total, 2);
  assert.deepEqual(titles(res), ["موسوعة التاريخ", "التاريخ الإسلامي"]);
});

test("flagged + hidden books are unreachable", async () => {
  assert.equal((await search(["محظور"])).total, 0);
  assert.equal((await search(["مخفي"])).total, 0);
  assert.equal((await search(["محظور"])).match, null);
});

test("private-group rows resolve with no URL (no links downstream)", async () => {
  // "المجموعة" normalizes to "مجموعه" (ة -> ه) before it reaches the reader.
  const res = await search(["مجموعه"]);
  assert.equal(res.total, 2);
  assert.deepEqual(titles(res), ["كتاب المجموعة الأول", "رواية المجموعة"]);
  assert.ok(res.rows.every((r) => r.url === ""));
});

test("no match", async () => {
  const res = await search(["xyzqqq"]);
  assert.equal(res.total, 0);
  assert.equal(res.match, null);
  assert.deepEqual(res.rows, []);
});

test("limit + offset + newest-first ranking", async () => {
  const all = await search(["كتاب"]);
  assert.equal(all.total, 5);
  assert.equal(all.match, "exact");
  assert.deepEqual(titles(all), [
    "الكتاب الكبير",
    "كتاب بيت الحرير",
    "كتاب الطبخ",
    "كتاب المجموعة الأول",
    "كتاب بلا مؤلف",
  ]);
  const page = await search(["كتاب"], { limit: 2, offset: 2 });
  assert.equal(page.total, 5);
  assert.deepEqual(titles(page), ["كتاب الطبخ", "كتاب المجموعة الأول"]);
});

test("rows carry the D1 shape the API pipeline expects", async () => {
  const res = await search(["جلاد"]);
  const row = res.rows[0];
  assert.equal(row.title, "رواية الجلاد");
  assert.equal(row.author, "أحمد خالد");
  assert.equal(row.ext, "pdf");
  assert.equal(row.url, "https://t.me/chanA/109");
  assert.equal(row.source, "chanA");
  assert.equal(row.kind, "channel");
  assert.ok("size" in row);
});
