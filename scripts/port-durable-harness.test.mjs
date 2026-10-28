// The port, checked offline: this tree is exactly what the port makes, and each planted break goes red by name.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkPort, header, parsePatch, portPackage, PORT_DIR, readPatches, upgradeReport } from './port-durable-harness.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const packageDir = join(root, 'packages', 'run-adapters');
const scratch = await mkdtemp(join(tmpdir(), 'agentrun-port-test-'));
after(() => rm(scratch, { recursive: true, force: true }));

let made = 0;
/** A copy of the package's inputs and committed output (no node_modules, no dist) with `plant` applied. */
async function copyOf(plant = async () => {}) {
  const dir = join(scratch, `p${made += 1}`);
  await cp(packageDir, dir, { recursive: true, filter: (path) => !/\/(?:node_modules|dist)(?:\/|$)/.test(path) });
  await plant(dir);
  return dir;
}
const edit = (file, change) => async (dir) => writeFile(join(dir, file), change(await readFile(join(dir, file), 'utf8')));
const table = (change) => edit(`${PORT_DIR}/imports.json`, (text) => JSON.stringify(change(JSON.parse(text)), null, 2));
const patchPath = (name) => `${PORT_DIR}/patches/harness-process/${name}.patch`;

test('the committed process copies are exactly what the pristine files, the patches and the import table make', async () => {
  assert.deepEqual(await checkPort(packageDir), []);
});

test('headers are generated from what was done to each file: its rewritten imports and the patches that touch it', async () => {
  const { files } = await portPackage(packageDir);
  const top = (path) => files.get(path).split('\n').slice(0, 3);
  assert.deepEqual(top('src/process/tail.ts').slice(2), ['// Changed by Parcha, patches: 002-message-prefix']);
  assert.match(top('src/process/builtins.ts')[2], /^\/\/ Changed by Parcha, imports rewritten for AgentRun; patches: 001-begin-reservation, 002-message-prefix, 003-comments-name-this-host$/);
  assert.match(top('src/process/inbox.ts')[2], /patches: 005-inbox-drop-wait-for-submissions$/);
  assert.equal(header({ upstreamPath: 'x.ts', importsRewritten: false, patches: [] }).split('\n')[2], '// Changed by Parcha, nothing');
  assert.match(top('src/process/records.ts')[0], /^\/\/ Copyright 2026 Vercel Inc\. Licensed under the Apache License, Version 2\.0; see LICENSE in this package\.$/);
});

test('--check names the file a committed byte differs in, and a file the port makes that is not committed', async () => {
  const body = await copyOf(edit('src/process/tools.ts', (text) => `${text} `));
  assert.match((await checkPort(body)).join('\n'), /src\/process\/tools\.ts: differs from the port's output/);
  const header = await copyOf(edit('src/process/tail.ts', (text) => text.replace('patches: 002-message-prefix', 'patches: none')));
  assert.match((await checkPort(header)).join('\n'), /src\/process\/tail\.ts: differs/);
  const missing = await copyOf((dir) => rm(join(dir, 'src/process/inbox.ts')));
  assert.match((await checkPort(missing)).join('\n'), /src\/process\/inbox\.ts: the port makes it and it is not committed/);
});

test('the table fails closed, by name: an unknown module, an unknown symbol and a gap', async () => {
  const unknownModule = await copyOf(table((t) => { delete t.modules['node:crypto']; return t; }));
  assert.match((await portPackage(unknownModule)).problems.join('\n'), /journal\.ts: import from node:crypto: module node:crypto is not in the import table/);
  const unknownSymbol = await copyOf(table((t) => { delete t.modules['harness-world'].symbols.Restart; return t; }));
  assert.match((await portPackage(unknownSymbol)).problems.join('\n'), /journal\.ts: import from harness-world: symbol Restart is not in the import table for harness-world/);
  const gap = await copyOf(table((t) => { t.modules['harness-world'].symbols.hostToolIO = 'gap'; return t; }));
  const problems = (await portPackage(gap)).problems.join('\n');
  assert.match(problems, /builtins\.ts: import from harness-world: symbol hostToolIO is a gap/);
  assert.match(problems, /tools\.ts: import from harness-world: symbol hostToolIO is a gap/);
  assert.notDeepEqual(await checkPort(gap), [], '--check fails with it');
});

test('a relative import must end in .ts and name a file of the manifest', async () => {
  const outside = await copyOf(async (dir) => {
    await edit('vendor/durable-harness/upstream/packages/harness-process/src/inbox.ts', (text) => `import { x } from './nowhere.ts';\n${text}`)(dir);
  });
  assert.match((await portPackage(outside)).problems.join('\n'), /nowhere\.ts is not a file of this manifest/);
});

test('each patch is a file with its reason: a missing field, a name that is not the file\'s and a patch that is not a patch are refused', () => {
  const ok = 'Patch: 001-x\nReason: r\nUpstream: ours\nPins: t\n---\ndiff --git a/p b/p\n--- a/p\n+++ b/p\n@@ -1 +1 @@\n-a\n+b\n';
  assert.equal(parsePatch('001-x', ok).Reason, 'r');
  assert.throws(() => parsePatch('001-x', ok.replace('Reason: r\n', '')), /patch 001-x: no Reason line/);
  assert.throws(() => parsePatch('001-y', ok), /patch 001-y: its Patch line says 001-x/);
  assert.throws(() => parsePatch('001-x', ok.replace('Upstream: ours', 'Upstream: maybe')), /Upstream is "offer" or "ours"/);
  assert.throws(() => parsePatch('001-x', ok.replace('Pins: t\n', '')), /no Pins line/);
  assert.throws(() => parsePatch('001-x', ok.replace('---\ndiff', 'diff')), /no "---" line/);
  assert.throws(() => parsePatch('001-x', ok.replace('Reason: r', 'Because: r')), /header line .* is not one of/);
  assert.throws(() => parsePatch('001-x', ok.replace('Pins: t', 'Pins: comments only')), /"Pins: comments only" but it changes code/);
});

test('a patch applies exactly: a changed line of context fails the port, naming the patch', async () => {
  const stale = await copyOf(edit(patchPath('002-message-prefix'), (text) => text.replace(/^ ( *\* failed\): the drive is halted)/m, '  $1 and more')));
  await assert.rejects(portPackage(stale), /patch 002-message-prefix does not apply/);
  // Exact context, not exact line numbers: upstream moving a hunk without changing it still applies.
  const shifted = await copyOf(edit('vendor/durable-harness/upstream/packages/harness-process/src/tail.ts', (text) => `// a new first line\n${text}`));
  const { files } = await portPackage(shifted, { cascade: false }).catch(() => ({ files: new Map() }));
  assert.ok(files.get('src/process/tail.ts')?.includes('agentrun-adapters:'), 'a hunk that moved applies');
});

