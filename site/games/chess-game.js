/* RliBook — Chess UI.
 * Rules engine: chess.js 0.13.4 (vendored in vendor/chess.js,
 * BSD-2-Clause, https://github.com/jhlywa/chess.js).
 * This file is the RliBook UI + AI only: tap-to-move board, legal-move
 * highlights, status line, move list, undo, new game.
 * AI: easy = random legal move; medium = greedy 1-ply (best material
 * gain, small random tie-break). Two-player mode on the same device.
 * Promotion is always to queen (auto-queen), stated on the page.
 */
(function () {
  "use strict";

  var PIECES = {
    w: { k: "\u2654", q: "\u2655", r: "\u2656", b: "\u2657", n: "\u2658", p: "\u2659" },
    b: { k: "\u265A", q: "\u265B", r: "\u265C", b: "\u265D", n: "\u265E", p: "\u265F" }
  };
  var VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
  var FILES = "abcdefgh";

  function squareName(r, c) { return FILES[c] + (8 - r); }

  function evaluate(game) {
    // Simple material count from White's point of view.
    var score = 0, board = game.board();
    for (var r = 0; r < 8; r++) {
      for (var c = 0; c < 8; c++) {
        var p = board[r][c];
        if (p) score += (p.color === "w" ? 1 : -1) * VALUES[p.type];
      }
    }
    return score;
  }

  function pickMove(game, mode) {
    var moves = game.moves({ verbose: true });
    if (!moves.length) return null;
    if (mode === "easy") return moves[Math.floor(Math.random() * moves.length)];
    // Medium: greedy 1-ply — best material outcome for the side to move.
    var best = null, bestScore = -Infinity;
    var side = game.turn();
    for (var i = 0; i < moves.length; i++) {
      var m = moves[i];
      game.move(m);
      var s = evaluate(game) * (side === "w" ? 1 : -1);
      if (game.in_checkmate()) s += 1000;
      game.undo();
      s += Math.random() * 0.2; // small tie-break so play varies
      if (s > bestScore) { bestScore = s; best = m; }
    }
    return best;
  }

  function initUI() {
    var game = new Chess();
    var boardEl = document.getElementById("board");
    var statusEl = document.getElementById("status");
    var movesEl = document.getElementById("moves");
    var modeEl = document.getElementById("mode");
    var selected = null; // square name, e.g. "e2"
    var legalTargets = {}; // dest square -> verbose move
    var aiBusy = false;

    function render() {
      boardEl.innerHTML = "";
      var board = game.board();
      for (var r = 0; r < 8; r++) {
        for (var c = 0; c < 8; c++) {
          var sq = squareName(r, c);
          var btn = document.createElement("button");
          btn.type = "button";
          btn.className = "chess-sq " + ((r + c) % 2 === 0 ? "light" : "dark");
          btn.dataset.square = sq;
          btn.setAttribute("aria-label", sq);
          var p = board[r][c];
          if (p) {
            btn.textContent = PIECES[p.color][p.type];
            btn.classList.add(p.color === "w" ? "white-piece" : "black-piece");
          }
          if (selected === sq) btn.classList.add("selected");
          if (legalTargets[sq]) {
            btn.classList.add(legalTargets[sq].captured ? "legal-capture" : "legal");
          }
          btn.addEventListener("click", onSquare(sq));
          boardEl.appendChild(btn);
        }
      }
      updateStatus();
    }

    function updateStatus() {
      var turn = game.turn() === "w" ? "الأبيض" : "الأسود";
      var text;
      if (game.in_checkmate()) {
        text = "كش مات — فاز " + (game.turn() === "w" ? "الأسود" : "الأبيض") + "! 🎉";
      } else if (game.in_stalemate()) {
        text = "تعادل — جمود (stalemate).";
      } else if (game.in_draw()) {
        text = "تعادل.";
      } else {
        text = "دور " + turn + (game.in_check() ? " — كش!" : "") + " — اضغط على قطعة لترى نقلاتها.";
      }
      statusEl.textContent = text;
      var hist = game.history();
      movesEl.textContent = hist.length ? "النقلات: " + hist.join(" ") : "";
    }

    function onSquare(sq) {
      return function () {
        if (game.game_over() || aiBusy) return;
        if (modeEl.value !== "two" && game.turn() === "b") return; // AI's turn
        var piece = game.get(sq);
        if (selected && legalTargets[sq]) {
          doMove(legalTargets[sq]);
          return;
        }
        if (piece && piece.color === game.turn()) {
          selected = sq;
          legalTargets = {};
          var moves = game.moves({ square: sq, verbose: true });
          for (var i = 0; i < moves.length; i++) legalTargets[moves[i].to] = moves[i];
          render();
        } else {
          selected = null;
          legalTargets = {};
          render();
        }
      };
    }

    function doMove(move) {
      game.move({ from: move.from, to: move.to, promotion: "q" });
      selected = null;
      legalTargets = {};
      render();
      maybeAiMove();
    }

    function maybeAiMove() {
      if (modeEl.value === "two" || game.game_over() || game.turn() !== "b") return;
      aiBusy = true;
      statusEl.textContent = "الحاسوب يفكّر…";
      setTimeout(function () {
        var m = pickMove(game, modeEl.value);
        if (m) game.move({ from: m.from, to: m.to, promotion: "q" });
        aiBusy = false;
        render();
      }, 250);
    }

    document.getElementById("newGame").addEventListener("click", function () {
      game.reset();
      selected = null; legalTargets = {}; aiBusy = false;
      render();
    });
    document.getElementById("undo").addEventListener("click", function () {
      if (aiBusy) return;
      game.undo();
      if (modeEl.value !== "two") game.undo(); // take back the AI reply too
      selected = null; legalTargets = {};
      render();
    });
    modeEl.addEventListener("change", function () {
      game.reset();
      selected = null; legalTargets = {}; aiBusy = false;
      render();
    });

    render();
  }

  if (typeof document !== "undefined") initUI();

  // Node-testable exports (browser ignores module).
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { pickMove: pickMove, evaluate: evaluate, squareName: squareName };
  }
})();
