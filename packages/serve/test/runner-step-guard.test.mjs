// Step guards on the runner (runner/step-guard.ts through workflow-first's served call, runner/workflow-first.ts): a pi
// run of an agent whose learned workflow fits starts on it, and the workflow's guarded step decides the run's path.
//   - a step whose guard puts p under its threshold hands the job back mid-run: the same run goes on to the agent,
//     whose first input carries the workflow's trace with the guard's row; path handed_back.
//   - one at or above it serves: the workflow's answer is the run's, path workflow.
//   - a guard that reads Jev asks it once, on the Jev key the claim opened for the workflow (claim-secrets.ts
//     learnedDecisionKeys), as a decision of the run (its one cap, ledger.decisions): what it charged is the run's cost
//     beside the node's model request.
//   - every check is a row of the run record: metrics.guards. The same on a CLI harness.
// pi's model and the node's go through the session proxy to a loopback gateway; Jev is the tests' fake (faux-jev.mjs,
// every yes 0.92) under the faux switch, on its canary key. No sleeps, no port races.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { CANARY } from "./fixtures/faux-jev.mjs";
import { landWorkflows, startAt } from "./learned-workflow-seed-support.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { cliRunSpecFromLaunch } = await import("../dist/runner/cli-run-spec.js");
const { CONFORMANCE_TIMING } = await import("../dist/runner/conformance/harness.js");
const { journalSessions } = await import("../dist/runner/sessions.js");
const { WORKFLOW_FIRST } = await import("../dist/runner/workflow-first.js");
const { runEntries, runTimeline } = await import("../dist/store-reads/journal.js");
const { FAUX_JEV_ENV, JEV_KEY_ENV } = await import("../dist/decisions.js");
const { FAUX_ENV } = await import("../dist/model.js");

const SEAL_KEY = Buffer.alloc(32, 7);
const RUN = "run-1";
const MODEL = "claude-sonnet-5-5";
const TIMING = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const QUESTION = "What is six times seven";
const AGENT_SAYS = "The agent's own answer: 42.";
const FAUX_JEV = new URL("./fixtures/faux-jev.mjs", import.meta.url).pathname;
const FAUX_ROUTE = new URL("./fixtures/faux-route.mjs", import.meta.url).pathname;

/** One guarded agent step answering the question (it submits its confidence beside its record). */
const flowOf = (guard) => ({
  v: 2, name: "answer",
  schemas: {
    In: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
    Answer: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } },
  },
  input: { schemaId: "In" }, output: { schemaId: "Answer", path: "answer" },
  root: { node: "agent", label: "answer", instructions: "Answer the question.", out: "Answer", as: "answer", tools: [], tier: "fast", guard },
});

const offers = (body, name) => (body?.tools ?? []).some((tool) => tool?.name === name);
const hasResult = (body) => (body?.messages ?? []).some((message) => Array.isArray(message.content) && message.content.some((block) => block?.type === "tool_result")) || (body?.input ?? []).some((item) => item?.type === "function_call_output");
const textOf = (body) => [
  ...(Array.isArray(body?.system) ? body.system.map((block) => block?.text ?? "") : [String(body?.system ?? "")]),
  ...(body?.messages ?? []).flatMap((message) => (typeof message.content === "string" ? [message.content] : (message.content ?? []).map((block) => block?.text ?? (Array.isArray(block?.content) ? block.content.map((c) => c?.text ?? "").join("") : String(block?.content ?? ""))))),
].join("\n");
const isNode = (request) => offers(request.body, "submit");

const until = async (done, what, ms = 40_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** The Jev the run's guard asks: the fake, under the faux switch, on its canary key in the runner's environment (the
 *  claim opens it for a workflow whose guard reads Jev); each call filed in `calls`. */
function jevEnv(t) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-guard-jev-"));
  const calls = join(dir, "calls.jsonl");
  writeFileSync(calls, "");
  const was = process.env.AGENTRUN_TEST_FAUX_JEV_CALLS;
  process.env.AGENTRUN_TEST_FAUX_JEV_CALLS = calls;
  t.after(() => {
    if (was === undefined) delete process.env.AGENTRUN_TEST_FAUX_JEV_CALLS;
    else process.env.AGENTRUN_TEST_FAUX_JEV_CALLS = was;
    rmSync(dir, { recursive: true, force: true });
  });
  return { env: { [FAUX_ENV]: FAUX_ROUTE, [FAUX_JEV_ENV]: FAUX_JEV, [JEV_KEY_ENV]: CANARY }, calls: () => readFileSync(calls, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) };
}

/** A pi run of an agent that learned `answer` (guarded by `guard`); its node submits `{answer, confidence}`; the agent,
 *  when asked, answers AGENT_SAYS. `env`: the runner's. */
