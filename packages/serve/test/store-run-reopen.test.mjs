// runs.reopen: a person's follow-up to a run that ended completed, in one transaction with the follow-up's steer row. The
// run goes back to running with no runner (released: a runner claims it at once), its end's own fields cleared, and
// everything it did kept: its epoch, its cost and metrics (its next turn is booked on what it spent). Only an agentic run
// that ended completed reopens; a workflow run, a failed, stopped or cancelled one, an imported one, a learning run and an
// unknown one are refused in the store (RunFinal), and nothing is written. A store over another database (Postgres) runs
// this same case.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentWithRevision, queued, storeOn } from "./store-helpers.mjs";

const { RunFinal } = await import("../dist/store/index.js");

test("runs.reopen puts a completed agentic run back to running, released and claimable, with its follow-up untaken and its spend kept; every other run is refused in the store", async (t) => {
  const { store } = await storeOn(t);
  await queued(store);
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 30_000 });
  await store.runs.update(claim, { state: "ended", summary: "The first answer.", costUsd: 0.25 });
  const ended = await store.runs.get("run-1");
  assert.equal(ended.state, "ended");

  const steer = await store.runs.reopen("run-1", { kind: "steer", body: { text: "And one more thing." } });
  assert.equal(steer.kind, "steer");
  assert.equal(steer.takenAt, null, "the follow-up waits untaken for the run's next claim");
  const reopened = await store.runs.get("run-1");
  assert.deepEqual({ state: reopened.state, runner: reopened.runner, endedAt: reopened.endedAt, summary: reopened.summary, outcome: reopened.outcome }, { state: "running", runner: null, endedAt: null, summary: null, outcome: null });
  assert.equal(reopened.epoch, ended.epoch, "its epoch stays");
  assert.equal(reopened.costUsd, 0.25, "what it spent stays: its next turn is booked on top");
  assert.ok((await store.runs.claimable()).includes("run-1"), "a runner may claim it at once");
  assert.deepEqual((await store.commands("run-1", 0)).filter((row) => row.takenAt === null).map((row) => row.body), [{ text: "And one more thing." }]);
  const again = await store.claim("run-1", "runner-b", { leaseMs: 30_000 });
  assert.ok(again && again.epoch > ended.epoch, "claimed at the next epoch");

  // Refused in the store, each with nothing written: a run still going, failed, stopped, a workflow's, an imported one, a
  // learning run, and none.
  const refused = async (runId, why) => {
    const before = await store.runs.get(runId);
    const rows = before ? (await store.commands(runId, 0)).length : 0;
    await assert.rejects(store.runs.reopen(runId, { kind: "steer", body: { text: "x" } }), (e) => e instanceof RunFinal, why);
    assert.deepEqual(await store.runs.get(runId), before, `${why}: the row is as it was`);
    if (before) assert.equal((await store.commands(runId, 0)).length, rows, `${why}: no row written`);
  };
  await refused("run-1", "a run that is running again");
  for (const [id, patch] of [["run-failed", { state: "failed", summary: "it broke" }], ["run-stopped", { state: "stopped", summary: "stopped by a person" }]]) {
    await queued(store, id);
    await store.runs.update(await store.claim(id, "runner-a", { leaseMs: 30_000 }), patch);
    await refused(id, `a ${patch.state} run`);
  }
  await agentWithRevision(store, "agent-wf", "rev-wf");
  await store.agents.addRevision({ agentId: "agent-wf", id: "rev-wf2", kind: "workflow", body: { workflow: { name: "w", nodes: [] } } });
  await store.runs.create({ id: "run-workflow", agentId: "agent-wf", revisionId: "rev-wf2" });
  await store.runs.update(await store.claim("run-workflow", "runner-a", { leaseMs: 30_000 }), { state: "ended" });
  await refused("run-workflow", "a completed workflow run");
  await store.runs.create({ id: "run-learning", agentId: "agent-1", revisionId: "rev-1" }, { body: { harness: "learning", input: { runId: "run-1" }, title: "Learning from run-1", place: { mode: "runner" } } });
  await store.runs.update(await store.claim("run-learning", "runner-a", { leaseMs: 30_000 }), { state: "ended" });
  await refused("run-learning", "a learning run");
  await refused("run-none", "no such run");
});
