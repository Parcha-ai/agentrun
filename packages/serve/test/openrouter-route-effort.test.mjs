// The run's thinking level reaches the model on pi's route to an OpenRouter Chat Completions model (the route's own
// translation, model-route.ts messagesFetch: pi-ai speaks neither of pi's wires to it), as OpenRouter's
// `reasoning: { effort }`. pi's session asks it in the Messages request it sends the route, and the translation hands it
// to pi-ai, which maps and clamps it by the model's own catalog entry. Until now the translation sent no level at all, so
// an effort set on pi on OpenRouter's key did nothing (openrouter/openai/gpt-6.1-sol, its default, included). With no
// effort set nothing changes: no level is sent, and pi-ai turns reasoning off as the catalog says (gpt-6.1-sol: no
// `reasoning` field, its default; Ling 3.2 Flash: effort "none"). On the real runner loop and the session's proxy, the
// provider stood in for by a loopback gateway (fixtures/faux-gateway.mjs): no real key, no network.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeOpenSessions, hostTools } from "./conformance-pi-adapter.mjs";
import { capRun, quiet } from "./adapter-pi-cap-support.mjs";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";

const { piAdapter } = await import("../dist/runner/adapters/pi.js");
const { heldRedactor } = await import("../dist/runner/redact.js");
const { routeOf } = await import("../dist/runner/model-route.js");
const { PI_WIRES } = await import("../dist/runner/adapter-run-spec.js");
after(closeOpenSessions);

const KEY = `not-a-secret-${"openrouter"}`;
const SOL = "openrouter/openai/gpt-6.1-sol";
const LING = "openrouter/inclusionai/ling-3.2-flash:free";

/** A fetch that sends each request to the gateway at `url`, on its own path: OpenRouter's origin stood in for. */
const toGateway = (url) => (target, init) => fetch(`${url}${new URL(String(target)).pathname}`, init);

/** One pi run on OpenRouter's `model` with the session at `thinking` (or none): every request OpenRouter took. */
async function runAt(t, model, thinking) {
  const gateway = await startFauxGateway({ usage: { input: 10, output: 2 } });
  t.after(() => gateway.close());
  const route = await routeOf(model, { OPENROUTER_API_KEY: KEY }, "default", PI_WIRES, toGateway(gateway.url));
  assert.equal(typeof route.fetch, "function", "pi reaches OpenRouter's Chat Completions through the route's translation");
  const specOf = () => (_claim, run) => ({
    adapter: piAdapter({ redact: heldRedactor((text) => text), run, model: route.model, provider: route.provider, ...(route.like ? { like: route.like } : {}), price: route.price, fetch: route.fetch }),
    session: { key: "root", label: "root", system: ["Answer."], tools: hostTools({}), context: "fresh", ...(thinking ? { thinking } : {}) },
    input: "Say hi.",
    hooks: quiet,
    gate: () => "allow",
  });
  const { row } = await capRun(t, { specOf, runCap: { capUsd: () => undefined, modelOf: () => undefined } });
  assert.equal(row.state, "ended", JSON.stringify(row));
  const posts = gateway.requests.filter((request) => request.path.endsWith("/chat/completions"));
  assert.ok(posts.length >= 1, "pi asked the model");
  return posts.map((request) => request.body?.reasoning ?? null);
}

for (const level of ["low", "medium", "high"]) {
  test(`pi on OpenRouter's gpt-6.1-sol at effort ${level}: every request carries reasoning effort ${level}`, { timeout: 60_000 }, async (t) => {
    const sent = await runAt(t, SOL, level);
    assert.deepEqual(sent, sent.map(() => ({ effort: level })), JSON.stringify(sent));
  });
}

test("pi on OpenRouter's gpt-6.1-sol with no effort set: no reasoning is sent, the model's default, as before", { timeout: 60_000 }, async (t) => {
  const sent = await runAt(t, SOL, undefined);
  assert.deepEqual(sent, sent.map(() => null), JSON.stringify(sent));
});

test("pi on Ling 3.2 Flash (free) with no effort set: reasoning stays off (effort none), as before", { timeout: 60_000 }, async (t) => {
  const sent = await runAt(t, LING, undefined);
  assert.deepEqual(sent, sent.map(() => ({ effort: "none" })), JSON.stringify(sent));
});

test("pi on Ling 3.2 Flash (free) at effort high: its request reasons at high", { timeout: 60_000 }, async (t) => {
  const sent = await runAt(t, LING, "high");
  assert.deepEqual(sent, sent.map(() => ({ effort: "high" })), JSON.stringify(sent));
});
