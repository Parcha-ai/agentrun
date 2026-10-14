// Across two pi versions only (scripts/pi-cross-version.mjs installs the packages on an older pi as PI_CROSS_FIRST and
// on a newer one as PI_CROSS_LATER): the limit of moving a store back. pi 1.2 keeps a tool call in flight as a version 2
// `pi.tool` task, which pi 1.1 cannot run. A run the newer pi left with a call in flight is not continued by the older
// one. The older pi's one commit is the one it makes for any task a dead process left running: it marks the task
// pending again. No entry, document or other task changes. The newer pi then completes the run, and makes no request
// the first process already made. The rows are the measure, not the file's bytes: SQLite folds its write-ahead log into
// the database file when the last connection closes, so even a process that writes nothing can rewrite the file.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { crossFixture, crossVersion } from './fixtures/cross-version.mjs';

/** Every row of every table of the store, read through a read-only connection, which cannot change it. */
function rows(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
    const cell = (value) => (value instanceof Uint8Array ? Buffer.from(value).toString('base64') : value);
    return Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM "${table}"`).all().map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, cell(value)])))]));
  } finally { db.close(); }
}
/** The store's rows with what a reopening pi does to any task a dead process left running taken out: a running task
 *  reads as pending, and the commit sequence counter is left out. */
function asReopened(store) {
  const task = (row) => {
    if (row.status !== 'running') return row;
    const record = JSON.parse(row.record);
    return { ...row, status: 'pending', record: JSON.stringify({ ...record, state: { ...record.state, status: 'pending' } }) };
  };
  return Object.fromEntries(Object.entries(store).map(([table, list]) => [table, list
    .map((row) => (table === 'tasks' ? task(row) : table === 'durable_metadata' ? { ...row, next_seq: null } : row))
    .map((row) => JSON.stringify(row)).sort()]));
}

test('a run the newer pi left with a tool call in flight is not continued by the older pi, which only marks it pending; the newer pi then completes it once', { skip: crossVersion ? false : 'runs only across two pi versions (scripts/pi-cross-version.mjs)' }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cross-version-back-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = join(dir, 'run.sqlite');
  const counter = join(dir, 'requests');
  writeFileSync(counter, '');
  const requests = () => readFileSync(counter, 'utf8').split('\n').filter(Boolean).length;
  const run = (which, mode, env = {}) => {
    const ran = spawnSync(process.execPath, [crossFixture('record-crash-child.mjs', which), mode, store, counter], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60_000 });
    const rows = ran.stdout.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
    return { ...ran, deliveries: rows.filter((row) => row.delivery).map((row) => row.delivery), end: rows.find((row) => 'settled' in row) };
  };
  const left = run('later', 'start', { KILL_AT: 'before-commit' });
  assert.equal(left.signal, 'SIGKILL', left.stderr);
  assert.equal(requests(), 1);
  const before = rows(store);
  const inFlight = before.tasks.filter((row) => row.kind === JSON.stringify('pi.tool') && row.status === 'running').map((row) => JSON.parse(row.record));
  assert.deepEqual(inFlight.map((record) => record.version), [2], 'the newer pi left one tool call in flight, as a version 2 pi.tool task');
  const older = run('first', 'resume');
  // Node ends a process whose top-level await never settles with 13: the older pi waits on the newer task, and
  // nothing else ends the process.
  assert.ifError(older.error);
  assert.equal(older.signal, null, older.stderr);
  assert.equal(older.status, 13, older.stderr);
  assert.deepEqual([older.deliveries, older.end], [[], undefined]);
  const after = rows(store);
  assert.deepEqual(asReopened(after), asReopened(before), 'the older pi changed nothing but marking the task a dead process left running as pending');
  assert.equal(after.tasks.find((row) => JSON.parse(row.record).id === inFlight[0].id).status, 'pending');
  const newer = run('later', 'resume');
  assert.equal(newer.status, 0, newer.stderr);
  assert.deepEqual(newer.deliveries, ['accepted']);
  assert.deepEqual(newer.end, { settled: 'done', record: { record: { verdict: 'buy' }, attempts: 1 }, gate: null });
  assert.equal(requests(), 1, 'no request the first process made is made again');
});

test('with the refusal asked for, the older pi refuses that store with a typed error instead of waiting, leaves it as a reopen would, and the newer pi completes the run once', { skip: crossVersion ? false : 'runs only across two pi versions (scripts/pi-cross-version.mjs)' }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cross-version-refuse-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = join(dir, 'run.sqlite');
  const counter = join(dir, 'requests');
  writeFileSync(counter, '');
  const requests = () => readFileSync(counter, 'utf8').split('\n').filter(Boolean).length;
  const run = (which, mode, env = {}) => {
    const ran = spawnSync(process.execPath, [crossFixture('record-crash-child.mjs', which), mode, store, counter], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60_000 });
    const rows = ran.stdout.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
    return { ...ran, refused: rows.find((row) => row.refused)?.refused, deliveries: rows.filter((row) => row.delivery).map((row) => row.delivery), end: rows.find((row) => 'settled' in row) };
  };
  assert.equal(run('later', 'start', { KILL_AT: 'before-commit' }).signal, 'SIGKILL');
  const before = rows(store);
  const older = run('first', 'resume', { REFUSE_NEWER: '1' });
  assert.equal(older.status, 3, older.stderr);
  assert.deepEqual([older.refused?.name, older.refused?.code, older.refused?.kind, older.refused?.version], ['NewerTaskError', 'PI_TASK_NEWER', 'pi.tool', 2]);
  assert.match(older.refused.message, /continue the run on pi-durable 1\.2 or later/);
  assert.deepEqual(asReopened(rows(store)), asReopened(before), 'the refusing pi changed nothing but what a reopen does');
  const newer = run('later', 'resume', { REFUSE_NEWER: '1' });
  assert.equal(newer.status, 0, newer.stderr);
  assert.deepEqual([newer.refused, newer.deliveries, requests()], [undefined, ['accepted'], 1]);
});
