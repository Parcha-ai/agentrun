import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openSqliteStore } from '../dist/store/index.js';
import { launchBody, readLaunchBody } from '../dist/run-launch.js';
import { learningWorkspace } from '../dist/learn/folder.js';
import { startAudit } from '../dist/runner/audit.js';
import { runProjectCheckpoint } from '../dist/runner/project-checkpoint.js';
import { projectCandidate, projectCheckpointStatuses, reconcileProjectCheckpoints } from '../dist/source-sync/checkpoints.js';

const binding = { id: 'a'.repeat(64), snapshot: 'b'.repeat(64), project: 'b'.repeat(64), configuration: 'c'.repeat(64) };
const placed = { version: 1, sourceId: binding.id, baselineRevision: 'revision', digest: binding.project, receipt: 'd'.repeat(64) };
const base = { input: { content: 'Answer the question.' }, title: 'Question', place: { mode: 'runner' }, sourceProject: placed };
const check = { of: 'served', workflow: 'answer', digest: 'e'.repeat(64) };
async function fixture(t) {
  const data = await mkdtemp(join(tmpdir(), 'source-learning-'));
  const store = await openSqliteStore({ file: join(data, 'store.sqlite'), role: 'server' });
  t.after(async () => { await store.close(); await rm(data, { recursive: true, force: true }); });
  await store.agents.create({ id: 'agent', name: 'Fixture' }, { id: 'revision', kind: 'agentic', body: { instructions: 'Answer.', tools: [], learning: { audit_every: 1 }, sourceSync: binding } });
  return { store, data };
}

test('a read-only moved agent starts an audit through fresh auxiliary admission, without copying its parent receipt', async t => {
  const { store, data } = await fixture(t), calls = [], logs = [];
  const launch = { ...base, learning: { seed: '0'.repeat(40), section: '', seededAt: Date.now() } };
  await store.runs.create({ id: 'served', agentId: 'agent', revisionId: 'revision' }, { body: launchBody(launch) });
  await startAudit({ store, agentId: 'agent', runId: 'served', revisionId: 'revision', launch, context: {},
    folder: () => learningWorkspace({ mode: 'local', data, agentId: 'agent' }), shown: async () => ({ text: value => value }), log: value => logs.push(value),
    admitAuxiliary: async request => { calls.push(request); return { run: { id: request.runId }, created: true }; },
  }, { name: check.workflow, digest: check.digest });
  assert.equal(calls.length, 1, logs.join('\n'));
  assert.equal(calls[0].revisionId, 'revision'); assert.equal(calls[0].launch.sourceProject, undefined);
  assert.deepEqual(calls[0].launch.audit, check);
  assert.equal(calls[0].launch.learning, undefined, 'the shadow does not compile or change learning');
  assert.deepEqual((await store.agents.revision('revision')).body.learning, { audit_every: 1 });
});

test('auxiliary placement does not bypass the existing conservative audit tool policy', async t => {
  const { store, data } = await fixture(t), logs = [];
  await store.agents.addRevision({ agentId: 'agent', id: 'writer-revision', kind: 'agentic', body: { instructions: 'Answer.', tools: ['read'], learning: { audit_every: 1 }, sourceSync: binding } });
  const launch = { ...base, sourceProject: { ...placed, baselineRevision: 'writer-revision' }, learning: { seed: '0'.repeat(40), section: '', seededAt: Date.now() } };
  await store.runs.create({ id: 'served', agentId: 'agent', revisionId: 'writer-revision' }, { body: launchBody(launch) });
  await startAudit({ store, agentId: 'agent', runId: 'served', revisionId: 'writer-revision', launch, context: {},
    folder: () => learningWorkspace({ mode: 'local', data, agentId: 'agent' }), shown: async () => ({ text: value => value }), log: value => logs.push(value),
    admitAuxiliary: async () => assert.fail('placement must not relax the audit capability policy'),
  }, { name: check.workflow, digest: check.digest });
  assert.match(logs.join('\n'), /audits off: read can write/);
});

