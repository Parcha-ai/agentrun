import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import initSqlJs from 'sql.js';
import { recordMachine } from '../scripts/record-machine.mjs';
import { CreatureStore, MemoryBackend } from '../src/store.ts';

const sql = await initSqlJs();

test('rows written by the agent-side CLI are what the tab store reads, oldest first', async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'rec-'));
  const file = join(dir, 'creature', 'memory.sqlite');
  recordMachine(file, { host: 'gpu:4090-3', kind: 'gpu', note: 'trained variant 3', at: '2026-10-09T11:00:00Z' });
  recordMachine(file, { host: 'tab', kind: 'tab', note: 'sketched', at: '2026-10-09T10:00:00Z' });
  const memory = new MemoryBackend();
  memory.bytes = new Uint8Array(readFileSync(file));
  const tab = await CreatureStore.open(sql, { designs: new MemoryBackend(), memory }, { memoryWritable: false });
  assert.deepEqual(tab.timeline().map((e) => [e.host, e.kind, e.note]), [['tab', 'tab', 'sketched'], ['gpu:4090-3', 'gpu', 'trained variant 3']]);
});

test('a bad kind or a missing host is refused before anything is written', () => {
  const file = join(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'rec-')), 'm.sqlite');
  assert.throws(() => recordMachine(file, { host: 'x', kind: 'laptop' }), /--kind/);
  assert.throws(() => recordMachine(file, { host: '', kind: 'tab' }), /--host/);
});
