// A claim is its epoch AND its lease: a write under a claim whose lease has run out (claimed_until passed, on the store's
// clock, the one that set it at claim and renew) is refused (Fenced) even while no one has taken the run and its epoch is
// unchanged. A runner paused past its lease (a stopped process, a long GC) must never write as if it still held the run:
// the store's statement is the only place the check and the write are one. A renew after the lease ran out is refused too:
// the claim is gone, and its runner takes the run again at a new epoch with a fresh loop. A release after it is refused,
// and the run is not stuck: running, its lease run out, it is claimable at once. And a write that makes the run final is
// its release: no runner, no lease, the epoch moved on by one, so a final run never shows a holder and a later release is a
// no-op.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { Fenced } from "../dist/store/store.js";
import { queued, storeOn } from "./store-helpers.mjs";
import { runRow, scratchConnection, T0 } from "./store-support.mjs";
import { postgresOnly, sqliteOnly } from "./store-target.mjs";

const storeModule = await import("../dist/store/index.js");
/** The shared fence predicate, read at each call: a store without it fails each test at its own call. */
const claimFence = (...args) => storeModule.claimFence(...args);

/** Whether `fence` matches a run row, through `tx`: the count of rows a no-op update under it touches. */
const holds = async (tx, fence) => (await tx.runCounted(`UPDATE runs SET epoch = epoch WHERE ${fence.where}`, ...fence.params)) === 1;
const insertRun = (tx, id) => tx.all("INSERT INTO runs (id, agent_id, revision_id, state, epoch, started_at) VALUES (?, 'agent-1', 'rev-1', 'ended', 0, ?) RETURNING rowid", id, T0);

test("the fence's held form: a claim holds its run while its lease has not run out, on the clock that set it, and not a moment after", async (t) => {
  const db = await scratchConnection(t);
  await runRow(db, "run-1", 1);
  const until = (await db.get("SELECT claimed_until FROM runs WHERE id = 'run-1'")).claimed_until;
  await db.connection.transaction(async (tx) => {
    assert.equal(await holds(tx, claimFence({ runId: "run-1", epoch: 1 }, until)), true, "at its last moment");
    assert.equal(await holds(tx, claimFence({ runId: "run-1", epoch: 1 }, until + 1)), false, "a moment after");
    assert.equal(await holds(tx, claimFence({ runId: "run-1", epoch: 2 }, until)), false, "another epoch");
  });
});

test("the fence's inserted-here form holds only for the row its own insert returned, never claimed: another run's row, a claimed row or a row with a runner are refused", sqliteOnly("the form naming its row by rowid; Postgres's is the next test"), async (t) => {
  const db = await scratchConnection(t);
  await runRow(db, "run-claimed", 1);
  await db.connection.transaction(async (tx) => {
    const [mine] = await insertRun(tx, "run-imported");
    assert.equal(await holds(tx, claimFence({ runId: "run-imported", epoch: 0 }, T0, { insertedHere: mine.rowid })), true, "the row this transaction inserted");
    const [other] = await insertRun(tx, "run-other");
    assert.equal(await holds(tx, claimFence({ runId: "run-imported", epoch: 0 }, T0, { insertedHere: other.rowid })), false, "another insert's rowid names another row");
    const claimed = await tx.get("SELECT rowid FROM runs WHERE id = 'run-claimed'");
    assert.equal(await holds(tx, claimFence({ runId: "run-claimed", epoch: 1 }, T0, { insertedHere: claimed.rowid })), false, "a claimed row (epoch above 0, a runner)");
    await tx.run("UPDATE runs SET runner = 'runner-x' WHERE id = 'run-imported'");
    assert.equal(await holds(tx, claimFence({ runId: "run-imported", epoch: 0 }, T0, { insertedHere: mine.rowid })), false, "a row with a runner");
  });
});

test("the fence's inserted-here form on Postgres holds only for a row this transaction inserted, never claimed: a never-claimed row another transaction inserted, a claimed row or a row with a runner are refused", postgresOnly("the form naming its row by its inserting transaction"), async (t) => {
  const db = await scratchConnection(t);
  await runRow(db, "run-claimed", 1);
  // A run never claimed (epoch 0, no runner) written by a transaction of its own, before this one.
  await db.run("INSERT INTO runs (id, agent_id, revision_id, state, epoch, started_at) VALUES ('run-queued', 'agent-1', 'rev-1', 'queued', 0, ?)", T0);
  const here = { insertedHere: "this-transaction" };
  await db.connection.transaction(async (tx) => {
    await tx.run("INSERT INTO runs (id, agent_id, revision_id, state, epoch, started_at) VALUES ('run-imported', 'agent-1', 'rev-1', 'ended', 0, ?)", T0);
    assert.equal(await holds(tx, claimFence({ runId: "run-imported", epoch: 0 }, T0, here)), true, "the row this transaction inserted");
    assert.equal(await holds(tx, claimFence({ runId: "run-queued", epoch: 0 }, T0, here)), false, "a never-claimed row another transaction inserted");
    assert.equal(await holds(tx, claimFence({ runId: "run-claimed", epoch: 1 }, T0, here)), false, "a claimed row (epoch above 0, a runner)");
    await tx.run("UPDATE runs SET runner = 'runner-x' WHERE id = 'run-imported'");
    assert.equal(await holds(tx, claimFence({ runId: "run-imported", epoch: 0 }, T0, here)), false, "a row with a runner");
  });
});

