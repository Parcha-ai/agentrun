// DELETE /v2/agents/{agent_id}/learning: an agent's learning reset, the agent kept (learning-reset.ts). Everything it
// learned goes (its learning folder whole, its promotions and grades), and from then on nothing learned is served: the
// next run takes the agent path. The agent, its runs and what they kept stay: the run list, the run count, GET /stats and
// GET /usage read the same before and after. Its learning-only work in flight (a check's replay, an audit's shadow) is
// cancelled and waited for; a run of its own still going, or learning work not ended in time, is 409 learning_busy and
// nothing is deleted. 204 when done, again on a second call and for an agent that never learned. Both profiles route it,
// with the token as the other learning writes take it.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { agentFolderOf } from "../dist/files.js";
import { deleteLearning } from "../dist/learn/delete.js";
import { gradesKey, promotionsKey, resetLedgerKey } from "../dist/learn/promote.js";
import { learningFolderOf, seedOf } from "../dist/learning.js";
import { git, resnap } from "./learn-support.mjs";
import { agent, follow, serve, withEnv } from "./support.mjs";

const { ROUTES } = await import("../dist/server.js");
const { API_ONLY_ROUTES } = await import("../dist/api-only.js");

/** The faux model at $100 per million output tokens: a served workflow's model node and the agent's turns both cost. */
const PRICED = new URL("./fixtures/faux-workflow-priced.mjs", import.meta.url).pathname;
/** A learned workflow on the agent's own input (`content`): one model node answers a number (learn-audit-api.test.mjs). */
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
const CORRECTION = "- Six times seven is 42.\n";
const ASK = { content: "What is 1 plus 41?" };
const FINAL = ["ended", "stopped", "failed"];

const learningDir = (data, id) => join(agentFolderOf(data, id), "learning");

/** Agent `id`'s learning, as runs and a check leave it: corrections.md and the `answer` workflow on its folder's main,
 *  the workflow promoted by its check, and a grade. Answers main's commit. */
async function learned(store, data, id) {
  await seedOf(data, id);
  const repo = learningDir(data, id);
  const files = { "corrections.md": CORRECTION, "workflows/answer/workflow.json": TEXT, "workflows/answer/README.md": "---\nname: answer\ndescription: Answers a question as a number; use when the person asks for the answer\n---\n" };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(repo, ["add", "--", ...Object.keys(files)]);
  git(repo, ["commit", "-q", "-m", "learned"]);
  await resnap(data, id);
  const main = git(repo, ["rev-parse", "main"]);
  await store.settings.put(promotionsKey(id), { v: 1, items: [{ workflow: "answer", digest: DIGEST, at: new Date().toISOString(), decided: "promote", reason: "checked: promoted", check: { compile_after: 5, agree_min: 0.8, alone_min: 0.7, attempt: 1, n: 5, agreed: 5, alone: 5, of: [] }, commit: main }] });
  await store.settings.put(gradesKey(id), { r1: { correct: true } });
  return main;
}

/** The agent's learning records still in the store. */
async function recordsOf(store, id) {
  const left = [];
  for (const key of [promotionsKey(id), gradesKey(id)]) if ((await store.settings.get(key)) !== undefined) left.push(key);
  return left;
}

