// A run's live view (store.live): one small row per running run (its current tool, its partial text), outside the
// journal, overwritten in place by its runner's tick and dropped at the run's end. A runner writes every changed row of a
// tick in ONE transaction, each row fenced by its run's claim epoch: a stale runner's row is skipped, never written. The
// server reads many runs' rows in one query.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentWithRevision, storeOn } from "./store-helpers.mjs";

const RUNS = 300;
const id = (i) => `run-${String(i).padStart(3, "0")}`;

async function claimed(store, n) {
  await agentWithRevision(store);
  for (let i = 0; i < n; i++) await store.runs.create({ id: id(i), agentId: "agent-1", revisionId: "rev-1" });
  return store.runs.claimMany("runner-a", n, { leaseMs: 60_000 });
}

test("one put of 300 rows is one transaction: another connection reading meanwhile sees none of them or all", async (t) => {
  const { store, file, clock } = await storeOn(t);
  const { store: reader } = await storeOn(t, { file, clock, role: "runner" });
  const claims = await claimed(store, RUNS);
  const ids = claims.map((claim) => claim.runId);
  const seen = new Set();
  let reading = true;
  const watch = (async () => {
    while (reading) seen.add((await reader.live.read(ids)).length);
  })();
  const result = await store.live.put(claims.map((claim, i) => ({ claim, state: { tool: { name: "bash", input: { command: `echo ${i}` } }, text: `partial ${i}` } })));
  reading = false;
  await watch;
  seen.add((await reader.live.read(ids)).length);
  assert.equal(result.written.length, RUNS);
  assert.deepEqual([...seen].filter((n) => n !== 0 && n !== RUNS), [], `a reader saw a part of the batch: ${JSON.stringify([...seen])}`);
  const [row] = await store.live.read([id(7)]);
  assert.deepEqual([row.runId, row.state], [id(7), { tool: { name: "bash", input: { command: "echo 7" } }, text: "partial 7" }]);
});

test("a stale claim's row is skipped, never written, beside the batch's live rows", async (t) => {
  const { store, clock } = await storeOn(t);
  const [stale, first] = await claimed(store, 2);
  // The other run's claim renewed past the clock's move: a row is written only under a live lease.
  const other = await store.renew(first, { leaseMs: 120_000 });
  clock.now += 61_000;
  const current = await store.claim(stale.runId, "runner-b", { leaseMs: 60_000 });
  assert.equal(current.epoch, 2);
  const result = await store.live.put([{ claim: stale, state: { text: "the stale runner's" } }, { claim: other, state: { text: "live" } }]);
  assert.deepEqual(result, { written: [other.runId], fenced: [stale.runId] });
  assert.deepEqual((await store.live.read([stale.runId, other.runId])).map((row) => row.runId), [other.runId]);
});

test("a row is overwritten in place by the next tick, and dropped at the run's end", async (t) => {
  const { store, clock } = await storeOn(t);
  const [claim] = await claimed(store, 1);
  await store.live.put([{ claim, state: { text: "a" } }]);
  clock.now += 300;
  await store.live.put([{ claim, state: { text: "ab" } }]);
  const [row] = await store.live.read([claim.runId]);
  assert.deepEqual([row.state, row.updatedAt], [{ text: "ab" }, clock.now]);
  await store.live.drop(claim);
  assert.deepEqual(await store.live.read([claim.runId]), []);
  assert.deepEqual(await store.live.read([]), [], "no runs asked: none");
});
