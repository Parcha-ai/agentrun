import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { installCliLearning, statusCliLearning, removeCliLearning } from '../dist/cli-learning/install.js';
import { learningMain } from '../dist/cli-learning/cli.js';
import { connectionFile } from '../dist/cli-learning/state.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'agentrun-learning-worktree-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const main = join(root, 'main');
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture',
    '-c', 'user.email=fixture@example.invalid', ...args], { stdio: 'pipe' });
  git('init', main);
  git('-C', main, 'commit', '--allow-empty', '-m', 'fixture');
  const projects = ['first', 'second'].map((name) => join(root, name));
  for (const project of projects) git('-C', main, 'worktree', 'add', '--detach', project);
  const options = projects.map((project) => ({ project, runtime: 'codex', dataDir: join(root, 'private-data'),
    url: 'http://127.0.0.1:7340', command: ['node', '/opt/agentrun/cli.js'] }));
  return { root, main, shared: join(main, '.codex/hooks.json'), options };
}
const localPath = (o) => join(o.project, '.codex/hooks.json');
const receiptPath = (o) => join(o.project, '.agentrun/cli-learning/codex.json');
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const originalToml = '# Preserve this file byte for byte.\nmodel = "project-model"\n';
async function legacyInstall(o) {
  // Simulate the previous installer's JSON receipt before worktree detection existed.
  await rename(join(o.project, '.git'), join(o.project, '.git.saved'));
  try { await installCliLearning(o); }
  finally { await rename(join(o.project, '.git.saved'), join(o.project, '.git')); }
}

/** Pause at the filesystem adapter boundary after both installer locks and the receipt
 * are durable, before the shared configuration is atomically replaced. */
