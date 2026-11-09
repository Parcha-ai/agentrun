// On Postgres the store has many writers, where SQLite's one writer lock serialized every transaction for free: two
// runners claim at once, a command lands while a run's end is in flight, a live put races the end, a sign-in's forget races a
// launch's hand-over, two firings race a trigger's room. Each test plays the other writer with a client of its own that
// holds the lock that writer's transaction holds (BEGIN, its statements, no COMMIT yet), then calls the store: the store's
// call must either skip the held row (a claim) or wait for that transaction and read its outcome (the rest). "Waits" is
// read from Postgres itself (pg_blocking_pids), never from a timer, and no test sleeps.
import assert from "node:assert/strict";
import { test } from "node:test";
import { queued, storeOn } from "./store-helpers.mjs";
import { client, postgresOnly, schemaOf } from "./store-target.mjs";

const { endedReason, RunFinal, SignInHandedTo, TriggerFull } = await import("../dist/store/index.js");

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
  // The run's end in flight: its fenced final write and its refusal of the rows it leaves (run-patch.ts), not committed.
  const end = await otherWriter(t, file);
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
  const end = await otherWriter(t, file);
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
