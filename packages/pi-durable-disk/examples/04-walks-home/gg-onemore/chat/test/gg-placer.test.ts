// The GG placer: Jev is asked a typed choice over the browser and the Modal VM with the GG criteria; the agent's model goes into
// the question as `agent_model` when the server gives it; without Jev's key the placer refuses to start.
import { test } from "node:test";
import assert from "node:assert/strict";
import placer, { buildGgPlacer, CRITERIA_GG, ggContext } from "../gg-placer.ts";

test("a typed choice over the browser and the VM, with the GG criteria; the answer is Jev's, with its probabilities", async () => {
  const asked: any[] = [];
  const p = buildGgPlacer(async (params) => {
    asked.push(params);
    return { answers: { where: { type: "choice", choice: "modal-vm", probabilities: { tab: 0.03, "modal-vm": 0.97 } } }, model: "jev" };
  });
  const d = await p.decide({ phase: "start", message: "Recreate Golden Gate Claude on the Qwen on your GPU box.", current: "tab", environments: ["tab", "modal-vm", "modal-gpu"] });
  assert.equal(d.choice, "modal-vm");
  assert.equal(d.model, "jev");
  assert.deepEqual(d.options.map((o) => [o.id, o.probability]), [["tab", 0.03], ["modal-vm", 0.97]]);
  assert.deepEqual(Object.keys(asked[0].questions.where.criteria), ["tab", "modal-vm"], "only the places with a GG criterion are offered");
  assert.equal(asked[0].questions.where.criteria["modal-vm"], CRITERIA_GG["modal-vm"]);
  assert.match(CRITERIA_GG["modal-vm"]!, /agent_model is steered\/qwen3\.5-27b/);
});

test("the agent's model is a fact of the question when the server gives it", async () => {
  assert.deepEqual(await ggContext(undefined, { model: { provider: "steered", modelId: "qwen3.5-27b" } }), { agent_model: "steered/qwen3.5-27b" });
  assert.deepEqual(await ggContext(undefined), {});
});

test("no Jev key, no placer; and no other client", async () => {
  const saved = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    await assert.rejects(placer({ log: () => undefined, args: {} }), /no fallback judge/);
    await assert.rejects(placer({ log: () => undefined, args: { client: "scripted" } }), /only jev/);
  } finally {
    if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
  }
});
