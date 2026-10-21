// A host settles an unknown shell effect with `reconcile`, and the driver hashes the files the effect declares. A call's
// `produces` may interpolate the state (`out/{tag}.txt`), and its dispatch named the files from the state the call started
// from. Reconcile names them from that same state: the kept state whose digest the frame bound when the call started, or
// a value the host bound by the same digest. Never the current state, never a guess: when no kept value has that digest,
// the settlement is refused and the refusal names the template.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { EffectOutcomeUnknownError, runWorkflow } from '@parcha/agentrun-dsl';
import { openJournal, openRecovery, withRecovery, workspaceFiles } from '@parcha/agentrun-dsl/recovery';

const schemas = { Any: { type: 'object' }, In: { type: 'object', properties: { name: { type: 'string' } } } };
const flow = (name, steps, extra = {}) => ({ v: 2, name, schemas, output: { schemaId: 'Any' }, root: { node: 'chain', steps }, ...extra });
const code = (label, body) => ({ node: 'code', label, code: `s => (${body})` });
const shell = (label, produces) => ({ node: 'call', label, via: 'shell', command: 'true', as: label, deadline_s: 5, produces });

function memory(record) {
  let owned = false;
  const backend = {
    acquire: async () => { if (owned) throw new Error('Run already has a live owner'); owned = true; return async () => { owned = false; }; },
    read: async () => record && structuredClone(record),
    write: async (next) => { record = structuredClone(next); },
  };
  return { store: { open: (bound) => openJournal(backend, bound) }, record: () => record };
}
const workspace = (t) => { const dir = mkdtempSync(join(tmpdir(), 'reconcile-produces-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const write = (dir, file) => { mkdirSync(join(dir, file, '..'), { recursive: true }); writeFileSync(join(dir, file), 'done'); };

// A first process: every shell call's outcome is unknown, so the run stops there and the journal keeps the effect unknown.
async function unknownRun(kept, workflow, input, cwd, options = {}) {
  const driver = await openRecovery(kept.store, workflow, { key: 'reconcile', files: workspaceFiles(cwd), ...options });
  const deps = withRecovery(driver, { runEffect: async (params) => { throw new EffectOutcomeUnknownError(params.node.label, params.idempotencyKey); } });
  await runWorkflow(workflow, input, deps).catch(() => {});
  await driver.close();
}
// A second process settles every unknown effect; what each settlement did, and the files the journal recorded.
async function settle(kept, workflow, cwd, options = {}) {
  const outcome = { settled: [], refused: null };
  try {
    const driver = await openRecovery(kept.store, workflow, { key: 'reconcile', files: workspaceFiles(cwd), ...options, reconcile: async (unknown, complete) => {
      for (const effect of unknown) { await complete(effect.id, { ok: true }); outcome.settled.push(effect.id); }
    } });
    await driver.close();
  } catch (error) { outcome.refused = `${error.code}: ${error.message}`; }
  outcome.files = (kept.record().effects ?? []).filter((effect) => effect.status === 'completed').map((effect) => Object.keys(effect.result?.files ?? {})).flat();
  return outcome;
}

test('a call after the first step whose produces interpolate the state: reconcile hashes the file the dispatch named', async (t) => {
  const cwd = workspace(t), kept = memory();
  const workflow = flow('chain-step', [code('seed', '{ tag: "t1" }'), shell('render', ['out/{tag}.txt'])]);
  await unknownRun(kept, workflow, {}, cwd);
  write(cwd, 'out/t1.txt');
  const outcome = await settle(kept, workflow, cwd);
  assert.equal(outcome.refused, null);
  assert.deepEqual(outcome.files, ['out/t1.txt']);
});

test('state written elsewhere after the call started does not move what the call named: the admitted state is read, not the latest', async (t) => {
  const cwd = workspace(t), kept = memory();
  // A parallel: one branch is the call, the other rewrites the key the call's template reads and finishes first.
  const workflow = flow('changed-after', [code('seed', '{ tag: "t1" }'), { node: 'parallel', label: 'both', branches: [shell('render', ['out/{tag}.txt']), code('retag', '{ tag: "t2" }')] }]);
  await unknownRun(kept, workflow, {}, cwd);
  const kept_ = JSON.stringify(kept.record().state.pin.states);
  assert.match(kept_, /"tag":"t2"/, 'the frame keeps a later state with the key rewritten');
  write(cwd, 'out/t1.txt');
  const outcome = await settle(kept, workflow, cwd);
  assert.equal(outcome.refused, null);
  assert.deepEqual(outcome.files, ['out/t1.txt'], 'the file the call named from the state it started from');
});

test('a call that is the run\'s first step: with the run\'s input bound it settles; without it the refusal names the template', async (t) => {
  const workflow = flow('first-step', [shell('render', ['out/{name}.txt'])], { input: { schemaId: 'In' } });
  {
    const cwd = workspace(t), kept = memory();
    await unknownRun(kept, workflow, { name: 'one' }, cwd, { bind: { input: { name: 'one' } } });
    write(cwd, 'out/one.txt');
    const outcome = await settle(kept, workflow, cwd, { bind: { input: { name: 'one' } } });
    assert.equal(outcome.refused, null);
    assert.deepEqual(outcome.files, ['out/one.txt']);
  }
  {
    const cwd = workspace(t), kept = memory();
    await unknownRun(kept, workflow, { name: 'one' }, cwd);
    write(cwd, 'out/one.txt');
    const outcome = await settle(kept, workflow, cwd);
    assert.match(outcome.refused ?? '', /^RECOVERY_RECONCILE_FAILED: .*out\/\{name\}\.txt/);
    assert.deepEqual(outcome.files, []);
  }
});

test('produces with nothing to interpolate are hashed as written, as before', async (t) => {
  const cwd = workspace(t), kept = memory();
  const workflow = flow('plain', [shell('render', ['out/site.html'])]);
  await unknownRun(kept, workflow, {}, cwd);
  write(cwd, 'out/site.html');
  assert.deepEqual((await settle(kept, workflow, cwd)).files, ['out/site.html']);
});

test('a journal the build before this change wrote, with such an effect stuck unknown, settles on the next open', async (t) => {
  const { workflow, key, record } = JSON.parse(readFileSync(new URL('./fixtures/reconcile-template-journal.json', import.meta.url), 'utf8'));
  assert.equal(key, 'reconcile');
  const cwd = workspace(t), kept = memory(record);
  write(cwd, 'out/t1.txt');
  const outcome = await settle(kept, workflow, cwd);
  assert.equal(outcome.refused, null);
  assert.deepEqual(outcome.files, ['out/t1.txt']);
});
