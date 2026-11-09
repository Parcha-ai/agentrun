// A paid request the run never saw answered (its process died, or its claim was lost and its answer's write was refused)
// may have been billed at a cache miss. The host's admission gives its bound (what a cache miss adds to its hold) beside
// its hold, and both are written on the request's record before it leaves. For the cap, a request with no answer counts at
// its hold plus its bound, the worst case, never less, in every later process and after it is booked cut. For the run's
// cost, such a request makes the cost unknown, with the known part so far beside it: a held guess is never shown as spend.
import assert from "node:assert/strict";
import { test } from "node:test";
import { modelPortFor, RUNNER_RECORDS, sessionSpendOf } from "@parcha/agentrun-kernel";
import { memorySessionStore } from "@parcha/agentrun-kernel/testing";
import { beforeRequestOf } from "../dist/kernel/cap/index.js";
import { SONNET, T0 } from "./kernel-cap-support.mjs";

const key = "chat:c1";
const HOLD = 0.25;
const BOUND = 0.5;
const near = (actual, expected, what) => assert.ok(actual !== null && Math.abs(actual - expected) < 1e-9, `${what}: ${actual}, not ${expected}`);

/** The booking of session `key` in a new process; its host holds HOLD with BOUND for each request. `lost()`: from then on,
 *  every write of this booking is refused, as a claim's late write is after its lease ran out (Fenced). */
async function port(store, asked = []) {
  const writer = await store.open(key);
  let refused = false;
  const fenced = {
    key: writer.key,
    read: () => writer.read(),
    append: (records) => (refused ? Promise.reject(Object.assign(new Error("the claim was lost: Fenced"), { name: "Fenced" })) : writer.append(records)),
    flush: () => writer.flush?.(),
  };
  const booking = await modelPortFor(fenced, { key, beforeRequest: (r) => (asked.push(r.spentUsd), { holdUsd: HOLD, boundUsd: BOUND }) });
  return Object.assign(booking, { lost: () => void (refused = true) });
}
const records = (store) => store.read(key);

test("the bound a host gives a request (what a cache miss adds) is written beside its hold on the request's record, before it leaves", async () => {
  const store = memorySessionStore();
  const booking = await port(store);
  await booking.models.beforeRequest({ model: "m" });
  const written = (await records(store)).filter((r) => r.kind === RUNNER_RECORDS.request).map((r) => r.data);
  assert.deepEqual(written, [{ turn: 1, model: "m", heldUsd: HOLD, boundUsd: BOUND }]);
});

test("a request whose claim was lost before its answer was written counts for the cap at its hold plus its bound in the next process, before and after it is booked cut", async () => {
  const store = memorySessionStore();
  const first = await port(store);
  await first.models.beforeRequest({ model: "m" });
  await first.models.afterRequest({ input: 1, output: 1, cacheRead: 0, usd: 0.01 });
  await first.models.beforeRequest({ model: "m" });
  first.lost();
  // Its answer came after the claim was lost: the write of its cost is refused.
  await assert.rejects(first.models.afterRequest({ input: 1, output: 1, cacheRead: 0, usd: 0.02 }));
  assert.deepEqual((await records(store)).filter((r) => r.kind === RUNNER_RECORDS.turn).map((r) => r.data.turn), [1], "the late answer's cost was never written");

  near(sessionSpendOf(await records(store)).spentUsd, 0.01 + HOLD + BOUND, "read from the records");
  const asked = [];
  const second = await port(store, asked);
  near(second.spentUsd(), 0.01 + HOLD + BOUND, "the next process's spend");
  await second.bookCut();
  near(second.spentUsd(), 0.01 + HOLD + BOUND, "booked cut: the same");
  near(sessionSpendOf(await records(store)).spentUsd, 0.01 + HOLD + BOUND, "read from the records once booked cut");
  await second.models.beforeRequest({ model: "m" });
  near(asked[0], 0.01 + HOLD + BOUND, "the next request's cap check sees it");
});

test("the run's cost with a request that has no answer is unknown, with the known part so far beside it; answered alone it is known", async () => {
  const store = memorySessionStore();
  const first = await port(store);
  await first.models.beforeRequest({ model: "m" });
  await first.models.afterRequest({ input: 1, output: 1, cacheRead: 0, usd: 0.01 });
  assert.deepEqual(sessionSpendOf(await records(store)).cost, { usd: 0.01, soFarUsd: 0.01, unpriced: 0 }, "every request answered: known");
  await first.models.beforeRequest({ model: "m" });
  assert.deepEqual(sessionSpendOf(await records(store)).cost, { usd: null, soFarUsd: 0.01, unpriced: 1 }, "one with no answer: unknown, $0.01 known so far");
  const second = await port(store);
  await second.bookCut();
  assert.deepEqual(sessionSpendOf(await records(store)).cost, { usd: null, soFarUsd: 0.01, unpriced: 1 }, "booked cut: still unknown");
});

test("the cap's admission gives a request's bound: for a request priced from the session's cache, what a miss adds to its hold", async () => {
  const warm = { model: SONNET.id, cachedTokens: 90_000, inputTokens: 10_000, boundTokens: 100_000, endedAt: T0 - 1_000 };
  const ask = { key, label: key, model: SONNET.id, turn: 1, maxTurns: null, spentUsd: 0, inFlight: [], inputTokensMax: 100_000, outputTokensAsked: 1_024, outputTokensLeast: 1_024 };
  const cached = await beforeRequestOf({ capUsd: () => 1, modelOf: () => SONNET, now: () => T0, previousOf: () => warm })(ask);
  const cold = await beforeRequestOf({ capUsd: () => 1, modelOf: () => SONNET, now: () => T0 })(ask);
  assert.ok(typeof cached.boundUsd === "number" && cached.boundUsd > 0, `a bound above $0: ${JSON.stringify(cached)}`);
  near(cached.holdUsd + cached.boundUsd, cold.holdUsd, "its hold and bound are the request priced uncached");
  assert.equal(cold.boundUsd, 0, "a request priced uncached has no bound");
});
