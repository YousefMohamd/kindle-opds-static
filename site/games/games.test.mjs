// RliBook games — Block 14 tests (node:test, no dependencies).
// Runs the real game logic in Node: Chess via the vendored chess.js,
// Set / Nonogram / Connect 4 pure logic via their module.exports, and
// static cross-checks (every getElementById in checkers.js exists in
// checkers.html; the hub links every game, the notebook and the files).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(root, p), "utf8");

const Chess = require("./vendor/chess.js").Chess;
const chessGame = require("./chess-game.js");
const setGame = require("./set.js");
const nono = require("./nonogram.js");
const c4 = require("./connect4.js");

test("chess: 20 legal moves from the start, and a real game plays", () => {
  const game = new Chess();
  assert.equal(game.moves().length, 20);
  for (const san of ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"]) {
    const m = game.move(san);
    assert.ok(m, san + " should be legal");
  }
  assert.equal(game.turn(), "w");
  assert.equal(game.game_over(), false);
});

test("chess: fool's mate is checkmate", () => {
  const game = new Chess();
  for (const san of ["f3", "e5", "g4", "Qh4#"]) game.move(san);
  assert.equal(game.in_checkmate(), true);
  assert.equal(game.game_over(), true);
});

test("chess: AI picker returns a legal move (easy + medium)", () => {
  const game = new Chess();
  game.move("e4");
  for (const mode of ["easy", "medium"]) {
    const m = chessGame.pickMove(game, mode);
    assert.ok(m && m.from && m.to, mode + " should pick a move");
    assert.ok(game.moves({ verbose: true }).some((v) => v.from === m.from && v.to === m.to));
  }
});

test("set: known set validates, known non-set fails, deck is 81 cards", () => {
  const deck = setGame.buildDeck();
  assert.equal(deck.length, 81);
  const uniq = new Set(deck.map((c) => JSON.stringify(c)));
  assert.equal(uniq.size, 81);
  // All same shape/number/fill, all different size -> a Set.
  assert.equal(setGame.isSet([
    { shape: 0, number: 1, fill: 0, size: 0 },
    { shape: 0, number: 1, fill: 0, size: 1 },
    { shape: 0, number: 1, fill: 0, size: 2 },
  ]), true);
  // Two same + one different on one attribute -> not a Set.
  assert.equal(setGame.isSet([
    { shape: 0, number: 1, fill: 0, size: 0 },
    { shape: 0, number: 1, fill: 0, size: 1 },
    { shape: 1, number: 1, fill: 0, size: 2 },
  ]), false);
  // A dealt table always contains a findable set or none (never crashes).
  const table = setGame.shuffle(setGame.buildDeck()).slice(0, 12);
  const found = setGame.findSet(table);
  if (found) assert.equal(setGame.isSet(found.map((i) => table[i])), true);
});

test("nonogram: clues computed from the solution; solved-state check", () => {
  assert.deepEqual(nono.runs("11011"), [2, 2]);
  assert.deepEqual(nono.runs("00000"), [0]);
  const heart = nono.PUZZLES[0];
  const clues = nono.computeClues(heart);
  assert.deepEqual(clues.rows[0], [2, 2]); // "11011"
  assert.deepEqual(clues.rows[4], [1]); // "00100"
  assert.deepEqual(clues.cols[0], [3]); // column 0: 1,1,1,0,0
  const state = heart.rows.map((r) => [...r].map((ch) => (ch === "1" ? 1 : 0)));
  assert.equal(nono.isSolved(heart, state), true);
  state[0][0] = 0;
  assert.equal(nono.isSolved(heart, state), false);
  for (const p of nono.PUZZLES) {
    assert.equal(p.rows.length, p.size);
    for (const row of p.rows) assert.equal(row.length, p.size);
  }
});

test("connect4: gravity, horizontal + vertical + diagonal wins, AI blocks", () => {
  const b = c4.emptyBoard();
  assert.equal(c4.dropRow(b, 0), 5);
  b[5][0] = 1; b[5][1] = 1; b[5][2] = 1;
  assert.equal(c4.winningCells(b, 1), null);
  b[5][3] = 1;
  assert.deepEqual(c4.winningCells(b, 1), [[5, 0], [5, 1], [5, 2], [5, 3]]);
  const v = c4.emptyBoard();
  v[5][0] = 2; v[4][0] = 2; v[3][0] = 2; v[2][0] = 2;
  assert.ok(c4.winningCells(v, 2));
  const d = c4.emptyBoard();
  d[5][0] = 1; d[4][1] = 1; d[3][2] = 1; d[2][3] = 1;
  assert.ok(c4.winningCells(d, 1));
  // AI must block: player has three in a row, open fourth at col 3.
  const threat = c4.emptyBoard();
  threat[5][0] = 1; threat[5][1] = 1; threat[5][2] = 1;
  assert.equal(c4.pickAiColumn(threat), 3);
  assert.equal(c4.boardFull(c4.emptyBoard()), false);
});

test("checkers: every DOM id the script needs exists in the page", () => {
  const js = read("checkers.js");
  const html = read("checkers.html");
  const ids = [...new Set([...js.matchAll(/getElementById\("([^"]+)"\)/g)].map((m) => m[1]))];
  assert.ok(ids.length >= 10, "expected many ids, got " + ids.length);
  for (const id of ids) {
    assert.ok(html.includes(`id="${id}"`), "checkers.html is missing id=" + id);
  }
  assert.ok(!html.includes("fonts.googleapis.com"), "no external fonts");
  assert.ok(!html.includes("i.ibb.co"), "no external images");
});

test("hub: links all five games + notebook + files (bot link)", () => {
  const hub = read("index.html");
  for (const page of ["chess.html", "checkers.html", "connect4.html", "set.html", "nonogram.html"]) {
    assert.ok(hub.includes(page), "hub missing " + page);
    assert.ok(existsSync(join(root, page)), page + " file missing");
  }
  assert.ok(hub.includes("../notebook/"), "hub missing notebook link");
  assert.ok(hub.includes("https://t.me/RliBook_bot"), "hub missing bot link for the files");
  assert.ok(hub.includes("من غير ألوان"), "hub must state Set has no colours");
});

test("games pages: one-line how-to + next step, no external requests", () => {
  for (const page of ["chess.html", "checkers.html", "connect4.html", "set.html", "nonogram.html"]) {
    const html = read(page);
    assert.ok(html.includes('class="howto"'), page + " needs a one-line how-to");
    assert.ok(html.includes("index.html"), page + " needs a back link to the hub");
    assert.ok(!html.includes("http://") || html.includes("https://github.com/jhlywa/chess.js"),
      page + " must not load external resources");
  }
  assert.ok(read("set.html").includes("من غير ألوان"));
  assert.ok(read("set.css").includes("fill-striped"), "set.css must define the striped fill");
});

test("notebook page: says who it is for (Scribe vs others) + 5% numbers", () => {
  const page = read("../notebook/index.html");
  assert.ok(page.includes("Scribe"), "notebook page must name Kindle Scribe");
  assert.ok(page.includes("حدّد أي سطر"), "notebook page must explain the no-pen path");
  assert.ok(page.includes("opacity: 0.05"), "notebook preview numbers must be 5% opacity");
  assert.ok(page.includes("rlibook-notebook-sample.epub"), "notebook page must link the sample EPUB");
  assert.ok(page.includes("https://t.me/RliBook_bot"), "notebook page must link the bot");
});
