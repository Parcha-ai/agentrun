// An agent's learning as its agent-level reads take it once a run asked to learn (POST /agents/{agent_id}/runs
// `learning: {settings}`): the newer of its newest run that asked (its start) and its current revision (its save).
// Proven here, through the API:
//   - an agent whose revision has no learning, after a keyed, capped run of it asked with compile_after 1: its view says
//     its learning (`learning.pending`), and the loop read counts its completed runs toward that run's compile_after
//     (1), not the default (20), never reading empty while its runs learn;
//   - an agent whose revision learns and no run of which asked reads as its revision says, its views the same bytes
//     before and after another agent's run asked;
//   - the newer wins: a revision saved after an asking run that says learning false reads as not learning (its view
//     off, its hold and its promotions read's audit line on that revision's numbers); a run that asks after that save is
//     on again with its settings;
//   - a tie goes to the run: one that asks in the millisecond its agent's revision was saved is the newer;
//   - an agent's purge takes the row naming its newest run that asked, another agent's row kept;
//   - on a server whose learning is off, a run that asks is 400 learning_off in words, nothing stored, and capabilities
//     say the server takes no learning object (`features.run_learning` false).
// The audit's hold on the asking run's numbers is learn-audit-ledger.test.mjs's.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { learner, made, putLearning } from "./learn-support.mjs";
import { putPromotions } from "./learned-workflow-seed-support.mjs";
import { agent, follow, serve, withEnv } from "./support.mjs";

const { auditLoopOfAgent } = await import("../dist/runner/audit.js");
const { auditLoopOf } = await import("../dist/learning-setting.js");
const { agentRunLearningKey } = await import("../dist/agent-run-learning.js");

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

/** A learned workflow `answer` that takes the agent's own input, landed on agent `id`'s learning and promoted by its
 *  check, so its promotions read has a serving line with an audit line. */
async function serving(store, id) {
  const flow = {
    v: 2, name: "answer",
    schemas: { In: { type: "object", required: ["content"], properties: { content: { type: "string" } } }, Answer: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } } },
    input: { schemaId: "In" }, output: { schemaId: "Answer", path: "answer" },
    root: { node: "chain", steps: [{ node: "extract", label: "answer", instructions: "Answer the question.", out: "Answer", as: "answer" }] },
  };
  const text = JSON.stringify(flow);
  const digest = createHash("sha256").update(text).digest("hex").slice(0, 16);
  const main = await putLearning(store, id, { "workflows/answer/workflow.json": text, "workflows/answer/README.md": "---\nname: answer\ndescription: Answers a question as a number; use when the person asks for the answer\n---\n" });
  await putPromotions(store, id, [{ workflow: "answer", digest, at: new Date().toISOString(), decided: "promote", reason: "checked: promoted", check: { compile_after: 5, agree_min: 0.8, alone_min: 0.7, attempt: 1, n: 5, agreed: 5, alone: 5, of: [] }, commit: main }]);
}

