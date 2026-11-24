// The claim rule's pin (store/sqlite/store.ts claimableIn, keptElsewhere), on SQLite and, under `npm run test:pg`, on
// Postgres: a parked run whose computer was kept at its park pinned to a runner (its computer_kept row names the runner
// and its incarnation, computer-kept.ts pinnedOf) is claimable by that runner alone while that runner is there under
// that incarnation (seen within the stale time, not refusing) and the keep lasts (not ending or ended, its time ahead).
// Another runner's claim, claimMany and claimable({runner}) leave it out: nothing is claimed and given back, the epoch
// stays. Once the pin stops holding, any runner claims it. The count of what waits (no runner) still counts it. The pin
// holds a run claimable by its wake or an answering command only: an untaken stop or cancel row makes it any runner's at
// once (a person's stop never waits on a pin).
import assert from "node:assert/strict";
import { test } from "node:test";
import { queued, storeOn } from "./store-helpers.mjs";

const { KEEP_MS, keptKeyOf, readKept, takeKept, writeKept } = await import("../dist/workspace/computer-kept.js");
const { PRESENCE_STALE_MS } = await import("../dist/runner/presence.js");

const RUN = "run-1";

/** run-1 parked and released by runner-a at the store's clock, its desktop kept and pinned to runner-a's `inc-a`, woken
 *  (its wake_at now) unless `wake` is false, with runner-a's word on the store. The row is put raw, as this build's park
 *  writes it, so a store without the pin fails on its claim rule alone. */
async function pinnedParked(t, extra = {}, { wake = true } = {}) {
  const { store, clock } = await storeOn(t);
  await queued(store, RUN);
  assert.equal(await store.runners.put({ runner: "runner-a", incarnation: "inc-a", refused: null }), true);
  const claim = await store.claim(RUN, "runner-a", { leaseMs: 30_000 });
  await store.release(claim, { state: "parked" });
  await store.settings.put(keptKeyOf(RUN), { provider: "docker", kind: "desktop", id: "a-d1", name: "a-d1", epoch: claim.epoch, until: clock.now + KEEP_MS, runner: "runner-a", incarnation: "inc-a", ...extra });
  if (wake) assert.equal(await store.runs.wake(RUN), true, "woken");
  return { store, clock, epoch: (await store.runs.get(RUN)).epoch };
}

test("store: a stop or a cancel of a run kept on a live runner is any runner's at once: B's poll 0 takes it, while a woken or an answered one stays runner-a's", async (t) => {
  for (const kind of ["stop", "cancel"]) {
    const one = await pinnedParked(t, {}, { wake: false });
    await one.store.command(RUN, { kind });
    assert.deepEqual(await one.store.runs.claimable({ runner: "runner-b" }), [RUN], `B's memory path sees the ${kind}`);
    const taken = await one.store.runs.claimMany("runner-b", 1);
    assert.deepEqual(taken.map((claim) => [claim.runId, claim.runner, claim.epoch, claim.from]), [[RUN, "runner-b", one.epoch + 1, "parked"]], `B's poll 0 takes the run on its ${kind}, runner-a live and the keep in its time`);
    assert.equal((await readKept(one.store.settings, RUN))?.runner, "runner-a", `the ${kind}'s claim leaves the kept row runner-a's`);
  }
  const woken = await pinnedParked(t);
  assert.deepEqual(await woken.store.runs.claimMany("runner-b", 1), [], "a woken one stays runner-a's");
  const answered = await pinnedParked(t, {}, { wake: false });
  await answered.store.command(RUN, { kind: "steer", body: { content: "go on" } });
  assert.deepEqual(await answered.store.runs.claimMany("runner-b", 1), [], "an answered one stays runner-a's");
  assert.deepEqual((await answered.store.runs.claimMany("runner-a", 1)).map((claim) => claim.runner), ["runner-a"], "and runner-a claims it");
});

