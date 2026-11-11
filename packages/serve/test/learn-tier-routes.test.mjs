// Which tiers of a run's learned workflows get a model of their own on the runner (adapter-run-spec.ts learnedTiers,
// learnedTierRoutes): those a model node or an `llm` call names, other than the default, that the host names a model of
// (AGENT_MODEL_FAST, AGENT_MODEL_STRONG). One whose route is refused is said, never routed to another model. And the
// port models of several ports as one registry (port-models.ts tieredModels): each model's request goes to its own port.
import assert from "node:assert/strict";
import { test } from "node:test";
import { answerFlow } from "./support.mjs";

const { learnedTiers, learnedTierRoutes } = await import("../dist/runner/adapter-run-spec.js");
const { tieredModels, tierProvider, PORT_PROVIDER } = await import("../dist/port-models.js");

/** A learned workflow whose node names `tier` (none: the default). */
const flowOf = (name, tier) => {
  const flow = answerFlow();
  if (tier) flow.root.steps[0].tier = tier;
  return { name, description: "Answers", workflow: JSON.stringify(flow) };
};

test("the tiers a run's learned workflows name, other than the default, in fast-then-strong order; a workflow that does not parse names none", () => {
  assert.deepEqual(learnedTiers([flowOf("a"), flowOf("b", "strong"), flowOf("c", "fast"), flowOf("d", "strong")]), ["fast", "strong"]);
  assert.deepEqual(learnedTiers([flowOf("a")]), []);
  assert.deepEqual(learnedTiers([{ name: "broken", description: "x", workflow: "{not json" }, flowOf("b", "fast")]), ["fast"]);
});

test("a tier the host names a model of is routed; one it names none of is left out (the run's own model runs it); a refused route is said, never another model", async () => {
  const asked = [];
  const routeOf = async (tier) => {
    asked.push(tier);
    if (tier === "strong") throw new Error("no key for the strong model's provider");
    return { model: `model-${tier}`, provider: { api: "openai-responses", origin: "http://gateway.invalid", credential: () => "x" } };
  };
  const flows = [flowOf("a", "fast"), flowOf("b", "strong")];
  const routes = await learnedTierRoutes(flows, { AGENT_MODEL_FAST: "gpt-fast", AGENT_MODEL_STRONG: "gpt-strong" }, routeOf);
  assert.deepEqual([...routes.keys()], ["fast", "strong"]);
  assert.equal(routes.get("fast").model, "model-fast");
  assert.deepEqual(routes.get("strong"), { why: "no key for the strong model's provider" });
  asked.length = 0;
  const none = await learnedTierRoutes(flows, { AGENT_MODEL_FAST: "", AGENT_MODEL: "gpt-run" }, routeOf);
  assert.deepEqual([[...none.keys()], asked], [[], []], "no model of its own for either tier: neither is routed");
});

test("port models of several ports as one registry: each model by its provider id, its request to its own port; a model of no port is refused", async () => {
  const port = (provider, id) => {
    const model = { provider, id };
    const sent = [];
    return { sent, models: { getModel: () => model, getModels: () => [model], streamSimple: (m) => (sent.push(m.id), "stream"), completeSimple: async (m) => (sent.push(m.id), { stopReason: "stop" }) } };
  };
  const own = port(PORT_PROVIDER, "gpt-run");
  const fast = port(tierProvider("fast"), "gpt-fast");
  const joined = tieredModels(new Map([[PORT_PROVIDER, own.models], [tierProvider("fast"), fast.models]]));
  assert.deepEqual(joined.getModels().map((m) => m.id), ["gpt-run", "gpt-fast"]);
  const model = joined.getModel(tierProvider("fast"), "gpt-fast");
  await joined.completeSimple(model, { messages: [] });
  joined.streamSimple(joined.getModel(PORT_PROVIDER, "session"), { messages: [] });
  assert.deepEqual([own.sent, fast.sent], [["gpt-run"], ["gpt-fast"]]);
  assert.equal(joined.getModel(tierProvider("strong"), "x"), undefined);
  assert.throws(() => joined.streamSimple({ provider: "elsewhere", id: "x" }, { messages: [] }), /no port of the run lists the model elsewhere\/x/);
});
