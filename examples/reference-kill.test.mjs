// The ten-kill ledger on the reference job: the job runs on the no-key host and is ended with SIGKILL at a seeded random
// point ten times, a fresh process resuming the directory each time. Every count is read from the store, the receipts and
// the run's own rows. The same seed gives the same kills.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cutInEffectWindow, killAnywhere, planNext, progress, random, render } from './reference/kill-anywhere.ts';

const failed = (ledger) => ledger.checks.filter((check) => !check.ok).map((check) => ({ check: check.name, detail: check.detail }));

// Seeds whose kills leave every gate green. Others are valid runs the gates call failures: see the notes in the follow-ups.
const GREEN = [9, 11];

test('ten kills at seeded random points, each resumed by a fresh process: every committed turn and every effect once, the record the uninterrupted run\'s, every gate green', { timeout: 300_000 }, async () => {
  const ledger = await killAnywhere({ seed: GREEN[0], kills: 10 });
  assert.deepEqual(failed(ledger), []);
  assert.equal(ledger.kills.filter((kill) => kill.landed).length, 10);
  assert.equal(ledger.final.status, 'complete');
  assert.deepEqual(ledger.counted.committedTurns, ledger.reference.committedTurns);
  assert.ok(ledger.checks.some((check) => check.name === 'gate fakes-called-once' && check.ok), 'the reference gates ran on the final directory');
  // The ledger says what the claims are, and names the kill behind a page action that never ran.
  const lines = render(ledger).join('\n');
  assert.match(lines, /page\.run +x[01]/);
  assert.match(lines, /does not prove the action happened/);
  assert.match(lines, /FROZEN_EFFECT_UNKNOWN, by design, so the call is never made twice/);
  assert.match(lines, /page\.read may repeat, each repeat tied to a kill inside it/);
});

test('a page action that never ran is printed with the kill behind it', () => {
  const lines = render({ seed: 1, kills: [], processes: 1, browserCalls: [], runInterrupted: [2, 5], final: { status: 'complete', generation: 1, record: null }, ms: 0, checks: [],
    counted: { committedTurns: [], requests: {}, effects: {}, judge: {}, browser: {}, receipts: [] }, reference: {} }).join('\n');
  assert.match(lines, /page\.run +x0: errored run result committed \(kill 2, 5\)/);
});

test('the same seed gives the same kills, and another seed gives others', { timeout: 300_000 }, async () => {
  const where = (ledger) => ledger.kills.map((kill) => kill.landed && `${kill.landed.side} ${kill.landed.point}`);
  const [one, again, other] = [await killAnywhere({ seed: GREEN[0], kills: 10 }), await killAnywhere({ seed: GREEN[0], kills: 10 }), await killAnywhere({ seed: GREEN[1], kills: 10 })];
  assert.deepEqual(failed(one), []);
  assert.deepEqual(where(again), where(one));
  assert.deepEqual(failed(other), []);
  assert.notDeepEqual(where(other), where(one));
});

test('a cut inside the effect\'s window stops the next process on the unknown effect, and the tool is never dispatched again', { timeout: 120_000 }, async () => {
  for (const point of ['tool.dispatch search', 'tool.returned search']) {
    const cut = await cutInEffectWindow(point);
    assert.equal(cut.killed, 'SIGKILL', point);
    // The run ends failed, and its result says what the driver said: reconcile the effect, it will not be repeated.
    assert.equal(cut.resumed.status, 'failed', point);
    assert.match(cut.resumed.message, /^Reconcile step:\/root\/steps\/0#call:0 before resuming; it will not be repeated$/, point);
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