async function pausedInstaller(t, options, shared) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { once } from 'node:events';
    import { syncBuiltinESMExports } from 'node:module';
    const rename = fs.promises.rename;
    fs.promises.rename = async (from, to) => {
      if (to === ${JSON.stringify(shared)}) {
        process.stdout.write('locks-held\\n');
        await once(process.stdin, 'data');
      }
      return rename(from, to);
    };
    syncBuiltinESMExports();
    const { installCliLearning } = await import(${JSON.stringify(new URL('../dist/cli-learning/install.js', import.meta.url).href)});
    await installCliLearning(${JSON.stringify(options)});
    process.stdin.destroy();
  `], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  t.after(async () => { child.kill('SIGKILL'); await exited; });
  const [ready] = await once(child.stdout, 'data', { signal: AbortSignal.timeout(5000) });
  assert.match(String(ready), /locks-held/);
  return {
    kill: async () => { child.kill('SIGKILL'); await exited; },
    finish: async () => { child.stdin.end('continue'); assert.deepEqual(await exited, [0, null]); },
  };
}

test('a killed installer releases proven ownership of both project and shared worktree locks on retry', async t => {
  const { main, shared, options: [first, second] } = await fixture(t);
  const paused = await pausedInstaller(t, first, shared);
  for (const path of [join(first.project, '.agentrun/cli-learning/install.lock'), join(main, '.codex/.agentrun-learning.lock')]) {
    assert.equal((await stat(path)).mode & 0o777, 0o600, 'installer owner records remain private');
  }
  await paused.kill();
  assert.equal((await installCliLearning(second)).configured, true, 'a sibling worktree recovers the dead shared owner');
  assert.equal((await removeCliLearning(first)).configured, false, 'disconnect recovers the dead project owner and clears its interrupted receipt');
  assert.equal((await statusCliLearning(second)).configured, true, 'recovery preserves the other worktree hooks');
  assert.equal((await installCliLearning(first)).configured, true);
  for (const groups of Object.values((await readJson(shared)).hooks)) {
    assert.equal(groups.filter(group => group.hooks.length).length, 2);
  }
});

test('a live shared installer excludes a sibling until release, then both hook sets survive', async t => {
  const { shared, options: [first, second] } = await fixture(t);
  const paused = await pausedInstaller(t, first, shared);
  let finished = false;
  const concurrent = installCliLearning(second).then(value => { finished = true; return value; });
  concurrent.catch(() => {}); // Preserve cleanup if an assertion fails while the sibling is waiting.
  // The second project's own lock proves it entered installation, while the shared
  // writer must still be waiting for the first process to release its lock.
  const lock = join(second.project, '.agentrun/cli-learning/install.lock');
  const deadline = Date.now() + 5000;
  while (!await stat(lock).catch(() => undefined)) {
    assert.ok(Date.now() < deadline, 'the sibling enters its installation');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(finished, false);
  await assert.rejects(readFile(shared), { code: 'ENOENT' }, 'neither writer has replaced shared configuration early');
  await paused.finish();
  assert.equal((await concurrent).configured, true);
  for (const groups of Object.values((await readJson(shared)).hooks)) {
    assert.equal(groups.filter(group => group.hooks.length).length, 2);
  }
  assert.equal((await statusCliLearning(first)).configured, true);
  assert.equal((await statusCliLearning(second)).configured, true);
});

test('an old ownerless shared lock is preserved across a sibling install attempt', async t => {
  const { main, shared, options: [first, second] } = await fixture(t);
  await installCliLearning(first);
  const before = await readFile(shared, 'utf8');
  const lock = join(main, '.codex/.agentrun-learning.lock');
  await writeFile(lock, '', { mode: 0o600 });
  const old = new Date(Date.now() - 86_400_000);
  await utimes(lock, old, old);
  await assert.rejects(installCliLearning(second), error => error.message.includes(lock) && /stop|stopped/i.test(error.message));
  assert.equal(await readFile(lock, 'utf8'), '');
  assert.equal(await readFile(shared, 'utf8'), before);
  assert.equal((await statusCliLearning(first)).configured, true);
});

test('linked worktrees serialize additive installs in the native shared file and leave local TOML untouched', async (t) => {
  const { main, shared, options: [first, second] } = await fixture(t);
  for (const o of [first, second]) {
    await mkdir(join(o.project, '.codex'));
    await writeFile(join(o.project, '.codex/config.toml'), originalToml);
  }
  const installed = await Promise.all([installCliLearning(first), installCliLearning(second)]);
  const config = await readJson(shared);
  for (const [index, o] of [first, second].entries()) {
    assert.equal(installed[index].configPath, shared, 'native Codex reads hooks from the main checkout');
    assert.equal(installed[index].configured, true);
    const receipt = await readJson(receiptPath(o));
    assert.equal(receipt.version, 2);
    assert.equal(receipt.format, 'codex-shared-json');
    assert.equal(receipt.configRoot, main);
    for (const event of ['UserPromptSubmit', 'Stop', 'Interrupt', 'SessionEnd']) {
      assert.equal(config.hooks[event].length, 2);
      assert.equal(config.hooks[event].filter((group) => group.hooks[0].command.includes(o.project)).length, 1);
    }
    const before = await readFile(shared, 'utf8');
    await installCliLearning(o);
    assert.equal(await readFile(shared, 'utf8'), before, 'reconnect must not change native trust keys or hashes');
    assert.equal((await statusCliLearning(o)).configured, true);
    assert.equal(await readFile(join(o.project, '.codex/config.toml'), 'utf8'), originalToml);
    await assert.rejects(readFile(localPath(o)), { code: 'ENOENT' });
  }
});

test('removing a worktree or the original main-checkout enrollment preserves surviving native group indices', async (t) => {
  const { main, shared, options: [first, second] } = await fixture(t);
  const mainOptions = { ...first, project: main };
  await installCliLearning(mainOptions);
  await installCliLearning(first);
  await installCliLearning(second);
  const before = await readJson(shared);
  await removeCliLearning(first);
  const afterFirst = await readJson(shared);
  for (const event of Object.keys(before.hooks)) {
    assert.deepEqual(afterFirst.hooks[event][1], { hooks: [] });
    assert.deepEqual(afterFirst.hooks[event][2], before.hooks[event][2]);
  }
  await removeCliLearning(mainOptions);
  const afterMain = await readJson(shared);
  for (const event of Object.keys(before.hooks)) {
    assert.deepEqual(afterMain.hooks[event][0], { hooks: [] });
    assert.deepEqual(afterMain.hooks[event][2], before.hooks[event][2]);
  }
  assert.equal((await statusCliLearning(second)).configured, true);
  await assert.rejects(readFile(receiptPath(first)), { code: 'ENOENT' });
});

test('legacy worktree JSON is not ready; reconnect migrates exact owned hooks and preserves unrelated local hooks', async (t) => {
  const { main, shared, options: [o] } = await fixture(t);
  await legacyInstall(o);
  const old = await readJson(localPath(o));
  const userHook = { type: 'command', command: 'unrelated-user-hook' };
  old.hooks.Stop[0].hooks.push(userHook);
  await writeFile(localPath(o), JSON.stringify(old));
  const before = await statusCliLearning(o);
  assert.equal(before.configured, false);
  assert.equal(before.state, 'migration-required');
  assert.equal((await installCliLearning(o)).configured, true);
  assert.deepEqual(await readJson(localPath(o)), { hooks: { Stop: [{ hooks: [userHook] }] } });
  const receipt = await readJson(receiptPath(o));
  assert.equal(receipt.version, 2);
  assert.equal(receipt.configRoot, main);
  assert.equal(receipt.legacy, undefined);
  await installCliLearning(o);
  await removeCliLearning(o);
  assert.deepEqual(await readJson(shared), {});
  assert.deepEqual(await readJson(localPath(o)), { hooks: { Stop: [{ hooks: [userHook] }] } });
});

test('legacy migration refuses changed ownership or another target without touching either config', async (t) => {
  const { shared, options: [o] } = await fixture(t);
  await legacyInstall(o);
  const before = await readFile(localPath(o), 'utf8');
  await assert.rejects(installCliLearning({ ...o, url: 'http://127.0.0.1:7341' }), /disconnect/);
  assert.equal(await readFile(localPath(o), 'utf8'), before);
  const modified = JSON.parse(before);
  modified.hooks.Stop[0].hooks[0].timeout = 11;
  const modifiedText = JSON.stringify(modified);
  await writeFile(localPath(o), modifiedText);
  assert.equal((await statusCliLearning(o)).state, 'partial');
  await assert.rejects(installCliLearning(o), /modified|disconnect/);
  assert.equal(await readFile(localPath(o), 'utf8'), modifiedText);
  await assert.rejects(readFile(shared), { code: 'ENOENT' });
  await removeCliLearning(o);
  assert.equal((await readJson(localPath(o))).hooks.Stop[0].hooks[0].timeout, 11);
});

test('malformed or symlinked shared JSON fails without losing local legacy ownership', async (t) => {
  const { main, shared, options: [o] } = await fixture(t);
  await legacyInstall(o);
  const receipt = await readFile(receiptPath(o), 'utf8');
  const local = await readFile(localPath(o), 'utf8');
  await mkdir(join(main, '.codex'));
  for (const invalid of ['{ invalid', '{"hooks": {"Stop": false}}']) {
    await writeFile(shared, invalid);
    await assert.rejects(installCliLearning(o), /Invalid/);
    assert.equal(await readFile(shared, 'utf8'), invalid);
    assert.equal(await readFile(receiptPath(o), 'utf8'), receipt);
    assert.equal(await readFile(localPath(o), 'utf8'), local);
  }
  await rm(shared);
  const outside = join(o.dataDir, 'outside.json');
  await mkdir(o.dataDir);
  await writeFile(outside, '{"keep":true}');
  await symlink(outside, shared);
  await assert.rejects(installCliLearning(o), /symlink/);
  assert.equal(await readFile(outside, 'utf8'), '{"keep":true}');
});

test('CLI reconnect migrates a live enrollment without issuing or revoking its credential', async (t) => {
  const { shared, options: [o] } = await fixture(t);
  await mkdir(o.dataDir);
  await writeFile(join(o.dataDir, '.token'), 'fake-owner-token');
  const output = [], errors = [], methods = [];
  const connection = { connection_id: 'fixture-connection', agent_id: 'fixture-agent', token: 'fake-scoped-token', active: true };
  const io = { command: o.command, stdout: (line) => output.push(line), stderr: (line) => errors.push(line),
    fetch: async (_url, init) => { methods.push(init.method); return Response.json(init.method === 'GET' ? { connections: [connection] } : connection); } };
  const args = ['connect', '--project', o.project, '--runtime', o.runtime, '--data', o.dataDir, '--url', o.url];
  await rename(join(o.project, '.git'), join(o.project, '.git.saved'));
  try { assert.equal(await learningMain(args, io), 0); }
  finally { await rename(join(o.project, '.git.saved'), join(o.project, '.git')); }
  const credentialPath = connectionFile(o.dataDir, o.runtime, o.project);
  const originalCredential = await readFile(credentialPath, 'utf8');
  assert.equal(await learningMain(args, io), 0, errors.join('\n'));
  const migrated = JSON.parse(output.at(-1));
  assert.equal(migrated.configured, true);
  assert.equal(migrated.configPath, shared);
  assert.equal(migrated.connection_id, connection.connection_id);
  assert.equal(migrated.agent_id, connection.agent_id);
  assert.equal(await readFile(credentialPath, 'utf8'), originalCredential);
  assert.deepEqual(methods, ['POST', 'GET']);
  assert.equal((await readFile(shared, 'utf8')).includes(connection.token), false);
});

test('interrupted migration retains both receipts for reconnect or safe disconnect', async (t) => {
  for (const stage of ['after-shared-write', 'before-shared-write']) {
    const { shared, options: [o] } = await fixture(t);
    await legacyInstall(o);
    const legacy = await readJson(receiptPath(o));
    const legacyConfig = await readFile(localPath(o), 'utf8');
    await installCliLearning(o);
    const migrated = await readJson(receiptPath(o));
    await writeFile(receiptPath(o), JSON.stringify({ ...migrated, legacy }));
    await writeFile(localPath(o), legacyConfig);
    if (stage === 'before-shared-write') {
      await writeFile(shared, '{}');
      assert.equal((await statusCliLearning(o)).state, 'partial');
    } else {
      assert.equal((await installCliLearning(o)).configured, true);
      assert.deepEqual(await readJson(localPath(o)), {});
      assert.equal((await readJson(receiptPath(o))).legacy, undefined);
    }
    await removeCliLearning(o);
    assert.deepEqual(await readJson(shared), {});
    assert.deepEqual(await readJson(localPath(o)), {});
    await assert.rejects(readFile(receiptPath(o)), { code: 'ENOENT' });
  }
});

test('forged receipt roots and wrong reciprocal Git registrations never authorize shared writes', async (t) => {
  const { shared, options: [o] } = await fixture(t);
  await installCliLearning(o);
  const receipt = await readJson(receiptPath(o));
  const before = await readFile(shared, 'utf8');
  for (const values of [{ configRoot: o.dataDir }, { format: 'codex-toml' }, { runtime: 'claude-code' },
    { legacy: { ...receipt, version: 1, dataDir: join(o.dataDir, 'other') } }]) {
    await writeFile(receiptPath(o), JSON.stringify({ ...receipt, ...values }));
    await assert.rejects(removeCliLearning(o), /Invalid AgentRun hook receipt/);
    assert.equal(await readFile(shared, 'utf8'), before);
  }
  await writeFile(receiptPath(o), JSON.stringify(receipt));
  const gitdir = (await readFile(join(o.project, '.git'), 'utf8')).trim().slice('gitdir: '.length);
  await writeFile(join(gitdir, 'gitdir'), join(o.dataDir, '.git'));
  await assert.rejects(statusCliLearning(o));
  await assert.rejects(removeCliLearning(o));
  assert.equal(await readFile(shared, 'utf8'), before);
});

test('a project inside a linked worktree maps the same relative project folder in the main checkout', async (t) => {
  const { main, options: [o] } = await fixture(t);
  o.project = join(o.project, 'packages', 'app');
  await mkdir(o.project, { recursive: true });
  const installed = await installCliLearning(o);
  assert.equal(installed.configPath, join(main, 'packages/app/.codex/hooks.json'));
  assert.equal(installed.configured, true);
  assert.equal((await readJson(receiptPath(o))).configRoot, join(main, 'packages/app'));
  assert.equal((await statusCliLearning(o)).configured, true);
});

test('a missing local Codex layer is not reported configured even when shared handlers still exist', async (t) => {
  const { shared, options: [o] } = await fixture(t);
  await installCliLearning(o);
  const before = await readFile(shared, 'utf8');
  await rm(join(o.project, '.codex'), { recursive: true });
  const status = await statusCliLearning(o);
  assert.equal(status.configured, false);
  assert.equal(status.state, 'partial');
  await assert.rejects(installCliLearning(o), /disconnect/);
  assert.equal(await readFile(shared, 'utf8'), before);
  await removeCliLearning(o);
  assert.deepEqual(await readJson(shared), {});
});

test('shared configuration size overflow is refused before writing ownership or changing user hooks', async (t) => {
  const { main, shared, options: [o] } = await fixture(t);
  await mkdir(join(main, '.codex'));
  const before = JSON.stringify({ description: 'x'.repeat(64 * 1024 - 100) });
  await writeFile(shared, before);
  await assert.rejects(installCliLearning(o), /size limit/);
  assert.equal(await readFile(shared, 'utf8'), before);
  await assert.rejects(readFile(receiptPath(o)), { code: 'ENOENT' });
});
