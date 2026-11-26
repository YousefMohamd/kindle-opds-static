// RliBook Reader — shared pure logic (Block 11b).
//
// This file has NO browser dependencies on purpose: the reader page
// (reader.js) and the Node tests (reader.test.mjs) both use it.
// In the browser it exposes window.RliReaderLib; in Node it is a
// CommonJS module (module.exports). Keep every function here pure —
// no fetch, no DOM, no IndexedDB — so `node site/reader/reader.test.mjs`
// can verify the URL contract without a browser.
//
// URL contract (the /book owner links here — see README.md):
//   /site/reader/?lib=hindawi&id=13028368
//       -> Hindawi public-domain EPUB, direct from hindawi.org.
//   /site/reader/?lib=khazendar|sahwa|electronic|drive&id=<drive id>
//       -> Google Drive file (CORS may block the in-browser fetch;
//          the reader says so honestly — see corsRisk). lib=drive is
//          a Drive-library book (kind='drive' in D1); the other three
//          are the static Drive libraries.
//   /site/reader/?lib=doab&id=<url-encoded full file URL>
//       -> DOAB file URL (the DOAB index stores the full URL as id).
//   /site/reader/?lib=tg&h=<handle>&p=<post>&f=epub
//       -> Telegram book, via GET /api/dl-token (Block 2 signed token)
//          then the Block 2 proxy URL the endpoint returns.
//   /site/reader/?src=<url-encoded https URL>
//       -> direct file URL, only from an allowlisted host (below).
//   /site/reader/?file=home-en | home-ar
//       -> the bundled RliBook Home EPUB in /files/ (same-origin sample).
//   /site/reader/?demo=1  -> same as ?file=home-en.
//   No params -> the reader opens empty with the file picker + demo link.
//
// Only EPUB opens in the reader. A PDF/DOC link resolves to
// { kind: "unsupported" } and the page points at Send-to-Kindle email
// instead of pretending it can read it — EXCEPT PDF/TXT books,
// which the plain-HTML reader (/read, functions/read.js) opens:
// those carry plainReaderTokenUrl, the /api/read-token URL that
// mints a 1-hour reader token for the book. (Hindawi is the
// exception: its acquisition URL is EPUB-only, so a Hindawi
// PDF/TXT has no plain-reader link.)
//
// No renewal timer here, by design (2026-11-16): the EPUB file is
// fetched ONCE via tokenUrl -> fetchArrayBuffer, then local to
// epub.js — there is nothing to renew. PDF/TXT hand off to /read
// at click, and /read renews its own token (server-side per
// chapter + a background timer). Personal books (?fp= + title)
// thread through dlTokenUrl / plainReaderTokenUrl so the server
// can verify the book is the caller's own (see those functions).

