// ./host's parent watch (parent-death.ts): a child started as a session machine starts it, detached in its own process
// group, dies with the process that started it. The host here is a node process (fixtures/parent-host.mjs) that is
// SIGKILLed, so it runs no close; its child ignores the end of its stdin, as the pinned Claude Agent CLI does. The
// process tree is read from /proc, so the behaviour tests run on Linux.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PARENT_WATCH_SHIM, parentWatched, parentWatchHere, SETPRIV } from '@parcha/agentrun-adapters/host';

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
async function host(t, how, { workers = 0, endWorker = false, spawner = 'main' } = {}) {
  const proc = spawn(process.execPath, [HOST, how, String(workers), endWorker ? 'yes' : 'no', JSON.stringify(STUBBORN), spawner], { stdio: ['ignore', 'pipe', 'inherit'] });
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
  assert.deepEqual(parentWatched(child, 'pdeathsig'), { command: SETPRIV, args: ['--pdeathsig', 'KILL', '--', '/pinned/cli', '--x', 'y'] });
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

test('the parent-death signal follows the thread that spawned the child, the event loop\'s: a worker thread ending does not end it, the host dying does', { skip: !pdeathsig && 'no setpriv with --pdeathsig here', timeout: 30_000 }, async (t) => {
  const h = await host(t, 'pdeathsig', { workers: 2, endWorker: true });
  assert.deepEqual(await h.next(), { worker: 'exited' });
  const tree = await h.settle();
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(tree.length === 1 && tree.every(alive), 'the child outlives the worker thread');
  h.proc.kill('SIGKILL');
  assert.deepEqual(await gone(tree, 2_000), []);
});

test('a worker thread is refused the parent-death signal by name, as its child would die when that worker ends, and spawns nothing; the shim it may use outlives the worker and dies with the host', { skip: !linux && 'needs /proc', timeout: 30_000 }, async (t) => {
  for (const how of ['pdeathsig', ...(pdeathsig ? ['default'] : [])]) {
    const h = await host(t, how, { spawner: 'worker' });
    assert.deepEqual(h.first, { refused: 'PdeathsigOffMainThread' }, `${how}, asked for in a worker thread`);
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(descendants(h.proc.pid), [], `${how}: nothing was spawned`);
  }
  const h = await host(t, 'shim', { spawner: 'worker', endWorker: true });
  assert.ok(Number.isSafeInteger(h.first.child), 'the shim is spawned from the worker thread');
  assert.deepEqual(await h.next(), { worker: 'exited' });
  const tree = await h.settle();
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(tree.length === 2 && tree.every(alive), `the shim and its child outlive the worker thread: ${tree}`);
  h.proc.kill('SIGKILL');
  assert.deepEqual(await gone(tree, 2_000), [], `still running 2 s after the host died: ${tree.filter(alive)}`);
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
