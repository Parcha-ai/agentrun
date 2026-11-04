// capModels on its own, over a fake Models whose streams the test holds open: what an agentic run in serve never does
// (two model requests in flight at once, as a workflow's parallel nodes would) and prices a run cannot choose (a cache
// write dearer than input), checked on the exact worst case.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { capModels, paidCall, sideRequests, useSpend } from "../dist/cap.js";
import { bookedIn, PARALLEL_EXTRACT_USD, PARALLEL_SEARCH_USD } from "../dist/paid-calls.js";
import { parallelExtract, webFetch } from "../dist/web-fetch.js";
import { webSearch } from "../dist/web-search.js";
import fakeParallel, { CANARY } from "./fixtures/faux-parallel.mjs";
import { network } from "./fixtures/fake-network.mjs";

const usage = (total) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } });
const model = (cost, maxTokens = 1_000) => ({ id: "m", name: "m", api: "fake", provider: "fake", baseUrl: "", reasoning: true, input: ["text"], cost, contextWindow: 128_000, maxTokens });
const context = { messages: [{ role: "user", content: "What is six times seven?", timestamp: 0 }] };

/** A Models whose every request is recorded and stays open until the test ends it with `cost`. */
function fakeModels() {
  const sent = [];
  const send = () => {
    const events = createAssistantMessageEventStream();
    const end = (cost) => {
      const message = { role: "assistant", content: [{ type: "text", text: "42" }], api: "fake", provider: "fake", model: "m", usage: usage(cost), stopReason: "stop", timestamp: Date.now() };
      events.push({ type: "done", reason: "stop", message });
      events.end(message);
    };
    sent.push({ end });
    return events;
  };
  const models = {
    stream: send, streamSimple: send,
    complete: (...args) => send(...args).result(), completeSimple: (...args) => send(...args).result(),
    streamDeferred: send, fetchDeferred: (...args) => send(...args).result(),
  };
  return { models, sent };
}

test("a request in flight holds its worst case: a second that fits alone but not beside it is refused, and admitted once the first answered", async () => {
  // $1 per million output tokens and 1,000 of them: each request's worst case is $0.001; the cap holds one, not two.
  const priced = model({ input: 0, output: 1, cacheRead: 0, cacheWrite: 0 });
  const { models, sent } = fakeModels();
  const capped = await capModels(models, 0.0015, 0);
  const first = capped.streamSimple(priced, context);
  const second = await capped.streamSimple(priced, context).result();
  assert.equal(sent.length, 1, "the second request was not sent while the first was in flight");
  assert.equal(second.stopReason, "error");
  assert.match(second.errorMessage, /^spend_cap_reached \(out of budget\): Not sent: /);
  sent[0].end(0.0001);
  await first.result();
  await new Promise((resolve) => setImmediate(resolve));
  const third = capped.streamSimple(priced, context);
  assert.equal(sent.length, 2, "once the first answered ($0.0001 spent), the next fits");
  sent[1].end(0);
  await third.result();
});

/** A paid call (monid_run's, through paidCall) the test holds under way until it settles it with what it charged, or
 *  fails it; resolved once the call is sent, past the cap's check. Settled at the test's end in any case, so a paid call
 *  in a later test is never queued behind it. */
async function underWay(t, usd) {
  const call = { sent: false };
  const answer = new Promise((resolve, reject) => Object.assign(call, { settle: resolve, fail: reject }));
  call.paid = paidCall("monid_run", () => ((call.sent = true), answer), (charged) => charged, { usd, basis: "the price monid_inspect quoted" });
  t.after(() => (call.settle(0), call.paid.catch(() => undefined)));
  while (!call.sent) await new Promise((resolve) => setImmediate(resolve));
  return call;
}

/** Whether a request was sent: one that was is ended at once, so a request the cap should have held never hangs the test. */
const wentOut = (sent) => (sent.forEach((request) => request.end(0)), sent.length);

test("a paid call under way holds what it is held at: a model request that fits only without it is refused, and goes once the call's charge is in", async (t) => {
  // A request's worst case is $0.001 (1,000 output tokens at $1 a million) and monid's run is held at its $0.001 quote:
  // the cap holds one of the two, not both.
  const priced = model({ input: 0, output: 1, cacheRead: 0, cacheWrite: 0 });
  const { models, sent } = fakeModels();
  const capped = await capModels(models, 0.0015, 0);
  t.after(() => useSpend(undefined));
  const call = await underWay(t, 0.001);
  const request = capped.streamSimple(priced, context);
  assert.equal(wentOut(sent), 0, "not sent while the paid call is under way");
  const refused = await request.result();
  assert.equal(refused.errorMessage, "spend_cap_reached (out of budget): Not sent: the run has spent $0 and holds $0.001 for requests still answering, of its $0.0015 cap, and its next m request needs at least $0.01. Raise the cap to at least $0.01 to run it.");
  call.settle(0.0002);
  assert.deepEqual(await call.paid, { result: 0.0002 });
  const admitted = capped.streamSimple(priced, context);
  assert.equal(sent.length, 1, "once the call settled at $0.0002, the request fits: $0.0012 of $0.0015");
  sent[0].end(0);
  await admitted.result();
});

