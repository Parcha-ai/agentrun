import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, symlink, rename, open, readlink, utimes, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { exportSourceSnapshot, sourceSnapshotDigest } from '../dist/native/source-snapshot.js';

const trusted = project => `[projects.${JSON.stringify(project)}]\ntrust_level = \"trusted\"\n`;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t, runtime = 'codex') {
  const root = await mkdtemp(join(tmpdir(), 'source-snapshot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'), home = join(root, 'home');
  await mkdir(project); await mkdir(home);
  const target = { runtime, project, selector: { kind: 'project' }, machine_id: 'fixture-machine', version: runtime === 'codex' ? '0.171.0' : '2.1.322', model: runtime === 'codex' ? 'gpt-5.5' : 'fixture-model',
    fingerprint: 'discovery-label-only', configuration: [], skills: [], mcp_servers: [], state: 'needs_verification', issues: [],
    capabilities: { launch: true, learning: true, workflows: false, approval: 'native', usage: true } };
  const put = async (path, bytes, policy = false, mode = 0o644) => {
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes, { mode });
    if (policy) { target.configuration = target.configuration.filter(x => x.path !== path); target.configuration.push({ path, sha256: sha(bytes) }); }
  };
  // Explicit portable source fixtures: account integrations are disabled at the source, and
  // Claude's selected authored agent has a concrete tool list. Defaults get separate refusal tests.
  if (runtime === 'codex') {
    await put(join(home, '.codex', 'config.toml'), trusted(project), true);
    await put(join(project, '.codex', 'config.toml'), '[features]\napps = false\nplugins = false\nimage_generation = false\n[cloud.skills]\nenabled = false\n', true);
  } else {
    await put(join(home, '.claude', 'settings.json'), '{"agent":"source"}', true);
    await put(join(home, '.claude', 'agents', 'source.md'), '---\nname: source\ntools: [Read, Write, Edit, Bash]\n---\n', true);
  }
  return { root, project, home, target, put,
    snapshot: extra => exportSourceSnapshot({ target, home, authorizedRoots: [project, home], ...extra }) };
}
const file = (snapshot, path) => snapshot.entries.find(x => x.path === path);
const content = (snapshot, path) => Buffer.from(snapshot.blobs[file(snapshot, path).sha256], 'base64');
const command = (cwd, ...args) => execFileSync('git', args, { cwd, env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });

for (const runtime of ['codex', 'claude-code']) test(`${runtime}: full authored assets, exact modes, deterministic no-op and references-only digest`, async t => {
  const f = await fixture(t, runtime), dir = runtime === 'codex' ? '.codex' : '.claude';
  const instruction = runtime === 'codex' ? 'AGENTS.md' : 'CLAUDE.md';
  await f.put(join(f.home, dir, instruction), 'Global source policy.', true);
  await f.put(join(f.project, instruction), 'Project source policy.', true);
  const skill = join(f.home, dir, 'skills', 'build');
  await f.put(join(skill, 'SKILL.md'), 'Read refs/guide.txt and run scripts/check.sh.', true);
  await f.put(join(skill, 'refs', 'guide.txt'), 'Authored reference one.');
  await f.put(join(skill, 'scripts', 'check.sh'), '#!/bin/sh\nexit 0\n', false, 0o755);
  await f.put(join(skill, 'image.bin'), Buffer.from([0, 255, 2, 128]));
  await f.put(join(skill, 'same.bin'), Buffer.from([0, 255, 2, 128]));
  f.target.skills.push('build');
  await f.put(join(f.project, 'work.txt'), 'Untracked work.');
  const first = await f.snapshot(); assert.equal(first.complete, true, JSON.stringify(first.blockers));
  assert.equal(first.instructions.text, 'Global source policy.\n\nProject source policy.');
  assert.ok(!first.instructions.text.includes('grader'));
  const prefix = first.skills[0].path;
  assert.equal(content(first, `${prefix}/refs/guide.txt`).toString(), 'Authored reference one.');
  assert.equal(file(first, `${prefix}/scripts/check.sh`).mode, 0o755);
  assert.deepEqual(content(first, `${prefix}/image.bin`), Buffer.from([0, 255, 2, 128]));
  assert.equal(file(first, `${prefix}/image.bin`).sha256, file(first, `${prefix}/same.bin`).sha256);
  assert.equal(first.digest, sourceSnapshotDigest(first));
  await utimes(join(skill, 'refs', 'guide.txt'), new Date(0), new Date(0));
  assert.equal((await f.snapshot()).digest, first.digest, 'timestamps do not create a new version');
  await f.put(join(skill, 'refs', 'guide.txt'), 'Authored reference two.');
  const changed = await f.snapshot(); assert.notEqual(changed.digest, first.digest);
  assert.equal((await f.snapshot()).digest, changed.digest, 'a repeated export is a no-op');
});

