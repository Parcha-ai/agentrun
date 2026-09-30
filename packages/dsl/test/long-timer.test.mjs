// A workflow's deadline_s / poll.deadline_s / poll.interval_s / retry.backoff_s carry no ceiling, so
// the delays derived from them can exceed Node's 2^31-1 ms timer limit. setLongTimeout re-arms in
// chunks so such a delay fires on time instead of overflowing to a near-immediate fire. These use
// fake timers to prove a 30-day delay fires neither early nor late, and that clear() cancels it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setLongTimeout, MAX_TIMER_DELAY_MS } from "../dist/long-timer.js";

const THIRTY_DAYS_MS = 2_592_000 * 1000; // 30 days in ms, well past MAX_TIMER_DELAY_MS (~24.8 days)

test("a 30-day delay fires neither early nor late (re-armed past Node's 2^31-1 ms limit)", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  assert.ok(THIRTY_DAYS_MS > MAX_TIMER_DELAY_MS, "the delay exceeds a single Node timer");
  let fired = 0;
  setLongTimeout(() => { fired += 1; }, THIRTY_DAYS_MS);
  t.mock.timers.tick(MAX_TIMER_DELAY_MS);
  assert.equal(fired, 0, "does not fire after one max-length chunk");
  t.mock.timers.tick(THIRTY_DAYS_MS - MAX_TIMER_DELAY_MS - 1);
  assert.equal(fired, 0, "does not fire one tick early");
  t.mock.timers.tick(1);
  assert.equal(fired, 1, "fires exactly on time");
  t.mock.timers.tick(THIRTY_DAYS_MS);
  assert.equal(fired, 1, "fires once, not again");
});

test("clear() cancels a long delay before it fires", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let fired = 0;
  const timer = setLongTimeout(() => { fired += 1; }, THIRTY_DAYS_MS);
  t.mock.timers.tick(MAX_TIMER_DELAY_MS);
  timer.clear();
  t.mock.timers.tick(THIRTY_DAYS_MS);
  assert.equal(fired, 0, "a cleared long timer never fires");
});

test("a sub-limit delay still fires like an ordinary timer", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let fired = 0;
  setLongTimeout(() => { fired += 1; }, 1000);
  t.mock.timers.tick(999);
  assert.equal(fired, 0);
  t.mock.timers.tick(1);
  assert.equal(fired, 1);
});
