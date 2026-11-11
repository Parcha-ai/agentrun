// A workflow call node's hold on the run's one ledger (workflow-spec.ts holdAtEffects): taken once the driver has admitted
// its effect, before it runs,
// taken over by the effect's paid request (heldBooking, reservedBooking), and given back when nothing took it. A hold given
// back is settled marked so (RunTools.settle's givenBack): its record is never a $0 charge or an unpriced one, so the run's
// timeline shows no row for it. A request charged by anyone but whom the hold was taken for is refused unsent: it would
// book under the wrong name.
import assert from "node:assert/strict";
import { test } from "node:test";

const { holdAtEffects, heldBooking, releaseCallHold } = await import("../dist/runner/workflow-spec.js");
const { CapRefused } = await import("@parcha/agentrun-kernel/kernel/cap");

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
    flush: async () => {},
  });
  // The hold is taken inside the driver's admission (admittedEffect); here no driver stands between the two halves.
  const call = (inner) => cap.effect(cap.admittedEffect(inner))({ node: { label: "search-0", tool: "web_search" }, input: {}, executionPath: "0", effect: { id: "e0" } });
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

/** The two halves with a stand-in for the driver between them: each call of the outer half is one admission, answered
 *  from `receipts` (an earlier claim's completed effects, in order) before any new one runs the admitted half. Its ledger
 *  refuses each hold with `refusals` (in order; none left: admitted). */
function admissions({ receipts = [], refusals = [] } = {}) {
  const log = [];
  const paid = {
    admit: async (request) => {
      const refusal = refusals.shift();
      if (refusal) { log.push(["refused", refusal.forGood]); throw refusal; }
      log.push(["admit", request.id]);
      return { id: request.id, heldUsd: request.holdUsd, boundUsd: 0, worstUsd: request.holdUsd, stoppedUsd: () => request.holdUsd };
    },
    settle: async (id, usd, options) => (log.push(["settle", id, usd, options?.givenBack === true]), usd),
    spentUsd: () => 0,
    heldUsd: () => 0,
  };
  const controller = new AbortController();
  const cap = holdAtEffects({ effect: (fn) => fn }, {
    paid: () => paid,
    holdOf: () => ({ usd: 0.005, name: "Parallel's search", basis: "Parallel's list price", chargedBy: "parallel" }),
    park: (refusal) => { log.push(["park", refusal.message]); controller.abort(new Error("parked")); },
    flush: async () => void log.push(["flush"]),
  });
  let ordinal = 0;
  const run = cap.admittedEffect(async () => (log.push(["sent"]), "found"));
  const driver = async (params) => {
    const id = `e${ordinal++}`;
    if (receipts.length) return receipts.shift();
    const value = await run({ ...params, effect: { id } });
    log.push(["completed", id, value]);
    return value;
  };
  const call = () => cap.effect(driver)({ node: { label: "search-0", tool: "web_search" }, input: {}, executionPath: "0", signal: controller.signal });
  return { log, call };
}

test("a hold refused for room once the driver admitted the call ends its effect held, nothing sent; the run parks only once that end is flushed", async () => {
  const { log, call } = admissions({ refusals: [new CapRefused("no room", { forGood: false, spentUsd: 0.9 })] });
  const thrown = await call().then(() => undefined, (error) => error);
  assert.equal(thrown?.message, "parked");
  const ended = log.find(([op]) => op === "completed");
  assert.deepEqual(ended?.[2]?.ok, false, `ended as a returned failure, which no continuation answers a call from: ${JSON.stringify(log)}`);
  assert.deepEqual(log.map(([op]) => op), ["refused", "completed", "flush", "park"], JSON.stringify(log));
});

test("an earlier claim's held end (its receipt) is that claim's park: the call goes again as a new effect, held and sent once", async () => {
  const { log, call } = admissions({ receipts: [{ ok: false, agentrun_serve_cap_held: "no room" }] });
  assert.equal(await call(), "found");
  assert.deepEqual(log.filter(([op]) => op !== "settle"), [["admit", "search-0@0#e1"], ["sent"], ["completed", "e1", "found"]], JSON.stringify(log));
});

test("a hold refused for good once the driver admitted the call ends its effect failed in the cap's words, nothing sent, never parked", async () => {
  const { log, call } = admissions({ refusals: [new CapRefused("no price for it", { forGood: true, spentUsd: null })] });
  const thrown = await call().then(() => undefined, (error) => error);
  // No `failing` stands outside here: the failure is the outcome the driver completes the effect with.
  assert.equal(thrown, undefined);
  assert.deepEqual(log.map(([op, , value]) => [op, value]), [["refused", undefined], ["completed", { agentrun_serve_tool_failed: 'call node "search-0": no price for it' }]], JSON.stringify(log));
});
