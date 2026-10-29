// ./host's parent watch (parent-death.ts): a child started as a session machine starts it, detached in its own process
// group, dies with the process that started it. The host here is a node process (fixtures/parent-host.mjs) that is
// SIGKILLed, so it runs no close; its child ignores the end of its stdin, as the pinned Claude Agent CLI does. The
// process tree is read from /proc, so the behaviour tests run on Linux.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PARENT_CHECK, PARENT_CHECK_FAILED, PARENT_WATCH_SHIM, parentWatched, parentWatchHere, SETPRIV } from '@parcha/agentrun-adapters/host';

const HOST = fileURLToPath(new URL('./fixtures/parent-host.mjs', import.meta.url));
const linux = process.platform === 'linux' && existsSync('/proc/self/stat');
const pdeathsig = linux && parentWatchHere() === 'pdeathsig';
/** A child that outlives the end of its stdin, as the pinned CLI does. */
const STUBBORN = ['-e', 'process.stdin.resume(); process.stdin.on("end", () => {}); setInterval(() => {}, 1000);'];

/** Whether `pid` runs: a zombie (exited, not yet reaped) does not. */
function alive(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
  } catch {
    return false;
  }
}

/** Every process under `root`, read from /proc. */
function descendants(root) {
  const children = new Map();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid).push(Number(name));
    } catch {}
  }
  const out = [];
  const walk = (pid) => { for (const c of children.get(pid) ?? []) { out.push(c); walk(c); } };
  walk(root);
  return out;
}

/** Start the host with `how`; resolves with the host, its first report, and a reader for the next ones. */
async function host(t, how, { workers = 0, endWorker = false, hold, child = STUBBORN } = {}) {
  const proc = spawn(process.execPath, [HOST, how, String(workers), endWorker ? 'yes' : 'no', JSON.stringify(child), ...(hold ? [hold] : [])], { stdio: ['ignore', 'pipe', 'inherit'] });
  const lines = createInterface({ input: proc.stdout })[Symbol.asyncIterator]();
  const next = async () => JSON.parse((await lines.next()).value);
  const first = await next();
  // Whatever happens, nothing this test started outlives it: every process under the host, by its exact pid.
  let tree = [];
  t.after(() => { for (const pid of [proc.pid, ...tree]) if (alive(pid)) try { process.kill(pid, 'SIGKILL'); } catch {} });
  const settle = async () => {
    // The shim's own child appears a moment after the shim.
    for (let i = 0; i < 100 && descendants(proc.pid).length < (how === 'shim' ? 2 : 1); i++) await new Promise((r) => setTimeout(r, 20));
    tree = descendants(proc.pid);
    return tree;
  };
  return { proc, first, next, settle };
}

/** Wait until none of `pids` runs, or `ms` passes; the ones still running. */
async function gone(pids, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 25))) if (!pids.some(alive)) return [];
  return pids.filter(alive);
}

test('the watch goes in front of the child: setpriv sets the parent-death signal, or the shim watches this process', () => {
  const child = { command: '/pinned/cli', args: ['--x', 'y'] };
  assert.deepEqual(parentWatched(child, 'pdeathsig'), { command: SETPRIV, args: ['--pdeathsig', 'KILL', '--', process.execPath, PARENT_CHECK, String(process.pid), '--', '/pinned/cli', '--x', 'y'] });
  assert.deepEqual(parentWatched(child, 'shim'), { command: process.execPath, args: [PARENT_WATCH_SHIM, String(process.pid), '--', '/pinned/cli', '--x', 'y'] });
  assert.ok(existsSync(PARENT_WATCH_SHIM), 'the shim ships beside it');
  // What this machine's setpriv can do, read here apart from parentWatchHere: an older one lacks --pdeathsig.
  const canPdeathsig = linux && existsSync(SETPRIV) && execFileSync(SETPRIV, ['--help'], { encoding: 'utf8' }).includes('--pdeathsig');
  assert.equal(parentWatchHere(), canPdeathsig ? 'pdeathsig' : 'shim', 'a setpriv with --pdeathsig uses the kernel; any other machine, the shim');
});

for (const how of ['pdeathsig', 'shim']) {
  test(`a SIGKILLed host leaves no child behind (${how}), though the child outlives the end of its stdin`, { skip: !linux ? 'needs /proc' : how === 'pdeathsig' && !pdeathsig && 'no setpriv with --pdeathsig here', timeout: 30_000 }, async (t) => {
    const h = await host(t, how);
    const tree = await h.settle();
    assert.ok(tree.length >= 1 && tree.every(alive), `the child runs: ${tree}`);
    h.proc.kill('SIGKILL');
    assert.deepEqual(await gone(tree, 2_000), [], `still running 2 s after the host died: ${tree.filter(alive)}`);
  });
}

