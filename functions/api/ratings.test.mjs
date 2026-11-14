// Test for the ratings endpoint (functions/api/ratings.js).
// Standalone Node script — run from the repo root:
//   node functions/api/ratings.test.mjs
//
// It imports the real Function, injects a stub fetch serving canned
// Google Books / Open Library replies (no network), and asserts:
//   A. a confident Google Books match returns its rating (0-5 -> /10)
//      with source "Google Books" + its description;
//   B. a title that matches NOTHING returns rating null (never a fake 0);
//   C. Google Books with no rating falls back to Open Library;
//   D. a same-title/different-author candidate is rejected;
//   E. any upstream failure still returns 200 with nulls (degradation);
//   F. Arabic titles match through normalization (diacritics stripped).
// Exit 0 = all pass.

import { onRequest, enrich, titleMatches, authorCompatible } from "./ratings.js";

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

const GB_DUNE = {
  items: [
    {
      volumeInfo: {
        title: "Dune",
        authors: ["Frank Herbert"],
        averageRating: 4.2,
        ratingsCount: 12345,
        description: "Set on the desert planet Arrakis, Dune is the story of Paul Atreides.",
      },
    },
    // Same title, different author — must be rejected, not rated.
    {
      volumeInfo: {
        title: "Dune",
        authors: ["Somebody Else"],
        averageRating: 1.0,
        ratingsCount: 3,
        description: "A different Dune.",
      },
    },
  ],
};
const GB_NO_RATING = {
  items: [
    {
      volumeInfo: {
        title: "Obscure Book",
        authors: ["Obscure Author"],
        description: "A book nobody rated on Google Books.",
      },
    },
  ],
};
const OL_OBSCURE = {
  docs: [
    {
      title: "Obscure Book",
      author_name: ["Obscure Author"],
      ratings_average: 3.8,
      ratings_count: 57,
    },
  ],
};
const GB_ARABIC = {
  items: [
    {
      volumeInfo: {
        title: "متون طالب العلم",
        authors: ["عبد المحسن القاسم"],
        averageRating: 4.5,
        ratingsCount: 210,
        description: "متن في العلم.",
      },
    },
  ],
};

let mode = "gb-dune"; // gb-dune | gb-no-rating | gb-fail | gb-empty
let lastOlUrl = "";
function stubFetch(u) {
  const url = new URL(u);
  const jsonRes = (obj, status = 200) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { "content-type": "application/json" },
    });
  if (url.hostname.includes("googleapis.com")) {
    if (mode === "gb-fail") throw new Error("network down");
    if (mode === "gb-no-rating") return jsonRes(GB_NO_RATING);
    if (mode === "gb-empty") return jsonRes({ items: [] });
    if (url.searchParams.get("q") && url.searchParams.get("q").includes("Obscure")) {
      return jsonRes(GB_NO_RATING);
    }
    const qNorm = (url.searchParams.get("q") || "")
      .normalize("NFKD").replace(/[\u064B-\u0652\u0670\u0640]/g, "");
    if (qNorm.includes("متون")) {
      return jsonRes(GB_ARABIC);
    }
    return jsonRes(GB_DUNE);
  }
  if (url.hostname.includes("openlibrary.org")) {
    lastOlUrl = u;
    return jsonRes(OL_OBSCURE);
  }
  throw new Error("unexpected fetch: " + u);
}

async function getRatings(title, author = "") {
  const res = await onRequest({
    request: new Request(
      "https://rlibook.tech/api/ratings?title=" + encodeURIComponent(title)
      + (author ? "&author=" + encodeURIComponent(author) : ""),
    ),
    env: {},
  });
  // onRequest uses global fetch; point it at the stub for this test.
  return { status: res.status, body: await res.text() };
}

// onRequest calls the global fetch, so swap it for the stub.
const realFetch = globalThis.fetch;
globalThis.fetch = stubFetch;

