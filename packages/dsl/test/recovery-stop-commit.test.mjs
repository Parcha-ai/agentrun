// A pause or a cancel is committed before anything else stops: a cancelled run never resumes, and a paused one resumes
// without reconciling. When the store refuses that commit, the host must hear it: the stop is not durable, the journal
// still reads running, and the next open would resume a run the host saw stopped. `flush()` and `close()` throw the
// refused commit (close after it has released the journal); a commit that lands changes nothing.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runWorkflow } from '@parcha/agentrun-dsl';
import { openJournal, openRecovery, withRecovery } from '@parcha/agentrun-dsl/recovery';

const workflow = { v: 2, name: 'stop-commit', schemas: { Any: { type: 'object' } }, output: { schemaId: 'Any' },
  root: { node: 'chain', steps: [{ node: 'call', label: 'slow', via: 'tool', tool: 'slow', args: {}, out: 'Any', as: 'slow', deadline_s: 30 }, { node: 'code', label: 'after', code: 's => ({ done: true })' }] } };

// A journal backend over one record; `refuse(next)` says which writes the disk refuses.
function disk(refuse = () => false) {
  let record; let owned = false;
  const backend = {
    acquire: async () => { if (owned) throw new Error('Run already has a live owner'); owned = true; return async () => { owned = false; }; },
    read: async () => record && structuredClone(record),
    write: async (next) => { if (refuse(next)) throw new Error('disk full'); record = structuredClone(next); },
  };
  return { store: { open: (bound) => openJournal(backend, bound) }, record: () => record };
}

// A run whose one effect is in flight when the host stops it.
async function stopped(kept, action) {
  const driver = await openRecovery(kept.store, workflow, { key: 'stop-commit' });
  let started; const begun = new Promise((resolve) => { started = resolve; });
  const runEffect = async ({ signal }) => {
    started();
    await new Promise((resolve, reject) => { const timer = setTimeout(resolve, 300); signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }); });
    return { ok: true };
  };
  const running = runWorkflow(workflow, {}, withRecovery(driver, { runEffect })).then((result) => result.status, (error) => error.code);
  await begun;
  driver.stop({ action, source: 'operator' });
  return { driver, run: await running };
}
const settled = (promise) => promise.then(() => 'resolved', (error) => `rejected: ${error.message}`);

test('a cancel whose commit the store refuses: the run reports the cancel, and flush and close throw the refused commit', async () => {
  let full = true;
  const kept = disk((next) => full && next?.state?.status === 'cancelled');
  const { driver, run } = await stopped(kept, 'cancel');
  assert.equal(run, 'FROZEN_CANCELLED');
  assert.match(await settled(driver.flush()), /^rejected: .*disk full/);
  assert.match(await settled(driver.close()), /^rejected: .*disk full/);
  assert.equal(kept.record().state.status, 'running', 'the cancel is not on disk');
  // close released the journal before it threw: once the disk takes writes again, the host opens the run and cancels it.
  full = false;
  const again = await openRecovery(kept.store, workflow, { key: 'stop-commit' });
  again.stop({ action: 'cancel', source: 'operator' });
  assert.equal(await settled(again.close()), 'resolved');
  assert.equal(kept.record().state.status, 'cancelled');
});

test('a pause whose commit the store refuses is reported the same way', async () => {
  const kept = disk((next) => next?.state?.status === 'paused');
  const { driver, run } = await stopped(kept, 'pause');
  assert.equal(run, 'FROZEN_PAUSED');
  assert.match(await settled(driver.close()), /^rejected: .*disk full/);
  assert.notEqual(kept.record().state.status, 'paused');
});

test('a cancel that replaces a committed pause, with its commit refused: close throws, the run still reads paused, and a reopen cancels', async () => {
  let full = true;
  const kept = disk((next) => full && next?.state?.status === 'cancelled');
  const { driver, run } = await stopped(kept, 'pause');
  assert.equal(run, 'FROZEN_PAUSED');
  await driver.flush();
  driver.stop({ action: 'cancel', source: 'operator' });
  assert.match(await settled(driver.close()), /^rejected: .*disk full/);
  assert.equal(kept.record().state.status, 'paused', 'the cancel is not on disk');
  // The refused write does not wedge the run: once the disk takes writes again, a reopen cancels the paused run cleanly.
  full = false;
  const again = await openRecovery(kept.store, workflow, { key: 'stop-commit' });
  again.stop({ action: 'cancel', source: 'operator' });
  assert.equal(await settled(again.close()), 'resolved');
  assert.equal(kept.record().state.status, 'cancelled');
});

test('a stop commit the store refuses once, then takes: the first flush throws, and the run cancels after a reopen', async () => {
  // The reviewer's case directly: a refused write is followed by a successful one. The refusal is on the first driver
  // (sticky: flush and close keep throwing it); the success is the next open's, since a refused stop releases the journal.
  let full = true;
  const kept = disk((next) => full && next?.state?.status === 'cancelled');
  const { driver, run } = await stopped(kept, 'cancel');
  assert.equal(run, 'FROZEN_CANCELLED');
  assert.match(await settled(driver.flush()), /^rejected: .*disk full/, 'the refused commit is reported');
  assert.match(await settled(driver.flush()), /^rejected: .*disk full/, 'a second flush still reports it, never a false success');
  assert.match(await settled(driver.close()), /^rejected: .*disk full/);
  assert.equal(kept.record().state.status, 'running', 'the cancel never reached disk');
  full = false;
  const again = await openRecovery(kept.store, workflow, { key: 'stop-commit' });
  again.stop({ action: 'cancel', source: 'operator' });
  assert.equal(await settled(again.flush()), 'resolved', 'the write the disk now takes succeeds');
  assert.equal(await settled(again.close()), 'resolved');
  assert.equal(kept.record().state.status, 'cancelled');
});

test('a commit refused while the run is running is the run\'s failure: flush throws it, and close lets go of the run', async () => {
  const kept = disk((next) => next?.effects?.some((effect) => effect.calls));
  const driver = await openRecovery(kept.store, workflow, { key: 'stop-commit' });
  // The effect keeps two outside calls at once: the second call's commit waits behind the first, which the store refuses.
  const runEffect = async ({ call }) => { call({ n: 1 }); call({ n: 2 }); return { ok: true }; };
  const run = await runWorkflow(workflow, {}, withRecovery(driver, { runEffect })).then((result) => result.status, (error) => error.message);
  assert.match(run, /disk full/);
  assert.match(await settled(driver.flush()), /^rejected: .*disk full/);
  assert.equal(await settled(driver.close()), 'resolved');
});

test('a cancel whose commit lands closes cleanly, and the run never resumes', async () => {
  const kept = disk();
  const { driver, run } = await stopped(kept, 'cancel');
  assert.equal(run, 'FROZEN_CANCELLED');
  assert.equal(await settled(driver.flush()), 'resolved');
  assert.equal(await settled(driver.close()), 'resolved');
  assert.equal(kept.record().state.status, 'cancelled');
  await assert.rejects(openRecovery(kept.store, workflow, { key: 'stop-commit' }).then(async (d) => { const r = await runWorkflow(workflow, {}, withRecovery(d, { runEffect: async () => ({ ok: true }) })).finally(() => d.close()); return r; }),
    (error) => error.code === 'FROZEN_CANCELLED');
});
