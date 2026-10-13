// The ten-kill ledger on the reference job: the job runs on the no-key host and is ended with SIGKILL at a seeded random
// point ten times, a fresh process resuming the directory each time. Every count is read from the store, the receipts and
// the run's own rows. The same seed gives the same kills.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cutInEffectWindow, killAnywhere, planNext, progress, random } from './reference/kill-anywhere.ts';

const failed = (ledger) => ledger.checks.filter((check) => !check.ok).map((check) => ({ check: check.name, detail: check.detail }));

test('ten kills at seeded random points, each resumed by a fresh process: every committed turn and every effect once, the record the uninterrupted run\'s', { timeout: 300_000 }, async () => {
  const ledger = await killAnywhere({ seed: 7, kills: 10 });
  assert.deepEqual(failed(ledger), []);
  assert.equal(ledger.kills.filter((kill) => kill.landed).length, 10);
  assert.equal(ledger.final.status, 'complete');
  assert.deepEqual(ledger.counted.committedTurns, ledger.reference.committedTurns);
});

test('the same seed gives the same kills, and another seed gives others', { timeout: 300_000 }, async () => {
  const where = (ledger) => ledger.kills.map((kill) => kill.landed && `${kill.landed.side} ${kill.landed.point}`);
  const [one, again, other] = [await killAnywhere({ seed: 21, kills: 6 }), await killAnywhere({ seed: 21, kills: 6 }), await killAnywhere({ seed: 22, kills: 6 })];
  assert.deepEqual(failed(one), []);
  assert.deepEqual(where(again), where(one));
  assert.notDeepEqual(where(other), where(one));
});

test('a cut inside the effect\'s window stops the next process on the unknown effect, and the tool is never dispatched again', { timeout: 120_000 }, async () => {
  for (const point of ['tool.dispatch search', 'tool.returned search']) {
    const cut = await cutInEffectWindow(point);
    assert.equal(cut.killed, 'SIGKILL', point);
    assert.equal(cut.resumed.status, 'error', point);
    assert.equal(cut.resumed.code, 'FROZEN_EFFECT_UNKNOWN', point);
    assert.deepEqual(cut.effects, { search: 1 }, point);
  }
});

test('the plan: a seed draws the same cuts, a window shrinks with the work left, and progress follows the order of an uncut run', () => {
  const draw = (seed) => { const next = random(seed); return [planNext(next, 10, { child: 30, supervisor: 30 }), planNext(next, 5, { child: 10, supervisor: 0 }), planNext(next, 1, { child: 0, supervisor: 0 })]; };
  assert.deepEqual(draw(3), draw(3));
  assert.notDeepEqual(draw(3), draw(4));
  const late = draw(5)[1];
  assert.equal(late.side, 'child');
  assert.ok(late.n >= 1 && late.n <= 2 * 10 / 5 + 3, `a late window is small: ${late.n}`);
  assert.equal(progress(['a', 'b', 'c', 'd'], [['a', 'b'], ['a', 'x', 'b', 'c']]), 3);
});
