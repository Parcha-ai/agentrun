// Two independent stores exercise the insertion/read ordering used by writers and deletion. No elapsed lease
// authorizes deletion: a failed remote write remains unresolved until its owner confirms settlement.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentWithRevision, storeOn } from './store-helpers.mjs';
import { purgingKey } from '../dist/agent-delete.js';
const api = () => import('../dist/source-sync/io.js');
async function pair(t) {
  const first = await storeOn(t), second = await storeOn(t, { file: first.file, role: 'runner', clock: first.clock });
  await agentWithRevision(first.store); return { store: first.store, other: second.store, clock: first.clock };
}

test('a reserved auxiliary operation has one durable writer across handles, with no timed takeover', async t => {
  const { store, other } = await pair(t), { beginSourceIO, sourceIOPrefix } = await api();
  const first = await beginSourceIO(store, 'agent-1', 'placement', 'auxiliary:reserved-run');
  await assert.rejects(beginSourceIO(other, 'agent-1', 'placement', 'auxiliary:reserved-run'), /source operation is still writing/);
  const later = Date.now() + 86_400_000;
  t.mock.method(Date, 'now', () => later);
  await assert.rejects(beginSourceIO(other, 'agent-1', 'placement', 'auxiliary:reserved-run'), /source operation is still writing/);
  t.mock.restoreAll();
  assert.equal((await store.settings.all({ prefix: sourceIOPrefix('agent-1') })).length, 1);
  await first.settled();
  const second = await beginSourceIO(other, 'agent-1', 'placement', 'auxiliary:reserved-run');
  await assert.rejects(first.settled(), /new owner must resolve/);
  assert.equal((await store.settings.all({ prefix: sourceIOPrefix('agent-1') })).length, 1);
  await second.settled();
});

test('a source writer admitted first prevents deletion until its actual I/O settles', async t => {
  const { store, other } = await pair(t), { beginSourceIO, requireSourceIOIdle } = await api();
  const hold = await beginSourceIO(store, 'agent-1', 'snapshot');
  await other.agents.archive('agent-1', true); await other.settings.put(purgingKey('agent-1'), true);
  await assert.rejects(requireSourceIOIdle(other, 'agent-1'), /source.*write|source.*operation/i);
  await hold.settled(); await requireSourceIOIdle(other, 'agent-1');
});

test('a writer inserted after the deletion mark refuses before invoking any filesystem callback', async t => {
  const { store, other } = await pair(t), { withSourceIO, requireSourceIOIdle, sourceIOPrefix } = await api();
  await other.agents.archive('agent-1', true); await other.settings.put(purgingKey('agent-1'), true);
  await requireSourceIOIdle(other, 'agent-1'); let called = false;
  await assert.rejects(withSourceIO(store, 'agent-1', 'placement', async () => { called = true; }), /active|delet|archiv/i);
  assert.equal(called, false); assert.deepEqual(await other.settings.all({ prefix: sourceIOPrefix('agent-1') }), [], 'a refusal before I/O can release its own receipt');
});

test('deletion between receipt insertion and the writer activity check cannot admit filesystem work', async t => {
  const { store, other } = await pair(t), { withSourceIO, sourceIOPrefix, requireSourceIOIdle } = await api();
  const put = store.settings.putIfAbsent; let inserted = false, called = false;
  store.settings.putIfAbsent = async (...args) => {
    const value = await put(...args); inserted = true;
    await other.agents.archive('agent-1', true); await other.settings.put(purgingKey('agent-1'), true);
    await assert.rejects(requireSourceIOIdle(other, 'agent-1'), /source.*write|source.*operation/i);
    return value;
  };
  await assert.rejects(withSourceIO(store, 'agent-1', 'snapshot', async () => { called = true; }));
  assert.equal(inserted, true); assert.equal(called, false);
  assert.deepEqual(await other.settings.all({ prefix: sourceIOPrefix('agent-1') }), []);
});

test('error, cancellation, and a lost owner retain durable receipts without age takeover', async t => {
  const { store, other } = await pair(t), { withSourceIO, beginSourceIO, sourceIOPrefix, requireSourceIOIdle } = await api();
  for (const failure of [new Error('fixture unknown remote write outcome'), new DOMException('fixture cancel', 'AbortError')])
    await assert.rejects(withSourceIO(store, 'agent-1', 'snapshot', async () => { throw failure; }), actual => actual === failure);
  await beginSourceIO(store, 'agent-1', 'placement'); // Simulate process loss: no completion call.
  const rows = await other.settings.all({ prefix: sourceIOPrefix('agent-1') }); assert.equal(rows.length, 3);
  for (const row of rows) await other.settings.put(row.key, { ...row.value, startedAt: 1 });
  await other.agents.archive('agent-1', true);
  await assert.rejects(requireSourceIOIdle(other, 'agent-1'), /source.*write|source.*operation/i);
  assert.equal((await other.settings.all({ prefix: sourceIOPrefix('agent-1') })).length, 3);
});

test('receipts are capacity bounded across handles and exact completion cannot remove a replacement', async t => {
  const { store, other } = await pair(t), { beginSourceIO, sourceIOPrefix, SOURCE_IO_LIMIT } = await api();
  const hold = await beginSourceIO(store, 'agent-1', 'placement'), [row] = await other.settings.all({ prefix: sourceIOPrefix('agent-1') });
  const replacement = { ...row.value, token: 'fixture-new-owner' }; await other.settings.put(row.key, replacement);
  await assert.rejects(hold.settled(), /changed|receipt/i); assert.deepEqual(await store.settings.get(row.key), replacement);
  await Promise.all(Array.from({ length: SOURCE_IO_LIMIT - 1 }, (_, i) => beginSourceIO(i % 2 ? other : store, 'agent-1', 'snapshot')));
  await assert.rejects(beginSourceIO(store, 'agent-1', 'snapshot'), /unresolved|capacity|source.*operation/i);
  assert.equal((await other.settings.all({ prefix: sourceIOPrefix('agent-1') })).length, SOURCE_IO_LIMIT);
});
