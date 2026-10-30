// The local session machine every harness adapter runs on (host/machine.ts), on its own: the environment allowlist, the
// git ceiling, the host's confinement, the process group ended whole, the private directories and the tail. Each adapter
// suite covers the same machine through its own harness; this one holds the shared code where it lives.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { BOX_EGRESS_SOCKET, BOX_MODEL_SOCKET, childEnv, confined, INHERITED_ENV, openLocalMachine, processAlive, startChild } from '@parcha/agentrun-kernel/host';

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
    // On this host there is no box network: the harness runs as itself, past the forwarder's own arguments.
    const harness = child.args.slice(child.args.indexOf('--') + 1);
    const proc = startChild({ command: harness[0], args: harness.slice(1), env: spec.env }, {}, spec.workspace);
    box.order.push('spawn');
    const full = { ...record, pid: proc.child.pid, startTime: '2', pidns: 'pid:[1]' };
    const ready = recorder.started(full).then(() => full);
    return { ...proc, record, ready };
  };
  box.reap = async (record) => { box.reaped.push(record.id); return reap(record); };
  return box;
}
const recorder = (log = []) => ({ log, ahead: (r) => log.push(['ahead', r.id]), started: async (r) => { log.push(['started', r.id]); } });
const boxOf = (box, extra = {}) => ({ box, recorder: recorder(), readOnly: ['/opt/cli'], modelPort: 4100, ...extra });
const FORWARD = fileURLToPath(new URL('../dist/host/box-forward.js', import.meta.url));

