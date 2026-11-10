// The runner's grade on a host whose only model key is OpenRouter's, with a grade model the server names on Anthropic
// (anthropic/claude-sonnet-4-5, or OpenRouter's dotted spelling of it): the learning dispatch (harness-loops.ts, through
// learning-dispatch.ts gradeRouteOf) sends it as main's grade sends a claude-agent run's (provider.ts providerFor):
// to OpenRouter's Messages endpoint, on Anthropic's own id, with OpenRouter's key as a bearer token, its one credential,
// and prices it at OpenRouter's catalog price for the model in the learning run's cost. Before, the runner's route
// refused the model ("No Anthropic key here") and every learning run on such a host ended grade_failed, no request sent.
//
// Through resolveRunnerLoop with the runner's real route (model-route.ts routeOf). OpenRouter's origin is fixed by
// design, so a request to https://openrouter.ai is redirected to the loopback gateway at the same path; any other
// request off loopback is refused, so nothing here reaches the network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentWithRevision, storeOn } from "./store-helpers.mjs";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";

const { resolveRunnerLoop } = await import("../dist/runner/harness-loops.js");
const { routeOf } = await import("../dist/runner/model-route.js");
const { runLearningEnd } = await import("../dist/store-reads/learning.js");

/** OpenRouter's key, plainly a test value. */
const KEY = `not-a-secret-${"openrouter"}`;
const OR_ALONE = { OPENROUTER_API_KEY: KEY };
const NOTE = { file: "retries.md", text: "---\nname: Retries\ndescription: Retry a flaky fetch twice\ntype: reference\n---\nRetry a flaky fetch twice.\n" };
const KEEP = JSON.stringify({ merge: true, reason: "Worth keeping.", items: [{ file: "retries.md", decision: "keep", why: "useful" }] });
const USAGE = { input: 1_000, output: 40 };

/** While `t` runs, a request to openrouter.ai goes to `gateway` at the same path and query; loopback as it is; any other
 *  is refused before it is sent, and listed. */
function toGateway(t, gateway) {
  const real = globalThis.fetch;
  const refused = [];
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.hostname === "127.0.0.1") return real(input, init);
    if (url.origin === "https://openrouter.ai") {
      const there = `${gateway}${url.pathname}${url.search}`;
      return input instanceof Request ? real(new Request(there, input), init) : real(there, init);
    }
    refused.push(`${url.origin}${url.pathname}`);
    return Promise.reject(new Error(`this test sends nothing off loopback: ${url.origin}`));
  };
  t.after(() => (globalThis.fetch = real));
  return refused;
}

/** run-1 ended keeping NOTE, its learning run learn-1 queued on the grade model `model`, as the run's end commit writes. */
async function ended(t, model) {
  const { store, dir } = await storeOn(t);
  await agentWithRevision(store);
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const source = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const kept = { state: "proposed", notes: ["Retries"], skills: [], workflows: [], proposal: { notes: [NOTE] }, detail: "Proposed 1 note." };
  await store.runs.update(source, { state: "ended" }, { also: [{ table: "learning_proposals", row: { turn: {}, proposal: kept } }, { table: "learning_run", row: { id: "learn-1", model } }] });
  return { store, dir };
}

for (const named of ["anthropic/claude-sonnet-4-5", "anthropic/claude-sonnet-4.5"]) {
  test(`a grade model ${named} on OpenRouter's key alone: the grade goes to OpenRouter's Messages endpoint on Anthropic's id, with one credential, priced at OpenRouter's price`, async (t) => {
    const gateway = await startFauxGateway({ text: KEEP, usage: USAGE });
    t.after(() => gateway.close());
    const refused = toGateway(t, gateway.url);
    const { store, dir } = await ended(t, named);
    const deps = {
      env: OR_ALONE, data: dir, journal: (claim) => store.journal(claim), store, sealKey: Buffer.alloc(32),
      computerForClaim: async () => ({ release: async () => {} }),
      routeOf,
    };
    const factory = await resolveRunnerLoop(deps)("learning", await store.runs.launch("learn-1"), "learn-1");
    const claim = await store.claim("learn-1", "runner-b", { leaseMs: 60_000 });
    const end = await factory({ journal: (c) => store.journal(c), flush: () => store.flush(), signal: new AbortController().signal }).start(claim);
    assert.deepEqual(end, { state: "ended" });
    assert.deepEqual(refused, [], "nothing off loopback but OpenRouter's origin, redirected");
    // (a) the id OpenRouter's Messages endpoint takes, Anthropic's own; (b) OpenRouter's key once, as a bearer token.
    assert.deepEqual(gateway.requests.map((request) => [request.path.endsWith("/v1/messages"), request.body?.model, request.headers.authorization, request.headers["x-api-key"]]), [[true, "claude-sonnet-4-5", `Bearer ${KEY}`, undefined]]);
    const learning = await runLearningEnd(store, "run-1");
    assert.equal(learning?.state, "merged", JSON.stringify(learning));
    // (c) OpenRouter's catalog price of the model, for the usage the grade reported.
    const priced = await routeOf("openrouter/anthropic/claude-sonnet-4.5", OR_ALONE, "default");
    const price = priced.price(priced.model, { input: USAGE.input, output: USAGE.output, cacheRead: 0, cacheWrite: 0 });
    assert.ok(price > 0);
    assert.ok(Math.abs(learning.cost_usd.grade - price) < 1e-12, `the grade's dollars ${learning.cost_usd.grade}, its price ${price}`);
  });
}

test("on a host with Anthropic's own key, a named Anthropic grade model keeps the runner's route as named: Anthropic's origin and key", async () => {
  const { gradeRouteOf } = await import("../dist/runner/learning-dispatch.js");
  const asked = [];
  const route = await gradeRouteOf("anthropic/claude-sonnet-4-5", { ...OR_ALONE, ANTHROPIC_API_KEY: "not-a-secret" }, (model) => (asked.push(model), { model: "as-named", provider: { api: "anthropic-messages", origin: "https://api.anthropic.com", credential: () => "a" } }));
  assert.deepEqual([asked, route.model], [["anthropic/claude-sonnet-4-5"], "as-named"]);
  const openai = [];
  await gradeRouteOf("openai/gpt-5", OR_ALONE, (model) => (openai.push(model), { model, provider: { api: "anthropic-messages", origin: "x", credential: () => "k" } }));
  assert.deepEqual(openai, ["openrouter/openai/gpt-5"], "an OpenAI model on OpenRouter's key alone: the same model on OpenRouter");
});
