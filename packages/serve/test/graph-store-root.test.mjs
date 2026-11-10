// A workflow run's graph over the one store reads its journal and nothing on the disk (graph-view.ts runGraph,
// run-reads-over-store.ts runGraphView). There is no run directory: a stray live.json or nodes.jsonl in the server's
// working directory never reaches any run's graph; a run that still goes shows its calls from the journal's effect
// records; and an ended run's cost is its own, each call counted once.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { createWorkflowExtension, nodeRunner, taskScope } from "@parcha/agentrun-pi/durable";
import { inspectWorkflow } from "@parcha/agentrun-dsl";
import { startWorkflowRevision } from "@parcha/pi-durable-agent/workflow";
import { storeOn } from "./store-helpers.mjs";
import { FAUX, flowAgent, follow, serve } from "./support.mjs";

const { runGraphView } = await import("../dist/run-reads-over-store.js");
const { runModels, FAUX_ENV } = await import("../dist/model.js");

const FAUX_PRICED = new URL("./fixtures/faux-priced.mjs", import.meta.url).pathname;

// The stray files every case here runs beside: the server's working directory holds a live view and a node log that no
// run wrote. Each would show on a graph read from the working directory: a decision, a call, and an llm answer's $100.
const STRAY = "stray_tool";
const home = process.cwd();
let stray;
before(() => {
  stray = mkdtempSync(join(tmpdir(), "graph-stray-"));
  const at = new Date().toISOString();
  writeFileSync(join(stray, "live.json"), JSON.stringify({ at, pin: { done: ["/root/steps/0"] }, receipts: [{ decision_id: "stray-decision", execution_path: "/root/steps/0", kind: "classify", cost_usd: 5 }] }));
  writeFileSync(join(stray, "nodes.jsonl"), [
    { t: "effect.start", path: "/root/steps/0", item: null, tool: STRAY, label: "stray", input: { stray: true }, at },
    { t: "effect.end", path: "/root/steps/0", item: null, tool: STRAY, label: "stray", status: "done", output: { stray: true }, at },
    { t: "effect.start", path: "/root/steps/0", item: null, tool: "llm", label: "stray", input: {}, at },
    { t: "effect.end", path: "/root/steps/0", item: null, tool: "llm", label: "stray", status: "done", output: { text: "stray", cost_usd: 100 }, at },
  ].map((line) => JSON.stringify(line)).join("\n") + "\n");
  process.chdir(stray);
});
after(() => {
  process.chdir(home);
  rmSync(stray, { recursive: true, force: true });
});

/** A workflow of one call node `fetch_it`, its answer the run's output. */
const callFlow = {
  v: 2, name: "call-once",
  schemas: {
    In: { type: "object", properties: {} },
    Got: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
  },
  input: { schemaId: "In" },
  output: { schemaId: "Got", path: "got" },
  root: { node: "chain", steps: [{ node: "call", label: "fetch it", via: "tool", tool: "fetch_it", args: { q: "x" }, out: "Got", as: "got", deadline_s: 120 }] },
};

/** A workflow run in the one store, its call node held until `release()`: the DSL's durable runner on the run's journal. */
async function heldCallRun(t) {
  const { store } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "agent-1" }, { id: "rev-1", kind: "workflow", body: { workflow: callFlow } });
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const { models } = await runModels({ [FAUX_ENV]: FAUX }, undefined, ["default"]);
  let calling;
  const called = new Promise((resolve) => { calling = resolve; });
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  const nodes = nodeRunner({ agent: () => ({ model: undefined, extensions: [], tools: [] }) });
  const workflows = createWorkflowExtension({
    run: ({ runtime, context }) => ({
      adapters: {
        runNode: nodes.on(taskScope(runtime), context).runNode,
        runEffect: async ({ input }) => { calling(); await released; return { text: `fetched ${input.q}` }; },
      },
      durableNodes: true,
    }),
  });
  const registry = createRegistry();
  registry.install(nodes.extension);
  registry.install(workflows.extension);
  const harness = await Harness.open(store.journal(claim), { models, registry, onReport: () => {} }, BACKGROUND_CONTEXT);
  t.after(() => harness.close(BACKGROUND_CONTEXT).catch(() => undefined));
  const outcome = startWorkflowRevision({
    harness, workflows, context: BACKGROUND_CONTEXT,
    run: { runId: "run-1", agentId: "agent-1", revision: { id: "rev-1", kind: "workflow", body: { workflow: callFlow } } },
    input: {}, tools: inspectWorkflow(callFlow).requires.tools,
  });
  return { store, called, release, outcome };
}

const startedAt = new Date().toISOString();
const graphDeps = (view) => ({
  env: {}, runWorkspace: async () => null, runView: async () => view, withheld: async () => false,
  cutValues: async () => ({ values: [] }), context: BACKGROUND_CONTEXT,
});
const viewOf = (status, endedAt = null) => ({ kind: "workflow", agent_id: "agent-1", revision: "rev-1", status, created_at: startedAt, ended_at: endedAt });

