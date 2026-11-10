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
import { agentWithRevision, storeOn, T0 } from "./store-helpers.mjs";

const KEY = randomBytes(32);
/** The secret a sign-in of alpha's saved at T0 for Browserbase carries beside the old view's fields (sign-ins-secrets.ts). */
const META = { secret: { name: "sign-in:alpha:browserbase", set: true, source: "sign-in", changed_at: new Date(T0).toISOString() } };
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

// A first sign-in made twice at once (two runs' first creates for one agent, each with a vendor object of its own): exactly
// one row wins, and the other is handed the winner's row back, never its own, so its caller can let its own vendor object
// go and use the winner's. A plain save would replace the first pointer in place, leaving its vendor object (cookies)
// held by no row, and the run handed it would find nothing that opens.
test("two first creates of one agent's sign-in race: exactly one row wins, and the loser is handed the winner's row back", async (t) => {
  const { store } = await storeOn(t);
  await agentWithRevision(store, "alpha", "alpha-rev");
  const sealedA = Uint8Array.from([1, 1, 1]);
  const sealedB = Uint8Array.from([2, 2, 2]);
  const [a, b] = await Promise.all([
    store.signIns.saveIfAbsent({ agentId: "alpha", provider: "browserbase", name: "default", pointerSealed: sealedA }),
    store.signIns.saveIfAbsent({ agentId: "alpha", provider: "browserbase", name: "default", pointerSealed: sealedB }),
  ]);
  assert.deepEqual([a.saved, b.saved].sort(), [false, true], `exactly one saved: ${JSON.stringify([a.saved, b.saved])}`);
  const [winner, loser] = a.saved ? [a, b] : [b, a];
  const kept = await store.signIns.get("alpha", "browserbase");
  assert.deepEqual([...kept.pointerSealed], [...winner.row.pointerSealed], "the store keeps the winner's pointer");
  assert.deepEqual([...loser.row.pointerSealed], [...winner.row.pointerSealed], "the loser is handed the winner's row, not its own");
  assert.equal((await store.signIns.list("alpha")).length, 1, "one row");
  // Once one is saved, a later saveIfAbsent saves nothing and hands the live row back.
  const later = await store.signIns.saveIfAbsent({ agentId: "alpha", provider: "browserbase", name: "default", pointerSealed: Uint8Array.from([3]) });
  assert.equal(later.saved, false);
  assert.deepEqual([...later.row.pointerSealed], [...winner.row.pointerSealed]);
});

