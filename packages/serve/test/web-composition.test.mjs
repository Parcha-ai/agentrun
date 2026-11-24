// Serve composes @parcha/agentrun-web's functions itself (web-search.ts searched, web-fetch.ts fetchFor): its per-run
// clients and pages by environment, its plane read per call, its breakers per binding. The bench measures createWeb.
// These tests hold the two to one behaviour: for each order serve's plane can resolve web_search and web_fetch to (the
// table below, searchOrderOf and fetchOrderOf), the same steps run through serve's composition and then through
// createWeb, each on fakes of its own made the same way (keyless Firecrawl a fake MCP server on loopback, keyless Exa,
// Parallel and the model provider the faux modules, the network a table), on the same clock. Each step's answer and the
// providers it reached are the same on both paths, and both are what the step expects: which providers were asked, in
// what turn (createWeb's receipt), which answered, the breakers' holds and waits, and the page cache. A change to either
// path, or to what they share, breaks one of the three.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import * as web from "@parcha/agentrun-web";
import { bookedIn, paidRequest } from "../dist/paid-calls.js";
import { searchOrderOf, webSearchTool } from "../dist/web-search.js";
import { fetchFor, fetchOrderOf, pagesOf } from "../dist/web-fetch.js";
import { GUARD } from "../dist/web-fetch-direct.js";
import { RATE_LIMITED } from "../dist/keyless-mcp.js";
import { FAUX_FIRECRAWL_ENV } from "../dist/firecrawl-keyless.js";
import { TOOL_PLANE_ENV } from "../dist/tool-plane.js";
import { hostedSearched } from "../dist/hosted-search.js";
import { runModels } from "../dist/model.js";
import { answers, firecrawlServer, refusal } from "./fixtures/fake-firecrawl.mjs";
import fakeExa, { resetFauxExa } from "./fixtures/faux-exa.mjs";
import fakeParallel, { CANARY, resetFauxParallel } from "./fixtures/faux-parallel.mjs";
import { network } from "./fixtures/fake-network.mjs";
import { FAUX, scratch, toolLedger, withEnv } from "./support.mjs";

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url).pathname;
const PUBLIC = "http://public.example/";
const EVIL = "http://evil.example/";
const NOTES = "http://public.example/notes.txt";
const MODEL = "anthropic/claude-sonnet-5-5";
const START = Date.parse("2026-11-24T12:00:00Z");
/** The fakes' variables: each test puts them back. */
const FAKE_VARS = ["AGENTRUN_TEST_FAUX_EXA", "AGENTRUN_TEST_FAUX_EXA_CALLS", "AGENTRUN_TEST_FAUX_PARALLEL_SEARCH", "AGENTRUN_TEST_FAUX_PARALLEL_EXTRACT", "AGENTRUN_TEST_FAUX_PARALLEL_CALLS", "AGENTRUN_TEST_FAUX_UPSTREAM", "AGENTRUN_TEST_FAUX_UPSTREAM_CALLS"];

/** The orders of plan section 3: what each provider serve's plane resolves a tool to asks, in turn. */
const SEARCH_ORDERS = { "firecrawl-keyless": ["firecrawl-keyless", "exa-keyless"], "exa-keyless": ["exa-keyless"], parallel: ["parallel"], native: ["native"] };
const FETCH_ORDERS = { "firecrawl-keyless": ["firecrawl-keyless", "direct"], parallel: ["parallel", "direct"], kernel: ["direct"] };

/** The fake each provider is, as a step's `asks` names it. */
const FAKE_OF = { "firecrawl-keyless": "firecrawl", "exa-keyless": "exa", parallel: "parallel", native: "native", direct: "dialled" };

const lines = async (file) => (await readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line));

/** One path's fakes, made fresh: Firecrawl answering each tools/call as `firecrawl(name, n)` says (undefined: its
 *  default answer), the faux modules filing their calls in files of this path's own and counting from their first, the
 *  network a table, and the clock. `asked()` counts what reached each. */
async function fakes(t, firecrawl = () => undefined) {
  const dir = await scratch(t);
  const files = { exa: join(dir, "exa.jsonl"), parallel: join(dir, "parallel.jsonl"), upstream: join(dir, "upstream.jsonl") };
  process.env.AGENTRUN_TEST_FAUX_EXA_CALLS = files.exa;
  process.env.AGENTRUN_TEST_FAUX_PARALLEL_CALLS = files.parallel;
  process.env.AGENTRUN_TEST_FAUX_UPSTREAM_CALLS = files.upstream;
  resetFauxExa();
  resetFauxParallel();
  const fc = await firecrawlServer(t, (name, _args, n) => firecrawl(name, n) ?? answers(name));
  const net = network();
  const clock = { now: START };
  const asked = async () => ({
    firecrawl: fc.toolCalls().length,
    exa: (await lines(files.exa)).filter((call) => call.method === "tools/call").length,
    parallel: (await lines(files.parallel)).length,
    native: (await lines(files.upstream)).length,
    dialled: net.dialled.length,
  });
  return { fc, net, clock, asked };
}

