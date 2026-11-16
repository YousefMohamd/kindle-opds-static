// RliBook Reader — Block 11b.
//
// Reads EPUB files in the browser with epub.js (vendored, see vendor/).
// No book file is ever stored on our server: the reader fetches the
// file from its library (Hindawi / Drive / the Block 2 proxy) and
// keeps a copy ONLY on the reader's own device (IndexedDB) so the
// book works offline. Highlights + progress live on the device too
// (localStorage); they are queued for sync after login, and sync
// needs the /api/reading-sync endpoint, which does not exist yet —
// until then the reader says so honestly and nothing is lost.
//
// Login rule (per the plan): reading is free without login. Tapping
// Highlight while logged out shows ONE line naming the exact button
// to log in, and does not create the highlight. Progress is saved on
// the device either way, so "continue reading" works without login;
// only syncing it to other devices needs login.
//
// Light on purpose: plain script, no framework, no build step — the
// page must also open in the Kindle browser (where the service worker
// and IndexedDB may simply be missing; the reader degrades to
// online-only reading and says so).
(function () {
  "use strict";
  var Lib = window.RliReaderLib;
  var Auth = window.RliAuth;
  var $ = function (id) { return document.getElementById(id); };

  // ---------- tiny localStorage store (works everywhere) ----------
  var store = {
    get: function (key, fallback) {
      try {
        var raw = window.localStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (e) { return fallback; }
    },
    set: function (key, value) {
      try { window.localStorage.setItem(key, JSON.stringify(value)); }
      catch (e) { /* private mode: lasts for this tab only */ }
    },
  };

  // ---------- IndexedDB: offline book copies only ----------
  var idb = {
    db: null,
    open: function () {
      return new Promise(function (resolve) {
        if (!("indexedDB" in window)) return resolve(null);
        var req = window.indexedDB.open("rlibook-reader", 1);
        req.onupgradeneeded = function () {
          req.result.createObjectStore("books", { keyPath: "key" });
        };
        req.onsuccess = function () { idb.db = req.result; resolve(req.result); };
        req.onerror = function () { resolve(null); };
      });
    },
    getBook: function (key) {
      return new Promise(function (resolve) {
        if (!idb.db) return resolve(null);
        try {
          var req = idb.db.transaction("books", "readonly").objectStore("books").get(key);
          req.onsuccess = function () { resolve(req.result || null); };
          req.onerror = function () { resolve(null); };
        } catch (e) { resolve(null); }
      });
    },
    putBook: function (rec) {
      return new Promise(function (resolve) {
        if (!idb.db) return resolve(false);
        try {
          var req = idb.db.transaction("books", "readwrite").objectStore("books").put(rec);
          req.onsuccess = function () { resolve(true); };
          req.onerror = function () { resolve(false); };
        } catch (e) { resolve(false); }
      });
    },
  };

  // ---------- state ----------
  var book = null;          // epub.js Book
  var rendition = null;     // epub.js Rendition
  var source = null;        // resolved book source (Lib.resolveBookSource)
  var bookKey = null;       // stable key for this book
  var bookTitle = "";
  var savedCfi = null;
  var locationsReady = false;
  var pendingCfi = null;    // current text selection (CFI range)
  var pendingText = "";
  var pendingContents = null;
  var selectedColor = "yellow";
  var highlights = [];      // [{cfiRange, text, color, createdAt}]
  var saveTimer = null;

  var settings = store.get("rlibook-reader-settings", {
    warm: false, brightness: 60, warmth: 50, fontSize: 100, font: "system",
  });
  function saveSettings() { store.set("rlibook-reader-settings", settings); }

  function user() { return Auth ? Auth.getUser() : null; }

  // ---------- status + notices (one line each, plain words) ----------
  function setStatus(text, warn) {
    var el = $("status");
    el.textContent = text;
    el.className = "status" + (warn ? " warn" : "");
  }
  function notice(text) {
    var el = $("notice");
    el.textContent = text;
    el.className = "status warn";
    el.style.display = "block";
  }
  function clearNotice() {
    var el = $("notice");
    el.textContent = "";
    el.className = "status";
    el.style.display = "none";
  }

  // ---------- sync queue (local first, honest about the backend) ----------
  function queueSync(type, payload) {
    var q = store.get("rlibook-sync-queue", []);
    q.push({ type: type, payload: payload, at: Date.now() });
    store.set("rlibook-sync-queue", q);
    flushSync();
  }
  function setSyncLine(text) {
    var el = $("sync-line");
    if (el) el.textContent = text;
  }
  function flushSync() {
    var u = user();
    var q = store.get("rlibook-sync-queue", []);
    if (!u || !q.length) return;
    if (!window.navigator.onLine) {
      setSyncLine("You are offline — your highlights and progress will sync when the internet returns.");
      return;
    }
    window.fetch(Lib.SYNC_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user: u, items: q }),
    }).then(function (res) {
      if (res.ok) {
        store.set("rlibook-sync-queue", []);
        setSyncLine("Synced ✓ — your highlights and progress are on your account.");
      } else if (res.status === 404) {
        // The endpoint is not built yet: keep the queue, say so.
        setSyncLine("Saved on this device. Account sync is not live yet — your highlights are safe here.");
      } else {
        setSyncLine("Saved on this device — sync will try again later.");
      }
    }).catch(function () {
      setSyncLine("Saved on this device — sync will try again when you are back online.");
    });
  }

  // ---------- progress ----------
  function loadProgress() {
    if (!bookKey) return null;
    return store.get("rlibook-progress-" + bookKey, null);
  }
  function saveProgress(cfi, pct) {
    if (!bookKey) return;
    store.set("rlibook-progress-" + bookKey, { cfi: cfi, pct: pct, at: Date.now() });
    if (user()) queueSync("progress", { book: bookKey, title: bookTitle, cfi: cfi, pct: pct });
  }
  function updateProgressUI(pct) {
    if (typeof pct === "number" && isFinite(pct)) {
      $("progress-text").textContent = Math.round(pct * 100) + "% read";
      $("progress-fill").style.width = Math.round(pct * 100) + "%";
    }
  }

  // ---------- highlights ----------
  function loadHighlights() {
    highlights = bookKey ? store.get("rlibook-highlights-" + bookKey, []) : [];
  }
  function saveHighlights() {
    if (!bookKey) return;
    store.set("rlibook-highlights-" + bookKey, highlights);
  }
  function colorHex(id) {
    for (var i = 0; i < Lib.HIGHLIGHT_COLORS.length; i++) {
      if (Lib.HIGHLIGHT_COLORS[i].id === id) return Lib.HIGHLIGHT_COLORS[i].color;
    }
    return "#FFE066";
  }
  function applyHighlight(h) {
    if (!rendition) return;
    try {
      rendition.annotations.highlight(
        h.cfiRange, {},
        function () { openDrawer("highlights"); },
        "rlibook-hl",
        { fill: colorHex(h.color), "fill-opacity": "0.35", "mix-blend-mode": "multiply" }
      );
    } catch (e) { /* a bad CFI must never break the page */ }
  }
  // epub.js keeps annotations in rendition.annotations and re-attaches
  // them itself whenever a section renders (its `inject` hook), so the
  // reader only registers each stored highlight ONCE, right after the
  // rendition is created. Re-registering on every render would stack
  // a duplicate yellow mark on top of the first one.
  function registerStoredHighlights() {
    if (!rendition) return;
    for (var i = 0; i < highlights.length; i++) {
      applyHighlight(highlights[i]);
    }
  }
  function renderHighlightList() {
    var ul = $("highlight-list");
    ul.innerHTML = "";
    if (!highlights.length) {
      ul.innerHTML = "<li class=\"note\">No highlights yet. Select some text, then tap Highlight.</li>";
      return;
    }
    highlights.forEach(function (h, i) {
      var li = document.createElement("li");
      var span = document.createElement("span");
      span.className = "hl-text";
      span.style.background = colorHex(h.color);
      span.textContent = h.text;
      var go = document.createElement("button");
      go.textContent = "Go to it";
      go.onclick = function () { if (rendition) rendition.display(h.cfiRange); };
      var del = document.createElement("button");
      del.className = "hl-del";
      del.textContent = "Delete";
      del.onclick = function () {
        try { rendition.annotations.remove(h.cfiRange, "highlight"); } catch (e) {}
        highlights.splice(i, 1);
        saveHighlights();
        renderHighlightList();
        if (user()) queueSync("highlight-delete", { book: bookKey, cfiRange: h.cfiRange });
      };
      li.appendChild(span);
      li.appendChild(document.createTextNode(" "));
      li.appendChild(go);
      li.appendChild(document.createTextNode(" · "));
      li.appendChild(del);
      ul.appendChild(li);
    });
  }

  // ---------- themes: Warm Light + fonts ----------
  function applyTheme() {
    var warm = Lib.warmLight(settings.brightness, settings.warmth);
    var overlay = $("warm-overlay");
    if (settings.warm) {
      overlay.style.background = warm.overlayColor;
      overlay.style.opacity = String(warm.overlayOpacity);
    } else {
      overlay.style.opacity = "0";
    }
    $("warm-toggle").setAttribute("aria-pressed", settings.warm ? "true" : "false");
    $("warm-panel").className = "panel" + (settings.warm ? " open" : "");
    if (!rendition) return;
    try {
      rendition.themes.register("rlibook-light", {
        body: { background: "#FFFDF5 !important", color: "#1C2826 !important" },
      });
      rendition.themes.register("rlibook-warm", {
        body: { background: warm.pageBg + " !important", color: "#1C2826 !important" },
      });
      rendition.themes.select(settings.warm ? "rlibook-warm" : "rlibook-light");
      rendition.themes.fontSize(settings.fontSize + "%");
      var font = null;
      for (var i = 0; i < Lib.FONTS.length; i++) {
        if (Lib.FONTS[i].id === settings.font) font = Lib.FONTS[i].stack;
      }
      if (font) rendition.themes.font(font);
    } catch (e) { /* theme errors must never block reading */ }
  }

  // ---------- opening a book ----------
  function fetchArrayBuffer(url) {
    return window.fetch(url).then(function (res) {
      if (!res.ok) throw new Error("http-" + res.status);
      return res.arrayBuffer();
    }).then(function (buf) {
      // A book file starts with PK (zip). An HTML error/Cloudflare
      // challenge page starts with "<" — refuse it with a plain message
      // instead of handing epub.js a web page.
      var head = new Uint8Array(buf.slice(0, 2));
      if (head.length < 2 || head[0] !== 0x50 || head[1] !== 0x4b) {
        throw new Error("not-an-epub");
      }
      return buf;
    });
  }

  function resolveFileUrl(src) {
    if (src.kind === "epub") return Promise.resolve(src.url);
    if (src.kind === "token") {
      return window.fetch(src.tokenUrl, { headers: { accept: "application/json" } })
        .then(function (res) {
          if (res.status === 403) throw new Error("flagged");
          if (!res.ok) throw new Error("token-" + res.status);
          return res.json();
        })
        .then(function (data) {
          if (!data || !data.ok || !data.url) throw new Error("no-download");
          return data.url;
        });
    }
    return Promise.reject(new Error("bad-source"));
  }

  function openError(message) {
    setStatus(message, true);
    $("empty").style.display = "block";
    $("viewer-wrap").style.display = "none";
    $("toolbar").style.display = "none";
  }

  function openBook(buf, title) {
    bookTitle = title || bookTitle || "Book";
    $("book-title").textContent = bookTitle;
    document.title = bookTitle + " — RliBook";
    if (typeof window.ePub !== "function") {
      openError("The reader library did not load — check your connection and reload the page.");
      return;
    }
    try { if (rendition) rendition.destroy(); } catch (e) {}
    try { if (book) book.destroy(); } catch (e) {}
    book = window.ePub(buf);
    var viewer = $("viewer");
    rendition = book.renderTo(viewer, {
      width: "100%", height: "100%",
      flow: "paginated", spread: "none",
    });
    var start = (loadProgress() || {}).cfi || undefined;
    registerStoredHighlights();
    rendition.display(start).then(function () {
      applyTheme();
      setStatus(navigator.onLine ? "Reading — tap the sides (or use Previous / Next) to turn the page."
        : "You are offline — reading your saved copy.", false);
    }).catch(function () {
      openError("This book file could not be opened. Try another book, or send it to your device by email.");
    });

    book.ready.then(function () {
      var meta = book.package && book.package.metadata;
      if (meta && meta.title) {
        bookTitle = meta.title;
        $("book-title").textContent = bookTitle;
        document.title = bookTitle + " — RliBook";
      }
      // Table of contents.
      return book.loaded.navigation;
    }).then(function (nav) {
      var ul = $("toc-list");
      ul.innerHTML = "";
      if (!nav || !nav.toc || !nav.toc.length) {
        ul.innerHTML = "<li class=\"note\">This book has no chapter list.</li>";
        return;
      }
      nav.toc.forEach(function (item) {
        var li = document.createElement("li");
        var b = document.createElement("button");
        b.textContent = item.label || item.href;
        b.onclick = function () { rendition.display(item.href); closeDrawers(); };
        li.appendChild(b);
        ul.appendChild(li);
      });
    }).catch(function () { /* contents are optional */ });

    // Reading progress (percent) needs locations; generate in the
    // background so opening stays fast.
    book.ready.then(function () {
      return book.locations.generate(1000);
    }).then(function () {
      locationsReady = true;
    }).catch(function () { /* percent stays hidden; pages still turn */ });

    rendition.on("relocated", function (location) {
      var pct = null;
      try {
        if (locationsReady && location.start && location.start.cfi) {
          pct = book.locations.percentageFromCfi(location.start.cfi);
        }
      } catch (e) { pct = null; }
      if (pct !== null) updateProgressUI(pct);
      clearTimeout(saveTimer);
      saveTimer = setTimeout(function () {
        if (location.start && location.start.cfi) {
          saveProgress(location.start.cfi, pct);
        }
      }, 800);
    });

    // Text selection -> the Highlight popup.
    rendition.on("selected", function (cfiRange, contents) {
      pendingCfi = cfiRange;
      pendingContents = contents;
      try {
        var sel = contents.window.getSelection();
        pendingText = sel ? String(sel.toString()).trim() : "";
      } catch (e) { pendingText = ""; }
      if (!pendingText) return;
      var pop = $("select-pop");
      pop.classList.add("open");
      try {
        var range = contents.window.getSelection().getRangeAt(0);
        var rect = range.getBoundingClientRect();
        var wrap = $("viewer-wrap").getBoundingClientRect();
        pop.style.top = Math.max(8, rect.top - wrap.top - 48) + "px";
        pop.style.left = Math.max(8, Math.min(rect.left - wrap.left, wrap.width - 220)) + "px";
      } catch (e) {
        pop.style.top = "8px"; pop.style.left = "8px";
      }
    });
    rendition.on("unselected", function () {
      // Keep the popup open briefly so the Highlight tap still lands.
      setTimeout(function () {
        if (!$("select-pop").matches(":hover")) $("select-pop").classList.remove("open");
      }, 400);
    });
  }

  function saveOfflineCopy(buf) {
    if (!bookKey) return;
    idb.putBook({ key: bookKey, blob: new Blob([buf], { type: "application/epub+zip" }), title: bookTitle, savedAt: Date.now() })
      .then(function (ok) {
        if (ok) setStatus("This book is saved on your device — you can read it offline.", false);
      });
  }

  function startReading(src) {
    source = src;
    bookKey = Lib.bookKey(src.kind === "epub" ? src.url : (src.tokenUrl || src.url || ""));
    loadHighlights();
    renderHighlightList();
    var saved = loadProgress();
    savedCfi = saved ? saved.cfi : null;
    if (saved && typeof saved.pct === "number") updateProgressUI(saved.pct);
    $("empty").style.display = "none";
    $("viewer-wrap").style.display = "block";
    $("toolbar").style.display = "flex";
    setStatus("Opening the book…", false);

    // Offline copy first: if this book is already saved on the device,
    // open it straight away (fast, and it works with no internet).
    idb.getBook(bookKey).then(function (rec) {
      if (rec && rec.blob) {
        return rec.blob.arrayBuffer().then(function (buf) {
          openBook(buf, rec.title || src.title);
          setStatus("This book is saved on your device — you can read it offline.", false);
        });
      }
      return resolveFileUrl(src)
        .then(function (url) { return fetchArrayBuffer(url); })
        .then(function (buf) {
          openBook(buf, src.title);
          saveOfflineCopy(buf); // download in the background, for offline
        });
    }).catch(function (err) {
      var msg = String(err && err.message || err);
      if (msg === "flagged") {
        openError("This book is flagged (commercial) — the website cannot read it. Ask for it from the bot @RliBook_bot.");
      } else if (msg === "no-download" || msg.indexOf("token-") === 0) {
        openError("The download link is not ready yet — try «احصل على الكتاب على جهازك» on the book page instead.");
      } else if (msg === "not-an-epub") {
        openError("The library sent a web page instead of the book file. Try again, or use «احصل على الكتاب على جهازك» on the book page.");
      } else if (src.corsRisk) {
        openError("Google Drive did not let the browser open this file directly. Use «احصل على الكتاب على جهازك» on the book page to get the file, or the email link there to have it sent.");
      } else {
        openError("Could not open this book — check your connection and try again.");
      }
    });
  }

  function openLocalFile(file) {
    if (!file) return;
    var title = file.name.replace(/\.epub$/i, "");
    bookKey = Lib.bookKey("file:" + file.name + ":" + file.size);
    loadHighlights();
    renderHighlightList();
    $("empty").style.display = "none";
    $("viewer-wrap").style.display = "block";
    $("toolbar").style.display = "flex";
    setStatus("Opening your file…", false);
    file.arrayBuffer().then(function (buf) {
      // Same PK check as a download (a renamed non-EPUB fails here).
      var head = new Uint8Array(buf.slice(0, 2));
      if (head[0] !== 0x50 || head[1] !== 0x4b) throw new Error("not-an-epub");
      openBook(buf, title);
      saveOfflineCopy(buf);
    }).catch(function () {
      openError("That file is not an EPUB book. Pick an .epub file.");
    });
  }

  // ---------- drawers / panels ----------
  function closeDrawers() {
    ["toc-drawer", "highlights-drawer", "login-drawer"].forEach(function (id) {
      $(id).classList.remove("open");
    });
  }
  function openDrawer(which) {
    var map = { toc: "toc-drawer", highlights: "highlights-drawer", login: "login-drawer" };
    var id = map[which];
    var wasOpen = $(id).classList.contains("open");
    closeDrawers();
    if (!wasOpen) $(id).classList.add("open");
    if (which === "highlights") renderHighlightList();
  }

  // ---------- login UI ----------
  function refreshLoginUI() {
    var u = user();
    var btn = $("login-btn");
    if (u) {
      btn.textContent = "👤 " + u.name;
      $("login-state").textContent = "Logged in as " + u.name + " (" + u.provider + ").";
      $("logout-btn").style.display = "inline-block";
      setSyncLine(u.provider === "telegram" && u.verified === false
        ? "Telegram login is saved on this device. The server will verify it when account sync goes live."
        : "Highlights and progress will sync when the account service is ready.");
    } else {
      btn.textContent = "Log in";
      $("login-state").textContent = "Reading is free, no login needed. Log in to keep your highlights and reading progress on all your devices.";
      $("logout-btn").style.display = "none";
      setSyncLine("");
    }
    flushSync();
  }

  // ---------- PWA: service worker + Add to Home Screen ----------
  var deferredInstall = null;
  function initPwa() {
    if ("serviceWorker" in navigator) {
      window.addEventListener("load", function () {
        navigator.serviceWorker.register("/site/sw.js", { scope: "/site/" }).catch(function () {
          /* no service worker on this browser (e.g. Kindle) — reading still works */
        });
      });
    }
    window.addEventListener("beforeinstallprompt", function (e) {
      e.preventDefault();
      deferredInstall = e;
      $("install-btn").style.display = "inline-block";
    });
    $("install-btn").onclick = function () {
      if (deferredInstall) {
        deferredInstall.prompt();
        deferredInstall = null;
        $("install-btn").style.display = "none";
      }
    };
    if (/iPad|iPhone|iPod/.test(navigator.userAgent) && !window.matchMedia("(display-mode: standalone)").matches) {
      $("ios-install-hint").style.display = "block";
    }
    var onlineLine = function () {
      if (!navigator.onLine) setStatus("You are offline — reading your saved copy.", true);
    };
    window.addEventListener("offline", onlineLine);
    window.addEventListener("online", function () {
      setStatus("Back online.", false);
      flushSync();
    });
  }

  // ---------- wire up ----------
  function init() {
    idb.open();
    var params = {};
    try {
      new URLSearchParams(window.location.search).forEach(function (v, k) { params[k] = v; });
    } catch (e) { /* very old browser: no query parsing, empty state */ }

    // Toolbar controls.
    $("prev-btn").onclick = function () { if (rendition) rendition.prev(); };
    $("next-btn").onclick = function () { if (rendition) rendition.next(); };
    $("warm-toggle").onclick = function () {
      settings.warm = !settings.warm;
      saveSettings();
      applyTheme();
    };
    $("brightness").value = settings.brightness;
    $("warmth").value = settings.warmth;
    $("brightness").oninput = function () {
      settings.brightness = Number(this.value); saveSettings(); applyTheme();
    };
    $("warmth").oninput = function () {
      settings.warmth = Number(this.value); saveSettings(); applyTheme();
    };
    $("font-size").value = settings.fontSize;
    $("font-size").oninput = function () {
      settings.fontSize = Number(this.value); saveSettings(); applyTheme();
      $("font-size-val").textContent = settings.fontSize + "%";
    };
    $("font-size-val").textContent = settings.fontSize + "%";
    var fontSel = $("font-select");
    Lib.FONTS.forEach(function (f) {
      var opt = document.createElement("option");
      opt.value = f.id; opt.textContent = f.label;
      if (f.id === settings.font) opt.selected = true;
      fontSel.appendChild(opt);
    });
    fontSel.onchange = function () {
      settings.font = this.value; saveSettings(); applyTheme();
    };
    $("toc-btn").onclick = function () { openDrawer("toc"); };
    $("highlights-btn").onclick = function () { openDrawer("highlights"); };
    $("login-btn").onclick = function () { openDrawer("login"); };
    $("logout-btn").onclick = function () { Auth.logout(); refreshLoginUI(); };

    // Highlight popup: colour swatches + the Highlight button.
    var pop = $("select-pop");
    Lib.HIGHLIGHT_COLORS.forEach(function (c) {
      var b = document.createElement("button");
      b.className = "swatch";
      b.style.background = c.color;
      b.title = c.label;
      b.setAttribute("aria-label", c.label);
      b.setAttribute("aria-pressed", c.id === selectedColor ? "true" : "false");
      b.onclick = function () {
        selectedColor = c.id;
        var all = pop.querySelectorAll(".swatch");
        for (var i = 0; i < all.length; i++) all[i].setAttribute("aria-pressed", "false");
        b.setAttribute("aria-pressed", "true");
      };
      pop.appendChild(b);
    });
    $("highlight-btn").onclick = function () {
      if (!pendingCfi) { pop.classList.remove("open"); return; }
      if (!user()) {
        // One line, exact button named, reading not blocked.
        notice("Highlight needs login — tap Log in above.");
        try { if (pendingContents) pendingContents.window.getSelection().removeAllRanges(); } catch (e) {}
        pendingCfi = null;
        pop.classList.remove("open");
        return;
      }
      var h = { cfiRange: pendingCfi, text: pendingText, color: selectedColor, createdAt: Date.now() };
      highlights.push(h);
      saveHighlights();
      applyHighlight(h);
      renderHighlightList();
      queueSync("highlight", { book: bookKey, title: bookTitle, cfiRange: h.cfiRange, text: h.text, color: h.color });
      pendingCfi = null;
      pop.classList.remove("open");
      setStatus("Highlight saved.", false);
    };

    // Tap zones on the reading area (big tap targets for mobile/Kindle).
    $("tap-prev").onclick = function () { if (rendition) rendition.prev(); };
    $("tap-next").onclick = function () { if (rendition) rendition.next(); };

    // Empty state: file picker + demo book.
    $("file-input").addEventListener("change", function () {
      if (this.files && this.files[0]) openLocalFile(this.files[0]);
    });
    $("demo-link").onclick = function (e) {
      e.preventDefault();
      startReading(Lib.resolveBookSource({ demo: "1" }));
    };

    // Login panel.
    if (Auth) {
      Auth.initGoogle($("google-btn"));
      Auth.initTelegram($("telegram-btn"));
      Auth.onChange(refreshLoginUI);
    }
    refreshLoginUI();
    initPwa();
    applyTheme();

    // Open the book from the URL, or show the empty state.
    var src = Lib.resolveBookSource(params);
    if (src.kind === "epub" || src.kind === "token") {
      startReading(src);
    } else if (src.kind === "unsupported") {
      var unsupportedMsg = "This book is a " + String(src.format || "").toUpperCase() + " file — the reader opens EPUB books. Use «احصل على الكتاب على جهازك» on the book page to get the file, or the email link there to have it sent.";
      if (src.plainReaderTokenUrl) {
        // PDF/TXT open in the plain-HTML reader (/read): mint a
        // 1-hour reader token, then go there.
        openError("This book is a " + String(src.format || "").toUpperCase() + " file — it opens in the plain reader instead.");
        var plainLine = $("plain-reader-line");
        if (plainLine) {
          plainLine.style.display = "block";
          var plainLink = $("plain-reader-link");
          plainLink.onclick = function (e) {
            e.preventDefault();
            plainLink.textContent = "Opening…";
            window.fetch(src.plainReaderTokenUrl, { headers: { accept: "application/json" } })
              .then(function (res) {
                if (!res.ok) throw new Error("token-" + res.status);
                return res.json();
              })
              .then(function (data) {
                if (!data || !data.ok || !data.url) throw new Error("no-url");
                window.location.href = data.url;
              })
              .catch(function () {
                setStatus("Could not open the plain reader — try «احصل على الكتاب على جهازك» on the book page instead.", true);
                plainLink.textContent = "📖 Read it in the plain reader (PDF / TXT)";
              });
          };
        }
      } else {
        openError(unsupportedMsg);
      }
    } else if (src.kind === "error") {
      openError(src.message);
    } else {
      $("empty").style.display = "block";
      $("viewer-wrap").style.display = "none";
      $("toolbar").style.display = "none";
      setStatus("Pick a book to read — reading is free, no login needed.", false);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
