// Correctness of web_search and web_fetch at their edges: a search answering no results passes the call on, a page read
// once a run whatever its fragment, a receipt that says only what its call did and asked, cuts that never split a
// surrogate pair, a keyed provider with no key unasked before any check, and a turn's words as the model reads them.
// Every outside part is a fake: no socket leaves the machine.
import assert from "node:assert/strict";
import { test } from "node:test";
import { publicCheck, publicFetch, readPage } from "@parcha/pi-browser";
import * as web from "../dist/index.js";
import { snippetOf } from "../dist/search.js";
import { firecrawlServer } from "./fixtures/fake-firecrawl.mjs";
import fakeExa, { resetFauxExa } from "./fixtures/faux-exa.mjs";
import fakeParallel, { CANARY } from "./fixtures/faux-parallel.mjs";
import { network } from "./fixtures/fake-network.mjs";
import { withEnv } from "./support.mjs";

const PUBLIC = "http://public.example/";
const START = Date.parse("2026-11-24T12:00:00Z");
const FAKE_VARS = ["AGENTRUN_TEST_FAUX_EXA", "AGENTRUN_TEST_FAUX_EXA_CALLS", "AGENTRUN_TEST_FAUX_PARALLEL_SEARCH", "AGENTRUN_TEST_FAUX_PARALLEL_EXTRACT", "AGENTRUN_TEST_FAUX_PARALLEL_CALLS"];
/** Exa's text that names no result this server reads. */
const UNREADABLE_TEXT = "Search results are temporarily formatted differently.";

/** The guard on a fake network, counting its checks. The fetch drops a URL's fragment, as HTTP does: none reaches a
 *  server. */
function guardOf(net = network()) {
  const counted = { checks: 0 };
  const fetchImpl = (url, init) => {
    const sent = new URL(url.href);
    sent.hash = "";
    return net.fetchImpl(sent, init);
  };
  const guard = { fetch: (url, options) => publicFetch(url, { lookup: net.lookup, fetchImpl, ...options }), check: (url, options) => (counted.checks++, publicCheck(url, { lookup: net.lookup, ...options })), html: readPage };
  return { guard, counted, net };
}

/** Exa answering every search with one tool result of `text`; any other request as its fake does. */
const exaSaying = (text) => async (url, init) => {
  const { method, id } = JSON.parse(init.body);
  if (method !== "tools/call") return fakeExa(url, init);
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } }), { status: 200, headers: { "content-type": "application/json" } });
};

/** Firecrawl's keyless search answering no results. */
const noHits = () => ({ content: [{ type: "text", text: JSON.stringify({ success: true, data: { web: [] } }) }] });

const turns = (receipt) => receipt.tries.map((one) => [one.provider, one.outcome]);
/** Whether `text` holds a lone surrogate. */
const lone = (text) => !text.isWellFormed();

test("a backend answering no results passes the call to the next: keyless Firecrawl's empty answer, then keyless Exa's results", async (t) => {
  withEnv(t, {}, FAKE_VARS);
  resetFauxExa();
  const fc = await firecrawlServer(t, (name) => (name === "firecrawl_search" ? noHits() : undefined));
  const w = web.createWeb({ order: { search: ["firecrawl-keyless", "exa-keyless"], fetch: [] }, endpoints: { "firecrawl-keyless": fc.url }, send: { "exa-keyless": fakeExa }, now: () => START });
  const { answer, receipt } = await w.search("widgets");
  assert.equal(answer.provider, "exa-keyless", "Exa's results answer");
  assert.ok(answer.results.length > 0);
  assert.deepEqual(turns(receipt), [["firecrawl-keyless", "empty"], ["exa-keyless", "ok"]], "the receipt says Firecrawl answered none");
  assert.equal(receipt.provider, "exa-keyless");
});

test("every backend answering no results or failing: the first empty answer is the call's, each turn on the receipt as it went", async (t) => {
  withEnv(t, {}, FAKE_VARS);
  resetFauxExa();
  const fc = await firecrawlServer(t, (name) => (name === "firecrawl_search" ? noHits() : undefined));
  const w = web.createWeb({ order: { search: ["firecrawl-keyless", "exa-keyless"], fetch: [] }, endpoints: { "firecrawl-keyless": fc.url }, send: { "exa-keyless": exaSaying(UNREADABLE_TEXT) }, now: () => START });
  const { answer, receipt } = await w.search("widgets");
  assert.deepEqual(answer, { provider: "firecrawl-keyless", objective: "widgets", queries: ["widgets"], results: [] });
  assert.deepEqual(turns(receipt), [["firecrawl-keyless", "empty"], ["exa-keyless", "error"]]);
  assert.equal(receipt.tries[1].failure?.code, "UNREADABLE");
  assert.equal(receipt.provider, "firecrawl-keyless");
});