test("a paid call that fails counts at what it was held at, as a model request that fails with no answer does: its hold never just drops", async (t) => {
  const priced = model({ input: 0, output: 1, cacheRead: 0, cacheWrite: 0 });
  const { models, sent } = fakeModels();
  const capped = await capModels(models, 0.0015, 0);
  t.after(() => useSpend(undefined));
  const call = await underWay(t, 0.001);
  call.fail(new Error("monid's socket closed"));
  await assert.rejects(call.paid, /socket closed/);
  const request = capped.streamSimple(priced, context);
  assert.equal(wentOut(sent), 0, "it may have been sent and charged: the run's spend keeps its $0.001");
  const refused = await request.result();
  assert.match(refused.errorMessage, /^spend_cap_reached \(out of budget\): Not sent: the run has spent \$0\.001 of its \$0\.0015 cap, and its next m request needs at least \$0\.01\./);
});

/** The input bound: one token per UTF-8 byte of the request's context, which byte-level tokenizers never undercount. */
const bound = (ctx) => Buffer.byteLength(JSON.stringify(ctx), "utf8");

test("the input is priced at the cache-write price when it is dearer than input, as a provider may bill all of it so", async () => {
  const input = bound(context);
  assert.ok(input > 0);
  // No output price; input at $1 per million, a cache write at $4: the worst case is the input at $4.
  const priced = model({ input: 1, output: 0, cacheRead: 0, cacheWrite: 4 });
  const atCacheWrite = (input * 4) / 1e6;
  for (const [cap, sends] of [[atCacheWrite * 1.01, 1], [atCacheWrite * 0.99, 0]]) {
    const { models, sent } = fakeModels();
    const capped = await capModels(models, cap, 0);
    const answer = capped.streamSimple(priced, context);
    assert.equal(sent.length, sends, `a cap of ${cap}: the worst case is ${atCacheWrite}, not the input price's ${input / 1e6}`);
    if (sends) sent[0].end(0);
    await answer.result();
  }
});

test("a request is held at the output it is sent with: what it asks for, and on an API whose thinking takes a budget, the budget pi-ai adds to it", async () => {
  // No input price, $1 per million output tokens, a ceiling of 1,000: asking 100 tokens with no thinking, the worst case is
  // $0.0001; thinking on Anthropic's API, pi-ai adds the budget, so it is the ceiling's $0.001.
  const asks = { maxTokens: 100 };
  const plain = model({ input: 0, output: 1, cacheRead: 0, cacheWrite: 0 });
  const thinking = { ...plain, api: "anthropic-messages" };
  for (const [priced, options, cap, sends] of [[plain, asks, 0.0005, 1], [thinking, { ...asks, reasoning: "high" }, 0.0005, 0], [thinking, { ...asks, reasoning: "high" }, 0.0011, 1]]) {
    const { models, sent } = fakeModels();
    const capped = await capModels(models, cap, 0);
    const answer = capped.streamSimple(priced, context, options);
    assert.equal(sent.length, sends, `${priced.api}, ${JSON.stringify(options)}, a cap of ${cap}`);
    if (sends) sent[0].end(0);
    else assert.match((await answer.result()).errorMessage, /^spend_cap_reached \(out of budget\): Not sent: this run's cap of \$0\.0005 can't cover one m request \(at least \$0\.01\)\. Raise the cap to at least \$0\.01 to run it\.$/);
    await answer.result();
  }
});

test("pi's input is bounded by its context's UTF-8 bytes, never pi's average: a dense text whose bytes pass the cap is not sent", async () => {
  // Four bytes a character: pi's estimate (about 3.5 characters a token) prices it far below what a byte-level tokenizer may bill.
  const dense = { messages: [{ role: "user", content: "\u{1F600}".repeat(2_000), timestamp: 0 }] };
  const average = estimateContextTokens(dense).tokens;
  const bytes = bound(dense);
  assert.ok(bytes > average * 4, `bytes ${bytes} against pi's estimate ${average}`);
  // $1 per million input tokens, nothing for output: a cap between the two estimates.
  const priced = model({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0 });
  const cap = ((average + bytes) / 2) / 1e6;
  const { models, sent } = fakeModels();
  const capped = await capModels(models, cap, 0);
  const answer = await capped.streamSimple(priced, dense).result();
  assert.equal(sent.length, 0, "not sent: its byte bound passes the cap");
  assert.match(answer.errorMessage, /^spend_cap_reached \(out of budget\): Not sent: /);
});

