// The SDK aggregate in the run's journal. Public analytics must keep it, including unknown usage, after a claim is
// reclaimed; the caller's aggregate never tells us its provider request count. An SDK run with no workflow binding asks
// no end-of-run model turn (runner/learning-end.ts: a run with `noWorkflows` compiles nothing), learning on or off.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { serve, client } from "./support.mjs";
import { createSdkLoop } from "../dist/runner/sdk-loop.js";
import { journalEntries } from "../dist/runner/journal-reader.js";

const SDK_USAGE = { input_tokens: 20, output_tokens: 5, cache_read_tokens: 3, cache_write_tokens: 2, cost_usd: 0.25 };

/** A real bookedAsk's route against a scripted Messages peer: no provider, key or network beyond its own local proxy.
 *  Every request it gets is pushed on `sent`. */
function route(sent) {
  return {
    provider: { api: "anthropic-messages", origin: "https://ask.invalid", credential: () => "not-a-secret-scripted-ask" },
    model: "ask-model",
    price: () => 0.125,
    fetch: async (_url, init) => {
      sent.push(JSON.parse(String(init.body)));
      const events = [
        { type: "message_start", message: { id: "ask", type: "message", role: "assistant", model: "ask-model", content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 30, cache_creation_input_tokens: 4 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Nothing to compile." } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } },
        { type: "message_stop" },
      ];
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    },
  };
}

async function completedSdk(t, { learning = true, usage = SDK_USAGE, status = "completed", evidenceComplete, runtime = "claude-agent-sdk" } = {}) {
  const server = await serve(t, { runner: false });
  const registered = await server.api("POST", "/agents", { definition: { id: "sdk-usage", name: "SDK usage", instructions: "Report status.", sdk: { runtime }, learning, tools: [] } });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  const started = await server.api("POST", "/agents/sdk-usage/sdk-runs", { runtime, input: "Report status.", instructions: "Report status.", model: "backend-model" }, { "Idempotency-Key": "usage" });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const { run_id: runId, token } = started.body;
  const completed = await client(server.baseUrl, token)("POST", `/sdk-runs/${runId}/complete`, { status, answer: "Ready.", usage,
    ...(evidenceComplete !== undefined ? { evidence_complete: evidenceComplete } : {}),
  });
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  const launch = (await server.store.runs.launch(runId)).body;
  const start = async (asker, { interruptEnd = false, pathRead, expectedState = status === "completed" ? "ended" : status === "cancelled" ? "stopped" : "failed" } = {}) => {
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
    // Faults at the store's read boundary: the run's path is read here.
    let readCalled = false;
    const store = new Proxy(server.store, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (key === "readJournal" && pathRead) return (...args) => {
          const reads = value.apply(target, args);
          return new Proxy(reads, {
            get(target, key) {
              const value = Reflect.get(target, key, target);
              if (key === "scanConversations") return async (...args) => {
                if (!readCalled) { readCalled = true; await pathRead({ loop, claim, abort }); }
                return value.apply(target, args);
              };
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const loop = createSdkLoop(launch, { store, data: server.data, env: {}, sealKey: Buffer.alloc(32, 7) }, async () => asker)({ journal: () => guarded, flush: () => server.store.flush(), signal: abort.signal });
    const end = await loop.start(claim);
    if (interruptEnd) {
      assert.equal(interrupted, true, "the fault fired at the end's commit");
      assert.deepEqual(end, { state: "interrupted" });
      await server.store.release(claim);
    } else assert.equal(end.state, expectedState, JSON.stringify(end));
    if (pathRead) assert.equal(readCalled, true, "the fault reached the path's store read");
    return end;
  };
  return { ...server, runId, start, sdk: client(server.baseUrl, token) };
}

async function assertPublicTotals(server, { cost, input = 20, output = 5, cacheRead = 3, cacheWrite = 2 }) {
  const run = (await server.api("GET", `/runs/${server.runId}`)).body;
  assert.equal(run.status, "completed", JSON.stringify(run));
  assert.equal(run.cost.usd, cost, "the public run cost is the SDK's");
  // The SDK's one booking for its whole task (aggregate) is its harness's own figure, an estimate; its tokens are the
  // stored aggregate's, with its request count unknown (left out), and none while any count is unknown, never a 0.
  assert.equal(run.cost.basis, cost === null ? "unpriced" : "estimate", JSON.stringify(run.cost));
  assert.deepEqual(run.cost.tokens, [input, output, cacheRead, cacheWrite].includes(null) ? undefined : { input, output, cache_read: cacheRead, cache_write: cacheWrite }, JSON.stringify(run.cost));
  assert.equal(run.result.final_answer, "Ready.");
  const totals = (await server.api("GET", "/stats?agent=sdk-usage")).body.analytics.totals;
  assert.deepEqual({ cost: totals.cost_usd, input: totals.input, output: totals.output, cacheRead: totals.cache_read, cacheWrite: totals.cache_write, requests: totals.requests, unmetered: totals.unmetered }, { cost, input, output, cacheRead, cacheWrite, requests: null, unmetered: null });
  assert.equal(totals.runs, 1);
  assert.equal(totals.unknown_cost_runs, cost === null ? 1 : 0);
  assert.equal(totals.tokens, [input, output, cacheRead, cacheWrite].includes(null) ? null : input + output + cacheRead + cacheWrite);
  assert.equal((await server.store.runs.get(server.runId)).costUsd, cost, "the persisted total agrees with the run view");
}

test("a learning SDK completion with no workflow binding asks no model turn: its public stats are the SDK aggregate's", async t => {
  const server = await completedSdk(t);
  const sent = [];
  await server.start(route(sent));
  assert.equal(sent.length, 0, JSON.stringify((await server.api("GET", `/runs/${server.runId}`)).body.learning));
  await assertPublicTotals(server, { cost: SDK_USAGE.cost_usd });
});

test("Eve's native task is booked once without an obsolete reflection charge", async t => {
  const server = await completedSdk(t, { runtime: "eve", evidenceComplete: true });
  const sent = [];
  await server.start(route(sent));
  assert.equal(sent.length, 0, "an Eve task without a workflow binding does not ask a model");
  await assertPublicTotals(server, { cost: 0.25 });
  const run = (await server.api("GET", `/runs/${server.runId}`)).body;
  assert.equal(run.sdk.runtime, "eve");
  const cost = await server.api("GET", "/agents/sdk-usage/learning/cost");
  assert.equal(cost.status, 200, JSON.stringify(cost.body));
  assert.deepEqual(cost.body.runs.map(row => [row.run_id, row.path, row.cost_usd, row.learning_usd, row.total_usd]),
    [[server.runId, "agent", 0.25, 0, 0.25]]);
  assert.deepEqual(cost.body.bill.points, [{ n: 1, run_id: server.runId, actual_usd: 0.25, agent_usd: 0.25 }]);
  assert.equal(cost.body.bill.booked_usd, 0.25, "the bill books the native task once");
  assert.deepEqual([cost.body.total_runs, cost.body.unknown_path_runs, cost.body.unknown_cost_runs], [1, 0, 0]);
});

test("a learning SDK completion remains in the cost series with its aggregate", async t => {
  const server = await completedSdk(t);
  await server.start(route([]));
  const cost = await server.api("GET", "/agents/sdk-usage/learning/cost");
  assert.equal(cost.status, 200, JSON.stringify(cost.body));
  assert.deepEqual(cost.body.runs.map(run => [run.run_id, run.path, run.workflow, run.total_usd]),
    [[server.runId, "agent", null, 0.25]]);
  assert.deepEqual([cost.body.total_runs, cost.body.unknown_path_runs], [1, 0]);
});

for (const status of ["failed", "cancelled"]) test(`a ${status} SDK completion keeps its known path and spend in the cost series`, async t => {
  const server = await completedSdk(t, { status });
  const sent = [];
  await server.start(route(sent));
  assert.equal(sent.length, 0, "unsuccessful backend work asks nothing");
  const cost = (await server.api("GET", "/agents/sdk-usage/learning/cost")).body;
  assert.deepEqual(cost.runs.map(run => [run.run_id, run.path, run.total_usd]), [[server.runId, "agent", 0.25]]);
  assert.equal(cost.unknown_path_runs, 0);
});

for (const runtime of ["claude-agent-sdk", "codex-sdk", "eve"]) for (const status of ["failed", "cancelled"])
  test(`a ${status} ${runtime} completion closes learning, atomically with its end`, async t => {
    const server = await completedSdk(t, { status, runtime });
    const sent = [], asker = route(sent);
    await server.start(asker, { interruptEnd: true });
    assert.equal(await server.store.learning.proposal(server.runId), undefined, "a lost end cannot leave a learning result alone");
    await server.start(asker);
    assert.equal(sent.length, 0, "failed and cancelled work never asks a model");
    const run = (await server.api("GET", `/runs/${server.runId}`)).body;
    const scoped = (await server.sdk("GET", `/sdk-runs/${server.runId}`)).body;
    assert.equal(run.status, status);
    assert.equal(scoped.state, status);
    assert.equal(run.learning.state, "dropped", JSON.stringify(run.learning));
    assert.equal(scoped.learning.state, "dropped", JSON.stringify(scoped.learning));
    assert.equal(run.learning.reason, status === "cancelled" ? "cancelled" : "crashed");
    assert.match(run.learning.detail, /learning stopped/);
    const row = await server.store.runs.get(server.runId);
    assert.deepEqual([row.costUsd, row.metrics.input, row.metrics.output, row.metrics.cacheRead, row.metrics.cacheWrite, row.metrics.path],
      [0.25, 20, 5, 3, 2, "agent"]);
    const entries = await journalEntries(server.store.readJournal(server.runId), BACKGROUND_CONTEXT);
    assert.equal(entries.filter(entry => entry.kind === "runner.turn").length, 1, "reclaim does not book the SDK charge twice");
    assert.equal(entries.filter(entry => entry.kind === "agentrun.end").length, 1);
  });

for (const status of ["failed", "cancelled"])
  test(`a ${status} SDK completion with learning off records no learning proposal`, async t => {
    const server = await completedSdk(t, { status, learning: false });
    const sent = [];
    await server.start(route(sent));
    assert.equal(sent.length, 0);
    assert.equal(await server.store.learning.proposal(server.runId), undefined);
    assert.equal((await server.api("GET", `/runs/${server.runId}`)).body.status, status);
  });

for (const status of ["completed", "failed", "cancelled"]) test(`an incomplete ${status} SDK trace retains known usage but leaves its execution path unknown`, async t => {
  const server = await completedSdk(t, { status, evidenceComplete: false }), sent = [];
  await server.start(route(sent));
  assert.equal(sent.length, 0, "a known partial trace asks nothing");
  const row = await server.store.runs.get(server.runId);
  assert.deepEqual([row.costUsd, row.metrics.input, row.metrics.output, row.metrics.cacheRead, row.metrics.cacheWrite], [0.25, 20, 5, 3, 2]);
  assert.equal(Object.hasOwn(row.metrics, "path"), false, "a partial trace cannot prove agent, workflow or handed_back");
  assert.equal((await server.api("GET", `/runs/${server.runId}`)).body.cost.usd, 0.25);
  const totals = (await server.api("GET", "/stats?agent=sdk-usage")).body.analytics.totals;
  assert.deepEqual([totals.cost_usd, totals.input, totals.output, totals.cache_read, totals.cache_write], [0.25, 20, 5, 3, 2]);
  const cost = (await server.api("GET", "/agents/sdk-usage/learning/cost")).body;
  assert.deepEqual([cost.runs, cost.total_runs, cost.unknown_path_runs], [[], 0, 1]);
});

test("an incomplete SDK trace preserves each unknown usage counter without inventing a path or zero cost", async t => {
  const server = await completedSdk(t, { evidenceComplete: false, usage: { ...SDK_USAGE, cost_usd: null, input_tokens: null, cache_write_tokens: null } });
  await server.start(route([]));
  await assertPublicTotals(server, { cost: null, input: null, cacheWrite: null });
  assert.equal(Object.hasOwn((await server.store.runs.get(server.runId)).metrics, "path"), false);
  assert.equal((await server.api("GET", "/agents/sdk-usage/learning/cost")).body.unknown_path_runs, 1);
});

test("a failed SDK path read keeps the backend outcome and leaves persisted cost and metrics unknown", async t => {
  const server = await completedSdk(t, { status: "failed" });
  await server.start(route([]), { pathRead: async () => { throw new Error("the journal read failed"); } });
  const run = await server.store.runs.get(server.runId);
  assert.deepEqual([run.state, run.costUsd, run.metrics], ["failed", null, null]);
  assert.equal(run.summary, "The backend SDK run did not complete.");
  const cost = (await server.api("GET", "/agents/sdk-usage/learning/cost")).body;
  assert.deepEqual([cost.runs, cost.unknown_path_runs], [[], 1]);
});

test("a stalled SDK path read is bounded and persists unknown cost and metrics", { timeout: 40_000 }, async t => {
  const server = await completedSdk(t, { status: "cancelled" });
  await server.start(route([]), { pathRead: () => new Promise(() => {}) });
  const run = await server.store.runs.get(server.runId);
  assert.deepEqual([run.state, run.outcome, run.costUsd, run.metrics], ["stopped", "cancelled", null, null]);
  const cost = (await server.api("GET", "/agents/sdk-usage/learning/cost")).body;
  assert.deepEqual([cost.runs, cost.unknown_path_runs], [[], 1]);
});

test("a stop during the SDK path read takes its command with the end and keeps the patch's known spend", async t => {
  const server = await completedSdk(t, { status: "failed" });
  let stopping;
  await server.start(route([]), {
    expectedState: "stopped",
    pathRead: async ({ loop }) => {
      const command = await server.store.command(server.runId, { kind: "stop" });
      stopping = loop.stop({ kind: "command", commandId: command.id });
    },
  });
  await stopping;
  const run = await server.store.runs.get(server.runId);
  assert.deepEqual([run.state, run.outcome, run.costUsd, run.metrics.path], ["stopped", "stopped", 0.25, "agent"]);
  const [command] = await server.store.commands(server.runId, 0);
  assert.ok(command.takenAt !== null);
  assert.equal(command.refused, null);
});

test("claim loss during the SDK path read writes no end and leaves completion available for another claim", async t => {
  const server = await completedSdk(t, { status: "failed" });
  await server.start(route([]), { expectedState: "interrupted", pathRead: async ({ abort }) => abort.abort() });
  assert.equal((await server.store.runs.get(server.runId)).state, "running");
  assert.equal((await journalEntries(server.store.readJournal(server.runId), BACKGROUND_CONTEXT)).some(entry => entry.kind === "agentrun.end"), false);
});

test("unknown SDK cost and individual token counters remain unknown in the public totals", async t => {
  const server = await completedSdk(t, { usage: { ...SDK_USAGE, cost_usd: null, input_tokens: null, cache_write_tokens: null } });
  await server.start(route([]));
  await assertPublicTotals(server, { cost: null, input: null, cacheWrite: null });
});

test("learning off persists only SDK usage and asks nothing", async t => {
  const server = await completedSdk(t, { learning: false });
  const sent = [];
  await server.start(route(sent));
  assert.equal(sent.length, 0);
  await assertPublicTotals(server, { cost: 0.25 });
});

test("a reclaimed SDK end counts the SDK charge once", async t => {
  const server = await completedSdk(t);
  const sent = [], asker = route(sent);
  await server.start(asker, { interruptEnd: true });
  await server.start(asker);
  assert.equal(sent.length, 0);
  const entries = await journalEntries(server.store.readJournal(server.runId), BACKGROUND_CONTEXT);
  assert.equal(entries.filter(entry => entry.kind === "agentrun.sdk.completion").length, 1);
  assert.equal(entries.filter(entry => entry.kind === "runner.turn").length, 1, "one SDK aggregate booking");
  assert.equal(entries.filter(entry => entry.kind === "agentrun.end").length, 1);
  await assertPublicTotals(server, { cost: SDK_USAGE.cost_usd });
});
