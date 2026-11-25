// A paid request the run never saw answered (its process died, or its claim was lost and its answer's write was refused)
// may have been billed at a cache miss. The cap held it at its worst case (its whole input uncached), and its hold is
// written on the request's record before it leaves. For the cap, a request with no answer counts at that hold, in every
// later process and after it is booked cut. For the run's cost, such a request makes the cost unknown, with the known
// part so far beside it: a held guess is never shown as spend.
import assert from "node:assert/strict";
import { test } from "node:test";
import { modelPortFor, RUNNER_RECORDS, sessionSpendOf } from "@parcha/agentrun-kernel";
import { memorySessionStore } from "@parcha/agentrun-kernel/testing";
import { beforeRequestOf, pricingOf } from "../dist/kernel/cap/index.js";
import { SONNET } from "./kernel-cap-support.mjs";

const key = "chat:c1";
const HOLD = 0.25;
const near = (actual, expected, what) => assert.ok(actual !== null && Math.abs(actual - expected) < 1e-9, `${what}: ${actual}, not ${expected}`);

/** The booking of session `key` in a new process; its host holds HOLD for each request. `lost()`: from then on, every
 *  write of this booking is refused, as a claim's late write is after its lease ran out (Fenced). */
async function port(store, asked = []) {
  const writer = await store.open(key);
  let refused = false;
  const fenced = {
    key: writer.key,
    read: () => writer.read(),
    append: (records) => (refused ? Promise.reject(Object.assign(new Error("the claim was lost: Fenced"), { name: "Fenced" })) : writer.append(records)),
    flush: () => writer.flush?.(),
  };
  const booking = await modelPortFor(fenced, { key, beforeRequest: (r) => (asked.push(r.spentUsd), { holdUsd: HOLD }) });
  return Object.assign(booking, { lost: () => void (refused = true) });
}
const records = (store) => store.read(key);

test("a request's hold is written on its record before it leaves, and nothing beside it: the hold is its worst case", async () => {
  const store = memorySessionStore();
  const booking = await port(store);
  await booking.models.beforeRequest({ model: "m" });
  // Beside the hold, only when it left (`at`, GRE-4835): no other figure.
  const written = (await records(store)).filter((r) => r.kind === RUNNER_RECORDS.request).map((r) => r.data);
  for (const w of written) assert.match(w.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/, "its record says when it left");
  assert.deepEqual(written.map(({ at: _at, ...rest }) => rest), [{ turn: 1, model: "m", heldUsd: HOLD }]);
});

test("the booking holds each request in flight at its hold until it is answered", async () => {
  const store = memorySessionStore();
  const booking = await port(store);
  assert.equal(booking.heldUsd(), 0);
  await booking.models.beforeRequest({ model: "m" });
  await booking.models.beforeRequest({ model: "m" });
  near(booking.heldUsd(), 2 * HOLD, "two in flight at their holds");
  await booking.models.afterRequest({ input: 1, output: 1, cacheRead: 0, usd: 0.01 });
  near(booking.heldUsd(), HOLD, "one answered: one hold left");
});

test("a request whose claim was lost before its answer was written counts for the cap at its hold in the next process, before and after it is booked cut", async () => {
  const store = memorySessionStore();
  const first = await port(store);
  await first.models.beforeRequest({ model: "m" });
  await first.models.afterRequest({ input: 1, output: 1, cacheRead: 0, usd: 0.01 });
  await first.models.beforeRequest({ model: "m" });
  first.lost();
  // Its answer came after the claim was lost: the write of its cost is refused.
  await assert.rejects(first.models.afterRequest({ input: 1, output: 1, cacheRead: 0, usd: 0.02 }));
  assert.deepEqual((await records(store)).filter((r) => r.kind === RUNNER_RECORDS.turn).map((r) => r.data.turn), [1], "the late answer's cost was never written");

  near(sessionSpendOf(await records(store)).spentUsd, 0.01 + HOLD, "read from the records");
  const asked = [];
  const second = await port(store, asked);
  near(second.spentUsd(), 0.01 + HOLD, "the next process's spend");
  await second.bookCut();
  near(second.spentUsd(), 0.01 + HOLD, "booked cut: the same");
  near(sessionSpendOf(await records(store)).spentUsd, 0.01 + HOLD, "read from the records once booked cut");
  await second.models.beforeRequest({ model: "m" });
  near(asked[0], 0.01 + HOLD, "the next request's cap check sees it");
});