test("in a box, a child starts through the host's Box with the session's directories, its allowlisted environment and the git ceiling", async (t) => {
  const dir = scratch();
  const box = fakeBox();
  const machine = await machineAt(t, dir, { box: boxOf(box) });
  assert.deepEqual(machine.isolation, { mode: 'bwrap', cgroup: false });
  const proc = machine.start({ command: process.execPath, args: ['-e', '0'], env: { HOME: machine.dirs.home } });
  await proc.exited;
  const [{ spec, child }] = box.specs;
  assert.deepEqual(child, { command: process.execPath, args: [FORWARD, '--listen', `4100=${BOX_MODEL_SOCKET}`, '--', process.execPath, '-e', '0'] }, "the box's first command is the forwarder, then the harness");
  assert.equal(spec.workspace, machine.root);
  assert.deepEqual(spec.homes, { home: machine.dirs.home, tmp: machine.dirs.tmp });
  assert.deepEqual(spec.env, { PATH: process.env.PATH, LANG: 'C.UTF-8', HOME: machine.dirs.home, GIT_CEILING_DIRECTORIES: dir });
  assert.equal(spec.env.SECRET_KEY, undefined, 'nothing outside the allowlist reaches the box');
  assert.deepEqual([spec.readOnly, spec.modelPort], [['/opt/cli', process.execPath, FORWARD], 4100]);
  // The sockets are local and short: under the OS's temp directory, never in the session's (possibly shared) directory.
  assert.ok(spec.modelSocket.startsWith(tmpdir()) && spec.modelSocket.endsWith('/model.sock') && Buffer.byteLength(spec.modelSocket) < 108, spec.modelSocket);
  assert.equal(statSync(dirname(spec.modelSocket)).mode & 0o777, 0o700);
  assert.equal(spec.egressSocket, undefined, 'no egress was given: the box reaches nothing but the model');
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

test("the session's last box is reaped before anything starts, in every mode, and one not counted empty fails the open", async (t) => {
  const previous = { id: 'old', pid: 4242, startTime: '9', pidns: 'pid:[9]', writer: { pid: 1, startTime: '1' } };
  const reaper = (verdict) => { const r = { reaped: [] }; r.reap = async (record) => { r.reaped.push(record.id); return verdict; }; return r; };
  const empty = { empty: true, left: 0, by: 'pidns' };
  const held = { empty: false, left: 1, by: 'cgroup' };
  const down = fakeBox({ isolation: { mode: 'unavailable', error: 'bwrap_userns_denied', detail: 'x' } });
  // Each mode this open may be in, after a boxed one: boxed again, unsandboxed, an unavailable box, no box at all.
  for (const [mode, extra] of [['boxed', { box: boxOf(fakeBox()) }], ['unsandboxed', { box: 'unsandboxed' }], ['unavailable', { box: boxOf(down) }], ['no box', {}]]) {
    const ok = reaper(empty);
    const machine = await machineAt(t, scratch(), { ...extra, previousBox: { record: previous, reap: ok.reap } });
    assert.deepEqual(ok.reaped, ['old'], `${mode}: the old box is reaped at open`);
    await machine.start({ command: '/bin/true' }).exited;
    const stuck = reaper(held);
    await assert.rejects(openLocalMachine({ name: 'agentrun-test', dir: scratch(), dirs: [], sessionId: 's', from: {}, proxy: { policy, hooks: { beforeRequest: async () => {}, afterRequest: async () => {} }, model: 'm', origin: 'https://provider.invalid', credential: () => 'c' }, ...extra, previousBox: { record: previous, reap: stuck.reap } }), (error) => error.code === 'box_not_empty' && error.left === 1, `${mode}: a last box not counted empty fails the open`);
  }
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

/** A box whose `started` record arrives when the test says: `late` waits for the child to have exited first. */
function slowBox({ late = false, startedFails = false } = {}) {
  const box = { isolation: { mode: 'bwrap', cgroup: false }, reaped: [], started: [], made: 0 };
  box.start = (spec, child, recorder) => {
    const record = { id: `box-${++box.made}`, writer: { pid: process.pid, startTime: '1' } };
    recorder.ahead(record);
    const harness = child.args.slice(child.args.indexOf('--') + 1);
    const proc = startChild({ command: harness[0], args: harness.slice(1), env: spec.env }, {}, spec.workspace);
    const full = { ...record, pid: proc.child.pid, startTime: '2', pidns: 'pid:[1]' };
    const record2 = () => recorder.started(full).then(() => { box.started.push(full.id); return full; });
    // A box that is never let go is killed, as bwrap's pid 1 is.
    // Late: the record comes after the child exited and its box was ended, as a slow write would.
    const ready = (late ? proc.exited.then(() => new Promise((resolve) => setTimeout(resolve, 50))).then(record2) : record2()).catch((error) => { proc.kill('SIGKILL'); throw error; });
    ready.catch(() => {});
    return { ...proc, record, ready };
  };
  box.reap = async (record) => { box.reaped.push(record.id); return { empty: true, left: 0, by: 'pidns' }; };
  return box;
}
const settled = async (box, n = 1) => { for (let i = 0; i < 200 && box.reaped.length < n; i++) await new Promise((resolve) => setTimeout(resolve, 10)); await new Promise((resolve) => setImmediate(resolve)); };

test("a box whose started record fails is never let go: it is reaped, and the session's next box waits for that reap", async (t) => {
  const box = slowBox();
  const log = [];
  const failing = { ahead: (r) => log.push(['ahead', r.id]), started: async () => { throw new Error('the disk is full'); } };
  const machine = await machineAt(t, scratch(), { box: { ...boxOf(box), recorder: failing } });
  const proc = machine.start({ command: '/bin/sh', args: ['-c', 'sleep 300'] });
  assert.throws(() => machine.start({ command: '/bin/true' }), (error) => error.code === 'box_busy', 'nothing else starts while the box is not let go');
  await assert.rejects(proc.ready, /the disk is full/);
  await settled(box);
  assert.deepEqual(box.reaped, ['box-1'], 'the box is reaped, by its ahead record');
  assert.deepEqual(box.started, [], 'nothing recorded it as started');
  await machine.start({ command: '/bin/true' }).exited;
});

test("a started record that arrives after the box ended is refused, never written: the box is reaped once, by its ahead record", async (t) => {
  const box = slowBox({ late: true });
  const log = [];
  const machine = await machineAt(t, scratch(), { box: { ...boxOf(box), recorder: recorder(log) } });
  const proc = machine.start({ command: '/bin/true' });
  await assert.rejects(proc.ready, (error) => error.code === 'box_record_failed');
  await settled(box);
  assert.deepEqual(box.reaped, ['box-1']);
  assert.deepEqual(log, [['ahead', 'box-1']], 'the late started record never reached the recorder');
  const next = machine.start({ command: '/bin/true' });
  await next.exited;
  await settled(box, 2);
  assert.deepEqual(box.reaped, ['box-1', 'box-2'], "the next box keeps its own record, the late one never replaced it");
});


test("in a box, the model front's only door is the session's socket, 0600, and the harness sees it at the box's port; close removes it", async (t) => {
  const dir = scratch();
  const run = join(scratch(), 'run');
  const machine = await machineAt(t, dir, { box: boxOf(fakeBox(), { runtimeDir: run }) });
  const socket = join(run, 'model.sock');
  assert.ok(lstatSync(socket).isSocket(), 'the front listens on the session socket');
  assert.equal(statSync(socket).mode & 0o777, 0o600);
  assert.equal(machine.modelUrl, 'http://127.0.0.1:4100', "the harness's view: the port the box serves the front on");
  await machine.close();
  assert.equal(existsSync(socket), false, 'nothing reaches a closed front by its path');
  assert.equal(existsSync(run), false, "the session's socket directory goes with it");
});

test('one egress proxy per session: started on the session socket before any box, shared by its boxes, closed with it, and named in the box', async (t) => {
  const dir = scratch();
  const box = fakeBox();
  const egress = { port: 4101, starts: [], closed: 0 };
  egress.start = async (path) => { egress.starts.push(path); return { close: async () => { egress.closed += 1; } }; };
  const run = join(scratch(), 'run');
  const machine = await machineAt(t, dir, { box: boxOf(box, { egress, runtimeDir: run }) });
  assert.deepEqual(egress.starts, [join(run, 'egress.sock')], 'started at open, at the session socket');
  await machine.start({ command: '/bin/true' }).exited;
  for (let i = 0; i < 100 && box.reaped.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  await new Promise((resolve) => setImmediate(resolve));
  await machine.start({ command: '/bin/true' }).exited;
  assert.equal(egress.starts.length, 1, "the session's boxes share its proxy");
  const { spec, child } = box.specs[1];
  assert.deepEqual([spec.egressSocket, spec.egressPort], [join(run, 'egress.sock'), 4101]);
  assert.deepEqual(child.args.slice(1, 6), ['--listen', `4100=${BOX_MODEL_SOCKET}`, '--listen', `4101=${BOX_EGRESS_SOCKET}`, '--']);
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) assert.equal(spec.env[name], 'http://127.0.0.1:4101', name);
  for (const name of ['ALL_PROXY', 'all_proxy']) assert.equal(spec.env[name], 'socks5h://127.0.0.1:4101', name);
  assert.deepEqual([spec.env.NO_PROXY, spec.env.no_proxy, spec.env.NODE_USE_ENV_PROXY], ['127.0.0.1,localhost', '127.0.0.1,localhost', '1']);
  for (let i = 0; i < 100 && box.reaped.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  await machine.close();
  assert.equal(egress.closed, 1, 'closed with the session, after its last box');
});

test('an egress proxy that cannot start fails the open, and leaves no model front behind', async () => {
  const dir = scratch();
  const egress = { port: 4101, start: async () => { throw new Error('egress: a live listener is there'); } };
  await assert.rejects(openLocalMachine({ name: 'agentrun-test', dir, dirs: [], sessionId: 's', from: {}, proxy: { policy, hooks: { beforeRequest: async () => {}, afterRequest: async () => {} }, model: 'm', origin: 'https://provider.invalid', credential: () => 'c' }, box: boxOf(fakeBox(), { egress, runtimeDir: join(dir, 'run') }) }), /a live listener is there/);
  assert.equal(existsSync(join(dir, 'run', 'model.sock')), false);
});

test("a session socket a dead machine left is replaced; a live one is another machine's, and the open is refused by name", async (t) => {
  const dir = scratch();
  const run = join(scratch(), 'run');
  mkdirSync(run, { recursive: true, mode: 0o700 });
  // A dead machine's socket: a listener in a process killed outright, which leaves the file and nothing behind it.
  const path = join(run, 'model.sock');
  const holder = spawn(process.execPath, ['-e', `require('node:net').createServer().listen(${JSON.stringify(path)}, () => console.log('up'))`], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve) => holder.stdout.once('data', resolve));
  holder.kill('SIGKILL');
  await new Promise((resolve) => holder.once('exit', resolve));
  assert.ok(lstatSync(path).isSocket(), 'the dead socket is there');
  const machine = await machineAt(t, dir, { box: boxOf(fakeBox(), { runtimeDir: run }) });
  assert.equal(machine.modelUrl, 'http://127.0.0.1:4100', 'the dead socket was replaced');
  // A live one: this machine's own front. A second machine in the same directory is refused, and the first still serves.
  await assert.rejects(openLocalMachine({ name: 'agentrun-test', dir, dirs: [], sessionId: 's2', from: {}, proxy: { policy, hooks: { beforeRequest: async () => {}, afterRequest: async () => {} }, model: 'm', origin: 'https://provider.invalid', credential: () => 'c' }, box: boxOf(fakeBox(), { runtimeDir: run }) }), /^Error: agentrun-kernel: the model proxy: a live listener is at .*model\.sock: it is not taken over$/);
  assert.ok(lstatSync(path).isSocket(), "the first machine's socket is untouched");
});

test("a socket directory that is not this user's own, 0700, is refused before any socket is made", async () => {
  const run = join(scratch(), 'open');
  mkdirSync(run, { recursive: true });
  chmodSync(run, 0o755);
  await assert.rejects(openLocalMachine({ name: 'agentrun-test', dir: scratch(), dirs: [], sessionId: 's', from: {}, proxy: { policy, hooks: { beforeRequest: async () => {}, afterRequest: async () => {} }, model: 'm', origin: 'https://provider.invalid', credential: () => 'c' }, box: boxOf(fakeBox(), { runtimeDir: run }) }), /^Error: agentrun-test: the session's socket directory .* must be this user's own, 0700, and not a link$/);
  assert.equal(existsSync(join(run, 'model.sock')), false);
});

test("the session's socket directory on FUSE or a filesystem shared between hosts is refused by name, before any socket", { skip: process.platform !== 'linux' && 'the check is Linux only' }, async () => {
  // The machine module's own seam (dist/host/machine.js), not the package's exports: no host can pass it.
  const { socketDir } = await import('../dist/host/machine.js');
  const dir = join(scratch(), 'run');
  for (const [type, kind] of [[0x65735546, 'fuse'], [0x6969, 'nfs'], [0xff534d42, 'cifs'], [0xfe534d42, 'smb2'], [0x517b, 'smb'], [0x01021997, '9p'], [0x00c36400, 'ceph']]) {
    assert.throws(() => socketDir(dir, 'agentrun-test', () => ({ type })), new RegExp(`^Error: agentrun-test: runtime_dir_not_local: the session's socket directory .* is on ${kind}, not a local filesystem$`), kind);
  }
  assert.equal(socketDir(dir, 'agentrun-test', () => ({ type: 0xef53 })), dir, 'a local filesystem (ext4) is taken');
  assert.equal(socketDir(dir, 'agentrun-test', () => ({ type: 0x01021994 })), dir, 'tmpfs is taken');
});

test("an abort kills a boxed child: it exits, its box is reaped, and only then does the session's next box start", async (t) => {
  const box = fakeBox();
  const machine = await machineAt(t, scratch(), { box: boxOf(box) });
  const abort = new AbortController();
  const proc = machine.start({ command: '/bin/sh', args: ['-c', 'exec sleep 300'], signal: abort.signal });
  assert.ok(alive(proc.child.pid), 'the child runs');
  abort.abort();
  const exited = await Promise.race([proc.exited.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 5_000))]);
  assert.ok(exited, 'the abort killed the child');
  for (let i = 0; i < 200 && box.reaped.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(box.reaped, ['box-1'], 'its box is reaped');
  await new Promise((resolve) => setImmediate(resolve));
  await machine.start({ command: '/bin/true' }).exited;
});
