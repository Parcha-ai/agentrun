// A person's stop of an agentic run ends its turn, never the run, as main's does (runs.ts statusOf: a stopped run is
// input_required and idle, and a message to it is a follow-up in the same run). The store keeps the stop as a final state,
// 'stopped', and says which stop it was in the run's outcome: 'stopped' for a person's stop, 'cancelled' for a cancel. A
// run a person stopped reopens with the person's next message (runs.reopen, or the stop's own end when the message was
// already waiting), as a completed run does; a cancelled run, a stopped workflow run, a failed run, an imported run and a
// learning run never do, and nothing of them is written. A store over another database (Postgres) runs these same cases.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentWithRevision, queued, storeOn } from "./store-helpers.mjs";

const { RunFinal, endedReason } = await import("../dist/store/index.js");

/** A person's stop and a cancel, as the run's end writes them. */
const STOPPED = { state: "stopped", summary: "stopped by a person", outcome: "stopped" };
const CANCELLED = { state: "stopped", summary: "cancelled", outcome: "cancelled" };

/** `runId` (queued first when it is not there yet) claimed and ended with `patch`. */
async function endedWith(store, runId, patch) {
  if (!(await store.runs.get(runId))) await queued(store, runId);
  await store.runs.update(await store.claim(runId, "runner-a", { leaseMs: 30_000 }), patch);
  return store.runs.get(runId);
}

/** runs.reopen of `runId` is refused in the store (RunFinal), with its row and its commands as they were. */
async function refused(store, runId, why) {
  const before = await store.runs.get(runId);
  const rows = before ? (await store.commands(runId, 0)).length : 0;
  await assert.rejects(store.runs.reopen(runId, { kind: "steer", body: { text: "Go on." } }), (e) => e instanceof RunFinal, why);
  assert.deepEqual(await store.runs.get(runId), before, `${why}: the row is as it was`);
  if (before) assert.equal((await store.commands(runId, 0)).length, rows, `${why}: no row written`);
}

/** A workflow agent's revision. */
async function workflowRevision(store) {
  await agentWithRevision(store, "agent-wf", "rev-wf");
  await store.agents.addRevision({ agentId: "agent-wf", id: "rev-wf2", kind: "workflow", body: { workflow: { name: "w", nodes: [] } } });
}

test("a person's stop and a cancel are told apart in the store: stopped, with outcome 'stopped' or 'cancelled'", async (t) => {
  const { store } = await storeOn(t);
  const stopped = await endedWith(store, "run-1", STOPPED);
  assert.deepEqual([stopped.state, stopped.outcome, stopped.summary], ["stopped", "stopped", "stopped by a person"]);
  const cancelled = await endedWith(store, "run-2", CANCELLED);
  assert.deepEqual([cancelled.state, cancelled.outcome, cancelled.summary], ["stopped", "cancelled", "cancelled"]);
});

test("runs.reopen takes an agentic run a person stopped: back to running, released and claimable, its follow-up untaken and its spend kept", async (t) => {
  const { store } = await storeOn(t);
  const stopped = await endedWith(store, "run-1", { ...STOPPED, costUsd: 0.25 });
  const steer = await store.runs.reopen("run-1", { kind: "steer", body: { text: "Go on, then." } });
  assert.equal(steer.takenAt, null, "the message waits untaken for the run's next claim");
  const reopened = await store.runs.get("run-1");
  assert.deepEqual(
    { state: reopened.state, runner: reopened.runner, endedAt: reopened.endedAt, summary: reopened.summary, outcome: reopened.outcome },
    { state: "running", runner: null, endedAt: null, summary: null, outcome: null },
    "its stop's own fields cleared",
  );
  assert.equal(reopened.epoch, stopped.epoch, "its epoch stays");
  assert.equal(reopened.costUsd, 0.25, "what it spent stays");
  assert.ok((await store.runs.claimable()).includes("run-1"), "a runner may claim it at once");
  assert.deepEqual((await store.commands("run-1", 0)).filter((row) => row.takenAt === null).map((row) => row.body), [{ text: "Go on, then." }]);
});