test('Codex override and selected profile preserve explicit source precedence', async t => {
  const f = await fixture(t);
  await f.put(join(f.home, '.codex', 'AGENTS.md'), 'Inactive global policy.', true);
  await f.put(join(f.home, '.codex', 'AGENTS.override.md'), 'Active global policy.', true);
  await f.put(join(f.project, 'AGENTS.md'), 'Project policy.', true);
  await f.put(join(f.home, '.codex', 'config.toml'), 'model = "gpt-5.5"\napproval_policy = "on-request"\n' + trusted(f.project), true);
  await f.put(join(f.home, '.codex', 'review.config.toml'), 'model = "gpt-5.6-sol"\n', true);
  await f.put(join(f.home, '.codex', 'other.config.toml'), 'hooks = ["unselected-hook"]\n', true);
  f.target.selector = { kind: 'profile', name: 'review' };
  const s = await f.snapshot(); assert.equal(s.complete, true, JSON.stringify(s.blockers));
  assert.equal(s.configuration.model, 'gpt-5.6-sol');
  assert.equal(s.configuration.permissions.approval_policy, 'on-request');
  assert.equal(s.instructions.text, 'Active global policy.\n\nProject policy.');
});

test('Claude named agent carries body, permission restrictions and model after project policy', async t => {
  const f = await fixture(t, 'claude-code');
  await f.put(join(f.project, 'CLAUDE.md'), 'Project policy.', true);
  await f.put(join(f.home, '.claude', 'agents', 'review.md'), '---\nname: review\nmodel: fixture-review\ntools: [Read]\ndisallowedTools: [Bash]\n---\nReview source files.\n', true);
  f.target.selector = { kind: 'agent', name: 'review' };
  const s = await f.snapshot(); assert.equal(s.complete, true, JSON.stringify(s.blockers));
  assert.equal(s.configuration.model, 'fixture-review');
  assert.deepEqual(s.configuration.permissions.disallowedTools, ['Bash']);
  assert.equal(s.instructions.text, 'Project policy.\n\nReview source files.\n');
});

