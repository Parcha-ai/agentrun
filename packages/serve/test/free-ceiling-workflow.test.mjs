// A workflow's model nodes on a free model count toward the run's limit on free-model requests, and a workflow that
// reaches it ends `failed` in the limit's words, capped or not. Without a dollar cap the workflow has no cap rule to park
// with, so the limit's refusal (for good) ends the run itself: it is never handed back for another claim, which would
// meet the same refusal again. Nor does an `llm` call node's refusal end as the call's failure: the run ends at the limit.
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

const TIMING = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
/** A free model: its catalog price all zeros. */
const FREE = Object.freeze({ id: "faux-free", api: "anthropic-messages", price: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, outputCeiling: 16_384 });

/** Two extract nodes, one after the other: each makes one model request (its submit). */
const workflow = {
  v: 2, name: "two-notes",
  schemas: { In: { type: "object", additionalProperties: true }, Note: { type: "object", required: ["n"], properties: { n: { type: "number" } } } },
  input: { schemaId: "In" },
  output: { schemaId: "Note", path: "second" },
  root: { node: "chain", steps: [
    { node: "extract", label: "first", instructions: "Note it.", out: "Note", as: "first" },
    { node: "extract", label: "second", instructions: "Note it again.", out: "Note", as: "second" },
  ] },
};

/** Two `llm` call nodes, one after the other: each makes one model request, inside its call's effect. */
const LLM = { type: "object", required: ["text"], properties: { text: { type: "string" } } };
const llmCalls = {
  v: 2, name: "two-calls",
  schemas: { In: { type: "object", additionalProperties: true }, Llm: LLM },
  input: { schemaId: "In" },
  output: { schemaId: "Llm", path: "c1" },
  root: { node: "chain", steps: ["call-0", "call-1"].map((label, index) => ({ node: "call", label, via: "tool", tool: "llm", args: { prompt: `${label}: say ok.` }, out: "Llm", as: `c${index}`, deadline_s: 60 })) },
};
const sse = (events) => new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
/** The `llm` calls' origin: each request answered "ok", and kept. */
const okOrigin = (sent) => async (_url, init = {}) => {
  const body = JSON.parse(String(init.body ?? "{}"));
  sent.push(body);
  return sse([
    { type: "message_start", message: { id: "msg_0", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } },
    { type: "message_stop" },
  ]);
};

/** run-1 of `flow` (the extract chain, or the llm calls with the `llm` tool granted) on the free model under a limit of
 *  one free request, capped at `capUsd` or not: its row once it ends (or the last row seen when it never does), its
 *  view, and the model requests that reached the provider. */
async function limitedRun(t, capUsd, flow = workflow) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-free-wf-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  const calls = flow === llmCalls;
  await server.agents.create({ id: "agent-1", name: "Flow" }, { id: "rev-1", kind: "workflow", body: { workflow: flow, ...(calls ? { tools: ["llm"] } : {}) } });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { doc: "a doc" }, title: "t", place: { mode: "runner" }, ...(capUsd === undefined ? {} : { max_cost_usd: capUsd }) } });
  const sent = [];
  const fetch = calls ? okOrigin(sent) : scriptedOrigin([{ call: "submit", args: { n: 1 } }], sent);
  const providerOf = () => ({
    modelId: FREE.id, api: "anthropic-messages", origin: "https://faux.invalid", credential: () => `not-a-secret-${"o"}`,
    policy: anthropicPolicy({ model: FREE.id, tools: [] }), price: () => 0, capModel: FREE, fetch,
  });
  runner = startRunner({ store, createLoop: createWorkflowLoop(workflowSpecOf({ store, providerOf, env: { AGENTRUN_FREE_MODEL_REQUESTS: "1" } })), name: "runner-a", ...TIMING });
  const from = Date.now();
  let row;
  for (;;) {
    row = await server.runs.get("run-1");
    if (["ended", "failed", "stopped"].includes(row.state) && row.runner === null) break;
    if (Date.now() - from > 20_000) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const view = await viewOverStore(server, "run-1", { origin: "http://127.0.0.1:1", serverSecrets: () => [] });
  return { row, view, sent };
}

for (const capUsd of [undefined, 100]) {
  test(`a workflow on a free model past the limit ends failed in the limit's words (${capUsd === undefined ? "no cap" : "capped"}), never handed back for another claim`, { timeout: 60_000 }, async (t) => {
    const { row, view, sent } = await limitedRun(t, capUsd);
    assert.equal(row.state, "failed", `the run ends failed: ${JSON.stringify({ state: row.state, summary: row.summary, runner: row.runner })}`);
    assert.equal(row.summary, "spend_cap_reached: Not sent: this run reached its 1-request limit for free models.");
    assert.deepEqual(view.error && { code: view.error.code, message: view.error.message }, { code: "spend_cap_reached", message: "Not sent: this run reached its 1-request limit for free models." });
    assert.equal(sent.length, 1, "the first node's request was sent; the second node's was refused before it was");
  });

  // An `llm` call node's request is refused inside its call's effect, where a refusal a raise could fix only fails the
  // call. The limit's refusal is for good, and every free request after it would be refused too: the run ends at it, in
  // its words and code, never as a call's failure ("failed at call-1").
  test(`a workflow whose llm call on a free model meets the limit ends failed in the limit's words (${capUsd === undefined ? "no cap" : "capped"})`, { timeout: 60_000 }, async (t) => {
    const { row, view, sent } = await limitedRun(t, capUsd, llmCalls);
    assert.equal(row.state, "failed", `the run ends failed: ${JSON.stringify({ state: row.state, summary: row.summary, runner: row.runner })}`);
    assert.equal(row.summary, "spend_cap_reached: Not sent: this run reached its 1-request limit for free models.");
    assert.deepEqual(view.error && { code: view.error.code, message: view.error.message }, { code: "spend_cap_reached", message: "Not sent: this run reached its 1-request limit for free models." });
    assert.equal(sent.length, 1, "the first call's request was sent; the second call's was refused before it was");
  });
}
