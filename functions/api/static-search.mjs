// Static search index reader (D1 root-fix step 2) — edge-side.
//
// Reads the two-tier index built by `tbi build-search-index`
// (telegram/tbi/build_search_index.py) from the site origin — zero D1
// rows per search:
//
//   search/manifest.json  — {letters, totals, generated_at, ...}
//   search/rec/<letter>.json — {"books": [[title, author, filename,
//     ext, size, source, handle, post, date], ...]} (slim records,
//     newest-first inside each letter)
//   search/idx/<letter>.json — {word: [ptr, ...]} where a pointer is
//     letter_index * 1_000_000 + row (row = the book's index inside
//     its `rec/<letter>.json` file; the manifest's `letters` array
//     defines the order).
//
// Tiers — the same ladder as tg-search.js ladderQueries, in the same
// order (the typo tier IS implemented here: it is only truncated
// prefixes, no trigram table needed):
//   exact  — every query word present (postings intersected)
//   exact  — particle-stripped exact AND (و/ف/بال/لل stripped, then
//            ال stripped; same label as D1, it IS an exact AND)
//   prefix — every word exact except the LAST word, which is a prefix
//            (last word len >= 4, same rule as D1)
//   typo   — every word truncated to its first 5-6 chars as a prefix
//            (6 chars for words len >= 7, 5 for len 5-6, whole word
//            otherwise — same rule as D1)
//   any    — any query word present (multi-word only)
//   word   — the longest query word only (multi-word only)
// Each tier resolves pointers to records, applies the format/source
// filters, ranks newest-first (rec `date` desc, then title), and
// returns up to `limit` rows after `offset`. Rows come back in the
// D1 row shape ({title, author, ext, size, url, source,
// kind:"channel"}) so the caller feeds them through its existing
// visibleResults/toResult pipeline — the delivery gates stay
// identical to the D1 path. A private-group row (empty handle) gets
// url "" — gatedLinks already returns no links for that, same as D1.
//
// Query words arrive normalized (tg-search.js queryWords output) and
// are split here on non-alphanumeric runs (FTS5 unicode61-style, the
// same character class the builder uses), so a hyphenated query word
// ("python-for-beginners") ANDs its pieces like the D1 FTS phrase
// does. stripAl/stripParticle below mirror the tg-search.js exports
// of the same names — they must stay identical.
//
// The caller owns fetching (fetchJson) and the manifest: pass a
// manifest object, or null to have it fetched from
// `${base}/manifest.json`. fetchJson contract: it returns the parsed
// JSON, and throws an error with `.status === 404` when the file
// does not exist (a missing idx/rec shard means "no words/books
// under that letter" and is treated as empty, not an error); any
// other failure propagates so the caller can 500 honestly.
//
// Caps (all documented, all hit only on pathological queries):
// MAX_WORDS (5) — extra words ignored; MAX_CANDIDATES (5000) —
// pointers considered per tier; MAX_EXPANSION_WORDS (500) — index
// words expanded per prefix/typo lookup; MAX_IDX_FILES (5) /
// MAX_REC_FILES (4) — index/record files fetched per search. A query
// whose true match count exceeds MAX_CANDIDATES reports the capped
// total.

export const POINTER_ROW_MOD = 1_000_000;
export const MAX_WORDS = 5;
export const MAX_CANDIDATES = 5000;
export const MAX_EXPANSION_WORDS = 500;
export const MAX_IDX_FILES = 5;
// Safety valve only: the maximum number of rec letter files
// fetched per search. The normal case touches a few letters; the
// bound covers a word spread over many letters, keeping the newest
// letters' books when it binds (see resolve).
export const MAX_REC_FILES = 16;

// REC_FIELDS order (build_search_index.py) — positional.
const F_TITLE = 0;
const F_AUTHOR = 1;
const F_FILENAME = 2;
const F_EXT = 3;
const F_SIZE = 4;
const F_SOURCE = 5;
const F_HANDLE = 6;
const F_POST = 7;
const F_DATE = 8;

// Alphanumeric runs, FTS5 unicode61-style — the same character
// class as the builder's _WORD_RE. Must stay identical.
const WORD_SPLIT_RE =
  /[^a-z0-9\u0600-\u06ff\u0660-\u0669\u06f0-\u06f9\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff]+/;