// A request its path saw lost (a broken stream, a gateway's 504 or 524) is booked at its hold (booking.ts): its worst
// case, so a cache miss it was billed at is inside it, in its own process and on the next claim.
test("a request booked lost (a gateway's timeout) counts for the cap at its hold, in its process and on the next claim", async () => {
  const store = memorySessionStore();
  const first = await port(store);
  await first.models.beforeRequest({ model: "m" });
  await first.models.afterRequest({ input: 0, output: 0, cacheRead: 0, usd: null }, undefined, { end: "lost", label: "gateway_timeout" });
  const turn = (await records(store)).find((r) => r.kind === RUNNER_RECORDS.turn)?.data;
  assert.equal(turn?.bookedUsd, HOLD, `booked at its hold: ${JSON.stringify(turn)}`);
  near(first.spentUsd(), HOLD, "its own process's spend");
  near(sessionSpendOf(await records(store)).spentUsd, HOLD, "read from the records");
  const asked = [];
  const second = await port(store, asked);
  near(second.spentUsd(), HOLD, "the next claim's spend");
  await second.models.beforeRequest({ model: "m" });
  near(asked[0], HOLD, "the next request's cap check sees it");
});

test("the run's cost with a request that has no answer is unknown, with the known part so far beside it; answered alone it is known; booked cut at its hold, known as at most", async () => {
  const store = memorySessionStore();
  const first = await port(store);
  await first.models.beforeRequest({ model: "m" });
  await first.models.afterRequest({ input: 1, output: 1, cacheRead: 0, usd: 0.01 });
  assert.deepEqual(sessionSpendOf(await records(store)).cost, { usd: 0.01, soFarUsd: 0.01, unpriced: 0 }, "every request answered: known");
  await first.models.beforeRequest({ model: "m" });
  assert.deepEqual(sessionSpendOf(await records(store)).cost, { usd: null, soFarUsd: 0.01, unpriced: 1 }, "one with no answer: unknown, $0.01 known so far");
  const second = await port(store);
  await second.bookCut();
  // Booked cut by the next process at what was held for it (CUT_AT_HOLD): the most it can have cost, so the cost is known
  // and says it counts one such figure, never blanked.
  assert.deepEqual(sessionSpendOf(await records(store)).cost, { usd: 0.01 + HOLD, soFarUsd: 0.01 + HOLD, unpriced: 0, atMost: 1 }, "booked cut at its hold: known, at most");
});

test("the cap's admission holds a request at its whole input uncached, at the cache-write rate when that is dearer: a miss never costs more", async () => {
  const ask = { key, label: key, model: SONNET.id, turn: 1, maxTurns: null, spentUsd: 0, inFlight: [], inputTokensMax: 100_000, outputTokensAsked: 1_024, outputTokensLeast: 1_024 };
  const admitted = await beforeRequestOf({ capUsd: () => 1, modelOf: () => SONNET })(ask);
  near(admitted.holdUsd, (100_000 * 3.75 + 1_024 * 15) / 1e6, "100,000 tokens at $3.75 (the cache write) and 1,024 out at $15");
  near(admitted.holdUsd, pricingOf(SONNET.price)(100_000, 1_024), "the cap's own worst-case price");
  assert.equal("boundUsd" in admitted, false, "no bound: nothing a miss could add");
});