test("a stray live.json and nodes.jsonl in the server's working directory never reach a run's graph, while it goes or once it ended", async (t) => {
  const { store, called, release, outcome } = await heldCallRun(t);
  await called;
  await store.flush();
  const going = await runGraphView(store, "run-1", graphDeps(viewOf("running")));
  assert.ok(!going.decisions.some((d) => d.id === "stray-decision"), `no stray decision while it goes: ${JSON.stringify(going.decisions)}`);
  assert.ok(!going.effects.some((e) => e.tool === STRAY || e.tool === "llm"), `no stray call while it goes: ${JSON.stringify(going.effects)}`);
  assert.equal(going.totals.cost_usd, 0, "no stray decision's or llm answer's cost while it goes");
  release();
  assert.equal((await outcome).status, "complete");
  await store.flush();
  const ended = await runGraphView(store, "run-1", graphDeps(viewOf("completed", new Date().toISOString())));
  assert.ok(!ended.decisions.some((d) => d.id === "stray-decision"), "no stray decision once it ended");
  assert.ok(!ended.effects.some((e) => e.tool === STRAY), `no stray call once it ended: ${JSON.stringify(ended.effects)}`);
});

test("a workflow run that still goes shows its call from its journal: working while it runs, done with its input and output once it answered", async (t) => {
  const { store, called, release, outcome } = await heldCallRun(t);
  await called;
  await store.flush();
  const going = await runGraphView(store, "run-1", graphDeps(viewOf("running")));
  assert.deepEqual(going.effects.map((e) => [e.tool, e.status, e.node, e.executionPath]), [["fetch_it", "working", "/root/steps/0", "/root/steps/0"]], JSON.stringify(going.effects));
  assert.deepEqual(going.effects[0].input, { q: "x" });
  assert.equal(going.effects[0].endedAt, null);
  assert.equal(going.totals.effects, 1);
  release();
  assert.equal((await outcome).status, "complete");
  await store.flush();
  const ended = await runGraphView(store, "run-1", graphDeps(viewOf("completed", new Date().toISOString())));
  assert.deepEqual(ended.effects.map((e) => [e.tool, e.status]), [["fetch_it", "done"]], JSON.stringify(ended.effects));
  assert.deepEqual(ended.effects[0].output, { text: "fetched x" });
  assert.equal(typeof ended.effects[0].endedAt, "string", "a done call has an end, so it is never drawn as still going");
  assert.equal(ended.nodes["/root/steps/0"].status, "done");
});

test("a graph read that fails on a value it parses answers internal in fixed words, and logs the failure with no part of the value it quoted", async (t) => {
  const { store } = await storeOn(t);
  const held = "sk-held-graph-0123456789";
  // V8's JSON.parse error quotes about ten characters of its input: here the start of a held key.
  const thrown = (() => { try { JSON.parse(`${held} and more`); } catch (error) { return error; } })();
  assert.match(thrown.message, /sk-held/, "the parse error quotes its input");
  const logged = [];
  const deps = { ...graphDeps(viewOf("running")), runView: async () => { throw thrown; }, cutValues: async () => ({ values: [held] }), log: (line) => logged.push(line) };
  await assert.rejects(runGraphView(store, "run-1", deps), (error) => {
    assert.equal(error.code, "internal");
    assert.equal(error.message, "the run's graph could not be read");
    return true;
  });
  assert.equal(logged.length, 1, JSON.stringify(logged));
  assert.match(logged[0], /run-1/);
  assert.match(logged[0], /SyntaxError/);
  assert.doesNotMatch(logged[0], /sk-h|held-graph/, `no part of the quoted value is logged: ${logged[0]}`);
});

/** A workflow of one `llm` call: the question's answer, in one completion. */
const llmFlow = {
  v: 2, name: "ask-once",
  schemas: {
    In: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
    Llm: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
  },
  input: { schemaId: "In" },
  output: { schemaId: "Llm", path: "answer" },
  root: { node: "chain", steps: [{ node: "call", label: "answer", via: "tool", tool: "llm", args: { prompt: "{question}" }, out: "Llm", as: "answer", deadline_s: 120 }] },
};

test("an ended workflow run's graph counts its priced llm call once: its total is the run's own cost, and the call is on it", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t, { faux: FAUX_PRICED });
  assert.equal((await api("POST", "/agents", flowAgent("asker", llmFlow, { tools: ["llm"] }))).status, 201);
  const { body } = await api("POST", "/agents/asker/runs", { input: { question: "What is six times seven?" } });
  await follow(api, body.run_id, ["completed"], { deadlineMs: 60_000 });
  const cost = (await api("GET", `/runs/${body.run_id}`)).body.cost.usd;
  assert.ok(cost > 0, `the run paid for its call: ${cost}`);
  const graph = (await api("GET", `/runs/${body.run_id}/graph`)).body;
  assert.deepEqual(graph.effects.map((e) => [e.tool, e.status]), [["llm", "done"]], JSON.stringify(graph.effects));
  assert.equal(graph.totals.cost_usd, cost, "its graph's total is the run's cost: the call once, not again from its answer");
});