console.log("A. Google Books match:");
mode = "gb-dune";
{
  const r = await getRatings("Dune", "Frank Herbert");
  const b = JSON.parse(r.body);
  check("A1 200 + ok", r.status === 200 && b.ok === true);
  check("A1 rating 4.2/5 -> 8.4/10", b.rating && b.rating.value === 8.4,
    JSON.stringify(b.rating));
  check("A1 rating count + source", b.rating && b.rating.count === 12345
    && b.rating.source === "Google Books");
  check("A1 description from Google Books",
    b.description && b.description.text.includes("Arrakis")
    && b.description.source === "Google Books");
}
{
  const e = await enrich("Dune", "Frank Herbert", stubFetch);
  check("A2 enrich() same result", e.rating && e.rating.value === 8.4);
}

console.log("B. No match -> no rating (never a fake 0):");
mode = "gb-empty";
{
  const r = await getRatings("A Book That Does Not Exist Anywhere");
  const b = JSON.parse(r.body);
  check("B1 200 + rating null", r.status === 200 && b.rating === null,
    r.body);
  check("B1 no 0/10 anywhere in the body", !r.body.includes("0"));
  check("B1 description null", b.description === null);
}

console.log("C. Google Books has no rating -> Open Library fallback:");
mode = "gb-no-rating";
{
  const r = await getRatings("Obscure Book", "Obscure Author");
  const b = JSON.parse(r.body);
  check("C1 rating from Open Library (3.8/5 -> 7.6/10)",
    b.rating && b.rating.value === 7.6 && b.rating.source === "Open Library",
    JSON.stringify(b.rating));
  check("C1 count 57", b.rating && b.rating.count === 57);
  check("C1 description still from Google Books",
    b.description && b.description.text.includes("nobody rated"));
  check("C1 Open Library request asks for the rating fields (without"
    + " fields= the API omits them — verified live 2026-11-14)",
    lastOlUrl.includes("fields=")
    && lastOlUrl.includes("ratings_average")
    && lastOlUrl.includes("ratings_count"), lastOlUrl);
}

console.log("D. Title/author matching guards:");
{
  check("D1 same title, different author rejected",
    authorCompatible(["Somebody Else"], "Frank Herbert") === false);
  check("D1 matching author accepted",
    authorCompatible(["Frank Herbert"], "Frank Herbert") === true);
  check("D1 no author given -> no check",
    authorCompatible(["Anyone"], "") === true);
  check("D1 title substring matches", titleMatches("Dune", "Dune") === true);
  check("D1 different book in the same series does not match",
    titleMatches("Dune Messiah", "Dune") === false);
  check("D1 same book with an edition qualifier matches",
    titleMatches("Dune: Deluxe Edition", "Dune") === true);
  check("D1 unrelated title does not match",
    titleMatches("Foundation", "Dune") === false);
  check("D1 short title never matches", titleMatches("It", "It") === false);
}

console.log("E. Upstream failure degrades to nulls:");
mode = "gb-fail";
{
  // Google fails AND Open Library stub still answers, but for Dune the
  // OL stub returns only the Obscure doc -> no match -> nulls.
  const r = await getRatings("Dune", "Frank Herbert");
  const b = JSON.parse(r.body);
  check("E1 still 200 with nulls", r.status === 200 && b.rating === null
    && b.description === null, r.body);
}

console.log("F. Arabic normalization:");
mode = "gb-dune";
{
  const e = await enrich("مُتَوِّنُ طَالِبِ الْعِلْمِ", "", stubFetch);
  check("F1 diacritics-stripped title matches + rates 9.0/10",
    e.rating && e.rating.value === 9.0 && e.rating.source === "Google Books",
    JSON.stringify(e.rating));
  check("F1 titleMatches across diacritics",
    titleMatches("متون طالب العلم", "مُتَوِّنُ طَالِبِ الْعِلْمِ") === true);
}

console.log("G. Empty title:");
{
  const r = await getRatings("");
  const b = JSON.parse(r.body);
  check("G1 empty title -> 200, nulls", r.status === 200 && b.rating === null
    && b.description === null);
}

globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
