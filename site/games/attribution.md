# RliBook Games — Sources & Licences

All games run in the browser on rlibook.tech — no downloads, no framework,
no external requests. Each game below names the open-source project it
comes from (or was checked against), its licence, and what RliBook did
with it. Nothing here is copied from a project whose licence we could
not verify, and no book files are involved.

## Used in the games

| Game | Source project | Licence | What RliBook did |
|---|---|---|---|
| Chess | [chess.js](https://github.com/jhlywa/chess.js) v0.13.4 — rules engine (move generation, check/checkmate) | BSD-2-Clause (vendored copy in `vendor/chess-LICENSE.txt`) | Vendored the UMD build as `vendor/chess.js`; the board UI + AI in `chess-game.js` are original RliBook code. |
| Dama / Checkers | [he-is-talha/html-css-javascript-games](https://github.com/he-is-talha/html-css-javascript-games), `41-Checkers-Game` | MIT | Adapted: same game logic (American draughts, AI levels, multi-jump), Arabic UI strings, RliBook brand colours, no external fonts/images. |
| Connect 4 | [he-is-talha/html-css-javascript-games](https://github.com/he-is-talha/html-css-javascript-games), `25-Connect-Four-Game` | MIT | Consulted as reference; `connect4.js` is a fresh RliBook implementation — the reference has no gravity and uses `alert()` popups; ours adds real gravity, an AI opponent and an inline status line. |
| Set (no colours) | [muthuspark/javascript-games](https://github.com/muthuspark/javascript-games) (Set Game) | MIT | Consulted as reference; `set.js` is a fresh, dependency-free RliBook implementation. The reference is Vue 3 + Vite and uses **colour** as a card attribute; ours replaces the colour attribute with **size**, so no card ever differs by colour (the user's explicit condition). |
| Nonogram | [monkeyArms/nonogram](https://github.com/monkeyArms/nonogram) | MIT | Consulted as reference; `nonogram.js` is a fresh RliBook implementation with hand-designed puzzles and clues computed from the solution. |

## Candidates checked but NOT used

| Project | Licence | Why not used |
|---|---|---|
| [davidje13/nonogram](https://github.com/davidje13/nonogram) (Nonogram editor/player/solver) | GPL-3.0 | Consulted only; nothing copied (a GPL copy would have imposed GPL terms on our files). Our nonogram is original code. |
| [shubhendusaurabh/draughts.js](https://github.com/shubhendusaurabh/draughts.js) (checkers rules library, inspired by chess.js) | MPL-2.0 | Candidate for the checkers engine; the he-is-talha game already had a complete playable UI + AI, so we adapted that instead. |
| [OMerkel/Buff-and-Green](https://github.com/OMerkel/Buff-and-Green) ("Buff and Green", checkers/Dama) | MIT | Candidate for Dama; the he-is-talha game was simpler to adapt to the Kindle browser. |
| [p1carats/picross-web](https://github.com/p1carats/picross-web) (Picross web interface) | MIT | Candidate for Nonogram; needs PHP + a database, so it does not fit a static site. |
| [jokude/react-nonogram](https://github.com/jokude/react-nonogram), [JosephCoburn/nonogram-puzzle](https://github.com/JosephCoburn/nonogram-puzzle) | no licence stated / unstated | Not used — no verifiable permissive licence. |

## Licence texts

- chess.js BSD-2-Clause: `vendor/chess-LICENSE.txt` (vendored with the library).
- MIT projects above: their MIT licence texts live in their own repositories
  (linked above); our adaptations keep the attribution in each file header.
