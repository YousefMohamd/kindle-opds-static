// Test for the Kindle diagnostic canary (functions/api/kindle-health.js).
// Standalone Node script — run from the repo root:
//   node functions/api/kindle-health.test.mjs
//
// It imports the real Function module and calls onRequest() over HTTP
// semantics. It asserts:
//   1. GET -> 200, body exactly "ok", content-type text/plain,
//      cache-control: no-store;
//   2. it needs no env at all (works with an empty env — no KV, no
//      D1, no secrets);
//   3. a non-GET method is 405.
// Exit 0 = all pass; non-zero = failure. No network, no deploy.

import { onRequest } from "./kindle-health.js";

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${extra ? " — " + extra : ""}`);
  }
}

{
  const res = await onRequest({
    request: new Request("https://rlibook.tech/api/kindle-health", { method: "GET" }),
    env: {},
  });
  check("1a GET -> 200", res.status === 200, "status " + res.status);
  check("1b body is exactly 'ok'", (await res.text()) === "ok");
  check("1c content-type is text/plain",
    (res.headers.get("content-type") || "").includes("text/plain"),
    res.headers.get("content-type"));
  check("1d cache-control: no-store",
    res.headers.get("cache-control") === "no-store",
    res.headers.get("cache-control"));
}

{
  // Empty env, no KV/D1/secrets anywhere: the canary must answer
  // even on a deployment where nothing else is configured — that is
  // its whole job (prove whether the zone challenges Kindle traffic).
  const res = await onRequest({
    request: new Request("https://rlibook.tech/api/kindle-health"),
    env: {},
  });
  check("2a empty env still answers 200 ok", res.status === 200 && (await res.text()) === "ok");
}

{
  const res = await onRequest({
    request: new Request("https://rlibook.tech/api/kindle-health", { method: "POST" }),
    env: {},
  });
  check("3a POST -> 405", res.status === 405, "status " + res.status);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
