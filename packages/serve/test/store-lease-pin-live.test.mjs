// The run's MCP pin and its live row are written under the claim's lease as well as its epoch: a runner paused past its
// lease (no one retook the run, the epoch unchanged) pins nothing, and its live row is answered fenced and not written,
// while a held claim beside it in the same tick is written. Dropping a run's live row stays on the epoch alone: a runner
// clearing its own row after its lease ran out removes no one else's view.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Fenced } from "../dist/store/store.js";
import { queued, storeOn } from "./store-helpers.mjs";

const PIN = { fake: { url: "http://127.0.0.1:1/mcp", tools: [] } };

test("a pin under a lease that ran out is Fenced and writes no pin; at the lease's last moment it pins", async (t) => {
  const { store, clock } = await storeOn(t);
  await queued(store, "run-1");
  await queued(store, "run-2");
  const lapsed = await store.claim("run-1", "runner-a", { leaseMs: 1_000 });
  const held = await store.claim("run-2", "runner-a", { leaseMs: 1_001 });
  clock.now += 1_001;
  const before = await store.runs.get("run-1");
  assert.deepEqual([before.epoch, before.runner], [lapsed.epoch, "runner-a"], "no one retook it: the epoch is the claim's");
  assert.equal((await store.runs.get("run-2")).claimedUntil, clock.now, "the held claim is at its last moment");

  await assert.rejects(store.mcp.pinOnce(lapsed, PIN), Fenced, "the lapsed claim's pin");
  assert.equal(await store.mcp.pin("run-1"), undefined, "no pin row for the lapsed claim");
  const pinned = await store.mcp.pinOnce(held, PIN);
  assert.deepEqual(pinned.body, PIN, "the held claim pins");
});

test("a live put under a lease that ran out answers that row fenced and writes it not, beside a held claim's row it writes", async (t) => {
  const { store, clock } = await storeOn(t);
  await queued(store, "run-1");
  await queued(store, "run-2");
  const lapsed = await store.claim("run-1", "runner-a", { leaseMs: 1_000 });
  const held = await store.claim("run-2", "runner-a", { leaseMs: 60_000 });
  clock.now += 1_001;
  assert.equal((await store.runs.get("run-1")).epoch, lapsed.epoch, "no one retook it");

  const result = await store.live.put([{ claim: lapsed, state: { text: "the paused runner's" } }, { claim: held, state: { text: "live" } }]);
  assert.deepEqual(result, { written: ["run-2"], fenced: ["run-1"] });
  assert.deepEqual((await store.live.read(["run-1", "run-2"])).map((row) => [row.runId, row.state.text]), [["run-2", "live"]]);
});

test("a live drop stays on the epoch: a claim whose lease ran out still clears its own run's row, a stale epoch's clears nothing", async (t) => {
  const { store, clock } = await storeOn(t);
  await queued(store, "run-1");
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 1_000 });
  await store.live.put([{ claim, state: { text: "a" } }]);
  clock.now += 1_001;
  await store.live.drop(claim);
  assert.deepEqual(await store.live.read(["run-1"]), [], "its own row, cleared after its lease ran out");

  const current = await store.claim("run-1", "runner-b", { leaseMs: 60_000 });
  await store.live.put([{ claim: current, state: { text: "b" } }]);
  await store.live.drop(claim);
  assert.deepEqual((await store.live.read(["run-1"])).map((row) => row.state.text), ["b"], "the new holder's row stays");
});
