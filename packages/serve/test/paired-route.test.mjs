// A paired computer's route (serve/src/workspace/paired-route.ts): one server setting per computer,
// `paired_route:<computer id>`, taken by a run's claim, dropped by the runner that holds it, noted by the server, each by
// compare-and-set on the store's settings. A take succeeds on no route, on the run's own (a resume on another runner),
// on a route whose runner is not live or restarted since, and on a route whose run is final; a route of another run on a
// live runner refuses it. A take under a superseded claim throws Fenced and writes nothing. Each case on the test's own
// store (store-target.mjs: SQLite, or Postgres where the run names one), its clock the test's.
import assert from "node:assert/strict";
import { test } from "node:test";
import { queued, storeOn, T0 } from "./store-helpers.mjs";

const { Fenced } = await import("../dist/store/index.js");
const { dropRoute, EMPTY_ROUTE, readRoute, replaceRoute, routeKeyOf, seeRoute, takeRoute } = await import("../dist/workspace/paired-route.js");

const BOX = "cmp-test0000000000000";
const UNTIL = T0 + 3_600_000;

/** A store with runner-a and runner-b live, each with a relay. */
async function routed(t) {
  const on = await storeOn(t);
  const { store } = on;
  for (const [runner, port] of [["runner-a", 40_001], ["runner-b", 40_002]]) await store.runners.put({ runner, incarnation: `inc-${runner.slice(-1)}`, refused: null, host: "127.0.0.1", port });
  const deps = { settings: store.settings, runners: store.runners, runs: store.runs };
  const want = (runner, run) => ({ runner, incarnation: `inc-${runner.slice(-1)}`, run, until: UNTIL });
  return { ...on, deps, want };
}

test("a take routes a box with no route; the same run takes it again from another runner; another run's take on a live runner is refused in words, the route left as it was", async (t) => {
  const { store, deps, want } = await routed(t);
  assert.deepEqual(await readRoute(store.settings, BOX), EMPTY_ROUTE, "no row reads as no route");
  const took = await takeRoute(deps, BOX, want("runner-a", "run-1"), { name: "desk-1" });
  assert.equal(took.taken, true);
  assert.deepEqual(await readRoute(store.settings, BOX), { runner: "runner-a", incarnation: "inc-a", run: "run-1", until: UNTIL, refused: null });
  assert.deepEqual(Object.keys(await store.settings.get(routeKeyOf(BOX))), ["runner", "incarnation", "run", "until", "refused"], "its fields in one order");

  const other = await takeRoute(deps, BOX, want("runner-b", "run-2"), { name: "desk-1" });
  assert.equal(other.taken, false);
  assert.equal(other.why, "desk-1 is held by run run-1 on runner runner-a: one run at a time");
  assert.equal((await readRoute(store.settings, BOX)).runner, "runner-a");

  assert.equal((await takeRoute(deps, BOX, want("runner-b", "run-1"))).taken, true, "the same run's resume on another runner takes it");
  assert.equal((await readRoute(store.settings, BOX)).runner, "runner-b");
});

test("a route goes stale when its runner has no live relay or names another incarnation: a take of another run succeeds over it", async (t) => {
  const { store, deps, want } = await routed(t);
  await takeRoute(deps, BOX, want("runner-a", "run-1"));
  await store.runners.put({ runner: "runner-a", incarnation: "inc-a2", refused: null, host: "127.0.0.1", port: 40_003 });
  assert.equal((await takeRoute(deps, BOX, want("runner-b", "run-2"))).taken, true, "runner-a restarted since: its route is stale");
  await store.runners.remove("runner-b", "inc-b");
  assert.equal((await takeRoute(deps, BOX, { runner: "runner-a", incarnation: "inc-a2", run: "run-3", until: UNTIL })).taken, true, "runner-b is not running: its route is stale");
});

