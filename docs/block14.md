# Block 14 — Notebook + Games + Files

Date: 2026-11-14. Owner: Blocks Coordinator subagent (website repo only).
No push, no deploy, no bot changes, no D1 changes in this block.

## What it is

Three things, all on rlibook.tech (pages.dev fallback), all in the
RliBook brand palette (Sky Pale `#DFF1F4`, Sky Light `#C4E0EB`,
Sky Blue `#93D4EF`, Sage `#99B6B3`, Olive Dark `#44402F`, Ink `#1C2826`):

1. **Notebook** — a designed notebook EPUB the user writes notes in.
2. **Games** — an interactive web app (NOT EPUB: EPUB does not run games).
3. **Files** — a separate button/link for the books file (the catalog file).

## 1. Notebook

### Files

- `telegram/tbi/notebook.py` — the canonical generator (pure stdlib).
  `python -m tbi.notebook --pages 50 --lines 24 -o rlibook-notebook.epub`
- `site/notebook/notebook.py` — thin re-export shim, same CLI.
- `site/notebook/index.html` — the notebook page.
- `site/notebook/rlibook-notebook-sample.epub` — generated sample,
  50 pages × 24 lines, 31,388 bytes (< 100 KB, so it ships in the repo).
- `telegram/tests/test_notebook.py` — 5 pytest tests.

### Design (per the user's spec)

- Every page carries the RliBook name + bird mark (🐦, text — no image
  file, so the EPUB stays small) on top, plus "دفتر الملاحظات — Notebook".
- Lines are **numbered** (1–24 on each page) and the numbers are at
  **5% opacity** (`opacity: 0.05` in `OEBPS/style.css`) — very faint,
  guiding the eye without competing with the handwriting.
- EPUB 3 with an EPUB 2 NCX for older Kindles; mimetype first + stored;
  one XHTML file per page + title page + nav.
- The generator is the deliverable: the sample EPUB is regenerated
  from the script, never edited by hand.

### Who it is for (stated on the page, so nobody downloads the wrong file)

- **Kindle Scribe (has a pen):** the notebook is made for handwriting —
  write on the lines with the pen.
- **Any other Kindle / reader (no pen):** select a line and add a note
  with the reader's built-in note feature; the numbered lines keep the
  notes organised.

### Delivery (same system as the Qurans)

