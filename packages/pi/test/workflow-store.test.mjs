import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WorkflowStore } from '../dist/workflow-store.js';

// Fictional procedures only; no providers, executable approval or input values.
const fixture = (instructions = 'Copy the supplied text.') => ({
  v: 2, name: 'fictional-copy',
  schemas: { Input: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
    Result: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } },
  input: { schemaId: 'Input' }, output: { schemaId: 'Result', path: 'result' },
  root: { node: 'extract', label: 'copy', instructions, state: { text: '{text}' }, out: 'Result', as: 'result' },
});
async function setup(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'agentrun-store-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return { cwd, store: new WorkflowStore(cwd), root: join(cwd, '.pi/agentrun/workflows') };
}
const code = expected => error => error?.code === expected;

test('empty listing is read-only; saved versions round-trip across store instances', async t => {
  const { cwd, root, store } = await setup(t);
  assert.deepEqual(await store.list(), []);
  await assert.rejects(stat(join(cwd, '.pi')), code('ENOENT'));
  const original = fixture();
  const saved = await store.save('release-review', original);
  original.root.instructions = 'Caller mutation';
  const restored = await new WorkflowStore(cwd).load('release-review', saved.digest);
  assert.equal(restored.workflow.root.instructions, 'Copy the supplied text.');
  assert.equal(restored.workflowName, 'fictional-copy');
  const disk = JSON.parse(await readFile(join(root, saved.name, `${saved.digest}.json`), 'utf8'));
  assert.deepEqual(Object.keys(disk).sort(), ['createdAt', 'digest', 'name', 'version', 'workflow']);
  assert.equal(disk.input, undefined); assert.equal(disk.trusted, undefined); assert.equal(disk.executableAuthorized, undefined);
  assert.equal((await stat(join(root, saved.name, `${saved.digest}.json`))).mode & 0o777, 0o600);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  restored.workflow.root.instructions = 'Returned mutation';
  assert.deepEqual((await store.load(saved.name)).workflow, fixture());
});

test('concurrent identical saves publish one immutable revision and retain old revisions', async t => {
  const { store, root } = await setup(t);
  const all = await Promise.all(Array.from({ length: 8 }, () => store.save('copy', fixture())));
  assert.ok(all.every(s => s.digest === all[0].digest && s.createdAt === all[0].createdAt));
  assert.deepEqual(await readdir(join(root, 'copy')), [`${all[0].digest}.json`]);
  const before = await readFile(join(root, 'copy', `${all[0].digest}.json`), 'utf8');
  const next = await store.save('copy', fixture('Copy without changing spelling.'));
  assert.notEqual(next.digest, all[0].digest);
  assert.equal(await readFile(join(root, 'copy', `${all[0].digest}.json`), 'utf8'), before);
  const revisions = await store.list();
  assert.equal(revisions.length, 2); assert.ok(revisions.every(r => r.workflow === undefined));
  assert.equal((await store.load('copy')).digest, revisions[0].digest);
  assert.deepEqual((await store.load('copy', all[0].digest)).workflow, fixture());
});

test('procedure validation rejects malformed schemas without executing code or accessors', async t => {
  const { store } = await setup(t);
  const executable = fixture();
  executable.root = { node: 'code', label: 'copy', as: 'result', code: '(globalThis.__workflowStoreExecuted = true, (s) => ({text:s.text}))' };
  delete globalThis.__workflowStoreExecuted;
  const saved = await store.save('code', executable);
  await store.load('code', saved.digest);
  assert.equal(globalThis.__workflowStoreExecuted, undefined);
  const invalid = fixture(); invalid.root.out = 'Unknown';
  await assert.rejects(store.save('bad', invalid), code('invalid_workflow'));
  let read = false;
  const getter = fixture(); Object.defineProperty(getter, 'name', { enumerable: true, get() { read = true; return 'unsafe'; } });
  await assert.rejects(store.save('bad', getter), code('invalid_workflow')); assert.equal(read, false);
  const cyclic = fixture(); cyclic.extra = cyclic;
  await assert.rejects(store.save('bad', cyclic), code('invalid_workflow'));
  await assert.rejects(store.save('bad', new Proxy(fixture(), {})), code('invalid_workflow'));
  const polluted = fixture(); Object.setPrototypeOf(polluted, { executableAuthorized: true });
  await assert.rejects(store.save('bad', polluted), code('invalid_workflow'));
});

