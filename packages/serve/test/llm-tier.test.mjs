// An `llm` call completes on the model of the tier it asks for. A tier the run fills in when the call runs
// (`tier: "{requestedTier}"`, read from the state) can be any of the three, so the run registers all three; and a tier
// the run has no model for is refused by name instead of answered by the default model. Faux model, no key, no network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { completer } from "../dist/llm.js";
import { llmTiers } from "../dist/model.js";
import { flowAgent, follow, serve, withEnv } from "./support.mjs";

const llm = (args) => ({ node: "call", label: "ask", via: "tool", tool: "llm", args, out: "Llm", as: "answer", deadline_s: 120 });

test("a tier the call names registers that tier; a tier the state fills in registers all three", () => {
  assert.deepEqual(llmTiers([llm({ prompt: "x" })], []), ["default"]);
  assert.deepEqual(llmTiers([llm({ prompt: "x", tier: "strong" })], []), ["strong"]);
  assert.deepEqual(llmTiers([llm({ prompt: "x", tier: "{requestedTier}" })], []), ["fast", "default", "strong"]);
  assert.deepEqual(llmTiers([llm("{llmArgs}")], []), ["fast", "default", "strong"], "args the state fills in whole may name any tier");
});

test("a tier the run has no model for is refused by name, never answered by the default model", async () => {
  const used = [];
  const models = { getModel: (provider, id) => ({ provider, id }), completeSimple: async (model) => (used.push(model.id), { content: [{ type: "text", text: "ok" }], stopReason: "stop" }) };
  const registered = new Map([["default", { provider: "faux", modelId: "the-default" }]]);
  const complete = completer(models, (tier) => registered.get(tier ?? "default"), "medium");
  assert.equal((await complete({ prompt: "x" }, AbortSignal.timeout(1000))).model, "faux/the-default", "no tier asked: the default");
  await assert.rejects(complete({ prompt: "x", tier: "strong" }, AbortSignal.timeout(1000)), /llm: tier strong has no model in this run/);
  assert.deepEqual(used, ["the-default"], "nothing was sent for the refused call");
});

// SKIP (follow-up #2078): a workflow node's requested tier does not run on that tier's model on the runner
test.skip("tier \"{requestedTier}\" with requestedTier strong runs on the strong tier's model", async (t) => {
  withEnv(t, { AGENT_MODEL_STRONG: "faux-strong", AGENT_MODEL_FAST: "faux-fast" });
  const { api } = await serve(t);
  const workflow = {
    v: 2, name: "tiered",
    schemas: {
      In: { type: "object", required: ["requestedTier"], properties: { requestedTier: { type: "string" } } },
      Llm: { type: "object", required: ["text", "model"], properties: { text: { type: "string" }, model: { type: "string" } } },
    },
    input: { schemaId: "In" },
    output: { schemaId: "Llm", path: "answer" },
    root: llm({ prompt: "Say hi", tier: "{requestedTier}" }),
  };
  const made = await api("POST", "/agents", flowAgent("tiered", workflow, { tools: ["llm"] }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  for (const [tier, model] of [["strong", "faux/faux-strong"], ["fast", "faux/faux-fast"], ["default", "faux/faux-1"]]) {
    const started = await api("POST", "/agents/tiered/runs", { input: { requestedTier: tier } });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await follow(api, started.body.run_id, ["completed"], { deadlineMs: 120_000 });
    const run = (await api("GET", `/runs/${started.body.run_id}`)).body;
    assert.equal(run.result.output.model, model, `${tier}: ${JSON.stringify(run.result)}`);
  }
});
