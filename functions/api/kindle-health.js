// Cloudflare Pages Function: Kindle diagnostic canary (RliBook).
// Route: GET /api/kindle-health
//
//   GET /api/kindle-health -> 200 text/plain "ok"
//
// A plain-text, no-store, no-KV, no-D1, no-env smoke test: it lets
// the user — or a desktop curl with a Kindle UA — prove in one
// request whether the zone is still challenging Kindle traffic,
// without loading the full site. If the verification page still
// appears here, Bot Fight Mode / Browser Integrity Check is still
// armed somewhere (see docs/kindle-delivery.md §6.4). It is a
// diagnostic, not a bypass: a challenge is issued at the edge before
// any Pages Function runs, so no endpoint can avoid one while BFM
// is on. GET only; anything else is 405.

export async function onRequest(context) {
  if (context.request.method !== "GET") {
    return new Response("method_not_allowed", {
      status: 405,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  return new Response("ok", {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