test('Git snapshot includes bounded HEAD history, dirty/untracked files and deletions without ignored files', async t => {
  const f = await fixture(t);
  command(f.project, 'init', '--quiet');
  await f.put(join(f.project, '.gitignore'), 'ignored.txt\n');
  await f.put(join(f.project, 'tracked.txt'), 'Committed original.');
  await f.put(join(f.project, 'deleted.txt'), 'Deleted after commit.');
  command(f.project, 'add', '.');
  command(f.project, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Initial fixture');
  const head = command(f.project, 'rev-parse', 'HEAD').toString().trim();
  await f.put(join(f.project, 'tracked.txt'), 'Dirty current work.');
  await f.put(join(f.project, 'untracked.txt'), 'New current work.');
  await f.put(join(f.project, 'private-dir', 'file.txt'), 'Directory mode.');
  await chmod(join(f.project, 'private-dir'), 0o700); await chmod(f.project, 0o750);
  await f.put(join(f.project, 'ignored.txt'), 'Ignored content.');
  await rm(join(f.project, 'deleted.txt'));
  const s = await f.snapshot(); assert.equal(s.complete, true, JSON.stringify(s.blockers));
  assert.equal(s.project.git.head, head); assert.equal(s.project.git.dirty, true);
  assert.deepEqual(s.project.git.deleted, ['deleted.txt']); assert.equal(s.project.git.history, 'complete');
  assert.equal(content(s, 'project/tracked.txt').toString(), 'Dirty current work.');
  assert.equal(content(s, 'project/untracked.txt').toString(), 'New current work.');
  assert.equal(file(s, 'project/ignored.txt'), undefined);
  assert.equal(file(s, 'project').mode, 0o750);
  assert.equal(file(s, 'project/private-dir').mode, 0o700);
  const bundle = join(f.root, 'snapshot.bundle'); await writeFile(bundle, Buffer.from(s.blobs[s.project.git.bundle.sha256], 'base64'));
  command(f.project, 'bundle', 'verify', bundle);
  assert.equal((await f.snapshot()).digest, s.digest, 'unchanged Git content has one deterministic snapshot');
});

test('credentials are never copied; references remain resolvable destination requirements', async t => {
  const f = await fixture(t), literal = 'fixture-secret-value';
  await f.put(join(f.home, '.codex', 'auth.json'), JSON.stringify({ access_token: literal }));
  await f.put(join(f.home, '.codex', 'config.toml'), '[mcp_servers.docs]\nurl = "https://docs.example.invalid/mcp"\nbearer_token_env_var = "DOCS_ACCESS_TOKEN"\n' + trusted(f.project), true);
  f.target.mcp_servers = ['docs'];
  const safe = await f.snapshot(); assert.equal(safe.complete, false);
  assert.ok(safe.blockers.some(item => item.code === "native_account_policy"));
  assert.deepEqual(safe.configuration.tools[0].credentials, ['DOCS_ACCESS_TOKEN']);
  assert.ok(!JSON.stringify(safe).includes(literal));
  await f.put(join(f.project, '.mcp.json'), JSON.stringify({ mcpServers: { private: { url: 'https://private.example.invalid/mcp', headers: { Authorization: literal } } } }));
  const blocked = await f.snapshot(); assert.equal(blocked.complete, false);
  assert.ok(blocked.blockers.some(x => x.code === 'secret_content'));
  assert.ok(!Object.values(blocked.blobs).some(value => Buffer.from(value, 'base64').includes(Buffer.from(literal))));
  assert.equal(file(blocked, 'project/.mcp.json'), undefined);
});

test('historical credential files block the Git bundle even after deletion', async t => {
  const f = await fixture(t); command(f.project, 'init', '--quiet');
  await f.put(join(f.project, 'auth.json'), JSON.stringify({ token: 'fixture-secret-value' }));
  command(f.project, 'add', '.'); command(f.project, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Historical fixture');
  command(f.project, 'rm', '--quiet', 'auth.json'); command(f.project, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Remove fixture');
  const s = await f.snapshot(); assert.equal(s.complete, false); assert.equal(s.project.git.bundle, undefined);
  assert.ok(s.blockers.some(x => x.code === 'git_history'));
});

test('Git never invokes a configured fsmonitor and refuses external object alternates', async t => {
  const f = await fixture(t); command(f.project, 'init', '--quiet');
  await f.put(join(f.project, 'work.txt'), 'Safe source.'); command(f.project, 'add', '.');
  command(f.project, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Fixture');
  const marker = join(f.root, 'hook-ran'), monitor = join(f.home, 'monitor.sh');
  await f.put(monitor, `#!/bin/sh\nprintf ran > '${marker}'\n`, false, 0o755);
  command(f.project, 'config', 'core.fsmonitor', monitor);
  const s = await f.snapshot(); assert.equal(s.complete, true, JSON.stringify(s.blockers));
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  await f.put(join(f.project, '.git', 'objects', 'info', 'alternates'), `${join(f.root, 'outside-objects')}\n`);
  const blocked = await f.snapshot(); assert.equal(blocked.complete, false); assert.equal(blocked.project.git, null);
  assert.ok(blocked.blockers.some(x => x.code === 'git_control'));
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('new authored skills are discovered independently of metadata-only skill fingerprints', async t => {
  const f = await fixture(t); const before = await f.snapshot();
  await f.put(join(f.home, '.codex', 'skills', 'new-skill', 'SKILL.md'), 'New authored skill.');
  await f.put(join(f.home, '.codex', 'skills', 'new-skill', 'refs', 'source.md'), 'New reference.');
  const after = await f.snapshot(); assert.equal(after.complete, true, JSON.stringify(after.blockers));
  assert.notEqual(after.digest, before.digest); assert.equal(after.skills[0].name, 'new-skill');
  assert.equal(content(after, `${after.skills[0].path}/refs/source.md`).toString(), 'New reference.');
});

test('unsupported hooks, stdio, imports and unhandled policy never report complete', async t => {
  const f = await fixture(t, 'claude-code');
  await f.put(join(f.project, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [] }, enabledPlugins: { fixture: true } }), true);
  await f.put(join(f.project, '.mcp.json'), JSON.stringify({ mcpServers: { local: { command: 'fixture-command' } } }), true);
  await f.put(join(f.project, 'CLAUDE.md'), 'Read @policy.md before work.', true);
  const s = await f.snapshot(); assert.equal(s.complete, false);
  for (const code of ['unsupported_setting', 'stdio_tool', 'instruction_import']) assert.ok(s.blockers.some(x => x.code === code), code);
});

test('links, including chains and a linked authorized root, never export target bytes', async t => {
  const f = await fixture(t), outside = join(f.root, 'outside');
  await mkdir(outside); await writeFile(join(outside, 'private.txt'), 'Outside-grant bytes.');
  await symlink(outside, join(f.project, 'second')); await symlink('second/private.txt', join(f.project, 'first'));
  const s = await f.snapshot(); assert.equal(s.complete, false);
  assert.ok(!Object.values(s.blobs).some(value => Buffer.from(value, 'base64').toString().includes('Outside-grant bytes.')));
  const alias = join(f.root, 'alias'); await symlink(outside, alias);
  const linked = await exportSourceSnapshot({ target: { ...f.target, project: alias }, home: f.home, authorizedRoots: [alias, f.home] });
  assert.equal(linked.complete, false); assert.equal(linked.entries.length, 0);
});

test('per-file and traversal bounds refuse incomplete content without truncating it', async t => {
  const f = await fixture(t); await f.put(join(f.project, 'large.txt'), 'abcdefghijk');
  const s = await f.snapshot({ limits: { fileBytes: 10 } }); assert.equal(s.complete, false); assert.equal(file(s, 'project/large.txt'), undefined);
  await f.put(join(f.project, 'second.txt'), 'Second.');
  const bounded = await f.snapshot({ limits: { files: 1 } }); assert.equal(bounded.complete, false);
  assert.ok(bounded.blockers.some(x => x.code === 'limit'));
});

test('expanded destination copies obey the byte bound even when their content blob is shared', async t => {
  const f = await fixture(t), skill = join(f.project, '.codex', 'skills', 'same', 'SKILL.md');
  await f.put(skill, 'Same.', true); f.target.skills = ['same'];
  const s = await f.snapshot({ limits: { bytes: 7 } });
  assert.equal(s.complete, false, 'project and authored-skill namespaces would materialize ten bytes from one five-byte blob');
  assert.ok(s.blockers.some(x => x.code === 'limit'));
  assert.ok(s.entries.reduce((sum, entry) => sum + entry.bytes, 0) <= 7);
});

test('a changed source file is rejected instead of committing mixed bytes', async t => {
  const f = await fixture(t), path = join(f.project, 'mutable.txt'); await f.put(path, 'Before.');
  const probe = await open(path); const prototype = Object.getPrototypeOf(probe); await probe.close();
  const original = prototype.read; let changed = false;
  t.mock.method(prototype, 'read', async function (...args) {
    const got = await original.apply(this, args);
    if (!changed && await readlink(`/proc/self/fd/${this.fd}`) === path) { changed = true; await writeFile(path, 'After changed bytes.'); }
    return got;
  });
  await assert.rejects(f.snapshot(), error => error.code === 'source_changed'); assert.equal(changed, true);
});

test('a parent swapped for an outside symlink during read cannot redirect the opened file', async t => {
  const f = await fixture(t), parent = join(f.project, 'folder'), path = join(parent, 'data.txt'), outside = join(f.root, 'outside');
  await f.put(path, 'Inside.'); await mkdir(outside); await writeFile(join(outside, 'data.txt'), 'Outside.');
  const probe = await open(path); const prototype = Object.getPrototypeOf(probe); await probe.close();
  const original = prototype.read; let swapped = false, outsideRead = false;
  t.mock.method(prototype, 'read', async function (...args) {
    const opened = await readlink(`/proc/self/fd/${this.fd}`); if (opened.startsWith(outside)) outsideRead = true;
    if (!swapped && opened === path) { swapped = true; await rename(parent, join(f.project, 'old-folder')); await symlink(outside, parent); }
    return original.apply(this, args);
  });
  await assert.rejects(f.snapshot(), error => error.code === 'source_changed'); assert.equal(swapped, true); assert.equal(outsideRead, false);
});


test('unsupported source platforms fail explicitly instead of using a path-based fallback', async t => {
  const f = await fixture(t), descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  try { await assert.rejects(f.snapshot(), error => error.code === 'unsupported_platform'); }
  finally { Object.defineProperty(process, 'platform', descriptor); }
});

test('cancelled source export does not continue reading or run Git', async t => {
  const f = await fixture(t), controller = new AbortController(); controller.abort();
  await assert.rejects(f.snapshot({ signal: controller.signal }), /abort/i);
});

for (const runtime of ['codex', 'claude-code']) test(`${runtime}: unsupported MCP capability restrictions block a complete snapshot`, async t => {
  const f = await fixture(t, runtime);
  const path = runtime === 'codex' ? join(f.home, '.codex', 'config.toml') : join(f.project, '.mcp.json');
  const settings = runtime === 'codex'
    ? '[mcp_servers.docs]\nurl="https://tools.example.invalid/mcp"\nenabled_tools=["read"]\ndisabled_tools=["delete"]\n'
    : JSON.stringify({ mcpServers: { docs: { url: 'https://tools.example.invalid/mcp', enabled_tools: ['read'], disabled_tools: ['delete'] } } });
  await f.put(path, settings, true);
  const snapshot = await f.snapshot();
  assert.equal(snapshot.complete, false, 'source restrictions must not become a full-capability destination server');
  assert.ok(snapshot.blockers.some(blocker => blocker.code === 'tool_configuration'));
});

test('raw instruction content retains its original UTF-8 BOM alongside the captured file bytes', async t => {
  const f = await fixture(t), content = '\ufeffOriginal source instructions.\n';
  await f.put(join(f.project, 'AGENTS.md'), content, true);
  const snapshot = await f.snapshot();
  assert.equal(snapshot.instructions.text, content);
  assert.equal(Buffer.from(snapshot.blobs[snapshot.entries.find(entry => entry.role === 'instruction').sha256], 'base64').toString(), content);
});

test('Codex separate hook policy cannot disappear from a complete setup', async t => {
  const f = await fixture(t);
  await f.put(join(f.home, '.codex', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'review-command' }] }] } }));
  const snapshot = await f.snapshot();
  assert.equal(snapshot.complete, false);
  assert.ok(snapshot.blockers.some(blocker => blocker.code === 'hooks'));
});

