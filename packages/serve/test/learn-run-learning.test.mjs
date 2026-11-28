// A run that asks to learn (POST /agents/{agent_id}/runs `learning: {settings?}`): it learns for its agent with the loop
// numbers it gives, whatever its revision's definition says, and only when it brings its own model key (`model_key`) and
// its own cap (`max_cost_usd`), so all of its learning work spends that key inside that cap. Proven here, through the API:
//   - the object without model_key, without max_cost_usd, or without either is 400 learning_needs_cap, in words, and no
//     run is made;
//   - an object with a key other than `settings`, or settings a definition's `learning` would refuse, is 422 at its field;
//   - POST /runs (an agent given inline) still takes only "use";
//   - capabilities say a server takes it (`features.run_learning`);
//   - a keyed, capped run that asks, of an agent whose definition has no learning, learns: its launch keeps the settings,
//     and its compile turn is asked at its first run (`compile_after: 1`), on the run's own key;
//   - its settings beat its revision's: an agent at `compile_after: 20` asks no compile turn at a plain first run, and
//     asks one at a first run that asks with `compile_after: 1`; a follow-up keeps its run's launch.
// The money side through the runner (replays split by keyedCapOf, the shadow on what the cap leaves) is
// runner-run-learning.test.mjs's.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { learner, made } from "./learn-support.mjs";
import { agent, follow, serve, withEnv } from "./support.mjs";

const KEY = `not-a-secret-${"run-learning"}-7c2e19`;
/** Every variable these tests set or clear: the server holds no model key of its own. */
const NAMES = ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_API_KEY", "AGENT_MODEL_PRICE", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_GATEWAY_IDS", "AGENTRUN_SERVE_GRADE_MODEL", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENROUTER_API_KEY"];
const keylessEnv = (url) => ({ AGENT_MODEL_BASE_URL: url, AGENT_MODEL: "claude-sonnet-5-5" });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** The model requests the gateway took, in order. */
const posts = (gw) => gw.requests.filter((request) => request.method === "POST");

async function until(check, what, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await sleep(50);
  }
}

/** A server with learning on, a faux gateway and no model key of its own: every run brings its own. */
async function keyless(t, options = {}) {
  const gw = await startFauxGateway({ text: "Answered." });
  t.after(() => gw.close());
  withEnv(t, keylessEnv(gw.url), NAMES);
  const server = await serve(t, { learning: "on", faux: undefined, ...options });
  return { gw, ...server };
}

/** Run `runId` followed to its end, then until its learning ended (its compile turn, when one was asked, answered). */
async function ended(api, runId) {
  const { last } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 90_000 });
  await until(async () => !["seeded", "reflecting"].includes((await api("GET", `/runs/${runId}`)).body.learning?.state), `run ${runId}'s learning ended`);
  return last;
}

test("a run's learning object without its own model_key and max_cost_usd is 400 learning_needs_cap in words, nothing made; a malformed object is 422 at its field; an inline run takes only \"use\"", { timeout: 60_000 }, async (t) => {
  const { api, store } = await keyless(t, { runner: false });
  await made(api, agent("plain"));
  for (const extra of [{}, { model_key: KEY }, { max_cost_usd: 1 }]) {
    const res = await api("POST", "/agents/plain/runs", { input: { content: "Go." }, learning: { settings: { compile_after: 1 } }, ...extra });
    assert.deepEqual([res.status, res.body.error?.code], [400, "learning_needs_cap"], `${JSON.stringify(extra)}: ${JSON.stringify(res.body)}`);
    assert.match(res.body.error.message, /model_key/, JSON.stringify(res.body.error));
    assert.match(res.body.error.message, /max_cost_usd/, JSON.stringify(res.body.error));
  }
  const bare = await api("POST", "/agents/plain/runs", { input: { content: "Go." }, learning: {} });
  assert.deepEqual([bare.status, bare.body.error?.code], [400, "learning_needs_cap"], `an object with no settings asks too: ${JSON.stringify(bare.body)}`);
  assert.equal((await store.runs.list({})).length, 0, "no run made");

  const keyed = { model_key: KEY, max_cost_usd: 1 };
  const cases = [
    [{ settings: { compile_after: 0 } }, "learning.settings.compile_after"],
    [{ settings: { agree_min: 2 } }, "learning.settings.agree_min"],
    [{ settings: { nope: 1 } }, "learning.settings.nope"],
    [{ settings: true }, "learning.settings"],
    [{ other: 1 }, "learning.other"],
  ];
  for (const [learning, field] of cases) {
    const res = await api("POST", "/agents/plain/runs", { input: { content: "Go." }, learning, ...keyed });
    assert.equal(res.status, 422, `${JSON.stringify(learning)}: ${JSON.stringify(res.body)}`);
    assert.ok(res.body.error.fields?.some((one) => one.field === field), `${JSON.stringify(learning)} names ${field}: ${JSON.stringify(res.body.error)}`);
  }
  assert.equal((await store.runs.list({})).length, 0, "no run made");

  const inline = await api("POST", "/runs", { external: { source: "host", kind: "expert", id: "x", version: 1 }, definition: { name: "Inline", instructions: "Answer." }, input: { content: "Go." }, learning: { settings: {} }, ...keyed });
  assert.equal(inline.status, 422, JSON.stringify(inline.body));
  assert.ok(inline.body.error.fields?.some((one) => one.field === "learning"), JSON.stringify(inline.body.error));
  assert.equal((await store.runs.list({})).length, 0, "no inline run made");
});

