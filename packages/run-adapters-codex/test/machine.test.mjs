// The session's local machine, attacked from the side Codex sits on: the child's environment, and the directories it
// may write and tail. No network.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { CODEX_ROUTES, gatewayHandler, isBrandedMachine } from '../dist/host/process.js';
import { childEnv, localMachine } from '../dist/host/machine.js';

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
    assert.deepEqual(Object.keys(seen.env).sort(), ['HOME', 'LANG', 'PATH', 'SESSION_KEY', 'TZ']);
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
