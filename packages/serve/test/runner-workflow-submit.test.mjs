// A workflow's model node submits on the runner: its request reaches the model with the node's `submit` (pi's
// host-tools.ts SUBMIT_TOOL) and the node's own tools offered. Main's per-run process sends a node's request straight to
// its provider (app.ts:117, runModels), so the node's tools go as offered; on the runner every model request goes
// through the session proxy, whose policy drops each tool definition it is not given, so the workflow's proxy policy
// admits the node's whole offered set (as pi's admits its session's tools). The origin here answers a tool only when the
// request offers it, as a model does (the faux model's rule): a node whose `submit` was dropped can never submit.
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

const TIMING = { leaseMs: 1_000, renewEveryMs: 250, stopMarginMs: 300, pollMs: 20, commandPollMs: 30 };
const PRICED = Object.freeze({ id: "faux-priced", api: "anthropic-messages", price: { input: 0, output: 100, cacheRead: 0, cacheWrite: 0 }, outputCeiling: 16_384 });

/** A one-model-node workflow (extract): it reads {question} and submits {answer}. */
const answerFlow = () => ({
  v: 2, name: "answer",
  schemas: { In: { type: "object", required: ["question"], properties: { question: { type: "string" } } }, Answer: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } } },
  input: { schemaId: "In" },
  output: { schemaId: "Answer", path: "answer" },
  root: { node: "extract", label: "answer", instructions: "Answer the question.", out: "Answer", as: "answer" },
});

test("a one-node answer workflow completes on the runner: its request offers the node's submit, and the model's submit ends it", async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-wf-submit-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Flow" }, { id: "rev-1", kind: "workflow", body: { workflow: answerFlow() } });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { question: "Six times seven?" }, title: "t", place: { mode: "runner" }, max_cost_usd: 100 } });
  const requests = [];
  const fetch = scriptedOrigin([{ call: "submit", args: { answer: 42 } }], requests);
  // The provider's own policy offers nothing: the workflow's spec admits the node's tools whatever it is given.
  const providerOf = () => ({
    modelId: "faux-priced", api: "anthropic-messages", origin: "https://faux.invalid", credential: () => `not-a-secret-${"s"}`,
    policy: anthropicPolicy({ model: "faux-priced", tools: [] }), price: (_model, usage) => (usage.output ?? 0) * 100 / 1e6, capModel: PRICED, fetch,
  });
  runner = startRunner({ store, createLoop: createWorkflowLoop(workflowSpecOf({ store, providerOf })), name: "runner-a", ...TIMING });
  const from = Date.now();
  let row;
  for (;;) {
    row = await server.runs.get("run-1");
    if (["ended", "failed", "stopped"].includes(row.state) && row.runner === null) break;
    if (Date.now() - from > 30_000) assert.fail(`the run never ended: ${JSON.stringify({ state: row.state, summary: row.summary })}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok((requests[0]?.tools ?? []).some((tool) => tool.name === "submit"), `the node's request offers submit: ${JSON.stringify((requests[0]?.tools ?? []).map((tool) => tool.name))}`);
  assert.equal(row.state, "ended", JSON.stringify({ state: row.state, summary: row.summary }));
});
