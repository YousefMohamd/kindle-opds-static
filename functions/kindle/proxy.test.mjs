// Test for the /kindle/* proxy (functions/kindle/[[...path]].js).
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
// Exit 0 = all pass; non-zero + a message = failure.
// No network, no production Worker, no deploy.

import { onRequest, rewriteKindleLinks } from "./[[...path]].js";

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

async function call(method, path) {
  const req = new Request(SITE + path, { method });
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
}

// 2. Bare /kindle and /kindle/search forward the same way.
{
  await call("GET", "/kindle");
  check("2a bare /kindle forwards", lastCall.url === WORKER + "/kindle", `url=${lastCall.url}`);
  await call("GET", "/kindle/search?fp=abc123&q=test");
  check(
    "2b search path + query forwards",
    lastCall.url === WORKER + "/kindle/search?fp=abc123&q=test",
    `url=${lastCall.url}`,
  );
}

// 3. Non-GET is 405 (and does not call the Worker).
{
  lastCall = null;
  const res = await call("POST", "/kindle/menu?fp=abc123");
  check("3a POST -> 405", res.status === 405, `status=${res.status}`);
  check("3b Worker not called on POST", lastCall === null);
}

// 4. Worker fetch failure is 502.
{
  mockMode = "throw";
  const res = await call("GET", "/kindle/menu?fp=abc123");
  check("4a Worker down -> 502", res.status === 502, `status=${res.status}`);
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
