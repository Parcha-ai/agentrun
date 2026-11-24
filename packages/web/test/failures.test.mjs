// Each provider's failure typed on the receipt: its class (infra, quota, rate, error, refused, not_text), a machine code
// (the provider's own where it names one) and the message in our words. The model's answer is unchanged: the page and
// the search error carry no `failure`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { publicCheck, publicFetch, readPage } from "@parcha/pi-browser";
import * as web from "../dist/index.js";
import { dailyLimit, firecrawlServer, refusal } from "./fixtures/fake-firecrawl.mjs";
import { EXA_CANARY, exaUnread, keyedServer, refused } from "./fixtures/fake-keyed.mjs";
import { CANARY } from "./fixtures/faux-parallel.mjs";
import { network } from "./fixtures/fake-network.mjs";

const PUBLIC = "http://public.example/";
const START = Date.parse("2026-11-24T12:00:00Z");
const guardOf = (net) => ({ fetch: (url, options) => publicFetch(url, { lookup: net.lookup, fetchImpl: net.fetchImpl, ...options }), check: (url, options) => publicCheck(url, { lookup: net.lookup, ...options }), html: readPage });
const typed = (one) => one.failure && [one.failure.class, one.failure.code, one.failure.message === one.error];

test("keyed Exa: a refused key, spent credit, a rate limit, a 5xx and a page it could not read, each typed", async (t) => {
  const answer = { "/contents": refused(401, { error: "Invalid API key", tag: "INVALID_API_KEY" }) };
  const exa = await keyedServer(t, (path) => answer[path]);
  const webOf = () => web.createWeb({ order: { search: ["exa"], fetch: ["exa", "direct"] }, keys: { exa: EXA_CANARY }, endpoints: { exa: exa.url }, guard: guardOf(network()), now: () => START });
  const w = webOf();
  assert.deepEqual(typed((await w.fetch(PUBLIC)).receipt.tries[0]), ["refused", "INVALID_API_KEY", true]);
  assert.deepEqual(typed((await w.search("widgets")).receipt.tries[0]), ["refused", "KEY_REFUSED", true]);
  const cases = [
    [refused(402, { error: "out of credits" }), ["quota", "HTTP_402", true]],
    [refused(429, { error: "slow down" }, { "retry-after": "30" }), ["rate", "HTTP_429", true]],
    [refused(503, { error: "down" }), ["infra", "HTTP_503", true]],
    [exaUnread(PUBLIC), ["error", "CRAWL_NOT_FOUND", true]],
  ];
  for (const [said, expected] of cases) {
    answer["/contents"] = said;
    const page = await webOf().fetch(PUBLIC);
    assert.deepEqual(typed(page.receipt.tries[0]), expected, JSON.stringify(said.json));
    assert.equal(page.answer.via, "direct");
    assert.equal("failure" in page.answer, false, "the page carries no failure");
  }
});

test("keyed Exa with no key: refused, unsent", async () => {
  const w = web.createWeb({ order: { search: ["exa"], fetch: ["exa", "direct"] }, guard: guardOf(network()), now: () => START });
  const found = await w.search("widgets");
  assert.deepEqual(typed(found.receipt.tries[0]), ["refused", "NO_KEY", true]);
  assert.equal("failure" in found.answer, false, "the search's error carries no failure");
});

test("keyless Firecrawl: its daily limit is a quota and holds the key, so the same Web's search is held; its keyless limit a rate limit; each with its code", async (t) => {
  const fc = await firecrawlServer(t, (name) => (name === "firecrawl_scrape" ? dailyLimit("scrape") : refusal("KEYLESS_LIMIT_REACHED", { retryAfter: 30 })));
  const w = web.createWeb({ order: { search: ["firecrawl-keyless"], fetch: ["firecrawl-keyless", "direct"] }, endpoints: { "firecrawl-keyless": fc.url }, guard: guardOf(network()), now: () => START });
  assert.deepEqual(typed((await w.fetch(PUBLIC)).receipt.tries[0]), ["quota", "DAILY_LIMIT", true]);
  assert.deepEqual(typed((await w.search("widgets")).receipt.tries[0]), ["quota", "HELD", false], "the daily limit holds the key: the same Web's search is held, unsent");
  const fresh = web.createWeb({ order: { search: ["firecrawl-keyless"], fetch: ["firecrawl-keyless", "direct"] }, endpoints: { "firecrawl-keyless": fc.url }, guard: guardOf(network()), now: () => START });
  assert.deepEqual(typed((await fresh.search("widgets")).receipt.tries[0]), ["rate", "KEYLESS_LIMIT_REACHED", true]);
  assert.deepEqual(await web.firecrawlScrape(PUBLIC, { endpoint: fc.url, now: () => START }), { error: "Keyless Firecrawl will not serve this server's fetches now (its free daily limit is spent): it is not asked again before 00:00 UTC", limit: { kind: "quota", retryAfter: "Wed, 25 Nov 2026 00:00:00 GMT" } }, "the exported scrape answers as before");
});

test("Parallel: no key and spent credit on an extract, typed", async () => {
  const none = web.createWeb({ order: { search: ["parallel"], fetch: ["parallel", "direct"] }, guard: guardOf(network()), now: () => START });
  assert.deepEqual(typed((await none.fetch(PUBLIC)).receipt.tries[0]), ["refused", "NO_KEY", true]);
  const send = async () => new Response("{}", { status: 402, headers: { "content-type": "application/json" } });
  const w = web.createWeb({ order: { search: ["parallel"], fetch: ["parallel", "direct"] }, keys: { parallel: CANARY }, send: { parallel: send }, guard: guardOf(network()), now: () => START });
  const page = await w.fetch(PUBLIC);
  assert.deepEqual([typed(page.receipt.tries[0]), page.answer.parallel], [["quota", "HTTP_402", true], "out of quota for the rest of this run"]);
});

test("keyless Exa: a 429 is a rate limit, a 403 a refused connection", async () => {
  for (const [status, expected] of [[429, ["rate", "HTTP_429", true]], [403, ["refused", "CONNECTION_REFUSED", true]]]) {
    const send = async () => new Response("", { status, headers: { "retry-after": "60" } });
    const w = web.createWeb({ order: { search: ["exa-keyless"], fetch: ["direct"] }, send: { "exa-keyless": send }, guard: guardOf(network()), now: () => START });
    assert.deepEqual(typed((await w.search("widgets")).receipt.tries[0]), expected);
  }
});

test("the direct fetch: a page's status, the guard's refusal and a page that is not text, typed on the receipt alone", async () => {
  const w = web.createWeb({ order: { search: [], fetch: ["direct"] }, guard: guardOf(network()), now: () => START });
  const cases = [
    ["http://public.example/missing", ["error", "PAGE_404", false]],
    ["http://evil.example/", ["refused", "GUARD", false]],
    ["http://public.example/image.png", ["refused", "GUARD", false]],
  ];
  for (const [url, expected] of cases) {
    const page = await w.fetch(url);
    const [one] = page.receipt.tries;
    assert.deepEqual([one.failure.class, one.failure.code], expected.slice(0, 2), url);
    assert.equal(one.failure.message, page.answer.refused ?? page.answer.error, url);
    assert.equal("failure" in page.answer, false, "the page carries no failure");
  }
});