test("capabilities say a server takes a run's learning object: features.run_learning", { timeout: 60_000 }, async (t) => {
  const { api } = await keyless(t, { runner: false });
  const caps = (await api("GET", "/capabilities")).body;
  assert.equal(caps.features?.run_learning, true, JSON.stringify(caps.features));
});

test("a keyed, capped run that asks to learn, of an agent whose definition has no learning, learns on its agent's learning: its launch keeps its settings and its compile turn is asked at its first run on the run's own key", { timeout: 180_000 }, async (t) => {
  const { api, store, gw } = await keyless(t);
  await made(api, agent("plain"));
  const res = await api("POST", "/agents/plain/runs", { input: { content: "Answer." }, model_key: KEY, max_cost_usd: 2, learning: { settings: { compile_after: 1, audit_every: 1 } } });
  assert.equal(res.status, 202, JSON.stringify(res.body));
  const runId = res.body.run_id;
  const launch = (await store.runs.launch(runId)).body;
  assert.deepEqual(launch.learning?.settings, { compile_after: 1, audit_every: 1 }, `its launch keeps the settings it asked with: ${JSON.stringify(launch.learning)}`);
  assert.equal(launch.max_cost_usd, 2);
  const last = await ended(api, runId);
  assert.equal(last.status, "completed");
  assert.ok(posts(gw).length >= 2, `its job's turn and its compile turn both asked the gateway: ${posts(gw).length}`);
  assert.deepEqual([...new Set(posts(gw).map((request) => request.headers.authorization))], [`Bearer ${KEY}`], "every request on the run's own key");
  const view = (await api("GET", `/runs/${runId}`)).body;
  assert.notEqual(view.learning, null, `the run learned: ${JSON.stringify(view.learning)}`);
});

test("a run's settings beat its revision's: at compile_after 20 a plain first run asks no compile turn, a first run that asks with compile_after 1 does; a follow-up keeps its run's launch", { timeout: 240_000 }, async (t) => {
  const { api, store, gw } = await keyless(t);
  await made(api, learner("slow", { learning: { compile_after: 20 } }));
  const plain = await api("POST", "/agents/slow/runs", { input: { content: "Answer." }, model_key: KEY, max_cost_usd: 2 });
  assert.equal(plain.status, 202, JSON.stringify(plain.body));
  await ended(api, plain.body.run_id);
  assert.equal(posts(gw).length, 1, `a plain run of an agent at compile_after 20 asks its job's turn alone: ${posts(gw).length}`);

  await made(api, learner("fast", { learning: { compile_after: 20 } }));
  const asked = await api("POST", "/agents/fast/runs", { input: { content: "Answer." }, model_key: KEY, max_cost_usd: 2, learning: { settings: { compile_after: 1 } } });
  assert.equal(asked.status, 202, JSON.stringify(asked.body));
  const runId = asked.body.run_id;
  const before = posts(gw).length;
  await ended(api, runId);
  assert.ok(posts(gw).length - before >= 2, `the run's compile_after 1 asks its compile turn at its first run: ${posts(gw).length - before} requests`);

  const sent = await api("POST", `/runs/${runId}/messages`, { content: "And then?", model_key: KEY });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  await until(async () => (await store.runs.launch(runId)).sealed === null && (await api("GET", `/runs/${runId}`)).body.status === "completed", "the follow-up's turn ends");
  assert.deepEqual((await store.runs.launch(runId)).body.learning?.settings, { compile_after: 1 }, "a follow-up keeps its run's launch, its settings with it");
});
