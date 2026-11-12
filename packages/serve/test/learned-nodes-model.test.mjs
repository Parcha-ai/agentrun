// A learned workflow's model nodes keep the model each ran on, and its tier, in the call's trace (LEARNED_NODES), so a
// run's timeline row shows which model a node ran on: a node of a tier, its tier and that tier's model; a node of none,
// its model alone. The workflow's model nodes run on a stand-in model registry: no network, no key.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { learnedWorkflowTool } from "../dist/learned-workflow.js";
import { LEARNED_NODES } from "../dist/learned-nodes.js";
import { PORT_PROVIDER } from "../dist/port-models.js";

const MODEL = { id: "stand-in", provider: "stand-in", api: "stand-in", name: "stand-in", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 4_000 };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const message = (content, stopReason) => ({ role: "assistant", content, stopReason, api: MODEL.api, provider: MODEL.provider, model: MODEL.id, usage, timestamp: Date.now() });

const FLOW = {
  v: 2, name: "two-tiers",
  schemas: {
    In: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
    Answer: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } },
  },
  input: { schemaId: "In" },
  output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [
    { node: "extract", label: "quick look", tier: "fast", instructions: "Answer the question.", out: "Answer", as: "first" },
    { node: "extract", label: "final answer", instructions: "Answer it again.", out: "Answer", as: "answer" },
  ] },
};

test("a learned workflow's trace names the model each model node ran on, and its tier when it names one", { timeout: 60_000 }, async (t) => {
  const work = mkdtempSync(join(tmpdir(), "learned-model-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  let requests = 0;
  const models = {
    getModel: () => MODEL,
    getModels: () => [MODEL],
    completeSimple: async (_model, context) => {
      requests += 1;
      const answered = (context?.messages ?? []).some((m) => m.role === "toolResult");
      return answered ? message([{ type: "text", text: "Done." }], "stop") : message([{ type: "toolCall", id: `submit-${requests}`, name: "submit", arguments: { value: { answer: 42 } } }], "toolUse");
    },
  };
  // As a run hands the tool its models: a node of no tier on the session's own port, named by the run's route (modelName);
  // a node of the fast tier on that tier's own model, named by its id (a host with AGENT_MODEL_FAST set, #2408's routes).
  const modelOf = (tier) => (tier === "fast" ? { provider: `${PORT_PROVIDER}-fast`, modelId: "gpt-5-mini" } : { provider: PORT_PROVIDER, modelId: "session" });
  const modelName = () => "gpt-5-4-mini";
  const tool = learnedWorkflowTool({ workflows: [{ name: "two-tiers", description: "Two tiers", workflow: JSON.stringify(FLOW) }], granted: [], env: {}, work, models, modelOf, modelName, policy: () => "allow", denyFrom: () => "default" });
  const kept = [];
  const api = { callId: "call-1", commit: async (change) => change({ appendEntry: async (_conversation, entry) => void kept.push(entry) }) };
  const said = await tool.execute({ name: "two-tiers", input: { question: "six times seven" } }, api, { abortSignal: new AbortController().signal });
  assert.equal(said.isError, false, JSON.stringify(said));
  const trace = kept.find((entry) => entry.kind === LEARNED_NODES)?.data?.nodes;
  assert.deepEqual(trace?.map(({ label, kind, status, model, tier }) => ({ label, kind, status, model, tier })), [
    { label: "quick look", kind: "extract", status: "ok", model: "gpt-5-mini", tier: "fast" },
    { label: "final answer", kind: "extract", status: "ok", model: "gpt-5-4-mini", tier: undefined },
  ], JSON.stringify(trace));
  assert.equal("tier" in trace[1], false, "a node of no tier has no tier key");
});

// Review on #2513: a learned workflow may repeat a label. Each node's model is kept by its own execution (its execution
// path), never by its label: two parallel model nodes of one label and different tiers each keep their own.
test("two model nodes with one label each keep the model they ran on", { timeout: 60_000 }, async (t) => {
  const work = mkdtempSync(join(tmpdir(), "learned-model-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  let requests = 0;
  const models = {
    getModel: () => MODEL,
    getModels: () => [MODEL],
    completeSimple: async (_model, context) => {
      requests += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      const answered = (context?.messages ?? []).some((m) => m.role === "toolResult");
      return answered ? message([{ type: "text", text: "Done." }], "stop") : message([{ type: "toolCall", id: `submit-${requests}`, name: "submit", arguments: { value: { answer: 42 } } }], "toolUse");
    },
  };
  const flow = { ...FLOW, name: "same-label", root: { node: "chain", steps: [
    { node: "parallel", label: "both", branches: [
      { node: "extract", label: "check", tier: "fast", instructions: "Answer the question.", out: "Answer", as: "a" },
      { node: "extract", label: "check", instructions: "Answer it again.", out: "Answer", as: "b" },
    ] },
    { node: "extract", label: "final answer", instructions: "Answer it.", out: "Answer", as: "answer" },
  ] } };
  const modelOf = (tier) => (tier === "fast" ? { provider: `${PORT_PROVIDER}-fast`, modelId: "gpt-5-mini" } : { provider: PORT_PROVIDER, modelId: "session" });
  const tool = learnedWorkflowTool({ workflows: [{ name: "same-label", description: "Same label", workflow: JSON.stringify(flow) }], granted: [], env: {}, work, models, modelOf, modelName: () => "gpt-5-4-mini", policy: () => "allow", denyFrom: () => "default" });
  const kept = [];
  const api = { callId: "call-1", commit: async (change) => change({ appendEntry: async (_conversation, entry) => void kept.push(entry) }) };
  const said = await tool.execute({ name: "same-label", input: { question: "six times seven" } }, api, { abortSignal: new AbortController().signal });
  assert.equal(said.isError, false, JSON.stringify(said));
  const trace = kept.find((entry) => entry.kind === LEARNED_NODES)?.data?.nodes ?? [];
  const checks = trace.filter((n) => n.label === "check").map(({ model, tier }) => `${tier ?? "-"}:${model}`).sort();
  assert.deepEqual(checks, ["-:gpt-5-4-mini", "fast:gpt-5-mini"], JSON.stringify(trace));
});
