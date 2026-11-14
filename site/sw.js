// RliBook service worker — Block 6 (PWA / offline).
//
// SCOPE NOTE: this file lives at /site/sw.js, so it only controls
// /site/* (the reader, the Telegram section, the newspapers page).
// That is where the offline reader lives. A whole-site worker at
// /sw.js would need a file at the repo root, which is outside this
// block's ownership — see README.md / blocks-open-questions.md.
// The home page (index.html, another owner) should add the same
// registration + manifest link when it is ready.
//
// Strategy — simple and safe:
//   * App shell (reader page, JS/CSS, vendored epub.js, icons, the
//     sample book, web fonts): cache-first. The reader must open
//     with no internet.
//   * Book files fetched while reading: network-first, then the cache
//     (a book opened once stays readable offline; the reader ALSO
//     keeps its own copy in IndexedDB — the cache here is a backup).
//   * Everything else (/api/*, /book, search indexes): network-only,
//     never cached — a stale search result or an old download token
//     would be worse than no result.
//   * Navigation under /site/reader/ with no network: the cached
//     reader page, so the app still opens offline.
//
// No book file is ever uploaded anywhere by this worker. Version the
// cache name (CACHE_VERSION) whenever a shell file changes.
var CACHE_VERSION = "rlibook-v1";
var SHELL_CACHE = CACHE_VERSION + "-shell";
var BOOKS_CACHE = CACHE_VERSION + "-books";

var SHELL_URLS = [
  "/site/reader/",
  "/site/reader/index.html",
  "/site/reader/reader.css",
  "/site/reader/reader.js",
  "/site/reader/reader-lib.js",
  "/site/reader/auth.js",
  "/site/reader/config.js",
  "/site/reader/vendor/jszip.min.js",
  "/site/reader/vendor/epub.min.js",
  "/site/manifest.webmanifest",
  "/site/icons/icon-192.png",
  "/site/icons/icon-512.png",
  "/site/icons/icon-512-maskable.png",
  "/site/icons/apple-touch-icon.png",
  "/site/icons/logo-1024.jpg",
  "/files/RliBook-Home-en.epub",
  "/files/RliBook-Home-ar.epub",
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(function (cache) {
      return cache.addAll(SHELL_URLS);
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        if (key !== SHELL_CACHE && key !== BOOKS_CACHE) {
          return caches.delete(key);
        }
        return undefined;
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

function isShellRequest(url) {
  if (url.origin !== self.location.origin) {
    // Web fonts (Google Fonts) are shell too: cache-first, opaque.
    return url.hostname === "fonts.googleapis.com"
      || url.hostname === "fonts.gstatic.com"
      || url.hostname === "api.fontshare.com";
  }
  var path = url.pathname;
  return path.indexOf("/site/reader/") === 0
    || path.indexOf("/site/icons/") === 0
    || path === "/site/manifest.webmanifest"
    || path === "/files/RliBook-Home-en.epub"
    || path === "/files/RliBook-Home-ar.epub";
}

function isBookRequest(url) {
  // Book files: same-origin EPUBs, or a file from an allowlisted
  // library host (Hindawi / Drive / the Block 2 proxy).
  if (url.pathname.toLowerCase().indexOf(".epub") !== -1) return true;
  return url.hostname === "www.hindawi.org"
    || url.hostname === "www.safahat.org"
    || url.hostname === "drive.google.com"
    || url.hostname === "rlibook-download.injectcloud.space";
}

self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);

  // Never cache API calls, the book search page, or search indexes.
  if (url.pathname.indexOf("/api/") === 0
    || url.pathname === "/book"
    || url.pathname.indexOf("/search-index.json") !== -1) {
    return; // network-only: fall through to the browser default
  }

  if (isShellRequest(url)) {
    // Cache-first for the app shell.
    event.respondWith(
      caches.match(req, { ignoreSearch: url.pathname === "/site/reader/" }).then(function (cached) {
        if (cached) return cached;
        return fetch(req).then(function (res) {
          if (res && (res.ok || res.type === "opaque")) {
            var copy = res.clone();
            caches.open(SHELL_CACHE).then(function (cache) { cache.put(req, copy); });
          }
          return res;
        });
      }).catch(function () {
        if (req.mode === "navigate") return caches.match("/site/reader/index.html");
        return undefined;
      })
    );
    return;
  }

  if (isBookRequest(url)) {
    // Network-first for book content, cache fallback when offline.
    event.respondWith(
      fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(BOOKS_CACHE).then(function (cache) { cache.put(req, copy); });
        }
        return res;
      }).catch(function () {
        return caches.match(req);
      })
    );
    return;
  }

  if (req.mode === "navigate" && url.pathname.indexOf("/site/reader/") === 0) {
    event.respondWith(
      fetch(req).catch(function () { return caches.match("/site/reader/index.html"); })
    );
  }
});
