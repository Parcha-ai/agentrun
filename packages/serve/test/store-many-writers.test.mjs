// On Postgres the store has many writers, where SQLite's one writer lock serialized every transaction for free: two
// runners claim at once, a command lands while a run's end is in flight, a live put races the end, a sign-in's forget races a
// launch's hand-over, two firings race a trigger's room. Each test plays the other writer with a client of its own that
// holds the lock that writer's transaction holds (BEGIN, its statements, no COMMIT yet), then calls the store: the store's
// call must either skip the held row (a claim) or wait for that transaction and read its outcome (the rest). "Waits" is
// read from Postgres itself (pg_blocking_pids), never from a timer, and no test sleeps.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { queued, storeOn } from "./store-helpers.mjs";
import { client, postgresOnly, raw, schemaOf } from "./store-target.mjs";

const { endedReason, Fenced, RunFinal, SignInHandedTo, TriggerFull } = await import("../dist/store/index.js");

const ONLY = postgresOnly("the many-writer locks (SQLite's one writer lock serializes these)");

/** The other writer: a client of its own in the store's schema, with its transaction open. */
async function otherWriter(t, file) {
  const c = await client(schemaOf(file));
  t.after(() => c.end().catch(() => undefined));
  const pid = (await c.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  await c.query("BEGIN");
  return { c, pid, sql: (text, ...params) => c.query(text, params) };
}

/** Settles with "waits" once a session is blocked by `pid`'s locks, or with the call's own outcome first, whichever comes
 *  first: what the call did while the other writer held its transaction open. */
async function whileHeld(call, pid, watcher) {
  const outcome = call.then((value) => ({ settled: "resolved", value }), (error) => ({ settled: "rejected", error }));
  for (;;) {
    const done = await Promise.race([outcome, new Promise((resolve) => setImmediate(() => resolve(undefined)))]);
    if (done) return done;
    const waiting = await watcher.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))", [pid]);
    if (waiting.rows[0].n > 0) return { settled: "waits" };
  }
}

async function watcherOf(t) {
  const c = await client();
  t.after(() => c.end().catch(() => undefined));
  return c;
}

/** The pid of the session `holder`'s lock holds up, once one is: a store call stopped mid-transaction at what `holder`
 *  locked, everything before that point (its run-row lock among it) already held. */