test("a route whose run is final is taken by a new run, a completed, a cancelled and a failed one each; a route whose run the store has no row of stands, and so does one whose run's read throws, each after one read", async (t) => {
  const { store, deps, want } = await routed(t);
  await queued(store, "run-done");
  const done = await store.claim("run-done", "runner-a", { leaseMs: 60_000 });
  await store.runs.update(done, { state: "ended", outcome: "completed", summary: "done", endedAt: T0 + 10 });
  await takeRoute(deps, BOX, want("runner-a", "run-done"));
  assert.equal((await takeRoute(deps, BOX, want("runner-b", "run-new"))).taken, true, "a route a completed run left is taken");

  await queued(store, "run-cancelled");
  const cancelled = await store.claim("run-cancelled", "runner-b", { leaseMs: 60_000 });
  await store.runs.update(cancelled, { state: "stopped", outcome: "cancelled", endedAt: T0 + 10 });
  assert.equal(await dropRoute(store.settings, BOX, { runner: "runner-b", incarnation: "inc-b" }), true);
  await takeRoute(deps, BOX, want("runner-b", "run-cancelled"));
  assert.equal((await takeRoute(deps, BOX, want("runner-a", "run-next"))).taken, true, "a route a cancelled run left is taken");

  await queued(store, "run-failed");
  const failed = await store.claim("run-failed", "runner-b", { leaseMs: 60_000 });
  await store.runs.update(failed, { state: "failed", summary: "failed", endedAt: T0 + 10 });
  assert.equal(await dropRoute(store.settings, BOX, { runner: "runner-a", incarnation: "inc-a" }), true);
  await takeRoute(deps, BOX, want("runner-b", "run-failed"));
  assert.equal((await takeRoute(deps, BOX, want("runner-a", "run-after"))).taken, true, "a route a failed run left is taken");

  await queued(store, "run-live");
  await store.claim("run-live", "runner-b", { leaseMs: 60_000 });
  assert.equal(await dropRoute(store.settings, BOX, { runner: "runner-a", incarnation: "inc-a" }), true);
  await takeRoute(deps, BOX, want("runner-b", "run-live"));
  assert.equal((await takeRoute(deps, BOX, want("runner-a", "run-other"))).taken, false, "a running run's route on a live runner refuses");
  assert.equal(await dropRoute(store.settings, BOX, { runner: "runner-b", incarnation: "inc-b" }), true);
  await takeRoute(deps, BOX, want("runner-b", "run-unknown"));
  let reads = 0;
  const counted = { ...deps, runs: { get: async (id) => (reads++, store.runs.get(id)) } };
  const missing = await takeRoute(counted, BOX, want("runner-a", "run-other"), { name: "desk-1" });
  assert.equal(missing.taken, false, "a run the store has no row of is not final");
  assert.equal(missing.why, "desk-1 is held by run run-unknown on runner runner-b: one run at a time");
  assert.equal(reads, 1, "one read of the route's run");

  reads = 0;
  const blind = { ...deps, runs: { get: async () => { reads++; throw new Error("the store is away"); } } };
  const threw = await takeRoute(blind, BOX, want("runner-a", "run-other"), { name: "desk-1" });
  assert.equal(threw.taken, false, "a read of the route's run that throws refuses, never takes over");
  assert.equal(threw.why, "desk-1 is held by run run-unknown on runner runner-b: one run at a time", "in the same words");
  assert.equal(reads, 1, "one read, no retry");
  assert.equal((await readRoute(store.settings, BOX)).run, "run-unknown", "the route left as it was");
});

test("a drop goes only for the route's own runner and incarnation (and run, where given); a note is kept on the row and goes with the next empty write", async (t) => {
  const { store, deps, want } = await routed(t);
  await takeRoute(deps, BOX, want("runner-a", "run-1"));
  assert.equal(await dropRoute(store.settings, BOX, { runner: "runner-b", incarnation: "inc-b" }), false, "another runner's drop");
  assert.equal(await dropRoute(store.settings, BOX, { runner: "runner-a", incarnation: "inc-old" }), false, "an earlier process's drop");
  assert.equal(await dropRoute(store.settings, BOX, { runner: "runner-a", incarnation: "inc-a", run: "run-2" }), false, "a drop for another run");
  assert.equal(await dropRoute(store.settings, BOX, { runner: "runner-a", incarnation: "inc-a", run: "run-1" }, "desk-1 did not reach runner runner-a"), true);
  assert.deepEqual(await readRoute(store.settings, BOX), { ...EMPTY_ROUTE, refused: "desk-1 did not reach runner runner-a" }, "the note stays, the route gone");
  const { seen } = await seeRoute(store.settings, BOX);
  assert.equal(await replaceRoute(store.settings, BOX, seen, EMPTY_ROUTE), true, "the note cleared");
  assert.equal(await store.settings.get(routeKeyOf(BOX)), undefined, "a row with no route and no note goes");
  assert.equal(await replaceRoute(store.settings, BOX, seen, EMPTY_ROUTE), false, "a compare-and-set on a row that went answers false");
});

test("a take under a claim another runner superseded throws Fenced and writes nothing", async (t) => {
  const { store, clock, deps, want } = await routed(t);
  await queued(store, "run-1");
  const first = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  clock.now = T0 + 120_000;
  for (const [runner, port] of [["runner-a", 40_001], ["runner-b", 40_002]]) await store.runners.put({ runner, incarnation: `inc-${runner.slice(-1)}`, refused: null, host: "127.0.0.1", port });
  const second = await store.claim("run-1", "runner-b", { leaseMs: 60_000 });
  assert.ok(second, "runner-b takes the run over once runner-a's lease ran out");
  await assert.rejects(takeRoute(deps, BOX, want("runner-a", "run-1"), { claim: first }), (error) => error instanceof Fenced);
  // The take put an empty row before its compare-and-set threw: harmless, it reads as no route and no note (the
  // server's tick removes it), and the next take goes over it.
  assert.deepEqual(await readRoute(store.settings, BOX), EMPTY_ROUTE, "nothing routed and nothing noted");
  assert.equal((await takeRoute(deps, BOX, want("runner-b", "run-1"), { claim: second })).taken, true, "the claim that holds the run takes it");
});
