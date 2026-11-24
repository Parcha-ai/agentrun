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
import { answers, firecrawlServer, refusal } from "./fixtures/fake-firecrawl.mjs";
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

test("keyless Exa alone: its free limit answers the caller's words and holds it for the Retry-After it named; past it Exa is asked again", async (t) => {
  const f = await fakes(t);
  process.env.AGENTRUN_TEST_FAUX_EXA = "ok,429";
  const w = web.createWeb({ ...f.config, order: { search: ["exa-keyless"], fetch: [] } });
  await run(f, w, [
    { query: "widgets", at: 0, asks: ["exa-keyless"], tries: [["exa-keyless", "ok"]], by: "exa-keyless" },
    { query: "gadgets", at: 0, asks: ["exa-keyless"], tries: [["exa-keyless", "error"]], by: null, check: (answer) => assert.deepEqual(answer, { error: WORDS.rateLimited }) },
    { query: "sprockets", at: 10_000, asks: [], tries: [["exa-keyless", "held"]], by: null, check: (answer) => assert.equal(answer.error, web.searchBusy(20)) },
    { query: "widgets", at: 31_000, asks: ["exa-keyless"], tries: [["exa-keyless", "error"]], by: null },
  ], "exa-keyless");
});

test("Parallel on the run's key, each search sent through the cap at its price: a 429 holds it for its Retry-After, a 402 turns it off", async (t) => {
  const f = await fakes(t);
  process.env.AGENTRUN_TEST_FAUX_PARALLEL_SEARCH = "ok;429@20;402";
  const price = web.PARALLEL_SEARCH_USD;
  const w = web.createWeb({ ...f.config, keys: { parallel: CANARY }, order: { search: ["parallel"], fetch: [] } });
  await run(f, w, [
    { query: "widgets", at: 0, asks: ["parallel"], tries: [["parallel", "ok"]], by: "parallel", usd: price },
    { query: "gadgets", at: 0, asks: ["parallel"], tries: [["parallel", "error"]], by: null, usd: price },
    { query: "sprockets", at: 5_000, asks: [], tries: [["parallel", "held"]], by: null, usd: 0, check: (answer) => assert.equal(answer.error, web.searchBusy(15)) },
    { query: "widgets", at: 21_000, asks: ["parallel"], tries: [["parallel", "error"]], by: null, usd: price },
    { query: "gadgets", at: 22_000, asks: [], tries: [["parallel", "held"]], by: null, usd: 0, check: (answer) => assert.equal(answer.error, web.SEARCH_UNAVAILABLE) },
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
    { url: EVIL, asks: [], tries: [["direct", "error"]], by: null, check: (answer) => assert.match(answer.refused, /^refused: evil\.example is not a public host/) },
    { url: NOTES, asks: ["firecrawl-keyless", "direct"], tries: [["firecrawl-keyless", "error"], ["direct", "ok"]], by: "direct" },
    { url: `${PUBLIC}?run=a`, asks: ["direct"], tries: [["direct", "ok"]], by: "direct" },
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
