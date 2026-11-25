// What a quota holds, per provider, through createWeb: one of the whole key (a 402, the key's credit spent, on keyed Exa,
// keyed Firecrawl or Parallel; keyless Firecrawl's daily limit, the host's allowance) holds both tools, unsent, until it
// lifts; a rate limit holds only the tool that met it (breaker-scope.test.mjs). A call given its own breakers keeps a
// key's quota in them, unless it asks for the Web's (keyLimits "web", serve's agent tool).
import assert from "node:assert/strict";
import { test } from "node:test";
import { publicCheck, publicFetch, readPage } from "@parcha/pi-browser";
import * as web from "../dist/index.js";
import { SEARCH_UNAVAILABLE } from "../dist/search.js";
import { answers, dailyLimit, firecrawlServer } from "./fixtures/fake-firecrawl.mjs";
import { EXA_CANARY, EXA_HITS, exaPage, exaResults, FIRECRAWL_CANARY, firecrawlPage, keyedServer, refused } from "./fixtures/fake-keyed.mjs";
import { CANARY } from "./fixtures/faux-parallel.mjs";
import { network } from "./fixtures/fake-network.mjs";

const PUBLIC = "http://public.example/";
const NOTES = "http://public.example/notes.txt";
const START = Date.parse("2026-11-24T12:00:00Z");
const guardOf = (net) => ({ fetch: (url, options) => publicFetch(url, { lookup: net.lookup, fetchImpl: net.fetchImpl, ...options }), check: (url, options) => publicCheck(url, { lookup: net.lookup, ...options }), html: readPage });