test("a paid search answering no results stays booked when the next backend answers", async (t) => {
  withEnv(t, {}, FAKE_VARS);
  resetFauxExa();
  const empty = async (url, init) => (new URL(String(url)).pathname === "/v1/search" ? new Response(JSON.stringify({ search_id: "s-empty", results: [] }), { status: 200, headers: { "content-type": "application/json" } }) : fakeParallel(url, init));
  const fees = [];
  const w = web.createWeb({ order: { search: ["parallel", "exa-keyless"], fetch: [] }, keys: { parallel: CANARY }, send: { parallel: empty, "exa-keyless": fakeExa }, pay: async (fee, send) => (fees.push(fee), send()), now: () => START });
  const { answer, receipt } = await w.search("widgets");
  assert.equal(answer.provider, "exa-keyless");
  assert.deepEqual(turns(receipt), [["parallel", "empty"], ["exa-keyless", "ok"]]);
  assert.equal(fees.length, 1);
  assert.equal(receipt.cost.usd, web.PARALLEL_SEARCH_USD, "the empty search was sent, so it is paid");
});

test("a native search answering its own text with no results answers: it is not passed over", async () => {
  const native = async () => ({ answer: { provider: "native", query: "q", results: [], text: "The answer is forty-two." } });
  let asked = 0;
  const w = web.createWeb({ order: { search: ["native", "exa-keyless"], fetch: [] }, native, send: { "exa-keyless": async () => (asked++, new Response("", { status: 500 })) }, now: () => START });
  const { answer, receipt } = await w.search("widgets");
  assert.equal(answer.text, "The answer is forty-two.");
  assert.deepEqual(turns(receipt), [["native", "ok"]]);
  assert.equal(asked, 0);
});

test("keyless Exa answering text that holds no result it reads: a failure typed UNREADABLE, never a silent empty answer", async () => {
  assert.deepEqual(await web.exaSearch("widgets", 3, { send: exaSaying(UNREADABLE_TEXT) }), { error: "Exa's search answered no results this server reads" });
});

test("a page is read once a run whatever its fragment or its host's case: a later fragment reads the run's page, with no request of its own", async () => {
  const { guard, net } = guardOf();
  const w = web.createWeb({ order: { search: [], fetch: ["direct"] }, guard, now: () => START });
  const first = await w.fetch(`${PUBLIC}#a`);
  assert.equal(first.answer.ok, true);
  const fresh = await web.createWeb({ order: { search: [], fetch: ["direct"] }, guard: guardOf().guard, now: () => START }).fetch(`${PUBLIC}#b`);
  const second = await w.fetch(`${PUBLIC}#b`);
  const third = await w.fetch("HTTP://Public.Example/");
  assert.deepEqual(net.dialled, [PUBLIC], "dialled once");
  assert.equal(second.receipt.cache, "hit");
  assert.equal(third.receipt.cache, "hit");
  assert.equal(second.answer.url, fresh.answer.url, "the page names the URL a fresh read would");
});

test("a search's receipt keeps the fees of its own call: a sift stopped by the caller that pays later adds nothing to it", async () => {
  const controller = new AbortController();
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let paid;
  const decider = {
    id: "fake",
    async sift(_query, hits, _task, ctx) {
      controller.abort();
      await gate;
      paid = ctx.pay({ name: "the fake's sift", by: "fake", usd: 0.01, basis: "list price" }, async () => ({ verdicts: hits.map(() => 1), model: null, temperature_sent: null, temperature_applied: false, tokens: null, cost: { usd: 0.01, basis: "reported" }, questions_sha256: [] }));
      return paid;
    },
  };
  const native = async () => ({ answer: { provider: "native", query: "q", results: [{ url: "https://native.example/1", title: "Native", snippet: "found natively" }] } });
  const w = web.createWeb({ order: { search: ["native"], fetch: [] }, native, decider, pay: async (_fee, send) => send(), now: () => START });
  const { receipt } = await w.search("widgets", { signal: controller.signal });
  assert.deepEqual(receipt.cost, { usd: 0, lines: [] });
  release();
  await paid;
  assert.deepEqual(receipt.cost, { usd: 0, lines: [] }, "the receipt is as it was returned");
});

