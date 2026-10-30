// ./host's box (box-bwrap.ts): what a reap signals and what it counts. Its answer is the kernel's count only, and a pid
// whose start time or namespace no longer matches the record is never signalled. A real pid namespace needs bwrap (the
// CI job's box tests); these use this host's processes.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { bwrapBox, countInPidns, pidnsMembers, pidnsOf, startTimeOf } from '@parcha/agentrun-kernel/host';

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

/** A delegated root as the reap reads it: a directory with a readable cgroup.procs. */
function liveRoot() {
  const root = mkdtempSync(join(tmpdir(), 'box-cgroot-'));
  writeFileSync(join(root, 'cgroup.procs'), '');
  return root;
}

test('a cgroup that is gone was emptied (rmdir succeeds only on an empty cgroup), while the delegated root reads: by cgroup, empty', async () => {
  const root = liveRoot();
  assert.deepEqual(await bwrapBox({ cgroupRoot: root }).reap({ id: 'x', cgroup: join(root, 'cg'), writer: { pid: process.pid, startTime: '1' } }), { empty: true, left: 0, by: 'cgroup' });
});

test('a missing box cgroup proves nothing when the delegated root is missing, unreadable, or not configured: not empty', async () => {
  const record = (cgroup) => ({ id: 'x', cgroup, writer: { pid: process.pid, startTime: '1' } });
  // The root moved or unmounted: every box's cgroup is missing.
  const moved = join(tmpdir(), `box-cgroot-gone-${process.pid}-${Date.now()}`);
  let reaped = await bwrapBox({ cgroupRoot: moved, reapMs: 50 }).reap(record(join(moved, 'cg')));
  assert.equal(reaped.empty, false, 'a missing root read as an emptied box');
  assert.equal(reaped.by, 'cgroup');
  // The root unreadable.
  const root = liveRoot();
  chmodSync(join(root, 'cgroup.procs'), 0o000);
  try {
    reaped = await bwrapBox({ cgroupRoot: root, reapMs: 50 }).reap(record(join(root, 'cg')));
    assert.equal(reaped.empty, false, 'an unreadable root read as an emptied box');
  } finally {
    chmodSync(join(root, 'cgroup.procs'), 0o644);
  }
  // No root configured.
  reaped = await bwrapBox({ reapMs: 50 }).reap(record(join(root, 'cg')));
  assert.equal(reaped.empty, false, 'no root configured, and a missing cgroup read as emptied');
});

test('populated is read from its own line of cgroup.events: "populated 0" is empty, "populated 1" is not, anything else is unknown', async () => {
  const root = liveRoot();
  const cg = join(root, 'cg');
  mkdirSync(cg);
  writeFileSync(join(cg, 'cgroup.kill'), '');
  writeFileSync(join(cg, 'cgroup.procs'), '');
  const reap = () => bwrapBox({ cgroupRoot: root, reapMs: 50 }).reap({ id: 'x', cgroup: cg, writer: { pid: process.pid, startTime: '1' } });
  // A phrase inside another line, either way round, never decides: only the line that is `populated 0|1` itself does.
  for (const [events, empty] of [['frozen 0\npopulated 1\n', false], ['xpopulated 0\npopulated 1\n', false], ['xpopulated 1\npopulated 0\n', true], ['frozen 0\n', false], ['populated 0\nfrozen 0\n', true]]) {
    writeFileSync(join(cg, 'cgroup.events'), events);
    assert.equal((await reap()).empty, empty, JSON.stringify(events));
  }
});

test('a cgroup whose population cannot be read is not empty: unknown is never gone, and only a missing cgroup counts as emptied', async () => {
  const cg = join(mkdtempSync(join(tmpdir(), 'box-reap-')), 'cg');
  mkdirSync(cg);
  writeFileSync(join(cg, 'cgroup.events'), 'populated 0\nfrozen 0\n');
  writeFileSync(join(cg, 'cgroup.kill'), '');
  writeFileSync(join(cg, 'cgroup.procs'), '');
  chmodSync(join(cg, 'cgroup.events'), 0o000);
  try {
    const reaped = await bwrapBox({ reapMs: 50 }).reap({ id: 'x', cgroup: cg, writer: { pid: process.pid, startTime: '1' } });
    assert.equal(reaped.empty, false, 'an unreadable cgroup.events was taken for an empty box');
    assert.equal(reaped.by, 'cgroup');
    assert.ok(reaped.left >= 1);
  } finally {
    chmodSync(join(cg, 'cgroup.events'), 0o644);
  }
  // Readable and unpopulated: empty.
  assert.deepEqual(await bwrapBox({ reapMs: 50 }).reap({ id: 'x', cgroup: cg, writer: { pid: process.pid, startTime: '1' } }), { empty: true, left: 0, by: 'cgroup' });
});

