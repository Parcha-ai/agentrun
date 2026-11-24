// createWeb: one run's web, every outside part injected (the providers' sends and endpoints, the public-host guard, the
// cap, a native search, the words). Each test drives one order through steps on fakes, and holds what each step
// answered, which fakes it reached, the receipt's turns and provider, and what it cost.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { publicCheck, publicFetch, readPage } from "@parcha/pi-browser";
import * as web from "../dist/index.js";
import { SEARCH_UNAVAILABLE, searchBusy } from "../dist/search.js";
import { answers, dailyLimit, FIRECRAWL_DAILY_INJECTION, firecrawlServer, refusal } from "./fixtures/fake-firecrawl.mjs";
import fakeExa, { resetFauxExa } from "./fixtures/faux-exa.mjs";
import fakeParallel, { CANARY, resetFauxParallel } from "./fixtures/faux-parallel.mjs";
import { network } from "./fixtures/fake-network.mjs";
import { withEnv } from "./support.mjs";

const PUBLIC = "http://public.example/";
const EVIL = "http://evil.example/";
const NOTES = "http://public.example/notes.txt";
const START = Date.parse("2026-11-24T12:00:00Z");
const WORDS = { rateLimited: "Free search is rate-limited; this product's words." };
const FAKE_VARS = ["AGENTRUN_TEST_FAUX_EXA", "AGENTRUN_TEST_FAUX_EXA_CALLS", "AGENTRUN_TEST_FAUX_PARALLEL_SEARCH", "AGENTRUN_TEST_FAUX_PARALLEL_EXTRACT", "AGENTRUN_TEST_FAUX_PARALLEL_CALLS"];

const lines = async (file) => (await readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line));

/** Fresh fakes: Firecrawl answering each tools/call as `firecrawl(name, n)` says (undefined: its default), Exa and
 *  Parallel filing their calls in files of their own, a native search answering as `native.next` says, the network a
 *  table, the clock, and a cap recording each fee it is asked (`refuse`: it refuses instead). `asked()` counts what
 *  reached each. */
