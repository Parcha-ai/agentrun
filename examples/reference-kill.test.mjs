// The ten-kill ledger on the reference job: the job runs on the no-key host and is ended with SIGKILL at a seeded random
// point ten times, a fresh process resuming the directory each time. Every count is read from the store, the receipts and
// the run's own rows. The same seed draws the same first kill.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reconcileEffects } from '../packages/harness/dist/assemble.js';
import { classesOf, CLASSES, cutBrowserAction, cutInEffectWindow, isReduced, killAnywhere, planNext, progress, random, render } from './reference/kill-anywhere.ts';

const failed = (ledger) => ledger.checks.filter((check) => !check.ok).map((check) => ({ check: check.name, detail: check.detail }));

// The seeds are chosen for coverage, not for how the reference gates read them; every gate is asserted on each. Together the two cover every class of crossing
// the random draw reaches; the browser's page action is cut on purpose below.
//   21   model turn, judge, browser read, receipt filing, supervisor not applied, supervisor applied
//   337  effect window, a release answer lost, model turn, receipt filing, supervisor applied, delivery
const SEEDS = [21, 337];
const ALL = Object.keys(CLASSES).filter((name) => name !== 'browser action');

test('ten kills at seeded random points, each resumed by a fresh process: every committed turn and every effect once, the record the uninterrupted run\'s', { timeout: 300_000 }, async () => {
  const covered = new Set();
  for (const seed of SEEDS) {
    const ledger = await killAnywhere({ seed, kills: 10 });
    assert.deepEqual(failed(ledger), [], `seed ${seed}`);
    assert.equal(ledger.kills.filter((kill) => kill.landed).length, 10, `seed ${seed}`);
    assert.equal(ledger.final.status, 'complete');
    // The reference gates ran on the final directory and every one passes (each is also a check above).
    assert.ok(ledger.gates.length >= 7, 'the reference gates ran on the final directory');
    assert.deepEqual(ledger.gates.filter((gate) => !gate.ok), [], `seed ${seed}`);
    for (const name of ledger.covered) covered.add(name);
    const lines = render(ledger).join('\n');
    assert.match(lines, /page\.run +x[0-2]/);
    assert.match(lines, /applied at most once, counted from the provider/);
    assert.match(lines, /page\.read may repeat, each repeat tied to a kill inside it/);
    assert.match(lines, /Reference gates on the final directory/);
  }
  assert.deepEqual(ALL.filter((name) => !covered.has(name)), [], 'every class of crossing the draw reaches is covered by a seed');
});

test('the browser\'s page action is cut before and after it is applied: applied at most once, and the lead looks before it decides', { timeout: 200_000 }, async () => {
  const before = await cutBrowserAction('applying');
  assert.equal(before.killed, 'SIGKILL');
  assert.equal(before.landed, 'browser.applying driver.run');
  assert.equal(before.resumed.status, 'complete');
  assert.deepEqual(before.errored, ['run'], 'the lost answer is committed as an error');
  assert.equal(before.pageRuns, 0, 'cut before it was applied: it never ran, and the lead does not ask again blind');
  const after = await cutBrowserAction('applied');
  assert.equal(after.landed, 'browser.applied driver.run');
  assert.equal(after.resumed.status, 'complete');
  assert.deepEqual(after.errored, ['run']);
  assert.equal(after.pageRuns, 1, 'cut after it was applied and before its answer left: it ran once and was not applied again');
  for (const cut of [before, after]) assert.deepEqual(cut.committedTurns, ['run', 'snapshot', 'read', 'submit']);
  assert.ok(classesOf([{ landed: { side: 'supervisor', point: after.landed } }]).includes('browser action'));
});

test('a page action that errored is printed with the kill behind it and the ask that followed', () => {
  const lines = render({ seed: 1, kills: [], processes: 1, browserCalls: [], runInterrupted: [2, 5], gates: [], covered: [], final: { status: 'complete', generation: 1, record: null }, ms: 0, checks: [],
    counted: { committedTurns: [], toolResults: [{ tool: 'run', error: true }], requests: {}, effects: {}, judge: {}, browser: { 'page.run': 2 }, receipts: [] }, reference: {} }).join('\n');
  assert.match(lines, /page\.run +x2; 1 errored run result committed \(kill 2, 5\)/);
});

test('the same seed draws the same first kill, and another seed draws another; every ledger check and gate passes on both runs', { timeout: 300_000 }, async () => {
  // Only the first kill's plan is compared: it lands before any process can diverge. Later landings depend on the order concurrent work takes inside a process, which varies under load.
  const [one, again, other] = [await killAnywhere({ seed: 300, kills: 6 }), await killAnywhere({ seed: 300, kills: 6 }), await killAnywhere({ seed: 65, kills: 6 })];
  for (const [name, ledger] of [['seed 300', one], ['seed 300 again', again], ['seed 65', other]]) {
    assert.deepEqual(failed(ledger), [], name);
    assert.deepEqual(ledger.gates.filter((gate) => !gate.ok), [], name);
  }
  assert.deepEqual(again.kills[0].plan, one.kills[0].plan);
  assert.notDeepEqual(other.kills[0].plan, one.kills[0].plan);
});

