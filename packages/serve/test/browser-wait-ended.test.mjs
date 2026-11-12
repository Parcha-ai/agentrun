// The Screen tab's ended state (browser-wait-ended.ts, computer-view.ts): a going run's browser let go while it waited
// for its person says so, with when, until any new session of the run opens; a poll reads one settings row, never the
// run's journal; any other `none` says nothing more.
import assert from "node:assert/strict";
import { test } from "node:test";
import { clearWaitEnded, markWaitEnded, readWaitEnded, screenWaitEnded } from "../dist/browser-wait-ended.js";
import { computerView } from "../dist/computer-view.js";
import { personHands } from "../dist/browser-person.js";

/** A store seam over a Map, counting settings reads; its journal throws if anything reads it. */
function storeOf() {
  const rows = new Map();
  const reads = { settings: 0 };
  return {
    rows, reads,
    settings: {
      get: async (key) => { reads.settings += 1; return rows.get(key); },
      put: async (key, value) => void rows.set(key, value),
      remove: async (key) => void rows.delete(key),
    },
    readJournal: () => { throw new Error("a Screen poll read the run's journal"); },
  };
}

const ENDED = { at: "2026-11-11T14:26:00.000Z", why: "The browser was released after 15 min waiting for you" };

test("a claim's clear leaves a later claim's message: a follow-up on another runner keeps its own", async () => {
  const store = storeOf();
  await markWaitEnded(store.settings, "run-e", ENDED, 3);
  assert.deepEqual(await readWaitEnded(store.settings, "run-e"), ENDED, "the epoch is not part of what the Screen reads");
  await clearWaitEnded(store.settings, "run-e", 2);
  assert.deepEqual(await readWaitEnded(store.settings, "run-e"), ENDED, "an earlier claim's end leaves a later claim's message");
  await clearWaitEnded(store.settings, "run-e", 3);
  assert.equal(await readWaitEnded(store.settings, "run-e"), undefined, "its own claim's end clears it");
});

test("marked as the wait ends, read back for the run, and gone once any new session of the run opens", async () => {
  const store = storeOf();
  assert.equal(await readWaitEnded(store.settings, "run-a"), undefined);
  await markWaitEnded(store.settings, "run-a", ENDED);
  assert.deepEqual(await readWaitEnded(store.settings, "run-a"), ENDED);
  assert.equal(await readWaitEnded(store.settings, "run-b"), undefined, "another run's browser is not this one's");
  // The answer's claim opens a browser: whatever let the old one go (its idle release, the tool, a close at the park),
  // the launch clears it (tools.ts onSessions on "launched").
  await clearWaitEnded(store.settings, "run-a");
  assert.equal(await readWaitEnded(store.settings, "run-a"), undefined);
  await clearWaitEnded(store.settings, "run-a");
  store.rows.set("browser_wait_ended:run-c", { at: 5, why: null });
  assert.equal(await readWaitEnded(store.settings, "run-c"), undefined, "a value of another shape is no ended state");
});

test("the Screen read of an ended run answers nothing and removes the run's row, so none is left behind", async () => {
  const store = storeOf();
  await markWaitEnded(store.settings, "run-done", ENDED);
  assert.deepEqual(await screenWaitEnded(store.settings, "run-done", false), ENDED, "a going run's ended state is read");
  assert.ok(store.rows.has("browser_wait_ended:run-done"));
  assert.equal(await screenWaitEnded(store.settings, "run-done", true), undefined, "an ended run has no ended-while-waiting state");
  assert.equal(store.rows.has("browser_wait_ended:run-done"), false, "and its row is gone");
  assert.equal(await screenWaitEnded(store.settings, "run-none", true), undefined, "a run with no row: nothing to remove");
});

test("each Screen poll's ended state is one settings read, never the run's journal", async () => {
  const store = storeOf();
  await markWaitEnded(store.settings, "run-poll", ENDED);
  for (let i = 0; i < 5; i += 1) {
    const view = await computerView({ viewer: async () => undefined, computer: () => ({ kind: "browser" }), ended: () => readWaitEnded(store.settings, "run-poll") });
    assert.deepEqual(view, { state: "none", kind: "browser", hold: "agent", ended: ENDED });
  }
  assert.equal(store.reads.settings, 5, "one settings read a poll");
});

test("the wait's end hands its row's words and time to the ended state, once; an answer hands nothing", async (t) => {
  const ended = [];
  let clock = Date.parse("2026-11-11T14:11:00.000Z");
  // Timers on the test's clock: each fires once the clock passes its time (tick).
  const pending = new Set();
  const timers = { set: (run, ms) => { const h = { run, due: clock + ms }; pending.add(h); return h; }, clear: (h) => void pending.delete(h) };
  const tick = (ms) => { clock += ms; for (const h of [...pending]) if (h.due <= clock) { pending.delete(h); h.run(); } };
  const person = personHands({
    gates: () => ({ give: () => false }), pollMs: 60_000, holdMs: 15 * 60_000, timers, now: () => clock,
    personTime: async () => ({ drop: () => {} }), note: async () => {}, asks: async () => [], answered: async () => undefined,
    waitEnded: (at, why) => ended.push({ at: new Date(at).toISOString(), why }),
  });
  t.after(() => person.close());
  const answered = await person.wait("call-1", ["ar-run-50-1"], clock);
  tick(60_000);
  answered.drop();
  tick(15 * 60_000);
  assert.deepEqual(ended, [], "an answer inside the window: nothing ended");
  clock = Date.parse("2026-11-11T14:11:00.000Z");
  const waited = await person.wait("call-2", ["ar-run-50-2"], clock);
  tick(15 * 60_000);
  await waited.lapsed;
  assert.deepEqual(ended, [], "nothing is handed before the runner parks on the lapse");
  waited.confirmed();
  person.sessionEnded("ar-run-50-2");
  waited.drop();
  assert.deepEqual(ended, [{ at: "2026-11-11T14:26:00.000Z", why: "The browser was released after 15 min waiting for you" }]);
});

test("GET /computer's none carries `ended` for a browser only, and only when there is one", async () => {
  const none = (kind, ended) => computerView({ viewer: async () => undefined, computer: () => ({ kind }), ended: async () => ended });
  assert.deepEqual(await none("browser", ENDED), { state: "none", kind: "browser", hold: "agent", ended: ENDED });
  assert.deepEqual(await none("browser", undefined), { state: "none", kind: "browser", hold: "agent" });
  assert.deepEqual(await none("desktop", ENDED), { state: "none", kind: "desktop", hold: "agent" }, "a desktop's none says nothing of a browser's wait");
  const live = await computerView({ viewer: async () => ({ kind: "browser", viewer: "/v2/runs/r/computer/live/v/1#t=x" }), computer: () => ({ kind: "browser" }), ended: async () => { throw new Error("not read while a viewer is open"); } });
  assert.equal(live.state, "live");
});
