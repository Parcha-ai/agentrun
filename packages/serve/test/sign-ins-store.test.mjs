// An agent's saved browser sign-ins over the one store (sign-ins-store.ts, the E1 store half): the pointer is sealed at
// rest, bound to its agent and provider, and opens for that agent alone; the owner's view never holds it; forgetting it
// moves it to a tombstone (newest 32 kept) and is refused while a running run was handed it; a pointer that does not open
// is `unreadable`. Ported from serve/test/sign-ins.test.mjs, over the store (the lease and Browserbase-settle rules move to
// E2's run path). A real store on a temp file.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import {
  forgetSignIn, forgottenPointers, handedTo, openSavedPointer, pointerHash, savedSignIns, saveSignIn, signInsOverStore, SignInHandedTo, SignInMissing,
} from "../dist/sign-ins-store.js";
import { ApiError } from "../dist/errors.js";
import { agentWithRevision, storeOn } from "./store-helpers.mjs";

const KEY = randomBytes(32);
/** A vendor port that records removals, or refuses them. */
function fakeVendors({ refuse = false } = {}) {
  const removed = [];
  return { removed, remove: async (provider, pointer) => { if (refuse) throw new Error(`${provider} answered 500`); removed.push([provider, pointer]); } };
}
/** A running run of the agent, handed `hashes` the way the runner writes them: at its claim, via runs.update under the
 *  claim's epoch fence. Returns the run id and the held claim (to end the run later; a running run cannot be re-claimed). */
async function runningRun(store, { agentId = "alpha", runId = "run-1", hashes = [] } = {}) {
  if (!(await store.agents.get(agentId))) await agentWithRevision(store, agentId, `${agentId}-rev`);
  await store.runs.create({ id: runId, agentId, revisionId: `${agentId}-rev` });
  const claim = await store.claim(runId, "runner-1");
  assert.ok(claim, "the run is claimable");
  if (hashes.length) await store.runs.update(claim, { signInHanded: hashes });
  return { runId, claim };
}

test("a pointer is sealed at rest, bound to its agent and provider, and opens for that agent alone; the view never holds it", async (t) => {
  const { store } = await storeOn(t);
  await agentWithRevision(store, "alpha", "alpha-rev");
  const saved = await saveSignIn(store, KEY, { agentId: "alpha", provider: "browserbase", pointer: "ctx-123" });
  assert.deepEqual([saved.name, saved.provider, saved.state], ["default", "browserbase", "ready"]);
  const row = await store.signIns.get("alpha", "browserbase");
  assert.ok(!Buffer.from(row.pointerSealed).toString("utf8").includes("ctx-123"), "sealed at rest");
  assert.deepEqual(await openSavedPointer(store, KEY, "alpha", "browserbase"), { pointer: "ctx-123" }, "opens for its agent");
  // The same sealed bytes under another agent's binding do not open.
  await agentWithRevision(store, "beta", "beta-rev");
  await store.signIns.save({ agentId: "beta", provider: "browserbase", name: "default", pointerSealed: row.pointerSealed });
  assert.equal(await openSavedPointer(store, KEY, "beta", "browserbase"), "unreadable", "another agent's copy does not open");
  // Nor under another seal key.
  assert.equal(await openSavedPointer(store, randomBytes(32), "alpha", "browserbase"), "unreadable");
  const views = await savedSignIns(store, KEY, "alpha");
  assert.deepEqual(views, [{ name: "default", provider: "browserbase", saved_at: saved.saved_at, state: "ready" }]);
  assert.ok(!JSON.stringify(views).includes("ctx-123"), "the view never holds the pointer");
});

test("one live sign-in per agent and provider: a second save replaces it in place", async (t) => {
  const { store, clock } = await storeOn(t);
  await agentWithRevision(store, "alpha", "alpha-rev");
  await saveSignIn(store, KEY, { agentId: "alpha", provider: "browserbase", pointer: "ctx-1" });
  clock.now += 10;
  const again = await saveSignIn(store, KEY, { agentId: "alpha", provider: "browserbase", pointer: "ctx-2" });
  assert.equal((await store.signIns.list("alpha")).length, 1, "one row");
  assert.deepEqual(await openSavedPointer(store, KEY, "alpha", "browserbase"), { pointer: "ctx-2" });
  assert.equal(again.saved_at, clock.now, "saved_at moved");
});