test("runs.reopen refuses a cancelled run: a cancel ends the run for good", async (t) => {
  const { store } = await storeOn(t);
  await endedWith(store, "run-1", CANCELLED);
  await refused(store, "run-1", "a cancelled run");
});

test("runs.reopen refuses a workflow run a person stopped", async (t) => {
  const { store } = await storeOn(t);
  await workflowRevision(store);
  await store.runs.create({ id: "run-wf", agentId: "agent-wf", revisionId: "rev-wf2" });
  await endedWith(store, "run-wf", STOPPED);
  await refused(store, "run-wf", "a stopped workflow run");
});

test("runs.reopen refuses a failed run", async (t) => {
  const { store } = await storeOn(t);
  await endedWith(store, "run-1", { state: "failed", summary: "it broke" });
  await refused(store, "run-1", "a failed run");
});

test("runs.reopen refuses an imported run, even one that reads stopped by a person", async (t) => {
  const { store } = await storeOn(t);
  await agentWithRevision(store);
  await store.importRun({
    id: "run-imported", agentId: "agent-1", revisionId: "rev-1", importedFrom: { source: "claude-code", session: "s1" },
    launch: { body: { input: { content: "hi" }, title: "t", place: { mode: "runner" } } }, state: "stopped", outcome: "stopped", startedAt: Date.now(), transcript: [],
  });
  await refused(store, "run-imported", "an imported run");
});

test("runs.reopen refuses a learning run a person stopped", async (t) => {
  const { store } = await storeOn(t);
  await agentWithRevision(store);
  await store.runs.create({ id: "run-learning", agentId: "agent-1", revisionId: "rev-1" }, { body: { harness: "learning", input: { runId: "run-0" }, title: "Learning from run-0", place: { mode: "runner" } } });
  await endedWith(store, "run-learning", STOPPED);
  await refused(store, "run-learning", "a learning run");
});

test("runs.reopen refuses a run a person's stop has not ended (a drain or a shutdown leaves it running, for its next claim to resume)", async (t) => {
  const { store } = await storeOn(t);
  await queued(store);
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 30_000 });
  // A drain's let-go: the claim released with the run still running, no end and no outcome written.
  await store.release(claim, {});
  const row = await store.runs.get("run-1");
  assert.deepEqual([row.state, row.outcome], ["running", null]);
  await refused(store, "run-1", "a run a drain let go");
  const steer = await store.command("run-1", { kind: "steer", body: { text: "Go on." } });
  assert.equal(steer.takenAt, null, "its message goes in as any running run's, for its next claim");
});

test("a person's message waiting when a person's stop ends the run opens it again in that end's commit; one waiting at a cancel is refused", async (t) => {
  const { store } = await storeOn(t);
  await queued(store);
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 30_000 });
  const message = await store.command("run-1", { kind: "steer", body: { text: "Also this." } });
  const raise = await store.command("run-1", { kind: "raise", body: { capUsd: 5 } });
  await store.runs.update(claim, STOPPED);
  const row = await store.runs.get("run-1");
  assert.deepEqual({ state: row.state, runner: row.runner, endedAt: row.endedAt, outcome: row.outcome }, { state: "running", runner: null, endedAt: null, outcome: null }, "opened again in the stop's commit");
  const rows = await store.commands("run-1", 0);
  assert.equal(rows.find((one) => one.id === message.id).takenAt, null, "the message waits for the next claim, which runs it as a new turn");
  assert.equal(rows.find((one) => one.id === raise.id).refused, endedReason("stopped"), "the run's other leftovers are refused as before");

  await queued(store, "run-2");
  const second = await store.claim("run-2", "runner-a", { leaseMs: 30_000 });
  const late = await store.command("run-2", { kind: "steer", body: { text: "too late" } });
  await store.runs.update(second, CANCELLED);
  assert.deepEqual([(await store.runs.get("run-2")).state, (await store.runs.get("run-2")).outcome], ["stopped", "cancelled"], "a cancel stays final");
  assert.equal((await store.commands("run-2", 0)).find((one) => one.id === late.id).refused, endedReason("stopped"), "its waiting message is refused");
});
