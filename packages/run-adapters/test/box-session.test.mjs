// ./host's box (box-bwrap.ts): what a box may bind under serve's data root and the server's home. The machine lends
// each session one directory (its base: the workspace and the homes are made under it), and the argv's check allows a
// writable bind there only at or under that session, and a read-only one under the server's home only in node's install
// prefix, the kernel's own packages and its forwarder. These build a server's home and a data root shaped as serve
// lays them out in a temporary directory, and give the check that home and runtime: no bwrap is started.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { BoxError, boxListens, buildBoxArgv, checkBoxArgv, forwardChild } from '@parcha/agentrun-kernel/host';

const harness = { command: '/usr/bin/true', args: [] };
const file = (path, text = '') => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
};
const dir = (path) => {
  mkdirSync(path, { recursive: true });
  return path;
};

/**
 * A server's home with node under ~/.nvm and the kernel in a project install, and serve's data root, under the home
 * (the default) or outside it. Each run's directory is <data>/runs/<id>: serve lends the machine <run>/harness (its
 * app.ts), the machine makes work/ and the homes under it (machine.ts), and the run's own files (store/run.sqlite,
 * process.log, box.json, serve.json) lie beside that session. `hidden` is serve's: the data root, the run's own store
 * and process log.
 */
function server({ dataUnderHome = true } = {}) {
  const top = mkdtempSync(join(tmpdir(), 'box-session-'));
  const home = dir(join(top, 'home'));
  const data = dir(dataUnderHome ? join(home, '.local', 'share', 'agentrun') : join(top, 'xdg', 'agentrun'));
  const run = (id) => {
    const at = join(data, 'runs', id);
    const session = join(at, 'harness');
    const homes = { HOME: dir(join(session, 'home')), CLAUDE_CONFIG_DIR: dir(join(session, 'config')) };
    for (const name of ['store/run.sqlite', 'process.log', 'box.json', 'serve.json', 'run.json']) file(join(at, name));
    return { dir: at, session, work: dir(join(session, 'work')), homes };
  };
  const a = run('a');
  const b = run('b');
  const execPath = file(join(home, '.nvm', 'versions', 'node', 'v22.0.0', 'bin', 'node'));
  const project = join(home, 'proj');
  const forward = file(join(project, 'node_modules', '@parcha', 'agentrun-kernel', 'dist', 'host', 'box-forward.js'));
  const cli = file(join(project, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-linux-x64', 'claude'));
  const socket = file(join(top, 'sockets', 'model.sock'));
  const hidden = [data, join(a.dir, 'store'), join(a.dir, 'process.log')];
  return { top, home, data, a, b, execPath, forward, cli, socket, hidden, runtime: { execPath, forward } };
}

/** Run a's spec: its session, work/ and homes, node and the CLI read-only, its own socket; `extra` overrides. */
const specOf = (s, extra = {}) => ({
  session: s.a.session,
  workspace: s.a.work,
  homes: s.a.homes,
  readOnly: [s.execPath, s.forward, s.cli],
  modelSocket: s.socket,
  modelPort: 8123,
  env: { PATH: '/usr/bin:/bin' },
  ...extra,
});
/** The argv's check, with the server's home, hidden paths and runtime of `s` (or `options`'). */
const check = (s, spec, options = {}) => checkBoxArgv(buildBoxArgv(spec, forwardChild(harness, boxListens(spec))), spec, { hidden: s.hidden, home: s.home, runtime: s.runtime, ...options });
const refusedBy = (s, spec, why, options = {}) =>
  assert.throws(() => check(s, spec, options), (e) => e instanceof BoxError && e.code === 'box_refused' && why.test(e.message), `not refused for ${why}`);
const escape = (path) => path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test("with the server's home holding the default data root, a run's own session binds: its work/ and its homes, node and the kernel's packages read-only, its own socket", () => {
  const s = server();
  check(s, specOf(s));
});

test("a home outside the session is refused by name: a sibling run's session, its home, or its run directory, given in homes", () => {
  const s = server();
  for (const path of [s.b.session, s.b.homes.HOME, s.b.dir]) {
    refusedBy(s, specOf(s, { homes: { ...s.a.homes, HOME: path } }), new RegExp(`home HOME ${escape(path)} is not under the session ${escape(s.a.session)}`));
  }
  refusedBy(s, specOf(s, { workspace: s.b.work }), new RegExp(`the workspace ${escape(s.b.work)} is not under the session`));
});

test("a session at the run directory is refused by name, as it holds the run's store: so a home at <run>/store or at <run> never binds", () => {
  const s = server();
  const store = join(s.a.dir, 'store');
  const atRun = { session: s.a.dir, workspace: s.a.work, homes: s.a.homes };
  refusedBy(s, specOf(s, atRun), new RegExp(`the session ${escape(s.a.dir)} is or holds ${escape(store)}, which a box never sees`));
  for (const path of [store, s.a.dir]) {
    refusedBy(s, specOf(s, { ...atRun, homes: { ...s.a.homes, HOME: path } }), new RegExp(`the session ${escape(s.a.dir)} is or holds ${escape(store)}`));
  }
});

test("a run's own records beside its session are never bound: <run>/box.json and <run>/serve.json, read-only or as a home, are refused by name", () => {
  const s = server();
  for (const name of ['box.json', 'serve.json']) {
    const path = join(s.a.dir, name);
    refusedBy(s, specOf(s, { readOnly: [s.execPath, path] }), new RegExp(`a read-only path ${escape(path)} is under ${escape(s.data)}, where a run's files live`));
    refusedBy(s, specOf(s, { homes: { ...s.a.homes, HOME: path } }), new RegExp(`home HOME ${escape(path)} is not under the session`));
  }
});

test("nothing else of the server's home binds: ~/.ssh read-only or as a home, and a session under the home but outside the data root or in a CLI's config, are refused by name", () => {
  const s = server();
  const ssh = dir(join(s.home, '.ssh'));
  refusedBy(s, specOf(s, { readOnly: [s.execPath, ssh] }), new RegExp(`a read-only path ${escape(ssh)} is under the server's home ${escape(s.home)}, outside node's install prefix`));
  refusedBy(s, specOf(s, { homes: { ...s.a.homes, HOME: ssh } }), new RegExp(`home HOME ${escape(ssh)} is not under the session`));
  // A session of its own, under the home: only the data root lends one there.
  const elsewhere = join(s.home, 'projects', 'p');
  const own = { session: elsewhere, workspace: dir(join(elsewhere, 'work')), homes: { HOME: dir(join(elsewhere, 'home')) } };
  refusedBy(s, specOf(s, own), new RegExp(`--bind ${escape(join(elsewhere, 'work'))} is under ${escape(s.home)}, and the session ${escape(elsewhere)} is not under the data root`));
  const claude = join(s.home, '.claude', 'p');
  refusedBy(s, specOf(s, { session: claude, workspace: dir(join(claude, 'work')), homes: {} }), new RegExp(`--bind ${escape(join(claude, 'work'))} is under ${escape(join(s.home, '.claude'))}, a CLI's config`));
});

test("with the data root outside the server's home, a sibling run's directory and a path of the home given as a home are still refused by name, and the run's own session binds", () => {
  const s = server({ dataUnderHome: false });
  check(s, specOf(s));
  refusedBy(s, specOf(s, { homes: { ...s.a.homes, HOME: s.b.dir } }), new RegExp(`home HOME ${escape(s.b.dir)} is not under the session`));
  const ssh = dir(join(s.home, '.ssh'));
  refusedBy(s, specOf(s, { homes: { ...s.a.homes, HOME: ssh } }), new RegExp(`home HOME ${escape(ssh)} is not under the session`));
});

test("node's install prefix under the server's home binds whole, and its node; a prefix holding etc/npmrc (registry tokens) is refused by name", () => {
  const s = server();
  const prefix = dirname(dirname(s.execPath));
  check(s, specOf(s, { readOnly: [prefix, s.forward] }));
  file(join(prefix, 'etc', 'npmrc'), '//registry.example/:_authToken=x\n');
  refusedBy(s, specOf(s), new RegExp(`a read-only path ${escape(s.execPath)} is under node's install prefix ${escape(prefix)}, which holds etc/npmrc`));
});

test("a source checkout under the server's home binds: the forwarder through a workspace link, a CLI hoisted in <repo>/node_modules beside a package's own node_modules; <repo>/.env and ~/node_modules are refused by name", () => {
  const s = server();
  const repo = join(s.home, 'agentrun');
  const kernel = join(repo, 'packages', 'run-adapters');
  file(join(kernel, 'dist', 'host', 'box-forward.js'));
  // npm made the kernel package its own node_modules for one dependency it could not hoist.
  file(join(kernel, 'node_modules', 'conflicting', 'index.js'));
  dir(join(repo, 'node_modules', '@parcha'));
  symlinkSync(kernel, join(repo, 'node_modules', '@parcha', 'agentrun-kernel'));
  const forward = join(repo, 'node_modules', '@parcha', 'agentrun-kernel', 'dist', 'host', 'box-forward.js');
  const cli = file(join(repo, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-linux-x64', 'claude'));
  const env = file(join(repo, '.env'), 'KEY=x\n');
  const stray = file(join(s.home, 'node_modules', 'stray', 'index.js'));
  const runtime = { execPath: s.execPath, forward };
  check(s, specOf(s, { readOnly: [s.execPath, forward, cli] }), { runtime });
  refusedBy(s, specOf(s, { readOnly: [s.execPath, env] }), new RegExp(`a read-only path ${escape(env)} is under the server's home .*the kernel's packages \\(${escape(join(repo, 'node_modules'))}\\)`), { runtime });
  refusedBy(s, specOf(s, { readOnly: [s.execPath, stray] }), new RegExp(`a read-only path ${escape(stray)} is under the server's home`), { runtime });
});

test("a project install binds with the kernel nested under another package and the CLIs hoisted or nested: the packages are the OUTERMOST node_modules on the forwarder's path, never the project around it (its .env is refused by name)", () => {
  const s = server();
  const modules = join(s.home, 'app', 'node_modules');
  const forward = file(join(modules, '@parcha', 'agentrun-serve', 'node_modules', '@parcha', 'agentrun-kernel', 'dist', 'host', 'box-forward.js'));
  const hoisted = file(join(modules, '@anthropic-ai', 'claude-agent-sdk-linux-x64', 'claude'));
  const nested = file(join(modules, '@parcha', 'agentrun-harness-codex', 'node_modules', '@openai', 'codex-linux-x64', 'vendor', 't', 'bin', 'codex'));
  const runtime = { execPath: s.execPath, forward };
  check(s, specOf(s, { readOnly: [s.execPath, forward, hoisted, nested] }), { runtime });
  const env = file(join(s.home, 'app', '.env'), 'KEY=x\n');
  refusedBy(s, specOf(s, { readOnly: [s.execPath, env] }), new RegExp(`a read-only path ${escape(env)} is under the server's home .*the kernel's packages \\(${escape(modules)}\\)`), { runtime });
});

test("a pnpm install binds: the forwarder and the CLI resolve into node_modules/.pnpm, under the project's outermost node_modules", () => {
  const s = server();
  const pnpm = join(s.home, 'pn', 'node_modules', '.pnpm');
  const forward = file(join(pnpm, '@parcha+agentrun-kernel@1.0.0', 'node_modules', '@parcha', 'agentrun-kernel', 'dist', 'host', 'box-forward.js'));
  const store = file(join(pnpm, '@anthropic-ai+claude-agent-sdk-linux-x64@0.3.286', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-linux-x64', 'claude'));
  const cli = join(s.home, 'pn', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-linux-x64');
  dir(dirname(cli));
  symlinkSync(dirname(store), cli);
  check(s, specOf(s, { readOnly: [s.execPath, forward, join(cli, 'claude')] }), { runtime: { execPath: s.execPath, forward } });
});

test("a socket of the spec's own is still never bound from a CLI's config: one under ~/.claude is refused by name", () => {
  const s = server();
  const socket = file(join(s.home, '.claude', 'agentrun.sock'));
  refusedBy(s, specOf(s, { modelSocket: socket }), new RegExp(`--bind /run/agentrun/model.sock \\(${escape(socket)}\\) is under ${escape(join(s.home, '.claude'))}, a CLI's config`));
});