/** A run's one ledger, as the adapter loop runs a host tool: each step a call of it, so a request to Parallel is booked. */
async function inCalls() {
  const paid = await toolLedger();
  let n = 0;
  return (work) => bookedIn({ call: `call-${(n += 1)}`, paid }, work);
}

/** Each step of `steps` on serve's path, then on createWeb's, each on its own fakes (made by `made`): every step's answer
 *  and the providers it reached, and createWeb's receipt. A step sets the fakes' variables in `set` first, and moves the
 *  clock to `at` ms past the start. */
async function bothPaths(made, paths, steps) {
  const outcomes = {};
  for (const [name, start] of Object.entries(paths)) {
    const f = await made();
    const run = await start(f);
    const seen = [];
    for (const step of steps) {
      Object.assign(process.env, step.set ?? {});
      if (step.at !== undefined) f.clock.now = START + step.at;
      const before = await f.asked();
      const { answer, receipt } = await run(step);
      const after = await f.asked();
      const reached = Object.keys(after).filter((fake) => after[fake] > before[fake]).sort();
      seen.push({ answer, reached, counts: Object.fromEntries(Object.keys(after).map((fake) => [fake, after[fake] - before[fake]])), receipt });
    }
    outcomes[name] = seen;
  }
  return outcomes;
}

/** Both paths' outcomes held to each other and to each step's expectations: the answer and every fake's count equal on
 *  both paths; the providers reached (`asks`), createWeb's turns ([provider, outcome]) and the provider that answered
 *  (`by`) as the step says, and what it cost createWeb's receipt where the step names a price. */
function same(outcomes, steps, label) {
  const { serve, web: bench } = outcomes;
  steps.forEach((step, i) => {
    const at = `${label} step ${i + 1}`;
    assert.deepEqual(serve[i].answer, bench[i].answer, `${at}: the same answer`);
    assert.deepEqual(serve[i].counts, bench[i].counts, `${at}: the same requests reached each fake`);
    const asks = step.asks.map((provider) => FAKE_OF[provider]).sort();
    assert.deepEqual(serve[i].reached, asks, `${at}: serve reached ${step.asks}`);
    assert.deepEqual(bench[i].reached, asks, `${at}: createWeb reached ${step.asks}`);
    assert.deepEqual(bench[i].receipt.tries.map((one) => [one.provider, one.outcome]), step.tries, `${at}: createWeb's turns`);
    // A page answers by its via where it was read; a search by its provider where it found any.
    const answer = bench[i].answer;
    const answered = "ok" in answer ? (answer.ok ? answer.via : null) : "error" in answer ? null : answer.provider;
    assert.equal(answered, step.by, `${at}: answered by ${step.by}`);
    assert.equal(bench[i].receipt.provider, step.by, `${at}: the receipt names ${step.by}`);
    if (step.usd !== undefined) assert.equal(bench[i].receipt.cost.usd, step.usd, `${at}: cost`);
    step.check?.(bench[i].answer, bench[i].receipt);
  });
}

test("serve's orders are plan section 3's table: searchOrderOf and fetchOrderOf name each resolution's providers in turn", () => {
  for (const [resolved, order] of Object.entries(SEARCH_ORDERS)) assert.deepEqual(searchOrderOf(resolved), order, resolved);
  for (const [resolved, order] of Object.entries(FETCH_ORDERS)) assert.deepEqual(fetchOrderOf(resolved), order, resolved);
});

// web_search: serve's webSearchTool (one run's binding, its breakers on the clock) against createWeb's search, each
// step's answer read as the tool fits it (fitSearch).

