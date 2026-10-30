// The box's cgroup reap (host/box-bwrap.ts) on a real cgroup v2 subtree delegated to this user, with plain processes in
// it (no bwrap): the reap counts a box's cgroup empty only once its whole subtree is, and a cgroup it cannot empty is
// never counted empty, so the session's slot stays held. Run it inside a delegated scope, which names the root:
//   systemd-run --user --scope -p Delegate=yes -- sh -c \
//     'AGENTRUN_BOX_CGROUP_ROOT=/sys/fs/cgroup$(awk -F: "\$1 == 0 { print \$3 }" /proc/self/cgroup) node --test test/box-cgroup-real.test.mjs'
// Without AGENTRUN_BOX_CGROUP_ROOT these skip.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { bwrapBox } from '@parcha/agentrun-kernel/host';

const ROOT = process.env.AGENTRUN_BOX_CGROUP_ROOT;
const skip = ROOT ? false : 'no delegated cgroup v2 subtree given (AGENTRUN_BOX_CGROUP_ROOT)';
const writer = { pid: process.pid, startTime: '1' };

/** A process that moves itself into `cgroup`, then sleeps; resolves once it is in. */
async function into(cgroup) {
  const child = spawn('/bin/sh', ['-c', 'echo $$ > "$0/cgroup.procs" && exec sleep 600', cgroup], { stdio: 'ignore' });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve(signal ?? code)));
  for (let i = 0; i < 200 && !readFileSync(join(cgroup, 'cgroup.procs'), 'utf8').split('\n').includes(String(child.pid)); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(readFileSync(join(cgroup, 'cgroup.procs'), 'utf8').split('\n').includes(String(child.pid)), `pid ${child.pid} did not join ${cgroup}`);
  return { child, exited };
}
const populated = (cgroup) => /^populated 1$/m.test(readFileSync(join(cgroup, 'cgroup.events'), 'utf8'));
/** Removes a test's cgroups, deepest first, once their processes are gone. */
function cleanup(...dirs) {
  for (const dir of dirs) {
    try {
      rmdirSync(dir);
    } catch {
      // gone, or still populated: the scope's end removes it
    }
  }
}

test("the reap counts a box's cgroup empty only once its whole subtree is: a process in a child cgroup is killed and waited for, then the cgroup goes", { skip }, async () => {
  const box = join(ROOT, `box-real-${process.pid}-a`);
  const child = join(box, 'child');
  mkdirSync(box);
  mkdirSync(child);
  try {
    const top = await into(box);
    const deep = await into(child);
    assert.ok(populated(box), 'the box cgroup is populated, its child included');
    const reaped = await bwrapBox({ cgroupRoot: ROOT, reapMs: 5000 }).reap({ id: 'a', cgroup: box, writer });
    assert.deepEqual(reaped, { empty: true, left: 0, by: 'cgroup' });
    assert.equal(await top.exited, 'SIGKILL');
    assert.equal(await deep.exited, 'SIGKILL', 'the process in the child cgroup was ended too');
  } finally {
    cleanup(child, box);
  }
});

test("a cgroup the reap cannot empty is never counted empty: its process lives on, the reap answers not empty, and the session's slot stays held", { skip }, async () => {
  const box = join(ROOT, `box-real-${process.pid}-b`);
  mkdirSync(box);
  const member = await into(box);
  // The reap's kill cannot be written: the member lives on, as one in an uninterruptible wait would.
  chmodSync(join(box, 'cgroup.kill'), 0o444);
  try {
    const reaped = await bwrapBox({ cgroupRoot: ROOT, reapMs: 300 }).reap({ id: 'b', cgroup: box, writer });
    assert.equal(reaped.empty, false, 'a cgroup with a live process was counted empty');
    assert.equal(reaped.by, 'cgroup');
    assert.ok(reaped.left >= 1);
    assert.ok(populated(box), 'still populated');
  } finally {
    chmodSync(join(box, 'cgroup.kill'), 0o644);
    member.child.kill('SIGKILL');
    await member.exited;
    for (let i = 0; i < 100 && populated(box); i++) await new Promise((r) => setTimeout(r, 10));
    cleanup(box);
  }
});

test("a box whose own cgroup holds no process but whose child cgroup does is not empty: the count is the subtree's, never the cgroup's own list", { skip }, async () => {
  const box = join(ROOT, `box-real-${process.pid}-c`);
  const child = join(box, 'child');
  mkdirSync(box);
  mkdirSync(child);
  const deep = await into(child);
  chmodSync(join(box, 'cgroup.kill'), 0o444);
  try {
    assert.equal(readFileSync(join(box, 'cgroup.procs'), 'utf8').trim(), '', 'the box cgroup itself lists no process');
    const reaped = await bwrapBox({ cgroupRoot: ROOT, reapMs: 300 }).reap({ id: 'c', cgroup: box, writer });
    assert.equal(reaped.empty, false, 'a box whose child cgroup holds a live process was counted empty');
    assert.ok(reaped.left >= 1);
  } finally {
    chmodSync(join(box, 'cgroup.kill'), 0o644);
    deep.child.kill('SIGKILL');
    await deep.exited;
    for (let i = 0; i < 100 && populated(box); i++) await new Promise((r) => setTimeout(r, 10));
    cleanup(child, box);
  }
});
