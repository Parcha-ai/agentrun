// A store transaction's deadline counted from its begin (store/deadline.ts runnableDeadline), the one rule both
// connections keep, SQLite's and Postgres's: only the time this process could run counts. On the real timers, the event
// loop held by a busy wait; the Postgres connection's commit bound moves by what it gave back (`held`).
import assert from "node:assert/strict";
import { test } from "node:test";
import { runnableDeadline, STALL_MS, TICK_MS } from "../dist/store/deadline.js";

const hold = (ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until);
};

test("the time the process was held up is given back, wherever it fell: the deadline fires once the time it could run has passed, and held() says how much", async () => {
  const started = performance.now();
  const fired = new Promise((resolve) => {
    const deadline = runnableDeadline(200, () => {
      resolve({ at: performance.now() - started, held: deadline.held() });
      deadline.clear();
    });
  });
  // The event loop held for 500 ms, across the deadline's 200 ms.
  setTimeout(() => hold(500), 20);
  const { at, held } = await fired;
  assert.ok(held >= 500 - TICK_MS - STALL_MS, `the hold was given back: ${held} ms`);
  assert.ok(at >= 200 + held - TICK_MS, `it fired only once 200 ms of runnable time had passed: at ${at} ms, ${held} held`);
});

test("a deadline whose process was never held up fires on time and gives nothing back; clear() stops it", async () => {
  let fired = false;
  const stopped = runnableDeadline(20, () => (fired = true));
  stopped.clear();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(fired, false);
  const started = performance.now();
  const quick = await new Promise((resolve) => {
    const deadline = runnableDeadline(120, () => {
      resolve({ at: performance.now() - started, held: deadline.held() });
      deadline.clear();
    });
  });
  assert.ok(quick.at >= 119, `never early: ${quick.at} ms`);
  assert.ok(quick.at < 120 + quick.held + 200, `on time, past what it gave back: ${quick.at} ms, ${quick.held} held`);
});
