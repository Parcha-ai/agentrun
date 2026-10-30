// The box on a real bwrap (host/box-bwrap.ts): what a harness inside it can and cannot see, what its reap counts, and that
// its probe passes. These need a bwrap that can make a user namespace (on Ubuntu 24.04, after `agentrun-box install`):
// without one they skip, naming the probe's answer, unless AGENTRUN_BOX_REAL=1 (the CI job that installs it) makes them fail.
// The server's home is never bound into a box, so the job runs them with a HOME outside the checkout.
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { BOX_FORWARD, boxListens, bwrapBox, countInPidns, forwardChild, probeBox } from '@parcha/agentrun-kernel/host';

const REQUIRED = process.env.AGENTRUN_BOX_REAL === '1';
const probed = await (async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'box-real-probe-'));
  try {
    return await probeBox({ scratch });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
})();
const usable = probed.mode === 'bwrap';
const skip = usable ? false : REQUIRED ? false : `no usable bwrap here: ${JSON.stringify(probed)}`;

/** A run directory: its workspace (bound into the box) and a placeholder for the model socket the forwarder serves. */
function run(name) {
  const root = mkdtempSync(join(tmpdir(), `box-real-${name}-`));
  const workspace = join(root, 'run', 'work');
  mkdirSync(workspace, { recursive: true });
  const modelSocket = join(root, 'model.sock');
  writeFileSync(modelSocket, '');
  const spec = { workspace, homes: {}, readOnly: [dirname(dirname(process.execPath)), BOX_FORWARD], modelSocket, modelPort: 8123, env: { PATH: '/usr/bin:/bin' } };
  return { root, workspace, spec, remove: () => rmSync(root, { recursive: true, force: true }) };
}

/** Starts `script` under /bin/sh in a box built from `spec`; resolves with its stdout, the box's record and the box. */
async function inBox(spec, script, { wait = true } = {}) {
  const box = bwrapBox({ reapMs: 5000 });
  const boxed = box.start(spec, forwardChild({ command: '/bin/sh', args: ['-c', script] }, boxListens(spec)), { ahead() {}, async started() {} });
  let out = '';
  boxed.child.stdout.on('data', (chunk) => (out += chunk));
  let record;
  try {
    record = await boxed.ready;
  } catch (error) {
    // The box never ran: bwrap's own words say which mount or namespace failed.
    throw new Error(`the box did not start: ${error.message}; bwrap said: ${boxed.stderrTail().trim() || '(nothing)'}`, { cause: error });
  }
  if (wait) await boxed.exited;
  /** Its stdout, and what bwrap and the harness wrote to stderr: for a failure message. */
  const said = () => `stdout: ${JSON.stringify(out)}; stderr: ${JSON.stringify(boxed.stderrTail())}`;
  return { box, boxed, record, out: () => out, said };
}

test('the probe passes on this host: pid 1 inside is bwrap, /data is absent, the host loopback does not answer', { skip }, () => {
  assert.equal(probed.mode, 'bwrap', `the probe found ${JSON.stringify(probed)}`);
});

test('nothing of the host leaks in: an environment variable of the server, a file beside the run, the host root', { skip }, async () => {
  const r = run('canary');
  const beside = join(r.root, 'canary.txt'); // in the run's own directory, but not in its workspace
  writeFileSync(beside, 'host secret');
  process.env.AGENTRUN_BOX_CANARY = 'host secret';
  try {
    const { out } = await inBox(r.spec, `printf 'env=[%s]\\n' "$AGENTRUN_BOX_CANARY"; if [ -e '${beside}' ]; then echo file=seen; else echo file=absent; fi; ls -A / | tr '\\n' ' '; echo`);
    assert.match(out(), /^env=\[\]$/m, 'the server environment reached the box');
    assert.match(out(), /^file=absent$/m, 'a host file beside the run reached the box');
    for (const forbidden of ['home', 'root', 'srv', 'data', 'var', 'opt']) assert.doesNotMatch(out(), new RegExp(`(^| )${forbidden}( |$)`, 'm'), `/${forbidden} is in the box`);
  } finally {
    delete process.env.AGENTRUN_BOX_CANARY;
    r.remove();
  }
});

test("the workspace's parents are empty in the box: only the workspace is bound, a sibling of it is not there (ENOENT)", { skip }, async () => {
  const r = run('parents');
  const sibling = join(dirname(r.workspace), 'secret.txt');
  writeFileSync(sibling, 'not for the box');
  writeFileSync(join(r.workspace, 'mine.txt'), 'the run');
  try {
    const { out } = await inBox(r.spec, `ls -A '${dirname(r.workspace)}'; cat '${sibling}' 2>&1; cat '${join(r.workspace, 'mine.txt')}'; echo; cat /workspace/mine.txt`);
    const lines = out().split('\n');
    assert.equal(lines[0], 'work', `the workspace's parent holds more than the workspace: ${out()}`);
    assert.match(out(), /secret\.txt: No such file or directory/);
    assert.match(out(), /^the run$/m);
    assert.equal(lines.filter((l) => l === 'the run').length, 2, 'the workspace at its own path and at /workspace');
  } finally {
    r.remove();
  }
});

