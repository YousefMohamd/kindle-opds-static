// RliBook Reader — login (Block 11b): Google + Telegram (via the bot).
//
// APPLE LOGIN IS NOT BUILT HERE, on purpose: Apple Sign In needs a
// paid Apple Developer Program membership ($99/year) and payments are
// forbidden. Recorded in ~/workspace/blocks-open-questions.md.
//
// What "logged in" means here: a local label (name + provider) that
// unlocks Highlight and lets the reader queue highlights/progress for
// sync. There is NO account backend yet, so:
//   - Google: the ID token is decoded in the browser ONLY to read the
//     name/email; the token itself is NOT stored.
//   - Telegram: the Login Widget payload is accepted locally and marked
//     verified:false — the server MUST verify it (bot token) in
//     /api/reading-sync before any sync trusts it. See README.md.
//   - Until that endpoint exists, sync attempts get a 404 and the
//     reader says so honestly; nothing is lost, everything stays on
//     the device (see reader.js queueSync).
//
// Session: localStorage "rlibook-auth" { provider, name, id }.
// No secrets are ever written to storage, the repo, or the report.
(function () {
  "use strict";
  var KEY = "rlibook-auth";

  function cfg() {
    return window.RLIBOOK_READER_CONFIG || {};
  }

  function load() {
    try {
      var raw = window.localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function save(user) {
    try {
      if (user) window.localStorage.setItem(KEY, JSON.stringify(user));
      else window.localStorage.removeItem(KEY);
    } catch (e) { /* private mode: login lasts for this tab only */ }
  }

  var listeners = [];
  function emit(user) {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](user); } catch (e) { /* ignore */ }
    }
  }

  function setUser(user) {
    save(user);
    emit(user);
    return user;
  }

  // Decode a JWT payload without verifying (Google ID token: the
  // browser only needs the name/email to show; verification happens
  // server-side when the sync endpoint exists).
  function decodeJwt(token) {
    try {
      var parts = String(token).split(".");
      var payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      while (payload.length % 4) payload += "=";
      return JSON.parse(window.atob(payload));
    } catch (e) { return null; }
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = src; s.async = true;
      s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  // Google Identity Services. No-op with an honest note when no
  // client ID is configured (config.js).
  function initGoogle(container) {
    var c = cfg();
    if (!c.GOOGLE_CLIENT_ID) {
      if (container) {
        container.textContent = "Google login is not set up yet — use Telegram below.";
      }
      return;
    }
    if (!container) return;
    loadScript("https://accounts.google.com/gsi/client").then(function () {
      if (!window.google || !window.google.accounts) return;
      window.google.accounts.id.initialize({
        client_id: c.GOOGLE_CLIENT_ID,
        callback: function (resp) {
          var claims = decodeJwt(resp.credential);
          if (!claims) return;
          setUser({
            provider: "google",
            name: claims.name || claims.email || "Google user",
            id: "google:" + (claims.sub || ""),
            email: claims.email || "",
          });
        },
      });
      window.google.accounts.id.renderButton(container, {
        theme: "outline", size: "large", text: "signin_with",
      });
    }).catch(function () {
      container.textContent = "Google login did not load — check your connection and try again.";
    });
  }

  // Telegram Login Widget. Telegram calls window.onTelegramAuth(user)
  // with the auth payload when the user approves in the Telegram app.
  // The widget only renders when the bot's domain is set in BotFather
  // (/setdomain -> rlibook.tech); otherwise Telegram shows its own
  // error inside the widget and the bot link below stays usable.
  function initTelegram(container) {
    var c = cfg();
    if (!container) return;
    window.onTelegramAuth = function (user) {
      if (!user) return;
      setUser({
        provider: "telegram",
        name: (user.first_name || "") + (user.last_name ? " " + user.last_name : ""),
        id: "telegram:" + (user.id || ""),
        username: user.username || "",
        verified: false, // server must verify (bot token) before sync trusts this
      });
    };
    var s = document.createElement("script");
    s.src = "https://telegram.org/js/telegram-widget.js?22";
    s.async = true;
    s.setAttribute("data-telegram-login", c.BOT_USERNAME || "RliBook_bot");
    s.setAttribute("data-size", "large");
    s.setAttribute("data-onauth", "onTelegramAuth(user)");
    s.setAttribute("data-request-access", "write");
    container.appendChild(s);
  }

  function logout() { setUser(null); }

  window.RliAuth = {
    getUser: load,
    onChange: function (fn) { listeners.push(fn); },
    initGoogle: initGoogle,
    initTelegram: initTelegram,
    logout: logout,
  };
})();