test('the count reads the kernel: this process is in its own namespace, and a made-up namespace whose pid 1 is not ours holds nothing', () => {
  assert.ok(countInPidns(pidnsOf(process.pid)) >= 1);
  // A pid 1 no process descends from (pid 2 is kthreadd): an unreadable process of another sandbox on this host (a
  // browser's) is not counted for it.
  assert.equal(countInPidns('pid:[1]', { pid: 2, startTime: startTimeOf(2) }), 0);
});

/** A fake /proc: each process a directory with its stat, status and ns/pid link; `hidden` ones have an unreadable ns/ (as
 *  a non-dumpable process's is), `nostat` ones an unreadable stat. */
/** Each fake /proc made here: its unreadable entries are made readable again and it is removed once the tests are done. */
const made = [];
after(() => {
  for (const root of made) {
    execFileSync('chmod', ['-R', 'u+rwx', root]);
    rmSync(root, { recursive: true, force: true });
  }
});

function fakeProc(processes) {
  const root = mkdtempSync(join(tmpdir(), 'box-proc-'));
  made.push(root);
  const uid = process.getuid();
  for (const p of processes) {
    const dir = join(root, String(p.pid));
    mkdirSync(join(dir, 'ns'), { recursive: true });
    symlinkSync(p.pidns, join(dir, 'ns', 'pid'));
    const fields = ['S', String(p.parent), ...Array(17).fill('0'), String(p.start)];
    writeFileSync(join(dir, 'stat'), `${p.pid} (proc) ${fields.join(' ')} 0 0\n`);
    writeFileSync(join(dir, 'status'), `Name:\tproc\nUid:\t${p.uid ?? uid}\t${p.uid ?? uid}\t${p.uid ?? uid}\t${p.uid ?? uid}\nNSpid:\t${p.nested === false ? p.pid : `${p.pid}\t7`}\n`);
    if (p.nostat) chmodSync(join(dir, 'stat'), 0o000);
    if (p.hidden) chmodSync(join(dir, 'ns'), 0o000);
  }
  return root;
}
const BOX = 'pid:[4026539999]';

test('an unreadable process of the box (non-dumpable) counts when its parents lead to pid 1 as recorded, pid and start time', () => {
  const proc = fakeProc([
    { pid: 500, parent: 400, start: 1000, pidns: BOX },
    { pid: 510, parent: 500, start: 1001, pidns: BOX },
    { pid: 520, parent: 510, start: 1002, pidns: 'x', hidden: true },
  ]);
  assert.equal(countInPidns(BOX, { pid: 500, startTime: '1000' }, proc), 3, 'pid 1, its child, and the hidden grandchild');
  // Each named, with how it counted: the two readable ones by their namespace, the hidden one by its chain to pid 1.
  assert.deepEqual(pidnsMembers(BOX, { pid: 500, startTime: '1000' }, proc).map((m) => [m.pid, m.how, m.comm, m.ppid]).sort(), [[500, 'ns', 'proc', 400], [510, 'ns', 'proc', 500], [520, 'chain', 'proc', 510]]);
});

test('a chain that reaches the recorded pid with another start time (the pid reused) is not the box', () => {
  const proc = fakeProc([
    { pid: 500, parent: 1, start: 9999, pidns: 'pid:[1]', nested: false },
    { pid: 520, parent: 500, start: 10000, pidns: 'x', hidden: true },
  ]);
  assert.equal(countInPidns(BOX, { pid: 500, startTime: '1000' }, proc), 0);
});

test('an unreadable process whose parent chain cannot be read to its end counts as left: unknown is never gone', () => {
  const proc = fakeProc([
    { pid: 600, parent: 500, start: 1, pidns: 'x', hidden: true },
    { pid: 500, parent: 400, start: 2, pidns: 'x', hidden: true, nostat: true },
  ]);
  assert.equal(countInPidns(BOX, { pid: 300, startTime: '1' }, proc), 2);
  assert.deepEqual(pidnsMembers(BOX, { pid: 300, startTime: '1' }, proc).map((m) => m.how), ['chain-unread', 'chain-unread'], 'each named as a chain that could not be read to its end');
});

test('another user\'s unreadable process, or one in this process\'s own namespace, is no box\'s', () => {
  const proc = fakeProc([
    { pid: 700, parent: 500, start: 1, pidns: 'x', hidden: true, uid: process.getuid() + 1 },
    { pid: 710, parent: 500, start: 1, pidns: 'x', hidden: true, nested: false },
    { pid: 500, parent: 1, start: 1000, pidns: BOX },
  ]);
  assert.equal(countInPidns(BOX, { pid: 500, startTime: '1000' }, proc), 1, 'pid 1 alone');
});
