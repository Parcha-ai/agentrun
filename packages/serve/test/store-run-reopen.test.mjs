// runs.reopen: a person's follow-up to a run that ended completed, in one transaction with the follow-up's steer row. The
// run goes back to running with no runner (released: a runner claims it at once), its end's own fields cleared, and
// everything it did kept: its epoch, its cost and metrics (its next turn is booked on what it spent). Only an agentic run
// that ended completed reopens; a workflow run, a failed, stopped or cancelled one, an imported one, a learning run and an
// unknown one are refused in the store (RunFinal), and nothing is written. A store over another database (Postgres) runs
// this same case.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentWithRevision, queued, storeOn } from "./store-helpers.mjs";
import { raw } from "./store-target.mjs";

/** A test-only log of every write of a run's state, in the store at `file` (either database): a row trigger appends the
 *  new state and whether ended_at is set. Read back with `writes(runId)`. */
async function stateLog(t, file) {
  const db = await raw(file);
  t.after(() => db.close().catch(() => undefined));
  if (db.kind === "sqlite") {
    await db.exec("CREATE TABLE test_state_log (n INTEGER PRIMARY KEY, run_id TEXT, state TEXT, ended_at INTEGER)");
    await db.exec("CREATE TRIGGER test_state_log_t AFTER UPDATE OF state ON runs BEGIN INSERT INTO test_state_log (run_id, state, ended_at) VALUES (NEW.id, NEW.state, NEW.ended_at); END");
  } else {
    await db.exec(`CREATE TABLE test_state_log (n BIGSERIAL PRIMARY KEY, run_id TEXT, state TEXT, ended_at BIGINT);
      CREATE FUNCTION test_state_log_f() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO test_state_log (run_id, state, ended_at) VALUES (NEW.id, NEW.state, NEW.ended_at); RETURN NEW; END $$;
      CREATE TRIGGER test_state_log_t AFTER UPDATE OF state ON runs FOR EACH ROW EXECUTE FUNCTION test_state_log_f()`);
  }
  return { writes: async (runId) => (await db.all("SELECT state, ended_at FROM test_state_log WHERE run_id = ? ORDER BY n", runId)).map((one) => [one.state, one.ended_at !== null]) };
}

const { RunFinal, endedReason } = await import("../dist/store/index.js");

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

test("a person's message racing a completed run's end lands on exactly one path: in before the end, the end opens the run again with it; after the end, a new row is refused and runs.reopen takes it", async (t) => {
  const { store, file } = await storeOn(t);
  // Every write of a run's state, as a row trigger sees it (a test-only log in the store, on either database): the end's
  // final write must be one of them, its ended_at set, before the reopen's, so what follows a run's changes tells its end
  // (run.ended, its marker the end's ended_at) as main does before it opens the run again (runs.ts reopen: the end's
  // run.ended first).
  const log = await stateLog(t, file);
  // In before the end: the message waits untaken at the end commit, which opens the run again with it (main's: a message
  // that waited for the end opens the completed run again), its other leftovers refused as before.
  await queued(store);
  const first = await store.claim("run-1", "runner-a", { leaseMs: 30_000 });
  const message = await store.command("run-1", { kind: "steer", body: { text: "Also this." } });
  const raise = await store.command("run-1", { kind: "raise", body: { capUsd: 5 } });
  await store.runs.update(first, { state: "ended", summary: "The first answer." });
  const row = await store.runs.get("run-1");
  assert.deepEqual({ state: row.state, runner: row.runner, endedAt: row.endedAt, summary: row.summary }, { state: "running", runner: null, endedAt: null, summary: null }, "opened again in the end's commit");
  const writes = await log.writes("run-1");
  assert.deepEqual(writes.slice(-2), [["ended", true], ["running", false]], `the end's final write, its ended_at set, then the reopen: ${JSON.stringify(writes)}`);
  assert.ok((await store.runs.claimable()).includes("run-1"), "a runner claims it at once");
  const rows = await store.commands("run-1", 0);
  const of = (id) => rows.find((one) => one.id === id);
  assert.equal(of(message.id).takenAt, null, "the message waits untaken for the next claim, which runs it as a new turn");
  assert.equal(of(raise.id).refused, endedReason("ended"), "the run's other leftovers are refused as before");
  await assert.rejects(store.runs.reopen("run-1", { kind: "steer", body: { text: "x" } }), (e) => e instanceof RunFinal, "never reopened twice: the run is running again");

  // After the end: the store takes no new row on the ended run (RunFinal), and runs.reopen is the one way in.
  await queued(store, "run-2");
  await store.runs.update(await store.claim("run-2", "runner-a", { leaseMs: 30_000 }), { state: "ended" });
  await assert.rejects(store.command("run-2", { kind: "steer", body: { text: "Later." } }), (e) => e instanceof RunFinal, "no row on a final run");
  assert.equal((await store.runs.get("run-2")).state, "ended", "the refused row opened nothing");
  await store.runs.reopen("run-2", { kind: "steer", body: { text: "Later." } });
  assert.deepEqual((await store.commands("run-2", 0)).map((one) => [one.body.text, one.takenAt]), [["Later.", null]], "one row, from the reopen");

  // A run that does not reopen refuses the message at its end, as before: stopped, failed, a workflow's.
  for (const [id, patch] of [["run-3", { state: "stopped", summary: "stopped by a person" }], ["run-4", { state: "failed", summary: "it broke" }]]) {
    await queued(store, id);
    const claim = await store.claim(id, "runner-a", { leaseMs: 30_000 });
    const late = await store.command(id, { kind: "steer", body: { text: "too late" } });
    await store.runs.update(claim, patch);
    assert.equal((await store.runs.get(id)).state, patch.state);
    assert.equal((await store.commands(id, 0)).find((one) => one.id === late.id).refused, endedReason(patch.state), `a ${patch.state} run refuses it`);
  }
  await agentWithRevision(store, "agent-wf", "rev-wf");
  await store.agents.addRevision({ agentId: "agent-wf", id: "rev-wf2", kind: "workflow", body: { workflow: { name: "w", nodes: [] } } });
  await store.runs.create({ id: "run-wf", agentId: "agent-wf", revisionId: "rev-wf2" });
  const wfClaim = await store.claim("run-wf", "runner-a", { leaseMs: 30_000 });
  const wfLate = await store.command("run-wf", { kind: "steer", body: { text: "too late" } });
  await store.runs.update(wfClaim, { state: "ended" });
  assert.equal((await store.runs.get("run-wf")).state, "ended", "a completed workflow run stays ended");
  assert.equal((await store.commands("run-wf", 0)).find((one) => one.id === wfLate.id).refused, endedReason("ended"));
});
