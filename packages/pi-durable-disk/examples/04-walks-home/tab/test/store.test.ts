import { test } from 'node:test';
import assert from 'node:assert/strict';
import initSqlJs from 'sql.js';
import { CreatureStore, MemoryBackend } from '../src/store.ts';
import { defaultDesign } from '../src/design.ts';

const sql = await initSqlJs();

test('a design is stored once per body, and survives a reopen from the backend bytes', async () => {
  const be = new MemoryBackend();
  const s = await CreatureStore.open(sql, be);
  const a = await s.saveDesign(defaultDesign(), '2026-10-09T10:00:00Z');
  const again = await s.saveDesign(defaultDesign(), '2026-10-09T10:05:00Z');
  assert.equal(again.id, a.id);
  assert.equal(be.writes, 1, 'no write for a design already held');
  const longer = defaultDesign();
  longer.torso.length = 0.6;
  const b = await s.saveDesign(longer, '2026-10-09T10:06:00Z');
  assert.notEqual(b.sha256, a.sha256);
  const s2 = await CreatureStore.open(sql, be);
  assert.deepEqual(s2.designs().map((d) => d.id), [b.id, a.id]);
  assert.equal(s2.designs()[1].design.torso.length, 0.5);
});

test('machine timeline reads back oldest first, and each insert reaches the backend before it resolves', async () => {
  const be = new MemoryBackend();
  const s = await CreatureStore.open(sql, be);
  await s.recordMachine({ at: '2026-10-09T10:02:00Z', host: 'daytona:sbx-1', kind: 'sandbox', note: 'wrote the training env' });
  await s.recordMachine({ at: '2026-10-09T10:00:00Z', host: 'tab', kind: 'tab', note: 'sketched the creature' });
  const reopened = await CreatureStore.open(sql, be);
  assert.deepEqual(reopened.timeline().map((e) => e.host), ['tab', 'daytona:sbx-1']);
});
