// The saved-workflow store as a host meets it: `@parcha/agentrun-pi/workflows`, resolved by the package's name, constructed with a
// directory the host passes, and reading and writing the records the /agentrun extension keeps for its own project directory.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import agentRunExtension from '../dist/extension.js';
import { reachableImports } from '../../../scripts/reachable-imports.mjs';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
const CODING_AGENT_ONLY = ['@earendil-works/pi-coding-agent', '@earendil-works/pi-agent-core', '@earendil-works/pi-tui'];
const { WorkflowStore, WorkflowStoreError } = await import(`${manifest.name}/workflows`);

// Fictional procedures only.
const fixture = (instructions = 'Copy the supplied text.', name = 'fictional-copy') => ({
  v: 2, name,
  schemas: { Input: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
    Result: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } },
  input: { schemaId: 'Input' }, output: { schemaId: 'Result', path: 'result' },
  root: { node: 'extract', label: 'copy', instructions, state: { text: '{text}' }, out: 'Result', as: 'result' },
});
async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'agentrun-store-entry-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const records = dir => join(dir, '.pi/agentrun/workflows');
// Run `body` in a second node process that imports the entry by the package name and prints one JSON line.
const inProcess = (body, ...args) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
  `import { WorkflowStore } from '${manifest.name}/workflows'; const [dir, ...rest] = process.argv.slice(1); const out = await (async () => { ${body} })(); console.log(JSON.stringify(out));`, ...args],
  { cwd: packageRoot, encoding: 'utf8' }));

test('the entry resolves by the package name, is typed, and never reaches the coding agent, its agent core or its TUI', () => {
  for (const file of Object.values(manifest.exports['./workflows'])) {
    assert.ok(existsSync(join(packageRoot, file)), file);
    const reached = reachableImports(packageRoot, file).filter(specifier => CODING_AGENT_ONLY.some(name => specifier === name || specifier.startsWith(`${name}/`)));
    assert.deepEqual(reached, [], file);
  }
  assert.equal(typeof WorkflowStore, 'function'); assert.equal(typeof WorkflowStoreError, 'function');
});

