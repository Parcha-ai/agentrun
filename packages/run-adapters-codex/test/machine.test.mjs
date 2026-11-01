// The session's local machine, attacked from the side Codex sits on: the child's environment, and the directories it
// may write and tail. No network.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { request } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { parentWatched, processAlive } from '@parcha/agentrun-adapters/host';
import { CODEX_ROUTES, gatewayHandler, isBrandedMachine } from '../dist/host/process.js';
import { childEnv, confined, localMachine } from '../dist/host/machine.js';
import { UNWATCHED } from '../dist/scripts.js';

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

test("the machine knows the exec the model proxy's latest answer carried: set as the answer passes, and cleared by the next answer, which holds none", async () => {
  const exec = (callId) => ({ type: 'response.output_item.done', item: { type: 'custom_tool_call', name: 'exec', call_id: callId, input: 'text(1)' } });
  const done = { type: 'response.completed', response: { id: 'r', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } };
  const stream = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const answers = [stream([exec('call_a'), done]), stream([exec('call_b'), done]), stream([done])];
  const acquire = localMachine({ dir: scratch(), proxy: { hooks, tools: [], fetch: async () => new Response(answers.shift(), { status: 200, headers: { 'content-type': 'text/event-stream' } }) } });
  const machine = await acquire({ ctx: { runId: 'announce' }, model: gatewayHandler(route) });
  try {
    const ask = () => new Promise((resolve, reject) => {
      const { hostname, port } = new URL(machine.modelUrl);
      const req = request({ host: hostname, port, method: 'POST', path: '/v1/responses', headers: { 'content-type': 'application/json', authorization: `Bearer ${machine.modelKey}` } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      req.end(JSON.stringify({ model: 'm', stream: true, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] }] }));
    });
    assert.equal(machine.announcedExec(), undefined, 'nothing announced yet');
    assert.equal(await ask(), 200);
    assert.equal(machine.announcedExec(), 'call_a');
    assert.equal(await ask(), 200);
    assert.equal(machine.announcedExec(), 'call_b', 'the latest answer, not the one before');
    assert.equal(await ask(), 200);
    assert.equal(machine.announcedExec(), undefined, 'an answer with no exec clears it');
  } finally {
    await machine.close();
  }
});

