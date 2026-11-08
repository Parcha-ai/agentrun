// A run's live row is dropped under its claim: the drop at a loop's end is fenced by the claim's epoch, as the ticker's
// puts are. A loop that ends late, after its claim was lost and another runner took the run, drops nothing of the
// replacement runner's row; a loop that ends under its own claim drops its row.
import assert from "node:assert/strict";
import { test } from "node:test";
import { queued, storeOn } from "./store-helpers.mjs";

const { withLiveTicker } = await import("../dist/runner/live-ticker.js");

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