/** Serve's web_search for a run whose plane resolves it to `resolved`, on the env `envOf(f)` adds to. */
const serveSearch = (resolved, envOf = () => ({}), models) => async (f) => {
  const env = { [TOOL_PLANE_ENV]: JSON.stringify({ web_search: resolved, ...(resolved === "native" ? { model: MODEL } : {}) }), AGENTRUN_SERVE_FAUX: FAUX, AGENTRUN_SERVE_FAUX_EXA: fixture("faux-exa.mjs"), [FAUX_FIRECRAWL_ENV]: f.fc.url, ...envOf(f) };
  const tool = webSearchTool(env, models ? async () => models : undefined, undefined, () => f.clock.now);
  const inCall = await inCalls();
  let n = 0;
  return async ({ query }) => ({ answer: (await inCall(() => tool.execute({ query }, { callId: `call-${(n += 1)}` }, {}))).details });
};
/** createWeb's search on serve's order for `resolved`, the same fakes given as config, in serve's words. */
const benchSearch = (resolved, more = () => ({})) => async (f) => {
  const w = web.createWeb({ order: { search: SEARCH_ORDERS[resolved], fetch: [] }, endpoints: { "firecrawl-keyless": f.fc.url }, send: { "exa-keyless": fakeExa, parallel: fakeParallel }, pay: paidRequest, words: { rateLimited: RATE_LIMITED }, now: () => f.clock.now, ...more(f) });
  const inCall = await inCalls();
  return async ({ query }) => {
    const { answer, receipt } = await inCall(() => w.search(query));
    return { answer: web.fitSearch(answer), receipt };
  };
};

test("keyless Firecrawl with Exa behind it: Firecrawl answers; its rate limit passes the call to Exa and holds Firecrawl for its wait; past it Firecrawl answers again; out of quota it is off for the run", async (t) => {
  withEnv(t, { AGENTRUN_TEST_FAUX_EXA: "ok" }, FAKE_VARS);
  const firecrawl = (name, n) => (name !== "firecrawl_search" ? undefined : n === 2 ? refusal("KEYLESS_LIMIT_REACHED", { retryAfter: 30 }) : n === 4 ? refusal("KEYLESS_QUOTA_EXHAUSTED") : undefined);
  const steps = [
    { query: "widgets", at: 0, asks: ["firecrawl-keyless"], tries: [["firecrawl-keyless", "ok"]], by: "firecrawl-keyless" },
    { query: "gadgets", at: 0, asks: ["firecrawl-keyless", "exa-keyless"], tries: [["firecrawl-keyless", "error"], ["exa-keyless", "ok"]], by: "exa-keyless" },
    { query: "sprockets", at: 10_000, asks: ["exa-keyless"], tries: [["firecrawl-keyless", "held"], ["exa-keyless", "ok"]], by: "exa-keyless" },
    { query: "widgets", at: 31_000, asks: ["firecrawl-keyless"], tries: [["firecrawl-keyless", "ok"]], by: "firecrawl-keyless" },
    { query: "gadgets", at: 31_000, asks: ["firecrawl-keyless", "exa-keyless"], tries: [["firecrawl-keyless", "error"], ["exa-keyless", "ok"]], by: "exa-keyless" },
    { query: "sprockets", at: 100_000, asks: ["exa-keyless"], tries: [["firecrawl-keyless", "held"], ["exa-keyless", "ok"]], by: "exa-keyless" },
  ];
  same(await bothPaths(() => fakes(t, firecrawl), { serve: serveSearch("firecrawl-keyless"), web: benchSearch("firecrawl-keyless") }, steps), steps, "firecrawl-keyless");
});

test("keyless Exa alone: its free limit answers serve's words and holds it for the Retry-After it named, unsent and busy within it; past it Exa is asked again", async (t) => {
  withEnv(t, { AGENTRUN_TEST_FAUX_EXA: "ok,429" }, FAKE_VARS);
  const steps = [
    { query: "widgets", at: 0, asks: ["exa-keyless"], tries: [["exa-keyless", "ok"]], by: "exa-keyless" },
    { query: "gadgets", at: 0, asks: ["exa-keyless"], tries: [["exa-keyless", "error"]], by: null, check: (answer) => assert.deepEqual(answer, { error: RATE_LIMITED }) },
    { query: "sprockets", at: 10_000, asks: [], tries: [["exa-keyless", "held"]], by: null, check: (answer) => assert.equal(answer.error, web.searchBusy(20)) },
    { query: "widgets", at: 31_000, asks: ["exa-keyless"], tries: [["exa-keyless", "error"]], by: null },
  ];
  same(await bothPaths(() => fakes(t), { serve: serveSearch("exa-keyless"), web: benchSearch("exa-keyless") }, steps), steps, "exa-keyless");
});

