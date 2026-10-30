// The box on a real bwrap (host/box-bwrap.ts): what a harness inside it can and cannot see, what its reap counts, and that
// its probe passes. These need a bwrap that can make a user namespace (on Ubuntu 24.04, after `agentrun-box install`):
// without one they skip, naming the probe's answer, unless AGENTRUN_BOX_REAL=1 (the CI job that installs it) makes them fail.
// The server's home is never bound into a box, so the job runs them with a HOME outside the checkout.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
  const spec = { session: dirname(workspace), workspace, homes: {}, readOnly: [dirname(dirname(process.execPath)), BOX_FORWARD], modelSocket, modelPort: 8123, env: { PATH: '/usr/bin:/bin' } };
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

test("nothing of the host leaks in: an environment variable of the server, a file beside the run, a file in the server user's real home and beside node's install, a host root nothing is bound under", { skip }, async (t) => {
  const r = run('canary');
  const beside = join(r.root, 'canary.txt'); // in the run's own directory, but not in its workspace
  writeFileSync(beside, 'host secret');
  // The server user's real home (not this job's HOME): a file there must not reach the box. It holds the box only as the
  // empty parents of what the box binds under it (the forwarder's file, when the checkout is there).
  const home = userInfo().homedir;
  const inHome = join(home, `.agentrun-box-canary-${process.pid}`);
  writeFileSync(inHome, 'host secret');
  // Beside node's install (bound read-only at its own path): its siblings stay the host's.
  // A canary there needs a node installed where this user may write (a tool cache); a root-owned prefix (/usr/local)
  // has none, and that canary is skipped by name: the listings below still hold.
  const nodePrefix = dirname(dirname(process.execPath));
  let besideNode = join(dirname(nodePrefix), `.agentrun-box-canary-${process.pid}`);
  try {
    writeFileSync(besideNode, 'host secret');
  } catch (error) {
    if (!['EACCES', 'EPERM', 'EROFS'].includes(error.code)) throw error;
    t.diagnostic(`no canary beside node's install: ${dirname(nodePrefix)} is not writable here (${error.code})`);
    besideNode = undefined;
  }
  const shown = [home, '/opt'];
  /** A host directory's first segment toward each path the box binds under it: what the box may show of it. */
  const bound = [r.spec.workspace, ...r.spec.readOnly];
  const firstUnder = (dir) => [...new Set(bound.filter((b) => b.startsWith(`${dir}/`)).map((b) => b.slice(dir.length + 1).split('/')[0]))].sort();
  process.env.AGENTRUN_BOX_CANARY = 'host secret';
  try {
    const { out, said } = await inBox(
      r.spec,
      `printf 'env=[%s]\\n' "$AGENTRUN_BOX_CANARY"; for f in ${[beside, inHome, besideNode].filter(Boolean).map((f) => `'${f}'`).join(' ')}; do if [ -e "$f" ]; then echo "seen=$f"; fi; done; ${shown.map((d, n) => `echo "ls${n}=[$(ls -A '${d}' 2>/dev/null | tr '\\n' ' ')]";`).join(' ')} echo "root=[$(ls -A / | tr '\\n' ' ')]"`,
    );
    assert.match(out(), /^env=\[\]$/m, `the server environment reached the box: ${said()}`);
    assert.doesNotMatch(out(), /^seen=/m, `a host file reached the box: ${said()}`);
    shown.forEach((dir, n) => {
      const listed = (new RegExp(`^ls${n}=\\[(.*)\\]$`, 'm').exec(out())?.[1] ?? '').trim().split(/\s+/).filter(Boolean).sort();
      assert.deepEqual(listed, firstUnder(dir), `the box shows more of ${dir} than the parents of what it binds: ${said()}`);
    });
    const root = (/^root=\[(.*)\]$/m.exec(out())?.[1] ?? '').trim().split(/\s+/);
    for (const host of ['home', 'root', 'srv', 'data', 'var', 'opt']) {
      if (root.includes(host)) assert.ok(bound.some((b) => b.startsWith(`/${host}/`)), `/${host} is in the box, and the box binds nothing under it: ${said()}`);
    }
  } finally {
    delete process.env.AGENTRUN_BOX_CANARY;
    rmSync(inHome, { force: true });
    if (besideNode) rmSync(besideNode, { force: true });
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

test('a read-only path given through a link is its target, seen at the path as given: the box reads the target\'s file there, and the link\'s own directory shows nothing else', { skip }, async () => {
  const r = run('link');
  const target = join(r.root, 'tools-1.2.3');
  mkdirSync(target);
  writeFileSync(join(target, 'tool.txt'), 'the target');
  const given = join(r.root, 'tools');
  symlinkSync(target, given);
  try {
    const { out, said } = await inBox({ ...r.spec, readOnly: [...r.spec.readOnly, given] }, `cat '${join(given, 'tool.txt')}'; echo; ls -A '${target}' 2>&1`);
    assert.match(out(), /^the target$/m, `the target's file at the given path: ${said()}`);
    assert.match(out(), /tools-1\.2\.3': No such file or directory/, `the target's own path is not bound: ${said()}`);
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
  const spec = { session: dirname(workspace), workspace, homes: {}, readOnly: [dirname(dirname(process.execPath)), BOX_FORWARD], modelSocket, modelPort: 8123, env: { PATH: '/usr/bin:/bin' } };
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
  // cgroup v2's one line: hierarchy id 0, no controller list, then the path.
  const [id, controllers, ...rest] = own.split(':');
  const path = id === '0' && controllers === '' ? join('/sys/fs/cgroup', rest.join(':')) : undefined;
  let delegated = false;
  try {
    if (path) writeFileSync(join(path, 'cgroup.subtree_control'), readFileSync(join(path, 'cgroup.subtree_control'), 'utf8').trim());
    delegated = true;
  } catch {
    delegated = false;
  }
  t.diagnostic(`this process's cgroup: ${own}; a subtree delegated to uid ${process.getuid()}: ${delegated ? 'yes' : 'no'}`);
});

// A cgroup-backed box (the shared-server mode): AGENTRUN_BOX_CGROUP_ROOT names a cgroup v2 subtree delegated to this user.
// Which case runs is read from this process's own cgroup: started inside the root, a box gets a cgroup under it; started
// outside, the start is refused by name.
const CGROUP_ROOT = process.env.AGENTRUN_BOX_CGROUP_ROOT;
const ownCgroup = (() => {
  try {
    for (const line of readFileSync('/proc/self/cgroup', 'utf8').split('\n')) {
      const [id, controllers, ...rest] = line.split(':');
      if (id === '0' && controllers === '') return resolve('/sys/fs/cgroup', `.${rest.join(':')}`);
    }
  } catch {
    // unreadable
  }
  return undefined;
})();
const inside = CGROUP_ROOT !== undefined && ownCgroup !== undefined && (ownCgroup === CGROUP_ROOT || ownCgroup.startsWith(`${CGROUP_ROOT}/`));
const cgroupSkip = (want) => skip || (CGROUP_ROOT === undefined ? 'no delegated cgroup root given (AGENTRUN_BOX_CGROUP_ROOT)' : inside === want ? false : `this process (${ownCgroup}) is ${inside ? 'inside' : 'outside'} ${CGROUP_ROOT}`);

test('started inside the delegated root, a box runs in a cgroup of its own under it, and its reap ends it and answers by the cgroup', { skip: cgroupSkip(true) }, async () => {
  const r = run('cgroup');
  const cgroup = join(CGROUP_ROOT, `box-real-${process.pid}`);
  try {
    const box = bwrapBox({ cgroupRoot: CGROUP_ROOT, reapMs: 5000 });
    const boxed = box.start({ ...r.spec, cgroup }, forwardChild({ command: '/bin/sh', args: ['-c', 'echo ready > /workspace/ready; exec sleep 600'] }, boxListens(r.spec)), { ahead() {}, async started() {} });
    const record = await boxed.ready;
    for (let i = 0; i < 200 && !existsSync(join(r.workspace, 'ready')); i++) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(existsSync(join(r.workspace, 'ready')), `the boxed command did not start: ${boxed.stderrTail()}`);
    assert.match(readFileSync(join(cgroup, 'cgroup.events'), 'utf8'), /^populated 1$/m, 'the box runs in its cgroup');
    assert.equal(record.cgroup, cgroup);
    assert.deepEqual(await box.reap(record), { empty: true, left: 0, by: 'cgroup' });
    await boxed.exited;
  } finally {
    r.remove();
  }
});

test('started outside the delegated root, a cgroup box is refused by name before anything is made: the server must start inside it', { skip: cgroupSkip(false) }, () => {
  const r = run('cgroup-out');
  const cgroup = join(CGROUP_ROOT, `box-real-${process.pid}-out`);
  try {
    assert.throws(
      () => bwrapBox({ cgroupRoot: CGROUP_ROOT }).start({ ...r.spec, cgroup }, forwardChild({ command: '/bin/true', args: [] }, boxListens(r.spec)), { ahead: () => assert.fail('recorded'), async started() {} }),
      (e) => e.code === 'box_refused' && /is not under the delegated root .*start the server inside its delegated subtree/.test(e.message),
    );
    assert.equal(existsSync(cgroup), false, 'a cgroup was made');
  } finally {
    r.remove();
  }
});
