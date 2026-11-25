// A run's learning work (learning-work.ts) and the view's `learning_work`, unit by unit: the children a claim names before
// it creates them, read against their rows. `none` for a run that started nothing; `running` while its compile turn goes
// or a child has not ended (listing those); `ended` once each finished, failed, was cancelled, was lost (named, never
// made, or its row gone) or dropped for want of budget (`no_budget`), at the last one's end. It only moves forward.
import assert from "node:assert/strict";
import { test } from "node:test";

const { atRunEnd, learningChildrenOf, learningWorkKey, learningWorkOf, noteLearningChild, keyedBesideOf } = await import("../dist/learning-work.js");

/** Settings as the store keeps them: get, putIfAbsent, replaceIf (a compare by value). */
function settingsStore() {
  const rows = new Map();
  return {
    rows,
    get: async (key) => rows.get(key),
    putIfAbsent: async (key, value) => (rows.has(key) ? rows.get(key) : (rows.set(key, value), value)),
    replaceIf: async (key, was, value) => (JSON.stringify(rows.get(key)) === JSON.stringify(was) ? (rows.set(key, value), true) : false),
  };
}

/** A store of `runs` (id → row) and `launches` (id → body). */
const storeOf = (settings, runs = {}, launches = {}) => ({ settings, runs: { get: async (id) => runs[id], launch: async (id) => ({ body: launches[id] ?? {} }) } });
const row = (id, state, extra = {}) => ({ id, state, endedAt: null, costUsd: null, ...extra });
const T = Date.parse("2026-11-25T08:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const NOT_YET = { learns: true, compiling: false, compiled: false, endedAt: null };
const COMPILING = { learns: true, compiling: true, compiled: false, endedAt: null };

test("none: a run that does not learn, or started nothing; running while only its compile turn goes, listing no run", async () => {
  const settings = settingsStore();
  assert.deepEqual(await learningWorkOf(storeOf(settings), "run-1", { learns: false, compiling: false, compiled: false, endedAt: T }), { state: "none", runs: [], ended_at: null });
  assert.deepEqual(await learningWorkOf(storeOf(settings), "run-1", NOT_YET), { state: "none", runs: [], ended_at: null }, "learns, but nothing began");
  assert.deepEqual(await learningWorkOf(storeOf(settings), "run-1", COMPILING), { state: "running", runs: [], ended_at: null });
  assert.deepEqual(await learningWorkOf(storeOf(settings), "run-1", { learns: true, compiling: false, compiled: true, endedAt: T }), { state: "ended", runs: [], ended_at: iso(T) }, "its compile turn ended: ended at its end");
});

test("running while any child it named has not ended, listing those in order; ended once each finished, failed or was cancelled, at the last end", async () => {
  const settings = settingsStore();
  await noteLearningChild(settings, "run-1", { run: "replay-a", kind: "replay", at: T, keyed: true });
  await noteLearningChild(settings, "run-1", { run: "replay-b", kind: "replay", at: T + 1, keyed: true });
  await noteLearningChild(settings, "run-1", { run: "shadow-c", kind: "shadow", at: T + 2, keyed: true });
  const own = { learns: true, compiling: false, compiled: true, endedAt: T - 10 };
  const runs = { "replay-a": row("replay-a", "running"), "replay-b": row("replay-b", "queued"), "shadow-c": row("shadow-c", "ended", { endedAt: T + 50 }) };
  assert.deepEqual(await learningWorkOf(storeOf(settings, runs), "run-1", own), { state: "running", runs: ["replay-a", "replay-b"], ended_at: null }, "one child ended, two have not: running");
  runs["replay-a"] = row("replay-a", "failed", { endedAt: T + 70 });
  assert.deepEqual(await learningWorkOf(storeOf(settings, runs), "run-1", own), { state: "running", runs: ["replay-b"], ended_at: null });
  runs["replay-b"] = row("replay-b", "stopped", { endedAt: T + 60 });
  assert.deepEqual(await learningWorkOf(storeOf(settings, runs), "run-1", own), { state: "ended", runs: [], ended_at: iso(T + 70) }, "a failed and a cancelled child count as ended");
  // Its compile turn going keeps it running even when no child is.
  assert.deepEqual((await learningWorkOf(storeOf(settings, runs), "run-1", COMPILING)).state, "running");
});

test("a lost child (named, never made, or its row gone) counts as ended at the time it was named; a no_budget drop ends the run's work", async () => {
  const settings = settingsStore();
  await noteLearningChild(settings, "run-1", { run: "lost-a", kind: "replay", at: T + 5, keyed: true });
  assert.deepEqual(await learningWorkOf(storeOf(settings), "run-1", NOT_YET), { state: "ended", runs: [], ended_at: iso(T + 5) }, "never made: ended, never running forever");
  const dropped = settingsStore();
  await noteLearningChild(dropped, "run-2", { run: null, kind: "replay", at: T + 9, keyed: true, dropped: "no_budget" });
  assert.deepEqual(await learningWorkOf(storeOf(dropped), "run-2", { learns: true, compiling: false, compiled: true, endedAt: T + 3 }), { state: "ended", runs: [], ended_at: iso(T + 9) }, "dropped: ended at the drop");
  assert.deepEqual(await learningChildrenOf(dropped, "run-2"), [{ run: null, kind: "replay", at: T + 9, keyed: true, dropped: "no_budget" }]);
});

test("forward only: through none, running and ended a run's state never reads running again once it read ended", async () => {
  const settings = settingsStore();
  const runs = {};
  const seen = [];
  const read = async (own) => seen.push((await learningWorkOf(storeOf(settings, runs), "run-1", own)).state);
  await read(NOT_YET);
  await read(COMPILING);
  await noteLearningChild(settings, "run-1", { run: "replay-a", kind: "replay", at: T, keyed: true });
  runs["replay-a"] = row("replay-a", "running");
  const after = { learns: true, compiling: false, compiled: true, endedAt: T };
  await read(after);
  runs["replay-a"] = row("replay-a", "ended", { endedAt: T + 1 });
  await read(after);
  await read(after);
  assert.deepEqual(seen, ["none", "running", "running", "ended", "ended"]);
});

test("noteLearningChild: each child named once, two claims at once both kept (compare-and-set), the row holding ids and times alone", async () => {
  const settings = settingsStore();
  await Promise.all([
    noteLearningChild(settings, "run-1", { run: "replay-a", kind: "replay", at: T }),
    noteLearningChild(settings, "run-1", { run: "shadow-b", kind: "shadow", at: T + 1, keyed: true }),
  ]);
  await noteLearningChild(settings, "run-1", { run: "replay-a", kind: "replay", at: T + 9 });
  assert.deepEqual((await learningChildrenOf(settings, "run-1")).map((one) => one.run).sort(), ["replay-a", "shadow-b"]);
  assert.deepEqual(Object.keys(settings.rows.get(learningWorkKey("run-1"))), ["children"]);
  assert.equal(learningWorkKey("run-1"), "learning_work:run-1");
});

test("keyedBesideOf: what keyed replays took beside their run, at cost once ended, at their cap while not; the shadow counted apart", async () => {
  const settings = settingsStore();
  await noteLearningChild(settings, "run-1", { run: "replay-a", kind: "replay", at: T, keyed: true });
  await noteLearningChild(settings, "run-1", { run: "replay-b", kind: "replay", at: T, keyed: true });
  await noteLearningChild(settings, "run-1", { run: "shadow-c", kind: "shadow", at: T, keyed: true });
  await noteLearningChild(settings, "run-1", { run: "replay-d", kind: "replay", at: T });
  const runs = { "replay-a": row("replay-a", "ended", { costUsd: 0.02 }), "replay-b": row("replay-b", "running"), "shadow-c": row("shadow-c", "running"), "replay-d": row("replay-d", "running") };
  assert.equal(await keyedBesideOf(storeOf(settings, runs, { "replay-b": { input: null, title: "", place: { mode: "runner" }, max_cost_usd: 0.5 } }), "run-1"), 0.52);
  assert.equal(await keyedBesideOf(storeOf(settings, runs), "run-1"), null, "a running keyed replay with no cap: not known");
});

test("atRunEnd: queued starts run once, in order, at the run's end; one that throws is logged and the next one runs", async () => {
  const logs = [];
  const order = [];
  const end = atRunEnd((line) => logs.push(line));
  end.later(async () => void order.push(1));
  end.later(async () => {
    throw new Error("boom");
  });
  end.later(async () => void order.push(3));
  assert.deepEqual(order, [], "nothing before the end");
  await end.run();
  await end.run();
  assert.deepEqual(order, [1, 3]);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /did not start \(boom\)/);
});