for (const kind of ['audit', 'replay']) test(`${kind} drains and syncs its private project but never reads or captures a publishable snapshot`, async t => {
  const { store, data } = await fixture(t), events = [];
  const launch = { ...base, [kind]: check };
  await store.runs.create({ id: kind, agentId: 'agent', revisionId: 'revision' }, { body: launchBody(launch) });
  const claim = await store.claim(kind, 'fixture', { leaseMs: 60_000 });
  const hook = runProjectCheckpoint({ store, agentId: 'agent', claim, launch,
    tools: { get workspace() { assert.fail('auxiliary completion must not capture project content'); }, settleProject: async () => { events.push('settle'); return []; } },
    computer: { syncProject: async () => { events.push('sync'); } }, workspace: { data, sealKey: undefined }, secrets: async () => assert.fail('no auxiliary snapshot secret scan'),
  });
  const receipt = await hook.capture(new AbortController().signal);
  assert.deepEqual(events, ['settle', 'sync']);
  assert.deepEqual(receipt, { version: 1, status: 'discarded', sourceId: binding.id, runId: kind, epoch: 1, reason: 'auxiliary_project_changes_not_applied' });
});

for (const kind of ['audit', 'replay']) test(`${kind} cancellation waits for an already dispatched sync and retains uncertain write ownership`, async t => {
  const { store, data } = await fixture(t);
  const { sourceIOPrefix } = await import('../dist/source-sync/io.js');
  const launch = { ...base, [kind]: check };
  await store.runs.create({ id: kind, agentId: 'agent', revisionId: 'revision' }, { body: launchBody(launch) });
  const claim = await store.claim(kind, 'fixture', { leaseMs: 60_000 }), abort = new AbortController();
  let entered, finish;
  const syncEntered = new Promise(resolve => { entered = resolve; }), syncDone = new Promise(resolve => { finish = resolve; });
  t.after(() => finish());
  const hook = runProjectCheckpoint({ store, agentId: 'agent', claim, launch,
    tools: { get workspace() { assert.fail('an auxiliary cancellation must not capture project content'); }, settleProject: async () => [] },
    computer: { syncProject: async signal => { assert.equal(signal, abort.signal); entered(); await syncDone; } },
    workspace: { data, sealKey: undefined }, secrets: async () => assert.fail('no auxiliary snapshot secret scan'),
  });
  let settled = false;
  const outcome = hook.capture(abort.signal).then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
  await syncEntered;
  abort.abort(new Error('private fixture cancellation'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'a cancellation signal does not prove remote sync has stopped');
  assert.equal((await store.settings.all({ prefix: sourceIOPrefix('agent') })).length, 1);
  finish();
  assert.equal((await outcome).error, abort.signal.reason);
  assert.equal((await store.settings.all({ prefix: sourceIOPrefix('agent') })).length, 1, 'an uncertain outcome is never cleared by elapsed time or return');
  assert.equal(hook.uncertain().stage, 'sync');
  assert.equal(JSON.stringify(hook.uncertain()).includes('private fixture'), false);
});

async function withSnapshot(t) {
  const f = await fixture(t);
  const { sourceSnapshotDigest } = await import('../dist/native/source-snapshot-types.js');
  const { commitSourceSnapshot } = await import('../dist/source-sync/snapshots.js');
  const { sourceWorkspace } = await import('../dist/source-sync/workspace.js');
  const { sourceAuxiliaryAdmitter } = await import('../dist/source-sync/auxiliary.js');
  const bytes = Buffer.from([0, 255, 128, 10]), sha256 = createHash('sha256').update(bytes).digest('hex');
  const content = { version: 1, complete: true,
    source: { runtime: 'codex', machine_id: 'fixture', project: '/fixture/project', selector: { kind: 'project' } },
    entries: [{ path: 'project', role: 'project', type: 'directory', mode: 0o755, bytes: 0 },
      { path: 'project/asset.bin', role: 'project', type: 'file', mode: 0o640, bytes: bytes.length, sha256 }],
    blobs: { [sha256]: bytes.toString('base64') }, instructions: { text: '', layers: [] }, skills: [],
    configuration: { model: null, tools: [], permissions: {}, credentials: [] }, project: { git: null }, blockers: [] };
  const snapshot = { ...content, digest: sourceSnapshotDigest(content) }, source = { ...binding, project: snapshot.digest, snapshot: snapshot.digest };
  await f.store.agents.addRevision({ agentId: 'agent', id: 'source-revision', kind: 'agentic', body: { instructions: 'Answer.', tools: ['read'], learning: { audit_every: 1 }, sourceSync: source } });
  const cache = await sourceWorkspace(f.store, 'agent', { data: f.data, sealKey: undefined });
  try { await commitSourceSnapshot(cache.workspace, snapshot); } finally { await cache.end(); }
  const admit = sourceAuxiliaryAdmitter(f.store, { data: f.data, sealKey: undefined });
  const request = { agentId: 'agent', runId: 'auxiliary', revisionId: 'source-revision', launch: { input: base.input, title: 'Replay', place: base.place,
    learning: { seed: '0'.repeat(40), section: '', seededAt: Date.now() }, replay: check } };
  // The source run must exist: the store's ordinary replay-origin retention rule still applies.
  await f.store.runs.create({ id: 'served', agentId: 'agent', revisionId: 'source-revision' }, { body: launchBody({ input: base.input, title: 'Served', place: base.place }) });
  return { ...f, admit, request, source, bytes };
}

test('real auxiliary placement keeps exact binary bytes/modes and reserved revision after current changes; retry preserves edits', async t => {
  const f = await withSnapshot(t), { runFolder } = await import('../dist/workspace/paths.js');
  await f.store.agents.addRevision({ agentId: 'agent', id: 'new-current', kind: 'agentic', body: { instructions: 'New setup.', sourceSync: { ...f.source, project: 'f'.repeat(64) } } });
  const first = await f.admit(f.request); assert.equal(first.created, true);
  const launch = readLaunchBody((await f.store.runs.launch('auxiliary')).body);
  assert.equal(launch.sourceProject.digest, f.source.project); assert.equal(launch.sourceProject.baselineRevision, 'source-revision');
  const file = join(runFolder(f.data, 'agent', 'auxiliary'), 'asset.bin');
  assert.deepEqual(await readFile(file), f.bytes); assert.equal((await stat(file)).mode & 0o777, 0o640);
  await writeFile(file, 'auxiliary changes stay private');
  const second = await f.admit(f.request); assert.equal(second.created, false);
  assert.equal(await readFile(file, 'utf8'), 'auxiliary changes stay private');
  assert.equal((await f.store.agents.get('agent')).currentRevision, 'new-current');
  await assert.rejects(f.admit({ ...f.request, launch: { ...f.request.launch, title: 'Different replay' } }), /different or unavailable launch/);
});

test('a supplied parent placement receipt is refused before any new run or destination write', async t => {
  const f = await withSnapshot(t);
  await assert.rejects(f.admit({ ...f.request, launch: { ...f.request.launch, sourceProject: placed } }), /fresh project placement/);
  assert.equal(await f.store.runs.get('auxiliary'), undefined);
});

test('a stale reserved learning seed cannot create a project after reset', async t => {
  const f = await withSnapshot(t), { resetAtKey } = await import('../dist/learn/promote.js');
  await f.store.settings.put(resetAtKey('agent'), { at: f.request.launch.learning.seededAt });
  await assert.rejects(f.admit(f.request), /learning was reset/);
  assert.equal(await f.store.runs.get('auxiliary'), undefined);
});

test('competing reserved-run preparations never share a destination or take over an unresolved writer', async t => {
  const f = await fixture(t), { auxiliaryAdmitter } = await import('../dist/source-sync/auxiliary.js');
  const { sourceIOPrefix } = await import('../dist/source-sync/io.js');
  const second = await openSqliteStore({ file: join(f.data, 'store.sqlite'), role: 'runner' }); t.after(() => second.close());
  await f.store.runs.create({ id: 'served', agentId: 'agent', revisionId: 'revision' }, { body: launchBody({ input: {}, title: 'Served', place: base.place }) });
  const reached = Promise.withResolvers(), unblock = Promise.withResolvers(); let opens = 0;
  const project = { async place({ launch }) { opens++; reached.resolve(); await unblock.promise; return { launch: { ...launch, sourceProject: placed }, undo: async () => assert.fail('no rollback of an admitted run') }; } };
  const request = { agentId: 'agent', runId: 'auxiliary', revisionId: 'revision', launch: { input: {}, title: 'Replay', place: base.place, replay: check } };
  const first = auxiliaryAdmitter(f.store, { data: f.data, project })(request);
  await reached.promise;
  // Different process queues, same real store: the durable receipt must arbitrate this race itself.
  await assert.rejects(auxiliaryAdmitter(second, { data: join(f.data, 'other-process'), project })(request), /source operation is still writing/);
  assert.equal(opens, 1); assert.equal((await second.settings.all({ prefix: sourceIOPrefix('agent') })).length, 1);
  unblock.resolve(); await first;
  assert.equal((await second.settings.all({ prefix: sourceIOPrefix('agent') })).length, 0);
});

for (const outcome of ['lost-committed', 'lost-absent', 'refused']) test(`auxiliary ${outcome} admission obeys original rollback and retained-writer rules`, async t => {
  const f = await fixture(t), { auxiliaryAdmitter } = await import('../dist/source-sync/auxiliary.js');
  const { sourceIOPrefix } = await import('../dist/source-sync/io.js');
  const { StoreConstraint } = await import('../dist/store/store.js');
  await f.store.runs.create({ id: 'served', agentId: 'agent', revisionId: 'revision' }, { body: launchBody({ input: {}, title: 'Served', place: base.place }) });
  const error = outcome === 'refused' ? new StoreConstraint('definite fixture refusal') : new Error('fixture unknown admission'); let undone = 0, opened = 0;
  const store = { ...f.store, runs: { ...f.store.runs, create: async (...args) => { if (outcome === 'lost-committed') await f.store.runs.create(...args); throw error; } } };
  const project = { place: async ({ launch }) => { opened++; return { launch: { ...launch, sourceProject: placed }, undo: async () => { undone++; } }; } };
  const admit = auxiliaryAdmitter(store, { data: f.data, project });
  const request = { agentId: 'agent', runId: 'auxiliary', revisionId: 'revision', launch: { input: {}, title: 'Replay', place: base.place, replay: check } };
  if (outcome === 'lost-committed') assert.equal((await admit(request)).run.id, 'auxiliary');
  else await assert.rejects(admit(request), actual => actual === error);
  assert.equal(undone, outcome === 'refused' ? 1 : 0);
  assert.equal((await f.store.settings.all({ prefix: sourceIOPrefix('agent') })).length, outcome === 'lost-absent' ? 1 : 0);
  if (outcome === 'lost-absent') { await assert.rejects(admit(request), /source operation is still writing/); assert.equal(opened, 1); }
});

for (const kind of ['audit', 'replay']) test(`${kind} can never publish even a structurally valid forged project candidate`, async () => {
  const candidate = projectCandidate({ sourceId: binding.id, runId: kind, epoch: 1, baselineRevision: 'revision', baselineDigest: binding.project, digest: 'f'.repeat(64) });
  const store = { runs: { projectCheckpoints: async () => [{ runId: kind, revisionId: 'revision', entryId: 1, attemptEpoch: 1, checkpoint: candidate }],
    get: async () => ({ id: kind, agentId: 'agent', revisionId: 'revision', epoch: 1 }), launch: async () => ({ body: launchBody({ ...base, [kind]: check }) }) },
    agents: { revision: async () => ({ id: 'revision', agentId: 'agent', kind: 'agentic', body: { sourceSync: binding }, skills: null, mcpPin: null }),
      get: async () => ({ currentRevision: 'revision', archivedAt: null, purgedAt: null }), addRevision: async () => assert.fail('auxiliary writes reached current project publication') } };
  const statuses = await reconcileProjectCheckpoints(store, 'agent');
  assert.equal(statuses.length, 1); assert.equal(statuses[0].status, 'uncertain');
  assert.equal(statuses[0].reason, 'auxiliary_project_changes_not_applied');
  store.runs.projectCheckpoints = async () => [{ runId: kind, revisionId: 'revision', entryId: 2, attemptEpoch: 1, checkpoint: { version: 1, status: 'discarded', sourceId: binding.id, runId: kind, epoch: 1, reason: 'auxiliary_project_changes_not_applied' } }];
  assert.deepEqual(await projectCheckpointStatuses(store, 'agent'), [], 'successful auxiliary settlement cannot block the next normal run');
  store.runs.get = async () => ({ id: kind, agentId: 'agent', revisionId: 'revision', epoch: 2 });
  store.runs.projectCheckpoints = async () => [{ runId: kind, revisionId: 'revision', entryId: 3, attemptEpoch: 2, checkpoint: { version: 1, status: 'discarded', sourceId: binding.id, runId: kind, epoch: 1, reason: 'auxiliary_project_changes_not_applied' } }];
  assert.equal((await projectCheckpointStatuses(store, 'agent'))[0]?.status, 'uncertain', 'a stale discard cannot settle a later attempt');
  store.runs.projectCheckpoints = async () => [
    { runId: kind, revisionId: 'revision', entryId: 2, attemptEpoch: 1, checkpoint: {} },
    { runId: kind, revisionId: 'revision', entryId: 3, attemptEpoch: 2, checkpoint: { version: 1, status: 'discarded', sourceId: binding.id, runId: kind, epoch: 2, reason: 'auxiliary_project_changes_not_applied' } },
  ];
  assert.deepEqual(await projectCheckpointStatuses(store, 'agent'), [], 'a later bound discard settles this auxiliary run without publishing its files');
});
