// The session's local machine, attacked from the side Codex sits on: the child's environment, and the directories it
// may write and tail. No network.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { parentWatched, processAlive } from '@parcha/agentrun-adapters/host';
import { CODEX_ROUTES, gatewayHandler, isBrandedMachine } from '../dist/host/process.js';
import { childEnv, confined, localMachine } from '../dist/host/machine.js';

const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-codex-machine-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let n = 0;
const scratch = () => mkdtempSync(join(ROOT, `t${n++}-`));

const route = { routes: CODEX_ROUTES, models: { model: 'luna-test' }, credential: () => 'provider-secret', target: 'https://provider.invalid' };
const hooks = { beforeRequest: async () => {}, afterRequest: async () => {} };

test("a child's environment is the allowlist and what the harness names: no host secret reaches Codex", async () => {
  const host = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC', HOME: '/nonexistent/host-home', OPENAI_API_KEY: 'sk-host', CODEX_HOME: '/nonexistent/host-home/.codex', GITHUB_TOKEN: 't' };
  assert.deepEqual(childEnv(host, { HOME: '/session/home' }), { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC', HOME: '/session/home' });

  const dir = scratch();
  const acquire = localMachine({ dir, env: host, proxy: { hooks, tools: [] } });
  const machine = await acquire({ ctx: { runId: 'r1' }, model: gatewayHandler(route) });
  try {
    assert.ok(isBrandedMachine(machine));
    const child = await machine.spawn({ command: process.execPath, args: ['-e', 'process.stdout.write(JSON.stringify({ env: process.env, cwd: process.cwd() }) + "\\n")'], env: { HOME: machine.dirs.home, SESSION_KEY: machine.modelKey } });
    let line;
    for await (const l of child.lines()) { line = l; break; }
    await child.exited;
    const seen = JSON.parse(line);
    assert.deepEqual(Object.keys(seen.env).sort(), ['GIT_CEILING_DIRECTORIES', 'HOME', 'LANG', 'PATH', 'SESSION_KEY', 'TZ']);
    assert.equal(seen.cwd, machine.root, 'Codex works in an empty directory of the session, never the host workspace');
  } finally {
    await machine.close();
  }
});

test("the machine writes and tails only inside the session's own directories, and never follows a link", async () => {
  const dir = scratch();
  const acquire = localMachine({ dir, proxy: { hooks, tools: [] } });
  const machine = await acquire({ ctx: { runId: 'r2' }, model: gatewayHandler(route) });
  try {
    for (const path of ['../escape', '/etc/passwd', 'a/../../escape', '']) {
      await assert.rejects(machine.files.upload('codex-home', [{ path, bytes: new Uint8Array() }]), /relative path|leaves the session/, path);
    }
    await machine.files.upload('codex-home', [{ path: 'sessions/x.jsonl', bytes: new TextEncoder().encode('one\ntwo\npart') }]);
    const tail = await machine.tail('codex-home', 'sessions/x.jsonl');
    assert.deepEqual(tail.read(), ['one', 'two']);
    const secret = join(dir, 'outside.txt');
    writeFileSync(secret, 'not yours\n');
    symlinkSync(secret, join(machine.dirs['codex-home'], 'sessions', 'link.jsonl'));
    const linked = await machine.tail('codex-home', 'sessions/link.jsonl');
    assert.throws(() => linked.read(), /is a link/);
    await assert.rejects(machine.tail('codex-home', '../outside.txt'), /leaves the session/);
  } finally {
    await machine.close();
  }
  await assert.rejects(machine.spawn({ command: process.execPath }), /closed/);
});

/** A session's machine under `dir`, with `confine`; returns a run of one child to its exit. */
async function machineAt(t, dir, confine) {
  const acquire = localMachine({ dir, ...(confine ? { confine } : {}), env: { PATH: process.env.PATH }, proxy: { hooks, tools: [] } });
  const machine = await acquire({ ctx: { runId: 'r1' }, model: gatewayHandler(route) });
  t.after(() => machine.close());
  const run = async (command, args) => {
    const proc = await machine.spawn({ command, args, env: {} });
    let out = '';
    (async () => { for await (const line of proc.lines()) out += line; })();
    const { code } = await proc.exited;
    return { code, out };
  };
  return { machine, run };
}

test("a session's git never finds a repository above the session, in a parent the model could write", async (t) => {
  const parent = mkdtempSync(join(ROOT, 'ceiling-'));
  execFileSync('git', ['init', '-q', parent]);
  const { run } = await machineAt(t, join(parent, 'sessions', 's1'));
  const found = await run('git', ['rev-parse', '--show-toplevel']);
  assert.notEqual(found.code, 0, `git found the repository ${found.out.trim()}`);
  const env = await run(process.execPath, ['-e', 'process.stdout.write(process.env.GIT_CEILING_DIRECTORIES ?? "")']);
  assert.equal(env.out, join(parent, 'sessions', 's1'));
});

test("the host's confinement wraps a child's command and arguments, never its environment, and may only add in front", async (t) => {
  const seen = [];
  const { run } = await machineAt(t, scratch(), (c) => { seen.push(c); return { command: '/usr/bin/env', args: ['--', c.command, ...c.args] }; });
  const code = 'process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))';
  const out = await run(process.execPath, ['-e', code]);
  assert.equal(out.code, 0);
  // The confinement wraps the child as the machine launches it: watched by this process (it dies with it).
  assert.deepEqual(seen, [parentWatched({ command: process.execPath, args: ['-e', code] })]);
  assert.deepEqual(JSON.parse(out.out), ['GIT_CEILING_DIRECTORIES', 'PATH'], "the environment is the machine's, untouched by the confinement");
  const child = { command: '/pinned/codex', args: ['--x', 'y'] };
  assert.deepEqual(confined(child, (c) => ({ command: '/usr/bin/setpriv', args: ['--no-new-privs', '--', c.command, ...c.args] })), { command: '/usr/bin/setpriv', args: ['--no-new-privs', '--', '/pinned/codex', '--x', 'y'] });
  for (const bad of [(c) => ({ command: c.command, args: c.args }), () => ({ command: '/usr/bin/env', args: [] }), (c) => ({ command: '/bin/sh', args: ['-c', 'x', '/other', ...c.args] }), (c) => ({ command: '/usr/bin/env', args: [c.command, ...c.args, '--more'] }), () => undefined]) {
    assert.throws(() => confined(child, bad), /confinement must start the child's own command/);
  }
});

test('under setpriv --no-new-privs, a child of the session runs with NoNewPrivs set', { skip: !existsSync('/usr/bin/setpriv') && 'no setpriv here' }, async (t) => {
  const { run } = await machineAt(t, scratch(), (c) => ({ command: '/usr/bin/setpriv', args: ['--no-new-privs', '--', c.command, ...c.args] }));
  const out = await run(process.execPath, ['-e', 'process.stdout.write(require("fs").readFileSync("/proc/self/status", "utf8").match(/^NoNewPrivs:\\s*(\\d)/m)[1])']);
  assert.equal(out.out, '1');
});

const alive = processAlive;
const gone = async (pid) => { for (let i = 0; i < 200 && alive(pid); i += 1) await new Promise((resolve) => setTimeout(resolve, 10)); return !alive(pid); };
/** Start a child that forks a grandchild (a sleep in the background) and reports its pid; returns both pids. */
async function forking(machine, signal) {
  const proc = await machine.spawn({ command: '/bin/sh', args: ['-c', 'sleep 300 & echo $!; wait'], env: {}, ...(signal ? { signal } : {}) });
  let grandchild;
  for await (const line of proc.lines()) { grandchild = Number(line); break; }
  assert.ok(Number.isInteger(grandchild) && alive(grandchild), 'the grandchild is running');
  return { proc, grandchild };
}

test("a child that forks a grandchild leaves none alive after the session's signal aborts: the kill is the process group", async (t) => {
  const { machine } = await machineAt(t, scratch());
  const stop = new AbortController();
  const { proc, grandchild } = await forking(machine, stop.signal);
  stop.abort(new Error('the process died'));
  const left = await gone(grandchild);
  if (!left) process.kill(grandchild, 'SIGKILL');
  assert.ok(left, 'the grandchild outlived its child');
  await proc.exited;
});

test("a child that forks a grandchild leaves none alive after close()", async (t) => {
  const { machine } = await machineAt(t, scratch());
  const { grandchild } = await forking(machine);
  await Promise.race([machine.close(), new Promise((resolve) => setTimeout(resolve, 3_000))]);
  const left = await gone(grandchild);
  if (!left) process.kill(grandchild, 'SIGKILL');
  assert.ok(left, 'the grandchild outlived the machine');
});

// Two runs on one host, each with its session machine. A client of run A that reads run B's address (a config or a
// port that is not its own) still holds A's key: B's proxy refuses it by name before anything is booked or forwarded.
const RECORDED_REQUEST = JSON.parse(readFileSync(new URL('./fixtures/responses-request-gpt-5.4-mini.json', import.meta.url), 'utf8'));
const RECORDED_STREAM = readFileSync(new URL('./fixtures/responses-stream-gpt-5.4-mini.sse', import.meta.url), 'utf8');

/** The user-agent of this test's own requests: another local client's keyless knock on a new loopback listener (a
 *  shared machine's service does) is refused too, and is shown, never judged here. */
const CROSS_RUN_AGENT = 'agentrun-cross-run-test';

/** A run's session machine whose proxy's hooks and provider record what reached them. */
async function runMachine(t, runId) {
  const seen = { before: 0, after: 0, forwarded: 0, refused: [] };
  const acquire = localMachine({ dir: scratch(), proxy: {
    hooks: { beforeRequest: async () => { seen.before += 1; }, afterRequest: async () => { seen.after += 1; } },
    tools: ['lookup'],
    log: (message, detail) => {
      if (!/refused/.test(message)) return;
      if (detail.userAgent === CROSS_RUN_AGENT) seen.refused.push(detail.reason);
      else t.diagnostic(`the proxy refused another client: ${JSON.stringify(detail)}`);
    },
    fetch: async () => { seen.forwarded += 1; return new Response(RECORDED_STREAM, { status: 200, headers: { 'content-type': 'text/event-stream' } }); },
  } });
  const machine = await acquire({ ctx: { runId }, model: gatewayHandler(route) });
  // Closed when the test ends, whatever happens after: a second machine that fails to start never leaves this one open.
  t.after(() => machine.close());
  return { machine, seen };
}

/** Codex's model request, with `key`, to the proxy at `url`. */
async function ask(url, key) {
  const body = { ...RECORDED_REQUEST, tools: [...RECORDED_REQUEST.tools, { type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } }] };
  const res = await fetch(`${url}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': CROSS_RUN_AGENT, ...(key === null ? {} : { authorization: `Bearer ${key}` }), accept: 'text/event-stream' }, body: JSON.stringify(body) });
  return { status: res.status, text: await res.text() };
}

test("run A's key at run B's proxy is refused by name: B books nothing, nothing reaches the provider, and each key still works at its own run's proxy", async (t) => {
  const a = await runMachine(t, 'run-a');
  const b = await runMachine(t, 'run-b');
  assert.notEqual(a.machine.modelKey, b.machine.modelKey, 'each run has a key of its own');
  for (const [client, proxy] of [[a, b], [b, a]]) {
    const refused = await ask(proxy.machine.modelUrl, client.machine.modelKey);
    assert.equal(refused.status, 401);
    assert.match(refused.text, /this session's key is required/);
  }
  // No key at all is refused the same way.
  const keyless = await ask(b.machine.modelUrl, null);
  assert.deepEqual([keyless.status, /this session's key is required/.test(keyless.text)], [401, true]);
  // The only route without the key is Codex's local probe, which answers here and reaches nothing.
  assert.equal((await fetch(`${b.machine.modelUrl}/`, { headers: { authorization: `Bearer ${a.machine.modelKey}` } })).status, 404);
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const run of [a, b]) {
    assert.deepEqual({ before: run.seen.before, after: run.seen.after, forwarded: run.seen.forwarded }, { before: 0, after: 0, forwarded: 0 }, "the other run's request was never booked or forwarded");
    assert.deepEqual(run.seen.refused, Array(run === b ? 2 : 1).fill("this session's key is required"), 'each refusal is said, by name');
  }
  for (const run of [a, b]) assert.equal((await ask(run.machine.modelUrl, run.machine.modelKey)).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const run of [a, b]) assert.deepEqual({ before: run.seen.before, forwarded: run.seen.forwarded }, { before: 1, forwarded: 1 }, "a run's own request is booked and forwarded once");
});
