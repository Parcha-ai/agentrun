// Exa on the run's key, through createWeb: Search for web_search, Contents for web_fetch, each request paid at Exa's list
// price, its settings typed with defaults, its refusals read by status for the run's breaker. Exa is a fake HTTP server on
// loopback (fixtures/fake-keyed.mjs), the network a table: no socket leaves the machine, and the key is a canary.
import assert from "node:assert/strict";
import { test } from "node:test";
import { publicCheck, publicFetch, readPage } from "@parcha/pi-browser";
import * as web from "../dist/index.js";
import { EXA_CANARY, EXA_HITS, exaPage, exaResults, exaUnread, keyedServer, ok, refused } from "./fixtures/fake-keyed.mjs";
import { network } from "./fixtures/fake-network.mjs";

const PUBLIC = "http://public.example/";
const NOTES = "http://public.example/notes.txt";
const EVIL = "http://evil.example/";
const START = Date.parse("2026-11-24T12:00:00Z");

/** A Web on a fake Exa answering as `answer` says, with its fees, log lines and clock; `key` null: the run holds none. */
async function exaWeb(t, answer, { settings, order = { search: ["exa"], fetch: ["exa"] }, key = EXA_CANARY } = {}) {
  const exa = await keyedServer(t, answer);
  const net = network();
  const clock = { now: START };
  const fees = [];
  const logs = [];
  const guard = { fetch: (url, options) => publicFetch(url, { lookup: net.lookup, fetchImpl: net.fetchImpl, ...options }), check: (url, options) => publicCheck(url, { lookup: net.lookup, ...options }), html: readPage };
  const w = web.createWeb({ order, ...(key ? { keys: { exa: key } } : {}), ...(settings ? { settings: { exa: settings } } : {}), endpoints: { exa: exa.url }, guard, pay: async (fee, send) => (fees.push(fee), send()), now: () => clock.now, log: (event, fields) => logs.push([event, fields]) });
  return { exa, w, clock, fees, logs };
}

/** Fails when the key reaches anything a call hands back or logs. */
const keyless = (label, ...said) => assert.ok(!JSON.stringify(said).includes(EXA_CANARY), `${label}: the key is never handed back`);

test("a search is one paid request to Exa's /search on the run's key: auto, the n asked, each result's highlights to 3,000 characters; the hits in the one search shape", async (t) => {
  const { exa, w, fees, logs } = await exaWeb(t, () => exaResults(EXA_HITS));
  const { answer, receipt } = await w.search(" widgets ", { n: 3 });
  assert.equal(exa.got.length, 1);
  assert.equal(exa.got[0].path, "/search");
  assert.equal(exa.got[0].headers["x-api-key"], EXA_CANARY);
  assert.deepEqual(exa.got[0].body, { query: "widgets", type: "auto", numResults: 3, contents: { highlights: { maxCharacters: 3_000 } } });
  assert.deepEqual(answer, { provider: "exa", objective: "widgets", queries: ["widgets"], results: [
    { url: "https://first.example/widgets", title: "Widgets, explained", snippet: "Widgets are small parts. … They fit together.", published: "2026-11-01T00:00:00.000Z" },
    { url: "https://second.example/gadgets", title: "Gadgets", snippet: "A second result." },
  ] }, "highlights joined, links as their text, a hit with no URL dropped");
  assert.deepEqual([receipt.provider, receipt.tries.map((one) => [one.provider, one.outcome])], ["exa", [["exa", "ok"]]]);
  assert.deepEqual(fees.map((fee) => [fee.name, fee.by, fee.usd]), [["Exa's search", "exa", 0.007]], "$0.007 an auto search, its highlights in that price");
  assert.equal(receipt.cost.usd, 0.007);
  keyless("search", answer, receipt, logs);
});

test("Exa's settings shape the request and its fee: type, text or highlights and their length, freshness, domains, category", async (t) => {
  const rows = [{ url: "https://first.example/widgets", title: "Widgets", text: "Whole   text of the page." }];
  const { exa, w, fees } = await exaWeb(t, () => exaResults(rows), { settings: { type: "instant", snippet: "text", snippetChars: 500, maxAgeHours: 24, includeDomains: ["first.example"], excludeDomains: ["spam.example"], category: "news" } });
  const { answer } = await w.search("widgets");
  assert.deepEqual(exa.got[0].body, { query: "widgets", type: "instant", numResults: 10, includeDomains: ["first.example"], excludeDomains: ["spam.example"], category: "news", contents: { text: { maxCharacters: 500 }, maxAgeHours: 24 } });
  assert.deepEqual(answer.results, [{ url: "https://first.example/widgets", title: "Widgets", snippet: "Whole text of the page." }]);
  assert.deepEqual(fees.map((fee) => fee.usd), [0.004], "$0.004 an instant search, its text in that price");
});

