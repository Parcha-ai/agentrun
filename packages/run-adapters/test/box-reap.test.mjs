// ./host's box (box-bwrap.ts): what a reap signals and what it counts. Its answer is the kernel's count only, and a pid
// whose start time or namespace no longer matches the record is never signalled. A real pid namespace needs bwrap (the
// CI job's box tests); these use this host's processes.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { bwrapBox, countInPidns, pidnsOf, startTimeOf } from '@parcha/agentrun-adapters/host';

const alive = (child) => child.exitCode === null && child.signalCode === null;
const sleeper = async () => {
  const child = spawn('sleep', ['60'], { stdio: 'ignore' });
  await new Promise((resolve) => child.once('spawn', resolve));
  return child;
};

test('a record with neither a pid nor a cgroup counts nothing: by none, and never empty', async () => {
  const reaped = await bwrapBox().reap({ id: 'x', writer: { pid: process.pid, startTime: startTimeOf(process.pid) } });
  assert.deepEqual(reaped, { empty: false, left: 0, by: 'none' });
});

test('a pid whose start time is not the recorded one is never signalled: a reused pid lives', async () => {
  const child = await sleeper();
  try {
    const reaped = await bwrapBox({ reapMs: 50 }).reap({ id: 'x', pid: child.pid, startTime: '1', pidns: 'pid:[1]', writer: { pid: process.pid, startTime: '1' } });
    await new Promise((resolve) => setTimeout(resolve, 100)); // a SIGKILL, had there been one, has landed by now
    assert.ok(alive(child), 'a process that is not the box\'s pid 1 was killed');
    assert.equal(reaped.by, 'pidns');
  } finally {
    child.kill('SIGKILL');
  }
});

test('a pid in another namespace than the recorded one is never signalled', async () => {
  const child = await sleeper();
  try {
    await bwrapBox({ reapMs: 50 }).reap({ id: 'x', pid: child.pid, startTime: startTimeOf(child.pid), pidns: 'pid:[1]', writer: { pid: process.pid, startTime: '1' } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(alive(child));
  } finally {
    child.kill('SIGKILL');
  }
});

test('the recorded pid 1 (start time and namespace matching) is SIGKILLed, and the count is the kernel\'s: this host\'s namespace is never empty', async () => {
  const child = await sleeper();
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve(signal)));
  const record = { id: 'x', pid: child.pid, startTime: startTimeOf(child.pid), pidns: pidnsOf(child.pid), writer: { pid: process.pid, startTime: '1' } };
  const reaped = await bwrapBox({ reapMs: 100 }).reap(record);
  assert.equal(await exited, 'SIGKILL');
  assert.equal(reaped.by, 'pidns');
  assert.equal(reaped.empty, false, 'this test runs in the host\'s namespace, which is never empty');
  assert.ok(reaped.left > 0);
});

test('a cgroup that is gone was emptied (rmdir succeeds only on an empty cgroup): by cgroup, empty', async () => {
  const gone = join(mkdtempSync(join(tmpdir(), 'box-reap-')), 'cg');
  assert.deepEqual(await bwrapBox().reap({ id: 'x', cgroup: gone, writer: { pid: process.pid, startTime: '1' } }), { empty: true, left: 0, by: 'cgroup' });
});

test('the count reads the kernel: this process is in its own namespace, and a made-up namespace whose pid 1 is not ours holds nothing', () => {
  assert.ok(countInPidns(pidnsOf(process.pid)) >= 1);
  // A pid 1 no process descends from (pid 2 is kthreadd): an unreadable process of another sandbox on this host (a
  // browser's) is not counted for it.
  assert.equal(countInPidns('pid:[1]', 2), 0);
});
