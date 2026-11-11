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
  // The run's model as its route names it, and the fast tier's (a host with AGENT_MODEL_FAST set).
  const modelName = (tier) => (tier === "fast" ? "gpt-5-mini" : "gpt-5-4-mini");
  const tool = learnedWorkflowTool({ workflows: [{ name: "two-tiers", description: "Two tiers", workflow: JSON.stringify(FLOW) }], granted: [], env: {}, work, models, modelOf: () => ({ provider: MODEL.provider, modelId: MODEL.id }), modelName, policy: () => "allow", denyFrom: () => "default" });
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