test("settings Exa does not take are refused when the Web is made, never sent", () => {
  for (const exa of [{ type: "turbo" }, { snippet: "summary" }, { snippetChars: 50 }, { snippetChars: 3_001 }, { maxAgeHours: 721 }, { includeDomains: "first.example" }, { category: "blogs" }, { pageVerbosity: "loud" }, { bogus: 1 }]) {
    assert.throws(() => web.createWeb({ order: { search: ["exa"], fetch: [] }, keys: { exa: EXA_CANARY }, settings: { exa } }), /Exa/, JSON.stringify(exa));
  }
});

test("Exa's limits, read by status: a 429 holds it for its Retry-After, a 402 (credit spent) turns it off for the run, unasked", async (t) => {
  const { exa, w, clock } = await exaWeb(t, (_path, _body, n) => (n === 1 ? refused(429, { error: "rate limit", tag: "RATE_LIMIT" }, { "retry-after": "30" }) : n === 2 ? refused(402, { error: "out of credits", tag: "NO_MORE_CREDITS" }) : exaResults(EXA_HITS)));
  const first = await w.search("widgets");
  assert.deepEqual(first.receipt.tries.map((one) => [one.provider, one.outcome, one.limit]), [["exa", "error", { kind: "rate", retryAfter: "30" }]]);
  clock.now += 10_000;
  const held = await w.search("gadgets");
  assert.deepEqual(held.receipt.tries.map((one) => [one.provider, one.outcome]), [["exa", "held"]]);
  assert.equal(exa.got.length, 1, "unasked within the wait");
  clock.now += 21_000;
  const spent = await w.search("gadgets");
  assert.deepEqual(spent.receipt.tries.map((one) => [one.provider, one.outcome, one.limit]), [["exa", "error", { kind: "quota" }]]);
  clock.now += 3_600_000;
  const off = await w.search("sprockets");
  assert.deepEqual(off.answer, { error: web.SEARCH_UNAVAILABLE });
  assert.equal(exa.got.length, 2, "off for the run");
});

