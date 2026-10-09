// Agent side of the memory: append one row to work/creature/memory.sqlite saying which machine the agent is on.
// Needs node >= 22.13 (node:sqlite). The schema is MEMORY_SCHEMA in src/store.ts; the tab only reads this file.
//   node record-machine.mjs <memory.sqlite> --host gpu:4090-3 --kind gpu --note "trained reward variant 3" [--at 2026-10-09T11:00:00Z]
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const KINDS = ['tab', 'sandbox', 'vm', 'gpu', 'other'];

export function recordMachine(path, { host, kind, note = '', at = new Date().toISOString() }) {
  if (!host) throw new Error('--host is required');
  if (!KINDS.includes(kind)) throw new Error(`--kind must be one of ${KINDS.join(', ')}`);
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(`CREATE TABLE IF NOT EXISTS machines (
      id INTEGER PRIMARY KEY, at TEXT NOT NULL, host TEXT NOT NULL, kind TEXT NOT NULL, note TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS machines_at ON machines(at);`);
    db.prepare('INSERT INTO machines (at, host, kind, note) VALUES (?, ?, ?, ?)').run(at, host, kind, note);
  } finally {
    db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { host: { type: 'string' }, kind: { type: 'string' }, note: { type: 'string' }, at: { type: 'string' } } });
  if (positionals.length !== 1) throw new Error('usage: record-machine.mjs <memory.sqlite> --host H --kind K [--note N] [--at ISO]');
  recordMachine(positionals[0], values);
}