test('a run directory under a parent of this user, mode 700 (a per-user TMPDIR), works: the box reads and writes its workspace there', { skip }, async () => {
  // The box runs as the server's own uid, mapped to itself in its user namespace, so a 700 directory of that uid stays
  // traversable to it: nothing is dropped to another uid before the workspace is bound.
  const parent = mkdtempSync(join(tmpdir(), 'box-real-700-'));
  chmodSync(parent, 0o700);
  const workspace = join(parent, 'runs', 'r1', 'work');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'in.txt'), 'from the host');
  const modelSocket = join(parent, 'model.sock');
  writeFileSync(modelSocket, '');
  const spec = { workspace, homes: {}, readOnly: [dirname(dirname(process.execPath)), BOX_FORWARD], modelSocket, modelPort: 8123, env: { PATH: '/usr/bin:/bin' } };
  try {
    assert.equal(statSync(parent).mode & 0o777, 0o700);
    const { out, said } = await inBox(spec, `cat /workspace/in.txt; echo; echo 'from the box' > /workspace/out.txt`);
    assert.match(out(), /^from the host$/m, `the box could not read its workspace under a 700 parent: ${said()}`);
    let written;
    try {
      written = readFileSync(join(workspace, 'out.txt'), 'utf8');
    } catch (error) {
      assert.fail(`the box's write did not reach the workspace under a 700 parent (${error.code}): ${said()}`);
    }
    assert.equal(written, 'from the box\n');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('a non-dumpable process inside the box is counted by its parent chain, and the reap ends it and counts the namespace empty', { skip }, async () => {
  const r = run('dumpable');
  // PR_SET_DUMPABLE (4) to 0: its /proc entries (ns/, environ) are this user's no more to read.
  const sleeper = `import ctypes, time; ctypes.CDLL(None).prctl(4, 0, 0, 0, 0); open('${join(r.workspace, 'ready')}', 'w').close(); time.sleep(600)`;
  try {
    const { box, boxed, record } = await inBox(r.spec, `python3 -c "${sleeper}" & wait`, { wait: false });
    let pid;
    for (let i = 0; i < 200 && pid === undefined; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      try {
        readFileSync(join(r.workspace, 'ready'));
        pid = Number(readFileSync(`/proc/${record.pid}/task/${record.pid}/children`, 'utf8').trim().split(/\s+/)[0]);
      } catch {
        // not yet
      }
    }
    assert.ok(pid, 'the non-dumpable process did not start');
    // It is non-dumpable indeed: its environment cannot be read from here.
    const descendants = [];
    const walk = (p) => {
      for (const c of readFileSync(`/proc/${p}/task/${p}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number)) {
        descendants.push(c);
        walk(c);
      }
    };
    walk(record.pid);
    const python = descendants.find((d) => readFileSync(`/proc/${d}/cmdline`, 'utf8').startsWith('python3'));
    assert.ok(python, 'no python3 under the box');
    assert.throws(() => readFileSync(`/proc/${python}/environ`), /EACCES|EPERM/, 'the process is readable: the test would prove nothing');
    assert.ok(countInPidns(record.pidns, { pid: record.pid, startTime: record.startTime }) >= 3, 'the box counts bwrap, its shell and the non-dumpable process');
    const reaped = await box.reap(record);
    assert.deepEqual(reaped, { empty: true, left: 0, by: 'pidns' });
    await boxed.exited;
  } finally {
    r.remove();
  }
});

test('the cgroup a box could run in here: whether this host delegates a cgroup v2 subtree to this user (measured, reported)', { skip }, (t) => {
  // Not a pass or fail of the box: the job records what its runner offers, so a cgroup-backed box is tested where it can be.
  let own = '?';
  try {
    own = readFileSync('/proc/self/cgroup', 'utf8').trim();
  } catch {
    // no cgroup file
  }
  const path = own.startsWith('0::') ? join('/sys/fs/cgroup', own.slice(3)) : undefined;
  let delegated = false;
  try {
    if (path) writeFileSync(join(path, 'cgroup.subtree_control'), readFileSync(join(path, 'cgroup.subtree_control'), 'utf8').trim());
    delegated = true;
  } catch {
    delegated = false;
  }
  t.diagnostic(`this process's cgroup: ${own}; a subtree delegated to uid ${process.getuid()}: ${delegated ? 'yes' : 'no'}`);
});
