// A request a lost runner left unanswered is booked cut once, however many bookings of its session read it open (#2331):
// the adapter loop opens a booking each pass of a claim, and two that each read the request unanswered would each book
// it cut, counting its hold and bound twice in the run's spend and its cost unknown twice. The cut is written once (the
// booking reads its session again just before it writes), and a cut written twice regardless counts once.
import assert from "node:assert/strict";
import { test } from "node:test";
import { modelPortFor, RUNNER_RECORDS, sessionSpendOf } from "@parcha/agentrun-kernel";
import { memorySessionStore } from "@parcha/agentrun-kernel/testing";

const KEY = "run:run-1";
/** A session whose lost runner left request 2 unanswered: request 1 answered at $0.01, request 2 held at $0.25 + $0.50. */
async function lostSession(store) {
  const writer = await store.open(KEY);
  await writer.append([
    { kind: RUNNER_RECORDS.request, data: { turn: 1, model: "m", heldUsd: 0.01 } },
    { kind: RUNNER_RECORDS.turn, data: { turn: 1, usd: 0.01, bookedUsd: 0.01, rule: "answered" } },
    { kind: RUNNER_RECORDS.request, data: { turn: 2, model: "m", heldUsd: 0.25, boundUsd: 0.5 } },
  ]);
}

test("two bookings of a session that each read a lost request open book it cut once", async () => {
  const store = memorySessionStore();
  await lostSession(store);
  // Both open over the same records before either books (a pass restarted, or two bookers racing).
  const writer = await store.open(KEY);
  const records = await writer.read();
  const first = await modelPortFor(writer, { key: KEY, label: KEY, records });
  const second = await modelPortFor(writer, { key: KEY, label: KEY, records });
  await first.bookCut();
  await second.bookCut();
  const cuts = (await store.read(KEY)).filter((r) => r.kind === RUNNER_RECORDS.turn && r.data?.cut === true);
  assert.equal(cuts.length, 1, `the lost request booked cut once: ${JSON.stringify(await store.read(KEY))}`);
});

test("a cut written twice for one request counts once in the spend and the cost", () => {
  const records = [
    { kind: RUNNER_RECORDS.request, data: { turn: 1, model: "m", heldUsd: 0.01 } },
    { kind: RUNNER_RECORDS.turn, data: { turn: 1, usd: 0.01, bookedUsd: 0.01, rule: "answered" } },
    { kind: RUNNER_RECORDS.request, data: { turn: 2, model: "m", heldUsd: 0.25, boundUsd: 0.5 } },
    { kind: RUNNER_RECORDS.turn, data: { turn: 2, usd: null, cut: true } },
    { kind: RUNNER_RECORDS.turn, data: { turn: 2, usd: null, cut: true } },
  ];
  const read = sessionSpendOf(records);
  assert.ok(Math.abs(read.spentUsd - 0.76) < 1e-9, `the cut request counted once at its hold and bound: ${read.spentUsd}`);
  assert.deepEqual(read.cost, { usd: null, soFarUsd: 0.01, unpriced: 1 }, "one request of unknown cost, never two");
});
