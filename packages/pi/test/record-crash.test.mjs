// The `submit` tool across a kill: a process dies inside the tool, a second process only opens the file and resumes.
// Whatever the kill point, the record is delivered once, the delivery is counted once, the second reading's round is
// granted once, and the model is asked nothing more than it was before the kill.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CHILD = fileURLToPath(new URL('./fixtures/record-crash-child.mjs', import.meta.url));
const OBJECTION = { id: 'verify', kind: 'verify', verdict: 'fails', reasons: ['names no reason'] };

/** One process of the fixture: how it ended and the rows it printed. */
function child(mode, dir, env) {
  const ran = spawnSync(process.execPath, [CHILD, mode, join(dir, 'run.sqlite'), join(dir, 'requests')], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60_000 });
  const rows = ran.stdout.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
  return { signal: ran.signal, status: ran.status, stderr: ran.stderr, deliveries: rows.filter((row) => row.delivery).map((row) => row.delivery), end: rows.find((row) => 'settled' in row) };
}
const requests = (dir) => readFileSync(join(dir, 'requests'), 'utf8').split('\n').filter(Boolean).length;
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'record-crash-'));
  writeFileSync(join(dir, 'requests'), '');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('with no kill, one process delivers the record with one request', (t) => {
  const dir = scratch(t);
  const only = child('start', dir, {});
  assert.equal(only.status, 0, only.stderr);
  assert.deepEqual(only.deliveries, ['accepted']);
  assert.deepEqual(only.end, { settled: 'done', record: { record: { verdict: 'buy' }, attempts: 1 }, gate: null });
  assert.equal(requests(dir), 1);
});

test('killed inside the tool before any write: the resumed call delivers the record, once, with no new request', (t) => {
  const dir = scratch(t);
  const first = child('start', dir, { KILL_AT: 'before-commit' });
  assert.equal(first.signal, 'SIGKILL');
  assert.deepEqual(first.deliveries, []);
  const second = child('resume', dir, {});
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(second.deliveries, ['accepted']);
  assert.deepEqual(second.end, { settled: 'done', record: { record: { verdict: 'buy' }, attempts: 1 }, gate: null });
  assert.equal(requests(dir), 1, 'the turn that called submit was committed: it is not requested again');
});

test('killed after the record is committed and before the model is answered: the resumed call finds it and counts nothing more', (t) => {
  const dir = scratch(t);
  const first = child('start', dir, { KILL_AT: 'after-commit' });
  assert.equal(first.signal, 'SIGKILL');
  assert.deepEqual(first.deliveries, ['accepted']);
  const second = child('resume', dir, {});
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(second.deliveries, ['already']);
  assert.deepEqual(second.end, { settled: 'done', record: { record: { verdict: 'buy' }, attempts: 1 }, gate: null }, 'one delivery, counted once');
  assert.equal(requests(dir), 1);
});

test('killed after the second reading spent its round and before the model was told: the round is not granted again', (t) => {
  const dir = scratch(t);
  const first = child('start', dir, { KILL_AT: 'after-commit', REVIEW: 'objects' });
  assert.equal(first.signal, 'SIGKILL');
  assert.deepEqual(first.deliveries, ['bounced']);
  const second = child('resume', dir, { REVIEW: 'objects' });
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(second.deliveries, ['accepted'], 'the resumed call reads the same record after the round: it is delivered');
  assert.deepEqual(second.end, { settled: 'done', record: { record: { verdict: 'buy' }, attempts: 2 }, gate: { bounced: true, disagreements: [OBJECTION] } });
  assert.equal(requests(dir), 1);
});
