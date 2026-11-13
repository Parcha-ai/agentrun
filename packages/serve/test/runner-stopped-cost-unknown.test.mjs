// A request our side stopped or lost (booking.ts rules `stopped`, `lost`) has no price of its own (usd null): its
// bookedUsd is the host's estimate (what streamed, or the hold), counted for the cap but never a known charge. As a cost
// the run's reads unknown (its known part kept), as an answer with no price already did (#2386); a request that provably
// never left (rule `nothing`, $0) stays a known zero.
import assert from "node:assert/strict";
import { test } from "node:test";

const { bookedSpend } = await import("../dist/runner/metrics.js");
const { sessionSpendOf } = await import("@parcha/agentrun-kernel");

const e = (conversationId, id, kind, data) => ({ conversationId, id, kind, data });
const root = [e(1, 1, "agentrun.session.key", { key: "harness", conversation: 7 })];
const answered = [e(7, 2, "runner.request", { turn: 1, model: "m" }), e(7, 3, "runner.turn", { turn: 1, usd: 0.01, bookedUsd: 0.01, rule: "answered" })];

for (const [rule, extra] of [["stopped", { stopped: true, heldUsd: 0.05 }], ["lost", {}], ["lost:cut", {}]]) {
  test(`a request booked ${rule} at an estimate reads the run's cost unknown, its known part kept`, () => {
    const entries = [...root, ...answered, e(7, 4, "runner.request", { turn: 2, model: "m" }), e(7, 5, "runner.turn", { turn: 2, usd: null, bookedUsd: 0.05, rule, ...extra })];
    const read = bookedSpend(entries, "model");
    assert.equal(read.usd, null, `unknown, never the estimate as a charge: ${JSON.stringify(read)}`);
    assert.equal(read.known, 0.01);
    assert.equal(read.unpriced, 1);
    const spend = sessionSpendOf(entries.filter((r) => r.conversationId === 7).map((r) => ({ kind: r.kind, data: r.data })));
    assert.deepEqual(spend.cost, { usd: null, soFarUsd: 0.01, unpriced: 1 });
  });
}

test("a request that never left (rule nothing, $0) is a known zero", () => {
  const entries = [...root, ...answered, e(7, 4, "runner.request", { turn: 2, model: "m" }), e(7, 5, "runner.turn", { turn: 2, usd: null, bookedUsd: 0, rule: "nothing:status" })];
  assert.equal(bookedSpend(entries, "model").usd, 0.01);
});