test('a cut before the host kept the effect\'s answer stops the next process on the unknown effect, and the tool is never dispatched again', { timeout: 120_000 }, async () => {
  for (const point of ['tool.dispatch search', 'tool.returned search']) {
    const cut = await cutInEffectWindow(point);
    assert.equal(cut.killed, 'SIGKILL', point);
    // The run ends refused with the driver's own code, and its result says what the driver said: reconcile the effect.
    assert.equal(cut.resumed.status, 'refused', point);
    assert.equal(cut.resumed.code, 'FROZEN_EFFECT_UNKNOWN', point);
    assert.match(cut.resumed.message, /^Reconcile step:\/root\/steps\/0#call:0 before resuming; it will not be repeated$/, point);
    // The host's ledger row is written before the call, so what the tool actually ran is counted by the tap: nothing when the
    // cut came before the call, once when it came after the call returned, and the resume never calls it again.
    assert.deepEqual(cut.made, point === 'tool.dispatch search' ? { killed: 0, total: 0 } : { killed: 1, total: 1 }, point);
  }
});

test('a cut after the host kept the effect\'s answer and before the driver committed it is reconciled: the resume answers from the record, the tool is made once', { timeout: 120_000 }, async () => {
  const cut = await cutInEffectWindow('effect.kept search');
  assert.equal(cut.killed, 'SIGKILL');
  assert.equal(cut.resumed.status, 'complete');
  assert.deepEqual(cut.made, { killed: 1, total: 1 });
});

test('a call admitted and never sent (the kill lands between admission and the send) is sent again by the resume with the args the journal kept: exactly one send in all', { timeout: 120_000 }, async () => {
  // Without a host `rerun` the resume refuses the unknown effect (the test above). With one, reconcile hands it the args the call was admitted with, and the call is sent once, by the resumed process.
  const cut = await cutInEffectWindow('tool.dispatch search', { rerun: true });
  assert.equal(cut.killed, 'SIGKILL');
  assert.equal(cut.resumed.status, 'complete');
  assert.deepEqual(cut.made, { killed: 0, total: 1 }, 'never sent by the killed process, sent once by the resumed one');
  assert.deepEqual(cut.effects, { search: 1 }, 'one search in the host\'s ledger: nothing was repeated');
});

test('reconcile gives rerun the args the journal kept for the effect, and none when the record has none', async () => {
  const asked = [];
  const completed = [];
  const rerun = async (effect) => { asked.push(effect); return effect.args === undefined ? undefined : { args: effect.args, value: { sent: effect.args } }; };
  await reconcileEffects([
    { id: 'a', argsHash: 'h1', intent: { tool: 'search' }, args: { query: 'Acme Ltd' } },
    { id: 'b', argsHash: 'h2', intent: { tool: 'search' } },
  ], async (id, value) => { completed.push([id, value]); }, { rerun });
  assert.deepEqual(asked.map((effect) => [effect.id, effect.args]), [['a', { query: 'Acme Ltd' }], ['b', undefined]]);
  assert.deepEqual(completed, [['a', { sent: { query: 'Acme Ltd' } }]], 'the one with args was sent and completed; the one without stays unknown');
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

test('a kill count or seed that is not a whole number is refused before any process starts', async () => {
  for (const kills of [Number.NaN, Number.POSITIVE_INFINITY, -1, 2.5]) await assert.rejects(killAnywhere({ seed: 1, kills }), /--kills must be a whole number/);
  await assert.rejects(killAnywhere({ seed: Number.NaN, kills: 1 }), /--seed must be a whole number/);
});

test('the reduced record is the uninterrupted one with the scan alone cited: a different company, answer or citation is not accepted', () => {
  const full = { record: { company: 'Acme Ltd', answer: 'Acme Ltd was incorporated on 2019-03-04.', citations: ['evidence/investigate/browser_read-aa.json', 'evidence/investigate/look-bb.json'] } };
  const reduced = (change = {}) => ({ record: { company: 'Acme Ltd', answer: 'Whether the registry page was opened is not known, so the filing scan is cited alone.', citations: ['evidence/investigate/look-bb.json'], ...change } });
  assert.equal(isReduced(reduced(), full), true);
  assert.equal(isReduced(reduced({ answer: 'The registry page could not be opened, so the filing scan is cited alone.' }), full), true);
  for (const change of [{ company: 'Other Ltd' }, { answer: 'Acme Ltd was incorporated on 2019-03-04.' }, { citations: ['evidence/investigate/look-zz.json'] }, { citations: [] }, { extra: 1 }]) assert.equal(isReduced(reduced(change), full), false, JSON.stringify(change));
  assert.equal(isReduced(null, full), false);
  assert.equal(isReduced(full, full), false, 'the full record is not the reduced one');
});
