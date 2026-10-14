// The reconcile seam: a host settles the effects a killed process left unknown through the driver's own open of the run,
// so the run's generation counts processes, and nothing it leaves unknown is ever dispatched.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runWorkflow } from '@parcha/agentrun-dsl';
import { openRecovery, withRecovery, memoryStore, RecoveryError, frozenEffectId, gatewayIntentOf } from '@parcha/agentrun-dsl/recovery';

const KEY = 'run-1';
const SCHEMAS = { Out: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } }, Any: { type: 'object' } };
const lookup = { node: 'call', label: 'lookup', via: 'tool', tool: 'registry_lookup', args: { id: 7 }, out: 'Any', as: 'lookup', deadline_s: 5 };
const finish = { node: 'code', label: 'finish', code: '() => ({ final: { ok: true } })' };
const workflow = { v: 2, name: 'reconcile', schemas: SCHEMAS, output: { schemaId: 'Out', path: 'final' }, root: { node: 'chain', steps: [lookup, finish] } };
const effectId = frozenEffectId('step', '/root/steps/0', 0);

/** One process of the run: open (with the host's options), run under the driver, let go. Resolves to the result and the
 *  generation the process held. */
async function process_(store, deps, options = {}) {
  const driver = await openRecovery(store, workflow, { key: KEY, ...options });
  try { return { result: await runWorkflow(workflow, {}, withRecovery(driver, deps)), generation: driver.generation }; }
  finally { await driver.close(); }
}
const dies = (counter) => ({ runEffect: async () => { counter.calls += 1; throw new Error('the process died'); } });
const fault = (code) => (error) => { assert.ok(error instanceof RecoveryError, String(error)); assert.equal(error.code, code, error.message); return true; };

test('a killed run settled through reconcile has one generation per process, and the settled effect is not dispatched again', async () => {
  const store = memoryStore(); const counter = { calls: 0 };
  await assert.rejects(process_(store, dies(counter)), /the process died/);
  const seen = [];
  const { result, generation } = await process_(store, dies(counter), {
    reconcile: async (unknown, complete) => {
      seen.push(unknown.map(({ id, status, intent }) => [id, status, intent]));
      for (const effect of unknown) await complete(effect.id, { found: 'kept' }, { intent: { tool: effect.intent.tool, args: { id: 7 } } });
    },
  });
  assert.deepEqual([result.status, result.state.lookup, counter.calls, generation], ['complete', { found: 'kept' }, 1, 2]);
  assert.deepEqual(seen, [[[effectId, 'unknown', gatewayIntentOf('registry_lookup', { id: 7 })]]]);
});

test('reconcile is not asked when nothing is unknown', async () => {
  let asked = 0;
  const { result } = await process_(memoryStore(), { runEffect: async () => ({ found: true }) }, { reconcile: async () => { asked += 1; } });
  assert.deepEqual([result.status, asked], ['complete', 0]);
});

test('an effect reconcile leaves unknown is refused at resume, and is not dispatched', async () => {
  const store = memoryStore(); const counter = { calls: 0 };
  await assert.rejects(process_(store, dies(counter)), /the process died/);
  let asked = 0;
  await assert.rejects(process_(store, dies(counter), { reconcile: async () => { asked += 1; } }), fault('FROZEN_EFFECT_UNKNOWN'));
  assert.deepEqual([asked, counter.calls], [1, 1]);
});

test('a reconcile that throws fails the open with its code and cause, and dispatches nothing', async () => {
  const store = memoryStore(); const counter = { calls: 0 }; const cause = new Error('the door is down');
  await assert.rejects(process_(store, dies(counter)), /the process died/);
  await assert.rejects(process_(store, dies(counter), { reconcile: async () => { throw cause; } }), (error) => {
    fault('RECOVERY_RECONCILE_FAILED')(error);
    assert.equal(error.cause, cause);
    return true;
  });
  assert.equal(counter.calls, 1);
  // The journal was let go: a later process opens it, and the effect is still unknown.
  await assert.rejects(process_(store, dies(counter)), fault('FROZEN_EFFECT_UNKNOWN'));
});

test('complete refuses an id that is not an unknown effect of the run, and a call after reconcile returned', async () => {
  const store = memoryStore(); const counter = { calls: 0 };
  await assert.rejects(process_(store, dies(counter)), /the process died/);
  let late;
  await assert.rejects(process_(store, dies(counter), { reconcile: async (_unknown, complete) => {
    late = complete;
    await assert.rejects(complete('step:/root/steps/9:0', {}), fault('RECOVERY_RECONCILE_FAILED'));
  } }), fault('FROZEN_EFFECT_UNKNOWN'));
  await assert.rejects(late(effectId, {}), fault('RECOVERY_RECONCILE_FAILED'));
});