test("unreadable: a sign-in whose pointer does not open under this server's seal key is the owner's unreadable state", async (t) => {
  const { store } = await storeOn(t);
  await agentWithRevision(store, "alpha", "alpha-rev");
  await saveSignIn(store, KEY, { agentId: "alpha", provider: "browserbase", pointer: "ctx-1" });
  // A server with another seal key (or none) sees it as unreadable, never its pointer.
  for (const key of [randomBytes(32), undefined]) {
    assert.deepEqual((await savedSignIns(store, key, "alpha"))[0].state, "unreadable");
    assert.equal(await openSavedPointer(store, key, "alpha", "browserbase"), "unreadable");
  }
  assert.equal(await openSavedPointer(store, KEY, "alpha", "nope"), undefined, "no sign-in for a provider is told from unreadable");
});

test("forget moves the pointer to a sealed tombstone and removes it at the vendor; a missing sign-in is SignInMissing", async (t) => {
  const { store } = await storeOn(t);
  await agentWithRevision(store, "alpha", "alpha-rev");
  await saveSignIn(store, KEY, { agentId: "alpha", provider: "browserbase", pointer: "ctx-1" });
  const vendors = fakeVendors();
  const out = await forgetSignIn(store, KEY, vendors, "alpha", "browserbase");
  assert.deepEqual(out, { provider: "browserbase", at_vendor: "deleted" });
  assert.deepEqual(vendors.removed, [["browserbase", "ctx-1"]], "removed at the vendor");
  assert.equal(await store.signIns.get("alpha", "browserbase"), undefined, "the live row is gone");
  // Its pointer is kept sealed in a tombstone, and still opens (for cutting from a run it was handed).
  const gone = await forgottenPointers(store, KEY, "alpha", "browserbase");
  assert.deepEqual(gone, { pointers: ["ctx-1"], unreadable: false });
  await assert.rejects(forgetSignIn(store, KEY, vendors, "alpha", "browserbase"), (e) => e instanceof SignInMissing);
});

test("a vendor that refuses the delete is reported, and this server forgets it anyway", async (t) => {
  const { store } = await storeOn(t);
  await agentWithRevision(store, "alpha", "alpha-rev");
  await saveSignIn(store, KEY, { agentId: "alpha", provider: "browserbase", pointer: "ctx-1" });
  const out = await forgetSignIn(store, KEY, fakeVendors({ refuse: true }), "alpha", "browserbase");
  assert.equal(out.at_vendor, "not_deleted");
  assert.match(out.message, /Not deleted at browserbase/);
  assert.equal(await store.signIns.get("alpha", "browserbase"), undefined, "forgotten here even so");
});

test("forget is refused while a running run was handed the sign-in's pointer; it goes once that run is no longer running", async (t) => {
  const { store } = await storeOn(t);
  await agentWithRevision(store, "alpha", "alpha-rev");
  await saveSignIn(store, KEY, { agentId: "alpha", provider: "browserbase", pointer: "ctx-1" });
  const hash = pointerHash("ctx-1");
  const { runId, claim } = await runningRun(store, { hashes: [hash] });
  assert.equal(await handedTo(store, hash), runId, "the running run holds the hash");
  const err = await forgetSignIn(store, KEY, fakeVendors(), "alpha", "browserbase").then(() => null, (e) => e);
  assert.ok(err instanceof SignInHandedTo && err.runId === runId, "refused while handed");
  assert.ok(await store.signIns.get("alpha", "browserbase"), "nothing written: the live row stays");
  // The run ends (its runner releases the claim it holds); the hold is gone, and forget succeeds.
  await store.release(claim, { state: "ended" });
  assert.equal(await handedTo(store, hash), undefined);
  const out = await forgetSignIn(store, KEY, fakeVendors(), "alpha", "browserbase");
  assert.equal(out.at_vendor, "deleted");
});

test("an unreadable sign-in is refused forget while any running run was handed a sign-in; its tombstone keeps the sealed bytes", async (t) => {
  const { store } = await storeOn(t);
  await agentWithRevision(store, "alpha", "alpha-rev");
  await saveSignIn(store, KEY, { agentId: "alpha", provider: "browserbase", pointer: "ctx-1" });
  // Forget under another key: the pointer does not open, so any running run handed a sign-in blocks it.
  const other = randomBytes(32);
  const { runId, claim } = await runningRun(store, { runId: "run-x", hashes: [pointerHash("whatever")] });
  const err = await forgetSignIn(store, other, fakeVendors(), "alpha", "browserbase").then(() => null, (e) => e);
  assert.ok(err instanceof SignInHandedTo && err.runId === runId, "an unreadable pointer is refused while any run was handed one");
  // With no running handed run, forget of the unreadable sign-in goes; its sealed bytes are kept in the tombstone.
  await store.release(claim, { state: "ended" });
  const out = await forgetSignIn(store, other, fakeVendors(), "alpha", "browserbase");
  assert.equal(out.at_vendor, "not_deleted", "its object could not be deleted (the pointer never opened)");
  const gone = await forgottenPointers(store, KEY, "alpha", "browserbase");
  assert.deepEqual(gone, { pointers: ["ctx-1"], unreadable: false }, "the tombstone keeps the sealed bytes, which open under the right key");
});

