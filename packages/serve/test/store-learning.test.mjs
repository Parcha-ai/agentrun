// A run's learning, kept at its end: what its end-of-run turn kept (the turn and the proposal it made) is written in the
// SAME commit as the run's end, beside its patch, or not at all. The server's learning routes read the kept proposal by
// run, and an agent's proposals newest first.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentWithRevision, storeOn } from "./store-helpers.mjs";

const TURN = { prompt: "Compile the job.", answer: "````workflow answer\n…\n````" };
const PROPOSAL = { state: "merged", merged: "abc123", workflows: [{ file: "workflows/answer/workflow.json", name: "answer" }] };

const kept = (turn = TURN, proposal = PROPOSAL) => ({ table: "learning_proposals", row: { turn, proposal } });

async function claimedRun(store, id = "run-1") {
  if (!(await store.agents.get("agent-1"))) await agentWithRevision(store);
  await store.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" });
  return store.claim(id, "runner-a", { leaseMs: 60_000 });
}

test("the run's end writes its kept proposal in that one commit, read by its run", async (t) => {
  const { store } = await storeOn(t);
  const claim = await claimedRun(store);
  await store.runs.update(claim, { state: "ended" }, { also: [kept()] });
  const proposal = await store.learning.proposal("run-1");
  assert.deepEqual(
    proposal && { runId: proposal.runId, agentId: proposal.agentId, turn: proposal.turn, proposal: proposal.proposal },
    { runId: "run-1", agentId: "agent-1", turn: TURN, proposal: PROPOSAL },
    "the kept proposal, read by its run",
  );
  assert.deepEqual(await store.runs.claimable({ limit: 10 }), [], "nothing queued beside it");
});

test("a fenced end writes no proposal", async (t) => {
  const { store } = await storeOn(t);
  const stale = await claimedRun(store);
  await store.release(stale);
  await assert.rejects(store.runs.update(stale, { state: "ended" }, { also: [kept()] }), /Fenced|epoch/);
  assert.equal(await store.learning.proposal("run-1"), undefined, "no kept proposal");
});

test("a run that kept no proposal has none", async (t) => {
  const { store } = await storeOn(t);
  const claim = await claimedRun(store);
  await store.runs.update(claim, { state: "ended" }, { also: [] });
  assert.equal(await store.learning.proposal("run-1"), undefined);
  assert.deepEqual(await store.runs.claimable({ limit: 10 }), [], "nothing queued");
});

test("an end written again under its claim is refused, and keeps the one proposal", async (t) => {
  const { store } = await storeOn(t);
  const claim = await claimedRun(store);
  await store.runs.update(claim, { state: "ended" }, { also: [kept()] });
  // The end is the run's release (its epoch moved on in that commit): the same rows staged again under the claim (a crash
  // after the commit, the end replayed) are Fenced, and nothing new is written.
  await assert.rejects(store.runs.update(claim, {}, { also: [kept(TURN, { state: "dropped", reason: "empty" })] }), /Fenced|epoch/);
  assert.deepEqual((await store.learning.proposal("run-1"))?.proposal, PROPOSAL, "the first end's proposal stands");
});

test("an agent's kept proposals are read newest first, each with its run", async (t) => {
  const { store, clock } = await storeOn(t);
  for (const id of ["run-a", "run-b"]) {
    const claim = await claimedRun(store, id);
    await store.runs.update(claim, { state: "ended" }, { also: [kept(TURN, { ...PROPOSAL, merged: id })] });
    clock.now += 1_000;
  }
  const list = await store.learning.proposals("agent-1", { limit: 10 });
  assert.deepEqual(list.map((row) => row.runId), ["run-b", "run-a"]);
});
