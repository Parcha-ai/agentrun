// A workflow run's graph names the model each model node ran on, and its tier when the node names one
// (GET /runs/{id}/graph nodes[path].model and .tier): the run records each tier's model where it resolves it
// (workflow-spec.ts modelOf), and the graph puts it on the nodes that ran. A call node never has one. Faux model.
import assert from "node:assert/strict";
import { test } from "node:test";
import { flowAgent, follow, serve } from "./support.mjs";

const FLOW = {
  v: 2, name: "tiers",
  schemas: {
    In: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
    Answer: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } },
    Llm: { type: "object" },
  },
  input: { schemaId: "In" },
  output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [
    { node: "extract", label: "quick look", tier: "fast", instructions: "Answer the question.", out: "Answer", as: "first" },
    { node: "extract", label: "final answer", instructions: "Answer it again.", out: "Answer", as: "answer" },
    { node: "call", label: "ask the llm", via: "tool", tool: "llm", args: { prompt: "Say ok." }, out: "Llm", as: "said", deadline_s: 60 },
  ] },
};

test("a workflow run's graph names the model each model node ran on and its tier; a node of no tier its model alone; a call node neither", { timeout: 60_000 }, async (t) => {
  const { api } = await serve(t);
  assert.equal((await api("POST", "/agents", flowAgent("tiers", FLOW, { tools: ["llm"] }))).status, 201);
  const started = await api("POST", "/agents/tiers/runs", { input: { question: "What is six times seven?" } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed", "failed"], { deadlineMs: 50_000 });
  const graph = (await api("GET", `/runs/${started.body.run_id}/graph`)).body;
  const [fast, plain, call] = ["/root/steps/0", "/root/steps/1", "/root/steps/2"].map((path) => graph.nodes[path]);
  assert.equal(fast?.status, "done", JSON.stringify(graph.nodes));
  assert.equal(typeof fast.model, "string", JSON.stringify(fast));
  assert.ok(fast.model.length > 0);
  assert.equal(fast.tier, "fast");
  assert.equal(typeof plain?.model, "string", JSON.stringify(plain));
  assert.equal("tier" in plain, false, "a node of no tier has no tier");
  assert.equal(call?.model, undefined, JSON.stringify(call));
  assert.equal(graph.nodes["/root"]?.model, undefined, "a chain has no model");
});