test('multiple differing source definitions for one MCP server need resolved precedence', async t => {
  const f = await fixture(t, 'claude-code');
  await f.put(join(f.home, '.claude.json'), JSON.stringify({ mcpServers: { docs: { url: 'https://user.example.invalid/mcp' } } }), true);
  await f.put(join(f.project, '.mcp.json'), JSON.stringify({ mcpServers: { docs: { url: 'https://project.example.invalid/mcp' } } }), true);
  const snapshot = await f.snapshot();
  assert.equal(snapshot.complete, false);
  assert.ok(snapshot.blockers.some(blocker => blocker.code === 'tool_precedence'));
});

test('Git never opens source config includes added after validation outside the grant', async t => {
  const f = await fixture(t);
  command(f.project, 'init', '--quiet'); await f.put(join(f.project, 'work.txt'), 'Fixture content.'); command(f.project, 'add', '.');
  command(f.project, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Fixture');
  const outside = join(f.root, 'outside-configuration'); execFileSync('mkfifo', [outside]);
  const cp = (await import('node:child_process')).default, nativeFs = await import('node:fs'), { syncBuiltinESMExports } = await import('node:module');
  const original = cp.spawn; let changed = false, outsideRead = false;
  let observe = Promise.resolve();
  cp.spawn = function (binary, args, options) {
    if (binary === 'git' && !changed) {
      changed = true;
      nativeFs.appendFileSync(join(f.project, '.git', 'config'), `\n[include]\n path = ${outside}\n`);
      observe = (async () => {
        for (const until = Date.now() + 1000; Date.now() < until;) {
          try {
            // A nonblocking FIFO writer only opens when another process has opened its read end.
            // This observes the actual Git read; no test-only exporter branch or path assertion.
            const fd = nativeFs.openSync(outside, nativeFs.constants.O_WRONLY | nativeFs.constants.O_NONBLOCK);
            outsideRead = true; nativeFs.writeSync(fd, '[fixture]\n value = synthetic\n'); nativeFs.closeSync(fd); return;
          } catch (error) { if (error.code !== 'ENXIO') throw error; }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      })();
    }
    return original.call(this, binary, args, options);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(f.snapshot(), error => error.code === 'source_changed'); await observe;
    assert.equal(changed, true); assert.equal(outsideRead, false, 'postflight rejection alone cannot undo an unauthorized configuration read');
  } finally { cp.spawn = original; syncBuiltinESMExports(); }
});

test('a held credential in an empty directory name never reaches entries or diagnostics', async t => {
  const f = await fixture(t), held = ['fixture', 'private', 'value'].join('-');
  await mkdir(join(f.project, held));
  const snapshot = await f.snapshot({ secretValues: [held] });
  assert.equal(snapshot.complete, false);
  assert.equal(JSON.stringify(snapshot).includes(held), false);
});

for (const runtime of ['codex', 'claude-code']) test(`${runtime}: exact owned capture hooks have an explicit, independently reproducible destination transform`, async t => {
  const f = await fixture(t, runtime), { installCliLearning } = await import('../dist/cli-learning/install.js');
  await installCliLearning({ project: f.project, runtime, dataDir: join(f.home, 'source-data') });
  const hooksPath = runtime === 'codex' ? '.codex/hooks.json' : '.claude/settings.local.json';
  const original = await readFile(join(f.project, hooksPath));
  const snapshot = await f.snapshot();
  assert.equal(snapshot.complete, true, JSON.stringify(snapshot.blockers));
  assert.equal(snapshot.transforms.length, 1);
  const transform = snapshot.transforms[0];
  assert.equal(transform.kind, 'agentrun-capture-hooks'); assert.equal(transform.path, `project/${hooksPath}`);
  assert.equal(transform.original_sha256, sha(original));
  assert.equal(snapshot.entries.find(entry => entry.path === transform.path).sha256, sha(original));
  assert.equal(Buffer.from(snapshot.blobs[transform.destination_sha256], 'base64').toString(), '{}\n');
  assert.equal(transform.receipt.path, `project/.agentrun/cli-learning/${runtime}.json`);
  assert.equal((await readFile(join(f.project, hooksPath))).toString(), original.toString(), 'no source hooks were changed');
  const user = JSON.parse(original); user.hooks.PreToolUse = [{ hooks: [{ type: 'command', command: 'user-policy', timeout: 3 }] }];
  await writeFile(join(f.project, hooksPath), JSON.stringify(user));
  const mixed = await f.snapshot();
  assert.equal(mixed.complete, false, 'user policy still needs its own managed equivalent');
  const destination = JSON.parse(Buffer.from(mixed.blobs[mixed.transforms[0].destination_sha256], 'base64'));
  assert.equal(destination.hooks.PreToolUse[0].hooks[0].command, 'user-policy');
});

test('a changed capture command cannot be exempted merely by updating its ownership receipt', async t => {
  const f = await fixture(t), { installCliLearning } = await import('../dist/cli-learning/install.js');
  await installCliLearning({ project: f.project, runtime: 'codex', dataDir: join(f.home, 'source-data'), command: ['/fixture/custom-program'] });
  const snapshot = await f.snapshot();
  assert.equal(snapshot.complete, false); assert.equal(snapshot.transforms.length, 0);
  assert.ok(snapshot.blockers.some(blocker => blocker.code === 'hooks'));
});

test('linked Codex checkout records shared owned hooks without fabricating a local project file', async t => {
  const f = await fixture(t), { installCliLearning } = await import('../dist/cli-learning/install.js');
  command(f.project, 'init', '--quiet'); await f.put(join(f.project, 'README.md'), 'Fixture project.'); command(f.project, 'add', '.');
  command(f.project, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Fixture');
  const linked = join(f.home, 'linked'); command(f.project, 'worktree', 'add', '--quiet', '-b', 'fixture-linked', linked);
  await installCliLearning({ project: linked, runtime: 'codex', dataDir: join(f.home, 'source-data') });
  f.target.project = linked; f.target.configuration = f.target.configuration.map(file => ({ ...file, path: file.path.startsWith(f.project + '/') ? linked + file.path.slice(f.project.length) : file.path }));
  await f.put(join(f.home, '.codex', 'config.toml'), trusted(linked), true);
  const snapshot = await f.snapshot();
  assert.equal(snapshot.complete, true, JSON.stringify(snapshot.blockers));
  assert.equal(snapshot.transforms.length, 1);
  assert.match(snapshot.transforms[0].path, /^instructions\/capture-hooks\/[a-f0-9]+\/hooks.json$/);
  assert.equal(snapshot.entries.some(entry => entry.path === 'project/.codex/hooks.json'), false);
});

test('Codex exports only the selected project trust decision, not unrelated project policies', async t => {
  const f = await fixture(t);
  await f.put(join(f.home, '.codex', 'config.toml'), `model = "gpt-5.5"\napproval_policy = "never"\nsandbox_mode = "workspace-write"\n[projects.${JSON.stringify(f.project)}]\ntrust_level = "trusted"\n[projects."/unrelated-project"]\ntrust_level = "untrusted"\n`, true);
  const s = await f.snapshot();
  assert.equal(s.complete, true, JSON.stringify(s.blockers));
  assert.equal(s.configuration.permissions.project_trust, 'trusted');
  assert.equal(Object.hasOwn(s.configuration.permissions, 'projects'), false);
  assert.equal(s.configuration.permissions.approval_policy, 'never');
  await f.put(join(f.home, '.codex', 'config.toml'), `[projects.${JSON.stringify(f.project)}]\ntrust_level = "untrusted"\n`, true);
  assert.equal((await f.snapshot()).configuration.permissions.project_trust, 'untrusted');
});

test('Claude project bypass mode cannot replace effective user permission policy', async t => {
  const f = await fixture(t, 'claude-code'); f.target.version = '2.1.322';
  await f.put(join(f.home, '.claude', 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'default' } }), true);
  await f.put(join(f.project, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }), true);
  const s = await f.snapshot();
  assert.equal(s.complete, false);
  assert.ok(s.blockers.some(x => x.code === 'permission_scope'));
  assert.equal(s.configuration.permissions.defaultMode, 'default');
});