test("the newer wins: a revision saved after an asking run that says learning false makes the agent read as not learning, its hold and its promotions read's audit line on that revision's numbers; a run that asks after that save wins again with its settings", { timeout: 60_000 }, async (t) => {
  const { api, store } = await keyless(t, { runner: false });
  await made(api, agent("plain"));
  await serving(store, "plain");
  const asks = async (settings) => {
    const res = await api("POST", "/agents/plain/runs", { input: { content: "Go." }, model_key: KEY, max_cost_usd: 1, learning: { settings } });
    assert.equal(res.status, 202, JSON.stringify(res.body));
    await sleep(5);
  };
  const hold = async () => auditLoopOfAgent(store, "plain", (await store.agents.get("plain")).currentRevision);
  /** The serving workflow's audit line's hold numbers, as GET .../learning/promotions sends them. */
  const auditLine = async () => {
    const read = await api("GET", "/agents/plain/learning/promotions");
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.serving?.length, 1, JSON.stringify(read.body));
    const { window, disagree } = read.body.serving[0].audit ?? {};
    return [window, disagree];
  };
  await asks({ compile_after: 2, audit_every: 2, hold_window: 4, hold_disagree: 2 });
  assert.equal(typeof (await api("GET", "/agents/plain")).body.learning?.pending, "number", "the asking run: on");
  assert.equal((await hold()).audit_every, 2, "the hold reads the asking run's numbers");
  assert.deepEqual(await auditLine(), [4, 2], "the promotions read's audit line is at the asking run's hold numbers");
  // (i) A revision saved after it, saying learning false: off, the hold on that revision's numbers (the defaults).
  const got = await api("GET", "/agents/plain");
  const saved = await api("PUT", "/agents/plain/definition", { definition: { name: "plain", instructions: "Answer again.", skills: [], tools: [], learning: false } }, { "if-match": got.headers.get("etag") });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  await sleep(5);
  const off = (await api("GET", "/agents/plain")).body;
  assert.equal(off.learning, undefined, `a revision saved after the asking run says learning false: not learning (${JSON.stringify(off.learning)})`);
  const defaults = auditLoopOf(undefined);
  assert.deepEqual(await hold(), defaults, "the hold falls back to that revision's numbers");
  assert.deepEqual(await auditLine(), [defaults.hold_window, defaults.hold_disagree], "and the audit line with it");
  assert.equal((await api("GET", "/agents/plain/learning/loop")).status, 200);
  // (ii) Another asking run after that save: on again, with its settings.
  await asks({ compile_after: 3, audit_every: 3, hold_window: 6, hold_disagree: 3 });
  assert.equal(typeof (await api("GET", "/agents/plain")).body.learning?.pending, "number", "a run that asks after that save: on again");
  assert.equal((await hold()).audit_every, 3, "the hold reads the newer asking run's numbers");
  assert.deepEqual(await auditLine(), [6, 3], "the audit line at the newer asking run's numbers");
});

test("a tie goes to the run: a run that asks to learn in the very millisecond its agent's revision was saved is the newer, and its agent reads as learning", { timeout: 60_000 }, async (t) => {
  // One frozen clock for the server and its store: the agent's save and the run's start read the same millisecond.
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 10, 28, 12) });
  const { api, store } = await keyless(t, { runner: false });
  await made(api, agent("plain"));
  assert.equal((await api("GET", "/agents/plain")).body.learning, undefined, "no run asked yet");
  const res = await api("POST", "/agents/plain/runs", { input: { content: "Go." }, model_key: KEY, max_cost_usd: 1, learning: { settings: { compile_after: 2 } } });
  assert.equal(res.status, 202, JSON.stringify(res.body));
  const named = await store.settings.get(agentRunLearningKey("plain"));
  const revision = await store.agents.revision((await store.agents.get("plain")).currentRevision);
  assert.deepEqual([named?.run, named?.at], [res.body.run_id, revision.createdAt], "the run was named in the millisecond the revision was saved");
  const view = (await api("GET", "/agents/plain")).body;
  assert.equal(typeof view.learning?.pending, "number", `a tie goes to the run: the agent learns (${JSON.stringify(view.learning)})`);
});

test("an agent's purge takes the row naming its newest run that asked to learn; another agent's row stays", { timeout: 60_000 }, async (t) => {
  const { api, store } = await keyless(t, { runner: false });
  const asked = {};
  for (const id of ["gone", "kept"]) {
    await made(api, agent(id));
    const res = await api("POST", `/agents/${id}/runs`, { input: { content: "Go." }, model_key: KEY, max_cost_usd: 1, learning: { settings: { compile_after: 2 } } });
    assert.equal(res.status, 202, JSON.stringify(res.body));
    asked[id] = res.body.run_id;
    // Ended as a runner ends it: a run of an agent being purged is final.
    await store.runs.update(await store.claim(res.body.run_id, "runner-test", { leaseMs: 60_000 }), { state: "ended" });
    assert.equal((await store.settings.get(agentRunLearningKey(id)))?.run, res.body.run_id, `${id}'s asking run is named`);
  }
  assert.equal((await api("POST", "/agents/gone/archive")).status, 200);
  const deleted = await api("DELETE", "/agents/gone");
  assert.equal(deleted.status, 204, JSON.stringify(deleted.body));
  assert.equal(await store.settings.get(agentRunLearningKey("gone")), undefined, "the purged agent's row is gone");
  assert.equal((await store.settings.get(agentRunLearningKey("kept")))?.run, asked.kept, "the other agent's row is as it was");
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
