// What one tool's failure holds of the other, per provider, through createWeb. A key the provider refused (401, or 403
// where the provider means the key by it) is refused for both tools: they share the run's one client. A rate limit
// holds only the tool that met it: web_search's breaker and web_fetch's are each the tool's own. Parallel's extract
// answers a rate limit as a failed read, which holds nothing. A quota's scope is quota-scope.test.mjs's.
import assert from "node:assert/strict";
import { test } from "node:test";
import { publicCheck, publicFetch, readPage } from "@parcha/pi-browser";
import * as web from "../dist/index.js";
import { answers, firecrawlServer, refusal } from "./fixtures/fake-firecrawl.mjs";
import { EXA_CANARY, EXA_HITS, exaPage, exaResults, keyedServer, refused } from "./fixtures/fake-keyed.mjs";
import { CANARY } from "./fixtures/faux-parallel.mjs";
import { network } from "./fixtures/fake-network.mjs";

const PUBLIC = "http://public.example/";
const NOTES = "http://public.example/notes.txt";
const START = Date.parse("2026-11-24T12:00:00Z");

const guardOf = (net) => ({ fetch: (url, options) => publicFetch(url, { lookup: net.lookup, fetchImpl: net.fetchImpl, ...options }), check: (url, options) => publicCheck(url, { lookup: net.lookup, ...options }), html: readPage });

/** A Web on a fake keyed Exa answering by path as `answer` says. */
async function exaWeb(t, answer) {
  const exa = await keyedServer(t, answer);
  const clock = { now: START };
  const w = web.createWeb({ order: { search: ["exa"], fetch: ["exa", "direct"] }, keys: { exa: EXA_CANARY }, endpoints: { exa: exa.url }, guard: guardOf(network()), now: () => clock.now });
  return { exa, w, clock };
}