async function piRun(t, { guard, confidence, env = {} }) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-step-guard-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  const gw = await startFauxGateway({
    call: ({ body }) => (offers(body, "submit") && !hasResult(body) ? { name: "submit", input: { value: { answer: confidence < 0.5 ? 41 : 42, confidence } } } : undefined),
    text: ({ body }) => (offers(body, "submit") ? "submitted" : AGENT_SAYS),
  });
  let runner;
  let reader;
  t.after(async () => {
    await runner?.close().catch(() => {});
    await reader?.close(ctx).catch(() => {});
    await gw.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read"], learning: true } });
  const seed = await landWorkflows(dir, "agent-1", [{ name: "answer", description: "Answers a question as a number", workflow: flowOf(guard) }]);
  const launch = { input: { content: `${QUESTION}?`, question: QUESTION }, title: "t", place: { mode: "runner" }, model: { provider: "anthropic", modelId: MODEL }, learning: startAt(seed) };
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  await server.flush?.();
  const price = (_model, usage) => ((usage.input ?? 0) * 3 + (usage.output ?? 0) * 15 + (usage.cacheRead ?? 0) * 0.3 + (usage.cacheWrite ?? 0) * 3.75) / 1e6;
  const route = { model: MODEL, provider: { api: "anthropic-messages", origin: gw.url, credential: () => `not-a-secret-${"pi"}` }, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, outputCeiling: 8_192, price, fetch: globalThis.fetch };
  const deps = { env, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => route, computerForClaim: async () => ({ release: async () => {} }), log: () => {} };
  runner = startRunner({ store, name: "runner-a", ...TIMING, createLoop: createAdapterLoop((claim, run) => adapterRunSpecFromLaunch(launch, run, deps, claim)) });
  const row = await until(async () => {
    const now = await server.runs.get(RUN);
    return ["ended", "failed", "stopped"].includes(now.state) && now.runner === null && now;
  }, "the run's end");
  reader = await Harness.open(server.journal({ runId: RUN, runner: "reader", epoch: row.epoch, until: 0, from: row.state }), { models: () => createModels(), registry: createRegistry(), onReport: () => {} }, ctx);
  const sessions = journalSessions(reader, ctx, server);
  const all = [];
  for (const key of await sessions.keys()) for (const record of await sessions.read(key)) all.push(record);
  const turns = all.filter((record) => record.kind === "runner.turn").map((record) => record.data);
  const timeline = await runTimeline(server, RUN, ctx, { settled: true });
  const entries = await runEntries(server, RUN, ctx);
  return { row, turns, timeline, entries, gateway: gw };
}

/** What the run's booking holds: its model requests' $ (a turn with usage) and its decisions' (a turn without). */
const sumUsd = (turns) => turns.reduce((sum, turn) => sum + (typeof turn.usd === "number" ? turn.usd : 0), 0);
const modelUsd = (turns) => sumUsd(turns.filter((turn) => turn.usage));
const decisionUsd = (turns) => turns.filter((turn) => !turn.usage).map((turn) => turn.usd);

test("a step its own confidence puts under its guard's threshold hands the job back mid-run: the agent gets the trace with the guard's row", async (t) => {
  const { row, timeline, entries, gateway } = await piRun(t, { guard: { signal: "self", threshold: 0.7 }, confidence: 0.3 });
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.deepEqual(entries.filter((entry) => entry.kind === WORKFLOW_FIRST).map((entry) => entry.data.outcome), ["handed_back"]);
  const firstAgent = gateway.requests.findIndex((request) => !isNode(request));
  assert.ok(firstAgent > 0 && gateway.requests.slice(0, firstAgent).every(isNode), `the node ran first: ${gateway.requests.map(isNode)}`);
  const said = textOf(gateway.requests[firstAgent].body);
  assert.match(said, /Your learned workflow `answer` ran first on this job and handed it back to you/);
  assert.match(said, /handed the job back at its step "answer": its guard put the chance this step is right at 0\.30 \(its own confidence 0\.30\), under its threshold 0\.7/);
  assert.match(said, /Its guards: guard on "answer" \(self\): p 0\.30 against threshold 0\.7 \(its own confidence 0\.30\); handed back\./);
  assert.equal(timeline.findLast((one) => ["assistant", "final_answer"].includes(one.kind))?.text, AGENT_SAYS);
  assert.equal(row.metrics?.path, "handed_back", JSON.stringify(row.metrics));
  assert.deepEqual(row.metrics?.guards, [{ node: "answer", signal: "self", self: 0.3, p: 0.3, threshold: 0.7, escalated: true }]);
});

test("a step sure enough of itself serves: the workflow's answer is the run's, path workflow, its guard's row kept", async (t) => {
  const { row, turns, gateway } = await piRun(t, { guard: { signal: "self", threshold: 0.7 }, confidence: 0.9 });
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.ok(gateway.requests.every(isNode), "no agent request");
  assert.equal(row.metrics?.path, "workflow", JSON.stringify(row.metrics));
  assert.deepEqual(row.metrics?.guards, [{ node: "answer", signal: "self", self: 0.9, p: 0.9, threshold: 0.7, escalated: false }]);
  assert.deepEqual(decisionUsd(turns), [], "a self guard asks Jev nothing");
  assert.ok(Math.abs((row.costUsd ?? 0) - modelUsd(turns)) < 1e-9, `a self guard costs nothing: ${row.costUsd} vs ${modelUsd(turns)}`);
});

test("both: Jev asked once on the claim's key, the lower of the two decides, and Jev's price is the run's cost beside the node's", async (t) => {
  const jev = jevEnv(t);
  const served = await piRun(t, { guard: { signal: "both", threshold: 0.7 }, confidence: 0.8, env: jev.env });
  assert.equal(served.row.state, "ended", JSON.stringify(served.row));
  assert.equal(served.row.metrics?.path, "workflow", JSON.stringify(served.row.metrics));
  assert.deepEqual(served.row.metrics?.guards, [{ node: "answer", signal: "both", self: 0.8, jev: 0.92, p: 0.8, threshold: 0.7, escalated: false }]);
  const calls = jev.calls();
  assert.equal(calls.length, 1, JSON.stringify(calls));
  assert.equal(calls[0].authorized, true, "on the canary key the claim opened");
  // Its one decision on the run's cap, at what Jev charged (the faux reports no cost: TypeSafe's published price for its
  // input tokens); the run's cost is the node's model request and it together.
  const [jevUsd, ...others] = decisionUsd(served.turns);
  assert.deepEqual(others, [], JSON.stringify(served.turns));
  assert.ok(jevUsd > 0 && jevUsd < 0.0001, `the Jev call is booked: ${JSON.stringify(served.turns)}`);
  assert.ok(Math.abs((served.row.costUsd ?? 0) - (modelUsd(served.turns) + jevUsd)) < 1e-12, `the run's cost is the node's and Jev's: ${served.row.costUsd} vs ${modelUsd(served.turns)} + ${jevUsd}`);
  assert.ok(!JSON.stringify(served.row).includes(CANARY), "the key is in no record");
});

test("both, with the step sure but Jev less so than the threshold: the job is handed back, the row says both signals", async (t) => {
  const jev = jevEnv(t);
  const { row } = await piRun(t, { guard: { signal: "both", threshold: 0.95 }, confidence: 0.99, env: jev.env });
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.equal(row.metrics?.path, "handed_back", JSON.stringify(row.metrics));
  assert.deepEqual(row.metrics?.guards, [{ node: "answer", signal: "both", self: 0.99, jev: 0.92, p: 0.92, threshold: 0.95, escalated: true }]);
});

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const HARNESS = "codex";

test("CLI: a guard under its threshold hands back to the harness with the guard's row; its row is in the run record", async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-step-guard-cli-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  const gw = await startFauxGateway({ call: ({ body }) => (offers(body, "submit") && !hasResult(body) ? { name: "submit", input: { value: { answer: 41, confidence: 0.2 } } } : undefined) });
  let runner;
  t.after(async () => {
    await runner?.close().catch(() => {});
    await gw.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: "Say your thinking.", harness: HARNESS, tools: ["read"], learning: true } });
  const seed = await landWorkflows(dir, "agent-1", [{ name: "answer", description: "Answers a question as a number", workflow: flowOf({ signal: "self", threshold: 0.5 }) }]);
  const launch = { input: { content: `${QUESTION}?`, question: QUESTION }, title: "t", place: { mode: "runner" }, harness: HARNESS, model: { provider: "openai", modelId: "gpt-6.1-terra" }, learning: startAt(seed) };
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  await server.flush?.();
  const env = { AGENT_MODEL_BASE_URL: gw.url, AGENT_MODEL: "gpt-6.1-terra", AGENT_MODEL_API_KEY: `not-a-secret-${"gateway"}`, AGENT_MODEL_PRICE: "1,2,0.5", AGENTRUN_HARNESS_TABLE: fauxTable(FAUX_HARNESS), NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT ?? "1" };
  const deps = { env, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => assert.fail("a CLI run takes no pi route"), computerForClaim: async () => ({ release: async () => {} }) };
  runner = startRunner({
    store, name: "runner-a", ...CONFORMANCE_TIMING, leaseMs: 60_000, stopMarginMs: 5_000,
    createLoop: createDispatchLoop({
      launchOf: (runId) => store.runs.launch(runId),
      resolve: (name, given) => (name === HARNESS ? createAdapterLoop((claim, run) => cliRunSpecFromLaunch(given, run, deps, claim)) : undefined),
    }),
  });
  const row = await until(async () => {
    const now = await server.runs.get(RUN);
    return ["ended", "failed", "stopped"].includes(now.state) && now.runner === null && now;
  }, "the run's end");
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.equal(row.metrics?.path, "handed_back", JSON.stringify(row.metrics));
  assert.deepEqual(row.metrics?.guards, [{ node: "answer", signal: "self", self: 0.2, p: 0.2, threshold: 0.5, escalated: true }]);
  const timeline = await runTimeline(server, RUN, ctx, { settled: true });
  const handed = timeline.find((one) => /handed it back to you/.test(one.text ?? ""));
  assert.ok(handed, JSON.stringify(timeline.map(({ kind, text }) => [kind, text?.slice(0, 80)])));
  assert.match(handed.text, /Its guards: guard on "answer" \(self\): p 0\.20 against threshold 0\.5 \(its own confidence 0\.20\); handed back\./);
  assert.ok(gw.requests.some((request) => request.body && offers(request.body, "submit")), "the node asked the model");
});