test("a 401 says the run's key is refused, and Exa is not asked again by either tool", async (t) => {
  const { exa, w, logs } = await exaWeb(t, () => refused(401, { error: "Invalid API key", tag: "INVALID_API_KEY" }), { order: { search: ["exa"], fetch: ["exa", "direct"] } });
  const first = await w.search("widgets");
  assert.match(first.answer.error, /Exa refused this run's key \(401\)/);
  const again = await w.search("gadgets");
  assert.match(again.answer.error, /Exa refused this run's key/);
  const page = await w.fetch(PUBLIC);
  assert.deepEqual([page.answer.via, page.receipt.tries.map((one) => [one.provider, one.outcome])], ["direct", [["direct", "ok"]]]);
  assert.equal(exa.got.length, 1);
  keyless("401", first, again, page, logs);
});

test("no Exa key: the search says so, unsent; the fetch's turn says so, unsent", async (t) => {
  const { exa, w } = await exaWeb(t, () => exaResults(EXA_HITS), { key: null, order: { search: ["exa"], fetch: ["exa", "direct"] } });
  const { answer } = await w.search("widgets");
  assert.match(answer.error, /no Exa key \(EXA_API_KEY\)/);
  const page = await w.fetch(PUBLIC);
  assert.deepEqual(page.receipt.tries.map((one) => [one.provider, one.outcome]), [["exa", "error"], ["direct", "ok"]]);
  assert.match(page.receipt.tries[0].error, /no Exa key/);
  assert.equal(exa.got.length, 0);
});

test("a fetch is one paid request to Exa's /contents: the page's text to the most web_fetch reads, compact, links kept; read once a run", async (t) => {
  const text = "# Read by Exa\n\nThe answer is forty-two. See [the registry](https://registry.example/1).";
  const { exa, w, fees } = await exaWeb(t, (path, body) => (path === "/contents" ? exaPage(body.urls[0], text) : undefined));
  const first = await w.fetch(PUBLIC);
  assert.equal(exa.got[0].path, "/contents");
  assert.equal(exa.got[0].headers["x-api-key"], EXA_CANARY);
  assert.deepEqual(exa.got[0].body, { urls: [PUBLIC], text: { maxCharacters: 1_000_001, verbosity: "compact", linkStyle: "full" } });
  assert.deepEqual([first.answer.ok, first.answer.via, first.answer.title, first.answer.text, first.answer.links], [true, "exa", "Read by Exa", text, ["https://registry.example/1"]]);
  assert.deepEqual([first.receipt.provider, first.receipt.tries.map((one) => [one.provider, one.outcome]), first.receipt.cost.usd], ["exa", [["exa", "ok"]], 0.001]);
  assert.deepEqual(fees.map((fee) => [fee.name, fee.usd]), [["Exa's contents", 0.001]]);
  const again = await w.fetch(PUBLIC, { offset: 10 });
  assert.equal(again.receipt.cache, "hit");
  assert.equal(exa.got.length, 1, "the page is read once a run");
});

test("Exa's fetch settings: freshness, verbosity and links shape the request", async (t) => {
  const { exa, w } = await exaWeb(t, (_path, body) => exaPage(body.urls[0], "Fresh text."), { settings: { maxAgeHours: 0, pageVerbosity: "standard", pageLinks: false } });
  await w.fetch(PUBLIC);
  assert.deepEqual(exa.got[0].body, { urls: [PUBLIC], text: { maxCharacters: 1_000_001, verbosity: "standard" }, maxAgeHours: 0 });
});

test("a page Exa could not read is a failed turn naming its tag; the direct fetch behind it reads the page; a 402 keeps Exa unasked after", async (t) => {
  const { exa, w } = await exaWeb(t, (_path, body, n) => (n === 1 ? exaUnread(body.urls[0]) : n === 2 ? refused(402, { error: "out of credits" }) : exaPage(body.urls[0], "late")), { order: { search: [], fetch: ["exa", "direct"] } });
  const first = await w.fetch(PUBLIC);
  assert.deepEqual([first.answer.via, first.receipt.tries.map((one) => [one.provider, one.outcome])], ["direct", [["exa", "error"], ["direct", "ok"]]]);
  assert.match(first.receipt.tries[0].error, /CRAWL_NOT_FOUND/);
  const second = await w.fetch(NOTES);
  assert.deepEqual(second.receipt.tries.map((one) => [one.provider, one.outcome, one.limit]), [["exa", "error", { kind: "quota" }], ["direct", "ok", undefined]]);
  const third = await w.fetch(`${PUBLIC}?run=a`);
  assert.deepEqual(third.receipt.tries.map((one) => [one.provider, one.outcome, one.failure?.code]), [["exa", "held", "HELD"], ["direct", "ok", undefined]], "a held turn is on the receipt, as search's is");
  assert.equal(exa.got.length, 2, "off for the run after its credit ran out");
});

test("Exa alone in the fetch order: a page it could not read is no page, the turn says why; a URL the guard refuses never goes", async (t) => {
  const { exa, w } = await exaWeb(t, (_path, body) => exaUnread(body.urls[0], "SOURCE_NOT_AVAILABLE", 403), { order: { search: [], fetch: ["exa"] } });
  const page = await w.fetch(PUBLIC);
  assert.deepEqual([page.answer.ok, page.answer.via, page.receipt.provider, page.receipt.tries.map((one) => [one.provider, one.outcome])], [false, "none", null, [["exa", "error"]]]);
  const evil = await w.fetch(EVIL);
  assert.equal(evil.answer.ok, false);
  assert.equal(exa.got.length, 1, "the private host never reached Exa");
});

// Exa names the URL it read, and its read cuts that url at URL_MAX. A password running past the cut leaves no "@" for a
// later scrub to find, and the cut url no longer parses: Exa's read clears them before its cut.
test("Exa's page url whose password runs past where a url is cut: the page web_fetch returns names it without any part of them", async (t) => {
  // Synthetic, built in code: a user name and a password padded past the cut.
  const at = new URL(`${PUBLIC}landed`);
  at.username = "web-user";
  at.password = `not-a-secret${"x".repeat(web.URL_MAX)}`;
  const landed = at.href;
  assert.ok(landed.indexOf("not-a-secret") < web.URL_MAX && landed.indexOf("@") > web.URL_MAX, "the cut of the url ends inside them");
  const { w, logs } = await exaWeb(t, (path) => (path === "/contents" ? exaPage(landed, "Read after a redirect.") : undefined), { order: { search: [], fetch: ["exa", "direct"] } });
  const { answer, receipt } = await w.fetch(PUBLIC);
  assert.deepEqual([answer.ok, answer.via], [true, "exa"], "Exa read the page");
  const where = { "exa: the receipt turns": receipt.tries, "exa: the page": answer, "exa: the text the model reads": receipt.out, "exa: the log": logs };
  const leaks = Object.entries(where).filter(([, what]) => /web-user|not-a-secr/.test(typeof what === "string" ? what : JSON.stringify(what))).map(([name]) => name);
  assert.deepEqual(leaks, [], `no part of them in: ${leaks.join("; ")}`);
  assert.equal(answer.url, `${PUBLIC}landed`, "the page's url, without them");
});

test("Exa's answer of something other than its results is a failed turn, never thrown", async (t) => {
  const { w } = await exaWeb(t, () => ok({ unexpected: true }));
  const { answer, receipt } = await w.search("widgets");
  assert.match(answer.error, /Exa's search answered no results/);
  assert.deepEqual(receipt.tries.map((one) => one.outcome), ["error"]);
});