/** Mirror of tg-search.js stripAl. */
export function stripAl(word) {
  if (word.startsWith("ال") && word.length >= 5) return word.slice(2);
  return word;
}

/** Mirror of tg-search.js stripParticle: strip ONE particle prefix
 *  (و / ف / بال / لل) when >= 4 chars remain. */
export function stripParticle(word) {
  if (!word) return word;
  for (const p of ["بال", "لل"]) {
    if (word.startsWith(p) && word.length - p.length >= 4) {
      return word.slice(p.length);
    }
  }
  for (const p of ["و", "ف"]) {
    if (word.startsWith(p) && word.length - 1 >= 4) return word.slice(1);
  }
  return word;
}

/** Split one incoming query word on non-alphanumeric runs (like the
 *  FTS tokenizer), strip ال from each piece, drop pieces < 2 chars.
 *  Incoming words are already normalized by tg-search.js queryWords. */
export function splitQueryWord(word) {
  return word
    .split(WORD_SPLIT_RE)
    .map((w) => stripAl(w))
    .filter((w) => w.length >= 2);
}

/** IDX shard key: first character of an already-normalized word,
 *  same classes as the builder's word_letter. */
export function wordLetter(word) {
  if (!word) return "#";
  const c = word[0];
  if (c >= "a" && c <= "z") return c;
  if (c >= "0" && c <= "9") return "0-9";
  const cp = c.codePointAt(0);
  if (
    (cp >= 0x0600 && cp <= 0x06ff) ||
    (cp >= 0x0660 && cp <= 0x0669) ||
    (cp >= 0x06f0 && cp <= 0x06f9) ||
    (cp >= 0x0750 && cp <= 0x077f) ||
    (cp >= 0x08a0 && cp <= 0x08ff) ||
    (cp >= 0xfb50 && cp <= 0xfdff) ||
    (cp >= 0xfe70 && cp <= 0xfeff)
  ) {
    return c;
  }
  return "#";
}

/** Decode one pointer against the manifest's letters array. */
export function decodePointer(ptr, letters) {
  const li = Math.floor(ptr / POINTER_ROW_MOD);
  return { letter: letters[li], row: ptr % POINTER_ROW_MOD };
}

function intersectSorted(lists) {
  if (lists.length === 0) return [];
  // Start from the shortest list (most selective word first).
  const sorted = lists.slice().sort((a, b) => a.length - b.length);
  let out = sorted[0].slice();
  for (let i = 1; i < sorted.length; i++) {
    const b = sorted[i];
    const next = [];
    let j = 0;
    let k = 0;
    while (j < out.length && k < b.length) {
      if (out[j] === b[k]) {
        next.push(out[j]);
        j++;
        k++;
      } else if (out[j] < b[k]) {
        j++;
      } else {
        k++;
      }
    }
    out = next;
    if (out.length === 0) break;
  }
  return out;
}

function unionSorted(lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const ptr of list) {
      if (!seen.has(ptr)) {
        seen.add(ptr);
        out.push(ptr);
      }
    }
  }
  out.sort((a, b) => a - b);
  return out;
}

function toRow(record) {
  const handle = record[F_HANDLE] || "";
  const post = record[F_POST] || "";
  return {
    title: record[F_TITLE] || "",
    author: record[F_AUTHOR] || "",
    ext: record[F_EXT] || "",
    size: record[F_SIZE] || "",
    url: handle && post ? `https://t.me/${handle}/${post}` : "",
    source: record[F_SOURCE] || "",
    kind: "channel",
  };
}

/**
 * Search the static index.
 *
 * @param {object} opts
 * @param {function(string): Promise<object>} opts.fetchJson - fetches
 *   a URL and returns the parsed JSON; throws an error with
 *   `.status === 404` when the file does not exist.
 * @param {string} opts.base - index base URL, e.g.
 *   "https://rlibook.tech/site/telegram/search" (no trailing slash).
 * @param {object|null} opts.manifest - manifest.json content, or
 *   null to fetch it from `${base}/manifest.json`.
 * @param {string[]} opts.words - normalized query words
 *   (tg-search.js queryWords output), len >= 2 each.
 * @param {string} [opts.format] - lowercase ext filter ("" = any).
 * @param {string} [opts.source] - source filter: matches the record
 *   `source` OR `handle` ("" = any).
 * @param {number} [opts.limit] - default 10.
 * @param {number} [opts.offset] - default 0.
 * @returns {Promise<{rows: object[], total: number, match: string|null}>}
 *   `rows` are D1-row-shaped (see toRow); `total` is the match count
 *   after filters (capped at MAX_CANDIDATES); `match` is the tier
 *   that produced the rows, or null when nothing matched.
 */
