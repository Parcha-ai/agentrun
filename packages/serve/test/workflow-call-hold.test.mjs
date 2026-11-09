// A workflow call node's hold on the run's one ledger (workflow-spec.ts holdAtEffects): taken before its effect runs,
// taken over by the effect's paid request (heldBooking, reservedBooking), and given back when nothing took it. A hold given
// back is settled marked so (RunTools.settle's givenBack): its record is never a $0 charge or an unpriced one, so the run's
// timeline shows no row for it. A request charged by anyone but whom the hold was taken for is refused unsent: it would
// book under the wrong name.
import assert from "node:assert/strict";
import { test } from "node:test";

const { holdAtEffects, heldBooking, releaseCallHold } = await import("../dist/runner/workflow-spec.js");

/** A cap whose effect wrapper passes through, and a ledger that records each admit and settle. */
function fixture({ chargedBy = "parallel" } = {}) {
  const log = [];
  const paid = {
    admit: async (request) => (log.push(["admit", request.id, request.chargedBy ?? null]), { id: request.id, heldUsd: request.holdUsd, boundUsd: 0, worstUsd: request.holdUsd, stoppedUsd: () => request.holdUsd }),
    settle: async (id, usd, options) => (log.push(["settle", id, usd, options?.givenBack === true]), usd),
    spentUsd: () => 0,
    heldUsd: () => 0,
  };
  const cap = holdAtEffects({ effect: (fn) => fn }, {
    paid: () => paid,
    holdOf: () => ({ usd: 0.005, name: "Parallel's search", basis: "Parallel's list price", ...(chargedBy ? { chargedBy } : {}) }),
    park: () => { throw new Error("no park here"); },
  });
  const call = (inner) => cap.effect(inner)({ node: { label: "search-0", tool: "web_search" }, input: {}, executionPath: "0" });
  return { log, call };
}

test("a hold its effect never took is given back marked so, at 0, never settled as a charge", async () => {
  const { log, call } = fixture();
  await call(async () => "answered from a cache, nothing paid");
  assert.deepEqual(log.map(([op, , ...rest]) => [op, ...rest]), [["admit", "parallel"], ["settle", 0, true]], JSON.stringify(log));
});

test("an llm call's hold, given back as its own request is judged, is settled marked given back", async () => {
  // An llm call's hold names no one: its cost is its own model request's.
  const { log, call } = fixture({ chargedBy: null });
  await call(async () => {
    await releaseCallHold();
    return "the llm's answer, booked as its own model request";
  });
  assert.deepEqual(log.map(([op, , ...rest]) => [op, ...rest]), [["admit", null], ["settle", 0, true]], JSON.stringify(log));
});

test("a hold its effect's paid request took is settled at what it charged, never marked given back", async () => {
  const { log, call } = fixture();
  await call(async () => {
    const held = heldBooking();
    await held.paid.admit({ id: "inner", name: "Parallel's search", holdUsd: 0.005, basis: "list", call: held.call, chargedBy: "parallel" });
    await held.paid.settle("inner", 0);
    return "searched, Parallel billed nothing (a 4xx)";
  });
  assert.deepEqual(log.map(([op, , ...rest]) => [op, ...rest]), [["admit", "parallel"], ["settle", 0, false]], JSON.stringify(log));
});

test("a paid request charged by another than whom the hold was taken for is refused unsent, in words", async () => {
  const { call } = fixture();
  let refused;
  await call(async () => {
    const held = heldBooking();
    refused = await held.paid.admit({ id: "inner", name: "Exa's search", holdUsd: 0.001, basis: "list", call: held.call, chargedBy: "exa" }).then(() => undefined, (error) => error);
    return "not sent";
  });
  assert.ok(refused, "refused");
  assert.match(refused.message, /^Not sent: Exa's search is charged by exa, not parallel, whom this call's hold was taken for\.$/);
});
