// One way for the web providers to do the same things. A thrown failure is typed one way by every provider: the bound
// running out is TIMEOUT, a stop (an AbortError, or the caller's signal stopped) is STOPPED, anything else CONNECT in
// words that name no URL's user name or password, cut at 300. Keyed and keyless Firecrawl read a page's metadata one
// way, an array title's first string kept by both. The page guard's check two fetches of one page share is stopped
// only once every fetch waiting on it has stopped.
import assert from "node:assert/strict";
import { test } from "node:test";
import { publicCheck, publicFetch, readPage } from "@parcha/pi-browser";
import * as web from "../dist/index.js";
import { cutAt, withoutUserinfo } from "../dist/page.js";
import { decideWeb, PUBLIC, TASK } from "./fixtures/decide-runs.mjs";
import { firecrawlServer } from "./fixtures/fake-firecrawl.mjs";
import { firecrawlPage, keyedServer } from "./fixtures/fake-keyed.mjs";
import { network } from "./fixtures/fake-network.mjs";

const KEY = "providers-one-key-canary-3b7e";
const STOP = () => new DOMException("This operation was aborted", "AbortError");

/** A send that waits until its request's signal stops, then fails as fetch does: with the signal's reason. */
const untilStopped = (started) => (_url, init) => new Promise((_resolve, reject) => {
  started?.();
  init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
});

/** A web searching through `provider` alone on the run's key, its requests through `send`. */
const keyedWeb = (provider, send) => web.createWeb({ order: { search: [provider], fetch: [] }, keys: { [provider]: KEY }, send: { [provider]: send } });

test("keyed Exa and Firecrawl: a request stopped by an AbortError the caller's signal did not carry is typed STOPPED, never TIMEOUT", async () => {
  for (const [provider, who] of [["exa", "Exa"], ["firecrawl", "Firecrawl"]]) {
    const w = keyedWeb(provider, async () => { throw STOP(); });
    const { receipt } = await w.search({ objective: "widgets" });
    assert.deepEqual(receipt.tries[0].failure, { class: "infra", code: "STOPPED", message: `${who}'s search was stopped` }, `${who}: a stop reads as one`);
  }
});

test("keyed Exa: the caller's stop while its request is out is STOPPED; its own bound running out is TIMEOUT", async () => {
  const stop = new AbortController();
  const w = keyedWeb("exa", untilStopped(() => setImmediate(() => stop.abort())));
  const stopped = await w.search({ objective: "widgets" }, { signal: stop.signal });
  assert.deepEqual(stopped.receipt.tries[0].failure, { class: "infra", code: "STOPPED", message: "Exa's search was stopped" });
  const timedOut = keyedWeb("exa", async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); });
  assert.deepEqual((await timedOut.search({ objective: "widgets" })).receipt.tries[0].failure, { class: "infra", code: "TIMEOUT", message: "Exa's search did not answer in time" });
});

test("Parallel's search stopped by the caller while its request is out is STOPPED, as its extract's stop is, never CONNECT", async () => {
  const stop = new AbortController();
  const w = keyedWeb("parallel", untilStopped(() => setImmediate(() => stop.abort())));
  const { receipt } = await w.search({ objective: "widgets" }, { signal: stop.signal });
  assert.equal(stop.signal.aborted, true);
  assert.deepEqual(receipt.tries[0].failure, { class: "infra", code: "STOPPED", message: "Parallel's search was stopped" });
});

test("Parallel's search that failed by a thrown error names no URL's user name or password, and its words are cut at 300", async () => {
  const said = `proxy refused https://agent:pa55word@proxy.example/v1/search ${"x".repeat(600)}`;
  const w = keyedWeb("parallel", async () => { throw new TypeError(said); });
  const { answer, receipt } = await w.search({ objective: "widgets" });
  const words = `Parallel's search failed: ${cutAt(withoutUserinfo(said), 300)}`;
  assert.deepEqual(receipt.tries[0].failure, { class: "infra", code: "CONNECT", message: words });
  assert.equal(answer.error, words);
  assert.ok(!JSON.stringify({ answer, receipt }).includes("pa55word"), "the password is said nowhere");
});

