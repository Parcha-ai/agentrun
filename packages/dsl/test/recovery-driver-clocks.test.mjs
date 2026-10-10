// The driver's clocks and a failed map's finished items: a poll window and a wait are absolute and survive a resume,
// and what a map finished before one item failed is kept for the host and answered again at a later open.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runWorkflow } from '@parcha/agentrun-dsl';
import { openRecovery, withRecovery, memoryStore, recoveryBound, frozenEffectId } from '@parcha/agentrun-dsl/recovery';

const SCHEMAS = { Out: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } }, Status: { type: 'object', required: ['status'], properties: { status: { type: 'string' } } }, Any: { type: 'object' } };
const doc = (steps) => ({ v: 2, name: 'clocks', schemas: SCHEMAS, output: { schemaId: 'Out', path: 'final' }, root: { node: 'chain', steps: [...steps, { node: 'code', label: 'finish', code: '() => ({ final: { ok: true } })' }] } });
const held = async (store, workflow) => { const journal = await store.open(recoveryBound(workflow)); try { return { state: journal.state, effects: journal.effects() }; } finally { await journal.close(); } };
const fault = (code, message) => (error) => { assert.deepEqual([error.code, error.message], [code, message]); return true; };

const POLL = '/root/steps/0';
const polled = doc([{ node: 'call', label: 'status', via: 'tool', tool: 'jobs.status', args: {}, out: 'Status', as: 'job', deadline_s: 5,
  poll: { until: { predicate: 'in', path: 'status', values: ['COMPLETED'] }, interval_s: 0.1, deadline_s: 5 } }]);
const check = (ordinal) => frozenEffectId('step', POLL, ordinal);

test('each poll check is its own effect, and a run cut inside a wait resumes the same wait in the same poll window', async () => {
  const store = memoryStore(); let calls = 0, waits = 0;
  const deps = { runEffect: async () => ({ status: (calls += 1) < 3 ? 'PENDING' : 'COMPLETED' }) };
  let driver = await openRecovery(store, polled, { key: 'run-1' });
  const wrapped = withRecovery(driver, deps);
  wrapped.recovery = { ...wrapped.recovery, wait: (...args) => (waits += 1) === 2 ? Promise.reject(new Error('died in the wait')) : driver.recovery.wait(...args) };
  await assert.rejects(runWorkflow(polled, {}, wrapped), /died in the wait/);
  await driver.close();
  const first = await held(store, polled);
  assert.deepEqual(first.effects.map((effect) => [effect.id, effect.status, effect.result.value]), [[check(0), 'completed', { status: 'PENDING' }], [check(1), 'completed', { status: 'PENDING' }]]);
  assert.deepEqual(Object.keys(first.state.clocks), [`poll:step:${POLL}`, `attempt:${check(0)}`, `wait:step:${POLL}:1`, `attempt:${check(1)}`]);
  driver = await openRecovery(store, polled, { key: 'run-1' });
  const resumed = await runWorkflow(polled, {}, withRecovery(driver, deps));
  await driver.close();
  assert.deepEqual([resumed.status, resumed.state.job, calls], ['complete', { status: 'COMPLETED' }, 3]);
  const second = await held(store, polled);
  for (const clock of Object.keys(first.state.clocks)) assert.equal(second.state.clocks[clock], first.state.clocks[clock], clock);
  assert.deepEqual(second.effects.map((effect) => effect.id), [check(0), check(1), check(2)]);
});

test('a poll window that ran out while the run was down refuses the next check unsent, and still answers the checks it holds', async () => {
  const store = memoryStore(); let calls = 0;
  const deps = { runEffect: async () => { calls += 1; return { status: 'PENDING' }; } };
  let driver = await openRecovery(store, polled, { key: 'run-1' });
  const wrapped = withRecovery(driver, deps);
  wrapped.recovery = { ...wrapped.recovery, wait: () => Promise.reject(new Error('died in the wait')) };
  await assert.rejects(runWorkflow(polled, {}, wrapped), /died in the wait/);
  await driver.close();
  // The window belongs to the outside world: time the run spent down counts against it.
  const journal = await store.open(recoveryBound(polled));
  await journal.save({ ...journal.state, clocks: { ...journal.state.clocks, [`poll:step:${POLL}`]: Date.now() - 1 } });
  await journal.close();
  driver = await openRecovery(store, polled, { key: 'run-1' });
  await assert.rejects(runWorkflow(polled, {}, withRecovery(driver, deps)), fault('FROZEN_EFFECT_DEADLINE', 'Effect exceeded its own deadline'));
  await driver.close();
  assert.deepEqual([calls, (await held(store, polled)).effects.map((effect) => [effect.id, effect.status])], [1, [[check(0), 'completed']]]);
});

test('a map that ends on one item keeps what its finished items produced, and a later open answers them without a second dispatch', async () => {
  const mapped = doc([{ node: 'code', label: 'seed', code: "() => ({ items: ['a', 'b', 'c'] })" },
    { node: 'map', label: 'each', itemsPath: 'items', as: 'hits', maxConcurrency: 1, body: { node: 'call', label: 'per-item', via: 'tool', tool: 'paid', args: { item: '{item}' }, out: 'Any', as: 'hit', deadline_s: 5 } }]);
  const item = (index) => frozenEffectId('step', `/root/steps/1/items/${index}/body`, 0);
  const store = memoryStore(); const calls = [];
  const deps = { runEffect: async ({ input }) => { calls.push(input.item); if (input.item === 'b') throw new Error('b failed'); return { for: input.item }; } };
  let driver = await openRecovery(store, mapped, { key: 'run-1' });
  await assert.rejects(runWorkflow(mapped, {}, withRecovery(driver, deps)), /b failed/);
  // Read as a host stores it: an item that never finished is null once the state is JSON.
  assert.deepEqual(JSON.parse(JSON.stringify(driver.lastState())), { items: ['a', 'b', 'c'], hits: [{ for: 'a' }, null, null] });
  await driver.close();
  const journal = await held(store, mapped);
  assert.deepEqual(journal.state.pin.partial, { path: '/root/steps/1', as: 'hits', results: [{ for: 'a' }, null, null] });
  assert.deepEqual([journal.state.pin.done, journal.effects.map((effect) => [effect.id, effect.status])], [['/root/steps/0', '/root/steps/1/items/0/body'], [[item(0), 'completed'], [item(1), 'unknown']]]);
  driver = await openRecovery(store, mapped, { key: 'run-1' });
  assert.deepEqual(driver.lastState(), { items: ['a', 'b', 'c'], hits: [{ for: 'a' }, null, null] });
  await assert.rejects(runWorkflow(mapped, {}, withRecovery(driver, deps)), fault('FROZEN_EFFECT_UNKNOWN', `Reconcile ${item(1)} before resuming; it will not be repeated`));
  await driver.close();
  assert.deepEqual(calls, ['a', 'b']);
});
