// A replay its owner starts (POST /agents/{id}/learning/workflows/{name}/revisions/{digest}/replays) and reads (GET the
// same path + /{replay_id}): the claim path's replay (runner/promotion.ts), started by a person. On a held revision, by
// default on the graded inputs its hold was decided on; its replay runs run as a claim's do, and once they ended its read
// decides it in the claim path's words and record shapes (a check's record). One replay of a revision at a time (409), only
// a revision and workflow the agent has (404), a whole number of inputs within the grades kept (400), and only by the
// owner's password session (a token is 403), as making a learned workflow an agent is.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { GRADES_KEPT, promotionsOf, recordPromotion } from "../dist/learn/promote.js";
import { putLearning } from "./learn-support.mjs";
import { putPromotions } from "./learned-workflow-seed-support.mjs";
import { schemaProblems } from "./schema-support.mjs";
import { agent, call, cookieOf, follow, serve, withEnv } from "./support.mjs";

const SIGN_IN_PHRASE = "the owner signs in with this phrase";
const json = { "content-type": "application/json" };
/** A learned workflow that takes the agent's own input (`content`) and answers a number with one model node. */
const FLOW = {
  v: 2, name: "answer",
  schemas: {
    In: { type: "object", required: ["content"], properties: { content: { type: "string" } } },
    Answer: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } },
  },
  input: { schemaId: "In" },
  output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [{ node: "extract", label: "answer", instructions: "Answer the question.", out: "Answer", as: "answer" }] },
};
const TEXT = JSON.stringify(FLOW);
const DIGEST = createHash("sha256").update(TEXT).digest("hex").slice(0, 16);

/** A server with accounts and the owner's session; agent `source` learning (`learning`: its definition's), `graded` runs of
 *  it ended on the agent's path and graded right, then the workflow landed on its learning. */
