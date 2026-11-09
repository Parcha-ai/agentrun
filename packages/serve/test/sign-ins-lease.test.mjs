// A sign-in's save lease over the store (E1b-P2: runs.update's { save }, handedHolder's settle window), ported from the
// file store's lease, gone-rule and settle cases in sign-ins.test.mjs. One run at a time saves to a sign-in: a run's bind
// (its runner writing sign_in_handed under its claim) answers save true unless another run already holds one of the
// pointers it was handed, in the same transaction. A run holds it while it runs, and for a Browserbase sign-in the settle
// window after it leaves running (its context's write-back may still be in flight); Kernel's, which saves as its browser
// ends, has none. A runner that dies never frees it: the run stays running until its claim's lease lapses, another runner
// claims the same run, and it still holds; only the run's end lets it go. All at store level, on the store's own clock: no
// process death, no waits.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { BROWSERBASE_SETTLE_MS, pointerHash, saveSignIn, signInsOverStore } from "../dist/sign-ins-store.js";
import { agentWithRevision, storeOn } from "./store-helpers.mjs";

const KEY = randomBytes(32);
const settleFor = (provider) => (provider === "browserbase" ? BROWSERBASE_SETTLE_MS : 0);
const vendors = { remove: async () => undefined };

/** A store on a moved clock, agent `alpha` with its Browserbase and Kernel sign-ins saved. */
async function signedIn(t) {
  const { store, clock } = await storeOn(t);
  await agentWithRevision(store, "alpha", "alpha-rev");
  for (const [provider, pointer] of [["browserbase", "bb-ctx-lease-1"], ["kernel", "agentrun-lease-1"]]) await saveSignIn(store, KEY, { agentId: "alpha", provider, pointer });
  return { store, clock };
}

/** Run `runId` of alpha, created and claimed by `runner` (its claim's lease `leaseMs`). */
async function claimed(store, runId, runner = "runner-1", leaseMs = 60_000) {
  await store.runs.create({ id: runId, agentId: "alpha", revisionId: "alpha-rev" });
  const claim = await store.claim(runId, runner, { leaseMs });
  assert.ok(claim, `${runId} is claimable`);
  return claim;
}

/** A run's bind at its claim, as the runner makes it: the hash of each pointer handed, written under the claim, and
 *  whether this run saves (runs.update's { save }, decided in the same transaction). */
const bind = async (store, claim, provider, pointer) => (await store.runs.update(claim, { signInHanded: [pointerHash(pointer)] }, { signInSettleMs: settleFor(provider) })).save;

/** The agent's sign-ins as the owner sees them: [provider, state, held_by]. */
const seen = async (store) => (await signInsOverStore(store, KEY, vendors).view("alpha")).map((s) => [s.provider, s.state, s.held_by]);

// sign-ins.test.mjs: "the save lease: the first run takes it, a run started while it holds gets the same sign-in with save
// false, and it ends with its run (released, or its run ended without a release)".
test("the first run to bind a sign-in saves; one bound while it runs gets the same sign-in to read, saving nothing; the lease ends with its run", async (t) => {
  const { store, clock } = await signedIn(t);
  const one = await claimed(store, "run-1");
  assert.equal(await bind(store, one, "kernel", "agentrun-lease-1"), true, "the first saves");
  const two = await claimed(store, "run-2");
  assert.equal(await bind(store, two, "kernel", "agentrun-lease-1"), false, "one bound meanwhile saves nothing");
  assert.deepEqual(await seen(store), [["browserbase", "ready", null], ["kernel", "held", "run-1"]]);
  // Kernel saves as its browser ends: run-1's end lets it go at once (no settle window), and the next bind saves.
  await store.runs.update(one, { state: "ended" });
  assert.deepEqual(await seen(store), [["browserbase", "ready", null], ["kernel", "held", "run-2"]], "run-2 still runs, handed it");
  await store.runs.update(two, { state: "ended" });
  clock.now += 1;
  assert.deepEqual(await seen(store), [["browserbase", "ready", null], ["kernel", "ready", null]]);
  assert.equal(await bind(store, await claimed(store, "run-3"), "kernel", "agentrun-lease-1"), true);
});