test('invalid names and revision paths never create storage', async t => {
  const { store, cwd } = await setup(t);
  for (const name of ['../escape', '/tmp/escape', '.', '..', 'a/b', 'a\\b', '__proto__', 'a\0b', 'A', 'x'.repeat(65), '']) {
    await assert.rejects(store.save(name, fixture()), code('invalid_name'));
    await assert.rejects(store.load(name), code('invalid_name'));
  }
  await assert.rejects(store.load('safe', '../escape'), code('invalid_revision'));
  await assert.rejects(stat(join(cwd, '.pi')), code('ENOENT'));
  // Object-prototype names have no magic behavior in filesystem paths.
  assert.equal((await store.save('constructor', fixture())).name, 'constructor');
});

for (const component of ['.pi', '.pi/agentrun', '.pi/agentrun/workflows', '.pi/agentrun/workflows/copy']) {
  test(`rejects a symbolic-link directory at ${component}`, async t => {
    const { cwd, store } = await setup(t);
    const outside = join(cwd, 'outside'); await mkdir(outside);
    const pieces = component.split('/');
    if (pieces.length > 1) await mkdir(join(cwd, ...pieces.slice(0, -1)), { recursive: true });
    await symlink(outside, join(cwd, component));
    await assert.rejects(store.save('copy', fixture()), code('unsafe_path'));
    await assert.rejects(store.load('copy', 'a'.repeat(64)), code('unsafe_path'));
    assert.deepEqual(await readdir(outside), []);
  });
}

test('rejects symbolic-link revisions without reading or replacing their target', async t => {
  const { cwd, root, store } = await setup(t);
  const saved = await store.save('copy', fixture());
  const target = join(cwd, 'outside.json'); await writeFile(target, 'private-fixture');
  const path = join(root, 'copy', `${saved.digest}.json`);
  await rm(path); await symlink(target, path);
  await assert.rejects(store.load('copy', saved.digest), code('unsafe_path'));
  await assert.rejects(store.save('copy', fixture()), code('unsafe_path'));
  assert.equal(await readFile(target, 'utf8'), 'private-fixture');
});

test('tampered content or authority fields fail closed and never overwrite old bytes', async t => {
  const { root, store } = await setup(t);
  const saved = await store.save('copy', fixture()); const path = join(root, 'copy', `${saved.digest}.json`);
  const record = JSON.parse(await readFile(path, 'utf8'));
  record.workflow.root.instructions = 'Tampered'; await writeFile(path, JSON.stringify(record));
  await assert.rejects(store.load('copy'), code('invalid_record'));
  await assert.rejects(store.save('copy', fixture()), code('invalid_record'));
  assert.equal(JSON.parse(await readFile(path, 'utf8')).workflow.root.instructions, 'Tampered');
  record.workflow = fixture(); record.executableAuthorized = true; await writeFile(path, JSON.stringify(record));
  await assert.rejects(store.load('copy', saved.digest), code('invalid_record'));
});

test('interrupted staging files are recoverable but never listed as revisions', async t => {
  const { root, store } = await setup(t);
  const saved = await store.save('copy', fixture());
  const interrupted = join(root, 'copy', '.pending-1234-abcd');
  await writeFile(interrupted, '{partial');
  assert.equal((await store.list()).length, 1);
  assert.equal((await store.load('copy')).digest, saved.digest);
  assert.equal(await readFile(interrupted, 'utf8'), '{partial');
  await assert.rejects(store.load('missing'), code('not_found'));
  await assert.rejects(store.load('copy', '0'.repeat(64)), code('not_found'));
});

test('malformed JSON and forged metadata are rejected on load', async t => {
  const { root, store } = await setup(t);
  const saved = await store.save('copy', fixture()); const path = join(root, 'copy', `${saved.digest}.json`);
  const original = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, '{partial');
  await assert.rejects(store.load('copy', saved.digest), code('invalid_record'));
  for (const patch of [{ name: 'different' }, { digest: '0'.repeat(64) }, { version: 2 }, { createdAt: '2026-99-01T00:00:00.000Z' }, { input: { text: 'must-not-persist' } }]) {
    await writeFile(path, JSON.stringify({ ...original, ...patch }));
    await assert.rejects(store.load('copy', saved.digest), code('invalid_record'));
  }
});