test("a claim whose lease ran out writes nothing, though its epoch is unchanged and no one retook the run: its journal commit, run update, take and retry are each Fenced", async (t) => {
  const { store, clock } = await storeOn(t);
  await queued(store);
  const command = await store.command("run-1", { kind: "raise", body: { usd: 5 } });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 1_000 });
  const journal = store.journal(claim);
  clock.now += 1_001;
  const before = await store.runs.get("run-1");
  assert.deepEqual([before.epoch, before.runner], [claim.epoch, "runner-a"], "no one retook it: the epoch is the claim's");
  await assert.rejects(commitWrites(journal, [{ type: "conversation", value: { id: 1 } }], BACKGROUND_CONTEXT), Fenced, "its journal's commit");
  await assert.rejects(store.runs.update(claim, { state: "ended" }), Fenced, "its run update");
  await assert.rejects(store.take(claim, command.id), Fenced, "its take");
  await assert.rejects(store.retry(claim, command.id), Fenced, "its retry");
  assert.deepEqual(await store.runs.get("run-1"), before, "the run is as the lease left it");
  assert.deepEqual((await store.commands("run-1", 0)).map((c) => [c.takenAt, c.tries]), [[null, 0]], "the command untaken, no try counted");
});

test("a claim's writes go through up to its lease's last moment: at claimed_until itself, a commit and an update land", async (t) => {
  const { store, clock } = await storeOn(t);
  await queued(store);
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 1_000 });
  clock.now += 1_000;
  await commitWrites(store.journal(claim), [{ type: "conversation", value: { id: 1 } }], BACKGROUND_CONTEXT);
  await store.runs.update(claim, { summary: "still mine" });
  assert.equal((await store.runs.get("run-1")).summary, "still mine");
});

test("a renew after the lease ran out is refused: the claim is gone, and only a new claim (a new epoch) takes the run", async (t) => {
  const { store, clock } = await storeOn(t);
  await queued(store);
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 1_000 });
  clock.now += 1_001;
  await assert.rejects(store.renew(claim, { leaseMs: 1_000 }), Fenced, "renew");
  const [renewed] = await store.renewMany([claim], { leaseMs: 1_000 });
  assert.ok(renewed instanceof Fenced, `renewMany answers it Fenced: ${renewed}`);
  const again = await store.claim("run-1", "runner-a", { leaseMs: 1_000 });
  assert.equal(again?.epoch, claim.epoch + 1, "taken again at a new epoch");
});

test("a release after the lease ran out is refused, and the run is not stuck: running, its lease run out, it is claimable at once", async (t) => {
  const { store, clock } = await storeOn(t);
  await queued(store);
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 1_000 });
  clock.now += 1_001;
  await assert.rejects(store.release(claim, { state: "parked" }), Fenced, "its release");
  const row = await store.runs.get("run-1");
  assert.deepEqual([row.state, row.epoch], ["running", claim.epoch], "not parked by a claim that ran out");
  assert.deepEqual(await store.runs.claimable(), ["run-1"], "claimable at once");
});

test("a write that makes the run final is its release: from that commit the run holds no runner and no lease, at the claim's epoch + 1, and nothing moves it after", async (t) => {
  for (const how of ["journal", "update"]) {
    const { store, clock } = await storeOn(t);
    await queued(store);
    const claim = await store.claim("run-1", "runner-a", { leaseMs: 1_000 });
    if (how === "journal") {
      // The end lands with the record it names: a fresh entry, as the loop's agentrun.end is.
      const journal = store.journal(claim);
      const conversation = await journal.mintId();
      const effect = await journal.mintId();
      journal.stage({ run: { state: "ended" }, effect });
      await commitWrites(journal, [{ type: "conversation", value: { id: conversation } }, { type: "entry", value: { id: effect, conversationId: conversation, kind: "agentrun.end" } }], BACKGROUND_CONTEXT);
    } else await store.runs.update(claim, { state: "ended" });
    const ended = await store.runs.get("run-1");
    assert.deepEqual([ended.state, ended.runner, ended.claimedUntil, ended.epoch], ["ended", null, null, claim.epoch + 1], `${how}: released by its end, at the claim's epoch + 1`);
    // The runner's release after it, late (its lease run out) or not: a no-op, no second move of the epoch, no error.
    clock.now += 1_001;
    await store.release(claim, {});
    assert.deepEqual(await store.runs.get("run-1"), ended, `${how}: a later release changes nothing`);
    assert.deepEqual(await store.runs.claimable(), [], `${how}: a final run is never claimed`);
  }
});
