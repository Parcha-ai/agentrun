// The local session machine every harness adapter runs on (host/machine.ts), on its own: the environment allowlist, the
// git ceiling, the host's confinement, the process group ended whole, the private directories and the tail. Each adapter
// suite covers the same machine through its own harness; this one holds the shared code where it lives.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { childEnv, confined, INHERITED_ENV, openLocalMachine, processAlive, startChild } from '@parcha/agentrun-kernel/host';

const ROOT = mkdtempSync(join(tmpdir(), 'kernel-machine-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let n = 0;
const scratch = () => join(ROOT, `s${n++}`);

/** A provider's rules, for the tests: one route and a bearer key. No request is sent. */
const policy = {
  id: 'test',
  routes: [{ method: 'POST', path: '/v1/test' }],
  keyOf: (headers) => String(headers.authorization ?? '').replace(/^Bearer /, ''),
  authHeaders: (credential) => ({ authorization: `Bearer ${credential}` }),
  apply: (body) => body,
  usageOf: () => undefined,
};

async function machineAt(t, dir, extra = {}) {
  const machine = await openLocalMachine({
    name: 'agentrun-test', dir, dirs: ['home', 'tmp'], sessionId: 'session-1',
    from: { PATH: process.env.PATH, LANG: 'C.UTF-8', SECRET_KEY: 'never-inherited' },
    proxy: { policy, hooks: { beforeRequest: async () => {}, afterRequest: async () => {} }, model: 'm', origin: 'https://provider.invalid', credential: () => 'c' },
    ...extra,
  });
  t.after(() => machine.close());
  return machine;
}

async function output(proc) {
  let out = '';
  proc.child.stdout.setEncoding('utf8');
  proc.child.stdout.on('data', (chunk) => { out += chunk; });
  await proc.exited;
  return out;
}

// A zombie is gone: under a PID 1 that does not reap orphans, a killed grandchild stays one, and kill(pid, 0) still finds it.
const alive = processAlive;
async function gone(pid) {
  for (let i = 0; i < 100 && alive(pid); i++) await new Promise((resolve) => setTimeout(resolve, 30));
  return !alive(pid);
}

test("a child's environment is the allowlist and what the harness names, and its git stops at the session's directory", async (t) => {
  const dir = scratch();
  const machine = await machineAt(t, dir);
  const env = JSON.parse(await output(machine.start({ command: process.execPath, args: ['-e', 'process.stdout.write(JSON.stringify(process.env))'], env: { HOME: machine.dirs.home } })));
  assert.equal(env.SECRET_KEY, undefined, 'nothing outside the allowlist is inherited');
  assert.equal(env.LANG, 'C.UTF-8');
  assert.equal(env.HOME, machine.dirs.home);
  assert.equal(env.GIT_CEILING_DIRECTORIES, dir);
  assert.deepEqual(childEnv({ PATH: '/bin', OTHER: 'x' }, { HOME: '/h' }), { PATH: '/bin', HOME: '/h' });
});

test('the allowlist is exactly PATH, LANG and TZ: a home, a user or a provider key in this process never reaches a child', () => {
  assert.deepEqual([...INHERITED_ENV], ['PATH', 'LANG', 'TZ']);
  const from = { PATH: '/bin', LANG: 'C.UTF-8', TZ: 'UTC', HOME: '/root', USER: 'root', OPENAI_API_KEY: 'x', ANTHROPIC_API_KEY: 'y' };
  assert.deepEqual(childEnv(from), { PATH: '/bin', LANG: 'C.UTF-8', TZ: 'UTC' });
});

test('close() resolves only once its children have exited: none is alive the moment it returns', async (t) => {
  const machine = await machineAt(t, scratch());
  const proc = machine.start({ command: '/bin/sh', args: ['-c', 'sleep 300'] });
  assert.ok(alive(proc.child.pid), 'the child is running');
  let exited = false;
  void proc.exited.then(() => { exited = true; });
  await machine.close();
  assert.equal(alive(proc.child.pid), false, 'the child is gone when close() resolves, with no wait after it');
  // The pid alone cannot tell: a SIGKILLed child is gone (or a zombie) within moments. The machine's own record can: its
  // exit is already in when close() returns, which only a close that waited for it gives.
  await Promise.resolve();
  assert.equal(exited, true, "the child's exit was in before close() returned");
  assert.equal(proc.alive(), false);
});

test('close() ends a child and the grandchild it forked: the kill is the process group', async (t) => {
  const machine = await machineAt(t, scratch());
  const proc = machine.start({ command: '/bin/sh', args: ['-c', 'sleep 300 & echo $!; wait'] });
  proc.child.stdout.setEncoding('utf8');
  const grandchild = await new Promise((resolve) => proc.child.stdout.once('data', (line) => resolve(Number(String(line).trim()))));
  assert.ok(Number.isInteger(grandchild) && alive(grandchild), 'the grandchild is running');
  // Bounded: a grandchild the kill missed holds the child's stdout open, so close() would wait on it for ever.
  await Promise.race([machine.close(), new Promise((resolve) => setTimeout(resolve, 3_000))]);
  const left = await gone(grandchild);
  if (!left) process.kill(grandchild, 'SIGKILL');
  assert.ok(left, 'the grandchild outlived the machine');
  assert.throws(() => machine.start({ command: '/bin/true' }), /^Error: agentrun-test: the session machine is closed$/);
});

test("the host's confinement goes in front of the command, and one that changes the command is refused, under the adapter's name", () => {
  const child = { command: '/pinned/cli', args: ['--x', 'y'] };
  assert.deepEqual(confined(child, (c) => ({ command: '/usr/bin/setpriv', args: ['--no-new-privs', '--', c.command, ...c.args] }), 'agentrun-test'), { command: '/usr/bin/setpriv', args: ['--no-new-privs', '--', '/pinned/cli', '--x', 'y'] });
  for (const bad of [(c) => ({ command: '/bin/sh', args: ['-c', c.command] }), (c) => ({ command: c.command, args: c.args }), () => ({ command: 1, args: [] })]) {
    assert.throws(() => confined(child, bad, 'agentrun-test'), /^Error: agentrun-test: the host's confinement must start the child's own command/);
  }
});

test("files stay inside the machine's directories, and a tail reads no link put in a file's place", async (t) => {
  const machine = await machineAt(t, scratch());
  for (const path of ['../out', '/abs', '', 'a/../../out']) {
    await assert.rejects(machine.files.upload('home', [{ path, bytes: new Uint8Array() }]), /^Error: agentrun-test: /);
  }
  await machine.files.upload('home', [{ path: 'a/b.txt', bytes: new TextEncoder().encode('one\n') }]);
  const tail = await machine.tail('home', 'a/b.txt');
  assert.deepEqual(tail.read(), ['one']);
  writeFileSync(join(ROOT, 'elsewhere'), 'secret\n');
  symlinkSync(join(ROOT, 'elsewhere'), join(machine.dirs.home, 'link.txt'));
  const linked = await machine.tail('home', 'link.txt');
  assert.throws(() => linked.read(), /^Error: agentrun-test: link\.txt is a link$/);
});

test('a relative session directory is refused', async () => {
  await assert.rejects(openLocalMachine({ name: 'agentrun-test', dir: 'relative', dirs: [], sessionId: 's', from: {}, proxy: {} }), /^Error: agentrun-test: the session directory must be an absolute path$/);
});

/** A box for the tests: it records its spec, writes its record ahead and on start, and runs the child as itself. Its
 *  reap answers what the test says. */
function fakeBox({ isolation = { mode: 'bwrap', cgroup: false }, reap = async () => ({ empty: true, left: 0, by: 'pidns' }) } = {}) {
  const box = { isolation, specs: [], reaped: [], order: [] };
  box.start = (spec, child, recorder) => {
    box.specs.push({ spec, child });
    const record = { id: `box-${box.specs.length}`, writer: { pid: process.pid, startTime: '1' } };
    recorder.ahead(record);
    box.order.push('ahead');
    const proc = startChild({ command: child.command, args: child.args, env: spec.env }, {}, spec.workspace);
    box.order.push('spawn');
    const full = { ...record, pid: proc.child.pid, startTime: '2', pidns: 'pid:[1]' };
    const ready = recorder.started(full).then(() => full);
    return { ...proc, record, ready };
  };
  box.reap = async (record) => { box.reaped.push(record.id); return reap(record); };
  return box;
}
const recorder = (log = []) => ({ log, ahead: (r) => log.push(['ahead', r.id]), started: async (r) => { log.push(['started', r.id]); } });
const boxOf = (box, extra = {}) => ({ box, recorder: recorder(), readOnly: ['/opt/cli'], modelSocket: '/run/m.sock', modelPort: 4100, ...extra });

test("in a box, a child starts through the host's Box with the session's directories, its allowlisted environment and the git ceiling", async (t) => {
  const dir = scratch();
  const box = fakeBox();
  const machine = await machineAt(t, dir, { box: boxOf(box) });
  assert.deepEqual(machine.isolation, { mode: 'bwrap', cgroup: false });
  const proc = machine.start({ command: process.execPath, args: ['-e', '0'], env: { HOME: machine.dirs.home } });
  await proc.exited;
  const [{ spec, child }] = box.specs;
  assert.deepEqual(child, { command: process.execPath, args: ['-e', '0'] });
  assert.equal(spec.workspace, machine.root);
  assert.deepEqual(spec.homes, { home: machine.dirs.home, tmp: machine.dirs.tmp });
  assert.deepEqual(spec.env, { PATH: process.env.PATH, LANG: 'C.UTF-8', HOME: machine.dirs.home, GIT_CEILING_DIRECTORIES: dir });
  assert.equal(spec.env.SECRET_KEY, undefined, 'nothing outside the allowlist reaches the box');
  assert.deepEqual([spec.readOnly, spec.modelSocket, spec.modelPort], [['/opt/cli'], '/run/m.sock', 4100]);
  assert.deepEqual(box.order, ['ahead', 'spawn'], 'the record is written before the spawn');
});

test('one box at a time: a second start while the first is live is refused at once, by name; once its reap counts it empty, the next starts', async (t) => {
  const box = fakeBox();
  const machine = await machineAt(t, scratch(), { box: boxOf(box) });
  const first = machine.start({ command: '/bin/sh', args: ['-c', 'sleep 300'] });
  assert.throws(() => machine.start({ command: '/bin/true' }), (error) => error.name === 'BoxError' && error.code === 'box_busy');
  assert.equal(box.specs.length, 1, 'the refused start reached no box');
  first.kill();
  await first.exited;
  for (let i = 0; i < 100 && box.reaped.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(box.reaped, ['box-1'], "the box is reaped once its child exits");
  await new Promise((resolve) => setImmediate(resolve));
  const second = machine.start({ command: '/bin/true' });
  await second.exited;
  assert.equal(box.specs.length, 2);
});

test("a box whose reap finds a process left stops the session: no box starts after it, and close fails, naming it", async (t) => {
  const box = fakeBox({ reap: async () => ({ empty: false, left: 2, by: 'pidns' }) });
  const machine = await openLocalMachine({
    name: 'agentrun-test', dir: scratch(), dirs: ['home', 'tmp'], sessionId: 'session-1', from: { PATH: process.env.PATH },
    proxy: { policy, hooks: { beforeRequest: async () => {}, afterRequest: async () => {} }, model: 'm', origin: 'https://provider.invalid', credential: () => 'c' },
    box: boxOf(box),
  });
  await machine.start({ command: '/bin/true' }).exited;
  for (let i = 0; i < 100 && box.reaped.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  await new Promise((resolve) => setImmediate(resolve));
  assert.throws(() => machine.start({ command: '/bin/true' }), (error) => error.code === 'box_busy');
  await assert.rejects(machine.close(), (error) => error.code === 'box_not_empty' && error.left === 2);
});

test("the session's last box is reaped before anything starts, and one not counted empty fails the open", async (t) => {
  const box = fakeBox();
  const previous = { id: 'old', pid: 4242, startTime: '9', pidns: 'pid:[9]', writer: { pid: 1, startTime: '1' } };
  const machine = await machineAt(t, scratch(), { box: boxOf(box, { previous }) });
  assert.deepEqual(box.reaped, ['old'], 'the old box is reaped at open');
  await machine.start({ command: '/bin/true' }).exited;
  const stuck = fakeBox({ reap: async () => ({ empty: false, left: 1, by: 'pidns' }) });
  await assert.rejects(openLocalMachine({ name: 'agentrun-test', dir: scratch(), dirs: [], sessionId: 's', from: {}, proxy: {}, box: boxOf(stuck, { previous }) }), (error) => error.code === 'box_not_empty');
});

test("isolation says what the host gave: a box's own, unsandboxed only by the operator's word, and nothing for no box; an unavailable box boxes nothing", async (t) => {
  const plain = await machineAt(t, scratch());
  assert.equal(plain.isolation, undefined);
  const open = await machineAt(t, scratch(), { box: 'unsandboxed' });
  assert.deepEqual(open.isolation, { mode: 'unsandboxed' });
  const down = fakeBox({ isolation: { mode: 'unavailable', error: 'bwrap_userns_denied', detail: 'setting up uid map: Permission denied' } });
  const machine = await machineAt(t, scratch(), { box: boxOf(down) });
  assert.equal(machine.isolation.error, 'bwrap_userns_denied');
  await machine.start({ command: '/bin/true' }).exited;
  assert.equal(down.specs.length, 0, 'an unavailable box starts nothing; the child runs as it would with none');
});

test("a child in a box runs in the session's working directory: another is refused before any box starts", async (t) => {
  const box = fakeBox();
  const machine = await machineAt(t, scratch(), { box: boxOf(box) });
  assert.throws(() => machine.start({ command: '/bin/true', cwd: '/tmp' }), /^Error: agentrun-test: a child in a box runs in the session's working directory, not \/tmp$/);
  assert.equal(box.specs.length, 0);
  await machine.start({ command: '/bin/true', cwd: machine.root }).exited;
});