test("a fetch's receipt names the URL asked without its user name or password, as the page does", async () => {
  const { guard } = guardOf();
  const w = web.createWeb({ order: { search: [], fetch: ["direct"] }, guard, now: () => START });
  const { answer, receipt } = await w.fetch("http://web-user:not-a-secret@public.example/");
  assert.equal(receipt.asked, "http://public.example/");
  assert.equal(answer.url, "http://public.example/");
  const refused = await w.fetch("http://web-user:not-a-secret@public.example/", { offset: -1 });
  assert.equal(refused.receipt.asked, "http://public.example/", "a part refused before anything is fetched too");
});

test("cuts never split a surrogate pair: clip, a snippet with no space to cut on, keyless Exa's words", async () => {
  const emoji = "\u{1F600}";
  assert.equal(lone(web.clip(`ab${emoji}cd`, 4)), false, "clip");
  assert.equal(web.clip(`ab${emoji}cd`, 4), "ab…");
  const snippet = snippetOf(`${"x".repeat(web.SNIPPET_MAX - 2)}${emoji}${"y".repeat(10)}`);
  assert.equal(lone(snippet), false, "snippetOf");
  assert.ok(snippet.endsWith("x…"));
  const said = `${"x".repeat(118)}${emoji}${"y".repeat(10)}.`;
  const failedSearch = async (url, init) => {
    const { method, id } = JSON.parse(init.body);
    if (method !== "tools/call") return fakeExa(url, init);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: said }] } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const { error } = await web.exaSearch("widgets", 3, { send: failedSearch });
  assert.equal(lone(error), false, "exaSaid");
});

for (const [id, label] of [["exa", "Exa"], ["firecrawl", "Firecrawl"]]) {
  test(`keyed ${label} in a fetch's order with no key: not tried, unchecked and unlogged, its turn typed NO_KEY`, async () => {
    const { guard, counted } = guardOf();
    const logs = [];
    const w = web.createWeb({ order: { search: [], fetch: [id, "direct"] }, guard, now: () => START, log: (event, fields) => logs.push([event, fields]) });
    const { answer, receipt } = await w.fetch(PUBLIC);
    assert.equal(counted.checks, 0, "the guard is never asked about a URL no provider is sent");
    assert.deepEqual(logs, [], "nothing is logged for a provider never asked");
    assert.deepEqual([receipt.tries[0].provider, receipt.tries[0].outcome, receipt.tries[0].failure?.code], [id, "error", "NO_KEY"]);
    assert.equal(answer[id], `not tried: this run holds no ${label} key`);
    assert.equal(answer.via, "direct");
  });
}

test("Parallel's failed read is recorded as any other provider's: the limit it met", async (t) => {
  withEnv(t, { AGENTRUN_TEST_FAUX_PARALLEL_EXTRACT: "402" }, FAKE_VARS);
  const { guard } = guardOf();
  const quota = web.createWeb({ order: { search: [], fetch: ["parallel", "direct"] }, keys: { parallel: CANARY }, send: { parallel: fakeParallel }, guard, now: () => START });
  const spent = await quota.fetch(PUBLIC);
  assert.deepEqual(spent.receipt.tries[0].limit, { kind: "quota" });
});

test("Parallel's failed read is recorded as any other provider's: its words cut at 300", async (t) => {
  withEnv(t, {}, FAKE_VARS);
  const long = `the run's cap does not hold this read: ${"x".repeat(400)}`;
  const capped = web.createWeb({ order: { search: [], fetch: ["parallel", "direct"] }, keys: { parallel: CANARY }, send: { parallel: fakeParallel }, guard: guardOf().guard, pay: async () => { throw new web.PaidRefused(long); }, now: () => START });
  const refused = await capped.fetch(PUBLIC);
  assert.equal(refused.receipt.tries[0].failure?.code, "CAP_REFUSED");
  assert.equal(refused.receipt.tries[0].error, long.slice(0, 300));
});

test("a page no provider ahead gave, whose direct fetch failed too, never says it was fetched directly", async () => {
  const { guard } = guardOf();
  const w = web.createWeb({ order: { search: [], fetch: ["parallel", "direct"] }, guard, now: () => START });
  const { answer } = await w.fetch("http://public.example/missing");
  assert.equal(answer.ok, false);
  assert.equal(answer.via, "direct");
  const text = web.webFetchText(answer);
  assert.doesNotMatch(text, /fetched directly/);
  assert.match(text, /\nParallel gave no page \(not tried: this run holds no Parallel key\); the direct fetch failed too\.$/);
});