async function fakes(t, firecrawl = () => undefined) {
  const dir = await mkdtemp(join(tmpdir(), "web-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const files = { exa: join(dir, "exa.jsonl"), parallel: join(dir, "parallel.jsonl") };
  withEnv(t, { AGENTRUN_TEST_FAUX_EXA_CALLS: files.exa, AGENTRUN_TEST_FAUX_PARALLEL_CALLS: files.parallel }, FAKE_VARS);
  resetFauxExa();
  resetFauxParallel();
  const fc = await firecrawlServer(t, (name, _args, n) => firecrawl(name, n) ?? answers(name));
  const net = network();
  const clock = { now: START };
  const native = { calls: 0, next: () => ({ answer: { provider: "native", query: "q", results: [{ url: "https://native.example/1", title: "Native", snippet: "found natively" }] } }) };
  const cap = { fees: [], refuse: undefined };
  const config = {
    endpoints: { "firecrawl-keyless": fc.url },
    send: { "exa-keyless": fakeExa, parallel: fakeParallel },
    guard: { fetch: (url, options) => publicFetch(url, { lookup: net.lookup, fetchImpl: net.fetchImpl, ...options }), check: (url, options) => publicCheck(url, { lookup: net.lookup, ...options }), html: readPage },
    native: async (query, n) => (native.calls++, native.next(query, n)),
    pay: async (fee, send) => {
      cap.fees.push(fee);
      if (cap.refuse) throw new web.PaidRefused(cap.refuse);
      return send();
    },
    words: WORDS,
    now: () => clock.now,
  };
  const asked = async () => ({
    firecrawl: fc.toolCalls().length,
    exa: (await lines(files.exa)).filter((call) => call.method === "tools/call").length,
    parallel: (await lines(files.parallel)).length,
    native: native.calls,
    dialled: net.dialled.length,
  });
  return { fc, net, clock, native, cap, config, asked };
}

/** Each step on `w` (a search of `query`, or a fetch of `url` and `part`), the clock at `at` ms past the start and the
 *  fakes' variables `set` first: its answer, the fakes it reached (`asks`), the receipt's turns (`tries`) and provider
 *  (`by`), and its cost (`usd`) where the step names one. A search step's `options` are its call's. */
async function run(f, w, steps, label) {
  for (const [i, step] of steps.entries()) {
    const at = `${label} step ${i + 1}`;
    Object.assign(process.env, step.set ?? {});
    if (step.at !== undefined) f.clock.now = START + step.at;
    const before = await f.asked();
    const { answer, receipt } = step.url === undefined ? await w.search(step.query, step.options) : await w.fetch(step.url, step.part ?? {});
    const after = await f.asked();
    const reached = Object.keys(after).filter((fake) => after[fake] > before[fake]).sort();
    const names = { "firecrawl-keyless": "firecrawl", "exa-keyless": "exa", parallel: "parallel", native: "native", direct: "dialled" };
    assert.deepEqual(reached, step.asks.map((provider) => names[provider]).sort(), `${at}: reached ${step.asks}`);
    assert.deepEqual(receipt.tries.map((one) => [one.provider, one.outcome]), step.tries, `${at}: the receipt's turns`);
    assert.equal(receipt.provider, step.by, `${at}: answered by ${step.by}`);
    if (step.usd !== undefined) assert.equal(receipt.cost.usd, step.usd, `${at}: cost`);
    step.check?.(answer, receipt);
  }
}

test("keyless Firecrawl with Exa behind it: Firecrawl answers; its rate limit passes the call to Exa and holds Firecrawl for its wait; past it Firecrawl answers again; out of quota it is off for the Web", async (t) => {
  const firecrawl = (name, n) => (name !== "firecrawl_search" ? undefined : n === 2 ? refusal("KEYLESS_LIMIT_REACHED", { retryAfter: 30 }) : n === 4 ? refusal("KEYLESS_QUOTA_EXHAUSTED") : undefined);
  const f = await fakes(t, firecrawl);
  process.env.AGENTRUN_TEST_FAUX_EXA = "ok";
  const w = web.createWeb({ ...f.config, order: { search: ["firecrawl-keyless", "exa-keyless"], fetch: [] } });
  await run(f, w, [
    { query: "widgets", at: 0, asks: ["firecrawl-keyless"], tries: [["firecrawl-keyless", "ok"]], by: "firecrawl-keyless" },
    { query: "gadgets", at: 0, asks: ["firecrawl-keyless", "exa-keyless"], tries: [["firecrawl-keyless", "error"], ["exa-keyless", "ok"]], by: "exa-keyless" },
    { query: "sprockets", at: 10_000, asks: ["exa-keyless"], tries: [["firecrawl-keyless", "held"], ["exa-keyless", "ok"]], by: "exa-keyless" },
    { query: "widgets", at: 31_000, asks: ["firecrawl-keyless"], tries: [["firecrawl-keyless", "ok"]], by: "firecrawl-keyless" },
    { query: "gadgets", at: 31_000, asks: ["firecrawl-keyless", "exa-keyless"], tries: [["firecrawl-keyless", "error"], ["exa-keyless", "ok"]], by: "exa-keyless" },
    { query: "sprockets", at: 100_000, asks: ["exa-keyless"], tries: [["firecrawl-keyless", "held"], ["exa-keyless", "ok"]], by: "exa-keyless" },
  ], "firecrawl-keyless");
  const hello = f.fc.got.find((one) => one.body.method === "initialize");
  assert.equal(hello.body.params.clientInfo.name, "agentrun-web", "the MCP client names web, never a server");
});

/** Fails when a call's answer or receipt carries any of Firecrawl's daily-limit words addressed to the agent. */
const unsaid = (answer, receipt) => {
  const text = JSON.stringify({ answer, receipt });
  for (const words of FIRECRAWL_DAILY_INJECTION) assert.ok(!text.includes(words), `"${words}" is never passed on`);
};

for (const where of ["search", "scrape", "rpc"]) {
  test(`keyless Firecrawl's daily limit (${where === "rpc" ? "a JSON-RPC error" : `as firecrawl_${where} served it`}): a quota until 00:00 UTC, Exa answers, Firecrawl is unasked until then and asked again at it`, async (t) => {
    const f = await fakes(t, (name, n) => (name === "firecrawl_search" && n === 1 ? dailyLimit(where) : undefined));
    process.env.AGENTRUN_TEST_FAUX_EXA = "ok";
    const w = web.createWeb({ ...f.config, order: { search: ["firecrawl-keyless", "exa-keyless"], fetch: [] } });
    const midnight = Date.parse("2026-11-25T00:00:00Z") - START;
    await run(f, w, [
      { query: "widgets", at: 0, asks: ["firecrawl-keyless", "exa-keyless"], tries: [["firecrawl-keyless", "error"], ["exa-keyless", "ok"]], by: "exa-keyless", check: (answer, receipt) => (assert.deepEqual(receipt.tries[0].limit, { kind: "quota", retryAfter: "Wed, 25 Nov 2026 00:00:00 GMT" }), unsaid(answer, receipt)) },
      { query: "gadgets", at: 16 * 60_000, asks: ["exa-keyless"], tries: [["firecrawl-keyless", "held"], ["exa-keyless", "ok"]], by: "exa-keyless" },
      { query: "sprockets", at: midnight - 1, asks: ["exa-keyless"], tries: [["firecrawl-keyless", "held"], ["exa-keyless", "ok"]], by: "exa-keyless" },
      { query: "widgets", at: midnight, asks: ["firecrawl-keyless"], tries: [["firecrawl-keyless", "ok"]], by: "firecrawl-keyless" },
    ], `firecrawl daily (${where})`);
  });
}

test("keyless Firecrawl alone, past its daily limit: the search answers in our words alone", async (t) => {
  const f = await fakes(t, (name) => (name === "firecrawl_search" ? dailyLimit("search") : undefined));
  const w = web.createWeb({ ...f.config, order: { search: ["firecrawl-keyless"], fetch: [] } });
  await run(f, w, [{ query: "widgets", at: 0, asks: ["firecrawl-keyless"], tries: [["firecrawl-keyless", "error"]], by: null, check: unsaid }], "firecrawl daily alone");
});

test("a fetch past keyless Firecrawl's daily limit (as firecrawl_scrape served it) goes direct, in our words alone; Firecrawl is unasked until 00:00 UTC and asked again at it", async (t) => {
  const f = await fakes(t, (name, n) => (name === "firecrawl_scrape" && n === 1 ? dailyLimit("scrape") : undefined));
  const w = web.createWeb({ ...f.config, order: { search: [], fetch: ["firecrawl-keyless", "direct"] } });
  const midnight = Date.parse("2026-11-25T00:00:00Z") - START;
  await run(f, w, [
    { url: PUBLIC, at: 0, asks: ["firecrawl-keyless", "direct"], tries: [["firecrawl-keyless", "error"], ["direct", "ok"]], by: "direct", check: unsaid },
    { url: NOTES, at: 16 * 60_000, asks: ["direct"], tries: [["firecrawl-keyless", "held"], ["direct", "ok"]], by: "direct" },
    { url: `${PUBLIC}?run=a`, at: midnight - 1, asks: ["direct"], tries: [["firecrawl-keyless", "held"], ["direct", "ok"]], by: "direct" },
    { url: `${PUBLIC}?run=b`, at: midnight, asks: ["firecrawl-keyless"], tries: [["firecrawl-keyless", "ok"]], by: "firecrawl-keyless" },
  ], "fetch firecrawl daily");
});

test("keyless Exa alone: its free limit answers the caller's words and holds it for the Retry-After it named; past it Exa is asked again", async (t) => {
  const f = await fakes(t);
  process.env.AGENTRUN_TEST_FAUX_EXA = "ok,429";
  const w = web.createWeb({ ...f.config, order: { search: ["exa-keyless"], fetch: [] } });
  await run(f, w, [
    { query: "widgets", at: 0, asks: ["exa-keyless"], tries: [["exa-keyless", "ok"]], by: "exa-keyless" },
    { query: "gadgets", at: 0, asks: ["exa-keyless"], tries: [["exa-keyless", "error"]], by: null, check: (answer) => assert.deepEqual(answer, { error: WORDS.rateLimited }) },
    { query: "sprockets", at: 10_000, asks: [], tries: [["exa-keyless", "held"]], by: null, check: (answer) => assert.equal(answer.error, searchBusy(20)) },
    { query: "widgets", at: 31_000, asks: ["exa-keyless"], tries: [["exa-keyless", "error"]], by: null },
  ], "exa-keyless");
});

test("keyless Exa past its daily count, a 429 naming a wait of 65,796 s (Exa's answer on 2026-11-24): off and unasked for that whole wait, the call saying search is unavailable, never to try again; past the wait Exa is asked again", async (t) => {
  const f = await fakes(t);
  process.env.AGENTRUN_TEST_FAUX_EXA = "429:65796,ok";
  const w = web.createWeb({ ...f.config, order: { search: ["exa-keyless"], fetch: [] } });
  const unavailable = (answer) => assert.deepEqual(answer, { error: SEARCH_UNAVAILABLE });
  await run(f, w, [
    { query: "widgets", at: 0, asks: ["exa-keyless"], tries: [["exa-keyless", "error"]], by: null, check: unavailable },
    { query: "gadgets", at: 16 * 60_000, asks: [], tries: [["exa-keyless", "held"]], by: null, check: unavailable },
    { query: "sprockets", at: 65_795_000, asks: [], tries: [["exa-keyless", "held"]], by: null, check: unavailable },
    { query: "widgets", at: 65_796_000, asks: ["exa-keyless"], tries: [["exa-keyless", "ok"]], by: "exa-keyless" },
  ], "exa-keyless daily");
});

test("Parallel on the run's key, each search sent through the cap at its price: a 429 holds it for its Retry-After, a 402 turns it off", async (t) => {
  const f = await fakes(t);
  process.env.AGENTRUN_TEST_FAUX_PARALLEL_SEARCH = "ok;429@20;402";
  const price = web.PARALLEL_SEARCH_USD;
  const w = web.createWeb({ ...f.config, keys: { parallel: CANARY }, order: { search: ["parallel"], fetch: [] } });
  await run(f, w, [
    { query: "widgets", at: 0, asks: ["parallel"], tries: [["parallel", "ok"]], by: "parallel", usd: price },
    { query: "gadgets", at: 0, asks: ["parallel"], tries: [["parallel", "error"]], by: null, usd: price },
    { query: "sprockets", at: 5_000, asks: [], tries: [["parallel", "held"]], by: null, usd: 0, check: (answer) => assert.equal(answer.error, searchBusy(15)) },
    { query: "widgets", at: 21_000, asks: ["parallel"], tries: [["parallel", "error"]], by: null, usd: price },
    { query: "gadgets", at: 22_000, asks: [], tries: [["parallel", "held"]], by: null, usd: 0, check: (answer) => assert.equal(answer.error, SEARCH_UNAVAILABLE) },
  ], "parallel");
  assert.deepEqual(f.cap.fees.map((fee) => fee.usd), [price, price, price], "the cap was asked once for each search sent");
});

test("a search the cap refuses is never sent: it answers the cap's words, at no cost", async (t) => {
  const f = await fakes(t);
  f.cap.refuse = "the run's cap does not hold this search";
  const w = web.createWeb({ ...f.config, keys: { parallel: CANARY }, order: { search: ["parallel"], fetch: [] } });
  await run(f, w, [{ query: "widgets", asks: [], tries: [["parallel", "error"]], by: null, usd: 0, check: (answer) => assert.deepEqual(answer, { error: f.cap.refuse }) }], "refused");
});

test("Parallel's client refuses an endpoint with no price before the cap is asked, as PaidRefused", async (t) => {
  const f = await fakes(t);
  const client = web.parallelExtract(CANARY, fakeParallel, f.config.pay);
  await assert.rejects(client.post("https://api.parallel.ai/v1/tasks/runs", { input: "widgets" }), (error) => error instanceof web.PaidRefused && error.name === "PaidRefused" && /no price here/.test(error.message));
  assert.deepEqual(f.cap.fees, [], "the cap was not asked");
  assert.equal((await f.asked()).parallel, 0, "nothing reached Parallel");
});

test("a native search, injected: a rate limit it answers holds it for the default wait, past which it answers again", async (t) => {
  const f = await fakes(t);
  const ok = f.native.next;
  let n = 0;
  f.native.next = (...args) => ((n += 1) === 2 ? { answer: { error: "rate-limited by the provider" }, limit: { kind: "rate" } } : ok(...args));
  const w = web.createWeb({ ...f.config, order: { search: ["native"], fetch: [] } });
  await run(f, w, [
    { query: "widgets", at: 0, asks: ["native"], tries: [["native", "ok"]], by: "native" },
    { query: "gadgets", at: 0, asks: ["native"], tries: [["native", "error"]], by: null },
    { query: "sprockets", at: 10_000, asks: [], tries: [["native", "held"]], by: null },
    { query: "widgets", at: 61_000, asks: ["native"], tries: [["native", "ok"]], by: "native" },
  ], "native");
});

test("each Web holds its own breakers: one turned off leaves another Web's closed", async (t) => {
  const f = await fakes(t);
  process.env.AGENTRUN_TEST_FAUX_PARALLEL_SEARCH = "402;ok";
  const one = web.createWeb({ ...f.config, keys: { parallel: CANARY }, order: { search: ["parallel"], fetch: [] } });
  const two = web.createWeb({ ...f.config, keys: { parallel: CANARY }, order: { search: ["parallel"], fetch: [] } });
  await run(f, one, [{ query: "widgets", asks: ["parallel"], tries: [["parallel", "error"]], by: null }, { query: "widgets", asks: [], tries: [["parallel", "held"]], by: null }], "one");
  await run(f, two, [{ query: "widgets", asks: ["parallel"], tries: [["parallel", "ok"]], by: "parallel" }], "two");
});

test("a call given its own breakers reads and trips those alone: the Web's stay closed, and the call's hold for the next call given them", async (t) => {
  const f = await fakes(t);
  process.env.AGENTRUN_TEST_FAUX_PARALLEL_SEARCH = "402;ok";
  const w = web.createWeb({ ...f.config, keys: { parallel: CANARY }, order: { search: ["parallel"], fetch: [] } });
  const call = { breakers: web.breakers(() => f.clock.now) };
  await run(f, w, [
    { query: "widgets", options: call, asks: ["parallel"], tries: [["parallel", "error"]], by: null },
    { query: "widgets", asks: ["parallel"], tries: [["parallel", "ok"]], by: "parallel" },
    { query: "widgets", options: call, asks: [], tries: [["parallel", "held"]], by: null },
  ], "breakers");
});

test("a search answer too long for one result leaves out its least relevant results, as the model reads it", async (t) => {
  const f = await fakes(t);
  const long = Array.from({ length: 25 }, (_, i) => ({ url: `https://long.example/${i}`, title: `Result ${i}`, snippet: "x".repeat(5_000) }));
  f.native.next = () => ({ answer: { provider: "native", query: "q", results: long } });
  const w = web.createWeb({ ...f.config, order: { search: ["native"], fetch: [] } });
  const { answer, receipt } = await w.search("widgets");
  assert.deepEqual(answer, web.fitSearch(answer), "the answer is already fitted");
  assert.ok(answer.omitted > 0, "its least relevant results are left out");
  assert.ok(receipt.out.chars <= web.SEARCH_MAX_CHARS, "within the bound");
});

test("keyless Firecrawl with the direct fetch behind it: Firecrawl reads a public page, the Web's pages answer its next part, a private host goes to neither, and Firecrawl out of quota passes the page to the direct fetch", async (t) => {
  const firecrawl = (name, n) => (name === "firecrawl_scrape" && n === 2 ? refusal("KEYLESS_QUOTA_EXHAUSTED") : undefined);
  const f = await fakes(t, firecrawl);
  const w = web.createWeb({ ...f.config, order: { search: [], fetch: ["firecrawl-keyless", "direct"] } });
  await run(f, w, [
    { url: PUBLIC, asks: ["firecrawl-keyless"], tries: [["firecrawl-keyless", "ok"]], by: "firecrawl-keyless" },
    { url: PUBLIC, part: { offset: 10 }, asks: [], tries: [], by: "firecrawl-keyless", check: (_answer, receipt) => assert.equal(receipt.cache, "hit") },
    { url: EVIL, asks: [], tries: [["firecrawl-keyless", "error"], ["direct", "error"]], by: null, check: (answer, receipt) => {
      assert.match(answer.refused, /^refused: evil\.example is not a public host/);
      assert.equal(receipt.tries[0].failure?.code, "GUARD", "keyless Firecrawl's turn is the guard's refusal");
    } },
    { url: NOTES, asks: ["firecrawl-keyless", "direct"], tries: [["firecrawl-keyless", "error"], ["direct", "ok"]], by: "direct" },
    { url: `${PUBLIC}?run=a`, asks: ["direct"], tries: [["firecrawl-keyless", "held"], ["direct", "ok"]], by: "direct" },
  ], "fetch firecrawl-keyless");
});

test("Parallel's extract on the run's key with the direct fetch behind it: a public page is a paid read, a private one never goes, a page it lists in errors is fetched directly, and a refused key keeps it unasked", async (t) => {
  const f = await fakes(t);
  const price = web.PARALLEL_EXTRACT_USD;
  const mode = (value) => ({ AGENTRUN_TEST_FAUX_PARALLEL_EXTRACT: value });
  const w = web.createWeb({ ...f.config, keys: { parallel: CANARY }, order: { search: [], fetch: ["parallel", "direct"] } });
  await run(f, w, [
    { url: PUBLIC, set: mode(""), asks: ["parallel"], tries: [["parallel", "ok"]], by: "parallel", usd: price },
    { url: EVIL, set: mode(""), asks: [], tries: [["parallel", "error"], ["direct", "error"]], by: null, usd: 0, check: (answer) => assert.equal(answer.parallel, "not tried: the URL did not pass the public-host guard") },
    { url: NOTES, set: mode("errors"), asks: ["parallel", "direct"], tries: [["parallel", "error"], ["direct", "ok"]], by: "direct", usd: price },
    { url: `${PUBLIC}?run=a`, set: mode("401"), asks: ["parallel", "direct"], tries: [["parallel", "error"], ["direct", "ok"]], by: "direct", usd: price },
    { url: `${PUBLIC}?run=b`, set: mode(""), asks: ["direct"], tries: [["parallel", "error"], ["direct", "ok"]], by: "direct", usd: 0, check: (answer) => assert.equal(answer.parallel, "not tried: refused earlier in this run") },
  ], "fetch parallel");
});

test("Parallel in the order with no key: the page is fetched directly and says Parallel was not tried", async (t) => {
  const f = await fakes(t);
  const w = web.createWeb({ ...f.config, order: { search: [], fetch: ["parallel", "direct"] } });
  await run(f, w, [{ url: PUBLIC, asks: ["direct"], tries: [["parallel", "error"], ["direct", "ok"]], by: "direct", usd: 0, check: (answer) => assert.equal(answer.parallel, "not tried: this run holds no Parallel key") }], "no key");
});

test("a fetch's receipt names every provider it asked: Firecrawl failing ahead of Parallel's page, and Firecrawl failing with nothing behind it", async (t) => {
  const f = await fakes(t, (name) => (name === "firecrawl_scrape" ? refusal("KEYLESS_QUOTA_EXHAUSTED") : undefined));
  const both = web.createWeb({ ...f.config, keys: { parallel: CANARY }, order: { search: [], fetch: ["firecrawl-keyless", "parallel"] } });
  await run(f, both, [{ url: PUBLIC, set: { AGENTRUN_TEST_FAUX_PARALLEL_EXTRACT: "" }, asks: ["firecrawl-keyless", "parallel"], tries: [["firecrawl-keyless", "error"], ["parallel", "ok"]], by: "parallel" }], "firecrawl then parallel");
  const alone = web.createWeb({ ...f.config, order: { search: [], fetch: ["firecrawl-keyless"] } });
  await run(f, alone, [{ url: PUBLIC, asks: ["firecrawl-keyless"], tries: [["firecrawl-keyless", "error"]], by: null }], "firecrawl alone");
});

test("a fetch's receipt lists its turns in the order they were taken: Firecrawl failing ahead of Parallel's page with the direct fetch behind them, and Parallel then Firecrawl failing ahead of the direct fetch", async (t) => {
  const f = await fakes(t, (name) => (name === "firecrawl_scrape" ? refusal("KEYLESS_QUOTA_EXHAUSTED") : undefined));
  const mode = (value) => ({ AGENTRUN_TEST_FAUX_PARALLEL_EXTRACT: value });
  const firecrawlFirst = web.createWeb({ ...f.config, keys: { parallel: CANARY }, order: { search: [], fetch: ["firecrawl-keyless", "parallel", "direct"] } });
  await run(f, firecrawlFirst, [{ url: PUBLIC, set: mode(""), asks: ["firecrawl-keyless", "parallel"], tries: [["firecrawl-keyless", "error"], ["parallel", "ok"]], by: "parallel" }], "firecrawl, parallel, direct");
  const parallelFirst = web.createWeb({ ...f.config, keys: { parallel: CANARY }, order: { search: [], fetch: ["parallel", "firecrawl-keyless", "direct"] } });
  await run(f, parallelFirst, [{ url: PUBLIC, set: mode("errors"), asks: ["parallel", "firecrawl-keyless", "direct"], tries: [["parallel", "error"], ["firecrawl-keyless", "error"], ["direct", "ok"]], by: "direct" }], "parallel, firecrawl, direct");
});

test("Parallel in the order with no key, behind a Firecrawl that reads the page: the page and its receipt are Firecrawl's alone, with no word of Parallel or of a direct fetch", async (t) => {
  const f = await fakes(t);
  const w = web.createWeb({ ...f.config, order: { search: [], fetch: ["firecrawl-keyless", "parallel", "direct"] } });
  await run(f, w, [{ url: PUBLIC, asks: ["firecrawl-keyless"], tries: [["firecrawl-keyless", "ok"]], by: "firecrawl-keyless", check: (answer) => {
    assert.equal(answer.parallel, undefined, "no Parallel note on Firecrawl's page");
    assert.doesNotMatch(web.webFetchText(answer), /fetched directly/);
  } }], "no key, firecrawl reads");
});

test("Parallel in the order with no key and Firecrawl refused, nothing behind them: the failed page never says it was fetched directly, and its receipt names both", async (t) => {
  const f = await fakes(t, (name) => (name === "firecrawl_scrape" ? refusal("KEYLESS_QUOTA_EXHAUSTED") : undefined));
  const w = web.createWeb({ ...f.config, order: { search: [], fetch: ["firecrawl-keyless", "parallel"] } });
  const { answer, receipt } = await w.fetch(PUBLIC);
  const text = web.webFetchText(answer);
  assert.doesNotMatch(text, /fetched directly/, "nothing was fetched directly");
  assert.match(text, /\nParallel was picked for web_fetch and gave no page \(not tried: this run holds no Parallel key\); no provider after it read the page\.$/);
  assert.equal(answer.via, "none");
  assert.deepEqual(receipt.tries.map(({ provider, outcome }) => [provider, outcome]), [["firecrawl-keyless", "error"], ["parallel", "error"]]);
  assert.equal(receipt.tries[1]?.error, "not tried: this run holds no Parallel key");
  assert.equal(receipt.provider, null);
  assert.deepEqual(await f.asked(), { firecrawl: 1, exa: 0, parallel: 0, native: 0, dialled: 0 });
});

test("the direct fetch alone: a public page read, a private host refused undialled, and a part no call may ask for refused before anything is fetched", async (t) => {
  const f = await fakes(t);
  const w = web.createWeb({ ...f.config, order: { search: [], fetch: ["direct"] } });
  await run(f, w, [
    { url: PUBLIC, asks: ["direct"], tries: [["direct", "ok"]], by: "direct", check: (answer) => assert.equal(answer.title, "Public page") },
    { url: EVIL, asks: [], tries: [["direct", "error"]], by: null },
    { url: NOTES, part: { maxChars: 1 }, asks: [], tries: [], by: null, check: (answer) => assert.equal(answer.error, "max_chars must be at least 200 (it was 1)") },
  ], "fetch direct");
});

test("with no guard given nothing is fetched and no URL goes to a provider", async (t) => {
  const f = await fakes(t);
  const { guard: _none, ...unguarded } = f.config;
  const w = web.createWeb({ ...unguarded, keys: { parallel: CANARY }, order: { search: [], fetch: ["firecrawl-keyless", "parallel", "direct"] } });
  const { answer } = await w.fetch(PUBLIC);
  assert.equal(answer.ok, false);
  assert.deepEqual(await f.asked(), { firecrawl: 0, exa: 0, parallel: 0, native: 0, dialled: 0 });
});

test("a fetch call brings no guard of its own: one passed with the call (a check that passes everything, its bound, an order) is never asked, and the Web with none fetches nothing", async (t) => {
  const f = await fakes(t);
  const { guard: _none, ...unguarded } = f.config;
  const w = web.createWeb({ ...unguarded, keys: { parallel: CANARY }, order: { search: [], fetch: ["firecrawl-keyless", "parallel", "direct"] } });
  const asked = [];
  const permissive = { fetch: async (url) => (asked.push(["fetch", url]), { url, status: 200, contentType: "text/plain", body: "read anyway" }), check: async (url) => void asked.push(["check", url]) };
  const { answer } = await w.fetch(PUBLIC, { guard: permissive, checkMs: 60_000, order: ["direct"] });
  assert.equal(answer.ok, false, JSON.stringify(answer));
  assert.deepEqual(asked, [], "the call's guard is never asked");
  assert.deepEqual(await f.asked(), { firecrawl: 0, exa: 0, parallel: 0, native: 0, dialled: 0 });
});

// WHATWG reads a backslash in an http URL as a slash, so the guard checks public.example; a parser that does not would
// read "public.example\" as a user name and evil.example (a private address here) as the host.
test("a provider is sent the URL the guard checked, as parsed, never the string as asked", async (t) => {
  const f = await fakes(t, (name) => (name === "firecrawl_scrape" ? refusal("KEYLESS_QUOTA_EXHAUSTED") : undefined));
  const w = web.createWeb({ ...f.config, keys: { parallel: CANARY }, order: { search: [], fetch: ["firecrawl-keyless", "parallel"] } });
  const asked = "http://public.example\\@evil.example/";
  const checked = "http://public.example/@evil.example/";
  assert.equal(new URL(asked).href, checked);
  const { receipt } = await w.fetch(asked);
  assert.deepEqual(f.fc.toolCalls().map((one) => one.body.params.arguments.url), [checked], "Firecrawl is sent the parsed URL");
  assert.deepEqual(receipt.tries.map((one) => [one.provider, one.outcome]), [["firecrawl-keyless", "error"], ["parallel", "ok"]], "the receipt names both providers asked");
  const extracts = (await lines(process.env.AGENTRUN_TEST_FAUX_PARALLEL_CALLS)).filter((call) => call.urls);
  assert.deepEqual(extracts.map((call) => call.urls), [[checked]], "Parallel is sent the parsed URL");
});

test("a URL short as asked but longer than 4,096 characters as sent (its href) is refused unsent, by the providers and by the direct fetch", async (t) => {
  const f = await fakes(t);
  const url = `${PUBLIC}${"\u00e9".repeat(1_500)}`;
  assert.ok(url.length < web.URL_MAX && new URL(url).href.length > web.URL_MAX, "short as asked, long as sent");
  const providers = web.createWeb({ ...f.config, keys: { parallel: CANARY }, order: { search: [], fetch: ["firecrawl-keyless", "parallel"] } });
  await run(f, providers, [{ url, asks: [], tries: [["firecrawl-keyless", "error"], ["parallel", "error"]], by: null }], "providers");
  const direct = web.createWeb({ ...f.config, order: { search: [], fetch: ["direct"] } });
  await run(f, direct, [{ url, asks: [], tries: [["direct", "error"]], by: null, check: (answer) => assert.equal(answer.error, "url is longer than 4,096 characters") }], "direct");
});

test("Parallel passed over for a URL it may not be sent says the real reason, in the direct fetch's words: an href too long, a port, a user name and password", async (t) => {
  const f = await fakes(t);
  const credentialed = new URL(PUBLIC);
  credentialed.username = "u";
  credentialed.password = "p";
  const cases = [
    [`${PUBLIC}${"é".repeat(1_500)}`, "url is longer than 4,096 characters"],
    ["http://public.example:8080/", "port 8080 is not 80 or 443"],
    [credentialed.href, "the URL holds a user name or password"],
  ];
  const w = web.createWeb({ ...f.config, keys: { parallel: CANARY }, order: { search: [], fetch: ["parallel", "direct"] } });
  for (const [url, why] of cases) {
    const at = why.split(" ").slice(0, 2).join(" ");
    await run(f, w, [{ url, asks: [], tries: [["parallel", "error"], ["direct", "error"]], by: null, usd: 0, check: (answer, receipt) => {
      assert.equal(answer.parallel, `not tried: ${why}`, `${at}: the page says why Parallel was not tried`);
      assert.equal(receipt.tries[0].error, `not tried: ${why}`, `${at}: the receipt says why Parallel was not tried`);
      assert.doesNotMatch(web.webFetchText(answer), /public-host guard/, `${at}: no word of the guard, which was never asked`);
    } }], at);
  }
});

// undici's fetch builds a Request for each hop, and Request refuses a URL holding a user name or password with an error
// that quotes the URL whole. The transport here builds one too (Node's Request is undici's), so the refusal and its
// words are undici's own.
test("a public page redirecting to a URL that holds a user name and password: neither the receipt's turns nor the page the model reads quote them", async (t) => {
  const f = await fakes(t);
  const moved = "http://public.example/moved";
  const target = new URL(PUBLIC);
  target.username = "web-user";
  target.password = "not-a-secret";
  const fetchImpl = async (url, init) => {
    new Request(url);
    if (String(url) === moved) return new Response(null, { status: 302, headers: { location: target.href } });
    return f.net.fetchImpl(url, init);
  };
  const w = web.createWeb({ ...f.config, order: { search: [], fetch: ["direct"] } });
  const { answer, receipt } = await w.fetch(moved, { fetchImpl });
  const text = web.webFetchText(answer);
  assert.match(text, /includes credentials/, "the page says undici refused the redirect's URL");
  assert.deepEqual(receipt.tries.map((one) => [one.provider, one.outcome]), [["direct", "error"]]);
  for (const one of receipt.tries) assert.doesNotMatch(one.error ?? "", /web-user|not-a-secret/, "the receipt's turn quotes no user name or password");
  assert.doesNotMatch(text, /web-user|not-a-secret/, "the page the model reads quotes no user name or password");
});

// A call stops waiting at its signal; the read it started is the run's and goes on. Here the read waits on the guard's
// name lookup for Parallel (released by hand) when the call is stopped, then Parallel reads the page and is paid.
test("a fetch stopped while the guard checks its URL for Parallel: the receipt it returned stays as it was, though the read goes on and pays", async (t) => {
  const f = await fakes(t);
  process.env.AGENTRUN_TEST_FAUX_PARALLEL_EXTRACT = "";
  let reached;
  const atLookup = new Promise((resolve) => (reached = resolve));
  let release;
  const released = new Promise((resolve) => (release = resolve));
  const lookup = async (host) => (reached(), await released, f.net.lookup(host));
  const w = web.createWeb({ ...f.config, keys: { parallel: CANARY }, order: { search: [], fetch: ["parallel", "direct"] } });
  const stop = new AbortController();
  const calling = w.fetch(PUBLIC, { lookup, signal: stop.signal });
  await atLookup;
  stop.abort();
  const { answer, receipt } = await calling;
  assert.equal(answer.via, "stopped");
  assert.deepEqual([receipt.provider, receipt.tries, receipt.cost], [null, [], { usd: 0, lines: [] }], "nothing answered or was paid before the call returned");
  const atReturn = structuredClone(receipt);
  release();
  const later = await w.fetch(PUBLIC);
  assert.equal(later.answer.via, "parallel", "the read went on, and Parallel read the page");
  assert.equal(f.cap.fees.length, 1, "Parallel's read was paid, after the stopped call returned");
  assert.deepEqual(receipt.cost.lines, atReturn.cost.lines, "the stopped call's receipt: cost.lines as at its return");
  assert.equal(receipt.cost.usd, atReturn.cost.usd, "the stopped call's receipt: cost.usd as at its return");
  assert.deepEqual(receipt.tries, atReturn.tries, "the stopped call's receipt: tries as at its return");
  assert.deepEqual(receipt, atReturn, "the stopped call's receipt, as at its return");
});

test("the package's root entry is its named API: none of the internals it is built from", async () => {
  const names = Object.keys(await import("../dist/index.js"));
  // What the root is built from, and the words and codes its answers carry (SEARCH_UNAVAILABLE, HELD_CODE): none is API.
  const internal = ["sleep", "callTool", "textBlocks", "MAX_BYTES", "PROTOCOL", "TIMEOUT_MS", "retryAfterMs", "waitOf", "searchBusy", "partOfRead", "markdownRead", "isRefused", "SEARCH_UNAVAILABLE", "HELD_CODE"];
  assert.deepEqual(internal.filter((name) => names.includes(name)), [], "an internal on the root");
  for (const name of ["createWeb", "webFetch", "webFetchText", "fetchPage", "askedUrl", "searchInTurn", "breakers", "linksOf", "parallelExtract", "parallelSearched", "exaSearch", "firecrawlSearch", "firecrawlScrape", "firecrawlFetch", "PaidRefused", "readerOf", "parallelReads", "searchBreaker", "holdingWords"]) assert.ok(names.includes(name), name);
});