test('a workflow saved by one process loads in a second, by name and by digest, as the same value', async t => {
  const dir = await directory(t);
  const saved = await new WorkflowStore(dir).save('release-review', fixture());
  const loaded = inProcess("const s = new WorkflowStore(dir); const byName = await s.load('release-review'); const byDigest = await s.load('release-review', rest[0]); return { byName, byDigest };", dir, saved.digest);
  assert.deepEqual(loaded.byName, JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(loaded.byDigest, loaded.byName);
  assert.equal(await readFile(join(records(dir), 'release-review', 'latest'), 'utf8'), `${saved.digest}\n`);
  // And the other way: the second process saves, this one loads.
  const other = inProcess("return await new WorkflowStore(dir).save('second', JSON.parse(rest[0]));", dir, JSON.stringify(fixture('Copy it twice.')));
  assert.deepEqual(JSON.parse(JSON.stringify(await new WorkflowStore(dir).load('second'))), other);
});

test('the store lives under <directory>/.pi/agentrun/workflows: the directory is the project directory, not the workflows directory', async t => {
  const dir = await directory(t);
  const saved = await new WorkflowStore(dir).save('copy', fixture());
  assert.deepEqual(await readdir(join(records(dir), 'copy')), [`${saved.digest}.json`, 'latest']);
  // A workflows directory handed in as if it were the root is a different project directory: nothing it holds is found.
  assert.deepEqual(await new WorkflowStore(records(dir)).list(), []);
});

test('list returns every revision newest first, across names', async t => {
  const dir = await directory(t); const store = new WorkflowStore(dir);
  const first = await store.save('alpha', fixture('One.'));
  await new Promise(resolve => setTimeout(resolve, 5));
  const second = await store.save('beta', fixture('Two.'));
  await new Promise(resolve => setTimeout(resolve, 5));
  const third = await store.save('alpha', fixture('Three.'));
  const listed = await store.list();
  assert.deepEqual(listed.map(item => item.digest), [third.digest, second.digest, first.digest]);
  assert.deepEqual(Object.keys(listed[0]).sort(), ['createdAt', 'digest', 'name', 'workflowName']);
  assert.equal((await store.load('alpha')).digest, third.digest, 'by name loads the last saved');
});

test('a symbolic link in the storage path or among the records is refused, and nothing is read through it', async t => {
  const outside = await directory(t);
  await new WorkflowStore(outside).save('secret', fixture('Outside.'));
  // A linked .pi directory.
  const linkedPi = await directory(t);
  await symlink(join(outside, '.pi'), join(linkedPi, '.pi'));
  await assert.rejects(new WorkflowStore(linkedPi).list(), error => error instanceof WorkflowStoreError && error.code === 'unsafe_path');
  await assert.rejects(new WorkflowStore(linkedPi).save('copy', fixture()), error => error.code === 'unsafe_path');
  // A linked name directory.
  const linkedName = await directory(t);
  await mkdir(records(linkedName), { recursive: true });
  await symlink(join(records(outside), 'secret'), join(records(linkedName), 'secret'));
  await assert.rejects(new WorkflowStore(linkedName).load('secret'), error => error.code === 'unsafe_path');
  // A linked revision file.
  const linkedFile = await directory(t);
  const saved = await new WorkflowStore(linkedFile).save('copy', fixture());
  const file = join(records(linkedFile), 'copy', `${saved.digest}.json`);
  const bytes = await readFile(file);
  await rm(file); await writeFile(join(linkedFile, 'target.json'), bytes); await symlink(join(linkedFile, 'target.json'), file);
  await assert.rejects(new WorkflowStore(linkedFile).load('copy', saved.digest), error => error.code === 'unsafe_path');
  // A linked project directory is the host's own path; the store resolves it once and then holds to real directories.
  const real = await directory(t); const via = join(await directory(t), 'project'); await symlink(real, via);
  await new WorkflowStore(via).save('copy', fixture());
  assert.equal((await new WorkflowStore(real).list()).length, 1);
});

test('a <name>/ directory copied into the workflows directory loads, by name and by digest, and a copy without its pointer loads the newest', async t => {
  const source = await directory(t); const saved = await new WorkflowStore(source).save('triage', fixture());
  const target = await directory(t);
  await mkdir(records(target), { recursive: true });
  await cp(join(records(source), 'triage'), join(records(target), 'triage'), { recursive: true });
  const store = new WorkflowStore(target);
  assert.deepEqual((await store.load('triage')).digest, saved.digest);
  assert.deepEqual((await store.load('triage', saved.digest)).workflow, fixture());
  assert.deepEqual((await store.list()).map(item => item.digest), [saved.digest]);
  // The interim copy a consumer made may hold the revision file alone.
  const bare = await directory(t);
  await mkdir(join(records(bare), 'triage'), { recursive: true });
  await cp(join(records(source), 'triage', `${saved.digest}.json`), join(records(bare), 'triage', `${saved.digest}.json`));
  assert.equal((await new WorkflowStore(bare).load('triage')).digest, saved.digest);
});

test('a tampered copy is refused: the digest and the metadata are checked as the extension checks them', async t => {
  const dir = await directory(t); const store = new WorkflowStore(dir);
  const saved = await store.save('copy', fixture());
  const file = join(records(dir), 'copy', `${saved.digest}.json`);
  const record = JSON.parse(await readFile(file, 'utf8'));
  record.workflow.root.instructions = 'Changed after saving.';
  await writeFile(file, JSON.stringify(record, null, 2) + '\n');
  await assert.rejects(store.load('copy', saved.digest), error => error.code === 'invalid_record' && /does not match its digest/.test(error.message));
  record.workflow = fixture(); record.name = 'other';
  await writeFile(file, JSON.stringify(record, null, 2) + '\n');
  await assert.rejects(store.load('copy', saved.digest), error => error.code === 'invalid_record');
  await assert.rejects(store.load('Not A Name'), error => error.code === 'invalid_name');
});

test('the /agentrun extension and the public store read each other\'s records for the same project directory', async t => {
  const cwd = await directory(t);
  const commands = new Map(); const messages = []; const events = new Map(); const branch = [];
  const ctx = { cwd, model: undefined, thinkingLevel: 'low', signal: new AbortController().signal, hasUI: false, mode: 'print',
    sessionManager: { getSessionId: () => 'store-entry-test', getBranch: () => branch, getSessionFile: () => undefined },
    ui: { setStatus: () => {}, setWidget: () => {}, custom: async () => undefined }, modelRegistry: { getAll: () => [], streamSimple: () => { throw new Error('no model'); } } };
  agentRunExtension({ registerTool: () => {}, registerCommand: (name, command) => commands.set(name, command), registerEntryRenderer: () => {},
    appendEntry: (customType, data) => branch.push({ type: 'custom', customType, data }), on: (name, handler) => events.set(name, handler),
    getActiveTools: () => ['read'], getCommands: () => [{ name: 'skill:agentrun-author', source: 'skill' }], getAllTools: () => [], getThinkingLevel: () => 'low',
    sendMessage: message => messages.push(message), sendUserMessage: () => {} });
  const command = args => commands.get('agentrun').handler(args, ctx);
  try {
    // The extension saves; the public store reads the same record.
    await command('triage billing');
    await command('save support-triage');
    const listed = await new WorkflowStore(cwd).list();
    assert.deepEqual(listed.map(item => item.name), ['support-triage']);
    const viaApi = await new WorkflowStore(cwd).load('support-triage');
    assert.equal(viaApi.digest, listed[0].digest);
    // The public store saves; the extension lists and loads it.
    const saved = await new WorkflowStore(cwd).save('host-saved', fixture('Saved by a host.'));
    await command('list');
    assert.match(messages.at(-1).content, /host-saved/);
    await command(`load host-saved ${saved.digest}`);
    assert.ok(messages.at(-1).content.includes(saved.digest));
    assert.match(messages.at(-1).content, /Missing input: text/);
  } finally { await events.get('session_shutdown')?.(); }
});
