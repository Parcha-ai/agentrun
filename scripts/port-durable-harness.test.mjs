// The port, checked offline: this tree is exactly what the port makes, and each planted break goes red by name.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { bodyOf, checkPort, header, parsePatch, portPackage, PORT_DIR, readPatches, rewriteImports, upgradeReport } from './port-durable-harness.mjs';

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
  assert.equal(top('src/process/inbox.ts')[2], '// Changed by Parcha, imports rewritten for AgentRun', 'a file no patch touches says only that its imports were rewritten');
  assert.equal(top('src/process/zod.ts')[2], '// Changed by Parcha, patches: 005-comments-name-the-agent-sdk');
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
    '001-begin-reservation', '002-message-prefix', '003-comments-name-this-host', '004-comments-name-the-session-writer', '005-comments-name-the-agent-sdk', '008-tool-images', '009-recovery-system-note', '010-recovery-note-statuses-only',
  ]);
  for (const patch of await readPatches(join(packageDir, PORT_DIR), 'harness-process')) assert.ok(patch.Reason.length > 20, `${patch.name} says why`);
  assert.equal((await readPatches(join(packageDir, PORT_DIR), 'harness-process'))[0].Upstream, 'offer', 'begin() is the one offered upstream');
});

test('the mutant of every patch differs from the port: a patch whose absence changes nothing would be dead weight', async () => {
  const whole = await portPackage(packageDir);
  for (const patch of await readPatches(join(packageDir, PORT_DIR), 'harness-process')) {
    const without = await portPackage(packageDir, { drop: [patch.name], cascade: true });
    assert.ok([...whole.files].some(([path, text]) => bodyOf(without.files.get(path) ?? '') !== bodyOf(text)), `${patch.name} changes the output`);
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
  for (const file of ['builtins', 'inbox', 'journal', 'records', 'recovery', 'tail', 'tools', 'zod']) {
    const upstreamFile = `packages/harness-process/src/${file}.ts`;
    await writeFile(join(clone, upstreamFile), await readFile(join(packageDir, 'vendor/durable-harness/upstream', upstreamFile)));
  }
  git('add', '-A'); git('commit', '-qm', 'same');
  const same = git('rev-parse', 'HEAD').trim();
  await writeFile(join(clone, path), pristine.replace('harness-world-process:', 'harness-world-process (moved):').replace("import { closeSync", "import { gzipSync } from 'node:zlib';\nimport { closeSync"));
  git('add', '-A'); git('commit', '-qm', 'moved');
  const moved = git('rev-parse', 'HEAD').trim();
  const unchanged = await upgradeReport(packageDir, { sha: same, upstreamClone: clone });
  assert.deepEqual([unchanged.imports, unchanged.patches], [[], []]);
  assert.deepEqual(unchanged.pristine['packages/harness-process/src/tail.ts'], { removed: 0, added: 0 });
  const report = await upgradeReport(packageDir, { sha: moved, upstreamClone: clone });
  assert.deepEqual(report.pristine['packages/harness-process/src/tail.ts'], { removed: 1, added: 2 }, 'the pristine diff, by file');
  assert.match(report.imports.join('\n'), /tail\.ts: import from node:zlib: module node:zlib is not in the import table/, 'the table names what the new text imports');
  assert.match(report.patches.join('\n'), /patch 002-message-prefix does not apply/, 'and the patch whose line moved');
});

test('the Codex port is what the pristine files, the Codex patches and the one import table make, with the header after the shebang', { skip: !existsSync(join(root, 'packages', 'run-adapters-codex', PORT_DIR)) && 'the Codex package is not in this tree' }, async () => {
  const codex = join(root, 'packages', 'run-adapters-codex');
  assert.deepEqual(await checkPort(codex), []);
  const { files } = await portPackage(codex);
  const fake = files.get('test/fake-app-server.mjs').split('\n');
  assert.equal(fake[0], '#!/usr/bin/env node');
  assert.match(fake[1], /^\/\/ Copyright 2026 Vercel Inc\./);
  assert.equal(fake[3], '// Changed by Parcha, patches: 005-fake-app-server-script, 006-comments');
  assert.match(files.get('src/harness.ts').split('\n')[2], /^\/\/ Changed by Parcha, imports rewritten for AgentRun; patches: 002-standin-guard, 004-names, 006-comments, 007-code-mode-nested, 008-recovery-note-developer, 009-cut-off-safe-call$/);
  for (const patch of await readPatches(join(codex, PORT_DIR), 'harness-codex')) {
    const without = await portPackage(codex, { drop: [patch.name], cascade: true });
    assert.ok([...files].some(([path, text]) => bodyOf(without.files.get(path) ?? '') !== bodyOf(text)), `${patch.name} changes the output`);
  }
  const target = await copyOf(table((t) => { t.modules['harness-world-process'].symbols.ModelSteps = { 'harness-claude-code': 'ModelSteps' }; return t; }));
  const codexCopy = join(scratch, 'codex-copy');
  await cp(codex, codexCopy, { recursive: true, filter: (path) => !/\/(?:node_modules|dist)(?:\/|$)/.test(path) });
  await cp(join(target, PORT_DIR, 'imports.json'), join(scratch, 'imports-no-codex.json'));
  const manifest = join(codexCopy, PORT_DIR, 'harness-codex.json');
  await writeFile(manifest, (await readFile(manifest, 'utf8')).replace(/"table": "[^"]*"/, `"table": ${JSON.stringify(join(scratch, 'imports-no-codex.json'))}`));
  assert.match((await portPackage(codexCopy)).problems.join('\n'), /harness\.ts: import from harness-world-process: symbol ModelSteps is not in the import table for harness-world-process/, 'a symbol the table holds for another package only is unknown for this one');
});

test('the command line exits 1 when a committed byte is not the port\'s, naming the file on stderr, and 0 on a clean tree', async () => {
  const run = (dir) => spawnSync(process.execPath, [join(root, 'scripts', 'port-durable-harness.mjs'), '--check', dir], { cwd: root, encoding: 'utf8' });
  const clean = run(packageDir);
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /the committed files are exactly what the pristine copies, the patches and the import table make/);
  const changed = await copyOf(edit('src/process/tools.ts', (text) => `${text} `));
  const red = run(changed);
  assert.equal(red.status, 1, 'a changed byte is a non-zero exit, so CI\'s gate is red');
  assert.match(red.stderr, /src\/process\/tools\.ts: differs from the port's output/);
  const broken = await copyOf(table((t) => { delete t.modules['node:crypto']; return t; }));
  assert.equal(run(broken).status, 1, 'a port that fails (not a byte difference) exits 1 too');
});

test('a patch that changes nothing is named: one a later patch reverts, and one that rewrites a line to itself', async () => {
  // Patch 006 changes a line of tail.ts's comment; 007 changes it back: together they leave the output as it was.
  const pristine = (await readFile(join(packageDir, 'vendor/durable-harness/upstream/packages/harness-process/src/tail.ts'), 'utf8')).split('\n');
  const at = pristine.findIndex((line, i) => i >= 4 && line.startsWith(' * ') && line.trim().length > 12);
  // One changed line with git's three lines of context on each side.
  const hunk = (from, to) => `diff --git a/packages/harness-process/src/tail.ts b/packages/harness-process/src/tail.ts\n--- a/packages/harness-process/src/tail.ts\n+++ b/packages/harness-process/src/tail.ts\n@@ -${at - 2},7 +${at - 2},7 @@\n${pristine.slice(at - 3, at).map((l) => ` ${l}`).join('\n')}\n-${from}\n+${to}\n${pristine.slice(at + 1, at + 4).map((l) => ` ${l}`).join('\n')}\n`;
  const patchFile = (name, from, to) => `Patch: ${name}\nReason: a test patch\nUpstream: ours\nPins: comments only\n---\n${hunk(from, to)}`;
  const changed = pristine[at].replace('*', '*  ');
  // The comment line sits inside the 002 patch's context only when it is within three lines of it; either way the patches
  // below are the last two, applied to the text the earlier ones left.
  const reverted = await copyOf(async (dir) => {
    const text = (await readFile(join(dir, 'vendor/durable-harness/upstream/packages/harness-process/src/tail.ts'), 'utf8')).split('\n');
    const line = text.findIndex((l) => l === pristine[at]);
    assert.ok(line >= 0);
    await writeFile(join(dir, patchPath('006-widen')), patchFile('006-widen', pristine[at], changed));
    await writeFile(join(dir, patchPath('007-narrow')), patchFile('007-narrow', changed, pristine[at]));
  });
  const problems = (await checkPort(reverted)).join('\n');
  assert.match(problems, /patch 006-widen changes nothing/);
  assert.doesNotMatch(problems, /patch 007-narrow changes nothing/, 'the reverting patch alone does change the output (it leaves the first applied)');
  // A patch that rewrites a line to itself applies and changes nothing.
  const same = await copyOf(async (dir) => {
    await writeFile(join(dir, patchPath('006-same')), patchFile('006-same', pristine[at], pristine[at]));
  });
  assert.match((await checkPort(same)).join('\n'), /patch 006-same changes nothing/);
});

/** A copy of another package that reads a changed copy of the one import table (its manifest names the copy). */
async function withTable(pkg, change, manifestName) {
  const dir = join(scratch, `pkg${made += 1}`);
  await cp(pkg, dir, { recursive: true, filter: (path) => !/\/(?:node_modules|dist)(?:\/|$)/.test(path) });
  const tableFile = join(scratch, `table${made}.json`);
  await writeFile(tableFile, change(await readFile(join(packageDir, PORT_DIR, 'imports.json'), 'utf8')));
  const manifest = join(dir, PORT_DIR, manifestName);
  await writeFile(manifest, (await readFile(manifest, 'utf8')).replace(/"table": "[^"]*"/, `"table": ${JSON.stringify(tableFile)}`));
  return dir;
}

test('the Claude port: its relative imports land where the manifest or the table says, and a module the table lacks fails by name', { skip: !existsSync(join(root, 'packages', 'run-adapters-claude-agent', PORT_DIR)) && 'the Claude package is not in this tree' }, async () => {
  const claude = join(root, 'packages', 'run-adapters-claude-agent');
  assert.deepEqual(await checkPort(claude), []);
  const { files } = await portPackage(claude);
  assert.match(files.get('src/testing/fake-sdk.ts'), /import type \{ ClaudeAgentSdk \} from '\.\.\/harness\.js';/, "upstream's ../src/index.ts is our harness.ts");
  assert.match(files.get('src/harness.ts'), /from '\.\/spawn\.js';/, "upstream's spawn is the file AgentRun wrote in its place");
  const bare = await withTable(claude, (text) => text.replace('"@anthropic-ai/claude-agent-sdk"', '"@anthropic-ai/other"'), 'harness-claude-code.json');
  assert.match((await portPackage(bare)).problems.join('\n'), /harness\.ts: a dynamic import or require of @anthropic-ai\/claude-agent-sdk: module @anthropic-ai\/claude-agent-sdk is not in the import table/);
  const noLanding = await withTable(claude, (text) => text.replace('packages/harness-claude-code/src/spawn.ts', 'packages/harness-claude-code/src/elsewhere.ts'), 'harness-claude-code.json');
  assert.match((await portPackage(noLanding)).problems.join('\n'), /harness\.ts: import from \.\/spawn\.ts: packages\/harness-claude-code\/src\/spawn\.ts is not a file of this manifest, and the import table has no landing for it/);
});

/** The table's verdict on `text`, which imports from the modules `mod-a` (renames symbols) and `mod-kept` (kept as it is). */
function rewrite(text) {
  const table = { relative: { from: '.ts', to: '.js' }, modules: {
    'mod-a': { to: 'src/kernel/index.ts', symbols: { '*': '*', DriveContext: 'NewContext', X: 'Y', Z: 'ZZ' } },
    'mod-kept': { keep: true },
  } };
  const problems = [];
  const { text: out } = rewriteImports(text, { table, file: 'up/a.ts', entries: [{ from: 'up/a.ts', to: 'src/a.ts' }], problems, outDir: 'src', target: 'pkg' });
  return { out, problems };
}

test('export * from a module goes through the table: an unknown one is named, a known one lands where the table says', () => {
  assert.match(rewrite("export * from 'mod-unknown';\n").problems.join('\n'), /a\.ts: export from mod-unknown: module mod-unknown is not in the import table/);
  const known = rewrite("export * from 'mod-a';\nexport * as ns from 'mod-a';\nexport * from 'mod-kept';\n");
  assert.deepEqual(known.problems, []);
  assert.equal(known.out, "export * from './kernel/index.js';\nexport * as ns from './kernel/index.js';\nexport * from 'mod-kept';\n");
});

test('a symbol rename touches the imported name only: the local alias stays, in an import and in a re-export', () => {
  const { out, problems } = rewrite([
    "import { DriveContext as C } from 'mod-a';",
    "import { X as X } from 'mod-a';",
    "import { type DriveContext as D, DriveContext } from 'mod-a';",
    "export { Z as W } from 'mod-a';",
    "export { Z } from 'mod-a';",
    '',
  ].join('\n'));
  assert.deepEqual(problems, []);
  assert.equal(out, [
    "import { NewContext as C } from './kernel/index.js';",
    "import { Y as X } from './kernel/index.js';",
    "import { type NewContext as D, NewContext as DriveContext } from './kernel/index.js';",
    "export { ZZ as W } from './kernel/index.js';",
    "export { ZZ as Z } from './kernel/index.js';",
    '',
  ].join('\n'));
});

test('--pin counts real line changes: a reordered pair and an added duplicate line each report a change', async () => {
  const clone = join(scratch, 'upstream-order');
  const git = (...args) => execFileSync('git', ['-C', clone, '-c', 'user.email=a@b.c', '-c', 'user.name=x', ...args], { encoding: 'utf8' });
  await mkdir(clone, { recursive: true });
  git('init', '-q');
  const tail = 'packages/harness-process/src/tail.ts';
  for (const file of ['builtins', 'inbox', 'journal', 'records', 'recovery', 'tail', 'tools', 'zod']) {
    const upstreamFile = `packages/harness-process/src/${file}.ts`;
    await mkdir(dirname(join(clone, upstreamFile)), { recursive: true });
    await writeFile(join(clone, upstreamFile), await readFile(join(packageDir, 'vendor/durable-harness/upstream', upstreamFile)));
  }
  git('add', '-A'); git('commit', '-qm', 'same');
  const lines = (await readFile(join(clone, tail), 'utf8')).split('\n');
  const at = lines.findIndex((line, i) => line.trim() && lines[i + 1]?.trim() && line !== lines[i + 1]);
  await writeFile(join(clone, tail), [...lines.slice(0, at), lines[at + 1], lines[at], ...lines.slice(at + 2)].join('\n'));
  git('add', '-A'); git('commit', '-qm', 'reordered');
  const reordered = git('rev-parse', 'HEAD').trim();
  await writeFile(join(clone, tail), [...lines.slice(0, at + 1), lines[at], ...lines.slice(at + 1)].join('\n'));
  git('add', '-A'); git('commit', '-qm', 'duplicated');
  const duplicated = git('rev-parse', 'HEAD').trim();
  assert.deepEqual((await upgradeReport(packageDir, { sha: reordered, upstreamClone: clone })).pristine[tail], { removed: 1, added: 1 }, 'a reorder');
  assert.deepEqual((await upgradeReport(packageDir, { sha: duplicated, upstreamClone: clone })).pristine[tail], { removed: 0, added: 1 }, 'an added copy of a line');
});

test('--pin names a listed file that is not at the new pin, still reports every other file, and exits 1', async () => {
  const clone = join(scratch, 'upstream-deleted');
  const git = (...args) => execFileSync('git', ['-C', clone, '-c', 'user.email=a@b.c', '-c', 'user.name=x', ...args], { encoding: 'utf8' });
  await mkdir(clone, { recursive: true });
  git('init', '-q');
  for (const file of ['builtins', 'inbox', 'journal', 'records', 'recovery', 'tail', 'tools', 'zod']) {
    const upstreamFile = `packages/harness-process/src/${file}.ts`;
    await mkdir(dirname(join(clone, upstreamFile)), { recursive: true });
    await writeFile(join(clone, upstreamFile), await readFile(join(packageDir, 'vendor/durable-harness/upstream', upstreamFile)));
  }
  git('add', '-A'); git('commit', '-qm', 'same');
  await rm(join(clone, 'packages/harness-process/src/journal.ts'));
  git('add', '-A'); git('commit', '-qm', 'deleted');
  const pin = git('rev-parse', 'HEAD').trim();
  const report = await upgradeReport(packageDir, { sha: pin, upstreamClone: clone });
  assert.deepEqual(report.missing, [`packages/harness-process/src/journal.ts: not at ${pin}`]);
  assert.deepEqual(report.pristine['packages/harness-process/src/tail.ts'], { removed: 0, added: 0 }, 'the other files are still checked');
  assert.ok(!('packages/harness-process/src/journal.ts' in report.pristine));
  const run = spawnSync(process.execPath, [join(root, 'scripts', 'port-durable-harness.mjs'), '--pin', pin, '--upstream', clone, packageDir], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stdout, new RegExp(`journal\\.ts: not at ${pin}`));
  assert.match(run.stdout, /tail\.ts: 0 lines removed, 0 added/, 'the whole report is printed');
});

/** A throwaway upstream repository holding every file of the process manifest, committed once; returns its helpers. */
async function throwawayUpstream(name) {
  const clone = join(scratch, name);
  const git = (...args) => execFileSync('git', ['-C', clone, '-c', 'user.email=a@b.c', '-c', 'user.name=x', ...args], { encoding: 'utf8' });
  await mkdir(clone, { recursive: true });
  git('init', '-q');
  for (const file of ['builtins', 'inbox', 'journal', 'records', 'recovery', 'tail', 'tools', 'zod']) {
    const upstreamFile = `packages/harness-process/src/${file}.ts`;
    await mkdir(dirname(join(clone, upstreamFile)), { recursive: true });
    await writeFile(join(clone, upstreamFile), await readFile(join(packageDir, 'vendor/durable-harness/upstream', upstreamFile)));
  }
  git('add', '-A'); git('commit', '-qm', 'same');
  return { clone, git };
}

test('--pin fails on a missing file even when that is the only problem: no import and no patch is written against it', async () => {
  const { clone, git } = await throwawayUpstream('upstream-only-missing');
  await rm(join(clone, 'packages/harness-process/src/inbox.ts'));
  git('add', '-A'); git('commit', '-qm', 'deleted');
  const pin = git('rev-parse', 'HEAD').trim();
  const report = await upgradeReport(packageDir, { sha: pin, upstreamClone: clone });
  assert.deepEqual(report.missing, [`packages/harness-process/src/inbox.ts: not at ${pin}`]);
  assert.deepEqual([report.imports, report.patches], [[], []], 'the missing file is the only problem');
  const run = spawnSync(process.execPath, [join(root, 'scripts', 'port-durable-harness.mjs'), '--pin', pin, '--upstream', clone, packageDir], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 1, run.stdout);
  assert.match(run.stdout, /inbox\.ts: not at /);
});

test('--pin reports only git\'s own missing-path answers as a missing file: a corrupt clone fails as itself', async () => {
  const { clone, git } = await throwawayUpstream('upstream-corrupt');
  const path = 'packages/harness-process/src/tail.ts';
  await writeFile(join(clone, path), `${await readFile(join(clone, path), 'utf8')}// moved\n`);
  git('add', '-A'); git('commit', '-qm', 'moved');
  const pin = git('rev-parse', 'HEAD').trim();
  const blob = git('rev-parse', `${pin}:${path}`).trim();
  await rm(join(clone, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
  await assert.rejects(upgradeReport(packageDir, { sha: pin, upstreamClone: clone }), (error) => !/not at /.test(error.message) && /unable to read|bad object|Command failed/.test(error.message));
});

test('an import with a comment between its tokens is still checked: an unknown module fails by name, and a string or comment that only looks like an import is not one', () => {
  for (const text of ["import /* x */ { X } from 'unknown-module';\n", "export /* x */ * from 'unknown-module';\n", "const loaded = import(/* x */ 'unknown-module');\n"]) {
    assert.match(rewrite(text).problems.join('\n'), /a\.ts: .*unknown-module.*is not in the import table/, text);
  }
  assert.match(rewrite("import /* x */ { X } from 'mod-a';\n").problems.join('\n'), /mod-a.*is not in the import table|mod-a.*escaped/, 'a known module the regex missed is not left unrewritten');
  const lookalikes = [
    'const s = "import { X } from \'unknown-module\'";',
    "// import { X } from 'unknown-module'",
    "/* export * from 'unknown-module' */",
    'const t = `import { X } from \'unknown-module\'`;',
    "import { X } from 'mod-kept';",
    '',
  ].join('\n');
  assert.deepEqual(rewrite(lookalikes).problems, []);
});

test('the command line refuses a value flag with no value and an unknown option: exit 2 with a usage line, and nothing written', () => {
  const stamp = () => `${execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })}|${statSync(join(packageDir, 'src/process/tail.ts')).mtimeMs}`;
  const before = stamp();
  for (const args of [['--pin'], ['--pin', '--check'], ['--upstream'], ['--drop'], ['--out'], ['--bogus'], ['--pin', 'abc', '--bogus'], ['a', 'b']]) {
    const run = spawnSync(process.execPath, [join(root, 'scripts', 'port-durable-harness.mjs'), ...args], { cwd: root, encoding: 'utf8' });
    assert.equal(run.status, 2, `${args.join(' ')}: ${run.stderr}`);
    assert.match(run.stderr, /usage/i, args.join(' '));
    assert.equal(stamp(), before, `${args.join(' ')} wrote nothing`);
  }
});
