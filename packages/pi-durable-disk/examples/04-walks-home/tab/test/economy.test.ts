import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Economy } from '../src/economy.ts';

/** Run frames at 60 Hz from `from` for `ms`, and count the ones that work. */
const run = (e: Economy, from: number, ms: number, dragging = false, playing = false) => { let n = 0; for (let i = 0; i < Math.round(ms / (1000 / 60)); i++) if (e.frame(from + i * (1000 / 60), dragging, playing)) n++; return n; };

test('a standalone page (not embedded) always works every frame', () => {
  const e = new Economy({ enabled: false });
  assert.equal(run(e, 0, 1000), 60);
  e.pause(true, 0);
  assert.equal(e.paused, false, 'pausing is for the embedded page only');
});

test('embedded: full rate for a while after an event, then a low rate, then full again on the next event', () => {
  const e = new Economy({ enabled: true, fullMs: 2000, lowIntervalMs: 125 });
  e.wake(0);
  assert.ok(run(e, 0, 2000) >= 119, 'full: every frame for the two seconds');
  const low = run(e, 2100, 4000);
  assert.ok(low >= 30 && low <= 34, `low: one frame in 125 ms is about 8 a second (got ${low} in 4 s)`);
  e.wake(7000);
  assert.ok(run(e, 7000, 1000) >= 59, 'an event brings the full rate back');
});

test('embedded: paused does nothing at all, and resuming wakes it to full rate for the window', () => {
  const e = new Economy({ enabled: true, fullMs: 1000, lowIntervalMs: 125 });
  e.pause(true, 0);
  assert.equal(run(e, 0, 5000), 0);
  assert.equal(e.paused, true);
  e.pause(false, 5000);
  assert.ok(run(e, 5000, 1000) >= 59, 'full again for the window');
  assert.ok(run(e, 6500, 1000) <= 9, 'then low');
  assert.ok(e.ticks > e.worked, 'frames that did no work are counted');
});

test('embedded: dragging is full rate for as long as it lasts', () => {
  const e = new Economy({ enabled: true, fullMs: 500, lowIntervalMs: 125 });
  assert.ok(run(e, 0, 3000, true) >= 179, 'every frame while the pointer is down');
});

test('embedded: a policy that drives the robot keeps the full rate for as long as it plays; the parent can hold the low rate while the model generates, and a drag still gets the full rate', () => {
  const e = new Economy({ enabled: true, fullMs: 500, lowIntervalMs: 125 });
  assert.ok(run(e, 0, 5000, false, true) >= 299, 'a skill that plays is never at the low rate');
  e.throttle(true);
  const held = run(e, 6000, 3000, false, true);
  assert.ok(held >= 22 && held <= 26, `held low while the model generates (got ${held} in 3 s)`);
  assert.ok(run(e, 10000, 1000, true, true) >= 59, 'a drag is full rate even then');
  e.throttle(false);
  assert.ok(run(e, 12000, 1000, false, true) >= 59, 'and back to full when the model is done');
  const off = new Economy({ enabled: false });
  off.throttle(true);
  assert.equal(off.throttled, false, 'a standalone page is never throttled');
});