test("pi under a cap: a model serve has no price for is refused, a model the catalog lists at $0 passes", async () => {
  const free = model({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const unlisted = { models: fakeModels(), capped: undefined };
  unlisted.capped = await capModels(unlisted.models.models, 1, 0, { unpriced: new Set(["m"]) });
  const refused = await unlisted.capped.streamSimple(free, context).result();
  assert.equal(unlisted.models.sent.length, 0, "an unpriced model is not sent under a cap");
  assert.match(refused.errorMessage, /^spend_cap_reached: .*no price.*out of budget/);
  const listed = fakeModels();
  const answer = (await capModels(listed.models, 0.000001, 0)).streamSimple(free, context);
  assert.equal(listed.sent.length, 1, "a listed $0 model is sent");
  listed.sent[0].end(0);
  await answer.result();
});

// The provider overhead table's figures, pinned here so a change to the table is a change to this test: Anthropic's tool-use
// prompt with a forced tool (pi's context does not say how a tool is chosen, so the dearer is taken) and its per-image
// maximum, Chat Completions' tool figure, and the assumed allowance for every kind without a documented one.
const ANTHROPIC_TOOLS = 804;
const ANTHROPIC_IMAGE = 4_784;
const COMPLETIONS_TOOLS = 804;
const ASSUMED_TOOLS = 2_048;
const tool = { name: "lookup", description: "Look a thing up.", parameters: { type: "object", properties: {} } };
const image = { type: "image", data: "aGk=", mimeType: "image/png" };
/** A pi model of `api` at $1 per million input tokens and nothing else, so a request's worst case is its input bound. */
const onApi = (api) => ({ ...model({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }), api });
/** Whether one request of `ctx` on `api` is sent under a cap of `tokens` input tokens' worth. */
async function sentUnder(api, ctx, tokens) {
  const { models, sent } = fakeModels();
  const answer = (await capModels(models, tokens / 1e6, 0)).streamSimple(onApi(api), ctx);
  const went = sent.length === 1;
  if (went) sent[0].end(0);
  await answer.result();
  return went;
}

test("pi's input adds what its provider adds server-side, from the model proxy's own table: an Anthropic model with tools and an image is held at the same figure", async () => {
  const ctx = { tools: [tool], messages: [{ role: "user", content: [{ type: "text", text: "What is this?" }, image], timestamp: 0 }] };
  const tokens = bound(ctx) + ANTHROPIC_TOOLS + ANTHROPIC_IMAGE;
  assert.equal(await sentUnder("anthropic-messages", ctx, tokens * 1.001), true, "sent within its bound plus the overhead");
  assert.equal(await sentUnder("anthropic-messages", ctx, tokens * 0.999), false, "refused past it: the overhead is counted");
});

test("a capped pi run on a chat-completions gateway, or on a provider with no documented figure, is priced and sent: never refused for the API it uses", async () => {
  const ctx = { tools: [tool], messages: [{ role: "user", content: "What is six times seven?", timestamp: 0 }] };
  for (const [api, overhead] of [["openai-completions", COMPLETIONS_TOOLS], ["bedrock-converse-stream", ASSUMED_TOOLS], ["google-generative-ai", ASSUMED_TOOLS], [`faux:${process.pid}`, ASSUMED_TOOLS]]) {
    const tokens = bound(ctx) + overhead;
    assert.equal(await sentUnder(api, ctx, tokens * 1.001), true, `${api}: sent within its bound`);
    assert.equal(await sentUnder(api, ctx, tokens * 0.999), false, `${api}: priced, with its overhead`);
  }
});

test("a tool's own request adds its hosted tool's allowance to its input bound and its most fee to its worst case: pi's web search is held at its context plus 5 searches of 25,000 tokens, and 5 searches' fee", async () => {
  // $1 per million input tokens and nothing else: the worst case is the input bound alone.
  const priced = model({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0 });
  const search = { messages: [{ role: "user", content: "Search the web for: widgets", timestamp: 0 }] };
  sideRequests.set(search, { label: "web_search", extraInputTokens: 125_000, maxFeeUsd: 0.05, feeUsd: () => 0.01 });
  const worst = (bound(search) + 125_000) / 1e6 + 0.05;
  for (const [cap, sent] of [[worst - 1e-6, 0], [worst, 1]]) {
    const { models, sent: requests } = fakeModels();
    const capped = await capModels(models, cap, 0);
    const answer = capped.completeSimple(priced, search);
    assert.equal(requests.length, sent, `a cap of $${cap}`);
    requests[0]?.end(0.001);
    if (!sent) assert.match((await answer).errorMessage, /^spend_cap_reached \(out of budget\): Not sent: /);
  }
});

test("a Parallel search under way holds its fee for the cap: a model request beside it that fits only without it is refused, and goes once the search answered and charged nothing", async (t) => {
  // A request's worst case is $0.001 (1,000 output tokens at $1 a million), and a fast search is held at its $0.001: a
  // $0.0015 cap holds one of the two, never both, whichever branch, tool round or harness each comes from.
  const mode = process.env.AGENTRUN_TEST_FAUX_PARALLEL_SEARCH;
  process.env.AGENTRUN_TEST_FAUX_PARALLEL_SEARCH = "422";
  t.after(() => (mode === undefined ? delete process.env.AGENTRUN_TEST_FAUX_PARALLEL_SEARCH : (process.env.AGENTRUN_TEST_FAUX_PARALLEL_SEARCH = mode)));
  const priced = model({ input: 0, output: 1, cacheRead: 0, cacheWrite: 0 });
  const { models, sent } = fakeModels();
  const capped = await capModels(models, 0.0015, 0);
  t.after(() => useSpend(undefined));
  // The search reaches Parallel and is held there until released.
  let arrived, release;
  const reached = new Promise((resolve) => (arrived = resolve));
  const held = new Promise((resolve) => (release = resolve));
  t.after(() => release());
  const send = async (url, init) => (arrived(), await held, fakeParallel(url, init));
  const records = [];
  const ledger = { call: "c1", record: async (kind, data) => void records.push([kind, data.heldUsd ?? data.usd]) };
  const search = bookedIn(ledger, () => webSearch({ query: "widgets", n: 2 }, parallelExtract(CANARY, send)));
  await reached;
  const request = capped.streamSimple(priced, context);
  assert.equal(wentOut(sent), 0, "not sent while the search is under way");
  // The refusal counts the search's fee as held (#1539's words, as main's paid-call hold test reads them).
  assert.equal((await request.result()).errorMessage, "spend_cap_reached (out of budget): Not sent: the run has spent $0 and holds $0.001 for requests still answering, of its $0.0015 cap, and its next m request needs at least $0.01. Raise the cap to at least $0.01 to run it.");
  // Parallel refused the search (422): it charged nothing, and its hold is gone.
  release();
  assert.deepEqual(await search, { error: "Parallel's search answered 422" });
  assert.deepEqual(records, [["agentrun.tool_started", PARALLEL_SEARCH_USD], ["agentrun.tool_cost", 0]]);
  const admitted = capped.streamSimple(priced, context);
  assert.equal(sent.length, 1, "with the search's hold released at $0, the request fits");
  sent[0].end(0);
  await admitted.result();
});


test("under a cap, a page's one Parallel extract is held as any Parallel request: a model request that fits only without its $0.001 is refused while the read is under way, and the page's later parts hold and ask nothing", async (t) => {
  const priced = model({ input: 0, output: 1, cacheRead: 0, cacheWrite: 0 });
  const { models, sent } = fakeModels();
  const capped = await capModels(models, 0.0015, 0);
  t.after(() => useSpend(undefined));
  let arrived, release;
  const reached = new Promise((resolve) => (arrived = resolve));
  const held = new Promise((resolve) => (release = resolve));
  t.after(() => release());
  const asked = [];
  const text = `${"capped ".repeat(6_000)}end`;
  const send = async (_url, init) => {
    asked.push(JSON.parse(init.body).advanced_settings.full_content.max_chars_per_result);
    arrived();
    await held;
    return new Response(JSON.stringify({ results: [{ url: "http://public.example/", title: "Capped", full_content: text }], errors: [] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const records = [];
  const ledger = { call: "c1", record: async (kind, data) => void records.push([kind, data.heldUsd ?? data.usd]) };
  const extract = parallelExtract(CANARY, send);
  const pages = new Map();
  const net = network();
  const first = bookedIn(ledger, () => webFetch("http://public.example/", { ...net, parallel: extract, pages }));
  await reached;
  const request = capped.streamSimple(priced, context);
  assert.equal(wentOut(sent), 0, "not sent while the extract is under way");
  assert.match((await request.result()).errorMessage ?? "", /holds \$0\.001 for requests still answering, of its \$0\.0015 cap/);
  release();
  assert.equal((await first).via, "parallel");
  const later = await bookedIn(ledger, () => webFetch("http://public.example/", { ...net, parallel: extract, pages, offset: 20_000 }));
  assert.deepEqual([later.via, later.offset, asked], ["parallel", 20_000, [1_000_001]], "a later part from what the run read: no request");
  assert.deepEqual(records, [["agentrun.tool_started", PARALLEL_EXTRACT_USD], ["agentrun.tool_cost", PARALLEL_EXTRACT_USD]], "held and charged once");
});
