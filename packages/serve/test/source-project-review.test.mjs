import assert from 'node:assert/strict';
import { test } from 'node:test';
import { storeOn } from './store-helpers.mjs';

const receipt = (entryId, status = 'uncertain') => ({ runId: 'run-one', entryId, status, reason: 'project_capture_failed' });
test('review acknowledges only the exact failed receipt; a later failure needs a new review', async t => {
  const { unresolvedProjects, acknowledgeProjects } = await import('../dist/source-sync/checkpoint-gate.js');
  const { store } = await storeOn(t); let rows = [receipt(4)]; const read = async () => rows;
  assert.equal((await unresolvedProjects(store, 'agent', read)).length, 1);
  await acknowledgeProjects(store, 'agent', [{ run_id: 'run-one', entry_id: 4 }], read);
  assert.deepEqual(await unresolvedProjects(store, 'agent', read), []);
  rows = [...rows, receipt(9)];
  assert.deepEqual((await unresolvedProjects(store, 'agent', read)).map(row => row.entry_id), [9]);
  await assert.rejects(acknowledgeProjects(store, 'agent', [{ run_id: 'run-one', entry_id: 4 }], read), error => error.code === 'precondition_failed');
  assert.equal((await unresolvedProjects(store, 'agent', read)).length, 1);
});
test('pending publication cannot be discarded, and unrelated agents do not inherit acknowledgment', async t => {
  const { unresolvedProjects, acknowledgeProjects } = await import('../dist/source-sync/checkpoint-gate.js');
  const { store } = await storeOn(t); let rows = [receipt(2, 'pending')]; const read = async () => rows;
  await assert.rejects(acknowledgeProjects(store, 'agent', [{ run_id: 'run-one', entry_id: 2 }], read), error => error.code === 'precondition_failed');
  rows = [receipt(2, 'conflict')];
  await acknowledgeProjects(store, 'agent', [{ run_id: 'run-one', entry_id: 2 }], read);
  assert.equal((await unresolvedProjects(store, 'another-agent', read)).length, 1);
  rows = [receipt(2, 'published')];
  assert.deepEqual(await unresolvedProjects(store, 'another-agent', read), []);
});
