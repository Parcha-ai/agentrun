// Three guards of the recovery driver: nothing is dispatched once a stop or a deadline has passed during the
// admission, a map that finished keeps no partial results, and a reserved file is reserved under every name.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { runWorkflow } from '@parcha/agentrun-dsl';
import { openRecovery, withRecovery, memoryStore, recoveryBound, workspaceFiles, frozenEffectId, nodeAt } from '@parcha/agentrun-dsl/recovery';

const scratch = mkdtempSync(join(tmpdir(), 'agentrun-recovery-guards-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const SCHEMAS = { Out: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } }, Any: { type: 'object' } };
const doc = (steps) => ({ v: 2, name: 'guards', schemas: SCHEMAS, output: { schemaId: 'Out', path: 'final' }, root: { node: 'chain', steps: [...steps, { node: 'code', label: 'finish', code: '() => ({ final: { ok: true } })' }] } });
const tool = (label, args = {}, extra = {}) => ({ node: 'call', label, via: 'tool', tool: 'paid', args, out: 'Any', as: label, deadline_s: 5, ...extra });
const fault = (code, message) => (error) => { assert.deepEqual([error.code, error.message], [code, message]); return true; };
const held = async (store, workflow) => { const journal = await store.open(recoveryBound(workflow)); try { return { state: journal.state, effects: journal.effects() }; } finally { await journal.close(); } };
/** A store whose admissions land, then run `then`: what happened while the admission was being committed. */
const admitting = (inner, then) => ({ open: async (bound) => {
  const journal = await inner.open(bound); const watched = Object.create(journal);
  watched.admit = async (...args) => { const admitted = await journal.admit(...args); await then(); return admitted; };
  return watched;
} });

test('a stop, a cancelled caller or a deadline that lands during the admission leaves the effect unknown and the adapter uncalled', async () => {
  const id = frozenEffectId('step', '/root/steps/0', 0);
  const cases = [
    ['a pause', doc([tool('lookup')]), (driver) => driver.stop({ action: 'pause', source: 'operator' }), fault('FROZEN_PAUSED', 'Frozen run paused')],
    ['a cancel', doc([tool('lookup')]), (driver) => driver.stop({ action: 'cancel' }), fault('FROZEN_CANCELLED', 'Frozen run cancelled')],
  ];
  for (const [name, workflow, during, refusal] of cases) {
    const inner = memoryStore(); let dispatched = 0, driver;
    driver = await openRecovery(admitting(inner, () => during(driver)), workflow, { key: 'run-1' });
    await assert.rejects(runWorkflow(workflow, {}, withRecovery(driver, { runEffect: async () => { dispatched += 1; return {}; } })), refusal, name);
    await driver.close();
    assert.deepEqual([dispatched, (await held(inner, workflow)).effects.map((effect) => [effect.id, effect.status])], [0, [[id, 'unknown']]], name);
  }
  // Asked of the driver directly, as the interpreter asks it: the caller's own signal (a sibling that failed while this
  // effect was being admitted), then the effect's own deadline.
  const direct = async (workflow, during, signal, refusal) => {
    const inner = memoryStore(); let dispatched = 0;
    const driver = await openRecovery(admitting(inner, during), workflow, { key: 'run-1' });
    const params = { node: nodeAt(workflow, '/root/steps/0'), input: {}, produces: [], attempt: 1, idempotencyKey: 'key', signal, executionPath: '/root/steps/0' };
    await assert.rejects(driver.wrapEffect(async () => { dispatched += 1; })(params), refusal);
    await driver.close();
    assert.deepEqual([dispatched, (await held(inner, workflow)).effects.map((effect) => [effect.id, effect.status])], [0, [[id, 'unknown']]]);
  };
  const caller = new AbortController();
  await direct(doc([tool('lookup')]), () => caller.abort(new Error('a sibling failed')), caller.signal, /a sibling failed/);
  await direct(doc([tool('lookup', {}, { deadline_s: 0.05 })]), () => new Promise((resolve) => setTimeout(resolve, 80)), new AbortController().signal, fault('FROZEN_EFFECT_DEADLINE', 'Effect exceeded its own deadline'));
});

test('a map that finishes after one of its items was reconciled keeps no partial results', async () => {
  const mapped = doc([{ node: 'code', label: 'seed', code: "() => ({ items: ['a', 'b', 'c'] })" },
    { node: 'map', label: 'each', itemsPath: 'items', as: 'hits', maxConcurrency: 1, body: tool('per-item', { item: '{item}' }) }]);
  const store = memoryStore(); let failing = true;
  const deps = { runEffect: async ({ input }) => { if (failing && input.item === 'b') throw new Error('b failed'); return { for: input.item }; } };
  let driver = await openRecovery(store, mapped, { key: 'run-1' });
  await assert.rejects(runWorkflow(mapped, {}, withRecovery(driver, deps)), /b failed/);
  await driver.close();
  assert.deepEqual((await held(store, mapped)).state.pin.partial.results, [{ for: 'a' }, null, null]);
  // An operator settles the unknown item; the next open finishes the map.
  const journal = await store.open(recoveryBound(mapped));
  await journal.complete(frozenEffectId('step', '/root/steps/1/items/1/body', 0), { value: { for: 'b' }, files: {} });
  await journal.close();
  failing = false;
  driver = await openRecovery(store, mapped, { key: 'run-1' });
  const result = await runWorkflow(mapped, {}, withRecovery(driver, deps));
  assert.deepEqual([result.status, result.state.hits, driver.lastState().hits], ['complete', [{ for: 'a' }, { for: 'b' }, { for: 'c' }], [{ for: 'a' }, { for: 'b' }, { for: 'c' }]]);
  await driver.close();
  assert.equal((await held(store, mapped)).state.pin.partial, undefined);
});

test('a reserved file is reserved under every name that reaches it, and a name that does not exist yet is compared as written', async () => {
  const cwd = mkdtempSync(join(scratch, 'files-')); const files = workspaceFiles(cwd);
  writeFileSync(join(cwd, 'report.md'), 'the host wrote this');
  symlinkSync('report.md', join(cwd, 'alias.md'));
  mkdirSync(join(cwd, 'real'));
  symlinkSync('real', join(cwd, 'linked'));
  assert.deepEqual([files.same('alias.md', 'report.md'), files.same('linked/draft.md', 'real/draft.md'), files.same('./notes.md', 'notes.md'), files.same('notes.md', 'report.md'), files.same('real/draft.md', 'draft.md')], [true, true, true, false, false]);
  const shell = (produces) => doc([{ node: 'call', label: 'render', via: 'shell', command: 'render', produces, deadline_s: 5, as: 'render' }]);
  const driver = await openRecovery(memoryStore(), shell(['alias.md']), { key: 'run-1', reservedOutputs: ['report.md', 'structured_output.json'], files });
  await driver.close();
  assert.deepEqual(driver.preStepRefusal, { code: 'RUN_CONTROL_UNSUPPORTED', kind: 'host_owned_output', label: 'workflow',
    message: 'Recovered artifacts must not overwrite report.md or structured_output.json; the host owns those files, and the pin writes alias.md' });
});