Email via Send-to-Kindle, or USB into `documents/`. The page offers
both: a bot button (ask for the notebook in `@RliBook_bot`) and a
direct download of the 50-page sample for USB. The dedicated bot
button/flow is a **v4.8.43 follow-up for the bot agent** — recorded in
`~/workspace/blocks-open-questions.md`, not built here (bot source is
another agent's ownership).

## 2. Games — `site/games/`

Public URL `/games/` (rewrite in `_redirects`, same pattern as
`/telegram/` and `/newspapers/`). Light, no framework, no external
requests (no fonts, no images, no CDN), touch-friendly (44px+ targets),
boards forced `dir="ltr"` inside the Arabic RTL page. Every game page
has a one-line how-to, a status line, a new-game button and a next step
(links to the other games / notebook). Full source + licence table:
`site/games/attribution.md`.

| Game | File | Status | Engine / source |
|---|---|---|---|
| Chess | `chess.html` + `chess-game.js` + `vendor/chess.js` | **Full** — tap-to-move, legal-move highlights, check/checkmate/stalemate, move list, undo, vs computer (easy random / medium greedy 1-ply) or 2 players, auto-queen promotion | chess.js 0.13.4 UMD, vendored, BSD-2-Clause (`vendor/chess-LICENSE.txt`); UI + AI are original RliBook code |
| Dama / Checkers | `checkers.html` + `checkers.js` + `checkers.css` | **Full** — 8×8 American draughts vs AI (easy/medium/hard minimax), captures, multi-jumps, kings, 3-fold draw | Adapted from he-is-talha `41-Checkers-Game` (MIT): same logic, Arabic UI, brand colours |
| Connect 4 | `connect4.html` + `connect4.js` + `connect4.css` | **Full** — real gravity, vs AI (win/block/random) or 2 players, inline status (no alerts) | Fresh RliBook implementation; he-is-talha `25-Connect-Four-Game` (MIT) consulted as reference — it has no gravity and uses `alert()`, so it was rewritten |
| Set — **no colours** | `set.html` + `set.js` + `set.css` | **Full** — 81-card deck, 12 on the table, score, hint, "no Set" deals 3 more | Fresh RliBook implementation; muthuspark Set (MIT, Vue 3 + Vite) consulted as reference. The colour attribute is replaced by **size**: cards differ only by shape (oval/diamond/rectangle — classic Set shapes), number (1–3), fill (solid/striped/outline, monochrome ink) and size (small/medium/large). Shapes are plain-CSS (no gradients/clip-path/exotic glyphs) so they render on old e-ink browsers |
| Nonogram | `nonogram.html` + `nonogram.js` + `nonogram.css` | **Full** — 5 hand-designed puzzles (heart, star, book 5×5; house, fish 10×10), clues computed from the solution, fill / mark-✕ modes, win detection | Fresh RliBook implementation; monkeyArms/nonogram (MIT) and davidje13/nonogram (GPL-3.0) consulted only, nothing copied |

### What "the same smoothness" means here

One shared shell: same brand CSS (`style.css`), same page shape
(how-to → controls → board → status → next step), same touch rules,
no page reloads, no external requests. The two adapted games kept
their original game feel (checkers animations, levels); the three
fresh ones were written to the same shell.

### Candidates checked but NOT used

See `site/games/attribution.md` — includes draughts.js (MPL-2.0),
OMerkel Buff-and-Green (MIT), p1carats/picross-web (MIT, needs PHP+DB),
and two unlicensed nonogram repos (not used: no verifiable licence).

## 3. Files — the books file button

No new file format. Both the games hub (`site/games/index.html`) and
the notebook page (`site/notebook/index.html`) carry a separate
"📚 ملف الكتب (الكتالوج)" card with a clear button to
`https://t.me/RliBook_bot` (ask the bot for the catalog file — email or
USB, same as the Qurans) plus a link to `/telegram/` to search the
books directly.

## Verification (all run 2026-11-14)

- Repo tests before changes: `node --test functions/book.test.mjs
  functions/new.test.mjs` — 38 passed (baseline).
- After changes: same command — still passing (2 suites, 0 fail).
- New tests: `node --test site/games/games.test.mjs` — **10 passed**,
  including a real Chess game (e4 e5 Nf3 Nc6 Bb5 a6), fool's-mate
  checkmate, AI picker legality, Set validation, Nonogram clues,
  Connect 4 gravity/wins/AI-block, checkers DOM-id cross-check,
  hub links, notebook-page wording.
- `python3 -m pytest telegram/tests/test_notebook.py` — **5 passed**.
- Notebook EPUB validated by hand: 57 zip entries, mimetype first +
  stored, `application/epub+zip`, container → OPF, 50 page files,
  24 numbered lines on page 1, CSS `opacity: 0.05`, all XHTML/OPF/NCX
  parse as XML, `testzip()` clean, 31,388 bytes.
- Chess play test (live logic): 60 legal moves played by the medium AI
  against itself from the start position, game still in progress —
  engine + AI work end-to-end. (Also the 6-move scripted game + fool's
  mate in the automated tests above.)
- Local HTTP check (`python3 -m http.server`): hub + all 5 game pages +
  notebook page + sample EPUB all return **200**.
- `node --check` passes on every game JS file including the vendored
  chess.js. No external requests in any game/notebook page
  (checked by test: no `fonts.googleapis.com`, no `i.ibb.co`, no
  `http://` loads except the chess.js credit link).

## Known limits / open questions

Recorded in `~/workspace/blocks-open-questions.md` (one line each):

- Bot notebook button/flow — v4.8.43 follow-up (bot agent's ownership).
- Chess promotion is always queen (auto-queen) — no promotion picker;
  fine for casual play, noted on the page.
- Set shapes are oval / diamond / rectangle: the classic third shape
  (squiggle) is replaced by a rectangle so all three render with plain
  CSS on old e-ink browsers. The striped fill is an outline + one
  middle bar, for the same reason (no gradients).
- Nonogram puzzles are hand-designed and win = exact match to the
  solution; solution uniqueness was not formally proven (casual play).
- Checkers AI "hard" (minimax depth 4) can take a few seconds on the
  oldest Kindle browsers; easy/medium are instant.
