// A run's learning, handed on at its end: what its end-of-run turn kept (the turn and the proposal it made) and the learning
// run that grades and merges it are written in the SAME commit as the run's end, beside its patch, or neither is. The
// learning run is an ordinary queued run of the same agent and revision, so any runner claims it. The server's learning
// routes read the kept proposal by run, and an agent's proposals newest first.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentWithRevision, storeOn } from "./store-helpers.mjs";

const TURN = { prompt: "What did you learn?", answer: "```note retries.md\n…\n```" };
const PROPOSAL = { notes: [{ file: "retries.md", text: "Retry twice." }] };

const kept = (turn = TURN, proposal = PROPOSAL) => ({ table: "learning_proposals", row: { turn, proposal } });
const learningRun = (id) => ({ table: "learning_run", row: { id } });

async function claimedRun(store, id = "run-1") {
  if (!(await store.agents.get("agent-1"))) await agentWithRevision(store);
  await store.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" });
  return store.claim(id, "runner-a", { leaseMs: 60_000 });
}

test("the run's end writes its kept proposal and a queued learning run of the same agent and revision, in that one commit", async (t) => {
  const { store } = await storeOn(t);
  const claim = await claimedRun(store);
  await store.runs.update(claim, { state: "ended" }, { also: [kept(), learningRun("run-1-learning")] });
  const proposal = await store.learning.proposal("run-1");
  assert.deepEqual(
    proposal && { runId: proposal.runId, agentId: proposal.agentId, turn: proposal.turn, proposal: proposal.proposal },
    { runId: "run-1", agentId: "agent-1", turn: TURN, proposal: PROPOSAL },
    "the kept proposal, read by its run",
  );
  const learning = await store.runs.get("run-1-learning");
  assert.deepEqual(learning && [learning.agentId, learning.revisionId, learning.state], ["agent-1", "rev-1", "queued"], "a queued learning run of the run's agent and revision");
  assert.ok((await store.runs.claimable({ limit: 10 })).includes("run-1-learning"), "claimable by any runner");
  // Its launch row, in the same commit: harness "learning", its input the run that learned (the runner reads it at claim).
  const launch = await store.runs.launch("run-1-learning");
  assert.deepEqual([launch.body.harness, launch.body.input], ["learning", { runId: "run-1" }]);
});

test("the kept proposal names the learning run queued with it, whichever order the end lists them in; a drop names none", async (t) => {
  const { store } = await storeOn(t);
  await store.runs.update(await claimedRun(store, "run-a"), { state: "ended" }, { also: [kept(), learningRun("run-a-learning")] });
  await store.runs.update(await claimedRun(store, "run-b"), { state: "ended" }, { also: [learningRun("run-b-learning"), kept()] });
  await store.runs.update(await claimedRun(store, "run-c"), { state: "ended" }, { also: [kept(TURN, { state: "dropped", reason: "empty" })] });
  assert.deepEqual(
    await Promise.all(["run-a", "run-b", "run-c"].map(async (id) => (await store.learning.proposal(id))?.learningRunId)),
    ["run-a-learning", "run-b-learning", undefined],
  );
  assert.deepEqual((await store.learning.proposals("agent-1")).map((one) => [one.runId, one.learningRunId]).sort(), [["run-a", "run-a-learning"], ["run-b", "run-b-learning"], ["run-c", undefined]]);
});

test("a fenced end writes neither the proposal nor the learning run", async (t) => {
  const { store } = await storeOn(t);
  const stale = await claimedRun(store);
  await store.release(stale);
  await assert.rejects(store.runs.update(stale, { state: "ended" }, { also: [kept(), learningRun("run-1-learning")] }), /Fenced|epoch/);
  assert.equal(await store.learning.proposal("run-1"), undefined, "no kept proposal");
  assert.equal(await store.runs.get("run-1-learning"), undefined, "no learning run");
});

test("a run that kept no proposal starts no learning run", async (t) => {
  const { store } = await storeOn(t);
  const claim = await claimedRun(store);
  await store.runs.update(claim, { state: "ended" }, { also: [] });
  assert.equal(await store.learning.proposal("run-1"), undefined);
  assert.deepEqual(await store.runs.claimable({ limit: 10 }), [], "nothing queued");
});

