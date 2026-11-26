// ./host's parent watch (parent-death.ts): a child started as a session machine starts it, detached in its own process
// group, dies with the process that started it. The host here is a node process (fixtures/parent-host.mjs) that is
// SIGKILLed, so it runs no close; its child ignores the end of its stdin, as the pinned Claude Agent CLI does. The
// process tree is read from /proc, so the behaviour tests run on Linux.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PARENT_WATCH_SHIM, parentWatched, parentWatchHere, SETPRIV } from '@parcha/agentrun-kernel/host';

const HOST = fileURLToPath(new URL('./fixtures/parent-host.mjs', import.meta.url));
const SPAWN_HELD = fileURLToPath(new URL('./fixtures/spawn-held.mjs', import.meta.url));
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
async function host(t, how, { workers = 0, endWorker = false } = {}) {
  const proc = spawn(process.execPath, [HOST, how, String(workers), endWorker ? 'yes' : 'no', JSON.stringify(STUBBORN)], { stdio: ['ignore', 'pipe', 'inherit'] });
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
  // A grace asked for reaches the shim before `--`; setpriv execs the child in place, so it has no use for one.
  assert.deepEqual(parentWatched(child, 'shim', { termGraceMs: 2_000 }), { command: process.execPath, args: [PARENT_WATCH_SHIM, String(process.pid), '--term-grace', '2000', '--', '/pinned/cli', '--x', 'y'] });
  assert.deepEqual(parentWatched(child, 'pdeathsig', { termGraceMs: 2_000 }), parentWatched(child, 'pdeathsig'));
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

// A host that ends a child under the shim sends the shim TERM, then SIGKILL after a wait of its own (the sign-in's 5 s).
// That SIGKILL reaches the shim alone: a child still running then would outlive it with no watch while its host lives.
// So such a host asks for a grace (`termGraceMs`, here 2 s), and the shim kills a child that outlasts a TERM it passed
// on, that long later.
test('the shim kills a child that outlasts a TERM it passed on, a grace later, while its host still runs, and ends as it did', { skip: !linux && 'needs /proc', timeout: 30_000 }, async (t) => {
  const watched = parentWatched({ command: process.execPath, args: ['-e', 'process.on("SIGTERM", () => {}); process.stdout.write(String(process.pid)); setInterval(() => {}, 1000);'] }, 'shim', { termGraceMs: 2_000 });
  const shim = spawn(watched.command, watched.args, { stdio: ['ignore', 'pipe', 'inherit'] });
  let child;
  t.after(() => { for (const pid of [shim.pid, child]) if (pid && alive(pid)) try { process.kill(pid, 'SIGKILL'); } catch {} });
  // Its pid is written once its TERM handler is on.
  child = Number(await new Promise((resolve) => shim.stdout.once('data', (d) => resolve(String(d)))));
  assert.ok(alive(child), 'the child runs');
  const closed = new Promise((resolve) => shim.on('close', (code, signal) => resolve({ code, signal })));
  const asked = Date.now();
  shim.kill('SIGTERM');
  let timer;
  const ended = await Promise.race([closed, new Promise((resolve) => { timer = setTimeout(() => resolve('still running'), 4_000); })]);
  clearTimeout(timer);
  assert.notEqual(ended, 'still running', `the shim and its child (pid ${child}) still ran 4 s after the shim passed a TERM on`);
  assert.ok(Date.now() - asked >= 1_500, `the child had its grace to go: killed ${Date.now() - asked} ms after the TERM`);
  assert.deepEqual(ended, { code: null, signal: 'SIGKILL' }, 'the shim ends as its child did');
  assert.equal(alive(child), false, 'the child is gone');
});

// A host may end its child the moment the shim has started it (a sign-in stopped as it opens): the shim takes TERM,
// INT and HUP as its own before its child exists, so a TERM there is passed on (and the grace kept), never the end of
// the shim alone with its child left running and no watch. The shim here is held right after its spawn returns
// (fixtures/spawn-held.mjs) while the TERM reaches it.
test('the shim passes on a TERM that reaches it the moment its child has started: it never ends alone, leaving the child running', { skip: !linux && 'needs /proc', timeout: 30_000 }, async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'agentrun-shim-held-'));
  const gate = join(dir, 'go');
  const pidFile = join(dir, 'pid');
  const watched = parentWatched({ command: process.execPath, args: ['-e', `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`] }, 'shim', { termGraceMs: 500 });
  const shim = spawn(watched.command, ['--import', SPAWN_HELD, ...watched.args], { stdio: 'ignore', env: { ...process.env, SPAWN_HELD_UNTIL: gate } });
  let child;
  t.after(() => {
    for (const pid of [shim.pid, child]) if (pid && alive(pid)) try { process.kill(pid, 'SIGKILL'); } catch {}
    rmSync(dir, { recursive: true, force: true });
  });
  const closed = new Promise((resolve) => shim.on('close', (code, signal) => resolve({ code, signal })));
  // Its pid is written once its TERM handler is on; the shim is still held in its spawn.
  for (const end = Date.now() + 20_000; !(existsSync(pidFile) && readFileSync(pidFile, 'utf8') !== '') && Date.now() < end; ) await new Promise((r) => setTimeout(r, 20));
  child = Number(readFileSync(pidFile, 'utf8'));
  assert.ok(alive(child), 'the child runs');
  shim.kill('SIGTERM');
  writeFileSync(gate, '');
  assert.ok(!existsSync(`${gate}.expired`), 'the shim was still held in its spawn when the TERM was sent');
  assert.deepEqual(await closed, { code: null, signal: 'SIGKILL' }, 'the shim passed the TERM on and ends as its child did, killed a grace later');
  assert.deepEqual(await gone([child], 5_000), [], `the child (pid ${child}) still runs after the shim ended`);
});