test("the newest 32 forgotten pointers per agent are kept, the oldest dropped first", async (t) => {
  const { store } = await storeOn(t);
  await agentWithRevision(store, "alpha", "alpha-rev");
  for (let i = 0; i < 35; i++) {
    await saveSignIn(store, KEY, { agentId: "alpha", provider: `p${i}`, pointer: `ctx-${i}` });
    await forgetSignIn(store, KEY, fakeVendors(), "alpha", `p${i}`);
  }
  const kept = [];
  for (let i = 0; i < 35; i++) kept.push(...(await store.signIns.tombstones("alpha", `p${i}`)));
  assert.equal(kept.length, 32, "32 kept across providers");
  const providers = new Set(kept.map((t) => t.provider));
  assert.ok(!providers.has("p0") && !providers.has("p2"), "the oldest dropped");
  assert.ok(providers.has("p34"), "the newest kept");
});

test("a ':' in the agent or the provider is refused", async (t) => {
  const { store } = await storeOn(t);
  await assert.rejects(saveSignIn(store, KEY, { agentId: "a:b", provider: "browserbase", pointer: "x" }), /never hold ":"/);
  await assert.rejects(saveSignIn(store, KEY, { agentId: "alpha", provider: "a:b", pointer: "x" }), /never hold ":"/);
});

// The view bridge: the old SignIns shapes (view/peek/forgotten/forget), byte for byte, so the v2 API answers unchanged.

test("signInsOverStore.view: the old SignInView shape; ready, then held/held_by while a live run holds the hash, and verified_at from the store", async (t) => {
  const { store, clock } = await storeOn(t);
  await agentWithRevision(store, "alpha", "alpha-rev");
  await saveSignIn(store, KEY, { agentId: "alpha", provider: "browserbase", pointer: "ctx-1" });
  const bridge = signInsOverStore(store, KEY, fakeVendors());
  assert.deepEqual(await bridge.view("alpha"), [{ key: "default", provider: "browserbase", state: "ready", held_by: null, verified_at: null }]);
  // A live run handed the pointer's hash: held, held_by names it.
  const { runId, claim } = await runningRun(store, { hashes: [pointerHash("ctx-1")] });
  assert.deepEqual(await bridge.view("alpha"), [{ key: "default", provider: "browserbase", state: "held", held_by: runId, verified_at: null }]);
  assert.ok(!JSON.stringify(await bridge.view("alpha")).includes("ctx-1"), "the view never holds the pointer");
  // A run verifies it (E2's run path through store.signIns.verify): verified_at shows that time, as ISO.
  clock.now += 1000;
  await store.signIns.verify("alpha", "browserbase", clock.now);
  await store.release(claim, { state: "ended" });
  assert.deepEqual(await bridge.view("alpha"), [{ key: "default", provider: "browserbase", state: "ready", held_by: null, verified_at: new Date(clock.now).toISOString() }]);
});

test("signInsOverStore.view: an unreadable sign-in reads unreadable with held_by null; peek and forgotten carry the old shapes", async (t) => {
  const { store } = await storeOn(t);
  await agentWithRevision(store, "alpha", "alpha-rev");
  await saveSignIn(store, KEY, { agentId: "alpha", provider: "browserbase", pointer: "ctx-1" });
  const other = signInsOverStore(store, randomBytes(32), fakeVendors());
  assert.deepEqual(await other.view("alpha"), [{ key: "default", provider: "browserbase", state: "unreadable", held_by: null, verified_at: null }]);
  // peek maps a browser resolution to { ref } / "unreadable" / undefined.
  const bridge = signInsOverStore(store, KEY, fakeVendors());
  assert.deepEqual(await bridge.peek("alpha", "browserbase"), { ref: "ctx-1" });
  assert.equal(await other.peek("alpha", "browserbase"), "unreadable");
  assert.equal(await bridge.peek("alpha", "chrome"), undefined, "a local Chrome keeps none");
  assert.equal(await bridge.peek("alpha", "kernel"), undefined, "no kernel sign-in here");
});

