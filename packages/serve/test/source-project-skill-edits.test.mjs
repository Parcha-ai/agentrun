// Ordinary owner saves must change future immutable project placement, never an already admitted run's files.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { agent, serve } from './support.mjs';
import { sourceSnapshotDigest } from '../dist/native/source-snapshot-types.js';
import { sourceWorkspace } from '../dist/source-sync/workspace.js';
import { commitSourceSnapshot, readSourceSnapshot } from '../dist/source-sync/snapshots.js';
import { runFolder } from '../dist/workspace/paths.js';
import { sourceIOPrefix } from '../dist/source-sync/io.js';

const original = 'Original imported guidance.';
const owned = { 'continuity/SKILL.md': original };
const binary = Buffer.from([0, 255, 128, 10]);
function snapshot(managed = false) {
  const blobs = {}, entries = [];
  const directory = (path, role, mode = 0o755) => entries.push({ path, role, type: 'directory', mode, bytes: 0 });
  const file = (path, role, bytes, mode) => {
    bytes = Buffer.from(bytes); const sha256 = createHash('sha256').update(bytes).digest('hex');
    blobs[sha256] = bytes.toString('base64'); entries.push({ path, role, type: 'file', mode, bytes: bytes.length, sha256 });
  };
  directory('project', 'project', 0o750);
  file('project/state.txt', 'project', managed ? 'Latest managed work' : 'Source work', 0o640);
  directory('skills/source/continuity', 'skill', 0o750);
  file('skills/source/continuity/SKILL.md', 'skill', managed ? 'Task-edited guidance.' : original, 0o640);
  file('skills/source/continuity/asset.bin', 'skill', binary, 0o600);
  file('skills/source/continuity/script.sh', 'skill', '#!/bin/sh\nexit 0\n', 0o751);
  const value = { version: 1, complete: true, source: { runtime: 'codex', machine_id: 'fixture', project: '/fixture/project', selector: { kind: 'project' } },
    entries, blobs, instructions: { text: '', layers: [] }, skills: [{ name: 'continuity', path: 'skills/source/continuity', source: 'project' }],
    configuration: { model: null, tools: [], permissions: {}, credentials: [] }, project: { git: null }, blockers: [] };
  return { ...value, digest: sourceSnapshotDigest(value) };
}
async function fixture(t) {
  const s = await serve(t, { runner: false });
  const created = await s.api('POST', '/agents', { ...agent('skill-edits', { skills: ['continuity'], tools: ['read'] }), skills: owned });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const source = snapshot(), project = snapshot(true), entry = await s.store.agents.get('skill-edits'), revision = await s.store.agents.revision(entry.currentRevision);
  const binding = { id: 'a'.repeat(64), snapshot: source.digest, project: project.digest, configuration: 'b'.repeat(64) };
  await s.store.agents.addRevision({ agentId: entry.id, id: 'moved-baseline', kind: revision.kind, ifCurrent: entry.currentRevision, skills: owned,
    body: { ...revision.body, sourceSync: binding } });
  const cache = await sourceWorkspace(s.store, entry.id, { data: s.data, sealKey: undefined, env: {} });
  try { await commitSourceSnapshot(cache.workspace, source); await commitSourceSnapshot(cache.workspace, project); } finally { await cache.end(); }
  const read = async () => s.store.agents.revision((await s.store.agents.get(entry.id)).currentRevision);
  const start = async () => {
    const result = await s.api('POST', `/agents/${entry.id}/runs`, { input: { content: 'Read the project.' } });
    assert.equal(result.status, 202, JSON.stringify(result.body)); return { id: result.body.run_id, folder: runFolder(s.data, entry.id, result.body.run_id) };
  };
  const save = skills => s.api('PUT', `/agents/${entry.id}/definition`, { definition: { instructions: 'Answer.', tools: ['read'], skills: Object.keys(skills).filter(p => p.endsWith('/SKILL.md')).map(p => p.slice(0, -9)) }, skills });
  return { ...s, source, project, binding, read, start, save };
}