(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  } else {
    root.RliReaderLib = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Hosts the reader may fetch a book file from. Anything else is
  // refused (the ?src= param must never become an open fetch proxy).
  // hindawi.org redirects to safahat.org, so both are listed.
  // drive.google.com serves the Drive libraries (khazendar / sahwa /
  // electronic). The Block 2 proxy host streams Telegram books.
  // gutenberg.org is listed only so a public-domain test book can be
  // opened the same way; it is not a catalog library.
  var ALLOWED_SRC_HOSTS = [
    "hindawi.org",
    "www.hindawi.org",
    "safahat.org",
    "www.safahat.org",
    "drive.google.com",
    "docs.google.com",
    "rlibook-download.injectcloud.space",
    "rlibook.tech",
    "www.rlibook.tech",
    "kindle-opds-static.pages.dev",
    "www.gutenberg.org",
    "gutenberg.org",
  ];

  var DRIVE_LIBS = { khazendar: 1, sahwa: 1, electronic: 1, drive: 1 };
  var SAMPLE_FILES = {
    "home-en": { url: "/files/RliBook-Home-en.epub", title: "RliBook — Home" },
    "home-ar": { url: "/files/RliBook-Home-ar.epub", title: "RliBook — Home" },
  };
  var SYNC_ENDPOINT = "/api/reading-sync";

  function hindawiUrl(id) {
    return "https://www.hindawi.org/books/" + id + ".epub";
  }

  function driveUrl(id) {
    return "https://drive.google.com/uc?id=" + encodeURIComponent(id) + "&export=download";
  }

  // The /api/dl-token URL that mints a 10-minute single-use
  // download token for one Telegram book. `opts` (personal books,
  // 2026-11-16): { fp, title } — appended as &fp=..&t=.. when
  // provided; the server verifies them against the private feed
  // (isPersonalBook) and an own book skips the flag gate and the
  // mint caps. Without opts the call is a plain library-book mint.
  function dlTokenUrl(handle, postId, fmt, opts) {
    var u = "/api/dl-token?h=" + encodeURIComponent(handle)
      + "&p=" + encodeURIComponent(String(postId))
      + "&f=" + encodeURIComponent(fmt || "epub");
    if (opts && opts.fp && opts.title) {
      u += "&fp=" + encodeURIComponent(opts.fp)
        + "&t=" + encodeURIComponent(opts.title);
    }
    return u;
  }

  // The /api/read-token URL that mints a 1-hour token for the
  // plain-HTML reader (/read) for one book. `book` is { lib, id }
  // or { lib: "tg", h, p } plus the format. `opts` (personal
  // books, 2026-11-16): { fp, title } — appended as &fp=..&t=..
  // when provided; an own book gets a token carrying "o":1, which
  // /read renews without any flag re-check.
  function plainReaderTokenUrl(book, fmt, opts) {
    var extra = "";
    if (opts && opts.fp && opts.title) {
      extra = "&fp=" + encodeURIComponent(opts.fp)
        + "&t=" + encodeURIComponent(opts.title);
    }
    if (book.lib === "tg") {
      return "/api/read-token?lib=tg&h=" + encodeURIComponent(book.h)
        + "&p=" + encodeURIComponent(String(book.p))
        + "&f=" + encodeURIComponent(fmt) + extra;
    }
    return "/api/read-token?lib=" + encodeURIComponent(book.lib)
      + "&id=" + encodeURIComponent(String(book.id))
      + "&f=" + encodeURIComponent(fmt) + extra;
  }

  // True when `url` is an https URL on an allowlisted host (or a
  // same-origin path, which the reader serves itself). Used for ?src=.
  function isAllowedSrcUrl(url) {
    if (typeof url !== "string" || !url) return false;
    if (url.charAt(0) === "/") return url.indexOf("//") !== 0;
    var m = /^https:\/\/([^/?#]+)/i.exec(url);
    if (!m) return false;
    var host = m[1].toLowerCase();
    for (var i = 0; i < ALLOWED_SRC_HOSTS.length; i++) {
      if (host === ALLOWED_SRC_HOSTS[i]) return true;
    }
    return false;
  }

  function fileExt(url) {
    var clean = String(url || "").split(/[?#]/)[0];
    var m = /\.([a-z0-9]+)$/i.exec(clean);
    return m ? m[1].toLowerCase() : "";
  }

  // Resolve the reader's query params to a book source.
  // Returns one of:
  //   { kind:"epub", url, title, corsRisk }   — fetch this URL
  //   { kind:"token", tokenUrl, title }       — GET tokenUrl, use its .url
  //   { kind:"unsupported", format, title }   — not an EPUB (PDF/DOC/...)
  //   { kind:"empty" }                        — no book given
  //   { kind:"error", message }               — bad params / blocked host
  // `params` is a plain object (from URLSearchParams or a test literal).
  function resolveBookSource(params) {
    params = params || {};
    var title = String(params.title || "").trim();
    var author = String(params.author || "").trim();

    if (params.demo === "1" || params.file === "home-en" || params.file === "home-ar") {
      var sample = SAMPLE_FILES[params.file] || SAMPLE_FILES["home-en"];
      return { kind: "epub", url: sample.url, title: title || sample.title, author: author, sample: true };
    }

    if (params.src) {
      var src = String(params.src);
      if (!isAllowedSrcUrl(src)) {
        return { kind: "error", message: "This book link is not from a library RliBook reads from." };
      }
      var ext = fileExt(src);
      if (ext && ext !== "epub") {
        return { kind: "unsupported", format: ext, title: title, url: src };
      }
      return { kind: "epub", url: src, title: title, author: author };
    }

    if (params.lib) {
      var lib = String(params.lib).toLowerCase();
      if (lib === "hindawi") {
        if (!/^\d+$/.test(String(params.id || ""))) {
          return { kind: "error", message: "A Hindawi book needs its number (id)." };
        }
        return { kind: "epub", url: hindawiUrl(params.id), title: title, author: author };
      }
      if (DRIVE_LIBS[lib]) {
        if (!params.id) return { kind: "error", message: "This library book needs its id." };
        // A Drive PDF/TXT opens in the plain-HTML reader instead.
        var driveFmt = String(params.f || "epub").toLowerCase();
        if (driveFmt === "pdf" || driveFmt === "txt") {
          return {
            kind: "unsupported", format: driveFmt, title: title,
            plainReaderTokenUrl: plainReaderTokenUrl({ lib: lib, id: params.id }, driveFmt),
          };
        }
        // Google Drive's download endpoint does not send CORS headers
        // for every file, so the in-browser fetch may be refused even
        // though the file itself is fine. The reader reports that
        // honestly instead of failing silently (see reader.js).
        return { kind: "epub", url: driveUrl(params.id), title: title, author: author, corsRisk: true };
      }
      if (lib === "doab") {
        if (!params.id || !isAllowedSrcUrl(String(params.id))) {
          return { kind: "error", message: "A DOAB book needs its file link." };
        }
        if (fileExt(String(params.id)) && fileExt(String(params.id)) !== "epub") {
          var doabFmt = fileExt(String(params.id));
          var doabRes = { kind: "unsupported", format: doabFmt, title: title, url: String(params.id) };
          if (doabFmt === "pdf" || doabFmt === "txt") {
            doabRes.plainReaderTokenUrl = plainReaderTokenUrl({ lib: "doab", id: String(params.id) }, doabFmt);
          }
          return doabRes;
        }
        return { kind: "epub", url: String(params.id), title: title, author: author };
      }
      if (lib === "tg") {
        var h = String(params.h || "").replace(/^@+/, "").toLowerCase();
        var p = Number(params.p);
        var f = String(params.f || "epub").toLowerCase();
        if (!h || !p) return { kind: "error", message: "A Telegram book needs its channel and post number." };
        if (f !== "epub") {
          var tgRes = { kind: "unsupported", format: f, title: title };
          if (f === "pdf" || f === "txt") {
            tgRes.plainReaderTokenUrl = plainReaderTokenUrl({ lib: "tg", h: h, p: p }, f,
              { fp: params.fp, title: title });
          }
          return tgRes;
        }
        return { kind: "token", tokenUrl: dlTokenUrl(h, p, f, { fp: params.fp, title: title }), title: title, author: author };
      }
      return { kind: "error", message: "Unknown library: " + lib };
    }

    return { kind: "empty" };
  }

  // The link the /book page (or any catalog page) puts on its
  // "Read online" button. `book` is { lib, id } or { lib:"tg", h, p, f }
  // or { src } plus optional title/author. Returns a relative URL.
  function buildReaderUrl(book) {
    book = book || {};
    var q = [];
    var add = function (k, v) {
      if (v !== undefined && v !== null && String(v) !== "") {
        q.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(v)));
      }
    };
    if (book.src) { add("src", book.src); }
    else if (book.lib === "tg") {
      add("lib", "tg"); add("h", book.h); add("p", book.p); add("f", book.f || "epub");
    } else if (book.lib) { add("lib", book.lib); add("id", book.id); }
    else if (book.demo) { add("demo", "1"); }
    add("title", book.title);
    add("author", book.author);
    return "/site/reader/?" + q.join("&");
  }

  // Warm Light: warmth 0..100 slides the overlay from pale straw to
  // deep amber; brightness 0..100 sets how strong the overlay is.
  // Returns the overlay colour + opacity and the matching page theme
  // (epub.js theme colours) so the page itself turns warm too.
  function warmLight(brightness, warmth) {
    brightness = Number(brightness);
    if (!isFinite(brightness)) brightness = 0;
    brightness = Math.max(0, Math.min(100, brightness));
    warmth = Number(warmth);
    if (!isFinite(warmth)) warmth = 50; // (0 is a real value, not "missing")
    warmth = Math.max(0, Math.min(100, warmth));
    // Interpolate #FFEFC0 (pale) -> #FF9E3D (deep amber).
    var t = warmth / 100;
    var r = 255;
    var g = Math.round(239 - (239 - 158) * t);
    var b = Math.round(192 - (192 - 61) * t);
    var overlay = "rgb(" + r + "," + g + "," + b + ")";
    var opacity = Math.round((brightness / 100) * 0.55 * 100) / 100;
    var pageBg = warmth >= 50 ? "#FFF3D6" : "#FFF9E8";
    return {
      overlayColor: overlay,
      overlayOpacity: opacity,
      pageBg: pageBg,
      pageColor: "#1C2826",
    };
  }

  // The three reader fonts (Arabic + English). "system" is the device
  // default and always works, including on the Kindle browser, where
  // the web fonts below may not load.
  var FONTS = [
    { id: "system", label: "Default", stack: "system-ui, Tahoma, sans-serif" },
    { id: "amiri", label: "Amiri", stack: '"Amiri", "Noto Naskh Arabic", serif' },
    { id: "naskh", label: "Noto Naskh Arabic", stack: '"Noto Naskh Arabic", "Amiri", serif' },
  ];

  // Kindle-style highlight colours.
  var HIGHLIGHT_COLORS = [
    { id: "yellow", label: "Yellow", color: "#FFE066" },
    { id: "green", label: "Green", color: "#B7E4C7" },
    { id: "blue", label: "Blue", color: "#A8D8EA" },
    { id: "pink", label: "Pink", color: "#FFC8DD" },
  ];

  // Stable short key for one book URL (FNV-1a, hex). Used as the
  // IndexedDB key for the book's progress, highlights and offline copy,
  // so the same book opened from two links is still the same book.
  function bookKey(url) {
    var h = 0x811c9dc5;
    var s = String(url || "");
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return "b" + ("0000000" + h.toString(16)).slice(-8);
  }

  return {
    ALLOWED_SRC_HOSTS: ALLOWED_SRC_HOSTS,
    SYNC_ENDPOINT: SYNC_ENDPOINT,
    FONTS: FONTS,
    HIGHLIGHT_COLORS: HIGHLIGHT_COLORS,
    hindawiUrl: hindawiUrl,
    driveUrl: driveUrl,
    dlTokenUrl: dlTokenUrl,
    plainReaderTokenUrl: plainReaderTokenUrl,
    isAllowedSrcUrl: isAllowedSrcUrl,
    fileExt: fileExt,
    resolveBookSource: resolveBookSource,
    buildReaderUrl: buildReaderUrl,
    warmLight: warmLight,
    bookKey: bookKey,
  };
});
