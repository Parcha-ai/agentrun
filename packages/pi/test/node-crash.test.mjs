// A node attempt across a kill: a task runs one LLM node in a conversation it owns; the process is killed at one
// point, and a second process only opens the file, installs the extension and resumes. At every point the second
// process finds the same conversation, the record is delivered once, and a model turn that committed is not requested
// again: only the one request that was in flight at the kill is sent a second time.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CHILD = fileURLToPath(new URL('./fixtures/node-crash-child.mjs', import.meta.url));

function child(mode, dir, env) {
  const ran = spawnSync(process.execPath, [CHILD, mode, join(dir, 'run.sqlite'), join(dir, 'requests')], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60_000 });
  const rows = ran.stdout.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
  return { signal: ran.signal, status: ran.status, stderr: ran.stderr, task: rows.find((row) => 'task' in row)?.task, opened: rows.filter((row) => 'conversation' in row), end: rows.find((row) => 'outcome' in row) };
}
const requests = (dir) => readFileSync(join(dir, 'requests'), 'utf8').split('\n').filter(Boolean).length;

test('with no kill, one process runs the node with one request', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'node-crash-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'requests'), '');
  const only = child('start', dir, {});
  assert.equal(only.status, 0, only.stderr);
  assert.equal(only.end.outcome, 'completed');
  assert.deepEqual(only.end.result.record, { verdict: 'buy' });
  assert.deepEqual(only.end.record, { record: { verdict: 'buy' }, attempts: 1 });
  assert.equal(requests(dir), 1);
});

// [kill point, model requests before the kill, model requests in all, whether the resumed attempt had to wait on its submission]
const ROWS = [
  ['after-conversation', 0, 1, true],
  ['mid-model', 1, 2, true],
  ['in-submit-tool', 1, 1, true],
  ['after-submission', 1, 1, false],
];
for (const [point, before, total, requested] of ROWS) {
  test(`killed ${point}: the resumed task finds the same conversation and the record is delivered once`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'node-crash-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'requests'), '');
    const first = child('start', dir, { KILL_AT: point });
    assert.equal(first.signal, 'SIGKILL', first.stderr);
    assert.deepEqual(first.opened.map((row) => row.resumed), [false]);
    assert.equal(requests(dir), before);
    const second = child('resume', dir, { TASK_ID: String(first.task) });
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(second.opened, [{ conversation: first.opened[0].conversation, resumed: true }], 'the same conversation, found by the attempt\'s session id');
    assert.equal(second.end.outcome, 'completed');
    assert.deepEqual(second.end.result, { conversation: first.opened[0].conversation, record: { verdict: 'buy' }, requested });
    assert.deepEqual(second.end.record, { record: { verdict: 'buy' }, attempts: 1 }, 'one delivery, counted once');
    assert.equal(requests(dir), total);
  });
}
