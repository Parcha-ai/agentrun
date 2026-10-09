import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ring, Stats } from '../src/stats.ts';

test('Ring keeps the latest values and answers percentiles and max', () => {
  const r = new Ring(4);
  assert.equal(r.percentile(0.5), null);
  assert.equal(r.max(), null);
  for (const v of [10, 20, 30, 40]) r.push(v);
  assert.equal(r.percentile(0.5), 30);
  assert.equal(r.max(), 40);
  r.push(5); r.push(6); // overwrites 10 and 20
  assert.equal(r.count, 4);
  assert.deepEqual([r.percentile(0), r.max()], [5, 40]);
});

test('Stats counts frames and steps, flags non-finite states, and tells an unexpected clock restart from an expected one', () => {
  const s = new Stats();
  s.step(0.02, true, false);
  s.step(0.04, true, false);
  s.step(0.06, false, false); // NaN in qpos
  s.step(0.02, true, false); // the clock went back without us asking: MuJoCo or the page reset it
  s.step(0.04, true, false);
  s.step(0.0, true, true); // the Reset button
  s.step(0.02, true, false);
  assert.equal(s.c.steps, 7);
  assert.equal(s.c.nan, 1);
  assert.equal(s.c.resetsSeen, 1);
  s.frame(1000, 1, 2); s.frame(1016, 2, 3); s.frame(1033, 1, 20);
  const snap = s.snapshot();
  assert.equal(snap.frames, 3);
  assert.equal(snap.frameMs.max, 17);
  assert.equal(snap.drawMs.max, 20);
});
