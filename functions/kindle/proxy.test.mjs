// Test for the /kindle/* proxy (functions/kindle/[[path]].js).
// Standalone Node script — run from the repo root:
//   node functions/kindle/proxy.test.mjs
//
// It mocks the global fetch (the Worker the proxy calls), imports the
// real Function module, and calls onRequest() over HTTP semantics.
// It asserts:
//   1. a GET /kindle/menu?fp=… forwards the path + query verbatim to
//      the Worker, with x-rlibook-origin: https://rlibook.tech,
//      and the Worker response (status + body + content-type) passes
//      through unchanged;
//   2. the bare /kindle path and a search path forward the same way;
//   3. a non-GET method is 405;
//   4. a Worker fetch failure is 502 (never a crash);
//   5. HTML responses have absolute Worker /kindle/ links rewritten to
//      rlibook.tech /kindle/ (the Worker does not honor
//      x-rlibook-origin yet — verified live 2026-11-14).
//   6. (as before) redirects + non-HTML passthrough.
//   7. NEW (Kindle delivery): the bare /kindle and /kindle/ paths
//      serve the local entry page (Kindle layout + banner for a
//      Kindle UA, standard layout + note otherwise — never a block
//      page), WITHOUT calling the Worker; proxied HTML responses
//      carry cache-control: no-store.
// Exit 0 = all pass; non-zero + a message = failure.
// No network, no production Worker, no deploy.

import { onRequest, rewriteKindleLinks, rewriteLocation, kindleEntryPage, isEReaderUA } from "./[[path]].js";

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`ok - ${name}`);
  } else {
    fail++;
    console.log(`FAIL - ${name} ${extra}`);
  }
}

const WORKER = "https://rlibook-bot.mohamedyou1357.workers.dev";
const SITE = "https://rlibook.tech";

