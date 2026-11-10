// The runner grades a run's learning on main's model order: the grade model the server names, else the model of the run
// that learned (its revision's `model`, as main's grade reads agent.model), else the host's default (the route picks
// it). Before, with no grade model named, the runner graded on the host's default whatever the agent ran on. Through
// resolveRunnerLoop (harness-loops.ts), its route asked for the model the grade runs on (gradeRouteOf, so an
// OpenRouter-only host still reaches it). An Anthropic model named by OpenRouter's dotted name is graded on Anthropic's
// own id, as its harness names it, so the catalog finds it; and a faux host grades on its faux route, never on a real
// provider whose key it inherited.
import assert from "node:assert/strict";
import { test } from "node:test";
import { storeOn } from "./store-helpers.mjs";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";

const { resolveRunnerLoop } = await import("../dist/runner/harness-loops.js");
const { gradeModelFor } = await import("../dist/runner/learning-dispatch.js");
const { routeOf: realRouteOf } = await import("../dist/runner/model-route.js");
const { runLearningEnd } = await import("../dist/store-reads/learning.js");

const NOTE = { file: "retries.md", text: "---\nname: Retries\ndescription: Retry a flaky fetch twice\ntype: reference\n---\nRetry a flaky fetch twice.\n" };
const KEEP = JSON.stringify({ merge: true, reason: "Worth keeping.", items: [{ file: "retries.md", decision: "keep", why: "useful" }] });
const sse = (events) => new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
/** The grader's provider: each request's model recorded, answered with KEEP. */
const graderOrigin = (sent) => async (_url, init = {}) => {
  const body = JSON.parse(String(init.body ?? "{}"));
  sent.push(body.model);
  return sse([
    { type: "message_start", message: { id: "msg_grade", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: KEEP } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  ]);
};

/** run-1 of an agent whose revision names `own`, ended keeping NOTE, its learning run learn-1 naming `graded` (none:
 *  no grade model named); learn-1 run through the runner's dispatch. Answers each model the route was asked for and
 *  each the grade was sent on. */
async function graded(t, { own, named, env = {}, routeOf }) {
  const { store, dir } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "agent-1" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", ...(own ? { model: own } : {}) } });
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const source = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const kept = { state: "proposed", notes: ["Retries"], skills: [], workflows: [], proposal: { notes: [NOTE] }, detail: "Proposed 1 note." };
  await store.runs.update(source, { state: "ended" }, { also: [{ table: "learning_proposals", row: { turn: {}, proposal: kept } }, { table: "learning_run", row: { id: "learn-1", ...(named ? { model: named } : {}) } }] });
  const asked = [];
  const sent = [];
  const deps = {
    env, data: dir, journal: (claim) => store.journal(claim), store, sealKey: Buffer.alloc(32),
    computerForClaim: async () => ({ release: async () => {} }),
    routeOf: routeOf ?? (async (model) => (asked.push(model), { provider: { api: "anthropic-messages", origin: "https://grader.invalid", credential: () => `not-a-secret-${"g"}` }, model: model ?? "the-hosts-default", price: () => 0, fetch: graderOrigin(sent) })),
  };
  const factory = await resolveRunnerLoop(deps)("learning", await store.runs.launch("learn-1"), "learn-1");
  const claim = await store.claim("learn-1", "runner-b", { leaseMs: 60_000 });
  const end = await factory({ journal: (c) => store.journal(c), flush: () => store.flush(), signal: new AbortController().signal }).start(claim);
  assert.deepEqual(end, { state: "ended" });
  return { asked, sent, store };
}

/** While `t` runs, any request off loopback is refused before it is sent, and listed. */
function offLoopback(t) {
  const real = globalThis.fetch;
  const refused = [];
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.hostname === "127.0.0.1") return real(input, init);
    refused.push(`${url.origin}${url.pathname}`);
    return Promise.reject(new Error(`this test sends nothing off loopback: ${url.origin}`));
  };
  t.after(() => (globalThis.fetch = real));
  return refused;
}

test("an agent whose revision names its model, with no grade model named: the grade goes to the agent's model", async (t) => {
  const { asked, sent } = await graded(t, { own: "anthropic/claude-sonnet-4-5" });
  assert.deepEqual(asked, ["anthropic/claude-sonnet-4-5"], "the route is asked for the agent's own model");
  assert.deepEqual(sent, ["anthropic/claude-sonnet-4-5"], "and the grade request names it");
});

test("a grade model the server names comes before the agent's own; with neither, the host's default", async (t) => {
  assert.deepEqual((await graded(t, { own: "anthropic/claude-sonnet-4-5", named: "openai/gpt-5" })).asked, ["openai/gpt-5"]);
  assert.deepEqual((await graded(t, {})).asked, [undefined], "neither: the route picks the host's default");
  assert.equal(gradeModelFor({ own: "x/y" }), "x/y");
  assert.equal(gradeModelFor({ model: "a/b", own: "x/y" }), "a/b");
  assert.equal(gradeModelFor({}), undefined);
});

test("a faux host that inherited OpenRouter's key grades a named anthropic/* model on its faux route, as named: nothing goes to OpenRouter", async (t) => {
  const refused = offLoopback(t);
  const { asked, sent, store } = await graded(t, { named: "anthropic/claude-sonnet-4-5", env: { AGENTRUN_SERVE_FAUX: "1", OPENROUTER_API_KEY: `not-a-secret-${"or"}` } });
  assert.deepEqual(asked, ["anthropic/claude-sonnet-4-5"], "the route is asked for the model as named, not rewritten to OpenRouter");
  assert.deepEqual(sent, ["anthropic/claude-sonnet-4-5"], "the grade went to the faux route's origin");
  assert.deepEqual(refused, [], "no request off loopback");
  assert.equal((await runLearningEnd(store, "run-1"))?.state, "merged");
});

test("with the real route and Anthropic's key, an agent whose revision names OpenRouter's dotted anthropic/claude-sonnet-4.5 is graded on claude-sonnet-4-5, and its learning merges", async (t) => {
  const gateway = await startFauxGateway({ text: KEEP, usage: { input: 1_000, output: 40 } });
  t.after(() => gateway.close());
  const env = { ANTHROPIC_API_KEY: `not-a-secret-${"a"}`, ANTHROPIC_BASE_URL: gateway.url };
  const { store } = await graded(t, { own: "anthropic/claude-sonnet-4.5", env, routeOf: realRouteOf });
  assert.deepEqual(gateway.requests.map((request) => [request.path, request.body?.model]), [["/v1/messages", "claude-sonnet-4-5"]]);
  const learning = await runLearningEnd(store, "run-1");
  assert.equal(learning?.state, "merged", JSON.stringify(learning));
  assert.ok(learning.cost_usd.grade > 0, "priced on the catalog's model");
});
