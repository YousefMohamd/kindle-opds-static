# Flag scan — automatic commercial (flagged-book) detection

Flag detection was manual until now: the user flagged «الجلاد تحت جلدي»
by hand after telling us it was flagged. This scan automates it for the
whole catalog, one chunk at a time.

## What a flag means

A flagged book is a **recent commercial release**: first published within
the last 2 years and not public domain, with a commercial publisher.
The rule mirrors the bot's submission check exactly
(`rlibook_bot/bookcheck.py`, `RECENT_YEARS = 2`,
`PUBLIC_DOMAIN_YEAR = 1929`, and `src/bookcheck.ts` in the worker), so
the automatic flag agrees with what the bot refuses at upload time.
The one known manual flag fits the rule: «الجلاد تحت جلدي» by عماد راشد
عثمان (دار الرواق) was first published 31 Dec 2025 / 2026 — inside the
2-year window.

A flagged book appears as a flag on the website but cannot be read or
downloaded there; the bot can still point to the source channel. A
**false flag is worse than a missed flag** (it blocks a legal book), so
the scan is conservative: it flags only on clear evidence, and anything
doubtful stays unflagged for manual review.

## Verdicts

| Verdict | Meaning |
|---|---|
| `flag` | Clear recent-commercial evidence: title+author match **and** a publisher **and** a usable year showing first publication within the last 2 years. |
| `clear` | Checked, not a recent commercial release: public domain (first published before 1929) or an older edition with a publisher. |
| `uncertain` | Could not determine: no author/title in the index, no match in any available API, a match with no publisher or no year, or an API error. Never flagged. |

## Sources

- **Open Library** (`openlibrary.org/search.json`, free, no key) — the
  working source. Its `first_publish_year` is the right field: it
  distinguishes a genuinely recent book from a public-domain classic
  with a modern reprint (e.g. Pride and Prejudice, first published
  1813, has hundreds of modern publishers — still public domain).
  Coverage of recent commercial books is weak, especially Arabic ones:
  «الجلاد تحت جلدي» returns 0 results.
- **Google Books** (`googleapis.com/books/v1/volumes`, free, no key)
  — **does not work without a key from this environment.** Verified
  2026-11-14 by the bot and again by this scan's probe: every no-key
  request returns HTTP 429, «Quota exceeded», `quota_limit_value:
  "0"`. The scan probes Google Books once per run (one call); on a
  429 it disables the source for the run and continues with Open
  Library only. It never retries blindly. Google Books is consulted
  only when Open Library did not decide the book, and only when the
  probe said it works. No API key is used anywhere in this module —
  keys never go on a command line. If a key exists one day, that is a
  separate change (the bot already supports one as a Worker secret).