for (const operation of ['update', 'add', 'remove']) test(`ordinary owner ${operation} of moved skills reaches new runs and preserves already placed projects`, async t => {
  const f = await fixture(t), before = await f.start();
  const files = operation === 'remove' ? {} : operation === 'update' ? { 'continuity/SKILL.md': 'Explicit owner guidance.' }
    : { ...owned, 'added/SKILL.md': 'New owner skill.', 'added/reference.json': '{"value":17}\n' };
  const saved = await f.save(files); assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const current = await f.read();
  assert.equal(current.body.sourceSync.snapshot, f.source.digest, 'source provenance remains the last imported snapshot');
  assert.equal(current.body.sourceSync.configuration, f.binding.configuration, 'later source updates must still detect the owner edit');
  const after = await f.start();
  assert.equal(await readFile(join(after.folder, 'state.txt'), 'utf8'), 'Latest managed work');
  assert.equal(await readFile(join(before.folder, '.agents/skills/continuity/SKILL.md'), 'utf8'), 'Task-edited guidance.', 'saved edits never rewrite admitted or resumed run files');
  if (operation === 'remove') await assert.rejects(stat(join(after.folder, '.agents/skills/continuity')), { code: 'ENOENT' });
  else {
    assert.equal(await readFile(join(after.folder, '.agents/skills/continuity/SKILL.md'), 'utf8'), operation === 'update' ? 'Explicit owner guidance.' : 'Task-edited guidance.');
    assert.equal((await stat(join(after.folder, '.agents/skills/continuity/SKILL.md'))).mode & 0o777, 0o640);
    assert.deepEqual(await readFile(join(after.folder, '.agents/skills/continuity/asset.bin')), binary);
    assert.equal((await stat(join(after.folder, '.agents/skills/continuity/script.sh'))).mode & 0o777, 0o751);
  }
  if (operation === 'add') {
    assert.equal(await readFile(join(after.folder, '.agents/skills/added/SKILL.md'), 'utf8'), 'New owner skill.');
    assert.equal(await readFile(join(after.folder, '.agents/skills/added/reference.json'), 'utf8'), '{"value":17}\n');
  }
  assert.notEqual(current.body.sourceSync.project, f.project.digest, 'a successful skill save must pin a new immutable project');
  assert.equal((await f.save(files)).status, 200);
  assert.equal((await f.read()).id, current.id, 'an identical save does not add another revision or snapshot');
  assert.deepEqual(await f.store.settings.all({ prefix: sourceIOPrefix('skill-edits') }), []);
  const cache = await sourceWorkspace(f.store, 'skill-edits', { data: f.data, sealKey: undefined, env: {} });
  try { assert.equal((await readSourceSnapshot(cache.workspace, f.project.digest)).digest, f.project.digest, 'old immutable project remains retained'); } finally { await cache.end(); }
});

test('owner skill saves keep nested authored paths discoverable by the moved harness', async t => {
  const f = await fixture(t), files = { ...owned, 'group/added/SKILL.md': 'Nested owner guidance.' };
  assert.equal((await f.save(files)).status, 200);
  const started = await f.start(), current = await f.read();
  const { movedSkillFiles } = await import('../dist/source-sync/claim.js');
  const { localWorkspace } = await import('../dist/workspace/local.js');
  assert.deepEqual(await movedSkillFiles(localWorkspace(started.folder), current.body.skills), ['continuity/SKILL.md', 'group/added/SKILL.md']);
  assert.equal(await readFile(join(started.folder, '.agents/skills/group/added/SKILL.md'), 'utf8'), 'Nested owner guidance.');
});

test('removing guidance can retain an explicitly owned companion without leaving native-discovered SKILL.md', async t => {
  const f = await fixture(t), reference = '{"retained":true}\n';
  assert.equal((await f.save({ ...owned, 'continuity/reference.json': reference })).status, 200);
  const saved = await f.save({ 'continuity/reference.json': reference });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const started = await f.start();
  assert.equal(await readFile(join(started.folder, '.agents/skills/continuity/reference.json'), 'utf8'), reference);
  assert.equal((await stat(join(started.folder, '.agents/skills/continuity'))).mode & 0o777, 0o750, 'a retained companion keeps its existing parent directory mode');
  await assert.rejects(stat(join(started.folder, '.agents/skills/continuity/SKILL.md')), { code: 'ENOENT' });
  await assert.rejects(stat(join(started.folder, '.agents/skills/continuity/asset.bin')), { code: 'ENOENT' });
});

test('removing an explicitly owned companion keeps the skill and its unedited imported assets', async t => {
  const f = await fixture(t);
  assert.equal((await f.save({ ...owned, 'continuity/reference.json': '{}\n' })).status, 200);
  assert.equal((await f.save(owned)).status, 200);
  const started = await f.start();
  await assert.rejects(stat(join(started.folder, '.agents/skills/continuity/reference.json')), { code: 'ENOENT' });
  assert.equal(await readFile(join(started.folder, '.agents/skills/continuity/SKILL.md'), 'utf8'), 'Task-edited guidance.');
  assert.deepEqual(await readFile(join(started.folder, '.agents/skills/continuity/asset.bin')), binary);
});