async function heldUp(watcher, holder) {
  for (;;) {
    const blocked = await watcher.query("SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid)) LIMIT 1", [holder.pid]);
    if (blocked.rows[0]) return blocked.rows[0].pid;
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** A journal commit of run-1 under `claim`, in flight: its first commit landed (the journal open), then a second one held up
 *  past its fence at the journal's metadata table, which another session holds. Returns the commit, its session's pid,
 *  the journal, and `letGo()`, which ends the hold. */
async function commitInFlight(t, store, file, claim, watcher) {
  const journal = store.journal(claim);
  await commitWrites(journal, [{ type: "conversation", value: { id: 1 } }], BACKGROUND_CONTEXT);
  const entry = { id: await journal.mintId(), conversationId: 1, kind: "pi.user", model: [{ role: "user", content: "Go." }] };
  const table = await otherWriter(t, file);
  await table.sql("LOCK TABLE pi_metadata IN ACCESS EXCLUSIVE MODE");
  const commit = commitWrites(journal, [{ type: "entry", value: entry }], BACKGROUND_CONTEXT);
  commit.catch(() => undefined);
  const pid = await heldUp(watcher, table);
  return { commit, pid, journal, letGo: () => table.sql("ROLLBACK") };
}

/** Once two sessions wait behind `holder`: both blocked by its locks, or one blocked by them and the other by that one. */
async function twoHeldUp(watcher, holder) {
  for (;;) {
    const seen = await watcher.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity w WHERE $1 = ANY(pg_blocking_pids(w.pid))
         OR EXISTS (SELECT 1 FROM pg_stat_activity f WHERE $1 = ANY(pg_blocking_pids(f.pid)) AND f.pid = ANY(pg_blocking_pids(w.pid)))`,
      [holder.pid],
    );
    if (seen.rows[0].n >= 2) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("two commits of one run's journal at once each take a seq of their own: the second reads the journal's seq only after the first has moved it on", ONLY, async (t) => {
  const { store, file } = await storeOn(t);
  await queued(store);
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 30_000 });
  const watcher = await watcherOf(t);
  const journal = store.journal(claim);
  await commitWrites(journal, [{ type: "conversation", value: { id: 1 } }], BACKGROUND_CONTEXT);
  const entry = async () => ({ type: "entry", value: { id: await journal.mintId(), conversationId: 1, kind: "pi.user", model: [{ role: "user", content: "Go." }] } });
  const [first, second] = [await entry(), await entry()];
  // The journal's own tables held by another session: each commit stops past what it reads first, until they are let go.
  const tables = await otherWriter(t, file);
  await tables.sql("LOCK TABLE pi_entries, pi_record_ids IN ACCESS EXCLUSIVE MODE");
  const both = Promise.all([commitWrites(journal, [first], BACKGROUND_CONTEXT), commitWrites(journal, [second], BACKGROUND_CONTEXT)]);
  both.catch(() => undefined);
  await twoHeldUp(watcher, tables);
  await tables.sql("ROLLBACK");
  await both;
  const db = await raw(file);
  const metadata = await db.get("SELECT next_seq FROM pi_metadata WHERE run_id = 'run-1'");
  await db.close();
  assert.equal(Number(metadata.next_seq), 4, "three commits, three seqs (1, 2, 3): none taken twice");
});

test("a command written while a journal commit that ends the run is in flight waits for that commit, then is refused, never left beside the ended run", ONLY, async (t) => {
  const { store, file } = await storeOn(t);
  await queued(store);
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 30_000 });
  const watcher = await watcherOf(t);
  const journal = store.journal(claim);
  await commitWrites(journal, [{ type: "conversation", value: { id: 1 } }], BACKGROUND_CONTEXT);
  const end = await journal.mintId();
  journal.stage({ run: { state: "ended" }, effect: end });
  // The ending commit held up past its run row's end (run-patch.ts deletes the run's live row next) by another session.
  const live = await otherWriter(t, file);
  await live.sql("LOCK TABLE run_live IN ACCESS EXCLUSIVE MODE");
  const commit = commitWrites(journal, [{ type: "entry", value: { id: end, conversationId: 1, kind: "agentrun.end", data: { state: "ended" } } }], BACKGROUND_CONTEXT);
  commit.catch(() => undefined);
  const committing = await heldUp(watcher, live);
  const command = store.command("run-1", { kind: "steer", body: { text: "and then" } });
  const seen = await whileHeld(command, committing, watcher);
  await live.sql("ROLLBACK");
  await commit;
  const outcome = await command.then(() => "written", (error) => error);
  assert.equal(seen.settled, "waits", `the command waited for the ending commit (it ${seen.settled})`);
  assert.ok(outcome instanceof RunFinal, `then it was refused, the run final: ${outcome}`);
  assert.deepEqual((await store.commands("run-1", 0)).filter((row) => row.takenAt === null), [], "no command of the ended run is left untaken");
});

test("a renew never waits for a journal commit in flight on its run: the commit holds the run's row shared, never against a lease's move", ONLY, async (t) => {
  const { store, file } = await storeOn(t);
  await queued(store);
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 30_000 });
  const watcher = await watcherOf(t);
  const inFlight = await commitInFlight(t, store, file, claim, watcher);
  const renew = store.renew(claim, { leaseMs: 30_000 });
  const seen = await whileHeld(renew, inFlight.pid, watcher);
  await inFlight.letGo();
  await inFlight.commit;
  await renew;
  assert.equal(seen.settled, "resolved", `the renew went through while the commit was in flight (it ${seen.settled})`);
});

test("a takeover of a run whose lease ran out while its journal commit is in flight waits for that commit, and the old claim's next commit is refused", ONLY, async (t) => {
  const { store, file, clock } = await storeOn(t);
  await queued(store);
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 1_000 });
  const watcher = await watcherOf(t);
  const inFlight = await commitInFlight(t, store, file, claim, watcher);
  clock.now += 2_000;
  const takeover = store.claim("run-1", "runner-b", { leaseMs: 30_000 });
  const seen = await whileHeld(takeover, inFlight.pid, watcher);
  await inFlight.letGo();
  await inFlight.commit;
  const taken = await takeover;
  assert.equal(seen.settled, "waits", `the takeover waited for the commit in flight (it ${seen.settled})`);
  assert.deepEqual([taken?.runner, taken?.epoch], ["runner-b", 2], "then took the run at the next epoch");
  await assert.rejects(commitWrites(inFlight.journal, [{ type: "conversation", value: { id: 2 } }], BACKGROUND_CONTEXT), Fenced, "the old claim commits nothing more");
});

test("a release while its run's journal commit is in flight waits for that commit, then moves the epoch on", ONLY, async (t) => {
  const { store, file } = await storeOn(t);
  await queued(store);
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 30_000 });
  const watcher = await watcherOf(t);
  const inFlight = await commitInFlight(t, store, file, claim, watcher);
  const release = store.release(claim, { state: "parked" });
  const seen = await whileHeld(release, inFlight.pid, watcher);
  await inFlight.letGo();
  await inFlight.commit;
  await release;
  assert.equal(seen.settled, "waits", `the release waited for the commit in flight (it ${seen.settled})`);
  await assert.rejects(commitWrites(inFlight.journal, [{ type: "conversation", value: { id: 2 } }], BACKGROUND_CONTEXT), Fenced, "the released claim commits nothing more");
});

test("a run's end while its journal commit is in flight waits for that commit, then ends the run", ONLY, async (t) => {
  const { store, file } = await storeOn(t);
  await queued(store);
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 30_000 });
  const watcher = await watcherOf(t);
  const inFlight = await commitInFlight(t, store, file, claim, watcher);
  const end = store.runs.update(claim, { state: "ended", outcome: "completed", summary: "done", costUsd: 0 });
  const seen = await whileHeld(end, inFlight.pid, watcher);
  await inFlight.letGo();
  await inFlight.commit;
  await end;
  assert.equal(seen.settled, "waits", `the end waited for the commit in flight (it ${seen.settled})`);
  assert.equal((await store.runs.get("run-1"))?.state, "ended", "then ended the run");
});

test("a second claimer takes the next run while the first holds one, without waiting for it", ONLY, async (t) => {
  const { store, file } = await storeOn(t);
  await queued(store, "run-1");
  await queued(store, "run-2");
  const watcher = await watcherOf(t);
  // The first claimer, mid-claim: it has picked run-1 and holds its row.
  const first = await otherWriter(t, file);
  await first.sql("SELECT id FROM runs WHERE id = 'run-1' FOR UPDATE");
  const second = store.runs.claimMany("runner-b", 1);
  const seen = await whileHeld(second, first.pid, watcher);
  await first.sql("ROLLBACK");
  assert.equal(seen.settled, "resolved", `the second claim did not wait for the first (it ${seen.settled}${seen.error ? `: ${seen.error.message}` : ""})`);
  assert.deepEqual(seen.value.map((claim) => claim.runId), ["run-2"], "it took the next run, never the held one");
  await second;
});

test("a claim of one run whose lease ran out waits for a write in flight on its row, then claims it, never answering it held", ONLY, async (t) => {
  const { store, file, clock } = await storeOn(t);
  await queued(store);
  await store.claim("run-1", "runner-a", { leaseMs: 1_000 });
  clock.now += 2_000;
  const watcher = await watcherOf(t);
  // The lapsed holder's write in flight: its transaction holds the run's row (as a journal commit or a renew does).
  const holder = await otherWriter(t, file);
  await holder.sql("SELECT 1 FROM runs WHERE id = 'run-1' FOR NO KEY UPDATE");
  const claim = store.claim("run-1", "runner-b", { leaseMs: 30_000 });
  const seen = await whileHeld(claim, holder.pid, watcher);
  await holder.sql("ROLLBACK");
  const taken = await claim;
  assert.equal(seen.settled, "waits", `the claim waited for the write in flight (it ${seen.settled}${seen.value === null ? ": null, read as held" : ""})`);
  assert.deepEqual([taken?.runner, taken?.epoch], ["runner-b", 2], "then claimed the run its lapsed holder no longer holds");
});

test("a renew that waits for another writer of its run runs its lease from when it holds the row, never from before", ONLY, async (t) => {
  const { store, file, clock } = await storeOn(t);
  await queued(store);
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 10_000 });
  const watcher = await watcherOf(t);
  const other = await otherWriter(t, file);
  await other.sql("SELECT 1 FROM runs WHERE id = 'run-1' FOR NO KEY UPDATE");
  const renew = store.renew(claim, { leaseMs: 10_000 });
  const seen = await whileHeld(renew, other.pid, watcher);
  // The clock moves while the renew waits, past the claim's lease: a renew that read it before its wait would bring the
  // lease back; one that reads it once it holds the row finds it run out.
  clock.now += 15_000;
  await other.sql("ROLLBACK");
  assert.equal(seen.settled, "waits", "the renew waited for the other writer");
  await assert.rejects(renew, (error) => error?.name === "Fenced", "a lease that ran out while it waited is not brought back");
});

test("claimers racing over many runs claim each run once", ONLY, async (t) => {
  const { store, file, clock } = await storeOn(t);
  for (let i = 0; i < 12; i++) await queued(store, `run-${String(i).padStart(2, "0")}`);
  const { store: other } = await storeOn(t, { file, clock, role: "runner" });
  const claims = (await Promise.all([store.runs.claimMany("runner-a", 4), other.runs.claimMany("runner-b", 4), store.runs.claimMany("runner-c", 4), other.runs.claimMany("runner-d", 4)])).flat();
  const ids = claims.map((claim) => claim.runId);
  assert.equal(new Set(ids).size, ids.length, `no run claimed twice: ${ids.join(", ")}`);
  assert.equal(ids.length, 12, "and every run claimed");
});

test("a command written while the run's end is open is refused, never left untaken", ONLY, async (t) => {
  const { store, file, clock } = await storeOn(t);
  await queued(store);
  await store.claim("run-1", "runner-a", { leaseMs: 30_000 });
  const watcher = await watcherOf(t);
  // The run's end in flight: the run's row held as an epoch's move holds it (runs.update, dialect lockRow "update"), its
  // fenced final write and its refusal of the rows it leaves (run-patch.ts), not committed.
  const end = await otherWriter(t, file);
  await end.sql("SELECT 1 FROM runs WHERE id = 'run-1' FOR UPDATE");
  await end.sql("UPDATE runs SET state = 'ended', ended_at = $1, runner = NULL, claimed_until = NULL, epoch = epoch + 1 WHERE id = 'run-1'", clock.now);
  await end.sql("UPDATE commands SET taken_at = $1, refused = $2 WHERE run_id = 'run-1' AND taken_at IS NULL", clock.now, endedReason("ended"));
  const command = store.command("run-1", { kind: "steer", body: { text: "and then" } });
  const seen = await whileHeld(command, end.pid, watcher);
  await end.sql("COMMIT");
  const outcome = await command.then(() => "written", (error) => error);
  assert.equal(seen.settled, "waits", "the command waited for the end in flight");
  assert.ok(outcome instanceof RunFinal, `then it was refused, the run final: ${outcome}`);
  const untaken = (await store.commands("run-1", 0)).filter((row) => row.takenAt === null);
  assert.deepEqual(untaken, [], "no command of the ended run is left untaken");
});

test("a live put while the run's end is open waits, then writes nothing beside the ended run", ONLY, async (t) => {
  const { store, file, clock } = await storeOn(t);
  await queued(store);
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 30_000 });
  const watcher = await watcherOf(t);
  // The run's end in flight, its row held as an epoch's move holds it (dialect lockRow "update").
  const end = await otherWriter(t, file);
  await end.sql("SELECT 1 FROM runs WHERE id = 'run-1' FOR UPDATE");
  await end.sql("UPDATE runs SET state = 'ended', ended_at = $1, runner = NULL, claimed_until = NULL, epoch = epoch + 1 WHERE id = 'run-1'", clock.now);
  await end.sql("DELETE FROM run_live WHERE run_id = 'run-1'");
  const put = store.live.put([{ claim, state: { tool: "search" } }]);
  const seen = await whileHeld(put, end.pid, watcher);
  await end.sql("COMMIT");
  assert.equal(seen.settled, "waits", "the put waited for the end in flight");
  assert.deepEqual(await put, { written: [], fenced: ["run-1"] }, "then found the claim gone");
  assert.deepEqual(await store.live.read(["run-1"]), [], "an ended run shows no live row");
});

test("a sign-in's forget while a launch hands its pointer to a run waits, then is refused for that run", ONLY, async (t) => {
  const { store, file } = await storeOn(t);
  await queued(store);
  await store.claim("run-1", "runner-a", { leaseMs: 30_000 });
  await store.signIns.save({ agentId: "agent-1", provider: "browserbase", name: "default", pointerSealed: new Uint8Array([1, 2, 3]) });
  const watcher = await watcherOf(t);
  // The launch in flight: the hand-over's lock (run-patch.ts SIGN_IN_HANDED_LOCK), then its write of the hashes.
  const launch = await otherWriter(t, file);
  await launch.sql("SELECT pg_advisory_xact_lock(hashtext($1), hashtext('sign_in_handed'))", schemaOf(file));
  await launch.sql("UPDATE runs SET sign_in_handed = $1 WHERE id = 'run-1'", JSON.stringify(["hash-1"]));
  const forget = store.signIns.forget("agent-1", "browserbase", { hash: "hash-1" });
  const seen = await whileHeld(forget, launch.pid, watcher);
  await launch.sql("COMMIT");
  const outcome = await forget.then(() => "forgotten", (error) => error);
  assert.equal(seen.settled, "waits", "the forget waited for the launch in flight");
  assert.ok(outcome instanceof SignInHandedTo && outcome.runId === "run-1", `then was refused for the run: ${outcome}`);
  assert.ok(await store.signIns.get("agent-1", "browserbase"), "the sign-in is still saved");
});

test("a firing recorded while another holds the trigger's last room waits, then is refused (TriggerFull)", ONLY, async (t) => {
  const { store, file, clock } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "agent-1" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer." } });
  await store.triggers.create({ id: "trig-1", agentId: "agent-1", name: "nightly", enabled: true, source: { kind: "schedule" }, target: { kind: "start_run" }, nextAt: null, catchupWindowS: 0 });
  const watcher = await watcherOf(t);
  // Another record in flight: it holds the trigger's row and has written its due firing.
  const other = await otherWriter(t, file);
  await other.sql("SELECT 1 FROM triggers WHERE id = 'trig-1' FOR UPDATE");
  await other.sql("INSERT INTO trigger_firings (trigger_id, key, by, nominal_at, status, at, shown) VALUES ('trig-1', 'k-1', 'schedule', $1, 'due', $1, 1)", clock.now);
  const record = store.triggers.record("trig-1", [{ key: "k-2", by: "schedule", nominalAt: clock.now, status: "due" }], { room: 1 });
  const seen = await whileHeld(record, other.pid, watcher);
  await other.sql("COMMIT");
  const outcome = await record.then(() => "recorded", (error) => error);
  assert.equal(seen.settled, "waits", "the record waited for the other in flight");
  assert.ok(outcome instanceof TriggerFull, `then found no room: ${outcome}`);
  assert.equal((await store.triggers.pending()).length, 1, "one firing due, as the room allows");
});