// verify's guard is the save it was checked against, by number (SignInRow.save, one more on every save of the row), never
// its saved_at: two saves can land in one millisecond, and a guard on saved_at would stamp the newer one as verified.
test("a verify guarded by the save it checked never stamps a newer save, even one in the same millisecond", async (t) => {
  const { store } = await storeOn(t);
  await agentWithRevision(store, "alpha", "alpha-rev");
  const first = await store.signIns.save({ agentId: "alpha", provider: "browserbase", name: "default", pointerSealed: Uint8Array.from([1]) });
  // The store's clock does not move: the re-save lands in the same millisecond.
  const again = await store.signIns.save({ agentId: "alpha", provider: "browserbase", name: "default", pointerSealed: Uint8Array.from([2]) });
  assert.equal(again.savedAt, first.savedAt, "both saves in one millisecond");
  const stale = await store.signIns.verify("alpha", "browserbase", first.savedAt + 1, { ifSave: first.save });
  assert.equal(stale, false, "guarded by the first save, verify stamps nothing");
  assert.equal((await store.signIns.get("alpha", "browserbase")).verifiedAt, null, "the newer save stays unverified");
  assert.notEqual(again.save, first.save, "each save has a number of its own");
  assert.equal(await store.signIns.verify("alpha", "browserbase", first.savedAt + 2, { ifSave: again.save }), true, "guarded by the live save, it stamps");
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
  await store.runs.update(claim, { state: "ended" });
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
  await store.runs.update(claim, { state: "ended" });
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

test("signInsOverStore.view: the old SignInView shape and the secret metadata; ready, then held/held_by while a live run holds the hash, and verified_at from the store", async (t) => {
  const { store, clock } = await storeOn(t);
  await agentWithRevision(store, "alpha", "alpha-rev");
  await saveSignIn(store, KEY, { agentId: "alpha", provider: "browserbase", pointer: "ctx-1" });
  const bridge = signInsOverStore(store, KEY, fakeVendors());
  assert.deepEqual(await bridge.view("alpha"), [{ key: "default", provider: "browserbase", state: "ready", held_by: null, verified_at: null, ...META }]);
  // A live run handed the pointer's hash: held, held_by names it.
  const { runId, claim } = await runningRun(store, { hashes: [pointerHash("ctx-1")] });
  assert.deepEqual(await bridge.view("alpha"), [{ key: "default", provider: "browserbase", state: "held", held_by: runId, verified_at: null, ...META }]);
  assert.ok(!JSON.stringify(await bridge.view("alpha")).includes("ctx-1"), "the view never holds the pointer");
  // A run verifies it (E2's run path through store.signIns.verify): verified_at shows that time, as ISO.
  clock.now += 1000;
  const verifiedAt = clock.now;
  await store.signIns.verify("alpha", "browserbase", verifiedAt);
  await store.runs.update(claim, { state: "ended" });
  // Browserbase keeps its save lease the settle window past the run's end (the context is still being written back): the
  // view matches, staying held and named by that run until the window passes, then ready.
  assert.deepEqual(await bridge.view("alpha"), [{ key: "default", provider: "browserbase", state: "held", held_by: runId, verified_at: new Date(verifiedAt).toISOString(), ...META }]);
  clock.now += 10_000 + 1; // past BROWSERBASE_SETTLE_MS
  assert.deepEqual(await bridge.view("alpha"), [{ key: "default", provider: "browserbase", state: "ready", held_by: null, verified_at: new Date(verifiedAt).toISOString(), ...META }]);
});

test("signInsOverStore.view: an unreadable sign-in reads unreadable with held_by null; peek and forgotten carry the old shapes", async (t) => {
  const { store } = await storeOn(t);
  await agentWithRevision(store, "alpha", "alpha-rev");
  await saveSignIn(store, KEY, { agentId: "alpha", provider: "browserbase", pointer: "ctx-1" });
  const other = signInsOverStore(store, randomBytes(32), fakeVendors());
  assert.deepEqual(await other.view("alpha"), [{ key: "default", provider: "browserbase", state: "unreadable", held_by: null, verified_at: null, ...META }]);
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
  await store.runs.update(held.claim, { state: "ended" });
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

// Stale verify: signIns.verify(agentId, provider, at, { ifSave }) stamps verified_at only while the sign-in is still the
// save the caller saw (SignInRow.save; a save that landed since, allowed while held, clears verified_at and must never be
// re-stamped stale). It answers whether it stamped a row.

test("a verify guarded by the save it checked: a re-save between a run's check and its verify is never stamped stale", async (t) => {
  const { store, clock } = await storeOn(t);
  await agentWithRevision(store, "alpha", "alpha-rev");
  await saveSignIn(store, KEY, { agentId: "alpha", provider: "browserbase", pointer: "ctx-1" });
  const first = await store.signIns.get("alpha", "browserbase");
  // A second save lands (a new pointer; it clears verified_at and numbers itself on).
  clock.now += 10;
  await saveSignIn(store, KEY, { agentId: "alpha", provider: "browserbase", pointer: "ctx-2" });
  const again = await store.signIns.get("alpha", "browserbase");
  assert.equal(again.save, first.save + 1, "the re-save numbered itself on");
  // A run verifies against the save it saw (the first): it must not stamp the re-saved sign-in.
  clock.now += 10;
  const stale = await store.signIns.verify("alpha", "browserbase", clock.now, { ifSave: first.save });
  assert.equal(stale, false, "guarded by the old save, verify stamps nothing");
  assert.equal((await store.signIns.get("alpha", "browserbase")).verifiedAt, null, "verified_at stays null for the re-saved sign-in");
  // Against the live save it stamps, and answers true.
  const when = clock.now;
  const ok = await store.signIns.verify("alpha", "browserbase", when, { ifSave: again.save });
  assert.equal(ok, true, "the live save stamps it");
  assert.equal((await store.signIns.get("alpha", "browserbase")).verifiedAt, when);
  // No ifSave stamps unconditionally, as the plain call always did; a missing sign-in answers false.
  assert.equal(await store.signIns.verify("alpha", "browserbase", when + 1), true, "an unguarded verify still stamps");
  assert.equal(await store.signIns.verify("alpha", "nope", when), false, "a sign-in the agent does not have stamps nothing");
});

// P2-4 Browserbase settle hold (main parity): Browserbase writes a saved context back after its session ends, so the
// saver's save lease must outlast the run leaving 'running' (ended OR parked) by BROWSERBASE_SETTLE_MS, or the next run
// saves over a write-back in flight. Other vendors free the lease the instant the run leaves running. The settle window is
// the serve layer's policy, passed to the store as signInSettleMs; the store stays vendor-agnostic.
const SETTLE_MS = 10_000; // = sign-ins-store.ts's BROWSERBASE_SETTLE_MS (main's value)

/** A fresh store where "holder" binds the sign-in then leaves running (ends or parks); `offset` ms later on the store clock
 *  "next" binds the same sign-in under `settleMs`. Answers next's save. */
async function bindAfterHolderLeft(t, { offset, park = false, settleMs = SETTLE_MS }) {
  const { store, clock } = await storeOn(t);
  await agentWithRevision(store, "alpha", "alpha-rev");
  const hash = pointerHash("ctx-1");
  await store.runs.create({ id: "holder", agentId: "alpha", revisionId: "alpha-rev" });
  const held = await store.claim("holder", "runner-h");
  assert.equal((await store.runs.update(held, { signInHanded: [hash] }, { signInSettleMs: settleMs })).save, true, "the first holder saves");
  // The holder leaves 'running': a park through release, an end through the end commit (a release never makes a run final).
  if (park) await store.release(held, { state: "parked" });
  else await store.runs.update(held, { state: "ended" });
  clock.now += offset;
  await store.runs.create({ id: "next", agentId: "alpha", revisionId: "alpha-rev" });
  const next = await store.claim("next", "runner-n");
  return (await store.runs.update(next, { signInHanded: [hash] }, { signInSettleMs: settleMs })).save;
}

test("P2-4 Browserbase settle: a bind within the window of a just-ended holder does not save; after it, it does", async (t) => {
  assert.equal(await bindAfterHolderLeft(t, { offset: 1 }), false, "+1ms: a context write-back may be in flight, so no save");
  assert.equal(await bindAfterHolderLeft(t, { offset: SETTLE_MS + 1 }), true, "+SETTLE+1ms: settled, the next run saves");
});

test("P2-4 the settle hold covers a park too, not only an end", async (t) => {
  assert.equal(await bindAfterHolderLeft(t, { offset: 1, park: true }), false, "+1ms after a park: still settling");
  assert.equal(await bindAfterHolderLeft(t, { offset: SETTLE_MS + 1, park: true }), true, "+SETTLE+1ms after a park: freed");
});

test("P2-4 other vendors keep no settle window: the save lease frees the instant the holder leaves running", async (t) => {
  assert.equal(await bindAfterHolderLeft(t, { offset: 1, settleMs: 0 }), true, "no settle: a bind right after the holder ends saves");
});