for (const ifMatch of [false, true]) test(`a racing managed checkpoint ${ifMatch ? 'refuses stale If-Match without changing the winner' : 'rebuilds the owner edit on the newest project'}`, async t => {
  const f = await fixture(t);
  const { getAgent, commitAgent } = await import('../dist/agents-store.js');
  const { prepareProjectSkillEdit } = await import('../dist/source-sync/skill-edits.js');
  const input = await getAgent(f.store, 'skill-edits'), later = structuredClone(f.project), text = Buffer.from('Work checkpointed during save'), sha = createHash('sha256').update(text).digest('hex');
  const state = later.entries.find(entry => entry.path === 'project/state.txt'), previousSha = state.sha256;
  state.sha256 = sha; state.bytes = text.length; delete later.blobs[previousSha]; later.blobs[sha] = text.toString('base64'); later.digest = sourceSnapshotDigest(later);
  const cache = await sourceWorkspace(f.store, 'skill-edits', { data: f.data, sealKey: undefined, env: {} });
  try { await commitSourceSnapshot(cache.workspace, later); } finally { await cache.end(); }
  const prepare = prepareProjectSkillEdit(f.store, 'skill-edits', { data: f.data, sealKey: undefined, env: {} });
  let calls = 0;
  const edit = commitAgent(f.store, input, { definition: { instructions: 'Answer.', tools: ['read'] }, skills: { 'continuity/SKILL.md': 'Owner update after racing work.' } }, {
    ...(ifMatch ? { ifCurrent: input.revision.id } : {}),
    prepare: async (revision, current) => {
      const result = await prepare(revision, current);
      assert.equal((await f.store.settings.all({ prefix: sourceIOPrefix('skill-edits') })).length, 1, 'storage ownership spans revision publication');
      if (++calls === 1) await f.store.agents.addRevision({ agentId: 'skill-edits', id: 'checkpoint-winner', kind: current.kind, ifCurrent: current.id,
        body: { ...current.body, sourceSync: { ...current.body.sourceSync, project: later.digest } }, skills: current.skills });
      return result;
    },
  });
  if (ifMatch) { await assert.rejects(edit, error => error.code === 'precondition_failed'); assert.equal((await f.read()).id, 'checkpoint-winner'); assert.equal(calls, 1); }
  else { await edit; assert.equal(calls, 2, 'the second attempt must prepare from the newer project'); }
  assert.deepEqual(await f.store.settings.all({ prefix: sourceIOPrefix('skill-edits') }), []);
  const started = await f.start();
  assert.equal(await readFile(join(started.folder, 'state.txt'), 'utf8'), 'Work checkpointed during save');
  assert.equal(await readFile(join(started.folder, '.agents/skills/continuity/SKILL.md'), 'utf8'), ifMatch ? 'Task-edited guidance.' : 'Owner update after racing work.');
});

test('missing retained project bytes refuse a skill save before acquiring a writer or publishing a revision', async t => {
  const f = await fixture(t), before = await f.read();
  const cache = await sourceWorkspace(f.store, 'skill-edits', { data: f.data, sealKey: undefined, env: {} });
  try { await cache.workspace.remove(`blobs/${f.project.entries.find(entry => entry.path === 'project/state.txt').sha256}`, { force: true }); } finally { await cache.end(); }
  const result = await f.save({ 'continuity/SKILL.md': 'New owner intent.' });
  assert.notEqual(result.status, 200);
  assert.equal((await f.read()).id, before.id);
  assert.deepEqual(await f.store.settings.all({ prefix: sourceIOPrefix('skill-edits') }), []);
});