// Mock fetch: record the call, return a canned Worker response.
let lastCall = null;
let mockMode = "ok";
globalThis.fetch = async (url, opts) => {
  lastCall = { url, headers: opts?.headers || {} };
  if (mockMode === "throw") throw new Error("network down");
  return new Response("<html>kindle menu</html>", {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
};

async function call(method, path, ua) {
  const headers = ua ? { "user-agent": ua } : {};
  const req = new Request(SITE + path, { method, headers });
  return onRequest({ request: req, env: {}, params: {} });
}

// 1. Menu page: path + query forwarded, header set, response passed through.
{
  mockMode = "ok";
  const res = await call("GET", "/kindle/menu?fp=abc123");
  check(
    "1a forwards path + query to the Worker",
    lastCall.url === WORKER + "/kindle/menu?fp=abc123",
    `url=${lastCall.url}`,
  );
  check(
    "1b sends x-rlibook-origin: https://rlibook.tech",
    lastCall.headers["x-rlibook-origin"] === SITE,
    `header=${lastCall.headers["x-rlibook-origin"]}`,
  );
  check("1c status passes through", res.status === 200, `status=${res.status}`);
  check(
    "1d body passes through",
    (await res.text()) === "<html>kindle menu</html>",
  );
  check(
    "1e content-type passes through",
    res.headers.get("content-type") === "text/html; charset=utf-8",
  );
  check(
    "1f proxied HTML carries cache-control: no-store (never cached)",
    res.headers.get("cache-control") === "no-store",
    `cache-control=${res.headers.get("cache-control")}`,
  );
}

// 2. Bare /kindle is the LOCAL entry page now (Kindle delivery —
// it no longer forwards to the Worker); /kindle/search still forwards.
{
  lastCall = null;
  const res = await call("GET", "/kindle");
  check("2a bare /kindle serves the entry page locally (Worker not called)",
    lastCall === null && res.status === 200, `status=${res.status}`);
  check("2a bare /kindle entry page has no Kindle banner without a Kindle UA",
    (await res.text()).includes("مخصصة لأجهزة Kindle"));
  await call("GET", "/kindle/search?fp=abc123&q=test");
  check(
    "2b search path + query forwards",
    lastCall.url === WORKER + "/kindle/search?fp=abc123&q=test",
    `url=${lastCall.url}`,
  );
}

// 3. Non-GET is 405 (and does not call the Worker) — an HTML page
// with a next step, not a bare error line.
{
  lastCall = null;
  const res = await call("POST", "/kindle/menu?fp=abc123");
  check("3a POST -> 405", res.status === 405, `status=${res.status}`);
  check("3b Worker not called on POST", lastCall === null);
  check("3c 405 is an HTML page with a home link",
    (await res.text()).includes('href="/"'));
}

// 4. Worker fetch failure is 502 — an HTML page with a next step.
{
  mockMode = "throw";
  const res = await call("GET", "/kindle/menu?fp=abc123");
  check("4a Worker down -> 502", res.status === 502, `status=${res.status}`);
  const body = await res.text();
  check("4b 502 is an HTML page, not a bare line",
    body.includes("<!DOCTYPE html>") && body.includes("الكتالوج غير متاح"));
  check("4c 502 has a home link (a next step)",
    body.includes('href="/"') && body.includes('href="/telegram/"'));
  mockMode = "ok";
}

// 5. HTML link rewrite: Worker /kindle/ links become rlibook.tech links.
{
  const html =
    '<a href="https://rlibook-bot.mohamedyou1357.workers.dev/kindle/latest">Latest</a>' +
    ' <a href="https://rlibook.tech">Home</a>';
  check(
    "5a rewriteKindleLinks rewrites Worker links only",
    rewriteKindleLinks(html) ===
      '<a href="https://rlibook.tech/kindle/latest">Latest</a>' +
        ' <a href="https://rlibook.tech">Home</a>',
  );
  mockMode = "ok";
  // The mocked Worker returns plain HTML without Worker links; swap the
  // mock to return a realistic Worker page and check the full round trip.
  globalThis.fetch = async (url, opts) => {
    lastCall = { url, headers: opts?.headers || {} };
    return new Response(
      '<a href="https://rlibook-bot.mohamedyou1357.workers.dev/kindle/libraries">Libs</a>',
      { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  };
  const res = await call("GET", "/kindle/menu?fp=abc123");
  check(
    "5b proxied HTML links point at rlibook.tech",
    (await res.text()) ===
      '<a href="https://rlibook.tech/kindle/libraries">Libs</a>',
  );
}

// 6. Redirects + non-HTML passthrough (Area 2 review).
{
  // A Worker 302 must keep its Location header — without it the
  // browser gets a redirect status with nowhere to go (blank page) —
  // and a workers.dev target must be rewritten to rlibook.tech.
  // (Uses /kindle/menu: the bare /kindle path is the local entry
  // page now and never reaches the Worker.)
  globalThis.fetch = async (url, opts) => {
    lastCall = { url, headers: opts?.headers || {} };
    return new Response(null, {
      status: 302,
      headers: { location: WORKER + "/kindle/menu?fp=abc123" },
    });
  };
  const res = await call("GET", "/kindle/menu");
  check("6a Worker 302 keeps its Location header",
    res.headers.get("location") === SITE + "/kindle/menu?fp=abc123",
    `location=${res.headers.get("location")}`);
  check("6b rewriteLocation leaves relative targets alone",
    rewriteLocation("/kindle/menu") === "/kindle/menu");
  check("6c rewriteLocation leaves other hosts alone",
    rewriteLocation("https://example.com/x") === "https://example.com/x");
  check("6d rewriteLocation rewrites the Worker origin only",
    rewriteLocation(WORKER + "/kindle/x") === SITE + "/kindle/x");
  // Non-HTML responses pass through unchanged (body + content-type).
  globalThis.fetch = async (url, opts) => {
    lastCall = { url, headers: opts?.headers || {} };
    return new Response('{"ok":true}', {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  };
  const res2 = await call("GET", "/kindle/data");
  check("6e non-HTML body passes through unchanged",
    (await res2.text()) === '{"ok":true}');
  check("6f non-HTML content-type passes through",
    res2.headers.get("content-type") === "application/json; charset=utf-8");
}

// 7. Entry page (Kindle delivery): bare /kindle + /kindle/ serve
// locally, Kindle layout for a Kindle UA, standard layout + note
// otherwise — never a block page, never a Worker call.
{
  const KINDLE_UA = "Mozilla/5.0 (X11; U; Linux armv7l like Android; en-us) AppleWebKit/534.24 (KHTML, like Gecko) Version/4.0 Safari/534.24 Kindle/3.0";
  const DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
  lastCall = null;
  const res = await call("GET", "/kindle", KINDLE_UA);
  check("7a Kindle UA: entry page served locally (Worker not called)",
    lastCall === null && res.status === 200, `status=${res.status}`);
  const body = await res.text();
  check("7b Kindle UA: 'you are on a Kindle' banner shown",
    body.includes("أنت على جهاز Kindle"));
  check("7c Kindle UA: search form present (GET /book)",
    body.includes('<form method="get" action="/book">'));
  check("7d Kindle UA: 4-step delivery summary present",
    body.includes("احصل على الكتاب على جهازك") && body.includes("amazon.com/sendtokindle"));
  check("7e Kindle UA: no-store", res.headers.get("cache-control") === "no-store");
  check("7f Kindle UA: no <script> (Kindle-safe, JS off)",
    !body.toLowerCase().includes("<script"));
  const res2 = await call("GET", "/kindle/", DESKTOP_UA);
  const body2 = await res2.text();
  check("7g desktop UA: same entry page, standard layout + note, no banner",
    res2.status === 200 && body2.includes("مخصصة لأجهزة Kindle")
    && !body2.includes("أنت على جهاز Kindle"));
  check("7h desktop UA: still no Worker call, still no-store",
    res2.headers.get("cache-control") === "no-store");
  const res3 = await call("POST", "/kindle", KINDLE_UA);
  check("7i POST /kindle -> 405 (method check runs before the entry page)",
    res3.status === 405, `status=${res3.status}`);
  check("7j kindleEntryPage + isEReaderUA are exported",
    typeof kindleEntryPage === "function" && typeof isEReaderUA === "function");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