// The grace is the caller's to ask for. A session's CLI runs under the same shim, and its host ends it with TERM to the
// whole group and a SIGKILL of its own later (the Claude Agent SDK's, 5 s after its TERM), which reaches the CLI too: a
// shim started with no grace passes a TERM on and kills nothing after it, so that CLI keeps all the time its host gives.
test('the shim started with no grace passes a TERM on and kills nothing after it: a child that ignores the TERM runs on until its host kills it', { skip: !linux && 'needs /proc', timeout: 30_000 }, async () => {
  const watched = parentWatched({ command: process.execPath, args: ['-e', 'process.on("SIGTERM", () => process.stdout.write("term\\n")); process.stdout.write(process.pid + "\\n"); setInterval(() => {}, 1000);'] }, 'shim');
  const shim = spawn(watched.command, watched.args, { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  shim.stdout.on('data', (d) => (out += d));
  const closed = new Promise((resolve) => shim.on('close', (code, signal) => resolve({ code, signal })));
  /** Waits until `out` holds `n` lines, or `ms` passes; whether it does. */
  const lines = async (n, ms) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 25))) if (out.split('\n').length > n) return true;
    return false;
  };
  let child;
  try {
    // Its pid is written once its TERM handler is on.
    assert.ok(await lines(1, 10_000), 'the child started and wrote its pid');
    child = Number(out.split('\n')[0]);
    assert.ok(alive(child), 'the child runs');
    const asked = Date.now();
    shim.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 3_500));
    assert.ok(alive(child), `the child (pid ${child}) was gone ${Date.now() - asked} ms after the shim passed a TERM on, though the shim was asked for no grace`);
    assert.ok(await lines(2, 1_000), 'the shim passed the TERM on');
    assert.equal(out.split('\n')[1], 'term');
    // Its host's own kill.
    process.kill(child, 'SIGKILL');
    let timer;
    const ended = await Promise.race([closed, new Promise((resolve) => { timer = setTimeout(() => resolve('still running'), 4_000); })]);
    clearTimeout(timer);
    assert.deepEqual(ended, { code: null, signal: 'SIGKILL' }, 'the shim ends as its child did, once its host killed the child');
  } finally {
    for (const pid of [shim.pid, child]) if (pid && alive(pid)) try { process.kill(pid, 'SIGKILL'); } catch {}
  }
});

test('the shim takes a grace only as a positive whole number of milliseconds a timer can wait: anything else is a usage error, and it runs nothing', { timeout: 30_000 }, async () => {
  const run = (args) => new Promise((resolve) => {
    const p = spawn(process.execPath, [PARENT_WATCH_SHIM, String(process.pid), ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => { p.kill('SIGKILL'); resolve({ code: 'still running after 10 s', err }); }, 10_000);
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, err }); });
  });
  const usage = 'usage: parent-watch.js <parent pid> [--term-grace <ms>] -- <command> [args...]\n';
  // The child would exit 5: a usage error runs none.
  const child = ['--', process.execPath, '-e', 'process.exit(5)'];
  for (const [what, args] of [
    ['a grace of 0', ['--term-grace', '0', ...child]],
    ['a grace that is no number', ['--term-grace', 'x', ...child]],
    ['a grace with a fraction', ['--term-grace', '1.5', ...child]],
    ['a grace longer than a timer waits', ['--term-grace', '2147483648', ...child]],
    ['a grace with no value before --', ['--term-grace', ...child]],
    ['a grace with no value and nothing after', ['--term-grace']],
  ]) assert.deepEqual(await run(args), { code: 2, err: usage }, what);
  assert.deepEqual(await run(['--term-grace', '1000', ...child]), { code: 5, err: '' }, 'a grace in milliseconds is taken, and the child runs');
});

// parentWatched reads a grace by the shim's rule, so a grace the shim would refuse throws at the call, on every machine
// (the parent-death signal has no use for one, but the same call elsewhere would start the shim), in place of a usage
// exit 2 at spawn that reads as the child's own exit. One the shim takes, it passes on.
test('parentWatched throws a RangeError at the call for a grace the shim would refuse, whichever watch, and the shim takes every grace it passes on', { timeout: 30_000 }, async () => {
  const cli = { command: '/pinned/cli', args: [] };
  for (const [what, termGraceMs] of [['0', 0], ['-0', -0], ['a negative grace', -1], ['a fraction', 1.5], ['NaN', NaN], ['Infinity', Infinity], ['one longer than a timer waits', 2_147_483_648], ['1e21', 1e21]]) {
    for (const how of ['shim', 'pdeathsig']) assert.throws(() => parentWatched(cli, how, { termGraceMs }), RangeError, `a grace of ${what} the shim would refuse was taken at the call (${how})`);
  }
  const run = ({ command, args }) => new Promise((resolve) => {
    const p = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, err }));
  });
  for (const termGraceMs of [1, 2_147_483_647]) {
    assert.deepEqual(await run(parentWatched({ command: process.execPath, args: ['-e', 'process.exit(5)'] }, 'shim', { termGraceMs })), { code: 5, err: '' }, `the shim refused a grace of ${termGraceMs} parentWatched passed on`);
  }
});
