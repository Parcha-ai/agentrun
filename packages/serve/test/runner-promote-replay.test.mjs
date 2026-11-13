// Promotion by replay through the runner (runner/promotion.ts, learn/promote.ts): a learned workflow's new digest with
// five graded inputs or more it fits does not serve first until a replay on them clears the bar.
//   - the first fitting run goes to the agent while the digest replays: one replay run per graded input, each the
//     workflow alone at workflow cost (path `replay`, no agent request, no end-of-run turn);
//   - a later run, every replay ended, is served first once the replay is within 2 points of the agent's graded answers;
//   - a replay the workflow hands back on counts as the agent's recorded answer, never as a failure: it still promotes;
//   - a replay whose answers are wrong holds the digest: the run after it is the agent's;
//   - fewer than five graded inputs: promoted on its passing dry run, as before, and the record says so.
// The graded runs are records the promotion reads (their grade, launch and row), on a pi run of the faux gateway.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { landWorkflows, startAt } from "./learned-workflow-seed-support.mjs";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { readLaunchBody } = await import("../dist/run-launch.js");
const { putGrade, promotionsOf } = await import("../dist/learn/promote.js");
const { workflowDigest } = await import("../dist/runner/workflow-first.js");
const { seedOf } = await import("../dist/learning.js");

const SEAL_KEY = Buffer.alloc(32, 7);
const MODEL = "claude-sonnet-5-5";
const TIMING = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const AGENT_SAYS = "The agent's own answer: 42.";

const answerFlow = {
  v: 2, name: "answer",
  schemas: {
    In: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
    Answer: { type: "object", required: ["answer", "sure"], properties: { answer: { type: "number" }, sure: { type: "boolean" } } },
  },
  input: { schemaId: "In" }, output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [
    { node: "extract", label: "answer", instructions: "Answer the question; say whether you are sure.", out: "Answer", as: "answer", tier: "fast" },
    { node: "escalate", label: "unsure", when: { predicate: "field_equals", path: "answer.sure", value: false }, kind: "unsure", stage: "answer", summary: "not sure of {answer.answer}" },
  ] },
};
const FLOWS = [{ name: "answer", description: "Answers a question as a number", workflow: answerFlow }];
const DIGEST = workflowDigest({ workflow: JSON.stringify(answerFlow) });
const offers = (body, name) => (body?.tools ?? []).some((tool) => tool?.name === name);
const hasResult = (body) => (body?.messages ?? []).some((message) => Array.isArray(message.content) && message.content.some((block) => block?.type === "tool_result"));
const isNode = (request) => offers(request.body, "submit");

