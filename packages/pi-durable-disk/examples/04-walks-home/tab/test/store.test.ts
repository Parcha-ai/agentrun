import { test } from 'node:test';
import assert from 'node:assert/strict';
import initSqlJs from 'sql.js';
import { CreatureStore, MEMORY_SCHEMA, MemoryBackend } from '../src/store.ts';
import { defaultDesign } from '../src/design.ts';

const sql = await initSqlJs();
const backends = () => ({ designs: new MemoryBackend(), memory: new MemoryBackend() });

test('a design is stored once per body, and survives a reopen from the backend bytes', async () => {
  const be = backends();
  const s = await CreatureStore.open(sql, be);
  const a = await s.saveDesign(defaultDesign(), '2026-10-09T10:00:00Z');
  const again = await s.saveDesign(defaultDesign(), '2026-10-09T10:05:00Z');
  assert.equal(again.id, a.id);
  assert.equal(be.designs.writes, 1, 'no write for a design already held');
  const longer = defaultDesign();
  longer.torso.length = 0.6;
  const b = await s.saveDesign(longer, '2026-10-09T10:06:00Z');
  assert.notEqual(b.sha256, a.sha256);
  const s2 = await CreatureStore.open(sql, be);
  assert.deepEqual(s2.designs().map((d) => d.id), [b.id, a.id]);
  assert.equal(s2.designs()[1].design.torso.length, 0.5);
  assert.equal(be.memory.writes, 0, 'designs never touch memory.sqlite');
});

test('machine timeline reads back oldest first, and each insert reaches the backend before it resolves', async () => {
  const be = backends();
  const s = await CreatureStore.open(sql, be);
  await s.recordMachine({ at: '2026-10-09T10:02:00Z', host: 'daytona:sbx-1', kind: 'sandbox', note: 'wrote the training env' });
  await s.recordMachine({ at: '2026-10-09T10:00:00Z', host: 'tab', kind: 'tab', note: 'sketched the creature' });
  const reopened = await CreatureStore.open(sql, be);
  assert.deepEqual(reopened.timeline().map((e) => e.host), ['tab', 'daytona:sbx-1']);
});

test('the tab never writes memory.sqlite when the agent owns it, and sees rows the agent added since it opened', async () => {
  const be = backends();
  const tab = await CreatureStore.open(sql, be, { memoryWritable: false });
  await assert.rejects(tab.recordMachine({ at: '2026-10-09T10:00:00Z', host: 'tab', kind: 'tab', note: '' }), /belongs to the agent/);
  assert.equal(be.memory.writes, 0);
  assert.equal(tab.timeline().length, 0);

  // the agent, on another machine, appends rows with its own sqlite: exactly the documented schema
  const agentDb = new sql.Database();
  agentDb.run(MEMORY_SCHEMA);
  agentDb.run("INSERT INTO machines (at, host, kind, note) VALUES ('2026-10-09T11:00:00Z', 'gpu:4090-3', 'gpu', 'trained variant 3')");
  be.memory.bytes = agentDb.export();

  // the tab saves a design while its memory copy is stale; the agent's file is untouched
  await tab.saveDesign(defaultDesign());
  assert.equal(be.memory.writes, 0);
  assert.equal(tab.timeline().length, 0, 'the open store does not change under the reader');
  const fresh = await tab.reload(sql);
  assert.deepEqual(fresh.timeline().map((e) => e.host), ['gpu:4090-3']);
  assert.equal(fresh.designs().length, 1);
});
