// A write that makes a run final (ended, stopped or failed) settles every command row of the run it leaves untaken, in
// that same transaction: refused with the end's reason, after the write's own takes. The store takes no new row on a final
// run (RunFinal), so a row left untaken by the end would stay so for good; a runner that dies right after the end leaves
// none. Both writes that end a run: runs.update, and a journal commit that lands a final run patch.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { queued, storeOn } from "./store-helpers.mjs";
import { raw } from "./store-target.mjs";

const { endedReason } = await import("../dist/store/index.js");
const commandRow = async (store, id) => (await store.commands("run-1", id - 1)).find((row) => row.id === id);

test("runs.update to a final state refuses the run's other untaken rows with the end's reason, its own take taken", async (t) => {
  const { store } = await storeOn(t);
  await queued(store);
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 30_000 });
  const raise = await store.command("run-1", { kind: "raise", body: { capUsd: 5 } });
  const steer = await store.command("run-1", { kind: "steer", body: { text: "and then" } });
  const stop = await store.command("run-1", { kind: "stop" });
  await store.runs.update(claim, { state: "stopped", summary: "stopped by a person" }, { take: [stop.id] });
  const stopRow = await commandRow(store, stop.id);
  assert.ok(stopRow.takenAt !== null && stopRow.refused === null, `the stop taken, not refused: ${JSON.stringify(stopRow)}`);
  for (const row of [raise, steer]) {
    const now = await commandRow(store, row.id);
    assert.ok(now.takenAt !== null, `row ${row.id} settled in the same write: ${JSON.stringify(now)}`);
    assert.equal(now.refused, endedReason("stopped"));
  }
});

test("a release never makes a run final: only the end commit does, so no final run is left holding an untaken row", async (t) => {
  const { store } = await storeOn(t);
  await queued(store);
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 30_000 });
  const steer = await store.command("run-1", { kind: "steer", body: { text: "and then" } });
  for (const state of ["ended", "stopped", "failed"]) {
    await assert.rejects(store.release(claim, { state }), (error) => error instanceof TypeError && /never makes a run final/.test(error.message), `a release to ${state} is refused`);
  }
  const row = await store.runs.get("run-1");
  assert.deepEqual([row.state, row.runner, row.endedAt], ["running", "runner-a", null], "the run is as the claim left it");
  assert.equal((await commandRow(store, steer.id)).takenAt, null, "its steer is still waiting for the loop");
});

/** A test-only trigger on the store's file that aborts any write refusing a command row: the end and its refusals must
 *  stand or fall together, so with the trigger the whole end rolls back (the run not final, its stop untaken). Were the
 *  refusals a write of their own after the end, the run would land final while they failed. */
async function refusalsAbort(file) {
  const db = await raw(file);
  if (db.kind === "sqlite") {
    await db.exec("CREATE TRIGGER test_no_refusal BEFORE UPDATE OF refused ON commands WHEN NEW.refused IS NOT NULL BEGIN SELECT RAISE(ABORT, 'a refusal aborted by the test'); END");
  } else {
    await db.exec(`CREATE FUNCTION test_no_refusal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'a refusal aborted by the test'; END $$;
      CREATE TRIGGER test_no_refusal BEFORE UPDATE OF refused ON commands FOR EACH ROW WHEN (NEW.refused IS NOT NULL) EXECUTE FUNCTION test_no_refusal()`);
  }
  await db.close();
}

test("runs.update to a final state and its refusals are one transaction: a refusal that fails rolls the end back", async (t) => {
  const { store, file } = await storeOn(t);
  await queued(store);
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 30_000 });
  const raise = await store.command("run-1", { kind: "raise", body: { capUsd: 5 } });
  const stop = await store.command("run-1", { kind: "stop" });
  await refusalsAbort(file);
  await assert.rejects(store.runs.update(claim, { state: "stopped", summary: "stopped by a person" }, { take: [stop.id] }), /a refusal aborted by the test/);
  assert.equal((await store.runs.get("run-1")).state, "running", "the end rolled back with its refusal: not final");
  assert.equal((await commandRow(store, stop.id)).takenAt, null, "its stop untaken");
  assert.equal((await commandRow(store, raise.id)).takenAt, null, "the raise untaken");
});

test("a journal commit's final run patch and its refusals are one transaction: a refusal that fails rolls the end back", async (t) => {
  const { store, file } = await storeOn(t);
  await queued(store);
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 30_000 });
  // A raise, not a person's message: a message waiting at a completed run's end opens the run again instead of being
  // refused (store-run-reopen.test.mjs), so it would make no refusal here to abort.
  const steer = await store.command("run-1", { kind: "raise", body: { capUsd: 5 } });
  const journal = store.journal(claim);
  await commitWrites(journal, [{ type: "conversation", value: { id: 1 } }], BACKGROUND_CONTEXT);
  await refusalsAbort(file);
  const end = await journal.mintId();
  journal.stage({ run: { state: "ended" }, effect: end });
  await assert.rejects(commitWrites(journal, [{ type: "entry", value: { id: end, conversationId: 1, kind: "agentrun.end", data: { state: "ended" } } }], BACKGROUND_CONTEXT), /a refusal aborted by the test/);
  assert.equal((await store.runs.get("run-1")).state, "running", "the end rolled back with its refusal: not final");
  assert.equal((await commandRow(store, steer.id)).takenAt, null, "the steer untaken");
});

test("runs.update that leaves the run running refuses nothing", async (t) => {
  const { store } = await storeOn(t);
  await queued(store);
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 30_000 });
  const steer = await store.command("run-1", { kind: "steer", body: { text: "still going" } });
  await store.runs.update(claim, { costUsd: 0.5 });
  assert.equal((await commandRow(store, steer.id)).takenAt, null);
});

test("a journal commit that lands a final run patch refuses the run's other untaken rows in that commit, its own take taken", async (t) => {
  const { store } = await storeOn(t);
  await queued(store);
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 30_000 });
  // A raise, not a person's message, as the leftover: a message waiting at a completed run's end opens the run again
  // (store-run-reopen.test.mjs).
  const steer = await store.command("run-1", { kind: "raise", body: { capUsd: 5 } });
  const approve = await store.command("run-1", { kind: "approve", body: { approval: "call-1" } });
  const journal = store.journal(claim);
  await commitWrites(journal, [{ type: "conversation", value: { id: 1 } }], BACKGROUND_CONTEXT);
  const end = await journal.mintId();
  journal.stage({ run: { state: "ended" }, effect: end, take: [{ command: approve.id, effect: end }] });
  await commitWrites(journal, [{ type: "entry", value: { id: end, conversationId: 1, kind: "agentrun.end", data: { state: "ended" } } }], BACKGROUND_CONTEXT);
  const approveRow = await commandRow(store, approve.id);
  assert.ok(approveRow.takenAt !== null && approveRow.refused === null, `the end's own take taken, not refused: ${JSON.stringify(approveRow)}`);
  const steerRow = await commandRow(store, steer.id);
  assert.ok(steerRow.takenAt !== null, `the steer settled in the end's commit: ${JSON.stringify(steerRow)}`);
  assert.equal(steerRow.refused, endedReason("ended"));
});
