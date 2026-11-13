// The runner's grade on a host whose only model key is OpenRouter's, with a grade model the server names on Anthropic
// (anthropic/claude-sonnet-5-5, or OpenRouter's dotted spelling of it): the learning dispatch (harness-loops.ts, through
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
const KEEP = JSON.stringify({ merge: true, reason: "Worth keeping.", items: [{ file: "retries.md", decision: "keep", general: true, why: "useful" }] });
const USAGE = { input: 1_000, output: 40 };

/** What OpenRouter's System One endpoint reports a Jev answer cost, in USD. */
const JEV_COST = 0.00003;

/** While `t` runs, a request to openrouter.ai goes to `gateway` at the same path and query; loopback as it is; any other
 *  is refused before it is sent, and listed. With `jev`, a System One request is answered here instead (each question a
 *  Noul of 0.92, JEV_COST reported) and its path and authorization listed in `jev`. */
function toGateway(t, gateway, jev) {
  const real = globalThis.fetch;
  const refused = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.hostname === "127.0.0.1") return real(input, init);
    if (jev && url.origin === "https://openrouter.ai" && url.pathname === "/api/v1/systemone") {
      const body = JSON.parse(input instanceof Request ? await input.text() : String(init?.body ?? "{}"));
      jev.push([url.pathname, new Headers(input instanceof Request ? input.headers : init?.headers).get("authorization")]);
      const answers = Object.fromEntries(Object.keys(body.questions ?? {}).map((id) => [id, { type: "noul", noul: 0.92 }]));
      return new Response(JSON.stringify({ id: "or-jev-1", model: "jev-1.14.0", answers, usage: { input_tokens: 120, output_tokens: 0, cost: JEV_COST } }), { status: 200, headers: { "content-type": "application/json" } });
    }
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
async function ended(t, model, capUsd) {
  const { store, dir } = await storeOn(t);
  await agentWithRevision(store);
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const source = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const kept = { state: "proposed", notes: ["Retries"], skills: [], workflows: [], proposal: { notes: [NOTE] }, detail: "Proposed 1 note." };
  await store.runs.update(source, { state: "ended" }, { also: [{ table: "learning_proposals", row: { turn: {}, proposal: kept } }, { table: "learning_run", row: { id: "learn-1", model, ...(capUsd !== undefined ? { capUsd } : {}) } }] });
  return { store, dir };
}

for (const named of ["anthropic/claude-sonnet-5-5", "anthropic/claude-sonnet-5.5"]) {
  test(`a grade model ${named} on OpenRouter's key alone: the grade goes to OpenRouter's Messages endpoint on Anthropic's id, with one credential, priced at OpenRouter's price`, async (t) => {
    const gateway = await startFauxGateway({ text: KEEP, usage: USAGE });
    t.after(() => gateway.close());
    const jev = [];
    const refused = toGateway(t, gateway.url, jev);
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
    // Jev runs on the same key (decisions.ts jevKey): the generality pre-check (learn/general.ts) asks it first, on
    // OpenRouter's System One endpoint, with that one credential too; it rates the note general, so the grader reads it.
    const messages = gateway.requests.filter((request) => request.path.endsWith("/v1/messages"));
    assert.deepEqual(messages.map((request) => [request.body?.model, request.headers.authorization, request.headers["x-api-key"]]), [["claude-sonnet-5-5", `Bearer ${KEY}`, undefined]]);
    assert.deepEqual(gateway.requests.filter((request) => !messages.includes(request)).map((request) => request.path), [], "nothing else reached the gateway");
    assert.deepEqual(jev, [["/api/v1/systemone", `Bearer ${KEY}`]], "the pre-check's one Jev request, on the same key");
    const learning = await runLearningEnd(store, "run-1");
    assert.equal(learning?.state, "merged", JSON.stringify(learning));
    // (c) OpenRouter's catalog price of the model, for the usage the grade reported, and the pre-check's reported cost.
    const priced = await routeOf("openrouter/anthropic/claude-sonnet-5.5", OR_ALONE, "default");
    const price = priced.price(priced.model, { input: USAGE.input, output: USAGE.output, cacheRead: 0, cacheWrite: 0 });
    assert.ok(price > 0);
    assert.ok(Math.abs(learning.cost_usd.grade - (price + JEV_COST)) < 1e-12, `the grade's dollars ${learning.cost_usd.grade}, its price ${price} + Jev's ${JEV_COST}`);
  });
}