test("keyed Exa: credit spent on a fetch holds web_search too, unsent; spent on a search, web_fetch", async (t) => {
  const fetchFirst = await keyedServer(t, (path) => (path === "/contents" ? refused(402, { error: "out of credits" }) : exaResults(EXA_HITS)));
  const w = web.createWeb({ order: { search: ["exa"], fetch: ["exa", "direct"] }, keys: { exa: EXA_CANARY }, endpoints: { exa: fetchFirst.url }, guard: guardOf(network()), now: () => START });
  const spent = await w.fetch(PUBLIC);
  assert.deepEqual([spent.answer.via, spent.receipt.tries[0].failure?.covers], ["direct", "key"]);
  const found = await w.search("widgets");
  assert.deepEqual([found.answer, found.receipt.tries.map((one) => one.outcome)], [{ error: SEARCH_UNAVAILABLE }, ["held"]]);
  assert.deepEqual(fetchFirst.got.map((one) => one.path), ["/contents"], "search never sent");

  const searchFirst = await keyedServer(t, (path, body) => (path === "/search" ? refused(402, { error: "out of credits" }) : exaPage(body.urls[0], "Read.")));
  const v = web.createWeb({ order: { search: ["exa"], fetch: ["exa", "direct"] }, keys: { exa: EXA_CANARY }, endpoints: { exa: searchFirst.url }, guard: guardOf(network()), now: () => START });
  assert.match((await v.search("widgets")).answer.error, /Exa's search answered 402/);
  const page = await v.fetch(NOTES);
  assert.deepEqual([page.answer.via, page.receipt.tries.map((one) => [one.provider, one.outcome])], ["direct", [["exa", "held"], ["direct", "ok"]]]);
  assert.deepEqual(searchFirst.got.map((one) => one.path), ["/search"], "the fetch never sent");
});

test("keyed Firecrawl: credit spent on a search holds web_fetch, unsent", async (t) => {
  const fc = await keyedServer(t, (path, body) => (path === "/v2/search" ? refused(402, { success: false, error: "Payment required" }) : firecrawlPage(body.url, "# Read")));
  const w = web.createWeb({ order: { search: ["firecrawl"], fetch: ["firecrawl", "direct"] }, keys: { firecrawl: FIRECRAWL_CANARY }, endpoints: { firecrawl: fc.url }, guard: guardOf(network()), now: () => START });
  assert.match((await w.search("widgets")).answer.error, /Firecrawl's search answered 402/);
  assert.equal((await w.fetch(PUBLIC)).answer.via, "direct");
  assert.deepEqual(fc.got.map((one) => one.path), ["/v2/search"]);
});

/** A fake Parallel: each request to `path` answered by `answer(path, n)` (n counted per path), every request kept. */
function parallelSend(answer) {
  const got = [];
  const send = async (url) => {
    const path = new URL(url).pathname;
    got.push(path);
    const said = answer(path, got.filter((one) => one === path).length);
    return new Response(JSON.stringify(said.json ?? {}), { status: said.status ?? 200, headers: { "content-type": "application/json" } });
  };
  return { send, got };
}
const parallelPage = { json: { results: [{ url: PUBLIC, title: "Read by Parallel", full_content: "The answer is forty-two." }], errors: [] } };
const parallelWeb = (send) => web.createWeb({ order: { search: ["parallel"], fetch: ["parallel", "direct"] }, keys: { parallel: CANARY }, send: { parallel: send }, guard: guardOf(network()), now: () => START });

test("Parallel: credit spent on a search holds its extract, and the page says so; spent on an extract, search is off", async () => {
  const searchFirst = parallelSend((path) => (path === "/v1/search" ? { status: 402 } : parallelPage));
  const w = parallelWeb(searchFirst.send);
  assert.match((await w.search("widgets")).answer.error, /Parallel's search answered 402/);
  const page = await w.fetch(PUBLIC);
  assert.deepEqual([page.answer.via, page.answer.parallel], ["direct", "not tried: out of quota for the rest of this run"]);
  assert.deepEqual(searchFirst.got, ["/v1/search"], "extract never sent");

  const extractFirst = parallelSend((path) => (path === "/v1/extract" ? { status: 402 } : { json: { results: [] } }));
  const v = parallelWeb(extractFirst.send);
  assert.equal((await v.fetch(PUBLIC)).answer.parallel, "out of quota for the rest of this run");
  assert.deepEqual((await v.search("widgets")).answer, { error: SEARCH_UNAVAILABLE });
  assert.equal((await v.fetch(NOTES)).answer.parallel, "not tried: out of quota for the rest of this run", "the extract is off too");
  assert.deepEqual(extractFirst.got, ["/v1/extract"]);
});

test("keyless Firecrawl: its daily limit met on a fetch holds web_search too until 00:00 UTC; met on a search, web_fetch", async (t) => {
  let spent = true;
  const fc = await firecrawlServer(t, (name) => (spent && name === "firecrawl_scrape" ? dailyLimit("scrape") : answers(name)));
  let now = START;
  const w = web.createWeb({ order: { search: ["firecrawl-keyless"], fetch: ["firecrawl-keyless", "direct"] }, endpoints: { "firecrawl-keyless": fc.url }, guard: guardOf(network()), now: () => now });
  assert.equal((await w.fetch(PUBLIC)).answer.via, "direct");
  spent = false;
  assert.deepEqual((await w.search("widgets")).answer, { error: SEARCH_UNAVAILABLE }, "search is held");
  assert.equal(fc.calls("firecrawl_search"), 0);
  now = Date.parse("2026-11-25T00:00:00Z");
  assert.equal((await w.search("widgets")).answer.provider, "firecrawl-keyless", "asked again at 00:00 UTC");
  assert.equal((await w.fetch(NOTES)).answer.via, "firecrawl-keyless", "and so is the scrape");

  const searched = await firecrawlServer(t, (name) => (name === "firecrawl_search" ? dailyLimit("search") : answers(name)));
  const v = web.createWeb({ order: { search: ["firecrawl-keyless"], fetch: ["firecrawl-keyless", "direct"] }, endpoints: { "firecrawl-keyless": searched.url }, guard: guardOf(network()), now: () => START });
  await v.search("widgets");
  assert.equal((await v.fetch(PUBLIC)).answer.via, "direct");
  assert.equal(searched.calls("firecrawl_scrape"), 0, "the scrape never sent");
});

test("a call given its own breakers keeps a key's quota in them; asking for the Web's (keyLimits web), it holds web_fetch", async (t) => {
  const exa = await keyedServer(t, (path, body) => (path === "/search" ? refused(402, { error: "out of credits" }) : exaPage(body.urls[0], "Read.")));
  const webOf = () => web.createWeb({ order: { search: ["exa"], fetch: ["exa", "direct"] }, keys: { exa: EXA_CANARY }, endpoints: { exa: exa.url }, guard: guardOf(network()), now: () => START });
  const own = webOf();
  await own.search("widgets", { breakers: web.breakers(() => START) });
  assert.equal((await own.fetch(PUBLIC)).answer.via, "exa", "the Web's fetch is still asked");
  const shared = webOf();
  await shared.search("widgets", { breakers: web.breakers(() => START), keyLimits: "web" });
  assert.equal((await shared.fetch(PUBLIC)).answer.via, "direct", "the Web's fetch is held");
});

test("a held fetch turn is on the receipt as search's is: outcome held, its failure the hold, no error words; Parallel's too", async (t) => {
  const searchFirst = parallelSend((path) => (path === "/v1/search" ? { status: 402 } : parallelPage));
  const w = parallelWeb(searchFirst.send);
  await w.search("widgets");
  const page = await w.fetch(PUBLIC);
  assert.deepEqual(page.receipt.tries, [
    { provider: "parallel", outcome: "held", failure: { class: "quota", code: "HELD", message: "not tried: out of quota for the rest of this run" }, ms: 0 },
    { provider: "direct", outcome: "ok" },
  ]);
});
