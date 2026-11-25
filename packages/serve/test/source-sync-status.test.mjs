import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentWithRevision, storeOn } from './store-helpers.mjs';
import { sourceService } from '../dist/source-sync/service.js';
import { SnapshotError } from '../dist/source-sync/snapshots.js';
import { sourceKey } from '../dist/source-sync/registry.js';

async function setup(t, error) {
  const { store } = await storeOn(t); await agentWithRevision(store);
  await store.settings.put(sourceKey('agent-1'), { version: 1, id: 'a'.repeat(64), agent_id: 'agent-1', enabled: true, generation: 'fixture', sequence: 0, snapshot: 'b'.repeat(64), capture_revision: 'rev-1' });
  const service = sourceService(store, { data: '/fixture/private-data', sealKey: new Uint8Array(32), env: {} }, async () => { throw Error('No preparation expected'); });
  service.sync.options.read = async () => { throw error; };
  return service;
}
test('a missing committed snapshot is a visible prerequisite, never ready or an empty setup', async t => {
  const service = await setup(t, new SnapshotError('missing', 'The complete source snapshot has not been committed.'));
  const status = await service.status('agent-1');
  assert.equal(status.state, 'needs_attention'); assert.equal(status.moved, false);
  assert.equal(status.blockers[0].code, 'snapshot_missing');
  assert.match(status.blockers[0].message, /snapshot/);
});
test('unexpected snapshot read failures remain operational failures', async t => {
  const error = new Error('fixture backend failed'); const service = await setup(t, error);
  await assert.rejects(service.status('agent-1'), candidate => candidate === error);
});
