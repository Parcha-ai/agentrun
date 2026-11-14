// A run's live row is written under the claim's lease as well as its epoch: a runner paused past its lease (no one retook
// the run, the epoch unchanged) has its live row answered fenced and not written, while a held claim beside it in the same
// tick is written. A run's MCP pin is no claim's write: it is its revision's, made at the agent's save, and a claim, held
// or lapsed, only reads it. Dropping a run's live row stays on the epoch alone: a runner
// clearing its own row after its lease ran out removes no one else's view.
import assert from "node:assert/strict";
import { test } from "node:test";
import { queued, storeOn } from "./store-helpers.mjs";

const PIN = { fake: { url: "http://127.0.0.1:1/mcp", tools: [] } };

test("a run's pin is its revision's: a claim whose lease ran out and a held one read it alike, and neither writes one", async (t) => {
  const { store, clock } = await storeOn(t);
  await queued(store, "run-1", { mcpPin: PIN });
  await store.runs.create({ id: "run-2", agentId: "agent-run-1", revisionId: "rev-run-1" });
  const lapsed = await store.claim("run-1", "runner-a", { leaseMs: 1_000 });
  const held = await store.claim("run-2", "runner-a", { leaseMs: 1_001 });
  clock.now += 1_001;
  const before = await store.runs.get("run-1");
  assert.deepEqual([before.epoch, before.runner], [lapsed.epoch, "runner-a"], "no one retook it: the epoch is the claim's");
  assert.equal((await store.runs.get("run-2")).claimedUntil, clock.now, "the held claim is at its last moment");

  assert.deepEqual((await store.mcp.pin("run-1"))?.body, PIN, "the lapsed claim's run reads its revision's pin");
  assert.deepEqual((await store.mcp.pin("run-2"))?.body, PIN, "the held claim's too");
  assert.equal(typeof store.mcp.pinOnce, "undefined", "the store has no claim-time pin write");
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
