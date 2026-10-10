// The node runner across a kill: one process runs a node and is killed at one point; a second opens the file, lets pi
// resume, and reaches the node only later. At every point the second process finds the same conversation, nothing of
// the node runs before its host was told it is open, the record is delivered once, and a model turn that committed is
// not requested again.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CHILD = fileURLToPath(new URL('./fixtures/node-runner-crash-child.mjs', import.meta.url));
const SUBMIT = 'Deliver the Verdict record. Submit it inline as the tool arguments. It ends the run.';

function child(mode, dir, env = {}) {
  const ran = spawnSync(process.execPath, [CHILD, mode, join(dir, 'run.sqlite'), join(dir, 'requests')], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60_000 });
  const rows = ran.stdout.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
  return { signal: ran.signal, status: ran.status, stderr: ran.stderr, rows, events: rows.map((row) => row.event), end: rows.find((row) => row.event === 'end') };
}
const requests = (dir) => readFileSync(join(dir, 'requests'), 'utf8').split('\n').filter(Boolean).length;
const scratch = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'node-runner-crash-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'requests'), '');
  return dir;
};

test('with no kill, one process runs the node with one request', (t) => {
  const dir = scratch(t);
  const only = child('start', dir);
  assert.equal(only.status, 0, only.stderr);
  assert.deepEqual(only.events, ['open', 'request', 'review', 'delivery', 'end']);
  assert.deepEqual(only.end, { event: 'end', record: { verdict: 'buy' }, stored: { record: { verdict: 'buy' }, attempts: 1 } });
  assert.equal(requests(dir), 1);
});

// [kill point, what the first process did, what the resumed one did, model requests in all]
const ROWS = [
  ['after-conversation', ['open'], ['reached', 'open', 'request', 'review', 'delivery', 'end'], 1],
  ['mid-model', ['open', 'request'], ['reached', 'open', 'request', 'review', 'delivery', 'end'], 2],
  ['in-review', ['open', 'request', 'review'], ['reached', 'open', 'review', 'delivery', 'end'], 1],
  ['after-record', ['open', 'request', 'review', 'delivery'], ['reached', 'open', 'end'], 1],
];
// The call a process died inside after its commit is answered `already` from the record, whenever pi resumes it: it
// waits for no runner, so its place among the other events is not fixed.
const ordered = (rows) => rows.filter((row) => !(row.event === 'delivery' && row.status === 'already')).map((row) => row.event);
for (const [point, before, after, total] of ROWS) {
  test(`killed ${point}: the resumed node waits for its runner, and the record is delivered once`, (t) => {
    const dir = scratch(t);
    const first = child('start', dir, { KILL_AT: point });
    assert.equal(first.signal, 'SIGKILL', first.stderr);
    assert.deepEqual(first.events, before);
    const second = child('resume', dir);
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(ordered(second.rows), after, 'nothing of the node ran before the runner reached it and its host was told');
    assert.deepEqual(second.rows.filter((row) => row.event === 'delivery').map((row) => row.status), point === 'after-record' ? ['already'] : ['accepted']);
    assert.deepEqual(second.rows.find((row) => row.event === 'open'), { event: 'open', conversation: first.rows[0].conversation, resumed: true });
    for (const row of second.rows.filter((row) => row.event === 'request')) assert.equal(row.submit, SUBMIT, 'a resumed request shows the node its own submit');
    assert.deepEqual(second.end, { event: 'end', record: { verdict: 'buy' }, stored: { record: { verdict: 'buy' }, attempts: 1 } }, 'one delivery, counted once');
    assert.equal(requests(dir), total);
  });
}
