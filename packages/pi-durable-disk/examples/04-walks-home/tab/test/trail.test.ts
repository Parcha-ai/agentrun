import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ticker, Trail, formatDistance } from '../src/trail.ts';

test('distance is metres from where the version started, on the ground plane', () => {
  const t = new Trail();
  t.reset(1, 2);
  assert.equal(t.distance(1, 2), 0);
  assert.equal(t.distance(4, 6), 5);
  assert.ok(Math.abs(t.distance(1.3, 2) - 0.3) < 1e-12);
});

test('a new version starts the count over, from where the creature is at that moment, and clears the trail', () => {
  const t = new Trail();
  t.reset(0, 0);
  for (let x = 0.1; x <= 2; x += 0.1) t.add(x, 0);
  assert.ok(t.points.length > 5);
  t.reset(2, 0);
  assert.equal(t.points.length, 0);
  assert.equal(t.distance(2, 0), 0);
  assert.equal(t.distance(3, 0), 1);
});

test('the trail drops a point only after the creature has moved a step from the last one, and keeps the newest when it is full', () => {
  const t = new Trail(5, 1);
  t.reset(0, 0);
  assert.equal(t.add(0.5, 0), false, 'less than a step');
  assert.equal(t.add(1, 0), true);
  assert.equal(t.add(1.5, 0), false, 'a step from the last point, not from the origin');
  for (let i = 2; i <= 10; i++) t.add(i, 0);
  assert.equal(t.points.length, 5);
  assert.deepEqual(t.points.map((p) => p.x), [6, 7, 8, 9, 10], 'the newest five');
});

test('the number on screen has one decimal and never says -0.0', () => {
  assert.equal(formatDistance(0), '0.0');
  assert.equal(formatDistance(-0.0001), '0.0');
  assert.equal(formatDistance(3.449), '3.4');
  assert.equal(formatDistance(3.45), '3.5');
  assert.equal(formatDistance(12.04), '12.0');
});

test('the walk meter ticks once per simulated second, once per call even after a long gap, and starts over when simulated time goes back', () => {
  const tk = new Ticker(1);
  assert.equal(tk.due(0), false, 'not at the start');
  assert.equal(tk.due(0.99), false);
  assert.equal(tk.due(1.0), true);
  assert.equal(tk.due(1.5), false);
  assert.equal(tk.due(2.01), true);
  assert.equal(tk.due(9.5), true, 'one tick for a long gap, not seven');
  assert.equal(tk.due(9.6), false);
  assert.equal(tk.due(0.2), false, 'time went back (a reset): start over');
  assert.equal(tk.due(1.2), true);
});