test("signInsOverStore.forget: the old {key, removed} shape; 404 for an unknown key; 409 sign_in_held while handed; forgotten lists the tombstone", async (t) => {
  const { store } = await storeOn(t);
  await agentWithRevision(store, "alpha", "alpha-rev");
  await saveSignIn(store, KEY, { agentId: "alpha", provider: "browserbase", pointer: "ctx-1" });
  const vendors = fakeVendors();
  const bridge = signInsOverStore(store, KEY, vendors);
  // 409 while a live run holds it, nothing removed.
  const held = await runningRun(store, { hashes: [pointerHash("ctx-1")] });
  const refused = await bridge.forget("alpha", "default").then(() => null, (e) => e);
  assert.ok(refused instanceof ApiError && refused.code === "sign_in_held" && refused.extra.details.handed_to === held.runId, "409 sign_in_held with handed_to (ApiError.extra.details, which the v2 body spreads)");
  assert.deepEqual(vendors.removed, [], "nothing removed while held");
  // The run ends; forget returns the old shape and the vendor object is deleted.
  await store.release(held.claim, { state: "ended" });
  assert.deepEqual(await bridge.forget("alpha", "default"), { key: "default", removed: [{ provider: "browserbase", at_vendor: "deleted" }] });
  assert.deepEqual(vendors.removed, [["browserbase", "ctx-1"]]);
  assert.deepEqual(await bridge.forgotten("alpha", "browserbase"), { refs: ["ctx-1"], unreadable: false });
  // 404 when the agent has no sign-in by that key.
  await assert.rejects(bridge.forget("alpha", "default"), (e) => e instanceof ApiError && e.code === "not_found");
});

// P2-1 the save race: runs.update(claim, { signInHanded }) decides this run's save lease in the same transaction as the
// sign_in_handed write, so two binds of one agent's sign-in claimed in one tick never both save (and clobber one browser
// context). It answers { save } with the row: true for the one run that holds the lease, false for the rest.

/** Two queued runs of one agent, each claimed by its own runner (a running run cannot be re-claimed). */
async function twoRunning(store) {
  await agentWithRevision(store, "alpha", "alpha-rev");
  for (const id of ["run-a", "run-b"]) await store.runs.create({ id, agentId: "alpha", revisionId: "alpha-rev" });
  return [await store.claim("run-a", "runner-a"), await store.claim("run-b", "runner-b")];
}

test("P2-1 two binds of one sign-in at once: exactly one gets save:true, decided in the write's own transaction", async (t) => {
  const { store } = await storeOn(t);
  const [claimA, claimB] = await twoRunning(store);
  const hash = pointerHash("ctx-1");
  // Both binds in flight at once (the store serializes their transactions): because the save lease is decided in the same
  // transaction as each sign_in_handed write, one reads no other holder (save:true) and the other reads the first
  // (save:false) — never both. A read-then-write bind would let both reads see no holder and both save.
  const rows = await Promise.all([
    store.runs.update(claimA, { signInHanded: [hash] }),
    store.runs.update(claimB, { signInHanded: [hash] }),
  ]);
  const saves = rows.map((row) => row.save);
  assert.equal(saves.filter((save) => save === true).length, 1, `exactly one save:true, got ${JSON.stringify(saves)}`);
  assert.equal(saves.filter((save) => save === false).length, 1, "the other reads the first as the holder and does not save");
});

test("P2-1 a sole binder saves; its own re-bind (a later claim of the same run) saves again, never blocked by itself", async (t) => {
  const { store, clock } = await storeOn(t);
  await agentWithRevision(store, "alpha", "alpha-rev");
  await store.runs.create({ id: "run-a", agentId: "alpha", revisionId: "alpha-rev" });
  const hash = pointerHash("ctx-1");
  const first = await store.claim("run-a", "runner-a", { leaseMs: 1_000 });
  assert.equal((await store.runs.update(first, { signInHanded: [hash] })).save, true, "the only run holding it saves");
  // The claim runs out and the same run is re-claimed: its own earlier hold must not block its save.
  clock.now += 2_000;
  const again = await store.claim("run-a", "runner-a");
  assert.equal((await store.runs.update(again, { signInHanded: [hash] })).save, true, "a run is never its own blocker");
});
