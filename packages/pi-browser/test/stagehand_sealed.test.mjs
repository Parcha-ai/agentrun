// The sealed Stagehand's creation (src/driver/sealed.ts): one more try when the extension is still running an earlier
// attach's init, a cancelled attach that never starts an init of its own, and attach steps that name where they went.
import assert from "node:assert/strict";
import test from "node:test";
import { BrowserFailureError } from "../dist/core/custody.js";
import { STAGEHAND_INIT_IN_PROGRESS } from "../dist/driver/stagehand.js";
import { attachStep, createSealed, initInProgress, throwIfCancelled } from "../dist/driver/sealed.js";

/** The error Stagehand.create throws when the extension refuses an init: its JSON-RPC error as the cause. */
const busy = () => Object.assign(new Error("init failed"), { cause: { code: -32603, message: STAGEHAND_INIT_IN_PROGRESS } });
/** A create that answers each call from `answers` in turn: a value is returned, an Error thrown. */
const creates = (...answers) => {
  const calls = { create: 0, wait: 0 };
  const create = async () => { const answer = answers[calls.create++]; if (answer instanceof Error) throw answer; return answer; };
  const wait = async () => { calls.wait += 1; };
  return { calls, create, wait };
};

test("the public message is the one the sealed steps recognise, and only an error caused by it counts as an init in progress", () => {
  assert.equal(STAGEHAND_INIT_IN_PROGRESS, "Stagehand initialization is already in progress");
  assert.equal(initInProgress(busy()), true);
  assert.equal(initInProgress(new Error(STAGEHAND_INIT_IN_PROGRESS)), false, "the text alone, with no JSON-RPC cause, is not the extension's refusal");
  assert.equal(initInProgress(Object.assign(new Error("x"), { cause: { code: "-32603", message: STAGEHAND_INIT_IN_PROGRESS } })), false, "a code that is not a number");
  assert.equal(initInProgress(null), false);
});

test("a first create that succeeds is returned, with no wait", async () => {
  const c = creates("stagehand");
  assert.equal(await createSealed(c.create, c.wait, "127.0.0.1:9222"), "stagehand");
  assert.deepEqual(c.calls, { create: 1, wait: 0 });
});

test("any other error from the first create is thrown as it is, with no wait and no second create", async () => {
  const other = new Error("Chrome went away");
  const c = creates(other);
  await assert.rejects(createSealed(c.create, c.wait, "h"), (error) => error === other);
  assert.deepEqual(c.calls, { create: 1, wait: 0 });
});

test("an init still running in the extension is waited out once, and the instance is created once more only after that wait ends", async () => {
  const c = creates(busy(), "second");
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const wait = () => { c.calls.wait += 1; return held; };
  const result = createSealed(c.create, wait, "h");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(c.calls, { create: 1, wait: 1 }, "no second create while the earlier init is still running");
  release();
  assert.equal(await result, "second");
  assert.deepEqual(c.calls, { create: 2, wait: 1 });
});

test("a call cancelled before the wait starts no wait and no init of its own", async () => {
  const c = creates(busy(), "never");
  const controller = new AbortController();
  const reason = new Error("the turn ended");
  controller.abort(reason);
  await assert.rejects(createSealed(c.create, c.wait, "h", controller.signal), (error) => error === reason);
  assert.deepEqual(c.calls, { create: 1, wait: 0 });
});

test("a call cancelled during the wait starts no init of its own, and a reason that is not an Error ends it as an AbortError", async () => {
  const controller = new AbortController();
  const c = creates(busy(), "never");
  const wait = async () => { c.calls.wait += 1; controller.abort("gone"); };
  await assert.rejects(createSealed(c.create, wait, "h", controller.signal), (error) => error instanceof Error && error.name === "AbortError" && error.message === "the attach was cancelled");
  assert.deepEqual(c.calls, { create: 1, wait: 1 });
});

test("a second refusal is the browser still busy: browser_unavailable, retryable, naming the host and the 60 s it waited", async () => {
  const c = creates(busy(), busy());
  await assert.rejects(createSealed(c.create, c.wait, "127.0.0.1:41234"), (error) => {
    assert.ok(error instanceof BrowserFailureError);
    assert.equal(error.failure.code, "browser_unavailable");
    assert.equal(error.failure.retryable, true);
    assert.match(error.message, /^The browser at 127\.0\.0\.1:41234 is still finishing an earlier connection after 60 s\./);
    return true;
  });
  assert.deepEqual(c.calls, { create: 2, wait: 1 });
});

test("any other error from the second create is thrown as it is", async () => {
  const other = new Error("the extension crashed");
  const c = creates(busy(), other);
  await assert.rejects(createSealed(c.create, c.wait, "h"), (error) => error === other);
});

test("a failed attach step names the host it went to and keeps the original as its cause; a step that succeeds is untouched", async () => {
  const step = attachStep("10.0.0.5:9222");
  const cause = { toString: () => "[object Object]" };
  await assert.rejects(step(Promise.reject(cause)), (error) => error.message === "attaching to the browser at 10.0.0.5:9222 failed: [object Object]" && error.cause === cause);
  await assert.rejects(step(Promise.reject(new Error("ECONNREFUSED"))), (error) => error.message === "attaching to the browser at 10.0.0.5:9222 failed: ECONNREFUSED");
  assert.equal(await step(Promise.resolve(7)), 7);
});

test("throwIfCancelled does nothing for a live signal or none", () => {
  throwIfCancelled(undefined);
  throwIfCancelled(new AbortController().signal);
});
