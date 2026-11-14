// A pi turn's wait whose claim's signal aborts while the wait is being registered (a runner's close, or a lost claim,
// while a resumed loop opens its session) ends the turn interrupted, and leaves no rejection nothing handles.
//
// pi-durable 1.5.0 answers a wait registered after its context's signal aborted with a promise it rejects at once
// (harness/util.js Waiters.add), handed back only when the Session's line delivers the read that registered it
// (harness/submissions.js wait, harness/scheduler.js waitForTask): after the commits before it are published. While one
// publishes (a Postgres round trip), that rejection has no handler, and Node says it is unhandled: the runner process
// exits on it (runner/main.ts lastResort), and a test in whose async context it falls fails with the abort's reason
// ("the runner is closing" in adapter-pi-steer-later's close on Postgres, seen once in CI and 4 times in 200 runs on a
// loaded machine). The Harness here is that wait's behaviour made certain: the read is held until the test aborts the
// signal, and the delivery comes a macrotask after the registration, as a publication's round trip makes it.
import assert from "node:assert/strict";
import { setImmediate as macrotask } from "node:timers/promises";
import { test } from "node:test";

const { piAdapter } = await import("../dist/runner/adapters/pi.js");

/** A pi-durable Harness with one root conversation, as far as the adapter's session reads it, whose submissions wait as
 *  pi-durable 1.5.0's do (see above). `read` holds each wait's line read until released. */
function harnessLike() {
  let release = () => {};
  const read = new Promise((resolve) => (release = resolve));
  /** Each wait's registration, with or without a signal, once its read is done. */
  const registered = [];
  /** Settles every registered waiter on the Harness's close, as pi-durable's Submissions close rejects them. */
  const closing = [];
  const submission = (id) => ({
    id,
    wait: async (context) => {
      const signal = context.abortSignal;
      await read;
      registered.push({ signal: signal !== undefined });
      // Waiters.add: an aborted signal is answered with a promise rejected now; else a waiter its abort rejects.
      const promise = signal?.aborted
        ? Promise.reject(signal.reason)
        : new Promise((_, reject) => {
          closing.push(() => reject(new Error("the session closed")));
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      // The line's delivery: after the commits before it are published, a store round trip later.
      await macrotask();
      return promise;
    },
  });
  const root = {
    id: 1,
    configure: async () => {},
    submit: async () => submission(7),
    abort: async () => {},
  };
  const harness = {
    root: async () => root,
    commit: async (work) => work({ submissionByRequest: () => undefined }),
    submission: async (id) => submission(id),
    inspect: async () => ({ submissions: [] }),
    waitForIdle: async () => {},
  };
  return { harness, release, registered, close: () => closing.forEach((settle) => settle()) };
}

test("a pi turn whose claim's signal aborts while its wait registers ends interrupted, and no rejection goes unhandled", async (t) => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(String(reason?.message ?? reason));
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));
  const { harness, release, registered, close } = harnessLike();
  const run = { harness, registry: { install: () => {} }, setModels: () => {} };
  const adapter = piAdapter({ run, model: "claude-sonnet-5-5", provider: { api: "anthropic-messages", origin: "https://faux.invalid", credential: () => "not-a-secret" } });
  const claim = new AbortController();
  const events = [];
  const session = await adapter.open(
    { key: "root", label: "root", system: [], tools: [], context: "fresh" },
    { signal: claim.signal, models: {}, onEvent: (event) => events.push(event) },
  );
  t.after(() => session.close());
  t.after(close);
  // The turn is placed and its wait asked; the claim's signal aborts while the wait's read is on the line.
  await session.send("Answer.");
  claim.abort(new Error("the runner is closing"));
  release();
  const end = await session.turnEnd();
  // The macrotasks a publication would take, and Node's report of a rejection with no handler after them.
  for (let i = 0; i < 5; i++) await macrotask();
  assert.deepEqual(unhandled, [], "no rejection went unhandled");
  assert.equal(end.status, "interrupted", `the turn ended interrupted: ${JSON.stringify(end)}`);
  assert.deepEqual(events.filter((event) => event.type === "turn_end"), [{ type: "turn_end", status: "interrupted" }]);
  assert.equal(registered.length, 1, "the wait was asked once");
});

test("a pi turn's wait asked after the claim's signal aborted ends interrupted at once, and pi-durable is never asked", async (t) => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(String(reason?.message ?? reason));
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));
  const { harness, release, registered, close } = harnessLike();
  release();
  const run = { harness, registry: { install: () => {} }, setModels: () => {} };
  const adapter = piAdapter({ run, model: "claude-sonnet-5-5", provider: { api: "anthropic-messages", origin: "https://faux.invalid", credential: () => "not-a-secret" } });
  const claim = new AbortController();
  const session = await adapter.open({ key: "root", label: "root", system: [], tools: [], context: "fresh" }, { signal: claim.signal, models: {}, onEvent: () => {} });
  t.after(() => session.close());
  t.after(close);
  claim.abort(new Error("the runner is closing"));
  await session.send("Answer.");
  const end = await session.turnEnd();
  for (let i = 0; i < 5; i++) await macrotask();
  assert.deepEqual(unhandled, [], "no rejection went unhandled");
  assert.equal(end.status, "interrupted");
  assert.equal(end.error, "the runner is closing", "the turn's error is the abort's reason");
  assert.deepEqual(registered, [], "no wait was registered on an aborted signal");
});

test("a pi turn's wait that settles before any abort answers as before: completed", async (t) => {
  const run = {
    registry: { install: () => {} },
    setModels: () => {},
    harness: {
      root: async () => ({ id: 1, configure: async () => {}, submit: async () => ({ id: 7, wait: async () => ({ status: "done" }) }), abort: async () => {} }),
      commit: async (work) => work({ submissionByRequest: () => undefined }),
    },
  };
  const adapter = piAdapter({ run, model: "claude-sonnet-5-5", provider: { api: "anthropic-messages", origin: "https://faux.invalid", credential: () => "not-a-secret" } });
  const claim = new AbortController();
  const session = await adapter.open({ key: "root", label: "root", system: [], tools: [], context: "fresh" }, { signal: claim.signal, models: {}, onEvent: () => {} });
  t.after(() => session.close());
  await session.send("Answer.");
  assert.deepEqual(await session.turnEnd(), { status: "completed" });
});
