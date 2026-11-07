// A host whose journal store syncs between commits (a run store at synchronous NORMAL) makes each effect's admission
// durable before it is dispatched: the driver calls the host's `afterAdmit` right after the admission's commit and before
// the effect runs, and an `afterAdmit` that fails dispatches nothing (the effect stays admitted and unknown, never sent).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runWorkflow } from '@parcha/agentrun-dsl';
import { memoryStore, openRecovery, withRecovery } from '@parcha/agentrun-dsl/recovery';

const SCHEMAS = { Out: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } }, Any: { type: 'object' } };
const workflow = { v: 2, name: 'admit-barrier', schemas: SCHEMAS, output: { schemaId: 'Out', path: 'final' }, root: { node: 'chain', steps: [
  { node: 'call', label: 'charge', via: 'tool', tool: 'pay.charge', args: {}, out: 'Any', as: 'paid', deadline_s: 5 },
  { node: 'code', label: 'finish', code: '() => ({ final: { ok: true } })' },
] } };

/** A memory store whose journal records each admission in `log` once its commit resolved. */
function logged(log) {
  const inner = memoryStore();
  return new Proxy(inner, { get: (target, key) => key !== 'open' ? Reflect.get(target, key, target) : async (...args) => {
    const journal = await target.open(...args);
    return new Proxy(journal, { get: (on, name) => {
      const value = Reflect.get(on, name, on);
      if (name === 'admit') return async (...admitted) => { const result = await value.apply(on, admitted); log.push('admit'); return result; };
      return typeof value === 'function' ? value.bind(on) : value;
    } });
  } });
}

test("an effect is dispatched only after its admission is committed and the host's afterAdmit resolved", async () => {
  const log = [];
  const driver = await openRecovery(logged(log), workflow, { key: 'run-1', afterAdmit: async () => void log.push('sync') });
  try {
    const result = await runWorkflow(workflow, {}, withRecovery(driver, { runEffect: async () => (log.push('sent'), { ok: true }) }));
    assert.equal(result.status, 'complete');
  } finally { await driver.close(); }
  assert.deepEqual(log, ['admit', 'sync', 'sent']);
});

test("an afterAdmit that fails dispatches nothing: the effect is admitted, never sent", async () => {
  const log = [];
  const driver = await openRecovery(logged(log), workflow, { key: 'run-1', afterAdmit: async () => { throw new Error('the disk went away'); } });
  try {
    await assert.rejects(runWorkflow(workflow, {}, withRecovery(driver, { runEffect: async () => (log.push('sent'), { ok: true }) })), /the disk went away/);
  } finally { await driver.close().catch(() => undefined); }
  assert.deepEqual(log, ['admit'], 'admitted, never sent');
});