test('a patch that changes nothing is named, and dropping a patch that others are written against fails loudly', async () => {
  const dead = await copyOf(async (dir) => {
    await writeFile(join(dir, patchPath('006-nothing')), 'Patch: 006-nothing\nReason: a patch with no effect\nUpstream: ours\nPins: comments only\n---\ndiff --git a/packages/harness-process/src/tail.ts b/packages/harness-process/src/tail.ts\n--- a/packages/harness-process/src/tail.ts\n+++ b/packages/harness-process/src/tail.ts\n@@ -1,2 +1,2 @@\n-// placeholder\n+// placeholder\n');
  });
  await assert.rejects(portPackage(dead), /patch 006-nothing does not apply/);
  await assert.rejects(portPackage(packageDir, { drop: ['001-begin-reservation'] }), /patch 002-message-prefix does not apply/);
  const cascaded = await portPackage(packageDir, { drop: ['001-begin-reservation'], cascade: true });
  assert.ok(!cascaded.files.get('src/process/builtins.ts').includes('private async again('), 'without 001 there is no reservation');
  assert.deepEqual((await readPatches(join(packageDir, PORT_DIR), 'harness-process')).map((p) => p.name), [
    '001-begin-reservation', '002-message-prefix', '003-comments-name-this-host', '004-comments-name-the-session-writer', '005-inbox-drop-wait-for-submissions',
  ]);
  for (const patch of await readPatches(join(packageDir, PORT_DIR), 'harness-process')) assert.ok(patch.Reason.length > 20, `${patch.name} says why`);
  assert.equal((await readPatches(join(packageDir, PORT_DIR), 'harness-process'))[0].Upstream, 'offer', 'begin() is the one offered upstream');
});

test('the mutant of every patch differs from the port: a patch whose absence changes nothing would be dead weight', async () => {
  const whole = await portPackage(packageDir);
  for (const patch of await readPatches(join(packageDir, PORT_DIR), 'harness-process')) {
    const without = await portPackage(packageDir, { drop: [patch.name], cascade: true });
    assert.ok([...whole.files].some(([path, text]) => without.files.get(path) !== text), `${patch.name} changes the output`);
  }
});

test('--pin reports an upgrade in three parts: the pristine diff, the table against the new text, the patches that fail', async () => {
  // A throwaway upstream repository holding two versions of one file of the manifest.
  const clone = join(scratch, 'upstream');
  const path = 'packages/harness-process/src/tail.ts';
  const pristine = await readFile(join(packageDir, 'vendor/durable-harness/upstream', path), 'utf8');
  await mkdir(dirname(join(clone, path)), { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', clone, '-c', 'user.email=a@b.c', '-c', 'user.name=x', ...args], { encoding: 'utf8' });
  git('init', '-q');
  for (const file of ['builtins', 'inbox', 'journal', 'records', 'recovery', 'tail', 'tools']) {
    const upstreamFile = `packages/harness-process/src/${file}.ts`;
    await writeFile(join(clone, upstreamFile), await readFile(join(packageDir, 'vendor/durable-harness/upstream', upstreamFile)));
  }
  git('add', '-A'); git('commit', '-qm', 'same');
  const same = git('rev-parse', 'HEAD').trim();
  await writeFile(join(clone, path), pristine.replace('harness-world-process:', 'harness-world-process (moved):').replace("import { closeSync", "import { homedir } from 'node:os';\nimport { closeSync"));
  git('add', '-A'); git('commit', '-qm', 'moved');
  const moved = git('rev-parse', 'HEAD').trim();
  const unchanged = await upgradeReport(packageDir, { sha: same, upstreamClone: clone });
  assert.deepEqual([unchanged.imports, unchanged.patches], [[], []]);
  assert.deepEqual(unchanged.pristine['packages/harness-process/src/tail.ts'], { removed: 0, added: 0 });
  const report = await upgradeReport(packageDir, { sha: moved, upstreamClone: clone });
  assert.deepEqual(report.pristine['packages/harness-process/src/tail.ts'], { removed: 1, added: 2 }, 'the pristine diff, by file');
  assert.match(report.imports.join('\n'), /tail\.ts: import from node:os: module node:os is not in the import table/, 'the table names what the new text imports');
  assert.match(report.patches.join('\n'), /patch 002-message-prefix does not apply/, 'and the patch whose line moved');
});
