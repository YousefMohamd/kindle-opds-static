// Cloudflare Pages Function: /kindle/* proxy to the RliBook bot Worker.
// Route: GET /kindle/* (functions/kindle/[[...path]].js — catch-all
// under /kindle/, so /kindle, /kindle/, /kindle/menu, /kindle/search…
// all land here).
//
// Why a proxy: the catalog EPUB's menu links (Search / Libraries /
// Latest / My Private Books) open the "Kindle-mode" pages, which are
// Worker routes served from the bot's own origin
// (https://rlibook-bot.mohamedyou1357.workers.dev/kindle/…). The
// dictionary file opens rlibook.tech — so the user saw TWO different
// websites. The /kindle/ pages now live on rlibook.tech too, through
// this proxy, and the bot (v4.8.42) builds the catalog's menu links
// against the site instead of the Worker origin.
//
// How it works: the request path + query are forwarded verbatim to
// the Worker (the fp/q params ride along), with one extra header —
// `x-rlibook-origin: https://rlibook.tech` — so the Worker generates
// rlibook.tech links in the HTML instead of workers.dev links (the
// Worker accepts that header ONLY when it is exactly the site
// origin; the fp is still verified against KV for private books, so
// the header grants nothing). The Worker's response (status + body +
// content-type) is passed through, except that absolute Worker
// /kindle/ links inside HTML responses are rewritten to rlibook.tech
// (see rewriteKindleLinks — the Worker does not honor the header yet,
// verified live 2026-11-14, so the rewrite is what actually keeps the
// user on one website).
//
// GET only — the /kindle/ pages are read-only; anything else is 405.
// A Worker fetch failure is 502 (never a crash, never a stack trace).
// Free-tier friendly: one subrequest per page view, no KV/D1, no
// storage. No secrets, no env vars.

const WORKER_BASE = "https://rlibook-bot.mohamedyou1357.workers.dev";
const PUBLIC_ORIGIN = "https://rlibook.tech";
const WORKER_KINDLE = WORKER_BASE + "/kindle/";
const PUBLIC_KINDLE = PUBLIC_ORIGIN + "/kindle/";

// Rewrite absolute Worker /kindle/ links to the public domain, in HTML
// only. VERIFIED LIVE 2026-11-14: the Worker does NOT (yet) honor the
// x-rlibook-origin header — a /kindle/ fetch with the header still
// returns workers.dev links — so the proxy rewrites them itself instead
// of depending on the Worker. If the Worker later honors the header,
// the rewrite is a no-op (nothing left to replace). Without this, a
// tap on "Latest" / "Libraries" inside a proxied page would jump the
// user back to the Worker domain — the exact "different website"
// problem this proxy exists to fix.
export function rewriteKindleLinks(html) {
  return html.split(WORKER_KINDLE).join(PUBLIC_KINDLE);
}

export async function onRequest(context) {
  const { request } = context;
  if (request.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }
  const url = new URL(request.url);
  const target = WORKER_BASE + url.pathname + url.search;
  let res;
  try {
    res = await fetch(target, {
      headers: { "x-rlibook-origin": PUBLIC_ORIGIN },
    });
  } catch {
    return new Response("Catalog unavailable — try again later.", {
      status: 502,
    });
  }
  const headers = new Headers();
  const contentType = res.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  if (contentType && contentType.includes("text/html")) {
    return new Response(rewriteKindleLinks(await res.text()), {
      status: res.status,
      headers,
    });
  }
  return new Response(res.body, { status: res.status, headers });
}