// #2650 review: a pre-check request that was sent and failed (here the gateway's 404 to System One) spent what nobody
// knows, so the grade's cost is unknown, never the grader's price alone; the run's learning says the check could not run.
test("the pre-check's Jev request sent and failed: the grader still reads the note, and the grade's cost is unknown, never the grader's price alone", async (t) => {
  const { GENERAL_UNCHECKED } = await import("../dist/learn/general.js");
  const gateway = await startFauxGateway({ text: KEEP, usage: USAGE });
  t.after(() => gateway.close());
  const refused = toGateway(t, gateway.url);
  const { store, dir } = await ended(t, "anthropic/claude-sonnet-5-5");
  const deps = { env: OR_ALONE, data: dir, journal: (claim) => store.journal(claim), store, sealKey: Buffer.alloc(32), computerForClaim: async () => ({ release: async () => {} }), routeOf };
  const factory = await resolveRunnerLoop(deps)("learning", await store.runs.launch("learn-1"), "learn-1");
  const claim = await store.claim("learn-1", "runner-b", { leaseMs: 60_000 });
  assert.deepEqual(await factory({ journal: (c) => store.journal(c), flush: () => store.flush(), signal: new AbortController().signal }).start(claim), { state: "ended" });
  assert.deepEqual(refused, []);
  assert.deepEqual(gateway.requests.map((request) => request.path), ["/api/v1/systemone", "/api/v1/messages"], "the Jev request was sent, then the grade");
  const learning = await runLearningEnd(store, "run-1");
  assert.equal(learning?.state, "merged", JSON.stringify(learning));
  assert.equal(learning.cost_usd.grade, null);
  assert.ok(learning.detail.endsWith(GENERAL_UNCHECKED), learning.detail);
});

test("on a host with Anthropic's own key, a named Anthropic grade model keeps the runner's route as named: Anthropic's origin and key", async () => {
  const { gradeRouteOf } = await import("../dist/runner/learning-dispatch.js");
  const asked = [];
  const route = await gradeRouteOf("anthropic/claude-sonnet-5-5", { ...OR_ALONE, ANTHROPIC_API_KEY: "fake-test-key" }, (model) => (asked.push(model), { model: "as-named", provider: { api: "anthropic-messages", origin: "https://api.anthropic.com", credential: () => "a" } }));
  assert.deepEqual([asked, route.model], [["anthropic/claude-sonnet-5-5"], "as-named"]);
  const openai = [];
  await gradeRouteOf("openai/gpt-6.1-sol", OR_ALONE, (model) => (openai.push(model), { model, provider: { api: "anthropic-messages", origin: "x", credential: () => "k" } }));
  assert.deepEqual(openai, ["openrouter/openai/gpt-6.1-sol"], "an OpenAI model on OpenRouter's key alone: the same model on OpenRouter");
});

test("under a cap, a grade on OpenRouter's key alone is judged at OpenRouter's price before it leaves: it fits, and is graded", async (t) => {
  const gateway = await startFauxGateway({ text: KEEP, usage: USAGE });
  t.after(() => gateway.close());
  toGateway(t, gateway.url);
  const { store, dir } = await ended(t, "anthropic/claude-sonnet-5-5", 5);
  const deps = { env: OR_ALONE, data: dir, journal: (claim) => store.journal(claim), store, sealKey: Buffer.alloc(32), computerForClaim: async () => ({ release: async () => {} }), routeOf };
  const factory = await resolveRunnerLoop(deps)("learning", await store.runs.launch("learn-1"), "learn-1");
  const claim = await store.claim("learn-1", "runner-b", { leaseMs: 60_000 });
  assert.deepEqual(await factory({ journal: (c) => store.journal(c), flush: () => store.flush(), signal: new AbortController().signal }).start(claim), { state: "ended" });
  assert.deepEqual(gateway.requests.map((request) => request.path), ["/api/v1/systemone", "/api/v1/messages"], "the pre-check's Jev request fit the cap and was sent, then the grade: its route carries a price the cap reads");
  assert.equal((await runLearningEnd(store, "run-1"))?.state, "merged");
});
