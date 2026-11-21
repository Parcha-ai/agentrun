import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { installCliLearning, statusCliLearning, removeCliLearning } from '../dist/cli-learning/install.js';

async function fixture(t, runtime = 'codex') {
  const project = await mkdtemp(join(tmpdir(), 'agentrun-learning-install-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  return { project, runtime, dataDir: join(project, 'server-data'), url: 'http://127.0.0.1:7340', command: ['node', '/opt/agentrun/cli.js'] };
}
const configPath = (o) => join(o.project, o.runtime === 'codex' ? '.codex/hooks.json' : '.claude/settings.local.json');
async function seed(o, config) {
  await mkdir(join(o.project, o.runtime === 'codex' ? '.codex' : '.claude'));
  await writeFile(configPath(o), JSON.stringify(config));
}
async function readConfig(o) { return JSON.parse(await readFile(configPath(o), 'utf8')); }

for (const runtime of ['codex', 'claude-code']) {
  test(`${runtime}: preserves existing settings, installs once and removes only its hooks`, async (t) => {
    const o = await fixture(t, runtime);
    const existing = { permissions: { allow: ['Read'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'my-existing-hook' }] }] } };
    await seed(o, existing);
    const installed = await installCliLearning(o);
    assert.equal(installed.configured, true);
    assert.equal(installed.activation, 'unverified');
    assert.equal(installed.configPath, configPath(o));
    const first = await readFile(configPath(o), 'utf8');
    await installCliLearning(o);
    assert.equal(await readFile(configPath(o), 'utf8'), first, 'reconnecting must not churn Codex hook trust hashes');
    const config = await readConfig(o);
    assert.deepEqual(config.permissions, existing.permissions);
    assert.deepEqual(config.hooks.Stop[0], existing.hooks.Stop[0]);
    assert.equal(config.hooks.UserPromptSubmit.length, 1);
    assert.equal(config.hooks.SessionEnd.length, 1);
    assert.ok(runtime === 'codex' ? config.hooks.Interrupt : config.hooks.StopFailure);
    const status = await statusCliLearning(o);
    assert.equal(status.configured, true);
    assert.ok(status.instructions.some((s) => s.includes('/hooks')));
    assert.equal((await removeCliLearning(o)).configured, false);
    assert.deepEqual(await readConfig(o), existing);
    await removeCliLearning(o);
    assert.deepEqual(await readConfig(o), existing, 'disconnect is idempotent');
  });
}

test('status is read-only and reports missing hooks without creating configuration', async (t) => {
  const o = await fixture(t);
  assert.equal((await statusCliLearning(o)).state, 'not-installed');
  await assert.rejects(readFile(configPath(o)), { code: 'ENOENT' });
  await assert.rejects(readFile(join(o.project, '.agentrun/cli-learning/codex.json')), { code: 'ENOENT' });
});

test('removes owned capture hooks and preserves user edits, warning when edited groups need trust review', async (t) => {
  const o = await fixture(t);
  await installCliLearning(o);
  const config = await readConfig(o);
  config.hooks.Stop[0].hooks.push({ type: 'command', command: 'new-user-hook' });
  config.hooks.UserPromptSubmit[0].hooks[0].timeout = 11;
  config.newSetting = true;
  await writeFile(configPath(o), JSON.stringify(config));
  const status = await statusCliLearning(o);
  assert.equal(status.configured, false);
  assert.equal(status.state, 'partial');
  const removed = await removeCliLearning(o);
  assert.ok(removed.warnings.some((s) => s.includes('modified')));
  assert.ok(removed.warnings.some((s) => s.includes('trust key')));
  const after = await readConfig(o);
  assert.equal(after.newSetting, true);
  assert.deepEqual(after.hooks.Stop, [{ hooks: [{ type: 'command', command: 'new-user-hook' }] }], 'capture stops even when preserving an edited group would keep the old native trust key');
  assert.equal(after.hooks.UserPromptSubmit[0].hooks[0].timeout, 11, 'modified commands are not ours to remove');
});

test('rejects malformed JSON or hook shapes without overwriting them', async (t) => {
  for (const text of ['{ invalid', '{"hooks": []}', '{"hooks":{"Stop": {}}}', '{"hooks":{"Stop":[{"hooks":"bad"}]}}']) {
    const o = await fixture(t);
    await seed(o, {});
    await writeFile(configPath(o), text);
    await assert.rejects(installCliLearning(o), /Invalid/);
    assert.equal(await readFile(configPath(o), 'utf8'), text);
  }
});

test('rejects a non-loopback URL or credentials before writing any files', async (t) => {
  const o = await fixture(t);
  const credentialsUrl = new URL('http://localhost:7340');
  credentialsUrl.username = 'test-user';
  credentialsUrl.password = 'not-a-secret';
  for (const url of ['https://example.com', credentialsUrl.href, 'http://127.0.0.1:7340?token=secret', 'file:///tmp/server']) {
    await assert.rejects(installCliLearning({ ...o, url }), /loopback|credentials/);
  }
  await assert.rejects(readFile(configPath(o)), { code: 'ENOENT' });
});

test('never follows project configuration symlinks into another scope', async (t) => {
  const o = await fixture(t);
  const outside = await fixture(t);
  await writeFile(join(outside.project, 'hooks.json'), '{"keep":true}');
  await symlink(outside.project, join(o.project, '.codex'), 'dir');
  await assert.rejects(installCliLearning(o), /symlink/);
  assert.equal(await readFile(join(outside.project, 'hooks.json'), 'utf8'), '{"keep":true}');
});

test('quotes command and project arguments without interpolation or executing a shell', async (t) => {
  const o = await fixture(t);
  const command = ['node', "/opt/agent's dir/$(touch NEVER)/cli.js"];
  await installCliLearning({ ...o, command });
  const handler = (await readConfig(o)).hooks.Stop[0].hooks[0];
  assert.match(handler.command, /'\/opt\/agent'"'"'s dir\/\$\(touch NEVER\)\/cli\.js'/);
  assert.match(handler.command, /'learning' 'hook' '--runtime' 'codex'/);
  assert.equal(handler.async, undefined, 'bounded synchronous enqueue cannot be killed as detached CLI work');
});

test('changing an installed target requires disconnect first, preserving the old hooks', async (t) => {
  const o = await fixture(t);
  await installCliLearning(o);
  const before = await readFile(configPath(o), 'utf8');
  await assert.rejects(installCliLearning({ ...o, url: 'http://127.0.0.1:7341' }), /disconnect/);
  assert.equal(await readFile(configPath(o), 'utf8'), before);
});

test('disconnect preserves pre-existing empty hook groups and events', async (t) => {
  const o = await fixture(t);
  const existing = { hooks: { Stop: [{ hooks: [] }], UserPromptSubmit: [] } };
  await seed(o, existing);
  await installCliLearning(o);
  await removeCliLearning(o);
  assert.deepEqual(await readConfig(o), existing);
});

test('disconnect still clears its receipt when the user already removed the configuration directory', async (t) => {
  const o = await fixture(t);
  await installCliLearning(o);
  await rm(join(o.project, '.codex'), { recursive: true });
  assert.equal((await removeCliLearning(o)).configured, false);
  await assert.rejects(readFile(configPath(o)), { code: 'ENOENT' });
  assert.equal((await statusCliLearning(o)).state, 'not-installed');
});