test("keyed Exa: a key refused on a fetch is refused for search too, unsent", async (t) => {
  const { exa, w } = await exaWeb(t, () => refused(401, { error: "Invalid API key", tag: "INVALID_API_KEY" }));
  const page = await w.fetch(PUBLIC);
  assert.deepEqual([page.answer.via, page.receipt.tries.map((one) => [one.provider, one.outcome])], ["direct", [["exa", "error"], ["direct", "ok"]]]);
  const found = await w.search("widgets");
  assert.match(found.answer.error, /Exa refused this run's key/);
  assert.deepEqual(exa.got.map((one) => one.path), ["/contents"], "search never sent");
});

test("keyed Exa: a rate limit on a fetch holds web_fetch alone, and one on a search web_search alone", async (t) => {
  const { exa, w, clock } = await exaWeb(t, (path, body) => (path === "/contents" ? (exa.calls("/contents") === 1 ? refused(429, { error: "slow down" }, { "retry-after": "30" }) : exaPage(body.urls[0], "Read.")) : exa.calls("/search") === 1 ? exaResults(EXA_HITS) : refused(429, { error: "slow down" }, { "retry-after": "30" })));
  const limited = await w.fetch(PUBLIC);
  assert.deepEqual(limited.receipt.tries.map((one) => [one.provider, one.outcome, one.limit]), [["exa", "error", { kind: "rate", retryAfter: "30" }], ["direct", "ok", undefined]]);
  assert.equal((await w.search("widgets")).answer.provider, "exa", "search is asked within fetch's wait");
  const held = await w.fetch(NOTES);
  assert.deepEqual(held.receipt.tries.map((one) => [one.provider, one.outcome]), [["exa", "held"], ["direct", "ok"]], "fetch waits");
  const searchLimited = await w.search("gadgets");
  assert.deepEqual(searchLimited.receipt.tries.map((one) => [one.outcome, one.limit]), [["error", { kind: "rate", retryAfter: "30" }]]);
  clock.now += 31_000;
  assert.equal((await w.fetch(`${PUBLIC}?again`)).answer.via, "exa", "past its wait fetch is asked again");
  assert.deepEqual(exa.got.map((one) => one.path), ["/contents", "/search", "/search", "/contents"]);
});

/** A fake Parallel: each request to `path` answered by `answer(path, n)` (n counted per path), every request kept. */
function parallelSend(answer) {
  const got = [];
  const send = async (url) => {
    const path = new URL(url).pathname;
    got.push(path);
    const said = answer(path, got.filter((one) => one === path).length);
    return new Response(JSON.stringify(said.json ?? {}), { status: said.status ?? 200, headers: { "content-type": "application/json", ...said.headers } });
  };
  return { send, got };
}
const parallelPage = { json: { results: [{ url: PUBLIC, title: "Read by Parallel", full_content: "The answer is forty-two." }], errors: [] } };
const parallelHits = { json: { results: [{ url: "https://first.example/widgets", title: "Widgets", excerpts: ["Widgets."] }] } };

const parallelWeb = (send) => web.createWeb({ order: { search: ["parallel"], fetch: ["parallel", "direct"] }, keys: { parallel: CANARY }, send: { parallel: send }, guard: guardOf(network()), now: () => START });

test("Parallel: a key refused on a fetch is refused for search too, unsent; one refused on a search is not tried for a fetch, and the page says so", async () => {
  const fetchFirst = parallelSend(() => ({ status: 401 }));
  const w = parallelWeb(fetchFirst.send);
  const page = await w.fetch(PUBLIC);
  assert.deepEqual([page.answer.via, page.answer.parallel], ["direct", "refused the key (401)"]);
  assert.match((await w.search("widgets")).answer.error, /Parallel refused this run's key/);
  assert.deepEqual(fetchFirst.got, ["/v1/extract"], "search never sent");
  const searchFirst = parallelSend(() => ({ status: 403 }));
  const v = parallelWeb(searchFirst.send);
  assert.match((await v.search("widgets")).answer.error, /Parallel refused this run's key/);
  const after = await v.fetch(PUBLIC);
  assert.deepEqual([after.answer.via, after.answer.parallel], ["direct", "not tried: refused earlier in this run"]);
  assert.deepEqual(searchFirst.got, ["/v1/search"], "extract never sent");
});

test("Parallel: a rate limit on an extract holds nothing, and one on a search holds web_search alone", async () => {
  const { send, got } = parallelSend((path, n) => (path === "/v1/extract" ? (n === 1 ? { status: 429, headers: { "retry-after": "60" } } : parallelPage) : n === 1 ? parallelHits : { status: 429, headers: { "retry-after": "60" } }));
  const w = parallelWeb(send);
  assert.deepEqual([(await w.fetch(PUBLIC)).answer.parallel], ["answered 429"]);
  assert.equal((await w.search("widgets")).answer.provider, "parallel", "search is asked after extract's rate limit");
  assert.equal((await w.fetch(NOTES)).answer.via, "parallel", "and extract again too");
  assert.match((await w.search("gadgets")).answer.error, /Parallel's search answered 429/);
  assert.match((await w.search("sprockets")).answer.error, /^search is busy/, "search waits");
  assert.equal((await w.fetch(`${PUBLIC}?again`)).answer.via, "parallel", "extract is still asked");
  assert.deepEqual(got, ["/v1/extract", "/v1/search", "/v1/extract", "/v1/search", "/v1/extract"]);
});

test("keyless Firecrawl: its keyless rate limit met on a fetch holds web_fetch for its wait; web_search is still asked", async (t) => {
  let limited = true;
  const fc = await firecrawlServer(t, (name) => (limited && name === "firecrawl_scrape" ? refusal("KEYLESS_LIMIT_REACHED", { retryAfter: 30 }) : answers(name)));
  let now = START;
  const w = web.createWeb({ order: { search: ["firecrawl-keyless"], fetch: ["firecrawl-keyless", "direct"] }, endpoints: { "firecrawl-keyless": fc.url }, guard: guardOf(network()), now: () => now });
  const first = await w.fetch(PUBLIC);
  assert.deepEqual(first.receipt.tries.map((one) => [one.provider, one.outcome]), [["firecrawl-keyless", "error"], ["direct", "ok"]]);
  assert.equal((await w.search("widgets")).answer.provider, "firecrawl-keyless", "search is asked within fetch's wait");
  limited = false;
  assert.equal((await w.fetch(NOTES)).answer.via, "direct", "fetch waits");
  assert.equal(fc.calls("firecrawl_scrape"), 1);
  now += 31_000;
  assert.equal((await w.fetch(`${PUBLIC}?again`)).answer.via, "firecrawl-keyless", "asked again past its wait");
});