test('a host that dies before the watch is set leaves no child either: the watched command checks its parent after setting the signal, and runs nothing for one that is gone', { skip: !pdeathsig && 'no setpriv with --pdeathsig here', timeout: 30_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'parent-check-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fifo = join(dir, 'hold');
  const ran = join(dir, 'ran');
  execFileSync('mkfifo', [fifo]);
  // The child marks that it ran, then outlives the end of its stdin as the CLI does.
  const h = await host(t, 'pdeathsig', { hold: fifo, child: ['-e', `require("fs").writeFileSync(${JSON.stringify(ran)}, "ran"); ${STUBBORN[1]}`] });
  const pid = h.first.child;
  t.after(() => { if (alive(pid)) try { process.kill(pid, 'SIGKILL'); } catch {} });
  assert.ok(alive(pid), 'the held command runs, before setpriv');
  // The host dies while its child waits in front of the watch: the signal is set only after this.
  const closed = new Promise((resolve) => h.proc.once('close', resolve));
  h.proc.kill('SIGKILL');
  await closed;
  writeFileSync(fifo, 'go\n');
  assert.deepEqual(await gone([pid], 2_000), [], `the command still runs 2 s after its host died before the watch: pid ${pid}`);
  assert.equal(existsSync(ran), false, 'the child never ran');
});

test('a confinement prefix that forks instead of exec\'ing in place fails the parent check in words: exit 125 and a line that says why, never a silent exit', { skip: !pdeathsig && 'no setpriv with --pdeathsig here', timeout: 30_000 }, async (t) => {
  const h = await host(t, 'pdeathsig', { hold: 'fork' });
  const wrapper = h.first.child;
  t.after(() => { if (alive(wrapper)) try { process.kill(wrapper, 'SIGKILL'); } catch {} });
  const ended = await h.next();
  assert.equal(ended.exit, PARENT_CHECK_FAILED, `the exit code: ${JSON.stringify(ended)}`);
  assert.equal(ended.stderr.trim(), `agentrun: parent check failed: started by ${wrapper}, expected ${h.proc.pid} (the host died during startup, or the confine prefix does not exec in place)`);
});

test('the parent check replaces itself with the child and passes its environment on byte for byte, saying nothing', { skip: !linux && 'needs /proc', timeout: 30_000 }, () => {
  // This process is the check's parent, so the check passes; the child prints the environment it was given.
  const env = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', SESSION_KEY: 'a b=c', EMPTY: '' };
  const out = spawnSync(process.execPath, [PARENT_CHECK, String(process.pid), '--', 'env'], { env, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stderr, '', 'nothing on stderr: no warning from the check');
  assert.deepEqual(out.stdout.trimEnd().split('\n').sort(), Object.entries(env).map(([k, v]) => `${k}=${v}`).sort(), 'the same names and values, none added');
});

test('a Node without process.execve fails the parent check loudly, and never runs the child some other way', { skip: !linux && 'needs /proc', timeout: 30_000 }, () => {
  const out = spawnSync(process.execPath, ['--import', 'data:text/javascript,process.execve = undefined;', PARENT_CHECK, String(process.pid), '--', 'touch', '/nonexistent-dir/ran'], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
  assert.equal(out.status, PARENT_CHECK_FAILED);
  assert.equal(out.stderr.trim(), `agentrun: parent check: this Node (${process.version}) has no process.execve; agentrun needs Node 22.15 or newer`);
});

test('the parent-death signal follows the thread that spawned the child, the event loop\'s: a worker thread ending does not end it, the host dying does', { skip: !pdeathsig && 'no setpriv with --pdeathsig here', timeout: 30_000 }, async (t) => {
  const h = await host(t, 'pdeathsig', { workers: 2, endWorker: true });
  assert.deepEqual(await h.next(), { worker: 'exited' });
  const tree = await h.settle();
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(tree.length === 1 && tree.every(alive), 'the child outlives the worker thread');
  h.proc.kill('SIGKILL');
  assert.deepEqual(await gone(tree, 2_000), []);
});

test('the shim runs its child with the same stdio, passes TERM on, and exits as the child exits', { skip: !linux && 'needs /proc', timeout: 30_000 }, async () => {
  const run = (args) => new Promise((resolve) => {
    const p = spawn(process.execPath, [PARENT_WATCH_SHIM, String(process.pid), '--', process.execPath, ...args], { stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    resolve({ p, out: () => out, done: new Promise((r) => p.on('close', (code, signal) => r({ code, signal }))) });
  });
  const echo = await run(['-e', 'process.stdin.pipe(process.stdout)']);
  echo.p.stdin.end('through');
  assert.deepEqual(await echo.done, { code: 0, signal: null });
  assert.equal(echo.out(), 'through');
  assert.deepEqual(await (await run(['-e', 'process.exit(7)'])).done, { code: 7, signal: null });
  const term = await run(['-e', 'setInterval(() => {}, 1000)']);
  await new Promise((r) => setTimeout(r, 300));
  term.p.kill('SIGTERM');
  assert.deepEqual(await term.done, { code: null, signal: 'SIGTERM' });
  // Started with a parent that is not its own: it runs nothing.
  const orphan = spawn(process.execPath, [PARENT_WATCH_SHIM, '1', '--', process.execPath, ...STUBBORN], { stdio: 'ignore' });
  assert.deepEqual(await new Promise((r) => orphan.on('close', (code, signal) => r({ code, signal }))), { code: 1, signal: null });
});
