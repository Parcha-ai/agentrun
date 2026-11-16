// The template eval's trigger clock (eval-mailbox.ts evalClock): `to` moves it on to a time, and every timer due by then
// fires; a timer it leaves fires when the clock, running on from there, reaches the timer's time, never on the real wait
// it was armed with before the move. The engine arms its timer for `soonest - now()` and the clock reads its own now()
// a moment later: a timer armed across a millisecond's tick lands a millisecond past the time the eval moves to.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { evalClock } from "../dist/eval-mailbox.js";

test("a timer armed a millisecond past the time the clock is moved to fires a moment after the move, not on the real wait it was armed with", async (t) => {
  const real = Date.now;
  let wall = real();
  Date.now = () => wall;
  t.after(() => (Date.now = real));
  const clock = evalClock();
  const at = clock.now() + 15 * 60_000;
  let fired = 0;
  // The engine's arm (triggers.ts arm): the wait read on one now(), the clock's own read on the next, a millisecond on.
  const ms = at - clock.now();
  wall += 1;
  clock.arm(() => fired++, ms);
  clock.to(at);
  assert.equal(clock.now(), at, "moved to the time");
  for (const end = real() + 2_000; fired === 0 && real() < end; ) await sleep(5);
  assert.equal(fired, 1, "the timer a millisecond past the time fired once the clock ran on past it");
});

test("a timer armed for the time the clock is moved to fires on the move, once; one armed further on waits for its own time", async (t) => {
  const real = Date.now;
  const wall = real();
  Date.now = () => wall;
  t.after(() => (Date.now = real));
  const clock = evalClock();
  const at = clock.now() + 60 * 60_000;
  const fired = [];
  clock.arm(() => fired.push("on time"), at - clock.now());
  clock.arm(() => fired.push("later"), at + 10 * 60_000 - clock.now());
  clock.to(at);
  assert.deepEqual(fired, ["on time"]);
  await sleep(50);
  assert.deepEqual(fired, ["on time"], "the later one waits for its time");
  clock.to(at + 10 * 60_000);
  assert.deepEqual(fired, ["on time", "later"]);
});