const until = async (done, what, ms = 60_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** An agent that learned `answer` and `graded` graded runs (their grade's `expected` fields: `expected`), a runner
 *  claiming every run from its stored launch. The node submits `{answer: 42, sure}`. */
async function world(t, { graded = 6, expected = { answer: 42 }, sure = true, flows = FLOWS, submit } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-promote-replay-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  const gw = await startFauxGateway({
    call: ({ body }) => (offers(body, "submit") && !hasResult(body) ? { name: "submit", input: { value: submit ? submit(JSON.stringify(body)) : { answer: 42, sure } } } : undefined),
    text: ({ body }) => (offers(body, "submit") ? "submitted" : AGENT_SAYS),
  });
  let runner;
  t.after(async () => {
    await runner?.close().catch(() => {});
    await gw.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read"], learning: true } });
  const seed = await landWorkflows(dir, "agent-1", flows);
  const launchOf = (question, at = seed) => ({ input: { content: `${question}?`, question }, title: question, place: { mode: "runner" }, model: { provider: "anthropic", modelId: MODEL }, learning: startAt(at) });
  // The graded runs: ended on the agent's path, each with its launch, read where the promotion reads them.
  const old = new Map(Array.from({ length: graded }, (_, i) => [`graded-${i}`, launchOf(`Question ${i}`)]));
  for (const [run, launch] of old) await putGrade(server.settings, "agent-1", { run, correct: true, expected, source: "eval", at: new Date().toISOString(), path: "agent" });
  const runsOf = Object.create(store.runs);
  for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(store.runs) ?? {})) if (typeof store.runs[key] === "function" && key !== "constructor") runsOf[key] = store.runs[key].bind(store.runs);
  runsOf.get = async (id) => (old.has(id) ? { id, agentId: "agent-1", revisionId: "rev-1", state: "ended", metrics: { path: "agent" }, archivedAt: null, importedFrom: null, costUsd: 0.01, startedAt: 1, endedAt: 2 } : store.runs.get(id));
  runsOf.launch = async (id) => (old.has(id) ? { runId: id, body: old.get(id), sealed: null, createdAt: 1 } : store.runs.launch(id));
  const depStore = new Proxy(store, { get: (target, key) => (key === "runs" ? runsOf : typeof target[key] === "function" ? target[key].bind(target) : target[key]) });
  const price = (_model, usage) => ((usage.input ?? 0) * 3 + (usage.output ?? 0) * 15) / 1e6;
  const route = { model: MODEL, provider: { api: "anthropic-messages", origin: gw.url, credential: () => `not-a-secret-${"pi"}` }, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, outputCeiling: 8_192, price, fetch: globalThis.fetch };
  const logs = [];
  const deps = { env: {}, data: dir, journal: (claim) => store.journal(claim), store: depStore, sealKey: SEAL_KEY, routeOf: async () => route, computerForClaim: async () => ({ release: async () => {} }), log: (line) => logs.push(line) };
  const specOf = async (claim, run) => adapterRunSpecFromLaunch(readLaunchBody((await store.runs.launch(claim.runId)).body), run, deps, claim);
  runner = startRunner({ store, name: "runner-a", ...TIMING, createLoop: createAdapterLoop(specOf) });
  const ended = (id) => until(async () => {
    const row = await server.runs.get(id);
    return ["ended", "failed", "stopped"].includes(row?.state) && row.runner === null && row;
  }, `run ${id} ended`);
  const start = async (id, question) => {
    // Launched as the server launches a run: at the learning folder's main now (a refit's revision once it landed).
    await server.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: launchOf(question, (await seedOf(dir, "agent-1")).sha) });
    return ended(id);
  };
  const replays = async () => (await server.runs.list({ agentId: "agent-1" })).filter((row) => row.id !== "run-1" && row.id !== "run-2");
  return { server, gw, logs, start, ended, replays, seed };
}

