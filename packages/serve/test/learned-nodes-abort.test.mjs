// Review on #2337: a learned workflow stopped part way keeps the trace of the nodes that ended. The learned_workflow
// tool keeps each node that ran beside its call (LEARNED_NODES) for the call's timeline row; a call whose signal is
// aborted after a node ended still keeps that node, and the call still ends as a stop (it throws, as before).
// The workflow's model nodes run on a stand-in model registry: no network, no key.
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

/** Two model nodes in a chain: `first` answers at once; `second` stops the call (its signal aborted) as it starts. */
const FLOW = {
  v: 2, name: "two-steps",
  schemas: {
    In: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
    Answer: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } },
  },
  input: { schemaId: "In" },
  output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [
    { node: "extract", label: "first", instructions: "Answer the question.", out: "Answer", as: "first" },
    { node: "extract", label: "second", instructions: "Answer it again.", out: "Answer", as: "answer" },
  ] },
};

test("a learned workflow stopped after a node ended keeps that node beside its call, and the call still ends as a stop", { timeout: 60_000 }, async (t) => {
  const work = mkdtempSync(join(tmpdir(), "learned-abort-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const stop = new AbortController();
  let requests = 0;
  let second = false;
  const models = {
    getModel: () => MODEL,
    getModels: () => [MODEL],
    completeSimple: async (_model, context) => {
      requests += 1;
      const prompt = JSON.stringify(context?.messages ?? []);
      if (prompt.includes("Answer it again")) {
        // The second node's first request: the owner stops the call here.
        second = true;
        stop.abort(new Error("stopped by the owner"));
        return message([], "aborted");
      }
      const answered = (context?.messages ?? []).some((m) => m.role === "toolResult");
      return answered ? message([{ type: "text", text: "Done." }], "stop") : message([{ type: "toolCall", id: `submit-${requests}`, name: "submit", arguments: { value: { answer: 42 } } }], "toolUse");
    },
  };
  const tool = learnedWorkflowTool({ workflows: [{ name: "two-steps", description: "Two steps", workflow: JSON.stringify(FLOW) }], granted: [], env: {}, work, models, modelOf: () => ({ provider: MODEL.provider, modelId: MODEL.id }), policy: () => "allow", denyFrom: () => "default" });
  const kept = [];
  const api = { callId: "call-1", commit: async (change) => change({ appendEntry: async (_conversation, entry) => void kept.push(entry) }) };
  const outcome = await tool.execute({ name: "two-steps", input: { question: "six times seven" } }, api, { abortSignal: stop.signal }).then((said) => ({ said }), (error) => ({ error }));
  assert.ok(second, `the second node started (${requests} requests)`);
  assert.ok(stop.signal.aborted);
  // The call ends as a stop: it throws, as an aborted call did before.
  assert.ok("error" in outcome, `the stopped call throws: ${JSON.stringify(outcome)}`);
  const traces = kept.filter((entry) => entry.kind === LEARNED_NODES);
  assert.equal(traces.length, 1, `one trace kept: ${JSON.stringify(kept)}`);
  assert.equal(traces[0].data.call, "call-1");
  assert.equal(traces[0].data.workflow, "two-steps");
  assert.deepEqual(traces[0].data.nodes.map(({ label, status }) => ({ label, status })).filter(({ label }) => label === "first"), [{ label: "first", status: "ok" }], JSON.stringify(traces[0].data.nodes));
});