test("Parallel on the run's key, each search a paid request: a 429 holds it for its Retry-After, a 402 turns it off for the run", async (t) => {
  withEnv(t, { AGENTRUN_TEST_FAUX_PARALLEL_SEARCH: "ok;429@20;402" }, FAKE_VARS);
  const price = web.PARALLEL_SEARCH_USD;
  const steps = [
    { query: "widgets", at: 0, asks: ["parallel"], tries: [["parallel", "ok"]], by: "parallel", usd: price },
    { query: "gadgets", at: 0, asks: ["parallel"], tries: [["parallel", "error"]], by: null, usd: price },
    { query: "sprockets", at: 5_000, asks: [], tries: [["parallel", "held"]], by: null, usd: 0, check: (answer) => assert.equal(answer.error, web.searchBusy(15)) },
    { query: "widgets", at: 21_000, asks: ["parallel"], tries: [["parallel", "error"]], by: null, usd: price },
    { query: "gadgets", at: 22_000, asks: [], tries: [["parallel", "held"]], by: null, usd: 0, check: (answer) => assert.equal(answer.error, web.SEARCH_UNAVAILABLE) },
  ];
  const keyed = { PARALLEL_API_KEY: CANARY, AGENTRUN_SERVE_FAUX_PARALLEL: fixture("faux-parallel.mjs") };
  same(await bothPaths(() => fakes(t), { serve: serveSearch("parallel", () => keyed), web: benchSearch("parallel", () => ({ keys: { parallel: CANARY } })) }, steps), steps, "parallel");
});

test("the model provider's own search, on the run's models: a rate limit holds it, past the wait it answers again", async (t) => {
  withEnv(t, {}, FAKE_VARS);
  const upstream = { AGENTRUN_SERVE_FAUX: FAUX, AGENTRUN_SERVE_FAUX_UPSTREAM: fixture("faux-upstream.mjs"), ANTHROPIC_API_KEY: "not-a-secret", OPENAI_API_KEY: "not-a-secret" };
  const { models } = await runModels(upstream, undefined);
  const steps = [
    { query: "widgets", at: 0, set: { AGENTRUN_TEST_FAUX_UPSTREAM: "" }, asks: ["native"], tries: [["native", "ok"]], by: "native" },
    { query: "gadgets", at: 0, set: { AGENTRUN_TEST_FAUX_UPSTREAM: "rate_limited" }, asks: ["native"], tries: [["native", "error"]], by: null },
    { query: "sprockets", at: 10_000, set: { AGENTRUN_TEST_FAUX_UPSTREAM: "" }, asks: [], tries: [["native", "held"]], by: null },
    { query: "widgets", at: 61_000, set: { AGENTRUN_TEST_FAUX_UPSTREAM: "" }, asks: ["native"], tries: [["native", "ok"]], by: "native" },
  ];
  const native = (query, n, signal) => hostedSearched(query, n, MODEL, signal, models);
  same(await bothPaths(() => fakes(t), { serve: serveSearch("native", () => upstream, models), web: benchSearch("native", () => ({ native })) }, steps), steps, "native");
});

// web_fetch: serve's fetchFor (on the run's pages, pagesOf) against createWeb's fetch, with pi-browser's guard (GUARD)
// on the fake network on both: serve hands the network to the guard as options, createWeb's guard holds it.

/** Serve's web_fetch for a run whose plane resolves it to `resolved`, on the env `envOf(f)` adds to. */
const serveFetch = (resolved, envOf = () => ({})) => async (f) => {
  const env = { [TOOL_PLANE_ENV]: JSON.stringify({ web_fetch: resolved }), AGENTRUN_SERVE_FAUX: FAUX, [FAUX_FIRECRAWL_ENV]: f.fc.url, ...envOf(f) };
  const pages = pagesOf(env);
  const inCall = await inCalls();
  return async ({ url, part = {} }) => ({ answer: await inCall(() => fetchFor(env, url, { lookup: f.net.lookup, fetchImpl: f.net.fetchImpl, pages, ...part })) });
};
/** createWeb's fetch on serve's order for `resolved`, its guard pi-browser's on the fake network. */
const benchFetch = (resolved, more = () => ({})) => async (f) => {
  const guard = { fetch: (url, options) => GUARD.fetch(url, { lookup: f.net.lookup, fetchImpl: f.net.fetchImpl, ...options }), html: GUARD.html };
  const w = web.createWeb({ order: { search: [], fetch: FETCH_ORDERS[resolved] }, endpoints: { "firecrawl-keyless": f.fc.url }, send: { parallel: fakeParallel }, guard, pay: paidRequest, words: { rateLimited: RATE_LIMITED }, ...more(f) });
  const inCall = await inCalls();
  return async ({ url, part = {} }) => inCall(() => w.fetch(url, part));
};