test("a new digest with graded inputs replays before it serves: the agent takes the run meanwhile; within the bar, the next run is served first", { timeout: 180_000 }, async (t) => {
  const { server, gw, logs, start, replays } = await world(t);
  const first = await start("run-1", "What is six times seven");
  assert.equal(first.state, "ended");
  assert.equal(first.metrics?.path, "agent", `the agent took the run while its workflow replays: ${JSON.stringify(first.metrics)}`);
  assert.ok(logs.some((line) => /replaying it on the agent's last 6 graded inputs/.test(line)), logs.join("\n"));
  // One replay run a graded input, each the workflow alone: path replay, answered, at workflow cost, no end-of-run turn.
  const runs = await until(async () => {
    const all = await replays();
    return all.length === 6 && all.every((row) => ["ended", "failed", "stopped"].includes(row.state) && row.runner === null) && all;
  }, "the six replay runs ended");
  for (const row of runs) {
    assert.equal(row.state, "ended", JSON.stringify(row));
    assert.equal(row.metrics?.path, "replay");
    assert.equal(row.metrics?.workflow_digest, DIGEST);
    assert.equal(row.metrics?.replay?.outcome, "answered");
    assert.match(row.metrics?.replay?.of, /^graded-\d$/);
    assert.ok(row.costUsd > 0, "at workflow cost: its node's request");
    assert.equal(await server.learning.proposal(row.id), undefined, "a replay asks nothing at its end");
  }
  assert.deepEqual([...new Set(runs.map((row) => row.metrics.replay.of))].sort(), Array.from({ length: 6 }, (_, i) => `graded-${i}`));
  const agentRequests = gw.requests.filter((request) => !isNode(request)).length;
  // The next fitting run: the replay is in, within the bar: promoted, and it serves first.
  const second = await start("run-2", "What is seven times six");
  assert.equal(second.metrics?.path, "workflow", JSON.stringify(second.metrics));
  assert.equal(gw.requests.filter((request) => !isNode(request)).length, agentRequests, "no agent request for the served run");
  const records = await promotionsOf(server.settings, "agent-1");
  assert.deepEqual(records.map(({ decided, source }) => [decided, source]), [["replaying", "replay"], ["promote", "replay"]]);
  const { replay } = records[1];
  assert.deepEqual({ ...replay, of: replay.of.length }, { n: 6, agree: 0, agent_acc: 1, wf_acc: 1, delta: 0, handed_back: 0, of: 6, cost_usd: replay.cost_usd });
  assert.ok(replay.cost_usd > 0, "what the replay cost is on its record");
  assert.equal(records[1].digest, DIGEST);
});

test("a replay the workflow hands back on counts as the agent's answer, never as a failure: it promotes, and no agent turn ran in it", { timeout: 180_000 }, async (t) => {
  const { server, gw, start, replays } = await world(t, { sure: false });
  await start("run-1", "What is six times seven");
  const agentAfterFirst = gw.requests.filter((request) => !isNode(request)).length;
  const runs = await until(async () => {
    const all = await replays();
    return all.length === 6 && all.every((row) => ["ended", "failed", "stopped"].includes(row.state) && row.runner === null) && all;
  }, "the six replay runs ended");
  assert.deepEqual(runs.map((row) => [row.state, row.metrics?.replay?.outcome]), runs.map(() => ["ended", "handed_back"]));
  assert.equal(gw.requests.filter((request) => !isNode(request)).length, agentAfterFirst, "a hand-back in replay asks the agent nothing");
  const second = await start("run-2", "What is seven times six");
  // Promoted (every input handed back: the agent's graded answers, all right); serving, it hands back to the agent.
  assert.equal(second.metrics?.path, "handed_back", JSON.stringify(second.metrics));
  const decided = (await promotionsOf(server.settings, "agent-1")).at(-1);
  assert.equal(decided.decided, "promote");
  assert.deepEqual({ wf_acc: decided.replay.wf_acc, agent_acc: decided.replay.agent_acc, handed_back: decided.replay.handed_back }, { wf_acc: 1, agent_acc: 1, handed_back: 6 });
});

test("a replay more than 2 points under the agent holds the digest: the next run is the agent's", { timeout: 180_000 }, async (t) => {
  const { server, start, replays, logs } = await world(t, { expected: { answer: 41 } });
  await start("run-1", "What is six times seven");
  await until(async () => {
    const all = await replays();
    return all.length === 6 && all.every((row) => ["ended", "failed", "stopped"].includes(row.state) && row.runner === null);
  }, "the six replay runs ended");
  const second = await start("run-2", "What is seven times six");
  assert.equal(second.metrics?.path, "agent", JSON.stringify(second.metrics));
  const decided = (await promotionsOf(server.settings, "agent-1")).at(-1);
  assert.deepEqual({ decided: decided.decided, source: decided.source, wf_acc: decided.replay.wf_acc, agent_acc: decided.replay.agent_acc, delta: decided.replay.delta }, { decided: "hold", source: "replay", wf_acc: 0, agent_acc: 1, delta: -1 });
  assert.match(decided.reason, /more than 2 pts under the agent/);
  assert.ok(logs.some((line) => /held/.test(line)), logs.join("\n"));
});

test("fewer than five graded inputs: promoted on its passing dry run, as before, and its record says so", { timeout: 120_000 }, async (t) => {
  const { server, start, replays } = await world(t, { graded: 3 });
  const first = await start("run-1", "What is six times seven");
  assert.equal(first.metrics?.path, "workflow", JSON.stringify(first.metrics));
  assert.deepEqual(await replays(), [], "no replay run");
  const [record] = await promotionsOf(server.settings, "agent-1");
  assert.deepEqual({ decided: record.decided, source: record.source, digest: record.digest }, { decided: "promote", source: "dry_run", digest: DIGEST });
  assert.match(record.reason, /3 graded inputs it fits, fewer than 5: promoted on its passing dry run/);
});

/** One guarded agent step (its own confidence, `self`), its guard at `threshold`. */
const guardedFlow = (threshold) => ({
  v: 2, name: "answer",
  schemas: {
    In: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
    Answer: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } },
  },
  input: { schemaId: "In" }, output: { schemaId: "Answer", path: "answer" },
  root: { node: "agent", label: "answer", instructions: "Answer the question.", out: "Answer", as: "answer", tools: [], tier: "fast", guard: { signal: "self", threshold } },
});

