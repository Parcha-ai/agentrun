// The sealed Stagehand's attach steps (src/driver/sealed.ts): a step that names where it went, and a cancelled attach that
// stops at once and hands anything that still attaches later back to be let go.
import assert from "node:assert/strict";
import test from "node:test";
import { attachStep, throwIfCancelled, untilCancelled } from "../dist/driver/sealed.js";

const later = () => { let resolve, reject; const promise = new Promise((y, n) => { resolve = y; reject = n; }); return { promise, resolve, reject }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("a failed attach step names the host it went to and keeps the original as its cause; a step that succeeds is untouched", async () => {
  const step = attachStep("10.0.0.5:9222");
  const cause = { toString: () => "[object Object]" };
  await assert.rejects(step(Promise.reject(cause)), (error) => error.message === "attaching to the browser at 10.0.0.5:9222 failed: [object Object]" && error.cause === cause);
  await assert.rejects(step(Promise.reject(new Error("ECONNREFUSED"))), (error) => error.message === "attaching to the browser at 10.0.0.5:9222 failed: ECONNREFUSED");
  assert.equal(await step(Promise.resolve(7)), 7);
});

test("throwIfCancelled does nothing for a live signal or none, and throws the reason, or an AbortError, for an ended one", () => {
  throwIfCancelled(undefined);
  throwIfCancelled(new AbortController().signal);
  const reason = new Error("the turn ended");
  assert.throws(() => throwIfCancelled(AbortSignal.abort(reason)), (error) => error === reason);
  assert.throws(() => throwIfCancelled(AbortSignal.abort("gone")), (error) => error.name === "AbortError" && error.message === "the attach was cancelled");
});

test("untilCancelled: with no signal, or one that never ends, the step's own outcome", async () => {
  const released = [];
  assert.equal(await untilCancelled(Promise.resolve("a"), undefined, (late) => released.push(late)), "a");
  assert.equal(await untilCancelled(Promise.resolve("b"), new AbortController().signal, (late) => released.push(late)), "b");
  const failed = new Error("refused");
  await assert.rejects(untilCancelled(Promise.reject(failed), new AbortController().signal, (late) => released.push(late)), (error) => error === failed);
  assert.deepEqual(released, [], "nothing is released that the call returned");
});

test("untilCancelled: a cancel ends the call at once, and the step that succeeds afterwards is released", async () => {
  const step = later();
  const controller = new AbortController();
  const released = [];
  const call = untilCancelled(step.promise, controller.signal, (late) => released.push(late));
  const reason = new Error("the reconnect's budget ran out");
  controller.abort(reason);
  await assert.rejects(call, (error) => error === reason);
  assert.deepEqual(released, []);
  step.resolve("browser");
  await tick();
  assert.deepEqual(released, ["browser"], "the late attach is let go");
});

test("untilCancelled: a signal already ended rejects without waiting, and still releases the step's late success; a late failure is dropped", async () => {
  const released = [];
  const ok = later();
  await assert.rejects(untilCancelled(ok.promise, AbortSignal.abort("gone"), (late) => released.push(late)), (error) => error.name === "AbortError");
  ok.resolve("late");
  const bad = later();
  const controller = new AbortController();
  const call = untilCancelled(bad.promise, controller.signal, (late) => released.push(late));
  controller.abort();
  await assert.rejects(call, (error) => error.name === "AbortError");
  bad.reject(new Error("failed after the cancel"));
  await tick();
  assert.deepEqual(released, ["late"]);
});