/** Every run of agent `id` final (its learning end, an audit's shadow among them). */
async function quiet(store, id, deadlineMs = 90_000) {
  const end = Date.now() + deadlineMs;
  for (;;) {
    const going = (await store.runs.every(id)).filter((run) => !FINAL.includes(run.state));
    if (!going.length) return;
    assert.ok(Date.now() < end, `runs still going: ${JSON.stringify(going.map((run) => [run.id, run.state]))}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** A run of agent `id` the store holds, queued, its launch `body`: a stand-in for a run the server started. */
async function storedRun(store, id, runId, body) {
  const revisionId = (await store.agents.get(id)).currentRevision;
  await store.runs.create({ id: runId, agentId: id, revisionId }, { body });
  return runId;
}

/** Run `runId` ended `state` as a runner ends it: claimed, then its end written (these servers have no runner). */
async function endAsRunner(store, runId, state) {
  const claim = await store.claim(runId, "runner-test", { leaseMs: 60_000 });
  assert.ok(claim, `${runId} claimed`);
  await store.runs.update(claim, { state });
}

/** A read without the time it was read at. */
const untimed = ({ to: _to, ...rest }) => rest;

test("both profiles route DELETE /agents/{id}/learning, and its document is the operation's", () => {
  const route = ROUTES.find((one) => one.name === "deleteAgentLearning");
  assert.ok(route, "a route of the server");
  assert.equal(route.method, "DELETE");
  assert.match("/agents/a1/learning", route.pattern);
  assert.doesNotMatch("/agents/a1/learning/cost", route.pattern);
  assert.ok(API_ONLY_ROUTES.has("deleteAgentLearning"), "served in the API-only profile");
});

test("a reset after a learned workflow served: nothing learned is left or served (the next run takes the agent path), and the agent, its runs, the run count, /stats and /usage are as they were", { timeout: 300_000 }, async (t) => {
  withEnv(t, {}, ["AGENTRUN_TEST_FAUX_GRADE_HOLD", "AGENTRUN_TEST_FAUX_CALLS", "TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "AGENT_MODEL_STRONG", "AGENTRUN_SERVE_GRADE_MODEL"]);
  const { api, data, store } = await serve(t, { learning: "on", faux: PRICED, runnerTiming: { leaseMs: 600_000, renewEveryMs: 10_000 } });
  assert.equal((await api("POST", "/agents", agent("source", { learning: { audit_every: 1_000 } }))).status, 201);
  await learned(store, data, "source");
  const run = async () => {
    const started = await api("POST", "/agents/source/runs", { input: ASK, learning: "use" });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await follow(api, started.body.run_id, ["completed", "failed", "escalated"], { deadlineMs: 90_000 });
    await quiet(store, "source");
    return started.body.run_id;
  };
  const served = await run();
  assert.equal((await store.runs.get(served)).metrics?.path, "workflow", "the learned workflow served it");
  assert.match((await api("GET", "/agents/source/learning")).body.corrections, /42/);

  const reads = async () => {
    const list = (await api("GET", "/agents/source/runs")).body;
    const all = (await api("GET", "/runs")).body;
    const view = (await api("GET", `/runs/${served}`)).body;
    const files = (await api("GET", `/runs/${served}/files`)).body;
    return {
      list: list.runs.map((row) => [row.run_id, row.status]), all: all.runs.map((row) => [row.run_id, row.status]),
      count: (await store.runs.every("source")).length,
      // `to`: the window's end, the time of the read.
      stats: untimed((await api("GET", "/stats")).body), usage: untimed((await api("GET", "/usage")).body),
      view: { status: view.status, path: view.path, cost: view.cost, answer: view.result?.final_answer }, files,
    };
  };
  const before = await reads();

  const reset = await api("DELETE", "/agents/source/learning");
  assert.equal(reset.status, 204, JSON.stringify(reset.body));
  const view = (await api("GET", "/agents/source/learning")).body;
  assert.deepEqual([view.main, view.corrections, view.workflows], [null, "", []], `nothing learned is left: ${JSON.stringify(view)}`);
  assert.deepEqual(await recordsOf(store, "source"), [], "no promotion or grade record");
  assert.ok(!existsSync(join(learningDir(data, "source"), "corrections.md")), "the folder's files gone");
  assert.equal((await api("GET", "/agents/source")).status, 200, "the agent is kept");
  assert.deepEqual(await reads(), before, "its runs, their count, the stats and the usage are as they were");

  const next = await run();
  const row = await store.runs.get(next);
  assert.equal(row.metrics?.path, "agent", `nothing learned is served: ${JSON.stringify(row.metrics)}`);
  const launch = (await store.runs.launch(next)).body;
  assert.ok(!launch.learning?.workflows?.length, `no workflow started with: ${JSON.stringify(launch.learning)}`);
  assert.doesNotMatch(launch.learning?.section ?? "", /42/, "no correction of before");
});

test("a served run's cost keeps its share of its revision's paid check after the reset (the reset ledger), as do the bill's booked total and what no run carries; an agent delete's learning step removes the ledger", async (t) => {
  const { api, data, store } = await serve(t, { learning: "on", runner: false });
  assert.equal((await api("POST", "/agents", agent("paid", { learning: true }))).status, 201);
  const revisionId = (await store.agents.get("paid")).currentRevision;
  const LEARNS = { input: ASK, title: "t", place: { mode: "runner" }, learning: { given: [], seed: "a".repeat(40), section: "", seedNotes: 0 } };
  // The check: two replays of `answer` at its digest, $0.30 each; then two runs it served at $0.10, K = 2.
  const ended = async (id, cost, metrics, body = LEARNS) => {
    await store.runs.create({ id, agentId: "paid", revisionId }, { body });
    const claim = await store.claim(id, "runner-cost", { leaseMs: 60_000 });
    await store.runs.update(claim, { state: "ended", costUsd: cost, metrics });
  };
  for (const id of ["replay-a", "replay-b"]) await ended(id, 0.3, { path: "replay", workflow: "answer", workflow_digest: DIGEST, replay: { of: "run-of-before", outcome: "answered" } }, { ...LEARNS, replay: { of: "run-of-before", workflow: "answer", digest: DIGEST } });
  for (const id of ["served-a", "served-b"]) await ended(id, 0.1, { path: "workflow", workflow: "answer", workflow_digest: DIGEST });
  await store.settings.put(promotionsKey("paid"), { v: 1, items: [{ workflow: "answer", digest: DIGEST, at: new Date().toISOString(), decided: "promote", reason: "checked: promoted", check: { compile_after: 2, agree_min: 0.8, alone_min: 0.7, attempt: 1, n: 2, agreed: 2, alone: 2, of: [] } }] });

  const costs = async () => ({
    runs: Object.fromEntries(await Promise.all(["served-a", "served-b", "replay-a"].map(async (id) => [id, (await api("GET", `/runs/${id}`)).body.cost]))),
    bill: await api("GET", "/agents/paid/learning/cost").then(({ body }) => [body.bill?.booked_usd, body.bill?.unattributed_usd]),
  });
  const before = await costs();
  assert.equal(before.runs["served-a"].learning_usd, 0.3, `its share of the $0.60 check over K = 2: ${JSON.stringify(before)}`);
  const reset = await api("DELETE", "/agents/paid/learning");
  assert.equal(reset.status, 204, JSON.stringify(reset.body));
  assert.deepEqual(await recordsOf(store, "paid"), [], "the records are gone");
  assert.deepEqual(await costs(), before, "each run's cost and the bill read as before");
  assert.deepEqual((await store.settings.get(resetLedgerKey("paid")))?.items, [{ workflow: "answer", digest: DIGEST, k: 2 }], "the revision's workflow, digest and K alone");
  // A second reset keeps it as it is.
  assert.equal((await api("DELETE", "/agents/paid/learning")).status, 204);
  assert.deepEqual(await costs(), before);
  await deleteLearning(store, "paid", learningFolderOf(data, "paid"));
  assert.equal(await store.settings.get(resetLedgerKey("paid")), undefined, "the agent's delete removes it");
});

test("an agent that never learned: 204, and 204 again; an unknown agent is 404; without the token it is 401, as a learning write is", async (t) => {
  const { api, baseUrl, store } = await serve(t, { learning: "on", runner: false });
  assert.equal((await api("POST", "/agents", agent("fresh", { learning: true }))).status, 201);
  for (const time of ["first", "second"]) {
    const done = await api("DELETE", "/agents/fresh/learning");
    assert.equal(done.status, 204, `${time}: ${JSON.stringify(done.body)}`);
  }
  assert.deepEqual(await recordsOf(store, "fresh"), []);
  const unknown = await api("DELETE", "/agents/nobody/learning");
  assert.deepEqual([unknown.status, unknown.body.error?.code], [404, "not_found"], JSON.stringify(unknown.body));
  const bare = await fetch(`${baseUrl}/agents/fresh/learning`, { method: "DELETE" });
  const sibling = await fetch(`${baseUrl}/agents/fresh/learning/corrections`, { method: "PUT", headers: { "content-type": "text/plain" }, body: "- x\n" });
  assert.deepEqual([bare.status, (await bare.json()).error?.code], [sibling.status, (await sibling.json()).error?.code], "refused as PUT corrections is");
  assert.equal(bare.status, 401);
});

test("a run of the agent's own still going: 409 learning_busy naming it, the run left going and nothing of the learning deleted; once it ended, 204", async (t) => {
  const { api, data, store } = await serve(t, { learning: "on", runner: false });
  assert.equal((await api("POST", "/agents", agent("busy", { learning: true }))).status, 201);
  const main = await learned(store, data, "busy");
  const started = await api("POST", "/agents/busy/runs", { input: ASK });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;

  const refused = await api("DELETE", "/agents/busy/learning");
  assert.deepEqual([refused.status, refused.body.error?.code, refused.body.error?.retryable], [409, "learning_busy", true], JSON.stringify(refused.body));
  assert.deepEqual(refused.body.error.details?.runs, [runId], "the run named");
  assert.equal((await store.runs.get(runId)).state, "queued", "the owner's run is not cancelled");
  assert.equal((await api("GET", "/agents/busy/learning")).body.main, main, "the folder as it was");
  assert.equal((await recordsOf(store, "busy")).length, 2, "the records kept");

  assert.deepEqual(await store.commands(runId, 0), [], "nor sent a cancel");
  await endAsRunner(store, runId, "ended");
  const done = await api("DELETE", "/agents/busy/learning");
  assert.equal(done.status, 204, JSON.stringify(done.body));
  assert.deepEqual(await recordsOf(store, "busy"), []);
  assert.equal((await api("GET", "/agents/busy/learning")).body.main, null);
});

test("a check's replay in flight is cancelled and waited for, then the learning deleted: 204", async (t) => {
  const { api, data, store } = await serve(t, { learning: "on", runner: false });
  assert.equal((await api("POST", "/agents", agent("checking", { learning: true }))).status, 201);
  const main = await learned(store, data, "checking");
  const replay = await storedRun(store, "checking", "replay-1", { input: ASK, title: "t", place: { mode: "runner" }, replay: { of: "run-of-before", workflow: "answer", digest: DIGEST } });

  const reset = api("DELETE", "/agents/checking/learning");
  // The cancel is the run's command; while the run has not ended, nothing of the learning is deleted. The runner takes
  // the cancel and stops the run, as this test does in its place.
  const end = Date.now() + 30_000;
  while (!(await store.commands(replay, 0)).some((command) => command.kind === "cancel")) {
    assert.ok(Date.now() < end, "a cancel sent to the replay");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal((await api("GET", "/agents/checking/learning")).body.main, main, "nothing deleted while the replay goes");
  await endAsRunner(store, replay, "stopped");
  const done = await reset;
  assert.equal(done.status, 204, JSON.stringify(done.body));
  assert.deepEqual(await recordsOf(store, "checking"), []);
  assert.equal((await api("GET", "/agents/checking/learning")).body.main, null);
});

test("a check's replay that has not ended by the wait's end: 409 learning_busy naming it, nothing of the learning deleted", async (t) => {
  const { api, data, store } = await serve(t, { learning: "on", runner: false, agentDeleteWaitMs: 300 });
  assert.equal((await api("POST", "/agents", agent("stuck", { learning: true }))).status, 201);
  const main = await learned(store, data, "stuck");
  const replay = await storedRun(store, "stuck", "replay-2", { input: ASK, title: "t", place: { mode: "runner" }, replay: { of: "run-of-before", workflow: "answer", digest: DIGEST } });
  // A runner holds it: its cancel stands, but only the runner ends it, and none is here.
  const claim = await store.claim(replay, "runner-a", { leaseMs: 60_000 });
  assert.ok(claim, "claimed");

  const refused = await api("DELETE", "/agents/stuck/learning");
  assert.deepEqual([refused.status, refused.body.error?.code], [409, "learning_busy"], JSON.stringify(refused.body));
  assert.deepEqual(refused.body.error.details?.runs, [replay]);
  assert.equal((await api("GET", "/agents/stuck/learning")).body.main, main, "the folder as it was");
  assert.equal((await recordsOf(store, "stuck")).length, 2, "the records kept");
});

test("the API-only profile serves it with the token: 409 while the agent's inline run is going, 401 without the token, 204 once it ended and again; an unknown agent is the route's own 404", async (t) => {
  const server = await serve(t, { apiOnly: true, runner: false });
  const send = async (method, path, { token = true, body } = {}) => {
    const res = await fetch(`${server.url}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${server.token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };
  const inline = await send("POST", "/v2/runs", { body: { external: { source: "host", kind: "expert", id: "9", version: 1 }, definition: { name: "Expert 9", instructions: "Answer.", skills: [], tools: [] }, input: { content: "Hi" } } });
  assert.equal(inline.status, 202, JSON.stringify(inline.body));
  const { agent_id: agentId, run_id: runId } = inline.body;

  const busy = await send("DELETE", `/v2/agents/${agentId}/learning`);
  assert.deepEqual([busy.status, busy.body?.error?.code, busy.body?.error?.details?.runs], [409, "learning_busy", [runId]], JSON.stringify(busy.body));
  assert.equal((await send("DELETE", `/v2/agents/${agentId}/learning`, { token: false })).status, 401);
  await endAsRunner(server.store, runId, "ended");
  for (const time of ["first", "second"]) assert.equal((await send("DELETE", `/v2/agents/${agentId}/learning`)).status, 204, time);
  const unknown = await send("DELETE", "/v2/agents/agent_missing/learning");
  assert.equal(unknown.status, 404);
  assert.ok(!unknown.body.error.message.includes("AGENTRUN_API_ONLY"), "the route's own, not the profile's");
});
