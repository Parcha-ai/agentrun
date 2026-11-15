// A replay its owner starts (POST /agents/{id}/learning/workflows/{name}/revisions/{digest}/replays) and reads (GET the
// same path + /{replay_id}): the claim path's replay (runner/promotion.ts), started by a person. On a held revision, by
// default on the graded inputs its hold was decided on; its replay runs run as a claim's do, and once they ended its read
// decides it in the claim path's words and record shapes (source replay). One replay of a revision at a time (409), only
// a revision and workflow the agent has (404), a whole number of inputs within the grades kept (400), and only by the
// owner's password session (a token is 403), as making a learned workflow an agent is.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { agentFolderOf } from "../dist/files.js";
import { seedOf } from "../dist/learning.js";
import { GRADES_KEPT, gradesOf, REPLAY_MIN } from "../dist/learn/promote.js";
import { git, resnap } from "./learn-support.mjs";
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

/** A server with accounts and the owner's session; agent `source` learning, `graded` runs of it ended on the agent's path
 *  and graded right, then the workflow landed on its learning folder's main. */
async function world(t, { graded = 5 } = {}) {
  withEnv(t, {}, ["AGENTRUN_TEST_FAUX_GRADE_HOLD", "AGENTRUN_TEST_FAUX_CALLS", "TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "AGENT_MODEL_STRONG", "AGENTRUN_SERVE_GRADE_MODEL"]);
  const server = await serve(t, { learning: "on", accounts: true, openSetup: true });
  const { api, data, port, baseUrl } = server;
  const origin = `http://127.0.0.1:${port}`;
  const setup = await call(port, { method: "POST", path: "/v2/setup", headers: { ...json, origin }, body: { password: SIGN_IN_PHRASE } });
  assert.equal(setup.status, 201, setup.text);
  const cookie = cookieOf(setup);
  assert.equal((await api("POST", "/agents", agent("source", { learning: true }))).status, 201);
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
  await seedOf(data, "source");
  const repo = join(agentFolderOf(data, "source"), "learning");
  const files = { "workflows/answer/workflow.json": TEXT, "workflows/answer/README.md": "---\nname: answer\ndescription: Answers a question as a number; use when the person asks for the answer\n---\n" };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(repo, ["add", "--", ...Object.keys(files)]);
  git(repo, ["commit", "-q", "-m", "learned"]);
  await resnap(data, "source");
  const main = git(repo, ["rev-parse", "main"]);
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  const base = (agentId = "source", name = "answer", digest = DIGEST) => `/v2/agents/${agentId}/learning/workflows/${name}/revisions/${digest}/replays`;
  const replay = (body = {}, { agentId, name, digest, headers = { ...json, cookie, origin } } = {}) => call(port, { method: "POST", path: base(agentId, name, digest), headers, body });
  return { ...server, runs, main, doc, replay, cookie, origin };
}

test("an owner replays a held revision on the inputs its hold was decided on: 202, its runs end, its read decides it as a claim would, record source replay", { timeout: 240_000 }, async (t) => {
  const { api, store, runs, main, doc, replay } = await world(t, { graded: 6 });
  // Held on a replay of five of the six graded runs (its record names them, and the commit its text is at).
  const held = runs.slice(0, 5);
  await store.settings.put("learning.promotions.source", { v: 1, items: [{ workflow: "answer", digest: DIGEST, at: new Date().toISOString(), decided: "hold", source: "replay", reason: "replayed on 5 graded inputs: more than 2 pts under the agent",
    replay: { n: 5, agree: 0, agent_acc: 1, wf_acc: 0.8, delta: -0.2, handed_back: 0, of: held, cost_usd: 0.01, skipped_tools: [], outcomes: { answered: 5, handed_back: 0, failed: 0, skipped_write: 0 } }, commit: main }] });
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
  assert.deepEqual(mine.map(({ decided, source }) => [decided, source]), [["replaying", "replay"], [view.decided, "replay"]], JSON.stringify(records));
  assert.deepEqual([...mine[1].replay.of].sort(), [...held].sort(), "replayed on the held inputs");
  assert.deepEqual(mine[1].replay.outcomes, view.outcomes, "the read's outcomes are the record's");
  assert.equal("skipped_write" in mine[1].replay, false, `one count of skipped inputs, in outcomes: ${JSON.stringify(mine[1].replay)}`);
  assert.deepEqual(mine[0].inputs.length, 5);
  assert.equal(mine[1].commit, main);
  // Its replay runs are runs of the agent on the replay path, each on one of the held inputs.
  for (const id of mine[0].runs) {
    const run = (await api("GET", `/runs/${id}`)).body;
    assert.ok(["completed", "failed", "escalated"].includes(run.status), JSON.stringify(run));
  }
  assert.equal((await api("GET", `${path.slice(0, path.lastIndexOf("/"))}/not-a-replay`)).status, 404, "an unknown replay is 404");
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

// Review of #2823, item 4: a replay on fewer than REPLAY_MIN inputs can only hold (its settle scores none of it), so it is
// refused before anything is reserved: no record, no run.
test("a replay on fewer than REPLAY_MIN graded inputs is 409 replay_conflict: no record is reserved and no run starts", { timeout: 180_000 }, async (t) => {
  const { api, replay } = await world(t);
  const refused = await replay({ inputs: REPLAY_MIN - 3 });
  assert.deepEqual([refused.status, refused.json?.error?.code], [409, "replay_conflict"], refused.text);
  assert.match(refused.json.error.message, new RegExp(`fewer than ${REPLAY_MIN}`));
  assert.deepEqual((await api("GET", "/agents/source/learning/promotions")).body.promotions, [], "no replay reserved");
  const runs = (await api("GET", "/agents/source/runs")).body.runs;
  assert.equal(runs.length, 5, `only the graded runs: ${JSON.stringify(runs.map((one) => one.path))}`);
  // Enough of them: it starts.
  const started = await replay({ inputs: REPLAY_MIN });
  assert.deepEqual([started.status, started.json?.inputs], [202, REPLAY_MIN], started.text);
});

// The gap #2823 left: a run served under a promotion keeps that promotion (its `since`), and its grade, through the grade
// route, copies it; a run a promotion with no `since` served (a dry run's) saves none, nor does an agent's run.
test("a grade through PUT /runs/{id}/grade keeps the promotion that served the run: a replay's promotion's since, none for a dry run's or the agent's", { timeout: 240_000 }, async (t) => {
  const { api, store, main } = await world(t);
  const record = (extra) => ({ workflow: "answer", digest: DIGEST, at: new Date().toISOString(), source: "replay", reason: "r", commit: main, ...extra });
  const served = async (content) => {
    const started = await api("POST", "/agents/source/runs", { input: { content }, learning: "use" });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await follow(api, started.body.run_id, ["completed"], { deadlineMs: 60_000 });
    const grade = await api("PUT", `/runs/${started.body.run_id}/grade`, { correct: true, source: "eval" });
    assert.equal(grade.status, 200, JSON.stringify(grade.body));
    assert.deepEqual([grade.body.path, grade.body.workflow, grade.body.workflow_digest], ["workflow", "answer", DIGEST], `served by the workflow: ${JSON.stringify(grade.body)}`);
    return (await gradesOf(store.settings, "source")).find((one) => one.run === started.body.run_id);
  };
  // Promoted on its dry run: no since, so a run it serves keeps none.
  await store.settings.put("learning.promotions.source", { v: 1, items: [record({ decided: "promote", source: "dry_run" })] });
  const dry = await served("What is 7 plus 42?");
  assert.equal("promotion" in dry, false, `a promotion with no since: none kept: ${JSON.stringify(dry)}`);
  // Held, then promoted again by a replay: that promotion's since, on the run it serves and on its grade.
  const since = Math.max(...(await gradesOf(store.settings, "source")).map((one) => one.seq));
  const items = (await store.settings.get("learning.promotions.source")).items;
  await store.settings.put("learning.promotions.source", { v: 1, items: [...items, record({ decided: "hold", source: "graded", held_on: [] }), record({ decided: "promote", since })] });
  const again = await served("What is 8 plus 42?");
  assert.equal(again.promotion, since, `the grade keeps the promotion that served its run: ${JSON.stringify(again)}`);
  // The agent's runs (world's, graded through the same route): none.
  const agents = (await gradesOf(store.settings, "source")).filter((one) => one.path === "agent");
  assert.equal(agents.length, 5);
  assert.ok(agents.every((one) => !("promotion" in one)), JSON.stringify(agents));
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