test('Claude permission lists preserve all source layers instead of overwriting earlier restrictions', async t => {
  const f = await fixture(t, 'claude-code');
  await f.put(join(f.home, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['Bash(rm *)'], allow: ['Read'] } }), true);
  await f.put(join(f.project, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['WebFetch'], allow: ['Grep'] } }), true);
  const s = await f.snapshot();
  assert.deepEqual(s.configuration.permissions.deny, ['Bash(rm *)', 'WebFetch']);
  assert.deepEqual(s.configuration.permissions.allow, ['Read', 'Grep']);
});

test('a held credential in a packed Git branch name is withheld from snapshot metadata', async t => {
  const f = await fixture(t), secret = 'fixture-private-branch-value';
  command(f.project, 'init', '--quiet'); await f.put(join(f.project, 'safe.txt'), 'Safe history.');
  command(f.project, 'add', 'safe.txt');
  command(f.project, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Initial fixture');
  command(f.project, 'branch', '-m', secret); command(f.project, 'pack-refs', '--all', '--prune');
  const snapshot = await f.snapshot({ secretValues: [secret] });
  assert.equal(snapshot.complete, false);
  assert.equal(JSON.stringify(snapshot).includes(secret), false);
});

test('Codex implicit cached search and explicit tool disables are represented, not reduced to MCP', async t => {
  const f = await fixture(t), snapshot = await f.snapshot();
  assert.equal(snapshot.configuration.native_tools.complete, true, JSON.stringify(snapshot.blockers));
  assert.equal(snapshot.configuration.permissions.web_search, 'cached');
  assert.ok(snapshot.configuration.native_tools.capabilities.includes('web_search'));
  assert.ok(snapshot.configuration.native_tools.capabilities.includes('shell'));
  assert.ok(snapshot.configuration.native_tools.disabled.includes('apps'));
  await f.put(join(f.project, '.codex', 'config.toml'), 'web_search = "disabled"\n[features]\napps = false\nplugins = false\nimage_generation = false\nshell_tool = false\nview_image = false\nmulti_agent = false\n[cloud.skills]\nenabled = false\n', true);
  const disabled = await f.snapshot();
  assert.equal(disabled.configuration.native_tools.complete, true);
  for (const capability of ['shell', 'web_search', 'image_read', 'subagents']) {
    assert.ok(disabled.configuration.native_tools.disabled.includes(capability));
    assert.ok(!disabled.configuration.native_tools.capabilities.includes(capability));
  }
});

test('unresolved default account integrations and unsupported native versions never claim complete closure', async t => {
  const f = await fixture(t);
  await f.put(join(f.project, '.codex', 'config.toml'), '', true);
  const unknown = await f.snapshot();
  assert.equal(unknown.complete, false); assert.equal(unknown.configuration.native_tools.complete, false);
  assert.ok(unknown.blockers.some(x => x.code === 'native_apps'));
  assert.ok(unknown.blockers.some(x => x.code === 'native_cloud_skills'));
  f.target.version = '0.172.0';
  assert.ok((await f.snapshot()).blockers.some(x => x.code === 'native_version'));
});

test('a model cache that changes native tools cannot silently use the bundled model assumptions', async t => {
  const f = await fixture(t);
  await f.put(join(f.home, '.codex', 'models_cache.json'), JSON.stringify({ client_version: '0.171.0', identity: 'fixture-account-scope', models: [{ slug: 'gpt-5.5', shell_type: 'disabled', apply_patch_tool_type: null, multi_agent_version: null, use_responses_lite: false, experimental_supported_tools: [] }] }));
  const snapshot = await f.snapshot();
  assert.equal(snapshot.complete, false);
  assert.ok(snapshot.blockers.some(x => x.code === 'native_model_catalog'));
  assert.ok(!JSON.stringify(snapshot).includes('fixture-account-scope'), 'cache identity is inspected locally, not exported');
});

test('Claude explicit agent tool closure preserves its allowlist and rejects unresolved default tools', async t => {
  const f = await fixture(t, 'claude-code');
  await f.put(join(f.home, '.claude', 'agents', 'source.md'), '---\nname: source\ntools: [Read, Write, Bash]\ndisallowedTools: [Bash]\n---\n', true);
  const snapshot = await f.snapshot();
  assert.equal(snapshot.complete, true, JSON.stringify(snapshot.blockers));
  assert.deepEqual(snapshot.configuration.native_tools.capabilities, ['file_read', 'file_write', 'image_read', 'session_end']);
  assert.ok(snapshot.configuration.native_tools.disabled.includes('shell'));
  await f.put(join(f.home, '.claude', 'settings.json'), '{}', true);
  const defaults = await f.snapshot();
  assert.equal(defaults.complete, false); assert.ok(defaults.blockers.some(x => x.code === 'native_tool_list'));
});

test('Codex asynchronous user messaging remains required when question prompts are disabled', async t => {
  const f = await fixture(t); f.target.model = 'gpt-6.2-sol';
  await f.put(join(f.home, '.codex', 'config.toml'), '[tools.experimental_request_user_input]\nenabled = false\n' + trusted(f.project), true);
  const snapshot = await f.snapshot();
  assert.ok(snapshot.configuration.native_tools.capabilities.includes('user_input'));
});

test('a cached model cannot add an async messaging tool outside its verified builtin set', async t => {
  const f = await fixture(t);
  await f.put(join(f.home, '.codex', 'models_cache.json'), JSON.stringify({ client_version: '0.171.0', identity: 'fixture-scope', models: [{ slug: 'gpt-5.5', shell_type: 'shell_command', apply_patch_tool_type: 'freeform', multi_agent_version: null, use_responses_lite: false, experimental_supported_tools: ['send_message_to_user_async'] }] }));
  assert.ok((await f.snapshot()).blockers.some(x => x.code === 'native_model_catalog'));
});

test('Claude explicit builtin allowlist cannot silently grant every configured MCP tool', async t => {
  const f = await fixture(t, 'claude-code');
  await f.put(join(f.project, '.mcp.json'), JSON.stringify({ mcpServers: { external: { type: 'http', url: 'https://tools.example.invalid/mcp' } } }), true);
  const snapshot = await f.snapshot();
  assert.equal(snapshot.complete, false);
  assert.ok(snapshot.blockers.some(x => x.code === 'native_mcp_selection'));
});

test('source environment model overrides are captured without exporting provider secrets', async t => {
  const f = await fixture(t, 'claude-code');
  const snapshot = await f.snapshot({ environment: { ANTHROPIC_MODEL: 'fixture-exact-env-model', ANTHROPIC_API_KEY: 'fake-test-key' }, secretValues: ['fake-test-key'] });
  assert.equal(snapshot.configuration.model, 'fixture-exact-env-model');
  assert.equal(JSON.stringify(snapshot).includes('fake-test-key'), false);
});

test('an inherited source Git executable is never run from the exported project', async t => {
  const f = await fixture(t);
  command(f.project, 'init', '--quiet'); await f.put(join(f.project, 'safe.txt'), 'Safe project.'); command(f.project, 'add', '.');
  command(f.project, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Fixture');
  const executable = join(f.project, 'bin', 'git'), marker = join(f.root, 'executed');
  await f.put(executable, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, false, 0o755);
  const old = process.env.PATH; process.env.PATH = `${join(f.project, 'bin')}:${old}`;
  try { await f.snapshot(); } finally { process.env.PATH = old; }
  await assert.rejects(readFile(marker), error => error.code === 'ENOENT');
});

test('Codex model-selected subagents need the actual agents disable, not the legacy feature alone', async t => {
  const f = await fixture(t); f.target.model = 'gpt-6-sol';
  await f.put(join(f.home, '.codex', 'config.toml'), '[features]\nmulti_agent = false\n' + trusted(f.project), true);
  assert.ok((await f.snapshot()).configuration.native_tools.capabilities.includes('subagents'));
  await f.put(join(f.home, '.codex', 'config.toml'), '[agents]\nenabled = false\n' + trusted(f.project), true);
  assert.ok((await f.snapshot()).configuration.native_tools.disabled.includes('subagents'));
});

test('Codex project settings cannot establish their own trust or override inactive layers', async t => {
  const f = await fixture(t);
  await f.put(join(f.project, '.codex', 'config.toml'), `model = "gpt-5.5"\n[features]\napps = false\nplugins = false\nimage_generation = false\n[cloud.skills]\nenabled = false\n[projects.${JSON.stringify(f.project)}]\ntrust_level = "trusted"\n`, true);
  for (const trust of [null, 'untrusted']) {
    await f.put(join(f.home, '.codex', 'config.toml'), trust === null ? '' : `[projects.${JSON.stringify(f.project)}]\ntrust_level = "${trust}"\n`, true);
    const snapshot = await f.snapshot();
    assert.equal(snapshot.complete, false, 'inactive project settings cannot yield a complete source');
    assert.ok(snapshot.blockers.some(item => item.code === 'project_configuration_trust'));
    assert.notEqual(snapshot.configuration.permissions.project_trust, 'trusted', 'project config cannot trust itself');
  }
});

for (const name of ['cloud-config-bundle-cache.json', 'auth.json']) test(`Codex ${name} cannot hide unverified account policy`, async t => {
  const f = await fixture(t), held = 'fixture-private-policy-value';
  await f.put(join(f.home, '.codex', name), JSON.stringify({ value: held }));
  const snapshot = await f.snapshot({ secretValues: [held] });
  assert.equal(snapshot.complete, false);
  assert.ok(snapshot.blockers.some(item => item.code === 'native_account_policy'));
  assert.equal(JSON.stringify(snapshot).includes(held), false, 'account material is never read into exported blobs');
});

test('Codex system requirements outside source roots are detected without exporting their contents', async t => {
  const f = await fixture(t), directory = join(f.root, 'system-policy'); await mkdir(directory);
  await f.put(join(directory, 'requirements.toml'), 'allowed_approval_policies = ["on-request"]');
  const fs = (await import('node:fs/promises')).default, { syncBuiltinESMExports } = await import('node:module');
  const original = fs.open; let probed = false;
  fs.open = async function (path, ...args) {
    const match = String(path).match(/^\/proc\/self\/fd\/(\d+)\/codex$/);
    if (match && await readlink(`/proc/self/fd/${match[1]}`) === '/etc') { probed = true; return original.call(this, directory, ...args); }
    return original.call(this, path, ...args);
  };
  syncBuiltinESMExports();
  try {
    const snapshot = await f.snapshot();
    assert.equal(snapshot.complete, false);
    assert.ok(snapshot.blockers.some(item => item.code === 'native_managed_policy'));
    assert.equal(probed, true);
    assert.equal(JSON.stringify(snapshot).includes('allowed_approval_policies'), false);
  } finally { fs.open = original; syncBuiltinESMExports(); }
});

for (const location of ['project', 'home', 'nested-project', 'explicit-config']) test(`consent-bound ${location} identity is checked before any replacement bytes are read`, async t => {
  const f = await fixture(t);
  let project = f.project, home = f.home, codexHome;
  if (location === 'nested-project') {
    project = join(home, 'nested-project'); await mkdir(project);
  }
  if (location === 'explicit-config') {
    codexHome = join(home, 'source-profile'); await mkdir(codexHome);
  }
  const roots = [project, home, ...(codexHome ? [codexHome] : [])];
  const expectedRoots = await Promise.all(roots.map(async path => {
    const info = await stat(path, { bigint: true }); return { path, device: info.dev.toString(), inode: info.ino.toString() };
  }));
  const replaced = location === 'home' ? home : location === 'explicit-config' ? codexHome : project;
  await rename(replaced, replaced + '-approved'); await mkdir(replaced);
  const marker = join(replaced, location === 'explicit-config' ? 'config.toml' : 'replacement.txt');
  await writeFile(marker, 'Unapproved replacement bytes.');
  const probe = await open(marker), prototype = Object.getPrototypeOf(probe); await probe.close();
  const original = prototype.read; let replacementRead = false;
  t.mock.method(prototype, 'read', async function (...args) {
    if (await readlink(`/proc/self/fd/${this.fd}`) === marker) replacementRead = true;
    return original.apply(this, args);
  });
  await assert.rejects(exportSourceSnapshot({ target: { ...f.target, project }, home, codexHome,
    authorizedRoots: roots, expectedRoots }), error => error.code === 'source_changed');
  assert.equal(replacementRead, false, 'an outer post-export scope check cannot undo an unauthorized read');
});

test('matching consent-bound roots retain normal exact snapshot behavior', async t => {
  const f = await fixture(t); await f.put(join(f.project, 'work.txt'), 'Approved content.');
  const expectedRoots = await Promise.all([f.project, f.home].map(async path => {
    const info = await stat(path, { bigint: true }); return { path, device: info.dev.toString(), inode: info.ino.toString() };
  }));
  const ordinary = await f.snapshot(), bound = await f.snapshot({ expectedRoots });
  assert.equal(bound.complete, true); assert.equal(bound.digest, ordinary.digest);
  assert.ok(!JSON.stringify(bound).includes('expectedRoots'));
});

test('consent identity is rechecked on descriptor traversal after initial validation', async t => {
  const f = await fixture(t); await f.put(join(f.project, 'original.txt'), 'Approved content.');
  const expectedRoots = await Promise.all([f.project, f.home].map(async path => {
    const info = await stat(path, { bigint: true }); return { path, device: info.dev.toString(), inode: info.ino.toString() };
  }));
  const probe = await open(f.home), prototype = Object.getPrototypeOf(probe); await probe.close();
  const originalStat = prototype.stat, originalRead = prototype.read; let swapped = false, replacementRead = false;
  t.mock.method(prototype, 'stat', async function (...args) {
    const info = await originalStat.apply(this, args);
    if (!swapped && args[0]?.bigint && await readlink(`/proc/self/fd/${this.fd}`) === f.home) {
      swapped = true; await rename(f.project, f.project + '-approved'); await mkdir(f.project);
      await writeFile(join(f.project, 'replacement.txt'), 'Unapproved replacement bytes.');
    }
    return info;
  });
  t.mock.method(prototype, 'read', async function (...args) {
    if (await readlink(`/proc/self/fd/${this.fd}`) === join(f.project, 'replacement.txt')) replacementRead = true;
    return originalRead.apply(this, args);
  });
  await assert.rejects(f.snapshot({ expectedRoots }), error => error.code === 'source_changed');
  assert.equal(swapped, true); assert.equal(replacementRead, false);
});