// sign-ins.test.mjs: "a Browserbase lease whose holder's process is gone outlasts the longest session it could have opened
// by that session's write-back; Kernel's, which saves as its browser ends, does not", "a Browserbase saver resumed while
// its own last save is still being written back waits that out before it saves again".
test("a Browserbase sign-in stays held for its settle window after its saver leaves running, so no run saves over a write-back in flight; Kernel's frees at once", async (t) => {
  const { store, clock } = await signedIn(t);
  // A run's browser is on one vendor: run-1 on Browserbase, run-k on Kernel.
  const saver = await claimed(store, "run-1");
  assert.equal(await bind(store, saver, "browserbase", "bb-ctx-lease-1"), true);
  const kernelSaver = await claimed(store, "run-k");
  assert.equal(await bind(store, kernelSaver, "kernel", "agentrun-lease-1"), true);
  await store.runs.update(saver, { state: "ended" });
  await store.runs.update(kernelSaver, { state: "ended" });
  // A second short of Browserbase's window: still held by run-1, and a run bound now saves nothing; Kernel's is free.
  clock.now += BROWSERBASE_SETTLE_MS - 1;
  assert.deepEqual(await seen(store), [["browserbase", "held", "run-1"], ["kernel", "ready", null]]);
  const early = await claimed(store, "run-2");
  assert.equal(await bind(store, early, "browserbase", "bb-ctx-lease-1"), false, "a second short of its write-back");
  assert.equal(await bind(store, await claimed(store, "run-k2"), "kernel", "agentrun-lease-1"), true, "Kernel's has no window");
  await store.runs.update(early, { state: "ended" });
  // Past the window (and past the reader's, which the store counts alike: see the todo case below): it saves.
  clock.now += BROWSERBASE_SETTLE_MS;
  assert.deepEqual((await seen(store))[0], ["browserbase", "ready", null]);
  assert.equal(await bind(store, await claimed(store, "run-3"), "browserbase", "bb-ctx-lease-1"), true);
});

// sign-ins.test.mjs: "a run's save lease outlives its process until the run ends …", "a lease whose holder's process is
// gone lasts no longer than a session it opened could …", "a run's end lets its lease go only when its process let its
// sessions go: after a crash the lease stays with it, by the gone rule".
test("a runner that dies never frees the save: its run stays running past its claim's lapse, the next runner claims the same run, which still holds it; only the run's end lets it go", async (t) => {
  const { store, clock } = await signedIn(t);
  const first = await claimed(store, "run-1", "runner-1", 1_000);
  assert.equal(await bind(store, first, "browserbase", "bb-ctx-lease-1"), true);
  // runner-1 dies: nothing is released, and its claim's lease lapses on the store's clock.
  clock.now += 60 * 60_000;
  assert.equal((await store.runs.get("run-1")).state, "running", "its run stays running");
  assert.deepEqual((await seen(store))[0], ["browserbase", "held", "run-1"], "a dead runner frees nothing, however long ago");
  // runner-2 takes the lapsed claim: the same run, a new epoch, and its bind still saves (its own lease).
  const [again] = await store.runs.claimMany("runner-2", 5);
  assert.equal(again?.runId, "run-1", "the next runner claims the same run");
  assert.ok(again.epoch > first.epoch);
  assert.equal(await bind(store, again, "browserbase", "bb-ctx-lease-1"), true, "it still holds it");
  const other = await claimed(store, "run-2", "runner-2");
  assert.equal(await bind(store, other, "browserbase", "bb-ctx-lease-1"), false, "no other run saves over it");
  // A run that stops or fails frees it as an ended one does: after the window.
  await store.runs.update(again, { state: "failed" });
  assert.deepEqual((await seen(store))[0], ["browserbase", "held", "run-1"], "its write-back may still be in flight");
  clock.now += BROWSERBASE_SETTLE_MS;
  await store.runs.update(other, { state: "ended" });
  clock.now += BROWSERBASE_SETTLE_MS;
  assert.deepEqual((await seen(store))[0], ["browserbase", "ready", null]);
});

// The saver's own lease across a relaunch while a reader runs (main: held_by stays the saver's; a relaunch saves again).
// Over the store, a run's sign_in_handed doesn't say whether it saves, so a reader handed the same pointer reads as a
// holder, and the saver's own re-bind (a relaunch, or the next runner's claim of it) is answered save false. No two runs
// ever save: this errs toward none. A reader's end also opens a settle window, though it wrote nothing back. The store
// keeps no saver per sign-in for the bind to tell them apart (E1b's runs.update
// { save }); it waits on that.
test("a saver's re-bind while a reader of the same sign-in runs still saves (its own lease)", { skip: "waits on runs.update { save } telling a saver from a reader (E1b): a reader's hand blocks the saver's own re-bind today" }, async (t) => {
  const { store } = await signedIn(t);
  const saver = await claimed(store, "run-1");
  assert.equal(await bind(store, saver, "kernel", "agentrun-lease-1"), true);
  assert.equal(await bind(store, await claimed(store, "run-2"), "kernel", "agentrun-lease-1"), false, "the reader saves nothing");
  assert.equal(await bind(store, saver, "kernel", "agentrun-lease-1"), true, "the saver's own re-bind keeps saving");
});