test("a replay held with a guard set too low gets one refit: the cheapest threshold within the bar lands as a new revision, promoted, and serves", { timeout: 180_000 }, async (t) => {
  // Odd questions: a wrong answer at confidence 0.3; even ones: right at 0.9. At threshold 0.1 the wrong ones serve.
  const submit = (text) => (/Question (\d+)/.exec(text)?.[1] % 2 === 1 ? { answer: 41, confidence: 0.3 } : { answer: 42, confidence: 0.9 });
  const flow = guardedFlow(0.1);
  const { server, start, replays, logs } = await world(t, { flows: [{ name: "answer", description: "Answers a question as a number", workflow: flow }], submit });
  const first = await start("run-1", "What is six times seven");
  assert.equal(first.metrics?.path, "agent");
  const runs = await until(async () => {
    const all = await replays();
    return all.length === 6 && all.every((row) => ["ended", "failed", "stopped"].includes(row.state) && row.runner === null) && all;
  }, "the six replay runs ended");
  // Record-only: every replay answered, its guard read at the least threshold the DSL takes.
  for (const row of runs) {
    assert.equal(row.metrics?.replay?.outcome, "answered", JSON.stringify(row.metrics));
    assert.deepEqual(row.metrics.guards.map(({ threshold, escalated }) => [threshold, escalated]), [[1e-9, false]]);
  }
  const second = await start("run-2", "What is seven times six");
  assert.equal(second.metrics?.path, "agent", "the held digest does not serve");
  const records = await promotionsOf(server.settings, "agent-1");
  const held = records.find((one) => one.decided === "hold");
  assert.equal(held.digest, workflowDigest({ workflow: JSON.stringify(flow) }));
  assert.deepEqual({ wf_acc: held.replay.wf_acc, agent_acc: held.replay.agent_acc }, { wf_acc: 0.5, agent_acc: 1 });
  const refit = records.at(-1);
  assert.deepEqual({ decided: refit.decided, source: refit.source, from: refit.refit.from, guards: refit.refit.guards }, { decided: "promote", source: "refit", from: held.digest, guards: [{ node: "answer", was: 0.1, threshold: 0.9 }] });
  assert.deepEqual({ wf_acc: refit.replay.wf_acc, delta: refit.replay.delta, handed_back: refit.replay.handed_back }, { wf_acc: 1, delta: 0, handed_back: 3 });
  assert.ok(logs.some((line) => /refit answer's guards over its replay held it \(6 rows\): answer 0\.1 -> 0\.9/.test(line)), logs.join("\n"));
  // The new revision is on the learning folder's main, at the refit's digest: the next run is laid from it.
  const third = await start("run-3", "Question 4");
  assert.equal(third.metrics?.workflow_digest, refit.digest, JSON.stringify(third.metrics));
  assert.equal(third.metrics?.path, "workflow", "an even question: sure enough, it serves");
  const fourth = await start("run-4", "Question 5");
  assert.equal(fourth.metrics?.path, "handed_back", "an odd one: under 0.9, handed back to the agent");
});
