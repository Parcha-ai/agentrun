// The local session machine every harness adapter runs on (host/machine.ts), on its own: the environment allowlist, the
// git ceiling, the host's confinement, the process group ended whole, the private directories and the tail. Each adapter
// suite covers the same machine through its own harness; this one holds the shared code where it lives.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { childEnv, confined, INHERITED_ENV, openLocalMachine, processAlive } from '@parcha/agentrun-kernel/host';

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