test("a learning run is started once: the same end written again under its claim is refused, and adds no second one", async (t) => {
  const { store } = await storeOn(t);
  const claim = await claimedRun(store);
  await store.runs.update(claim, { state: "ended" }, { also: [kept(), learningRun("run-1-learning")] });
  // The end is the run's release (its epoch moved on in that commit): the same rows staged again under the claim (a crash
  // after the commit, the end replayed) are Fenced, and nothing new is written.
  await assert.rejects(store.runs.update(claim, {}, { also: [kept(), learningRun("run-1-learning")] }), /Fenced|epoch/);
  const rows = (await store.runs.claimable({ limit: 10 })).filter((id) => id.startsWith("run-1-learning"));
  assert.equal(rows.length, 1, "one learning run");
  assert.equal((await store.runs.launch("run-1-learning")).body.harness, "learning", "and one launch row, kept");
});

test("an agent's kept proposals are read newest first, each with its run", async (t) => {
  const { store, clock } = await storeOn(t);
  for (const id of ["run-a", "run-b"]) {
    const claim = await claimedRun(store, id);
    await store.runs.update(claim, { state: "ended" }, { also: [kept(TURN, { notes: [{ file: `${id}.md`, text: id }] })] });
    clock.now += 1_000;
  }
  const list = await store.learning.proposals("agent-1", { limit: 10 });
  assert.deepEqual(list.map((row) => row.runId), ["run-b", "run-a"]);
});

test("a learning run is no run of a person's: runs.list never names it, by agent, by state or within a limit, though it reads by its id", async (t) => {
  const { store } = await storeOn(t);
  await store.runs.update(await claimedRun(store), { state: "ended" }, { also: [kept(), learningRun("run-1-learning")] });
  for (const filter of [{}, { agentId: "agent-1" }, { revisionId: "rev-1" }, { state: "queued" }, { limit: 10 }, { archived: false }]) {
    assert.deepEqual((await store.runs.list(filter)).map((run) => run.id).filter((id) => id !== "run-1"), [], JSON.stringify(filter));
  }
  assert.deepEqual((await store.runs.list({})).map((run) => run.id), ["run-1"], "the run that learned is listed");
  assert.equal((await store.runs.get("run-1-learning"))?.state, "queued", "the learning run reads by its id");
});

test("what learning spent reads in one call over a window: a learning dropped before it was proposed costs 0 when it was kept; a proposal costs its learning run's cost when that run ended or failed, null kept unknown; one still waiting is none", async (t) => {
  const { store, clock } = await storeOn(t);
  // run-a: dropped before it was proposed. run-b: proposed, its learning run ended with the grade's spend on its row.
  // run-c: proposed, its learning run failed with the grade's spend unknown. run-d: proposed, its learning run still queued.
  await store.runs.update(await claimedRun(store, "run-a"), { state: "ended" }, { also: [kept(TURN, { state: "dropped", reason: "empty" })] });
  for (const id of ["run-b", "run-c", "run-d"]) await store.runs.update(await claimedRun(store, id), { state: "ended" }, { also: [kept(TURN, { state: "proposed", proposal: PROPOSAL }), learningRun(`${id}-learning`)] });
  clock.now += 60_000;
  await store.runs.update(await store.claim("run-b-learning", "runner-a", { leaseMs: 60_000 }), { state: "ended", costUsd: 0.25 });
  await store.runs.update(await store.claim("run-c-learning", "runner-a", { leaseMs: 60_000 }), { state: "failed", costUsd: null });
  // Each time as the store kept it (the test's clock on SQLite, the database's on Postgres).
  const at = { a: (await store.learning.proposal("run-a")).createdAt, b: (await store.runs.get("run-b-learning")).endedAt, c: (await store.runs.get("run-c-learning")).endedAt };
  assert.ok(typeof at.b === "number" && typeof at.c === "number" && at.a < at.b, JSON.stringify(at));
  const seen = (list) => list.map((one) => [one.agentId, one.at, one.costUsd]).sort((x, y) => x[1] - y[1] || String(x[2]).localeCompare(String(y[2])));
  const want = [["agent-1", at.a, 0], ["agent-1", at.b, 0.25], ["agent-1", at.c, null]].sort((x, y) => x[1] - y[1] || String(x[2]).localeCompare(String(y[2])));
  assert.deepEqual(seen(await store.learning.spend({ from: 0, to: Number.MAX_SAFE_INTEGER })), want, "run-d, still waiting for its grade, is none");
  // The window is [from, to): a learning that ended at `to` is out of it, one at `from` in.
  const before = await store.learning.spend({ from: 0, to: at.b });
  assert.deepEqual(seen(before), want.filter(([, when]) => when < at.b));
  const from = await store.learning.spend({ from: at.b, to: Number.MAX_SAFE_INTEGER });
  assert.deepEqual(seen(from), want.filter(([, when]) => when >= at.b));
});