test("keyless Firecrawl reads a page whose metadata title is a list by its first string, as keyed Firecrawl does", async (t) => {
  const markdown = "# Listed\n\nThe answer is forty-two.";
  const metadata = { title: ["Listed title", "Another"], sourceURL: PUBLIC, statusCode: 200 };
  const fc = await firecrawlServer(t, () => ({ content: [{ type: "text", text: JSON.stringify({ markdown, metadata }) }] }));
  const keyless = await web.firecrawlScrape(PUBLIC, { endpoint: fc.url });
  assert.equal(keyless.title, "Listed title", "keyless Firecrawl keeps the list's first title");
  const api = await keyedServer(t, (path) => (path === "/v2/scrape" ? { ...firecrawlPage(PUBLIC, markdown), json: { success: true, data: { markdown, metadata } } } : undefined));
  const net = network();
  const checked = { fetch: (url, options) => publicFetch(url, { lookup: net.lookup, fetchImpl: net.fetchImpl, ...options }), check: (url, options) => publicCheck(url, { lookup: net.lookup, ...options }), html: readPage };
  const w = web.createWeb({ order: { search: [], fetch: ["firecrawl"] }, keys: { firecrawl: KEY }, endpoints: { firecrawl: api.url }, guard: checked });
  const keyed = await w.fetch(PUBLIC);
  assert.deepEqual([keyed.answer.via, keyed.answer.title], ["firecrawl", "Listed title"], "keyed Firecrawl keeps it too");
});

/** A decider whose guard answers once `release` is called, and records the signal each guard request was asked under;
 *  its step answers at once. */
function heldGuard() {
  let release;
  const released = new Promise((resolve) => (release = resolve));
  let asked;
  const guardAsked = new Promise((resolve) => (asked = resolve));
  const signals = [];
  const CONTENT = { type: "choice", choice: "content", probabilities: { content: 0.93, login_wall: 0.04, paywall: 0.03 } };
  const provider = {
    id: "fake",
    needs: [],
    async decide(request, ctx) {
      const isGuard = Object.hasOwn(request.questions, "wall");
      if (isGuard) {
        signals.push(ctx.signal);
        asked();
        await released;
      }
      const answers = isGuard ? { wall: CONTENT, injection: { type: "noul", noul: 0.02 } } : Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: "noul", noul: 0.9 }]));
      return { answers, evidence: [], model: "fake-1", usage: null, cost_usd: 0.0001, cost_basis: "estimate", provider_request_id: null };
    },
  };
  const w = decideWeb({ decider: web.deciderFrom(provider, { price: { requestUsd: 0.0002 } }), pageGuard: true, bounds: { decideMs: 600_000 } });
  return { w, release, guardAsked, signals };
}

/** Turns of the event loop until `done()`, at most `turns` of them: work counted, never time. */
async function turnsUntil(done, turns = 200) {
  for (let turn = 0; turn < turns && !done(); turn++) await new Promise((resolve) => setImmediate(resolve));
}

test("the first fetch's stop does not stop the guard check a second fetch of the page waits on: the second gets the verdict", async () => {
  const { w, release, guardAsked, signals } = heldGuard();
  const stop = new AbortController();
  let firstEnded;
  const first = w.fetch(PUBLIC, { task: TASK, signal: stop.signal }).then((got) => (firstEnded = got));
  await guardAsked;
  const second = w.fetch(PUBLIC, { task: TASK });
  // The second fetch reaches the shared check before the first stops.
  await turnsUntil(() => false, 20);
  stop.abort();
  await turnsUntil(() => firstEnded !== undefined);
  try {
    assert.ok(firstEnded, "the stopped fetch ends at its stop");
    assert.deepEqual([firstEnded.receipt.wall.verdict, firstEnded.receipt.wall.error?.code], ["unjudged", "aborted"], "the stopped fetch's guard says it was stopped");
    assert.deepEqual([signals.length, signals[0].aborted], [1, false], "the shared check, asked once, is not stopped while the second fetch waits on it");
  } finally {
    release();
  }
  await first;
  const { receipt } = await second;
  assert.equal(receipt.wall.verdict, "content", "the second fetch gets the guard's verdict");
});

test("the shared guard check is stopped once every fetch waiting on it has stopped, and is asked again by the next fetch", async () => {
  const { w, release, guardAsked, signals } = heldGuard();
  const one = new AbortController();
  const two = new AbortController();
  const ended = [];
  const first = w.fetch(PUBLIC, { task: TASK, signal: one.signal }).then((got) => ended.push(got));
  await guardAsked;
  const second = w.fetch(PUBLIC, { task: TASK, signal: two.signal }).then((got) => ended.push(got));
  await turnsUntil(() => false, 20);
  one.abort();
  await turnsUntil(() => ended.length === 1);
  assert.equal(signals[0].aborted, false, "one fetch still waits: the check goes on");
  two.abort();
  await turnsUntil(() => ended.length === 2);
  assert.equal(signals[0].aborted, true, "no fetch waits: the check is stopped");
  release();
  await Promise.all([first, second]);
  assert.deepEqual(ended.map((got) => got.receipt.wall.error?.code), ["aborted", "aborted"]);
  const again = await w.fetch(PUBLIC, { task: TASK });
  assert.deepEqual([signals.length, again.receipt.wall.verdict], [2, "content"], "a stopped check is not kept: the next fetch asks again");
});