test("two answers open at once on a session (a background call beside the turn) make the announced exec unknown until both have ended, and a clean answer after them announces again", async () => {
  const encoder = new TextEncoder();
  const exec = (id) => `event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', item: { type: 'custom_tool_call', name: 'exec', call_id: id, input: 'x' } })}\n\n`;
  const done = `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'r', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\n`;
  const gates = [];
  const open = [];
  const answer = (id) => new Promise((resolve) => {
    let finish;
    const gate = new Promise((r) => { finish = r; });
    gates.push(finish);
    resolve(new Response(new ReadableStream({ async start(c) { c.enqueue(encoder.encode(exec(id))); open.push(id); await gate; c.enqueue(encoder.encode(done)); c.close(); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
  });
  const ids = ['call_a', 'call_b', 'call_c'];
  const acquire = localMachine({ dir: scratch(), proxy: { hooks, tools: [], fetch: async () => answer(ids.shift()) } });
  const machine = await acquire({ ctx: { runId: 'overlap' }, model: gatewayHandler(route) });
  const until = async (test) => { for (let i = 0; i < 200 && !test(); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(test()); };
  const ask = () => new Promise((resolve, reject) => {
    const { hostname, port } = new URL(machine.modelUrl);
    const req = request({ host: hostname, port, method: 'POST', path: '/v1/responses', headers: { 'content-type': 'application/json', authorization: `Bearer ${machine.modelKey}` } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(JSON.stringify({ model: 'm', stream: true, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] }] }));
  });
  try {
    const first = ask();
    await until(() => open.includes('call_a'));
    assert.equal(machine.announcedExec(), 'call_a', 'one answer open: its exec');
    const second = ask();
    await until(() => open.includes('call_b'));
    assert.equal(machine.announcedExec(), UNWATCHED, 'two open: which carried which cannot be told');
    gates[0]();
    await first;
    assert.equal(machine.announcedExec(), UNWATCHED, 'one ended, one open: still unknown');
    gates[1]();
    await second;
    assert.equal(machine.announcedExec(), UNWATCHED, 'both ended: neither exec stands for the other');
    const third = ask();
    await until(() => open.includes('call_c'));
    assert.equal(machine.announcedExec(), 'call_c', 'a clean answer after them announces again');
    gates[2]();
    await third;
  } finally {
    for (const g of gates) g();
    await machine.close();
  }
});

test("a machine acquired again announces nothing until its own proxy has seen an answer", async () => {
  const exec = { type: 'response.output_item.done', item: { type: 'custom_tool_call', name: 'exec', call_id: 'call_a', input: 'x' } };
  const body = [exec, { type: 'response.completed', response: { id: 'r', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const dir = scratch();
  const make = () => localMachine({ dir, proxy: { hooks, tools: [], fetch: async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }) } });
  const first = await make()({ ctx: { runId: 'again' }, model: gatewayHandler(route) });
  try {
    const { hostname, port } = new URL(first.modelUrl);
    await new Promise((resolve, reject) => {
      const req = request({ host: hostname, port, method: 'POST', path: '/v1/responses', headers: { 'content-type': 'application/json', authorization: `Bearer ${first.modelKey}` } }, (res) => { res.resume(); res.on('end', resolve); });
      req.on('error', reject);
      req.end(JSON.stringify({ model: 'm', stream: true, input: [] }));
    });
    assert.equal(first.announcedExec(), 'call_a');
  } finally {
    await first.close();
  }
  const second = await make()({ ctx: { runId: 'again' }, model: gatewayHandler(route) });
  try {
    assert.equal(second.announcedExec(), undefined, 'a re-attached machine announces nothing');
  } finally {
    await second.close();
  }
});

test("a seed of files is in its private directory at acquire and again after every wipe; a seed path that is not plain and relative, or a directory not the machine's own, is refused when the machine is made", async () => {
  const dir = scratch();
  const seed = { dir: 'codex-home', files: { 'skills/cite/SKILL.md': 'cite', 'skills/cite/reference/sources.md': 'sources' } };
  const acquire = localMachine({ dir, proxy: { hooks, tools: [] }, seed });
  const machine = await acquire({ ctx: { runId: 'r-seed' }, model: gatewayHandler(route) });
  try {
    const home = machine.dirs['codex-home'];
    const read = (path) => readFileSync(join(home, path), 'utf8');
    assert.deepEqual([read('skills/cite/SKILL.md'), read('skills/cite/reference/sources.md')], ['cite', 'sources'], 'at acquire');
    writeFileSync(join(home, 'skills', 'cite', 'SKILL.md'), 'changed');
    writeFileSync(join(home, 'stale.txt'), 'from an earlier drive');
    await machine.files.wipe();
    assert.deepEqual([read('skills/cite/SKILL.md'), read('skills/cite/reference/sources.md')], ['cite', 'sources'], 'written again after the wipe');
    assert.equal(existsSync(join(home, 'stale.txt')), false, 'the wipe still wipes everything else');
    assert.equal(existsSync(join(machine.dirs.home, 'skills')), false, 'only the seed\'s own directory');
  } finally {
    await machine.close();
  }
  for (const path of ['../escape', 'skills/../../escape', '/etc/passwd', '.hidden', 'skills/.system/x', './x', 'a//b', 'a/', '', 'a\\b', 'a\u0000b']) {
    assert.throws(() => localMachine({ dir: scratch(), proxy: { hooks, tools: [] }, seed: { dir: 'codex-home', files: { [path]: 'x' } } }), /agentrun-codex: the seed path .* is not a plain relative path inside codex-home/, JSON.stringify(path));
  }
  for (const where of ['work', '..', 'codex-home/skills']) {
    assert.throws(() => localMachine({ dir: scratch(), proxy: { hooks, tools: [] }, seed: { dir: where, files: { 'a.md': 'x' } } }), /agentrun-codex: a seed goes in one of the machine's private directories/, where);
  }
});
