// An agent's learning as its agent-level reads take it once a run asked to learn (POST /agents/{agent_id}/runs
// `learning: {settings}`): the settings of its newest run that asked, else its revision's definition's. Proven here,
// through the API:
//   - an agent whose revision has no learning, after a keyed, capped run of it asked with compile_after 1: its view says
//     its learning (`learning.pending`), and the loop read counts its completed runs toward that run's compile_after
//     (1), not the default (20), never reading empty while its runs learn;
//   - an agent whose revision learns and no run of which asked reads as its revision says, its views the same bytes
//     before and after another agent's run asked;
//   - on a server whose learning is off, a run that asks is 400 learning_off in words, nothing stored, and capabilities
//     say the server takes no learning object (`features.run_learning` false).
// The audit's hold on the asking run's numbers is learn-audit-ledger.test.mjs's.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { learner, made } from "./learn-support.mjs";
import { agent, follow, serve, withEnv } from "./support.mjs";

const KEY = `not-a-secret-${"agent-learning"}-41d7a0`;
/** Every variable these tests set or clear: the server holds no model key of its own. */
const NAMES = ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_API_KEY", "AGENT_MODEL_PRICE", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_GATEWAY_IDS", "AGENTRUN_SERVE_GRADE_MODEL", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENROUTER_API_KEY"];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, what, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await sleep(50);
  }
}

/** A server with learning `learning`, a faux gateway and no model key of its own: every run brings its own. */
async function keyless(t, options = {}) {
  const gw = await startFauxGateway({ text: "Answered." });
  t.after(() => gw.close());
  withEnv(t, { AGENT_MODEL_BASE_URL: gw.url, AGENT_MODEL: "claude-sonnet-5-5" }, NAMES);
  const server = await serve(t, { learning: "on", faux: undefined, ...options });
  return { gw, ...server };
}

/** A keyed, capped run of agent `id` (with `extra`), followed to its end and its learning's. */
async function ran(api, id, extra = {}) {
  const res = await api("POST", `/agents/${id}/runs`, { input: { content: "Answer." }, model_key: KEY, max_cost_usd: 2, ...extra });
  assert.equal(res.status, 202, JSON.stringify(res.body));
  const { last } = await follow(api, res.body.run_id, ["completed", "failed"], { deadlineMs: 90_000 });
  assert.equal(last.status, "completed", JSON.stringify(last));
  await until(async () => !["seeded", "reflecting"].includes((await api("GET", `/runs/${res.body.run_id}`)).body.learning?.state), `run ${res.body.run_id}'s learning ended`);
  return res.body.run_id;
}

/** What agent `id`'s agent-level learning reads answer, as sent. */
async function reads(api, id) {
  const out = {};
  for (const path of [`/agents/${id}`, `/agents/${id}/learning/loop`, `/agents/${id}/learning/promotions`]) {
    const res = await api("GET", path);
    assert.equal(res.status, 200, `${path}: ${JSON.stringify(res.body)}`);
    out[path] = res.body;
  }
  return out;
}

test("an agent whose revision has no learning, once a run of it asked with compile_after 1: its view says its learning and its loop counts toward that run's compile_after", { timeout: 240_000 }, async (t) => {
  const { api } = await keyless(t);
  await made(api, agent("plain"));
  const before = (await api("GET", "/agents/plain")).body;
  assert.equal(before.learning, undefined, `no run asked yet: the agent does not learn (${JSON.stringify(before.learning)})`);
  await ran(api, "plain", { learning: { settings: { compile_after: 1 } } });
  await ran(api, "plain");
  const view = (await api("GET", "/agents/plain")).body;
  assert.equal(typeof view.learning?.pending, "number", `its view says its learning, as an agent's that learns: ${JSON.stringify(view.learning)}`);
  const loop = (await api("GET", "/agents/plain/learning/loop")).body;
  assert.equal(loop.completed_runs, 1, `2 completed runs counted toward the asking run's compile_after 1, never the default 20: ${JSON.stringify(loop)}`);
});

test("an agent whose revision learns, and no run of which asked, reads as its revision says: the same bytes before and after another agent's run asked", { timeout: 240_000 }, async (t) => {
  const { api } = await keyless(t);
  await made(api, learner("own", { learning: { compile_after: 1 } }));
  await made(api, agent("other"));
  await ran(api, "own");
  await ran(api, "own");
  const first = await reads(api, "own");
  assert.equal(typeof first["/agents/own"].learning?.pending, "number", JSON.stringify(first["/agents/own"].learning));
  assert.equal(first["/agents/own/learning/loop"].completed_runs, 1, `its revision's compile_after 1: ${JSON.stringify(first["/agents/own/learning/loop"])}`);
  await ran(api, "other", { learning: { settings: { compile_after: 5, audit_every: 1 } } });
  const again = await reads(api, "own");
  for (const path of Object.keys(first)) assert.equal(JSON.stringify(again[path]), JSON.stringify(first[path]), `${path} reads the same bytes`);
});

test("on a server whose learning is off a run that asks to learn is 400 learning_off in words, nothing stored, and capabilities say the server takes no learning object", { timeout: 60_000 }, async (t) => {
  const { api, store } = await keyless(t, { learning: "off", runner: false });
  await made(api, agent("plain"));
  const res = await api("POST", "/agents/plain/runs", { input: { content: "Go." }, model_key: KEY, max_cost_usd: 1, learning: { settings: { compile_after: 1 } } });
  assert.deepEqual([res.status, res.body.error?.code], [400, "learning_off"], JSON.stringify(res.body));
  assert.equal(res.body.error.message, "Learning is off on this server.");
  assert.equal((await store.runs.list({})).length, 0, "no run made");
  const use = await api("POST", "/agents/plain/runs", { input: { content: "Go." }, model_key: KEY, max_cost_usd: 1, learning: "use" });
  assert.equal(use.status, 202, `"use" still starts a run there, given nothing: ${JSON.stringify(use.body)}`);
  const caps = (await api("GET", "/capabilities")).body;
  assert.equal(caps.features?.learning, "off");
  assert.equal(caps.features?.run_learning, false, JSON.stringify(caps.features));
});