async function world(t, { graded = 5, learning = true } = {}) {
  withEnv(t, {}, ["AGENTRUN_TEST_FAUX_CALLS", "TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "AGENT_MODEL_STRONG"]);
  const server = await serve(t, { learning: "on", accounts: true, openSetup: true });
  const { api, data, port, baseUrl } = server;
  const origin = `http://127.0.0.1:${port}`;
  const setup = await call(port, { method: "POST", path: "/v2/setup", headers: { ...json, origin }, body: { password: SIGN_IN_PHRASE } });
  assert.equal(setup.status, 201, setup.text);
  const cookie = cookieOf(setup);
  assert.equal((await api("POST", "/agents", agent("source", { learning }))).status, 201);
  // The graded runs: on the agent's path (no workflow learned yet), keeping nothing (`use`), each graded right.
  const runs = [];
  for (let i = 0; i < graded; i++) {
    const started = await api("POST", "/agents/source/runs", { input: { content: `What is ${i} plus 42?` }, learning: "use" });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await follow(api, started.body.run_id, ["completed"], { deadlineMs: 60_000 });
    const grade = await api("PUT", `/runs/${started.body.run_id}/grade`, { correct: true, source: "eval" });
    assert.equal(grade.status, 200, JSON.stringify(grade.body));
    assert.equal(grade.body.path, "agent");
    runs.push(started.body.run_id);
  }
  const files = { "workflows/answer/workflow.json": TEXT, "workflows/answer/README.md": "---\nname: answer\ndescription: Answers a question as a number; use when the person asks for the answer\n---\n" };
  const main = await putLearning(server.store, "source", files);
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  const base = (agentId = "source", name = "answer", digest = DIGEST) => `/v2/agents/${agentId}/learning/workflows/${name}/revisions/${digest}/replays`;
  const replay = (body = {}, { agentId, name, digest, headers = { ...json, cookie, origin } } = {}) => call(port, { method: "POST", path: base(agentId, name, digest), headers, body });
  return { ...server, runs, main, doc, replay, cookie, origin };
}

test("an owner replays a held revision on the inputs its hold was decided on: 202, its runs end, its read decides it as a claim would, record a check's", { timeout: 240_000 }, async (t) => {
  const { api, store, runs, main, doc, replay } = await world(t, { graded: 6 });
  // Held on a replay of five of the six graded runs (its record names them, and the commit its text is at).
  const held = runs.slice(0, 5);
  await putPromotions(store, "source", [{ workflow: "answer", digest: DIGEST, at: new Date().toISOString(), decided: "hold", reason: "checked on 5 of the agent's inputs: held",
    check: { compile_after: 5, agree_min: 0.8, alone_min: 0.7, attempt: 1, n: 5, agreed: 4, alone: 5, of: held, cost_usd: 0.01, outcomes: { answered: 5, handed_back: 0, failed: 0, skipped_write: 0 } }, inputs: held, commit: main }]);
  const meets = (path, method, status, value) => assert.deepEqual(schemaProblems(doc, doc.paths[path][method].responses[status].content["application/json"].schema, value), [], `${path}: ${JSON.stringify(value)}`);

  const started = await replay();
  assert.equal(started.status, 202, started.text);
  assert.equal(started.json.inputs, 5, "the inputs its hold was decided on");
  assert.match(started.json.replay, /^[0-9a-f-]{36}$/);
  meets("/agents/{agent_id}/learning/workflows/{name}/revisions/{digest}/replays", "post", "202", started.json);
  // One replay of a revision at a time.
  const again = await replay();
  assert.equal(again.status, 409, again.text);
  assert.equal(again.json.error.code, "replay_conflict");
  assert.match(again.json.error.message, /replaying/);

  const path = `/agents/source/learning/workflows/answer/revisions/${DIGEST}/replays/${started.json.replay}`;
  let read;
  const end = Date.now() + 180_000;
  for (;;) {
    read = await api("GET", path);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    if (read.body.status !== "running") break;
    assert.ok(Date.now() < end, `the replay never ended: ${JSON.stringify(read.body)}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  meets("/agents/{agent_id}/learning/workflows/{name}/revisions/{digest}/replays/{replay_id}", "get", "200", read.body);
  const view = read.body;
  assert.equal(view.status, "done", JSON.stringify(view));
  assert.ok(["promote", "hold"].includes(view.decided), JSON.stringify(view));
  assert.equal(view.inputs, 5);
  // Its runs' outcomes once, nested as the promotion record keeps them; no count derived from the score beside it.
  assert.deepEqual(Object.keys(view.outcomes).sort(), ["answered", "failed", "handed_back", "skipped_write"], JSON.stringify(view));
  for (const field of ["answered", "handed_back", "failed", "skipped_write", "alone"]) assert.equal(field in view, false, `no top-level ${field}: ${JSON.stringify(view)}`);
  const { answered, handed_back, failed, skipped_write } = view.outcomes;
  assert.equal(answered + handed_back + failed + skipped_write, 5, `every input is counted once: ${JSON.stringify(view)}`);
  assert.equal(answered, 5, `each replay run ran the revision at its learning commit, the workflow alone: ${JSON.stringify(view)}`);
  assert.equal(view.score.n, answered + handed_back, "scored: the inputs it answered or handed back");
  // The record it decided is a replay's, as a claim's is: the Learning tab and the gate read it unchanged.
  const records = (await api("GET", "/agents/source/learning/promotions")).body.promotions;
  const mine = records.filter((one) => one.replay_id === started.json.replay);
  assert.deepEqual(mine.map(({ decided }) => decided), ["replaying", view.decided], JSON.stringify(records));
  assert.deepEqual([...mine[1].check.of].sort(), [...held].sort(), "replayed on the held inputs");
  assert.deepEqual(mine[1].check.outcomes, view.outcomes, "the read's outcomes are the record's");
  assert.deepEqual(mine[0].inputs.length, 5);
  assert.equal(mine[1].commit, main);
  // Its replay runs are runs of the agent on the replay path, each on one of the held inputs.
  for (const id of mine[0].runs) {
    const run = (await api("GET", `/runs/${id}`)).body;
    assert.ok(["completed", "failed", "escalated"].includes(run.status), JSON.stringify(run));
  }
  assert.equal((await api("GET", `${path.slice(0, path.lastIndexOf("/"))}/not-a-replay`)).status, 404, "an unknown replay is 404");
});

// Review on #3064 (PRRT_kwDOUmdVMs64QeeB): "held" reads the inputs off the revision's decided check (`check.of`), not
// only off its reservation's `inputs`. A hold decided on three of six runs whose reservation record is not among the
// agent's records (only the hold is): replay "held" still replays exactly those three, never the agent's newest runs.
test("an owner's held replay with no reservation record beside its hold: it replays exactly the cases the hold was decided on", { timeout: 240_000 }, async (t) => {
  const { api, store, runs, main, replay } = await world(t, { graded: 6 });
  const held = [runs[0], runs[2], runs[4]];
  const bar = { compile_after: 5, agree_min: 0.8, alone_min: 0.7, attempt: 1 };
  const replayId = "00000000-0000-7000-8000-000000000001";
  await recordPromotion(store.learning, "source", { at: new Date().toISOString(), workflow: "answer", digest: DIGEST, decided: "hold", reason: "checked on 3 of the agent's inputs: held", replay_id: replayId, commit: main,
    check: { ...bar, n: 3, agreed: 2, alone: 3, of: held, cost_usd: 0.01, outcomes: { answered: 3, handed_back: 0, failed: 0, skipped_write: 0 } } }, () => true);
  const kept = (await promotionsOf(store.learning, "source")).filter((one) => one.workflow === "answer");
  assert.deepEqual(kept.map(({ decided, inputs }) => [decided, inputs]), [["hold", undefined]], `only the hold, no reservation: ${JSON.stringify(kept)}`);

  const started = await replay();
  assert.equal(started.status, 202, started.text);
  assert.equal(started.json.inputs, held.length, `the held cases, not the agent's newest runs: ${started.text}`);
  const reserved = (await api("GET", "/agents/source/learning/promotions")).body.promotions.find((one) => one.replay_id === started.json.replay);
  assert.equal(reserved?.decided, "replaying", JSON.stringify(reserved));
  assert.deepEqual([...reserved.inputs].sort(), [...held].sort(), "replayed on exactly the inputs its hold was decided on");
  // Its runs end before the server closes.
  for (const id of reserved.runs) await follow(api, id, ["completed", "failed", "escalated"], { deadlineMs: 120_000 });
});

// Review on #3064 (PRRT_kwDOUmdVMs64PlpE): with no earlier check, an owner's replay picks the agent's own compile_after
// (its definition's), never the default's 20: 5 picks 5 of 6 runs, 30 picks 30 of 31. Its record's bar says the same.
for (const compileAfter of [5, 30]) test(`an owner's replay of a revision never checked, compile_after ${compileAfter} on the definition: it picks the agent's last ${compileAfter} completed runs`, { timeout: 480_000 }, async (t) => {
  const { api, runs, replay } = await world(t, { graded: compileAfter + 1, learning: { compile_after: compileAfter } });
  const started = await replay();
  assert.equal(started.status, 202, started.text);
  assert.equal(started.json.inputs, compileAfter, `the agent's compile_after, not the default 20: ${started.text}`);
  const reserved = (await api("GET", "/agents/source/learning/promotions")).body.promotions.find((one) => one.replay_id === started.json.replay);
  assert.equal(reserved?.decided, "replaying", JSON.stringify(reserved));
  assert.deepEqual([...reserved.inputs].sort(), runs.slice(1).sort(), "the newest compileAfter of the agent's own completed runs");
  assert.equal(reserved.check.compile_after, compileAfter, "the bar its record keeps is the definition's");
  // Its runs end before the server closes.
  for (const id of reserved.runs) await follow(api, id, ["completed", "failed", "escalated"], { deadlineMs: 120_000 });
});

test("a replay is refused: a token (403), an unknown agent, workflow or revision (404), a number of inputs out of range (400)", { timeout: 180_000 }, async (t) => {
  const { replay, token } = await world(t, { graded: 1 });
  const refused = await replay({}, { headers: { ...json, authorization: `Bearer ${token}` } });
  assert.deepEqual([refused.status, refused.json?.error?.code], [403, "forbidden"], refused.text);
  assert.match(refused.json.error.message, /password sign-in/);
  const noCookie = await replay({}, { headers: json });
  assert.equal(noCookie.status, 401, "no credential at all is 401, as every route is");
  for (const [where, what] of [[{ agentId: "nobody" }, "agent"], [{ name: "nothing" }, "workflow"], [{ digest: "0123456789abcdef" }, "revision"]]) {
    const missing = await replay({}, where);
    assert.equal(missing.status, 404, `${what}: ${missing.text}`);
  }
  for (const inputs of [0, GRADES_KEPT + 1, 1.5, "all", null]) {
    const bad = await replay({ inputs });
    assert.equal(bad.status, 400, `${JSON.stringify(inputs)}: ${bad.text}`);
    assert.match(bad.json.error.message, /inputs is "held"/);
  }
});

test("an archived agent's replay is refused as its run's start is (409 agent_not_runnable): nothing reserved, no run started", { timeout: 180_000 }, async (t) => {
  const { api, replay } = await world(t, { graded: 1 });
  assert.equal((await api("POST", "/agents/source/archive")).status, 200);
  const refused = await replay();
  assert.deepEqual([refused.status, refused.json?.error?.code], [409, "agent_not_runnable"], refused.text);
  assert.match(refused.json.error.message, /archived: unarchive it to run it/);
  assert.equal(typeof refused.json.error.details?.archived_at, "string");
  assert.deepEqual((await api("GET", "/agents/source/learning/promotions")).body.promotions, [], "no replay reserved");
  const runs = (await api("GET", "/agents/source/runs?archived=true")).body.runs;
  assert.equal(runs.length, 1, `only the graded run: ${JSON.stringify(runs)}`);
});
