// A gateway model pi-ai's catalog does not list (a local model on Ollama, a gateway's own alias), run with no thinking
// level: its thinking is never off. pi never sends it `reasoning: {effort: "none"}`, which a local server reads as "don't
// split the reasoning out" while the model reasons anyway, so the reasoning lands in the answer. A level the run asks for
// is sent as asked, and a model the catalog lists keeps the catalog's levels.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeOpenSessions, hostTools } from "./conformance-pi-adapter.mjs";
import { capRun, quiet } from "./adapter-pi-cap-support.mjs";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";

const { piAdapter } = await import("../dist/runner/adapters/pi.js");
const { routeOf } = await import("../dist/runner/model-route.js");
const { PI_WIRES } = await import("../dist/runner/adapter-run-spec.js");
const { catalogPrices, catalogThinking } = await import("../dist/model.js");
after(closeOpenSessions);

const env = (url, model) => ({ AGENT_MODEL_BASE_URL: `${url}/v1`, AGENT_MODEL_GATEWAY_IDS: "bare", AGENT_MODEL: model, AGENT_MODEL_PRICE: "0,0,0" });

/** The Responses body of the first request a pi run on `model` through a loopback gateway sends, its session at `thinking`. */
async function firstBody(t, model, thinking) {
  const gateway = await startFauxGateway({ text: "Done." });
  t.after(() => gateway.close());
  const route = await routeOf(undefined, env(gateway.url, model), "default", PI_WIRES);
  assert.equal(route.provider.api, "openai-responses");
  const specOf = () => (_claim, run) => ({
    adapter: piAdapter({ run, model: route.model, provider: route.provider, ...(route.like ? { like: route.like } : {}), price: route.price }),
    session: { key: "root", label: "root", system: ["Answer."], tools: hostTools({}), context: "fresh", ...(thinking ? { thinking } : {}) },
    input: "Answer.",
    hooks: quiet,
    gate: () => "allow",
  });
  const { row } = await capRun(t, { specOf, runCap: { capUsd: () => undefined, modelOf: () => undefined } });
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.equal(gateway.requests[0]?.path, "/v1/responses");
  return gateway.requests[0].body;
}

test("an unknown gateway model with no thinking level is never asked for no reasoning: pi sends its lowest level, with the reasoning split out", async (t) => {
  const body = await firstBody(t, "qwen3:4b", undefined);
  assert.notDeepEqual(body.reasoning, { effort: "none" }, `reasoning: ${JSON.stringify(body.reasoning)}`);
  assert.deepEqual([body.reasoning, body.include], [{ effort: "minimal", summary: "auto" }, ["reasoning.encrypted_content"]]);
});

test("an unknown gateway model at a level the run asks for is sent that level", async (t) => {
  const body = await firstBody(t, "qwen3:4b", "low");
  assert.deepEqual(body.reasoning, { effort: "low", summary: "auto" });
});

test("catalogThinking: a model the catalog does not list has thinking off mapped to no effort; one it lists keeps the catalog's map", async () => {
  const catalog = await catalogPrices();
  assert.deepEqual(catalogThinking(catalog, "qwen3:4b", undefined), { off: null });
  assert.deepEqual(catalogThinking(catalog, "team-model", "openai"), { off: null });
  const sol = catalogThinking(catalog, "gpt-6.1-sol", "openai");
  assert.notDeepEqual(sol, { off: null }, "a listed model is read from the catalog");
  assert.equal(catalogThinking(catalog, "openai/gpt-6.1-sol", undefined)?.off, sol?.off);
});
