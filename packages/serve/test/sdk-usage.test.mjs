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

async function completedSdk(t, { learning = "notes", usage = SDK_USAGE, status = "completed", evidenceComplete, runtime = "claude-agent-sdk" } = {}) {
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
  const start = async (grader, { interruptEnd = false, pathRead, expectedState = status === "completed" ? "ended" : status === "cancelled" ? "stopped" : "failed" } = {}) => {
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
    // Faults at the store's read boundary: failure/cancelled completions do no reflection, so this is the path read.
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
    const loop = createSdkLoop(launch, { store, data: server.data, env: {}, sealKey: Buffer.alloc(32, 7) }, async () => grader)({ journal: () => guarded, flush: () => server.store.flush(), signal: abort.signal });
    const end = await loop.start(claim);
    if (interruptEnd) {
      assert.equal(interrupted, true, "the fault fired after reflection was saved");
      assert.deepEqual(end, { state: "interrupted" });
      await server.store.release(claim);
    } else assert.equal(end.state, expectedState, JSON.stringify(end));
    if (pathRead) assert.equal(readCalled, true, "the fault reached the path's store read");
    return end;
  };
  // An earlier claim's durable provider records, as a provider with partial usage or an interrupted request left them.
  const seedReflection = async (usage, { step, round = 1, kept } = {}) => {
    const claim = await server.store.claim(runId, "earlier-runner", { leaseMs: 60_000 });
    const journal = server.store.journal(claim);
    const conversation = await journal.mintId();
    const writes = [{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }, { type: "conversation", value: { id: conversation } }];
    const entry = async (conversationId, kind, data) => writes.push({ type: "entry", value: {
      id: await journal.mintId(), conversationId, kind, data,
      ...(data.role === "person" ? { model: [{ role: "user", content: data.text, timestamp: Date.now() }] } : {}),
    } });
    const requestId = reflectRequestId(runId, false, round, step);
    await entry(ROOT_CONVERSATION_ID, "agentrun.sdk.started", { runtime: "claude-agent-sdk", model: "backend-model" });
    await entry(ROOT_CONVERSATION_ID, "agentrun.message", { role: "person", text: "Report status." });
    await entry(ROOT_CONVERSATION_ID, "agentrun.sdk.completion", { status: "completed", answer: "Ready.", usage: SDK_USAGE });
    await entry(ROOT_CONVERSATION_ID, "agentrun.message", { role: "model", text: "Ready." });
    await entry(ROOT_CONVERSATION_ID, "runner.request", { turn: 1, model: "backend-model", aggregate: true });
    await entry(ROOT_CONVERSATION_ID, "runner.turn", { turn: 1, usd: SDK_USAGE.cost_usd, usage: { input: 20, output: 5, cacheRead: 3, cacheWrite: 2 }, aggregate: true });
    await entry(ROOT_CONVERSATION_ID, "agentrun.session.key", { key: GRADE_SESSION, conversation });
    await entry(ROOT_CONVERSATION_ID, "agentrun.end-of-run.turn", { role: "person", requestId, text: "The task is done.", ...(kept ? { kept } : {}) });
    await entry(ROOT_CONVERSATION_ID, "agentrun.sdk.reflecting", { request_id: requestId });
    await entry(conversation, "runner.request", { turn: 1, model: "reflection-model" });
    if (usage) {
      await entry(conversation, "runner.turn", { turn: 1, usd: reflectionUsd, usage });
      await entry(ROOT_CONVERSATION_ID, "agentrun.end-of-run.turn", { role: "model", requestId, text: "Nothing reusable to learn." });
    }
    await commitWrites(journal, writes, BACKGROUND_CONTEXT);
    await server.store.release(claim);
  };
  return { ...server, runId, start, seedReflection, sdk: client(server.baseUrl, token) };
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

test("a learning SDK completion remains in the cost series with its aggregate and reflection spend", async t => {
  const server = await completedSdk(t);
  await server.start(route([]));
  const cost = await server.api("GET", "/agents/sdk-usage/learning/cost");
  assert.equal(cost.status, 200, JSON.stringify(cost.body));
  assert.deepEqual(cost.body.runs.map(run => [run.run_id, run.path, run.workflow, run.total_usd]),
    [[server.runId, "agent", null, 0.375]]);
  assert.deepEqual([cost.body.total_runs, cost.body.unknown_path_runs], [1, 0]);
});

for (const status of ["failed", "cancelled"]) test(`a ${status} SDK completion keeps its known path and spend in the cost series`, async t => {
  const server = await completedSdk(t, { status });
  const sent = [];
  await server.start(route(sent));
  assert.equal(sent.length, 0, "unsuccessful backend work is not reflected");
  const cost = (await server.api("GET", "/agents/sdk-usage/learning/cost")).body;
  assert.deepEqual(cost.runs.map(run => [run.run_id, run.path, run.total_usd]), [[server.runId, "agent", 0.25]]);
  assert.equal(cost.unknown_path_runs, 0);
});

for (const runtime of ["claude-agent-sdk", "codex-sdk"]) for (const status of ["failed", "cancelled"])
  test(`a ${status} ${runtime} completion closes learning without reflection, atomically with its end`, async t => {
    const server = await completedSdk(t, { status, runtime });
    const sent = [], grader = route(sent);
    await server.start(grader, { interruptEnd: true });
    assert.equal(await server.store.learning.proposal(server.runId), undefined, "a lost end cannot leave a learning result alone");
    await server.start(grader);
    assert.equal(sent.length, 0, "failed and cancelled work never asks the reflection model");
    const run = (await server.api("GET", `/runs/${server.runId}`)).body;
    const scoped = (await server.sdk("GET", `/sdk-runs/${server.runId}`)).body;
    assert.equal(run.status, status);
    assert.equal(scoped.state, status);
    assert.equal(run.learning.state, "dropped", JSON.stringify(run.learning));
    assert.equal(scoped.learning.state, "dropped", JSON.stringify(scoped.learning));
    assert.equal(run.learning.reason, status === "cancelled" ? "cancelled" : "crashed");
    assert.match(run.learning.detail, /learning stopped/);
    assert.equal(await server.store.runs.get(`${server.runId}-learning`), undefined, "no grading run is queued");
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
    assert.equal(await server.store.runs.get(`${server.runId}-learning`), undefined);
    assert.equal((await server.api("GET", `/runs/${server.runId}`)).body.status, status);
  });

for (const status of ["completed", "failed", "cancelled"]) test(`an incomplete ${status} SDK trace retains known usage but leaves its execution path unknown`, async t => {
  const server = await completedSdk(t, { status, evidenceComplete: false }), sent = [];
  await server.start(route(sent));
  assert.equal(sent.length, 0, "a known partial trace is not reflected");
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
  await assertPublicTotals(server, { cost: null, input: null, output: 5, cacheRead: 3, cacheWrite: null });
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

for (const runtime of ["claude-agent-sdk", "codex-sdk"]) {
  for (const [name, taskCost, priced, reflectionCost] of [
    ["known costs", 0.25, true, 0.125],
    ["unknown task cost", null, true, null],
    ["unknown reflection cost", 0.25, false, null],
  ]) test(`SDK reflection recovery keeps the original breakdown: ${runtime}, ${name}`, async t => {
    const server = await completedSdk(t, { runtime, usage: { ...SDK_USAGE, cost_usd: taskCost } });
    const sent = [], grader = route(sent, { priced });
    await server.start(grader, { interruptEnd: true });
    const before = await journalEntries(server.store.readJournal(server.runId), BACKGROUND_CONTEXT);
    const requestId = reflectRequestId(server.runId);
    const firstAsk = before.find(entry => entry.kind === "agentrun.end-of-run.turn" && entry.data.role === "person" && entry.data.requestId === requestId);
    assert.ok(firstAsk);
    assert.equal(sent.length, 1, "the interrupted claim completed a real booked reflection");
    assert.equal(before.filter(entry => entry.kind === "agentrun.end-of-run.turn" && entry.data.role === "model").length, 1);
    assert.equal(before.some(entry => entry.kind === "agentrun.end"), false, "the failed end commit wrote no terminal entry");
    assert.equal((await server.store.runs.get(server.runId)).state, "running");
    assert.equal(await server.store.learning.proposal(server.runId), undefined, "learning and its cost split cannot commit ahead of the run end");

    await server.start(grader);
    const total = taskCost === null || reflectionCost === null ? null : taskCost + reflectionCost;
    await assertPublicTotals(server, { cost: total });
    const cost = await server.api("GET", "/agents/sdk-usage/learning/cost");
    assert.equal(cost.status, 200);
    assert.equal(cost.body.runs.length, 1);
    assert.deepEqual([cost.body.runs[0].cost_usd, cost.body.runs[0].learning_usd, cost.body.runs[0].total_usd],
      [taskCost, reflectionCost, total], "recovery must not relabel an already-paid reflection as task spending");
    const saved = await server.store.learning.proposal(server.runId);
    assert.deepEqual([saved.proposal.job_cost_usd, saved.proposal.look_back_usd], [taskCost, reflectionCost]);
    assert.ok(firstAsk.data.kept, "the first ask must durably retain the task's original cost and answer time");
    assert.equal(firstAsk.data.kept.job_cost_usd, taskCost);
    assert.ok(Number.isFinite(Date.parse(firstAsk.data.kept.answered_at)));
    assert.equal(saved.proposal.answered_at, firstAsk.data.kept.answered_at, "a new claim cannot move when the task answered");
    const after = await journalEntries(server.store.readJournal(server.runId), BACKGROUND_CONTEXT);
    assert.equal(sent.length, 1, "recovery must reuse the paid answer");
    assert.equal(after.filter(entry => entry.kind === "agentrun.sdk.completion").length, 1);
    assert.equal(after.filter(entry => entry.kind === "runner.turn").length, 2, "one SDK aggregate and one reflection charge");
    assert.equal(after.filter(entry => entry.kind === "agentrun.end").length, 1, "the terminal state and learning costs commit together once");
  });
}

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

// Compiler turns are journaled under their own IDs. An earlier claim may have completed one before losing its end;
// the SDK accounting reader must recover that round's first kept task figures, even without a plain look-back row.
for (const runtime of ["claude-agent-sdk", "codex-sdk"]) test(`SDK recovery retains the first compile step's task figures: ${runtime}`, async t => {
  const server = await completedSdk(t, { runtime });
  const kept = { answered_at: "2026-01-01T12:00:00.000Z", job_cost_usd: SDK_USAGE.cost_usd };
  await server.seedReflection(REFLECTION, { step: "compile-1", kept });
  const sent = [];
  await server.start(route(sent));
  // This notes-only prefix asks its missing look-back once. The later workflow layer also exercises the real
  // compile-only/retry path; this fixture covers the durable SDK record boundary without inventing workflow support.
  assert.equal(sent.length, 1);
  const saved = await server.store.learning.proposal(server.runId);
  assert.equal(saved.proposal.answered_at, kept.answered_at);
  assert.deepEqual([saved.proposal.job_cost_usd, saved.proposal.look_back_usd], [0.25, 0.25]);
  await assertPublicTotals(server, { cost: 0.5, input: 220, output: 25, cacheRead: 63, cacheWrite: 10 });
});

test("SDK recovery never takes task figures from a different reflection round", async t => {
  const server = await completedSdk(t);
  await server.seedReflection(REFLECTION, { step: "compile-1", round: 2,
    kept: { answered_at: "2026-01-01T12:00:00.000Z", job_cost_usd: 0.01 } });
  await server.start(route([]));
  const saved = await server.store.learning.proposal(server.runId);
  assert.deepEqual([saved.proposal.job_cost_usd, saved.proposal.look_back_usd], [0.375, 0.125]);
  assert.notEqual(saved.proposal.answered_at, "2026-01-01T12:00:00.000Z");
});
