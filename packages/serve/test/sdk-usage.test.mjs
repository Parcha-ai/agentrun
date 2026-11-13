// The SDK aggregate and the server's reflection share one run journal. Public analytics must keep both, including
// unknown usage, after a claim is reclaimed; the caller's aggregate never tells us its provider request count.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { serve, client } from "./support.mjs";
import { createSdkLoop } from "../dist/runner/sdk-loop.js";
import { journalEntries } from "../dist/runner/journal-reader.js";
import { reflectRequestId } from "../dist/runner/end-of-run.js";
import { GRADE_SESSION } from "../dist/runner/learning-ask.js";

const SDK_USAGE = { input_tokens: 20, output_tokens: 5, cache_read_tokens: 3, cache_write_tokens: 2, cost_usd: 0.25 };
const REFLECTION = { input: 100, output: 10, cacheRead: 30, cacheWrite: 4 };
const reflectionUsd = 0.125;

/** A real bookedAsk against a scripted Messages peer: no provider, key or network beyond its own local proxy. */
function route(sent, { priced = true, tokens = REFLECTION } = {}) {
  return {
    provider: { api: "anthropic-messages", origin: "https://reflection.invalid", credential: () => "not-a-secret-scripted-reflection" },
    model: "reflection-model",
    price: () => priced ? reflectionUsd : null,
    fetch: async (_url, init) => {
      sent.push(JSON.parse(String(init.body)));
      const events = [
        { type: "message_start", message: { id: "reflection", type: "message", role: "assistant", model: "reflection-model", content: [], stop_reason: null, usage: { input_tokens: tokens.input, output_tokens: 0, cache_read_input_tokens: tokens.cacheRead, cache_creation_input_tokens: tokens.cacheWrite } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Nothing reusable to learn." } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: tokens.output } },
        { type: "message_stop" },
      ];
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    },
  };
}

async function completedSdk(t, { learning = "notes", usage = SDK_USAGE } = {}) {
  const server = await serve(t, { runner: false });
  const registered = await server.api("POST", "/agents", { definition: { id: "sdk-usage", name: "SDK usage", instructions: "Report status.", sdk: { runtime: "claude-agent-sdk" }, learning, tools: [] } });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  const started = await server.api("POST", "/agents/sdk-usage/sdk-runs", { runtime: "claude-agent-sdk", input: "Report status.", instructions: "Report status.", model: "backend-model" }, { "Idempotency-Key": "usage" });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const { run_id: runId, token } = started.body;
  const completed = await client(server.baseUrl, token)("POST", `/sdk-runs/${runId}/complete`, { status: "completed", answer: "Ready.", usage });
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  const launch = (await server.store.runs.launch(runId)).body;
  const start = async (grader, { interruptEnd = false } = {}) => {
    const claim = await server.store.claim(runId, "usage-proof", { leaseMs: 60_000 });
    assert.ok(claim);
    const abort = new AbortController();
    let interrupted = false;
    const journal = server.store.journal(claim);
    const guarded = new Proxy(journal, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (key === "commit" && interruptEnd) return async (batches, ...rest) => {
          if (batches.flat().some(write => write.type === "entry" && write.value.kind === "agentrun.end")) {
            interrupted = true;
            abort.abort();
            throw new Error("the runner died before its end commit");
          }
          return value.call(target, batches, ...rest);
        };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const loop = createSdkLoop(launch, { store: server.store, data: server.data, env: {}, sealKey: Buffer.alloc(32, 7) }, async () => grader)({ journal: () => guarded, flush: () => server.store.flush(), signal: abort.signal });
    const end = await loop.start(claim);
    if (interruptEnd) {
      assert.equal(interrupted, true, "the fault fired after reflection was saved");
      assert.deepEqual(end, { state: "interrupted" });
      await server.store.release(claim);
    } else assert.deepEqual(end, { state: "ended" });
  };
  // An earlier claim's durable provider records, as a provider with partial usage or an interrupted request left them.
  const seedReflection = async (usage) => {
    const claim = await server.store.claim(runId, "earlier-runner", { leaseMs: 60_000 });
    const journal = server.store.journal(claim);
    const conversation = await journal.mintId();
    const writes = [{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }, { type: "conversation", value: { id: conversation } }];
    const entry = async (conversationId, kind, data) => writes.push({ type: "entry", value: {
      id: await journal.mintId(), conversationId, kind, data,
      ...(data.role === "person" ? { model: [{ role: "user", content: data.text, timestamp: Date.now() }] } : {}),
    } });
    const requestId = reflectRequestId(runId);
    await entry(ROOT_CONVERSATION_ID, "agentrun.sdk.started", { runtime: "claude-agent-sdk", model: "backend-model" });
    await entry(ROOT_CONVERSATION_ID, "agentrun.message", { role: "person", text: "Report status." });
    await entry(ROOT_CONVERSATION_ID, "agentrun.sdk.completion", { status: "completed", answer: "Ready.", usage: SDK_USAGE });
    await entry(ROOT_CONVERSATION_ID, "agentrun.message", { role: "model", text: "Ready." });
    await entry(ROOT_CONVERSATION_ID, "runner.request", { turn: 1, model: "backend-model", aggregate: true });
    await entry(ROOT_CONVERSATION_ID, "runner.turn", { turn: 1, usd: SDK_USAGE.cost_usd, usage: { input: 20, output: 5, cacheRead: 3, cacheWrite: 2 }, aggregate: true });
    await entry(ROOT_CONVERSATION_ID, "agentrun.session.key", { key: GRADE_SESSION, conversation });
    await entry(ROOT_CONVERSATION_ID, "agentrun.end-of-run.turn", { role: "person", requestId, text: "The task is done." });
    await entry(ROOT_CONVERSATION_ID, "agentrun.sdk.reflecting", { request_id: requestId });
    await entry(conversation, "runner.request", { turn: 1, model: "reflection-model" });
    if (usage) {
      await entry(conversation, "runner.turn", { turn: 1, usd: reflectionUsd, usage });
      await entry(ROOT_CONVERSATION_ID, "agentrun.end-of-run.turn", { role: "model", requestId, text: "Nothing reusable to learn." });
    }
    await commitWrites(journal, writes, BACKGROUND_CONTEXT);
    await server.store.release(claim);
  };
  return { ...server, runId, start, seedReflection };
}

async function assertPublicTotals(server, { cost, input = 120, output = 15, cacheRead = 33, cacheWrite = 6 }) {
  const run = (await server.api("GET", `/runs/${server.runId}`)).body;
  assert.equal(run.status, "completed", JSON.stringify(run));
  assert.equal(run.cost.usd, cost, "the public run cost includes SDK and reflection");
  assert.equal(run.result.final_answer, "Ready.");
  const totals = (await server.api("GET", "/stats?agent=sdk-usage")).body.analytics.totals;
  assert.deepEqual({ cost: totals.cost_usd, input: totals.input, output: totals.output, cacheRead: totals.cache_read, cacheWrite: totals.cache_write, requests: totals.requests, unmetered: totals.unmetered }, { cost, input, output, cacheRead, cacheWrite, requests: null, unmetered: null });
  assert.equal(totals.runs, 1);
  assert.equal(totals.unknown_cost_runs, cost === null ? 1 : 0);
  assert.equal(totals.tokens, [input, output, cacheRead, cacheWrite].includes(null) ? null : input + output + cacheRead + cacheWrite);
  assert.equal((await server.store.runs.get(server.runId)).costUsd, cost, "the persisted total agrees with the run view");
}

test("SDK public stats persist the aggregate plus known reflection usage", async t => {
  const server = await completedSdk(t);
  const sent = [];
  await server.start(route(sent));
  assert.equal(sent.length, 1, JSON.stringify((await server.api("GET", `/runs/${server.runId}`)).body.learning));
  await assertPublicTotals(server, { cost: SDK_USAGE.cost_usd + reflectionUsd });
});

test("an unpriced SDK reflection leaves total cost unknown while known tokens still add", async t => {
  const server = await completedSdk(t);
  await server.start(route([], { priced: false }));
  await assertPublicTotals(server, { cost: null });
});

test("an unmetered SDK reflection leaves token totals unknown, never the SDK-only count", async t => {
  const server = await completedSdk(t);
  await server.start(route([], { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }));
  await assertPublicTotals(server, { cost: SDK_USAGE.cost_usd + reflectionUsd, input: null, output: null, cacheRead: null, cacheWrite: null });
});

test("unknown SDK cost and individual token counters remain unknown after a metered reflection", async t => {
  const server = await completedSdk(t, { usage: { ...SDK_USAGE, cost_usd: null, input_tokens: null, cache_write_tokens: null } });
  await server.start(route([]));
  await assertPublicTotals(server, { cost: null, input: null, cacheWrite: null });
});

test("learning off persists only SDK usage and sends no reflection", async t => {
  const server = await completedSdk(t, { learning: false });
  const sent = [];
  await server.start(route(sent));
  assert.equal(sent.length, 0);
  await assertPublicTotals(server, { cost: 0.25, input: 20, output: 5, cacheRead: 3, cacheWrite: 2 });
});

test("a reclaimed SDK end reuses reflection and counts each charge once", async t => {
  const server = await completedSdk(t);
  const sent = [], grader = route(sent);
  await server.start(grader, { interruptEnd: true });
  await server.start(grader);
  assert.equal(sent.length, 1, "the paid reflection was not replayed");
  const entries = await journalEntries(server.store.readJournal(server.runId), BACKGROUND_CONTEXT);
  assert.equal(entries.filter(entry => entry.kind === "agentrun.sdk.completion").length, 1);
  assert.equal(entries.filter(entry => entry.kind === "runner.turn").length, 2, "one SDK aggregate and one reflection booking");
  await assertPublicTotals(server, { cost: SDK_USAGE.cost_usd + reflectionUsd });
});

test("a reclaimed reflection's partial token report preserves each unknown dimension", async t => {
  const server = await completedSdk(t);
  const { cacheWrite: _unknown, ...reported } = REFLECTION;
  await server.seedReflection(reported);
  const sent = [];
  await server.start(route(sent));
  assert.equal(sent.length, 0, "the saved answer is reused");
  await assertPublicTotals(server, { cost: SDK_USAGE.cost_usd + reflectionUsd, cacheWrite: null });
});

test("a dispatched reflection with no durable answer is never replayed and leaves totals unknown", async t => {
  const server = await completedSdk(t);
  await server.seedReflection();
  const sent = [];
  await server.start(route(sent));
  assert.equal(sent.length, 0, "the interrupted paid request is never replayed");
  await assertPublicTotals(server, { cost: null, input: null, output: null, cacheRead: null, cacheWrite: null });
});