test("store: a woken run kept on a live runner is that runner's alone; B's polls claim nothing and move nothing until runner-a goes stale, then B's next poll claims it once", async (t) => {
  const one = await pinnedParked(t);
  // A live: its word renewed each second, as presence.ts renews it. B polls 100 times over 100 s of the store's clock.
  for (let poll = 0; poll < 100; poll += 1) {
    one.clock.now += 1_000;
    assert.equal(await one.store.runners.renew("runner-a", "inc-a", null), true);
    assert.deepEqual(await one.store.runs.claimMany("runner-b", 1), [], `B's poll ${poll} claims nothing`);
  }
  assert.deepEqual(await one.store.runs.claimable({ runner: "runner-b" }), [], "nor does B's memory path see it");
  assert.equal(await one.store.claim(RUN, "runner-b", { leaseMs: 30_000 }), null, "nor take it by its id");
  assert.deepEqual(await one.store.runs.claimable(), [RUN], "the count of what waits still counts it");
  assert.equal((await one.store.runs.get(RUN)).epoch, one.epoch, "nothing claimed and given back: the epoch did not move");
  // A stops: its word goes stale PRESENCE_STALE_MS later, on the store's clock. The keep is still in its time.
  one.clock.now += PRESENCE_STALE_MS + 1;
  const taken = await one.store.runs.claimMany("runner-b", 1);
  assert.deepEqual(taken.map((claim) => [claim.runId, claim.runner, claim.epoch]), [[RUN, "runner-b", one.epoch + 1]], "B's next poll claims it, once");
});

test("store: the runner the keep names claims it while it is live; a new incarnation of the same name unpins it for any runner", async (t) => {
  const live = await pinnedParked(t);
  assert.deepEqual(await live.store.runs.claimable({ runner: "runner-a" }), [RUN], "runner-a's memory path sees its own");
  const mine = await live.store.runs.claimMany("runner-a", 1);
  assert.deepEqual(mine.map((claim) => claim.runner), ["runner-a"], "runner-a claims its own");

  const restarted = await pinnedParked(t);
  // runner-a restarted under the same name: its row names another incarnation, so the machine its old one kept is not
  // its own (a dial token names the old incarnation): any runner claims.
  await restarted.store.runners.put({ runner: "runner-a", incarnation: "inc-a2", refused: null });
  const taken = await restarted.store.runs.claimMany("runner-b", 1);
  assert.deepEqual(taken.map((claim) => claim.runner), ["runner-b"], "unpinned by the new incarnation");
});

test("store: the pin ends with the keep or with its runner's refusal: a keep past its time, one ending or ended, or a refusing runner leaves the run to any runner", async (t) => {
  const past = await pinnedParked(t);
  past.clock.now += KEEP_MS;
  assert.equal(await past.store.runners.renew("runner-a", "inc-a", null), true, "runner-a still there");
  assert.deepEqual((await past.store.runs.claimMany("runner-b", 1)).map((claim) => claim.runner), ["runner-b"], "its time passed on the store's clock, though no timer marked it");

  for (const state of [{ ending: true }, { ended: true }]) {
    const over = await pinnedParked(t, state);
    assert.deepEqual((await over.store.runs.claimMany("runner-b", 1)).map((claim) => claim.runner), ["runner-b"], `kept no more: ${JSON.stringify(state)}`);
  }

  const refusing = await pinnedParked(t);
  await refusing.store.runners.put({ runner: "runner-a", incarnation: "inc-a", refused: "draining" });
  assert.deepEqual((await refusing.store.runs.claimMany("runner-b", 1)).map((claim) => claim.runner), ["runner-b"], "a runner that refuses claims nothing, so it holds nothing");

  // A row with no runner (an exec vendor's machine, a phone) pins nothing.
  const { store } = await storeOn(t);
  await queued(store, RUN);
  const claim = await store.claim(RUN, "runner-a", { leaseMs: 30_000 });
  await store.release(claim, { state: "parked" });
  await store.settings.put(keptKeyOf(RUN), { provider: "e2b", kind: "desktop", id: "e1", name: "e1", epoch: claim.epoch, until: Number.MAX_SAFE_INTEGER });
  await store.runs.wake(RUN);
  assert.deepEqual((await store.runs.claimMany("runner-b", 1)).map((one) => one.runner), ["runner-b"], "unpinned: any runner");
});

test("store: a park's keep keeps its runner and incarnation through writeKept and readKept, and the resume's compare-and-set takes it", async (t) => {
  const { store, clock } = await storeOn(t);
  const row = { provider: "docker", kind: "desktop", id: "a-d1", name: "a-d1", epoch: 2, until: clock.now + KEEP_MS, folder: "bind", runner: "runner-a", incarnation: "inc-a" };
  await writeKept(store.settings, "run-2", row);
  const read = await readKept(store.settings, "run-2");
  assert.deepEqual(read, row, "the row names the runner that holds the machine and its incarnation");
  assert.equal(await takeKept(store.settings, "run-2", read), true, "the row as read is the row as written: the resume takes it");
  assert.equal(await readKept(store.settings, "run-2"), undefined);
});
