// The sealed Stagehand's attach steps (src/driver/sealed.ts): a step that names where it went, and a cancelled attach that
// stops at once and hands anything that still attaches later back to be let go; and the driver's own use of them, over a
// Stagehand module that stands in for the real one.
import assert from "node:assert/strict";
import test from "node:test";
import { attachStep, throwIfCancelled, untilCancelled } from "../dist/driver/sealed.js";
import { stagehandDriver } from "../dist/driver/stagehand.js";

const later = () => { let resolve, reject; const promise = new Promise((y, n) => { resolve = y; reject = n; }); return { promise, resolve, reject }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("a failed attach step names the host it went to and keeps the original as its cause; a step that succeeds is untouched", async () => {
  const step = attachStep("cdp.example.com:9222");
  const cause = { toString: () => "[object Object]" };
  await assert.rejects(step(Promise.reject(cause)), (error) => error.message === "attaching to the browser at cdp.example.com:9222 failed: [object Object]" && error.cause === cause);
  await assert.rejects(step(Promise.reject(new Error("ECONNREFUSED"))), (error) => error.message === "attaching to the browser at cdp.example.com:9222 failed: ECONNREFUSED");
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

/** A Stagehand module whose connect and create each wait for the test, recording what the driver does with the browser. */
function fakeStagehand() {
  const events = [];
  const steps = { connect: later(), create: later() };
  const browser = { disconnect: async () => { events.push("disconnect started"); await tick(); events.push("disconnected"); } };
  const module = {
    localBrowser: { connect: async () => { events.push("connect"); return steps.connect.promise.then(() => browser); } },
    Stagehand: { create: async () => { events.push("create"); return steps.create.promise; } },
  };
  return { events, steps, driver: stagehandDriver({ stagehand: async () => module }) };
}
const TARGET = { sdkCdpUrl: "ws://127.0.0.1:9/devtools/browser/x" };

test("the driver: a cancel while create runs disconnects the browser, then fails with the cancel; the create's late answer is dropped", async () => {
  const fake = fakeStagehand();
  const call = new AbortController();
  const attaching = fake.driver(TARGET, call.signal);
  fake.steps.connect.resolve();
  while (!fake.events.includes("create")) await tick();
  const reason = new Error("the turn ended");
  call.abort(reason);
  await assert.rejects(attaching, (error) => error === reason);
  assert.deepEqual(fake.events, ["connect", "create", "disconnect started", "disconnected"], "disconnected before the failure reached the caller");
  fake.steps.create.resolve({ late: true });
  await tick();
  assert.equal(fake.events.filter((event) => event === "disconnect started").length, 1, "the late create releases nothing more");
});

test("the driver: a create that fails disconnects the browser before the failure reaches the caller", async () => {
  const fake = fakeStagehand();
  const attaching = fake.driver(TARGET, new AbortController().signal);
  fake.steps.connect.resolve();
  while (!fake.events.includes("create")) await tick();
  const failed = new Error("init refused");
  fake.steps.create.reject(failed);
  await assert.rejects(attaching, (error) => error === failed);
  assert.deepEqual(fake.events, ["connect", "create", "disconnect started", "disconnected"]);
});
