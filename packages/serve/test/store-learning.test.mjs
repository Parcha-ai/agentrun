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

test("a learning run is started once: the same end written again by a resumed claim adds no second one", async (t) => {
  const { store } = await storeOn(t);
  const claim = await claimedRun(store);
  await store.runs.update(claim, { state: "ended" }, { also: [kept(), learningRun("run-1-learning")] });
  // The same rows staged again (a crash after the commit, the end replayed): nothing new, no error.
  await store.runs.update(claim, {}, { also: [kept(), learningRun("run-1-learning")] });
  const rows = (await store.runs.claimable({ limit: 10 })).filter((id) => id.startsWith("run-1-learning"));
  assert.equal(rows.length, 1, "one learning run");
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
