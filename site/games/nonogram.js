/* RliBook — Nonogram (Picross).
 * Original RliBook implementation (vanilla JS, no framework).
 * References consulted: monkeyArms/nonogram (MIT) and
 * davidje13/nonogram (GPL-3.0) — see attribution.md. Neither was
 * copied: the puzzles below are hand-designed RliBook pictures, and
 * the clues are computed from the solution by computeClues().
 * How to play: the numbers on each row/column say how many runs of
 * filled cells there are, and how long each run is. Tap a cell to
 * fill it; switch to "mark" (✕) for cells you know are empty.
 * You win when every filled cell matches the hidden picture exactly.
 */
(function () {
  "use strict";

  // 1 = filled, 0 = empty. Hand-designed RliBook pictures.
  var PUZZLES = [
    {
      name: "قلب — 5×5", size: 5,
      rows: ["11011", "11111", "11111", "01110", "00100"]
    },
    {
      name: "نجمة — 5×5", size: 5,
      rows: ["00100", "01110", "11111", "01110", "01010"]
    },
    {
      name: "كتاب — 5×5", size: 5,
      rows: ["11110", "10010", "10010", "10010", "11110"]
    },
    {
      name: "بيت — 10×10", size: 10,
      rows: [
        "0000110000", "0001111000", "0011111100", "0111111110",
        "1111111111", "0110000110", "0110000110", "0110110110",
        "0110000110", "0111111111"
      ]
    },
    {
      name: "سمكة — 10×10", size: 10,
      rows: [
        "0000000000", "0001111000", "0011111100", "0110111110",
        "1111111111", "0111111100", "0011110000", "0001100000",
        "0000000000", "0000000000"
      ]
    }
  ];

  // Runs of 1s in a line, e.g. "11011" -> [2, 2]; "00000" -> [0].
  function runs(line) {
    var out = [], n = 0;
    for (var i = 0; i < line.length; i++) {
      if (line[i] === "1") n++;
      else if (n) { out.push(n); n = 0; }
    }
    if (n) out.push(n);
    return out.length ? out : [0];
  }

  function computeClues(puzzle) {
    var n = puzzle.size;
    var rowClues = puzzle.rows.map(runs);
    var colClues = [];
    for (var c = 0; c < n; c++) {
      var col = "";
      for (var r = 0; r < n; r++) col += puzzle.rows[r][c];
      colClues.push(runs(col));
    }
    return { rows: rowClues, cols: colClues };
  }

  function isSolved(puzzle, state) {
    // state[r][c]: 0 empty, 1 filled, 2 marked-X.
    for (var r = 0; r < puzzle.size; r++) {
      for (var c = 0; c < puzzle.size; c++) {
        var want = puzzle.rows[r][c] === "1" ? 1 : 0;
        var got = state[r][c] === 1 ? 1 : 0;
        if (want !== got) return false;
      }
    }
    return true;
  }

  function initUI() {
    var selectEl = document.getElementById("puzzle");
    var gridEl = document.getElementById("grid");
    var statusEl = document.getElementById("status");
    var puzzle, clues, state, mode, won;

    PUZZLES.forEach(function (p, i) {
      var opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = p.name;
      selectEl.appendChild(opt);
    });

    function loadPuzzle(i) {
      puzzle = PUZZLES[i];
      clues = computeClues(puzzle);
      state = [];
      for (var r = 0; r < puzzle.size; r++) {
        var row = [];
        for (var c = 0; c < puzzle.size; c++) row.push(0);
        state.push(row);
      }
      mode = "fill";
      won = false;
      updateModeButtons();
      render();
      statusEl.textContent = "لغز «" + puzzle.name + "» — املأ المربعات حسب الأرقام لتظهر الصورة.";
    }

    function updateModeButtons() {
      document.getElementById("modeFill").className = mode === "fill" ? "btn" : "btn btn-ghost";
      document.getElementById("modeMark").className = mode === "mark" ? "btn" : "btn btn-ghost";
    }

    function render() {
      var n = puzzle.size;
      gridEl.innerHTML = "";
      gridEl.style.gridTemplateColumns = "auto repeat(" + n + ", 44px)";
      var corner = document.createElement("div");
      corner.className = "nono-corner";
      gridEl.appendChild(corner);
      for (var c = 0; c < n; c++) {
        var cc = document.createElement("div");
        cc.className = "nono-clue col";
        cc.innerHTML = clues.cols[c].join("<br>");
        gridEl.appendChild(cc);
      }
      for (var r = 0; r < n; r++) {
        var rc = document.createElement("div");
        rc.className = "nono-clue row";
        rc.textContent = clues.rows[r].join(" ");
        gridEl.appendChild(rc);
        for (var c2 = 0; c2 < n; c2++) {
          (function (rr, cc2) {
            var cell = document.createElement("button");
            cell.type = "button";
            cell.className = "nono-cell";
            cell.setAttribute("aria-label", "صف " + (rr + 1) + " عمود " + (cc2 + 1));
            if (state[rr][cc2] === 1) cell.classList.add("filled");
            else if (state[rr][cc2] === 2) { cell.classList.add("marked"); cell.textContent = "✕"; }
            cell.addEventListener("click", function () { onCell(rr, cc2); });
            gridEl.appendChild(cell);
          })(r, c2);
        }
      }
    }

    function onCell(r, c) {
      if (won) return;
      if (mode === "fill") state[r][c] = state[r][c] === 1 ? 0 : 1;
      else state[r][c] = state[r][c] === 2 ? 0 : 2;
      if (isSolved(puzzle, state)) {
        won = true;
        render();
        statusEl.textContent = "أحسنت! 🎉 أكملت الصورة: «" + puzzle.name + "» — جرّب لغزاً آخر من القائمة.";
        return;
      }
      render();
    }

    document.getElementById("modeFill").addEventListener("click", function () { mode = "fill"; updateModeButtons(); });
    document.getElementById("modeMark").addEventListener("click", function () { mode = "mark"; updateModeButtons(); });
    document.getElementById("clear").addEventListener("click", function () { loadPuzzle(selectEl.value); });
    selectEl.addEventListener("change", function () { loadPuzzle(selectEl.value); });

    loadPuzzle(0);
  }

  if (typeof document !== "undefined") initUI();

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      PUZZLES: PUZZLES, runs: runs,
      computeClues: computeClues, isSolved: isSolved
    };
  }
})();
