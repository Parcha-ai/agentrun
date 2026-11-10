// A run whose task fails while an agent node is in flight, and is then replaced by a later start. One process is
// killed inside the node's model request; the next opens the run and its open fails (an older build refusing it, or a
// host failing to give its options), so the task ends failed and pi aborts the node's request; a third start replaces
// the failed task over the same journal. That run completes with the uncut run's output, the tool is called once, and
// the node runs again in a conversation of the new task instead of failing on the request the old task's end aborted.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { childPath } from './fixtures/cross-version.mjs';

const CHILD = childPath('node-replace-child.mjs');

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'node-replace-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of ['calls', 'requests']) writeFileSync(join(dir, name), '');
  return dir;
}
function child(mode, dir, env = {}) {
  const ran = spawnSync(process.execPath, [CHILD, mode, join(dir, 'run.sqlite')], {
    env: { ...process.env, CALLS: join(dir, 'calls'), REQUESTS: join(dir, 'requests'), ...env }, encoding: 'utf8', timeout: 60_000,
  });
  const rows = ran.stdout.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
  return { signal: ran.signal, status: ran.status, stderr: ran.stderr, last: rows.at(-1) };
}
const lines = (dir, name) => readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean).length;

test('with nothing failed, one process runs the tool once and the node once', (t) => {
  const dir = scratch(t);
  const only = child('start', dir);
  assert.equal(only.status, 0, only.stderr);
  assert.deepEqual(only.last, { outcome: 'complete', output: { total: 42, verdict: 'buy' } });
  assert.deepEqual([lines(dir, 'calls'), lines(dir, 'requests')], [1, 1]);
});

// [how the second process's open fails, its code]
const REFUSALS = [
  ['an older build refuses the run at its open', 'FROZEN_CHECKPOINT_INVALID'],
  ['a host fails to give its options', 'HOST_OPTIONS_FAILED'],
];
for (const [how, code] of REFUSALS) {
  test(`a task that fails while its agent node is in flight (${how}) is replaced by the next start, which completes with the uncut output and calls the tool once`, (t) => {
    const dir = scratch(t);
    const killed = child('start', dir, { KILL_AT: 'mid-model' });
    assert.equal(killed.signal, 'SIGKILL', killed.stderr);
    assert.equal(lines(dir, 'requests'), 1, 'the node\'s request was in flight when the process died');
    const refused = child('refuse', dir, { REFUSE_CODE: code });
    assert.equal(refused.status, 0, refused.stderr);
    assert.deepEqual(refused.last, { settled: 'terminal', outcome: 'failed' }, 'the run\'s open failed, so its task ended failed');
    const replaced = child('start', dir);
    assert.equal(replaced.status, 0, replaced.stderr);
    assert.deepEqual(replaced.last, { outcome: 'complete', output: { total: 42, verdict: 'buy' } });
    assert.equal(lines(dir, 'calls'), 1, 'the tool was called once, by the first process');
  });
}
