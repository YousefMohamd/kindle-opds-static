/* RliBook — Set, WITHOUT colours (the user's explicit condition).
 * Original RliBook implementation (vanilla JS, no framework).
 * Reference consulted: the Set Game in muthuspark/javascript-games
 * (MIT License) — see attribution.md. That version is Vue 3 + Vite
 * and uses colour as a card attribute; this version is a fresh,
 * dependency-free implementation that replaces the colour attribute
 * with SIZE, so no card ever differs by colour:
 *   shape: oval / diamond / rectangle (classic Set shapes, plain CSS)
 *   number: 1 / 2 / 3 symbols
 *   fill: solid / striped / outline (monochrome ink only)
 *   size: small / medium / large
 * A Set = 3 cards where EACH attribute is all the same or all different.
 * 81 cards (3^4), 12 on the table, +3 when no Set is on the table.
 */
(function () {
  "use strict";

  var SHAPES = ["oval", "diamond", "rect"];
  var FILLS = ["solid", "striped", "outline"];
  var SIZES = ["small", "medium", "large"];

  function buildDeck() {
    var deck = [];
    for (var s = 0; s < 3; s++)
      for (var n = 1; n <= 3; n++)
        for (var f = 0; f < 3; f++)
          for (var z = 0; z < 3; z++)
            deck.push({ shape: s, number: n, fill: f, size: z });
    return deck;
  }

  function shuffle(deck) {
    for (var i = deck.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = deck[i]; deck[i] = deck[j]; deck[j] = t;
    }
    return deck;
  }

  function allSameOrAllDifferent(a, b, c) {
    return (a === b && b === c) || (a !== b && b !== c && a !== c);
  }

  function isSet(cards) {
    if (cards.length !== 3) return false;
    var a = cards[0], b = cards[1], c = cards[2];
    return allSameOrAllDifferent(a.shape, b.shape, c.shape) &&
      allSameOrAllDifferent(a.number, b.number, c.number) &&
      allSameOrAllDifferent(a.fill, b.fill, c.fill) &&
      allSameOrAllDifferent(a.size, b.size, c.size);
  }

  function findSet(table) {
    for (var i = 0; i < table.length; i++)
      for (var j = i + 1; j < table.length; j++)
        for (var k = j + 1; k < table.length; k++)
          if (isSet([table[i], table[j], table[k]])) return [i, j, k];
    return null;
  }

  function initUI() {
    var deck, table, score, selected;
    var tableEl = document.getElementById("table");
    var statusEl = document.getElementById("status");

    function newGame() {
      deck = shuffle(buildDeck());
      table = deck.splice(0, 12);
      score = 0;
      selected = [];
      ensureSetOnTable();
      render();
      setStatus("نقاطك: 0 — اختر 3 بطاقات.");
    }

    function ensureSetOnTable() {
      // Keep dealing 3 more until a Set exists (or the deck runs out).
      while (!findSet(table) && deck.length >= 3) {
        table = table.concat(deck.splice(0, 3));
      }
    }

    function setStatus(text) { statusEl.textContent = text; }

    function render() {
      tableEl.innerHTML = "";
      table.forEach(function (card, idx) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "set-card";
        btn.setAttribute("aria-label", "بطاقة " + (idx + 1));
        if (selected.indexOf(idx) >= 0) btn.classList.add("selected");
        var syms = document.createElement("div");
        syms.className = "set-symbols";
        for (var n = 0; n < card.number; n++) {
          var s = document.createElement("span");
          s.className = "set-sym shape-" + SHAPES[card.shape] +
            " fill-" + FILLS[card.fill] + " size-" + SIZES[card.size];
          syms.appendChild(s);
        }
        btn.appendChild(syms);
        btn.addEventListener("click", function () { onCard(idx); });
        tableEl.appendChild(btn);
      });
    }

    function onCard(idx) {
      var pos = selected.indexOf(idx);
      if (pos >= 0) { selected.splice(pos, 1); render(); return; }
      selected.push(idx);
      if (selected.length === 3) {
        var cards = selected.map(function (i) { return table[i]; });
        if (isSet(cards)) {
          score++;
          setStatus("Set صحيح! 🎉 نقاطك: " + score + " — اختر 3 بطاقات أخرى.");
          // Remove the set, deal replacements (or shrink the table).
          var gone = selected.slice().sort(function (a, b) { return b - a; });
          gone.forEach(function (i) { table.splice(i, 1); });
          while (table.length < 12 && deck.length) table.push(deck.shift());
          if (!deck.length && !findSet(table)) {
            setStatus("انتهت البطاقات! نقاطك النهائية: " + score + " 🎉");
          } else {
            ensureSetOnTable();
          }
        } else {
          setStatus("ليست Set — حاول مجدداً. نقاطك: " + score);
        }
        selected = [];
      }
      render();
    }

    document.getElementById("newGame").addEventListener("click", newGame);
    document.getElementById("hint").addEventListener("click", function () {
      var found = findSet(table);
      var cards = tableEl.querySelectorAll(".set-card");
      cards.forEach(function (c) { c.classList.remove("hint"); });
      if (found) {
        found.forEach(function (i) { cards[i].classList.add("hint"); });
        setStatus("التلميح: البطاقات المحددة بإطار غامق تكوّن Set.");
      } else {
        setStatus("لا يوجد Set على الطاولة — اضغط «أضف 3 بطاقات».");
      }
    });
    document.getElementById("noSet").addEventListener("click", function () {
      if (findSet(table)) {
        setStatus("يوجد Set على الطاولة — ابحث عنه! (جرّب «تلميح»).");
        return;
      }
      if (deck.length >= 3) {
        table = table.concat(deck.splice(0, 3));
        setStatus("أضفنا 3 بطاقات — ابحث عن Set.");
        render();
      } else {
        setStatus("لا توجد بطاقات إضافية في الرزمة.");
      }
    });

    newGame();
  }

  if (typeof document !== "undefined") initUI();

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      buildDeck: buildDeck, shuffle: shuffle,
      isSet: isSet, findSet: findSet,
      SHAPES: SHAPES, FILLS: FILLS, SIZES: SIZES
    };
  }
})();