export async function searchStaticIndex(opts) {
  const fetchJson = opts.fetchJson;
  const base = (opts.base || "").replace(/\/$/, "");
  const limit = Math.max(1, opts.limit || 10);
  const offset = Math.max(0, opts.offset || 0);
  const format = (opts.format || "").trim().toLowerCase();
  const source = (opts.source || "").trim();
  // Split hyphenated/dotted query words the way the FTS tokenizer
  // does, then cap the word count (same MAX_WORDS as the D1 path's
  // effective cap).
  const words = [];
  for (const w of opts.words || []) {
    for (const piece of splitQueryWord(w)) {
      if (!words.includes(piece)) words.push(piece);
    }
    if (words.length >= MAX_WORDS) break;
  }
  if (words.length === 0) return { rows: [], total: 0, match: null };

  let manifest = opts.manifest || null;
  if (!manifest) manifest = await fetchJson(`${base}/manifest.json`);
  const letters = manifest.letters || [];
  if (letters.length === 0) return { rows: [], total: 0, match: null };

  // Fetch-or-null: a missing idx/rec shard (404) means "nothing
  // under that letter" and is empty, not an error. Any other
  // failure propagates so the caller can 500 honestly.
  async function fetchOrNull(url) {
    try {
      return await fetchJson(url);
    } catch (e) {
      if (e && e.status === 404) return null;
      throw e;
    }
  }

  // One fetch per distinct letter file, shared by all tiers.
  const idxCache = new Map();
  async function idxFile(letter) {
    if (!idxCache.has(letter)) {
      idxCache.set(letter, fetchOrNull(`${base}/idx/${letter}.json`));
    }
    return idxCache.get(letter);
  }
  const recCache = new Map();
  async function recFile(letter) {
    if (!recCache.has(letter)) {
      recCache.set(letter, fetchOrNull(`${base}/rec/${letter}.json`));
    }
    return recCache.get(letter);
  }

  // Postings for one exact word ([] when the word is not indexed).
  async function postings(word) {
    const file = await idxFile(wordLetter(word));
    return (file && file[word]) || [];
  }

  // Postings for all index words starting with `prefix` (unioned,
  // capped at MAX_CANDIDATES pointers / MAX_EXPANSION_WORDS words).
  async function prefixPostings(prefix) {
    const file = await idxFile(wordLetter(prefix));
    if (!file) return [];
    const out = [];
    const seen = new Set();
    let wordsExpanded = 0;
    for (const key of Object.keys(file)) {
      if (!key.startsWith(prefix)) continue;
      wordsExpanded++;
      if (wordsExpanded > MAX_EXPANSION_WORDS) break;
      for (const ptr of file[key]) {
        if (!seen.has(ptr)) {
          seen.add(ptr);
          out.push(ptr);
          if (out.length >= MAX_CANDIDATES) return out.sort((a, b) => a - b);
        }
      }
    }
    out.sort((a, b) => a - b);
    return out;
  }

  // Resolve pointers to filtered, ranked D1-shaped rows. Every
  // matched letter is fetched (up to MAX_REC_FILES), newest-first
  // (manifest `letters_newest` is the newest rec date per letter,
  // parallel to `letters`) — so `total` is the honest resolved
  // match count (after the format/source filters), not just the
  // page, and if the cap ever binds the kept books are the newest
  // letters' (a documented degradation of the fallback, not a
  // silent alphabetical bias). A manifest without `letters_newest`
  // falls back to manifest letter order. The Cache API in front of
  // /api/tg-search stores the fallback reply for 5 min, so the
  // per-query cost of fetching several letter files is paid once
  // per distinct query, not per search.
  async function resolve(ptrs) {
    const capped = ptrs.slice(0, MAX_CANDIDATES);
    const byLetter = new Map();
    for (const ptr of capped) {
      const { letter, row } = decodePointer(ptr, letters);
      if (!letter) continue;
      if (!byLetter.has(letter)) byLetter.set(letter, []);
      byLetter.get(letter).push(row);
    }
    const newestByLetter = new Map();
    (manifest.letters_newest || []).forEach((d, i) => {
      newestByLetter.set(letters[i], d || "");
    });
    const orderedLetters = [...byLetter.keys()]
      .sort((a, b) => {
        const da = newestByLetter.get(a) || "";
        const db = newestByLetter.get(b) || "";
        return da === db ? 0 : da < db ? 1 : -1;
      })
      .slice(0, MAX_REC_FILES);
    const rows = [];
    for (const letter of orderedLetters) {
      const file = await recFile(letter);
      const books = (file && file.books) || [];
      for (const row of byLetter.get(letter)) {
        const record = books[row];
        if (!record) continue;
        if (format && (record[F_EXT] || "").toLowerCase() !== format) continue;
        if (
          source &&
          record[F_SOURCE] !== source &&
          record[F_HANDLE] !== source
        ) {
          continue;
        }
        rows.push({ record, date: record[F_DATE] || "" });
      }
    }
    // Newest-first (rec date desc), then title for determinism.
    rows.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      const ta = a.record[F_TITLE] || "";
      const tb = b.record[F_TITLE] || "";
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
    return rows.map((r) => toRow(r.record));
  }

  // Run one tier: intersect its posting lists; resolve; return the
  // page when it yields rows, else null (try the next tier).
  async function tryTier(match, lists) {
    if (lists.length === 0) return null;
    if (lists.some((l) => l.length === 0)) return null;
    const hits = intersectSorted(lists);
    if (hits.length === 0) return null;
    const rows = await resolve(hits);
    if (rows.length === 0) return null;
    return { rows: rows.slice(offset, offset + limit), total: rows.length, match };
  }

  // Exact postings per word, fetched once and shared by the
  // exact / any / word tiers.
  const exactLists = [];
  for (const w of words) exactLists.push(await postings(w));

  // Tier 0 — exact AND.
  let res = await tryTier("exact", exactLists);
  if (res) return res;

  // Tier 0b — particle-stripped exact AND (label "exact", like D1).
  // Only when some word changes.
  const stripped = words.map((w) => stripAl(stripParticle(w)));
  if (stripped.some((w, i) => w !== words[i])) {
    const strippedLists = [];
    for (const w of stripped) strippedLists.push(await postings(w));
    res = await tryTier("exact", strippedLists);
    if (res) return res;
  }

  // Tier 1 — prefix: every word exact except the LAST, which is a
  // prefix (last word len >= 4, same rule as D1).
  const last = words[words.length - 1];
  if (last.length >= 4) {
    const prefixLists = exactLists.slice(0, -1);
    prefixLists.push(await prefixPostings(last));
    res = await tryTier("prefix", prefixLists);
    if (res) return res;
  }

  // Tier 2 — typo: every word truncated to its first 5-6 chars as a
  // prefix (6 chars for len >= 7, 5 for len 5-6, whole word
  // otherwise — same rule as D1).
  const typoLists = [];
  for (const w of words) {
    const anchor = w.length >= 7 ? w.slice(0, 6) : w.length >= 5 ? w.slice(0, 5) : w;
    typoLists.push(await prefixPostings(anchor));
  }
  res = await tryTier("typo", typoLists);
  if (res) return res;

  // Tier 3 — any word (multi-word only, like D1).
  if (words.length > 1) {
    const anyHits = unionSorted(exactLists);
    if (anyHits.length > 0) {
      const rows = await resolve(anyHits);
      if (rows.length > 0) {
        return { rows: rows.slice(offset, offset + limit), total: rows.length, match: "any" };
      }
    }
  }

  // Tier 4 — longest word alone (multi-word only, like D1).
  if (words.length > 1) {
    const longestIdx = words.reduce(
      (best, w, i) => (w.length > words[best].length ? i : best),
      0,
    );
    const wordHits = exactLists[longestIdx] || [];
    if (wordHits.length > 0) {
      const rows = await resolve(wordHits);
      if (rows.length > 0) {
        return { rows: rows.slice(offset, offset + limit), total: rows.length, match: "word" };
      }
    }
  }

  return { rows: [], total: 0, match: null };
}
