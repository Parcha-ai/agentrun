// The ten-kill ledger on the reference job: the job runs on the no-key host and is ended with SIGKILL at a seeded random
// point ten times, a fresh process resuming the directory each time. Every count is read from the store, the receipts and
// the run's own rows. The same seed gives the same kills.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classesOf, CLASSES, cutBrowserAction, cutInEffectWindow, killAnywhere, planNext, progress, random, render } from './reference/kill-anywhere.ts';

const failed = (ledger) => ledger.checks.filter((check) => !check.ok).map((check) => ({ check: check.name, detail: check.detail }));

// The seeds are chosen for coverage, not for how the reference gates read them. Together the two cover every class of crossing
// the random draw reaches; the browser's page action is cut on purpose below.
//   31  model turn, receipt filing, supervisor not applied, supervisor applied, delivery, and a release answer lost
//   40  judge, browser read, receipt filing, supervisor applied, delivery
const SEEDS = [31, 40];
const ALL = Object.keys(CLASSES).filter((name) => name !== 'browser action');

test('ten kills at seeded random points, each resumed by a fresh process: every committed turn and every effect once, the record the uninterrupted run\'s', { timeout: 300_000 }, async () => {
  const covered = new Set();
  for (const seed of SEEDS) {
    const ledger = await killAnywhere({ seed, kills: 10 });
    assert.deepEqual(failed(ledger), [], `seed ${seed}`);
    assert.equal(ledger.kills.filter((kill) => kill.landed).length, 10, `seed ${seed}`);
    assert.equal(ledger.final.status, 'complete');
    assert.deepEqual(ledger.counted.committedTurns, ledger.reference.committedTurns);
    // The reference gates ran, and what they said is in the ledger: a failure is recorded with the rows it wanted.
    assert.ok(ledger.gates.length >= 6, 'the reference gates ran on the final directory');
    for (const gate of ledger.gates.filter((candidate) => !candidate.ok)) assert.ok(gate.wanted !== undefined, `gate ${gate.id} names the rows it wanted`);
    for (const name of ledger.covered) covered.add(name);
    const lines = render(ledger).join('\n');
    assert.match(lines, /page\.run +x[01]/);
    assert.match(lines, /does not prove the action happened/);
    assert.match(lines, /FROZEN_EFFECT_UNKNOWN, by design, so the call is never made twice/);
    assert.match(lines, /page\.read may repeat, each repeat tied to a kill inside it/);
    assert.match(lines, /Reference gates on the final directory/);
  }
  assert.deepEqual(ALL.filter((name) => !covered.has(name)), [], 'every class of crossing the draw reaches is covered by a seed');
});

test('the browser\'s page action is cut before and after it is applied: made at most once, and never again by the resume', { timeout: 200_000 }, async () => {
  const before = await cutBrowserAction('applying');
  assert.equal(before.killed, 'SIGKILL');
  assert.equal(before.landed, 'browser.applying driver.run');
  assert.equal(before.resumed.status, 'complete');
  assert.equal(before.pageRuns, 0, 'cut before it was applied: it never ran');
  const after = await cutBrowserAction('applied');
  assert.equal(after.landed, 'browser.applied driver.run');
  assert.equal(after.resumed.status, 'complete');
  assert.equal(after.pageRuns, 1, 'cut after it was applied and before its answer left: it ran once, and the resume did not repeat it');
  for (const cut of [before, after]) assert.deepEqual(cut.committedTurns, ['run', 'browser_read', 'read', 'submit'].map((name) => (name === 'run' ? 'run' : name)));
  assert.ok(classesOf([{ landed: { side: 'supervisor', point: after.landed } }]).includes('browser action'));
});

test('a page action that never ran is printed with the kill behind it', () => {
  const lines = render({ seed: 1, kills: [], processes: 1, browserCalls: [], runInterrupted: [2, 5], gates: [], covered: [], final: { status: 'complete', generation: 1, record: null }, ms: 0, checks: [],
    counted: { committedTurns: [], requests: {}, effects: {}, judge: {}, browser: {}, receipts: [] }, reference: {} }).join('\n');
  assert.match(lines, /page\.run +x0: errored run result committed \(kill 2, 5\)/);
});

test('the same seed gives the same kills, and another seed gives others', { timeout: 300_000 }, async () => {
  const where = (ledger) => ledger.kills.map((kill) => kill.landed && `${kill.landed.side} ${kill.landed.point}`);
  const [one, again, other] = [await killAnywhere({ seed: 31, kills: 6 }), await killAnywhere({ seed: 31, kills: 6 }), await killAnywhere({ seed: 40, kills: 6 })];
  assert.deepEqual(failed(one), []);
  assert.deepEqual(where(again), where(one));
  assert.deepEqual(failed(other), []);
  assert.notDeepEqual(where(other), where(one));
});

test('a cut inside the effect\'s window stops the next process on the unknown effect, and the tool is never dispatched again', { timeout: 120_000 }, async () => {
  for (const point of ['tool.dispatch search', 'tool.returned search']) {
    const cut = await cutInEffectWindow(point);
    assert.equal(cut.killed, 'SIGKILL', point);
    // The run ends refused with the driver's own code, and its result says what the driver said: reconcile the effect.
    assert.equal(cut.resumed.status, 'refused', point);
    assert.equal(cut.resumed.code, 'FROZEN_EFFECT_UNKNOWN', point);
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
