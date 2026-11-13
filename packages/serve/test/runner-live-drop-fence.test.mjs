// A run's live row is dropped under its claim: the drop at a loop's end is fenced by the claim's epoch, as the ticker's
// puts are. A loop that ends late, after its claim was lost and another runner took the run, drops nothing of the
// replacement runner's row; a loop that ends under its own claim drops its row. On a runner, the drop lands before the
// run's release moves the epoch on (the ticker awaits it before the loop's start() resolves): were that order to slip,
// the fenced drop would find the epoch moved and leave the row behind.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openSqliteStore } from "../dist/store/index.js";
import { startRunner } from "../dist/runner/runner.js";
import { suiteTools } from "../dist/runner/conformance/harness.js";
import { after } from "node:test";
import { closeOpenSessions, piAdapterSubject } from "./conformance-pi-adapter.mjs";
import { quiet, until } from "./live-support.mjs";
import { queued, storeOn } from "./store-helpers.mjs";

const { withLiveTicker } = await import("../dist/runner/live-ticker.js");
after(closeOpenSessions);

/** A loop that runs until `end()` is called. */
function heldLoop() {
  const control = {};
  const createLoop = () => ({
    start: () => new Promise((resolve) => (control.end = () => resolve({ state: "ended" }))),
    command: async () => ({ refused: "not in this test" }),
    stop: async () => {},
  });
  return { control, createLoop };
}

test("a loop that ends after its claim was lost and the run claimed again drops nothing of the new claim's live row", async (t) => {
  const { store, clock } = await storeOn(t);
  await queued(store, "run-1");
  const stale = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const { control, createLoop } = heldLoop();
  const ticker = withLiveTicker(store, createLoop, { tickMs: 60_000 });
  t.after(() => ticker.close());
  const started = ticker.createLoop({ journal: () => undefined, flush: async () => {}, signal: new AbortController().signal }).start(stale);

  // The claim runs out; another runner claims the run and writes its live row.
  clock.now += 61_000;
  const current = await store.claim("run-1", "runner-b", { leaseMs: 60_000 });
  assert.equal(current.epoch, stale.epoch + 1);
  assert.deepEqual((await store.live.put([{ claim: current, state: { text: "the new runner's" } }])).written, ["run-1"]);

  // The old loop ends late: its drop is under the stale claim.
  control.end();
  await started;
  assert.deepEqual((await store.live.read(["run-1"])).map((row) => row.state), [{ text: "the new runner's" }], "the new claim's row stays");
});

test("on a runner, a run's live row is dropped before its release: none is left once the run is released", async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-live-drop-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  let ticker;
  t.after(async () => {
    await runner?.close();
    await ticker?.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Drop" }, { id: "rev-1", kind: "agentic", body: {} });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  // The order the store is asked to drop the row and to release the run.
  const order = [];
  const drop = store.live.drop.bind(store.live);
  store.live.drop = async (claim) => (order.push("drop"), drop(claim));
  const release = store.release.bind(store);
  store.release = async (claim, options) => (order.push("release"), release(claim, options));
  const { tools, letSlowGo } = suiteTools();
  t.after(() => letSlowGo());
  ticker = withLiveTicker(store, piAdapterSubject.createLoop({ script: [{ call: "slow" }, { say: "done" }], tools, hooks: quiet }), { tickMs: 50 });
  const released = [];
  // The ticker wrapped here: the runner's own is off (live false).
  runner = startRunner({ store, createLoop: ticker.createLoop, live: false, name: "runner-a", leaseMs: 5_000, renewEveryMs: 1_000, stopMarginMs: 1_000, pollMs: 50, commandPollMs: 200, onEvent: (event) => event.type === "released" && released.push(event) });
  await until(async () => (await server.live.read(["run-1"])).length === 1, "the run's live row while its tool runs", 30_000);
  letSlowGo();
  await until(() => released.length === 1, "the run's release", 30_000);
  assert.deepEqual(order.filter((step) => step === "drop" || step === "release"), ["drop", "release"], "dropped before released");
  assert.deepEqual(await server.live.read(["run-1"]), [], "no live row once the run is released");
});

test("a loop that ends under its own claim drops its run's live row", async (t) => {
  const { store } = await storeOn(t);
  await queued(store, "run-1");
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const { control, createLoop } = heldLoop();
  const ticker = withLiveTicker(store, createLoop, { tickMs: 60_000 });
  t.after(() => ticker.close());
  const started = ticker.createLoop({ journal: () => undefined, flush: async () => {}, signal: new AbortController().signal }).start(claim);
  await store.live.put([{ claim, state: { text: "running" } }]);
  control.end();
  await started;
  assert.deepEqual(await store.live.read(["run-1"]), [], "dropped at its end");
});