test("a fetch that comes once every waiter has stopped the shared check, before that check has ended, asks a check of its own", async () => {
  const { w, release, guardAsked, signals } = heldGuard();
  const one = new AbortController();
  const two = new AbortController();
  const ended = [];
  const first = w.fetch(PUBLIC, { task: TASK, signal: one.signal }).then((got) => ended.push(got));
  await guardAsked;
  const second = w.fetch(PUBLIC, { task: TASK, signal: two.signal }).then((got) => ended.push(got));
  await turnsUntil(() => false, 20);
  one.abort();
  two.abort();
  await turnsUntil(() => ended.length === 2);
  assert.equal(signals[0].aborted, true, "no fetch waits: the check is stopped, and has not ended yet");
  let thirdEnded;
  const third = w.fetch(PUBLIC, { task: TASK }).then((got) => (thirdEnded = got));
  await turnsUntil(() => signals.length === 2);
  try {
    assert.deepEqual([signals.length, signals[1]?.aborted], [2, false], "the stopped check is not joined: the new fetch's check is its own, and live");
  } finally {
    release();
  }
  await Promise.all([first, second, third]);
  assert.equal(thirdEnded.receipt.wall.verdict, "content", "the new fetch gets its own check's verdict");
});

test("under searchInTurn's deadline (the real AbortSignal.any), a provider sees a TimeoutError when the bound ran out and an AbortError when the call was stopped", async () => {
  const bound = AbortSignal.any([AbortSignal.timeout(1), new AbortController().signal]);
  await new Promise((resolve) => bound.addEventListener("abort", resolve, { once: true }));
  const caller = new AbortController();
  const stopped = AbortSignal.any([AbortSignal.timeout(600_000), caller.signal]);
  caller.abort();
  assert.deepEqual([bound.reason.name, stopped.reason.name], ["TimeoutError", "AbortError"]);
  for (const [provider, timeout] of [["exa-keyless", ["TIMEOUT", "Exa's search did not answer within 60 s"]], ["firecrawl-keyless", ["DEADLINE", "Firecrawl's search did not answer before the search's time ran out"]]]) {
    const bounded = web.createWeb({ order: { search: [provider], fetch: [] }, send: { [provider]: untilStopped() } });
    const out = await bounded.search({ objective: "widgets" }, { bounds: { searchMs: 1 } });
    assert.deepEqual([out.receipt.tries[0].failure.code, out.receipt.tries[0].failure.message], timeout, `${provider}: the bound ran out`);
    const stop = new AbortController();
    let sent = 0;
    const stoppable = web.createWeb({ order: { search: [provider], fetch: [] }, send: { [provider]: untilStopped(() => (sent += 1, setImmediate(() => stop.abort()))) } });
    const asked = await stoppable.search({ objective: "widgets" }, { signal: stop.signal, bounds: { searchMs: 600_000 } });
    assert.ok(sent > 0, `${provider}: it was asked before the stop`);
    assert.deepEqual([asked.receipt.tries[0].failure.code, asked.receipt.tries[0].failure.message], ["STOPPED", "the search was stopped"], `${provider}: the call was stopped`);
  }
});

test("Parallel's client, one keyed client for both tools: a URL not below Parallel's API is never sent with its key", async () => {
  const sent = [];
  const client = web.parallelExtract(KEY, async (url) => (sent.push(String(url)), new Response("{}", { status: 200 })));
  await assert.rejects(client.post("https://elsewhere.example/v1/search", { mode: "fast", search_queries: ["q"] }), (error) => error instanceof web.PaidRefused && error.message === "Parallel's /v1/search was not sent: it has no price here");
  await client.post(web.PARALLEL_SEARCH_URL, { mode: "fast", search_queries: ["q"] });
  assert.deepEqual(sent, [web.PARALLEL_SEARCH_URL], "only Parallel's own URL was sent");
});

test("every paid send carries its key with redirect: error, so a request that never left is never one whose first hop was sent", async () => {
  // The $0 rule for a request that never left (paidSend) reads a connect failure as nothing sent: a followed redirect
  // would send the first hop, key and all, and still fail with ENOTFOUND at the second.
  const asked = [];
  const recording = (who) => async (url, init) => (asked.push([who, init?.redirect]), new Response("{}", { status: 500 }));
  for (const provider of ["exa", "firecrawl", "parallel"]) await keyedWeb(provider, recording(`${provider} search`)).search({ objective: "widgets" });
  await web.parallelExtract(KEY, recording("parallel extract")).extract("https://example.com/a");
  assert.deepEqual(asked, [["exa search", "error"], ["firecrawl search", "error"], ["parallel search", "error"], ["parallel extract", "error"]]);
});
