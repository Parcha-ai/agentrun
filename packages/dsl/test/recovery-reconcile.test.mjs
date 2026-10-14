// The reconcile seam: a host settles the effects a killed process left unknown through the driver's own open of the run,
// so the run's generation counts processes, and nothing it leaves unknown is ever dispatched.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runWorkflow } from '@parcha/agentrun-dsl';
import { openRecovery, withRecovery, memoryStore, recoveryBound, workspaceFiles, RecoveryError, frozenEffectId, frozenEffectPath, gatewayIntentOf } from '@parcha/agentrun-dsl/recovery';

const KEY = 'run-1';
const SHELL = { code: 0, stdout: 'rendered', stderr: '' };
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

test('settling an effect that declares output files records their hashes: a missing output refuses the settlement, a changed one is refused at the next resume', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'agentrun-reconcile-files-'));
  try {
    const render = { node: 'call', label: 'render', via: 'shell', command: 'render', produces: ['out.txt'], as: 'render', deadline_s: 5 };
    const flow = { ...workflow, root: { node: 'chain', steps: [render, finish] } };
    const id = frozenEffectId('step', '/root/steps/0', 0);
    const files = workspaceFiles(cwd); const store = memoryStore(); let calls = 0;
    const open = (options = {}) => openRecovery(store, flow, { key: KEY, files, ...options });
    const killed = { runEffect: async () => { calls += 1; throw new Error('the process died'); } };
    const go = async (options) => { const driver = await open(options); try { return await runWorkflow(flow, {}, withRecovery(driver, killed)); } finally { await driver.close(); } };
    await assert.rejects(go(), /the process died/);
    // The render died before writing its output: there is nothing to settle with.
    await assert.rejects(go({ reconcile: async (unknown, complete) => { await complete(unknown[0].id, SHELL); } }), fault('RECOVERY_RECONCILE_FAILED'));
    writeFileSync(join(cwd, 'out.txt'), 'bytes');
    const settle = { reconcile: async (unknown, complete) => { await complete(id, SHELL); assert.equal(unknown.length, 1); } };
    const done = await go(settle);
    assert.deepEqual([done.status, done.state.render, calls], ['complete', SHELL, 1]);
    // The output changes after it was settled: a later process refuses to build on it.
    writeFileSync(join(cwd, 'out.txt'), 'changed');
    await assert.rejects(go(), fault('FROZEN_ARTIFACT_INVALID'));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('an effect id round-trips to the path and ordinal it was made from', () => {
  for (const [frame, path, ordinal] of [['step', '/root/steps/0', 0], ['step', '/root/steps/1/items/3/body/steps/2', 4], ['step', '/root/steps/0:odd#path', 1]]) {
    assert.deepEqual(frozenEffectPath(frozenEffectId(frame, path, ordinal)), { path, ordinal });
  }
  assert.equal(frozenEffectPath('not an effect id'), undefined);
});

/** A store whose journal fails the admission after it landed: the process died between admitting a call and sending it. */
const diesAfterAdmission = (store) => ({ open: async (bound) => {
  const journal = await store.open(bound);
  const held = Object.create(journal);
  held.admit = async (...args) => { await journal.admit(...args); throw new Error('killed after admission'); };
  return held;
} });

test('a call admitted but never sent is settled by reconcile re-sending it with the arguments kept at admission, applied once', async () => {
  const store = memoryStore(); const door = []; let calls = 0;
  const deps = { runEffect: async () => { calls += 1; return { found: 'adapter' }; } };
  await assert.rejects(process_(diesAfterAdmission(store), deps), /killed after admission/);
  assert.deepEqual([door.length, calls], [0, 0], 'the door never saw the call');
  const { result } = await process_(store, deps, { reconcile: async (unknown, complete) => {
    assert.deepEqual(unknown.map((effect) => effect.args), [{ id: 7 }]);
    for (const effect of unknown) { door.push(effect.args); await complete(effect.id, { found: 'door' }); }
  } });
  assert.deepEqual([result.status, result.state.lookup, door, calls], ['complete', { found: 'door' }, [{ id: 7 }], 0]);
});

test('a record written before arguments were kept reads as it did: no args, and an unsettled call is still refused', async () => {
  const store = memoryStore(); const counter = { calls: 0 };
  await assert.rejects(process_(store, dies(counter)), /the process died/);
  const old = { open: async (bound) => {
    const journal = await store.open(bound); const held = Object.create(journal);
    held.effects = () => journal.effects().map(({ args, ...rest }) => rest);
    return held;
  } };
  let seen;
  await assert.rejects(process_(old, dies(counter), { reconcile: async (unknown) => { seen = unknown; } }), fault('FROZEN_EFFECT_UNKNOWN'));
  assert.deepEqual([seen.length, 'args' in seen[0], counter.calls], [1, false, 1]);
});

/** The writes a journal receives, in order: `called` and `complete` as the driver makes them, with what they carry. */
const recording = (store, writes) => ({ open: async (bound) => {
  const journal = await store.open(bound);
  const held = Object.create(journal);
  for (const write of ['called', 'complete']) held[write] = async (...args) => { writes.push([write, args[0], args[1]]); return journal[write](...args); };
  return held;
} });

test('a call the host made settling an effect is kept on it before it completes, as a dispatch keeps its own; a settle that made no call adds none', async () => {
  const store = memoryStore(); const counter = { calls: 0 }; const writes = [];
  await assert.rejects(process_(store, dies(counter)), /the process died/);
  const sent = [{ outcome: 'applied', tool: 'registry_lookup' }];
  const { result } = await process_(recording(store, writes), dies(counter), { reconcile: async (unknown, complete) => {
    for (const effect of unknown) await complete(effect.id, { found: 'door' }, { calls: sent });
  } });
  assert.deepEqual([result.status, counter.calls], ['complete', 1]);
  assert.deepEqual(writes.map(([write, id, value]) => [write, id, write === 'called' ? value : 'result']), [['called', effectId, sent], ['complete', effectId, 'result']]);
  // The same settlement from an answer the host had kept: no outside call was made, so none is recorded.
  const second = memoryStore(); const kept = []; const other = { calls: 0 };
  await assert.rejects(process_(second, dies(other)), /the process died/);
  await process_(recording(second, kept), dies(other), { reconcile: async (unknown, complete) => { for (const effect of unknown) await complete(effect.id, { found: 'kept' }); } });
  assert.deepEqual(kept.map(([write]) => write), ['complete']);
  await process_(second, dies(other), { reconcile: async () => { throw new Error('nothing is unknown any more'); } }).catch(() => undefined);
});

test('a re-send adds to the calls an earlier process kept: a call that applied before the kill stays on the effect', async () => {
  const store = memoryStore();
  // Process 1: the outside call ended applied and was kept, and the process died before the effect completed.
  const cut = { runEffect: async ({ call }) => { call({ outcome: 'applied', process: 1 }); throw new Error('the process died'); } };
  await assert.rejects(process_(store, cut), /the process died/);
  const held = await store.open(recoveryBound(workflow));
  assert.deepEqual([held.effect(effectId).status, held.effect(effectId).calls], ['unknown', [{ outcome: 'applied', process: 1 }]]);
  await held.close();
  // Process 2: the host has no kept answer, so it sends the call again and reports it.
  await process_(store, cut, { reconcile: async (unknown, complete) => {
    for (const effect of unknown) await complete(effect.id, { found: 'door' }, { calls: [{ outcome: 'applied', process: 2 }] });
  } });
  const after = await store.open(recoveryBound(workflow));
  assert.deepEqual(after.effect(effectId).calls, [{ outcome: 'applied', process: 1 }, { outcome: 'applied', process: 2 }]);
  await after.close();
});
