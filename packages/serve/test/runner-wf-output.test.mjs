// A workflow run's answer is its output: main's server reads it once the workflow completes (runs.ts workflowEnd:
// readWorkflowRun's `output`, the value at the workflow's output path), keeps it on the run, and serves it as result.output,
// each string in it cut of the values the run holds and its shape kept (servedOutput). On the runner the workflow loop's
// end is where the run completes, so the end keeps the output, and the store-backed view (viewOverStore) serves it the
// way main does.
//
// Through the real loop (startRunner over createWorkflowLoop and workflowSpecOf) on a real store.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { anthropicPolicy } from "@parcha/agentrun-harness-claude";
import { scriptedOrigin } from "./conformance-pi-adapter.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createWorkflowLoop } = await import("../dist/runner/workflow-loop.js");
const { workflowSpecOf } = await import("../dist/runner/workflow-spec.js");
const { viewOverStore } = await import("../dist/store-view.js");
const { readWorkflowRunOver } = await import("../dist/store-reads/workflow.js");

const TIMING = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const PRICED = Object.freeze({ id: "faux-priced", api: "anthropic-messages", price: { input: 0, output: 100, cacheRead: 0, cacheWrite: 0 }, outputCeiling: 16_384 });
/** A value the server holds as a secret (at least MIN_SECRET long): a run's answer that repeats it is served cut of it. */
const HELD = `held-value-${"x".repeat(24)}`;

/** A one-model-node workflow: it reads {question} and submits `Out`, the workflow's output (output.path "answer"). */
const flow = (out) => ({
  v: 2, name: "answer",
  schemas: { In: { type: "object", additionalProperties: true }, Out: out },
  input: { schemaId: "In" },
  output: { schemaId: "Out", path: "answer" },
  root: { node: "extract", label: "answer", instructions: "Answer the question.", out: "Out", as: "answer" },
});

/** run-1 of `workflow`, its node submitting `submitted`; its view as GET /runs/{id} answers it from the store, and the
 *  workflow's own view read back from its journal (main's readWorkflowRun). */
async function endedRun(t, workflow, submitted) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-wf-output-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Flow" }, { id: "rev-1", kind: "workflow", body: { workflow } });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { question: "Six times seven?" }, title: "t", place: { mode: "runner" }, max_cost_usd: 100 } });
  const fetch = scriptedOrigin([{ call: "submit", args: submitted }], []);
  const providerOf = () => ({
    modelId: "faux-priced", api: "anthropic-messages", origin: "https://faux.invalid", credential: () => `not-a-secret-${"o"}`,
    policy: anthropicPolicy({ model: "faux-priced", tools: [] }), price: (_model, usage) => (usage.output ?? 0) * 100 / 1e6, capModel: PRICED, fetch,
  });
  runner = startRunner({ store, createLoop: createWorkflowLoop(workflowSpecOf({ store, providerOf })), name: "runner-a", ...TIMING });
  const from = Date.now();
  for (;;) {
    const row = await server.runs.get("run-1");
    if (["ended", "failed", "stopped"].includes(row.state) && row.runner === null) break;
    if (Date.now() - from > 30_000) assert.fail(`the run never ended: ${JSON.stringify({ state: row.state, summary: row.summary })}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const view = await viewOverStore(server, "run-1", { origin: "http://127.0.0.1:1", serverSecrets: () => [HELD] });
  const workflowView = await readWorkflowRunOver(server, "run-1");
  return { view, workflowView };
}

test("a workflow whose last node returns an object ends with result.output equal to it, main's output (readWorkflowRun's)", async (t) => {
  const { view, workflowView } = await endedRun(t, flow({ type: "object", required: ["answer"], properties: { answer: { type: "number" } } }), { answer: 42 });
  assert.equal(view.status, "completed", JSON.stringify({ status: view.status, error: view.error }));
  assert.deepEqual(view.result?.output, { answer: 42 }, `result.output is the node's object: ${JSON.stringify(view.result)}`);
  // Main's source exactly: the workflow's own output, as main's workflowEnd read it (readWorkflowRun(...).output).
  assert.deepEqual(view.result.output, workflowView?.output, "the same value main's readWorkflowRun gives");
  assert.equal(view.result.final_answer, null, "a workflow run's answer is its output, never a final_answer");
});

test("a workflow's output repeating a value the server holds is served cut of it, its shape kept (main's servedOutput)", async (t) => {
  const { view } = await endedRun(t, flow({ type: "object", required: ["note", "n"], properties: { note: { type: "string" }, n: { type: "number" } } }), { note: `the key is ${HELD}`, n: 7 });
  assert.equal(view.status, "completed", JSON.stringify({ status: view.status, error: view.error }));
  const output = view.result?.output;
  assert.ok(output && typeof output === "object", `an object: ${JSON.stringify(view.result)}`);
  assert.deepEqual(Object.keys(output).sort(), ["n", "note"], "its shape kept");
  assert.equal(output.n, 7);
  assert.ok(typeof output.note === "string" && !output.note.includes(HELD) && output.note.startsWith("the key is "), `the held value cut: ${output.note}`);
});
