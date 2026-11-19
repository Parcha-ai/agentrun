// Each runner's word that it is there (store `runners`, runner/presence.ts) and the runs no runner here can take
// (Runs.failUnclaimed), on either store: a row is kept per runner and fenced by its incarnation, a row no runner renewed
// for a day goes at the next put, the server reads a refusal only while every runner still there refused, and the runs
// still queued fail in its words while a run a runner claimed is left to it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { keepPresence, PRESENCE_STALE_MS, refusedEnd, refusedEndMessage, runnersRefused } from "../dist/runner/presence.js";
import { RUNNER_ROWS_KEPT_MS } from "../dist/store/store.js";
import { queued, storeOn, T0 } from "./store-helpers.mjs";

const WORDS = "AGENTRUN_RUN_USER=bogus is not a setting this runner knows: set AGENTRUN_RUN_USER=same.";

test("a runner's row is its incarnation's: seen and removed only by it, put again by a new one, gone a day after its last word", async (t) => {
  const clock = { now: T0 };
  const { store } = await storeOn(t, { clock });
  await store.runners.put({ runner: "r1", incarnation: "a", refused: null });
  assert.deepEqual(await store.runners.list(), [{ runner: "r1", incarnation: "a", refused: null, seenAt: T0 }]);
  clock.now = T0 + 5_000;
  assert.equal(await store.runners.seen("r1", "a"), true);
  assert.equal(await store.runners.seen("r1", "b"), false, "another incarnation's renewal is not this one's");
  assert.equal((await store.runners.list())[0].seenAt, T0 + 5_000);
  // A new start of the same name takes the row over; the earlier one's remove leaves it.
  await store.runners.put({ runner: "r1", incarnation: "b", refused: WORDS });
  await store.runners.remove("r1", "a");
  assert.deepEqual(await store.runners.list(), [{ runner: "r1", incarnation: "b", refused: WORDS, seenAt: T0 + 5_000 }]);
  await store.runners.remove("r1", "b");
  assert.deepEqual(await store.runners.list(), []);
  // A runner that died without its close: its row goes at a put past RUNNER_ROWS_KEPT_MS, never before.
  await store.runners.put({ runner: "dead", incarnation: "x", refused: WORDS });
  clock.now = T0 + 5_000 + RUNNER_ROWS_KEPT_MS;
  await store.runners.put({ runner: "r2", incarnation: "y", refused: null });
  assert.deepEqual((await store.runners.list()).map((row) => row.runner), ["dead", "r2"]);
  clock.now += 1;
  await store.runners.put({ runner: "r2", incarnation: "y", refused: null });
  assert.deepEqual((await store.runners.list()).map((row) => row.runner), ["r2"]);
});

test("no runner can take a run only while every runner still there refused, and one at least is there", async (t) => {
  const clock = { now: T0 };
  const { store } = await storeOn(t, { clock });
  const at = (ms) => T0 + ms;
  assert.equal(await runnersRefused(store.runners, at(0)), undefined, "no runner yet: runs queue for one to come");
  await store.runners.put({ runner: "refuses", incarnation: "1", refused: WORDS });
  assert.equal(await runnersRefused(store.runners, at(0)), `No runner of this server can take a run: ${WORDS}`);
  await store.runners.put({ runner: "refuses-too", incarnation: "1", refused: WORDS });
  assert.equal(await runnersRefused(store.runners, at(0)), `No runner of this server can take a run: ${WORDS}`, "the same words once");
  await store.runners.put({ runner: "claims", incarnation: "1", refused: null });
  assert.equal(await runnersRefused(store.runners, at(0)), undefined, "one runner that claims is enough");
  // The runner that claims stops saying it is there (it died): past PRESENCE_STALE_MS it no longer counts.
  clock.now = at(PRESENCE_STALE_MS);
  await store.runners.seen("refuses", "1");
  await store.runners.seen("refuses-too", "1");
  assert.equal(await runnersRefused(store.runners, at(PRESENCE_STALE_MS + 1)), `No runner of this server can take a run: ${WORDS}`);
  // And refusing runners that died count for nothing either: no runner is there.
  assert.equal(await runnersRefused(store.runners, at(2 * PRESENCE_STALE_MS + 1)), undefined);
});

test("keepPresence keeps its row renewed and puts it back when it went; its close removes it", async (t) => {
  const { store } = await storeOn(t, { clock: { now: Date.now() } });
  const presence = keepPresence(store.runners, "kept", WORDS, { renewMs: 50 });
  t.after(() => presence.stop());
  const until = async (done) => {
    const end = Date.now() + 5_000;
    while (!done(await store.runners.list()) && Date.now() < end) await sleep(20);
    return store.runners.list();
  };
  const [row] = await until((rows) => rows.length === 1);
  assert.deepEqual({ runner: row.runner, refused: row.refused }, { runner: "kept", refused: WORDS });
  // Gone from under it (a row pruned): put again at its next renewal, its own incarnation.
  await store.runners.remove(row.runner, row.incarnation);
  const [again] = await until((rows) => rows.length === 1);
  assert.equal(again.incarnation, row.incarnation);
  await presence.close();
  assert.deepEqual(await store.runners.list(), []);
});

test("failUnclaimed fails every run still queued in the words given, refusing its untaken commands, and leaves a claimed run to its runner", async (t) => {
  const { store } = await storeOn(t);
  await queued(store, "run-queued");
  await queued(store, "run-claimed");
  await store.command("run-queued", { kind: "steer", body: { content: "and this" } });
  const claim = await store.claim("run-claimed", "runner-a", { leaseMs: 60_000 });
  assert.ok(claim);
  const summary = refusedEnd(`No runner of this server can take a run: ${WORDS}`);
  assert.deepEqual(await store.runs.failUnclaimed(summary), ["run-queued"]);
  const failed = await store.runs.get("run-queued");
  assert.equal(failed.state, "failed");
  assert.equal(failed.summary, summary);
  assert.equal(refusedEndMessage(failed.summary), `No runner of this server can take a run: ${WORDS}`);
  assert.equal(failed.endedAt, T0);
  assert.equal(failed.epoch, 1, "its epoch moved on, as an end's does");
  const commands = (await store.commandsOf([{ runId: "run-queued", after: 0 }])).get("run-queued");
  assert.equal(commands.length, 1);
  assert.notEqual(commands[0].refused, null, "its untaken command is refused with its end");
  const held = await store.runs.get("run-claimed");
  assert.equal(held.state, "running", "a run a runner claimed is its runner's");
  assert.equal(held.epoch, claim.epoch);
  assert.deepEqual(await store.runs.failUnclaimed(summary), [], "nothing left to fail");
  assert.equal(refusedEndMessage("run failed"), undefined);
});