test('a lost remote snapshot-write acknowledgment keeps its I/O fence and never publishes the owner revision', async t => {
  const f = await fixture(t);
  const { getAgent, commitAgent } = await import('../dist/agents-store.js');
  const { prepareProjectSkillEdit, projectWithSkillEdits } = await import('../dist/source-sync/skill-edits.js');
  const { saveArchilSettings, storeAgentDisk } = await import('../dist/archil-settings.js');
  const { requireSourceIOIdle } = await import('../dist/source-sync/io.js');
  const { FakeArchilDisk } = await import('./fixtures/archil-fake.mjs');
  const { archilControlFetch } = await import('./archil-control-fake.mjs');
  const disk = new FakeArchilDisk(), diskId = 'dsk-4444444444444444';
  await saveArchilSettings(f.store, { region: 'aws-us-east-1', s3Url: 'https://s3.us-east-1.aws.archil.com' });
  await storeAgentDisk(f.store, 'skill-edits', { diskId });
  const control = archilControlFetch({ strict: true, disks: [{ id: diskId }] });
  const options = { data: f.data, sealKey: undefined, env: { ARCHIL_API_KEY: 'fake-test-key' }, control: { ...control, makeDisk: () => disk } };
  const cache = await sourceWorkspace(f.store, 'skill-edits', options);
  try { await commitSourceSnapshot(cache.workspace, f.project); } finally { await cache.end(); }
  const files = { 'continuity/SKILL.md': 'Owner edit whose acknowledgment is lost.' }, successor = projectWithSkillEdits(f.project, owned, files);
  const put = disk.putObject.bind(disk); let sent = 0;
  disk.putObject = async (key, body) => {
    await put(key, body);
    if (key.endsWith(`/manifests/${successor.digest}.json`)) { sent++; throw new Error('fixture lost storage acknowledgment after write'); }
  };
  const before = await getAgent(f.store, 'skill-edits');
  await assert.rejects(commitAgent(f.store, before, { definition: { instructions: 'Answer.', tools: ['read'] }, skills: files },
    { prepare: prepareProjectSkillEdit(f.store, 'skill-edits', options) }));
  assert.equal(sent, 1, 'an uncertain storage write is not resent automatically');
  assert.equal([...disk.files.keys()].some(key => key.endsWith(`/manifests/${successor.digest}.json`)), true, 'the remote side actually accepted bytes before its acknowledgment was lost');
  assert.equal((await f.read()).id, before.revision.id);
  assert.equal((await f.store.settings.all({ prefix: sourceIOPrefix('skill-edits') })).length, 1);
  await assert.rejects(requireSourceIOIdle(f.store, 'skill-edits'), /unresolved|source operation/);
});

for (const guidance of [true, false]) test(`owner-added ${guidance ? 'skills' : 'standalone companions'} survive the next Git checkpoint even when the project ignores .agents`, async t => {
  const f = await fixture(t), files = { ...owned, ...(guidance ? { 'group/added/SKILL.md': 'Keep the new owner skill.' } : {}), 'group/added/reference.json': '{"retained":true}\n' };
  assert.equal((await f.save(files)).status, 200);
  const started = await f.start(), current = await f.read();
  const { localWorkspace } = await import('../dist/workspace/local.js');
  const { captureProject } = await import('../dist/source-sync/capture-project.js');
  const { captureGit } = await import('../dist/source-sync/capture-git.js');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const scratchDir = await mkdtemp(join(tmpdir(), 'owner-skill-git-')); t.after(() => rm(scratchDir, { recursive: true, force: true }));
  const work = localWorkspace(started.folder), scratch = localWorkspace(scratchDir);
  const parentModes = { '.agents': 0o710, '.agents/skills': 0o750, '.agents/skills/group': 0o711 };
  for (const [path, mode] of Object.entries(parentModes)) await chmod(join(started.folder, path), mode);
  const git = async (...args) => {
    const answer = await work.exec(['git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args],
      { env: { PATH: '/usr/bin:/bin', LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, timeoutMs: 3000 });
    assert.equal(answer.code, 0, Buffer.from(answer.stderr).toString());
  };
  await git('init', '--quiet', '--template=', '--initial-branch=fixture');
  await work.write('.gitignore', '.agents/\ninputs/\n'); await git('add', 'state.txt', '.gitignore'); await git('commit', '--quiet', '-m', 'Fixture project');
  const cache = await sourceWorkspace(f.store, 'skill-edits', { data: f.data, sealKey: undefined, env: {} });
  let baseline; try { baseline = await readSourceSnapshot(cache.workspace, current.body.sourceSync.project); } finally { await cache.end(); }
  const captured = await captureProject({ workspace: work, baseline, exclude: [{ path: 'inputs/message.md', recursive: false }],
    git: (work, options) => captureGit(work, scratch, options) });
  for (const path of [...(guidance ? ['project/.agents/skills/group/added/SKILL.md'] : []), 'project/.agents/skills/group/added/reference.json'])
    assert.ok(captured.entries.some(entry => entry.path === path), 'Git ignore rules cannot discard an explicitly saved owner skill');
  for (const [path, mode] of Object.entries(parentModes))
    assert.equal(captured.entries.find(entry => entry.path === `project/${path}`)?.mode, mode, 'retained ignored parent directories keep their exact modes');
});