test("keyless Firecrawl with the direct fetch behind it: Firecrawl reads a public page, the run's pages answer its next part, a private host goes to neither, and Firecrawl out of quota passes the page to the direct fetch and is off for the run", async (t) => {
  withEnv(t, {}, FAKE_VARS);
  const firecrawl = (name, n) => (name === "firecrawl_scrape" && n === 2 ? refusal("KEYLESS_QUOTA_EXHAUSTED") : undefined);
  const steps = [
    { url: PUBLIC, asks: ["firecrawl-keyless"], tries: [["firecrawl-keyless", "ok"]], by: "firecrawl-keyless" },
    { url: PUBLIC, part: { offset: 10 }, asks: [], tries: [], by: "firecrawl-keyless", check: (_answer, receipt) => assert.equal(receipt.cache, "hit") },
    { url: EVIL, asks: [], tries: [["direct", "error"]], by: null, check: (answer) => assert.match(answer.refused, /^refused: evil\.example is not a public host/) },
    { url: NOTES, asks: ["firecrawl-keyless", "direct"], tries: [["firecrawl-keyless", "error"], ["direct", "ok"]], by: "direct" },
    { url: `${PUBLIC}?run=a`, asks: ["direct"], tries: [["direct", "ok"]], by: "direct" },
  ];
  same(await bothPaths(() => fakes(t, firecrawl), { serve: serveFetch("firecrawl-keyless"), web: benchFetch("firecrawl-keyless") }, steps), steps, "fetch firecrawl-keyless");
});

test("Parallel's extract on the run's key with the direct fetch behind it: Parallel reads a public page (a paid request), never a private one, a page it lists in its errors is fetched directly, and a refused key keeps it unasked for the run", async (t) => {
  withEnv(t, {}, FAKE_VARS);
  const price = web.PARALLEL_EXTRACT_USD;
  const mode = (value) => ({ AGENTRUN_TEST_FAUX_PARALLEL_EXTRACT: value });
  const steps = [
    { url: PUBLIC, set: mode(""), asks: ["parallel"], tries: [["parallel", "ok"]], by: "parallel", usd: price },
    { url: EVIL, set: mode(""), asks: [], tries: [["parallel", "error"], ["direct", "error"]], by: null, usd: 0, check: (answer) => assert.equal(answer.parallel, "not tried: the URL did not pass the public-host guard") },
    { url: NOTES, set: mode("errors"), asks: ["parallel", "direct"], tries: [["parallel", "error"], ["direct", "ok"]], by: "direct", usd: price },
    { url: `${PUBLIC}?run=a`, set: mode("401"), asks: ["parallel", "direct"], tries: [["parallel", "error"], ["direct", "ok"]], by: "direct", usd: price },
    { url: `${PUBLIC}?run=b`, set: mode(""), asks: ["direct"], tries: [["parallel", "error"], ["direct", "ok"]], by: "direct", usd: 0, check: (answer) => assert.equal(answer.parallel, "not tried: refused earlier in this run") },
  ];
  const keyed = { PARALLEL_API_KEY: CANARY, AGENTRUN_SERVE_FAUX_PARALLEL: fixture("faux-parallel.mjs") };
  same(await bothPaths(() => fakes(t), { serve: serveFetch("parallel", () => keyed), web: benchFetch("parallel", () => ({ keys: { parallel: CANARY } })) }, steps), steps, "fetch parallel");
});

test("Parallel picked with no key: the page is fetched directly and says Parallel was not tried", async (t) => {
  withEnv(t, {}, FAKE_VARS);
  const steps = [
    { url: PUBLIC, asks: ["direct"], tries: [["parallel", "error"], ["direct", "ok"]], by: "direct", usd: 0, check: (answer) => assert.equal(answer.parallel, "not tried: this run holds no Parallel key") },
  ];
  same(await bothPaths(() => fakes(t), { serve: serveFetch("parallel"), web: benchFetch("parallel") }, steps), steps, "fetch parallel, no key");
});

test("the kernel's direct fetch alone: a public page read, a private host refused undialled, and a part no call may ask for refused before anything is fetched", async (t) => {
  withEnv(t, {}, FAKE_VARS);
  const steps = [
    { url: PUBLIC, asks: ["direct"], tries: [["direct", "ok"]], by: "direct", check: (answer) => assert.equal(answer.title, "Public page") },
    { url: EVIL, asks: [], tries: [["direct", "error"]], by: null },
    { url: NOTES, part: { maxChars: 1 }, asks: [], tries: [], by: null, check: (answer) => assert.equal(answer.error, "max_chars must be at least 200 (it was 1)") },
  ];
  same(await bothPaths(() => fakes(t), { serve: serveFetch("kernel"), web: benchFetch("kernel") }, steps), steps, "fetch kernel");
});
