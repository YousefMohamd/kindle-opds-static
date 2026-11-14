/* RliBook — Connect 4.
 * Original RliBook implementation (vanilla JS, no framework).
 * Reference consulted: "Connect Four Game" (25-Connect-Four-Game) in
 * he-is-talha/html-css-javascript-games, MIT License — see attribution.md.
 * Differences from that reference, by design: real gravity (a disc
 * falls to the lowest free row of the chosen column), an AI opponent
 * (win if possible, block if needed, else random), an inline status
 * line instead of alert() popups, and RliBook brand colours.
 * Board: 6 rows x 7 columns. Player 1 = sky blue, Player 2 = sage/olive.
 */
(function () {
  "use strict";

  var ROWS = 6, COLS = 7;

  function emptyBoard() {
    var b = [];
    for (var r = 0; r < ROWS; r++) { b.push([0, 0, 0, 0, 0, 0, 0]); }
    return b;
  }

  function dropRow(board, col) {
    for (var r = ROWS - 1; r >= 0; r--) {
      if (board[r][col] === 0) return r;
    }
    return -1;
  }

  // Returns the winning cells [[r,c],...] (length 4) or null.
  function winningCells(board, player) {
    var dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
    for (var r = 0; r < ROWS; r++) {
      for (var c = 0; c < COLS; c++) {
        if (board[r][c] !== player) continue;
        for (var d = 0; d < dirs.length; d++) {
          var dr = dirs[d][0], dc = dirs[d][1];
          var cells = [[r, c]], ok = true;
          for (var k = 1; k < 4; k++) {
            var nr = r + dr * k, nc = c + dc * k;
            if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS || board[nr][nc] !== player) { ok = false; break; }
            cells.push([nr, nc]);
          }
          if (ok) return cells;
        }
      }
    }
    return null;
  }

  function boardFull(board) {
    for (var c = 0; c < COLS; c++) if (board[0][c] === 0) return false;
    return true;
  }

  // AI: win now if possible, block the player's immediate win, else random.
  function pickAiColumn(board) {
    var free = [];
    for (var c = 0; c < COLS; c++) if (dropRow(board, c) >= 0) free.push(c);
    if (!free.length) return -1;
    for (var i = 0; i < free.length; i++) {
      var r = dropRow(board, free[i]);
      board[r][free[i]] = 2;
      var win = !!winningCells(board, 2);
      board[r][free[i]] = 0;
      if (win) return free[i];
    }
    for (var j = 0; j < free.length; j++) {
      var r2 = dropRow(board, free[j]);
      board[r2][free[j]] = 1;
      var block = !!winningCells(board, 1);
      board[r2][free[j]] = 0;
      if (block) return free[j];
    }
    return free[Math.floor(Math.random() * free.length)];
  }

  function initUI() {
    var board = emptyBoard();
    var turn = 1, over = false, aiBusy = false;
    var boardEl = document.getElementById("board");
    var colsEl = document.getElementById("colButtons");
    var statusEl = document.getElementById("status");
    var modeEl = document.getElementById("mode");
    var winCells = null;

    function render() {
      boardEl.innerHTML = "";
      for (var r = 0; r < ROWS; r++) {
        for (var c = 0; c < COLS; c++) {
          var cell = document.createElement("div");
          cell.className = "c4-cell" + (board[r][c] ? " p" + board[r][c] : "");
          if (winCells) {
            for (var i = 0; i < winCells.length; i++) {
              if (winCells[i][0] === r && winCells[i][1] === c) cell.classList.add("win");
            }
          }
          boardEl.appendChild(cell);
        }
      }
      colsEl.innerHTML = "";
      for (var col = 0; col < COLS; col++) {
        (function (cc) {
          var b = document.createElement("button");
          b.type = "button";
          b.textContent = "▼";
          b.setAttribute("aria-label", "العمود " + (cc + 1));
          b.disabled = over || aiBusy || dropRow(board, cc) < 0 ||
            (modeEl.value === "ai" && turn === 2);
          b.addEventListener("click", function () { play(cc); });
          colsEl.appendChild(b);
        })(col);
      }
    }

    function setStatus(text) { statusEl.textContent = text; }

    function play(col) {
      if (over || aiBusy) return;
      if (modeEl.value === "ai" && turn === 2) return;
      var r = dropRow(board, col);
      if (r < 0) return;
      board[r][col] = turn;
      afterMove();
      if (!over && modeEl.value === "ai" && turn === 2) {
        aiBusy = true;
        setStatus("الحاسوب يفكّر…");
        render();
        setTimeout(function () {
          var cc = pickAiColumn(board);
          if (cc >= 0) {
            var rr = dropRow(board, cc);
            board[rr][cc] = 2;
            afterMove();
          }
          aiBusy = false;
          render();
        }, 300);
      }
      render();
    }

    function afterMove() {
      winCells = winningCells(board, turn);
      if (winCells) {
        over = true;
        setStatus(turn === 1 ? "فزت! 🎉 — أربعة أقراص زرقاء في صف واحد." : "فاز الحاسوب — جرّب مجدداً.");
        return;
      }
      if (boardFull(board)) {
        over = true;
        setStatus("تعادل — امتلأت اللوحة.");
        return;
      }
      turn = turn === 1 ? 2 : 1;
      setStatus(turn === 1 ? "دورك — أنت الأزرق." :
        (modeEl.value === "two" ? "دور اللاعب الثاني — الزيتوني." : "دور الحاسوب…"));
    }

    function newGame() {
      board = emptyBoard(); turn = 1; over = false; aiBusy = false; winCells = null;
      setStatus("دورك — أنت الأزرق، والحاسوب الزيتوني.");
      render();
    }

    document.getElementById("newGame").addEventListener("click", newGame);
    modeEl.addEventListener("change", newGame);
    render();
  }

  if (typeof document !== "undefined") initUI();

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      emptyBoard: emptyBoard, dropRow: dropRow,
      winningCells: winningCells, boardFull: boardFull,
      pickAiColumn: pickAiColumn, ROWS: ROWS, COLS: COLS
    };
  }
})();