Matching: the queried title/author must match a result's title/author
after Arabic normalization (tashkeel stripped, alef forms unified —
`tbi.books.normalize_arabic`). Either normalized title containing the
other (subtitles allowed, same rule as the bot's `flags.ts`), or
mostly-overlapping word sets. The scan takes the **first** matching
candidate; Open Library returns best matches first, so the exact work
normally wins. Residual risk, documented honestly: a short title can
match a different work in the same series («Dune» vs «Dune Messiah»)
— the evidence string always carries the matched title, so a human
reviewing `flag-list.jsonl` before applying flags can catch it.

Query normalization: a leading track number in the parsed title
(«01. ONYX STORM», «001 - …», «007 - …») is stripped for the API
query only (`query_title` in `flag_scan.py`). Verified 2026-11-14:
Open Library returns 0 results for «01. ONYX STORM» by Rebecca
Yarros and 4 for «ONYX STORM». The stored title, the match check and
the flag list keep the original text; a bare leading year is never
stripped («1984» is untouched).

Year precedence: Open Library's `first_publish_year` is authoritative.
Google Books has no first-publication field, so its earliest matching
edition year is only a proxy, used when Open Library has no usable
year. If Open Library says the first publication is old and Google
Books shows a recent reprint, Open Library wins (clear, not flagged).

## How to run a chunk

From the `telegram/` directory. The catalog DB is opened **read-only**;
D1 is never touched; nothing is pushed or deployed by this script.

```bash
# Self-test: 6 known books against the live APIs (no writes).
python -m tbi.flag_scan --self-test --db /path/to/index.db

# Run chunk 0 (1,000 distinct books). Omit --chunk to run the next
# unfinished chunk.
python -m tbi.flag_scan --db /path/to/index.db --chunk 0
```

Options: `--chunk-size` (default 1000), `--delay` seconds between API
requests (default 1.0), `--recent-years` (default 2, mirroring the
bot; `0` flags any in-copyright commercial edition instead — see
«Open question» below), `--pd-year` (default 1929), `--max-books`
(testing only), `--progress` / `--flag-list` / `--log-dir` paths.

Exit codes: `0` chunk complete; `2` stopped mid-chunk (rate-limited
or 5 consecutive API errors — progress saved, re-run the same
`--chunk` to resume); `1` usage error.

## Batching, resume, rate limits

- One chunk = 1,000 distinct books (`dedupe_key` order, deterministic).
  Same title+author with different file sizes are different keys, but
  share one API verdict via an in-memory cache (one call per
  title+author per run).
- Progress file `flag-scan-progress.json` (local only, **never
  commit**): completed chunks are summarized; the in-progress chunk
  keeps one outcome per book, so a stopped run resumes without
  re-calling the APIs for decided books. A re-run of a completed chunk
  is a no-op for the flag list (lines are deduped by handle+post_id).
- One API request per second at most, polite User-Agent
  (`RliBook-flag-scan/1.0`), 15 s timeouts. A 429 from Open Library
  stops the chunk immediately. A 429 from Google Books disables that
  source for the run.
- Full catalog: 324,416 distinct books (2026-11-14 seed) = 325 chunks.
  At ~1.3 s per API-checked book and ~47% of books carrying an author,
  a chunk takes ~10 minutes and the full run ~55 hours of wall time.
  **Do not run the full catalog by hand** — it is a scheduled job for
  later (one chunk per run, or a few per day). The chunk-0 run below
  is the proof the pipeline works.

## Outputs

- `telegram/flag-list.jsonl` — **the deliverable.** One line per
  flagged book *occurrence* (a book shared in several channels gets
  one line per channel, because the KV key is per file):
  `{"handle": "<channel>", "post_id": <id>, "title": "<title>",
  "author": "<author>", "evidence": "<what the API returned>",
  "source": "google-books|open-library"}`. The parent applies the
  flags from this file (`flag:<handle>:<post_id>` in KV). This module
  never writes KV itself (no Cloudflare token here). Every line
  carries its evidence so a human can review it before applying.
- `flag-scan-log-chunkNNNN.jsonl` — audit trail: one line per scanned
  book (verdict, reason, evidence, occurrences). Local only, never
  commit.
- `flag-scan-progress.json` — resume state. Local only, never commit.

## Results

### Self-test (live APIs, 2026-11-14, no writes) — 6/6 as expected

| Book | Expected | Got | Evidence |
|---|---|---|---|
| Onyx Storm — Rebecca Yarros | flag | flag | Open Library: first published 2025, publishers: Entangled Publishing, LLC; Red Tower Books |
| Sunrise on the Reaping — Suzanne Collins | flag | flag | Open Library: first published 2025, publishers: Scholastic; … |
| The Women — Kristin Hannah | flag | flag | Open Library: first published 2024, publishers: St. Martin's Press; … |
| The Alchemist — Paulo Coelho | clear | clear | Open Library matched the Graphic Novel work, first published 2010 (not recent) |
| Pride and Prejudice — Jane Austen | clear | clear | Open Library: first published 1813 (public domain) |
| الجلاد تحت جلدي — عماد راشد | uncertain | uncertain | No match in any available API (0 Open Library results; Google Books 429) |

Google Books (no key) confirmed unavailable again: HTTP 429,
«Quota exceeded», quota 0.

### Chunk 0 (first 1,000 distinct books) — 2026-11-14, final run

`considered=1000 flagged=9 clear=5 uncertain=986 api_calls=429
google_books=False completed=True` — 7 min 44 s, Open Library only.

| Outcome | Count | Why |
|---|---|---|
| flagged | 9 books (10 flag-list lines — Onyx Storm has 2 occurrences) | Recent commercial edition, publisher + year confirmed (below) |
| clear | 5 | Checked, not recent: 1952, 2008, 2023, 2019, 2014 |
| uncertain | 986 | 528 no author in the index (no API call) + 458 no Open Library match |

Flagged in chunk 0 (all via Open Library, all with publisher + year):

| Book | Year | Publisher (evidence) |
|---|---|---|
| Battle Mountain — C.J. Box (thedevilshours 3875) | 2025 | Head of Zeus / Penguin Publishing Group |
| Everything Is Tuberculosis — John Green (muscatnonfiction 6810) | 2025 | Penguin Random House / Crash Course |
| Mark Twain — Ron Chernow (muscatnonfiction 7284) | 2025 | Penguin Press |
| Melania — Melania Trump (muscatnonfiction 5585) | 2024 | Skyhorse Publishing |
| Onyx Storm — Rebecca Yarros (thedevilshours 3810, 3902) | 2025 | Entangled / Red Tower Books |
| Sister Wife — Christine Brown Woolley (muscatnonfiction 8241) | 2025 | Gallery Books |
| Somehow — Anne Lamott (muscatnonfiction 3630) | 2024 | Canongate / Penguin Publishing Group |
| The Boyfriend — Freida McFadden (Legacy_1945 7428) | 2024 | Sourcebooks / Poisoned Pen Press |
| The Demon of Unrest — Erik Larson (muscatnonfiction 3856) | 2024 | Crown Publishing Group |

Clear in chunk 0: The Old Man and the Sea (1952), Flying Home (2008),
Fourth Wing (2023 — correctly NOT flagged under the 2-year rule),
Ready Player Two (2019), The Body Keeps the Score (2014).

Why uncertain is so high (98.6%): chunk 0 is the alphabetically-first
slice, dominated by numeric-prefixed curriculum/junk titles and
mis-parsed authors («كتاب الطالب», «للبنين», «Z-Library»). 52.8% of
the chunk has no author at all, so no API call is even possible; of
the 472 checked, 458 have no Open Library match. That is the catalog's
shape in this slice, not a scanner failure — the same queries were
verified by hand (a mangled title returns 0 docs, the clean title
returns the book).

First-attempt note (honest history): the first chunk-0 run returned
0 flagged / 0 clear / 1000 uncertain, because the parsed titles carry
leading track numbers («01. ONYX STORM») that Open Library cannot
match. Diagnosing that led to `query_title` (strip the number for the
query only); the chunk was reset and re-run with the fix, giving the
numbers above. The stale first log was discarded, not kept.

## Open questions

1. **Flag window: 2 years or any in-copyright commercial edition?**
   The scan defaults to the bot's 2-year rule (`--recent-years 2`),
   which the task's «a recent commercial edition = flagged» and the
   الجلاد precedent both support. The alternative — flag any
   in-copyright book with a publisher (`--recent-years 0`) — would
   flag far more of the catalog (e.g. The Alchemist, Dune) and is one
   flag away if the coordinator decides that. Note the 2-year rule
   also matches the bot's Dune / Ender's Game test fixtures only as
   *matching* examples, not as flag-rule examples. Recorded in
   `~/workspace/blocks-open-questions.md`.
2. **Google Books without a key is dead (429, quota 0).** The scan
   works on Open Library alone, but Open Library has no record of
   recent Arabic commercial books (الجلاد: 0 results), so those can
   only be flagged manually or with a keyed Google Books source.
   Whether to add a keyed path later is a coordinator decision (a key
   would be a Cloudflare secret, never in the repo).
3. **Full run scheduling.** 325 chunks at ~10 min each is ~55 hours.
   Needs a scheduled job (one/few chunks per run) — not built here.

## Files

- `telegram/tbi/flag_scan.py` — the scan (stdlib only, imports
  `normalize_arabic` from `tbi.books`; never edits `books.py`).
- `telegram/tests/test_flag_scan.py` — 26 offline tests (mocked HTTP,
  temp DB): matching, query normalization, verdicts, clients, chunk
  run, resume after a 429, verdict cache, deterministic enumeration.
- `telegram/flag-list.jsonl` — the flag output (see above).
- `docs/flag-scan.md` — this file.
