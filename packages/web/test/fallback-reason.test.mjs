// Every fallback to the guarded direct fetch carries its reason in the answer the model reads: under the id of each
// provider asked ahead of it, why it gave none, and a line after the page's JSON naming it and why. A page a provider
// behind it read carries none (said-scope.test.mjs).
// A limit is said by what holds the provider (rate-limited or out of quota, until the minute it lifts, UTC, or for the
// rest of the run), never by the provider's words for it. The server's log is as it was.
import assert from "node:assert/strict";
import { test } from "node:test";
import { publicCheck, publicFetch, readPage } from "@parcha/pi-browser";
import * as web from "../dist/index.js";
import { answers, dailyLimit, firecrawlServer, refusal } from "./fixtures/fake-firecrawl.mjs";
import { EXA_CANARY, keyedServer, refused } from "./fixtures/fake-keyed.mjs";
import { CANARY } from "./fixtures/faux-parallel.mjs";
import { network } from "./fixtures/fake-network.mjs";

const PUBLIC = "http://public.example/";
const NOTES = "http://public.example/notes.txt";
const START = Date.parse("2026-11-24T12:00:00Z");
const guardOf = (net) => ({ fetch: (url, options) => publicFetch(url, { lookup: net.lookup, fetchImpl: net.fetchImpl, ...options }), check: (url, options) => publicCheck(url, { lookup: net.lookup, ...options }), html: readPage });
const lineOf = (answer) => web.webFetchText(answer).split("\n")[1];
const turns = (receipt) => receipt.tries.map((one) => [one.provider, one.outcome]);

test("keyless Firecrawl rate-limited on a fetch: the page says until when, and so does the next, which it was not asked for", async (t) => {
  const fc = await firecrawlServer(t, (name) => (name === "firecrawl_scrape" ? refusal("KEYLESS_LIMIT_REACHED", { retryAfter: 30 }) : answers(name)));
  const logged = [];
  const w = web.createWeb({ order: { search: ["firecrawl-keyless"], fetch: ["firecrawl-keyless", "direct"] }, endpoints: { "firecrawl-keyless": fc.url }, guard: guardOf(network()), now: () => START, log: (event, fields) => logged.push([event, fields]) });
  const first = await w.fetch(PUBLIC);
  assert.deepEqual([first.answer.via, first.answer["firecrawl-keyless"]], ["direct", "rate-limited until 12:01 UTC"]);
  assert.equal(lineOf(first.answer), "keyless Firecrawl was picked for web_fetch and gave no page (rate-limited until 12:01 UTC); this one was fetched directly.");
  assert.deepEqual(turns(first.receipt), [["firecrawl-keyless", "error"], ["direct", "ok"]], "the receipt as before");
  assert.deepEqual(logged.map(([event, fields]) => [event, fields.direct]), [["web_fetch_firecrawl_failed", "read"]], "the log as before");
  assert.equal(logged[0][1].said, first.receipt.tries[0].error, "the log keeps the provider's failure in our words");

  const second = await w.fetch(NOTES);
  assert.deepEqual([second.answer.via, second.answer["firecrawl-keyless"]], ["direct", "not tried: rate-limited until 12:01 UTC"]);
  assert.equal(lineOf(second.answer), "keyless Firecrawl was picked for web_fetch and gave no page (not tried: rate-limited until 12:01 UTC); this one was fetched directly.");
  assert.deepEqual(turns(second.receipt), [["firecrawl-keyless", "held"], ["direct", "ok"]], "a held turn is on the receipt");
  assert.equal(fc.calls("firecrawl_scrape"), 1);
});

test("keyless Firecrawl's daily limit met on a search: a fetch says it is out of quota until 00:00 UTC", async (t) => {
  const fc = await firecrawlServer(t, (name) => (name === "firecrawl_search" ? dailyLimit("search") : answers(name)));
  const w = web.createWeb({ order: { search: ["firecrawl-keyless"], fetch: ["firecrawl-keyless", "direct"] }, endpoints: { "firecrawl-keyless": fc.url }, guard: guardOf(network()), now: () => START });
  await w.search("widgets");
  const page = await w.fetch(PUBLIC);
  assert.deepEqual([page.answer.via, page.answer["firecrawl-keyless"]], ["direct", "not tried: out of quota until 00:00 UTC"]);
  assert.equal(lineOf(page.answer), "keyless Firecrawl was picked for web_fetch and gave no page (not tried: out of quota until 00:00 UTC); this one was fetched directly.");
});

test("keyed Exa that gave no page: its failure in our words, on the page and in the line", async (t) => {
  const exa = await keyedServer(t, () => refused(503, { error: "down" }));
  const w = web.createWeb({ order: { search: ["exa"], fetch: ["exa", "direct"] }, keys: { exa: EXA_CANARY }, endpoints: { exa: exa.url }, guard: guardOf(network()), now: () => START });
  const page = await w.fetch(PUBLIC);
  const said = page.receipt.tries[0].error;
  assert.deepEqual([page.answer.via, page.answer.exa], ["direct", said]);
  assert.equal(lineOf(page.answer), `Exa was picked for web_fetch and gave no page (${said}); this one was fetched directly.`);
  assert.doesNotMatch(web.webFetchText(page.answer), new RegExp(EXA_CANARY), "never the key");
});

test("a page another provider read after one gave none carries no reason: the line would say it was fetched directly", async (t) => {
  const fc = await firecrawlServer(t, (name) => (name === "firecrawl_scrape" ? refusal("KEYLESS_ACCESS_NOT_AVAILABLE") : answers(name)));
  const extract = { results: [{ url: PUBLIC, title: "Read by Parallel", full_content: "The answer is forty-two." }], errors: [] };
  const send = async () => new Response(JSON.stringify(extract), { status: 200, headers: { "content-type": "application/json" } });
  const w = web.createWeb({ order: { search: [], fetch: ["firecrawl-keyless", "parallel", "direct"] }, keys: { parallel: CANARY }, send: { parallel: send }, endpoints: { "firecrawl-keyless": fc.url }, guard: guardOf(network()), now: () => START });
  const page = await w.fetch(PUBLIC);
  assert.deepEqual([page.answer.via, page.answer["firecrawl-keyless"]], ["parallel", undefined]);
  assert.equal(lineOf(page.answer), undefined);
  assert.deepEqual(turns(page.receipt), [["firecrawl-keyless", "error"], ["parallel", "ok"]], "the turn stays on the receipt");
});

test("Parallel's own line is as it was where it is not limited, and a part of the page keeps every reason", async (t) => {
  const fc = await firecrawlServer(t, (name) => (name === "firecrawl_scrape" ? refusal("KEYLESS_LIMIT_REACHED", { retryAfter: 30 }) : answers(name)));
  const w = web.createWeb({ order: { search: [], fetch: ["firecrawl-keyless", "parallel", "direct"] }, endpoints: { "firecrawl-keyless": fc.url }, guard: guardOf(network()), now: () => START });
  const page = await w.fetch(PUBLIC, { maxChars: 1_000 });
  assert.deepEqual(Object.keys(page.answer).slice(-3), ["via", "firecrawl-keyless", "parallel"], "after via, in the order asked");
  assert.deepEqual(web.webFetchText(page.answer).split("\n").slice(1, 3), [
    "keyless Firecrawl was picked for web_fetch and gave no page (rate-limited until 12:01 UTC); this one was fetched directly.",
    "Parallel was picked for web_fetch and gave no page (not tried: this run holds no Parallel key); this one was fetched directly.",
  ]);
});
