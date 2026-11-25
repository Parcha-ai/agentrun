import { beginSourceIO } from "../dist/source-sync/io.js";
// Actual runner/host-tool/filesystem/capture/store path, with a scripted adapter and no vendor calls. Native harness
// selection/discovery is covered separately by runner-cli-spec; this suite does not claim a live vendor session.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { commitWrites } from '@earendil-works/pi-durable/testing';
import { openSqliteStore } from '../dist/store/index.js';
import { startRunner } from '../dist/runner/runner.js';
import { createAdapterLoop } from '../dist/runner/adapter-loop.js';
import { localWorkspace } from '../dist/workspace/local.js';
import { runFolder } from '../dist/workspace/paths.js';
import { runTools } from '../dist/workspace/run-tools.js';
import { launchBody, readLaunchBody } from '../dist/run-launch.js';
import { sourceSnapshotDigest } from '../dist/native/source-snapshot-types.js';
import { commitSourceSnapshot, readSourceSnapshot } from '../dist/source-sync/snapshots.js';
import { sourceWorkspace, sourceSnapshotReader, openRunPlacement } from '../dist/source-sync/workspace.js';
import { projectPlacement } from '../dist/source-sync/projects.js';
import { piAdapterSpec, closeOpenSessions } from './conformance-pi-adapter.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const timing = { leaseMs: 60_000, renewEveryMs: 20_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 20 };
async function until(check) { const end = Date.now() + 30_000; for (;;) { const value = await check(); if (value) return value; if (Date.now() > end) throw new Error('fixture runner did not settle'); await new Promise(resolve => setTimeout(resolve, 20)); } }
async function setup(t, clock) {
  const data = await mkdtemp(join(tmpdir(), 'source-project-life-')), sealKey = Buffer.alloc(32, 7), store = await openSqliteStore({ dataDir: data, role: 'server', ...(clock ? { now: () => clock.now } : {}) });
  t.after(async () => { await closeOpenSessions(); await store.close(); await rm(data, { recursive: true, force: true }); });
  const options = { data, sealKey, env: {} }, blobs = {}, entries = [{ path: 'project', role: 'project', type: 'directory', mode: 0o750, bytes: 0 }];
  const file = (path, role, bytes, mode = 0o644) => { bytes = Buffer.from(bytes); const sha256 = hash(bytes); blobs[sha256] = bytes.toString('base64'); entries.push({ path, role, type: 'file', mode, bytes: bytes.length, sha256 }); };
  file('project/dirty.txt', 'project', 'source dirty');
  file('skills/fixture/check/SKILL.md', 'skill', '---\nname: check\ndescription: Execute the authored check script.\n---\nRead assets/reference.bin.\n');
  file('skills/fixture/check/scripts/check.sh', 'skill', '#!/bin/sh\nprintf authored-script', 0o755);
  file('skills/fixture/check/assets/reference.bin', 'skill', Uint8Array.of(0, 128, 255));
  const body = { version: 1, complete: true, source: { runtime: 'codex', machine_id: 'fixture', project: '/fixture/project', selector: { kind: 'project' } }, entries, blobs,
    instructions: { text: '', layers: [] }, skills: [{ name: 'check', path: 'skills/fixture/check', source: 'fixture' }], configuration: { model: null, tools: [], permissions: {}, credentials: [] }, project: { git: null }, blockers: [] };
  const snapshot = { ...body, digest: sourceSnapshotDigest(body) }, source = { id: 'a'.repeat(64), snapshot: snapshot.digest, project: snapshot.digest, configuration: 'b'.repeat(64) };
  await store.agents.create({ id: 'agent', name: 'Moved' }, { id: 'base', kind: 'agentic', body: { instructions: 'Work.', sourceSync: source } });
  const cache = await sourceWorkspace(store, 'agent', options); await commitSourceSnapshot(cache.workspace, snapshot); await cache.end();
  const placement = projectPlacement({ hold: ({ agentId }) => beginSourceIO(store, agentId, "placement"), snapshots: agentId => sourceSnapshotReader(store, agentId, options), destination: input => openRunPlacement(store, input, options) });
  async function admit(id) {
    const revision = await store.agents.revision((await store.agents.get('agent')).currentRevision);
    const placed = await placement.place({ agentId: 'agent', runId: id, revision, launch: { input: { content: 'Work.' }, title: 'Work', place: { mode: 'runner' } } });
    await store.runs.create({ id, agentId: 'agent', revisionId: revision.id, expectedCurrent: revision.id }, { body: launchBody(placed.launch) });
    await placed.admitted();
    return placed.launch;
  }
  return { data, store, options, snapshot, admit };
}

for (const failedSync of [false, true]) test(`actual run writes ${failedSync ? 'retain uncertainty after failed sync' : 'publish durable project bytes and executable skill assets for the next run'}`, { timeout: 45_000 }, async t => {
  const { runProjectCheckpoint } = await import('../dist/runner/project-checkpoint.js');
  const { reconcileProjectCheckpoints } = await import('../dist/source-sync/checkpoints.js');
  const f = await setup(t), launch = await f.admit('one'); let released = false;
  const runner = startRunner({ store: f.store, name: 'fixture-runner', ...timing, onEvent: event => { if (event.type === 'released') released = true; },
    createLoop: createAdapterLoop(async (claim, run) => {
      const tools = await runTools(localWorkspace(runFolder(f.data, 'agent', claim.runId)), undefined, { mode: 1, context: BACKGROUND_CONTEXT });
      const scripted = piAdapterSpec({ script: [{ call: 'write', args: { path: 'dirty.txt', content: 'managed edit' } }, { call: 'write', args: { path: 'new.txt', content: 'managed addition' } }, { say: 'Saved.' }], tools: {}, hooks: { beforeIntent: async () => {}, beforeResult: async () => {} } });
      const built = scripted(claim, run);
      return { ...built, agentId: 'agent', session: { ...built.session, tools: tools.hostTools(['read', 'write']) },
        projectCheckpoint: runProjectCheckpoint({ store: f.store, agentId: 'agent', claim, launch, tools, computer: { release: async () => {}, ...(failedSync ? { syncProject: async () => { throw new Error('fixture failed sync'); } } : {}) }, workspace: f.options, secrets: async () => [] }),
        release: () => tools.end() };
    }),
  });
  t.after(() => runner.close());
  await until(async () => { const row = await f.store.runs.get('one'); return row.state === 'ended' && released; });
  await runner.close();
  assert.equal(Buffer.from(await localWorkspace(runFolder(f.data, 'agent', 'one')).read('dirty.txt')).toString(), 'managed edit', 'the actual host write ran');
  const receipts = await f.store.runs.projectCheckpoints({ agentId: 'agent' }); assert.equal(receipts.length, 1);
  const status = await reconcileProjectCheckpoints(f.store, 'agent');
  if (failedSync) { assert.equal(receipts[0].checkpoint.status, 'uncertain'); assert.equal(receipts[0].checkpoint.stage, 'sync'); assert.equal(JSON.stringify(receipts[0].checkpoint).includes('fixture failed sync'), false); assert.equal(status[0].status, 'uncertain'); assert.equal((await f.store.agents.get('agent')).currentRevision, 'base'); return; }
  assert.equal(receipts[0].checkpoint.status, 'candidate'); assert.equal(status[0].status, 'published');
  await f.admit('two');
  const second = localWorkspace(runFolder(f.data, 'agent', 'two'));
  assert.equal(Buffer.from(await second.read('dirty.txt')).toString(), 'managed edit'); assert.equal(Buffer.from(await second.read('new.txt')).toString(), 'managed addition');
  assert.deepEqual([...await second.read('.agents/skills/check/assets/reference.bin')], [0, 128, 255]);
  const executed = await second.exec(['.agents/skills/check/scripts/check.sh'], { timeoutMs: 1000, maxOutput: 1000, env: {} });
  assert.equal(executed.code, 0); assert.equal(Buffer.from(executed.stdout).toString(), 'authored-script');
});

test('a superseded checkpoint writer prevents deletion after the replacement claim ends', { timeout: 30_000 }, async t => {
  const { runProjectCheckpoint } = await import('../dist/runner/project-checkpoint.js');
  const { requireSourceIOIdle, sourceIOPrefix } = await import('../dist/source-sync/io.js');
  const { purgingKey } = await import('../dist/agent-delete.js');
  const clock = { now: Date.now() }, f = await setup(t, clock), launch = await f.admit('one');
  const other = await openSqliteStore({ dataDir: f.data, role: 'runner', now: () => clock.now });
  t.after(() => other.close());
  const claim = await f.store.claim('one', 'old-writer', { leaseMs: 1000 });
  const tools = await runTools(localWorkspace(runFolder(f.data, 'agent', 'one')), undefined, { mode: 1, context: BACKGROUND_CONTEXT });
  const entered = Promise.withResolvers(), finish = Promise.withResolvers(), settle = tools.settleProject;
  tools.settleProject = async () => { entered.resolve(); await finish.promise; return settle(); };
  const hook = runProjectCheckpoint({ store: f.store, agentId: 'agent', claim, launch, tools, computer: { release: async () => {} }, workspace: f.options, secrets: async () => [] });
  const pending = hook.capture(new AbortController().signal); pending.catch(() => {});
  try {
    await entered.promise;
    clock.now += 2000;
    const replacement = await other.claim('one', 'replacement', { leaseMs: 60_000 });
    assert.equal(replacement.epoch, claim.epoch + 1);
    const journal = other.journal(replacement);
    await commitWrites(journal, [{ type: 'conversation', value: { id: 1 } }], BACKGROUND_CONTEXT);
    const entryId = await journal.mintId(); journal.stage({ run: { state: 'ended' }, effect: entryId });
    await commitWrites(journal, [{ type: 'entry', value: { id: entryId, conversationId: 1, kind: 'agentrun.end', data: { state: 'ended' } } }], BACKGROUND_CONTEXT);
    await journal.close();
    assert.equal((await other.runs.get('one')).state, 'ended', 'the live-run deletion fence no longer protects the old writer');
    await other.agents.archive('agent', true); await other.settings.put(purgingKey('agent'), true);
    await assert.rejects(requireSourceIOIdle(other, 'agent'), /source.*operation|source.*writ/i);
    assert.equal((await other.settings.all({ prefix: sourceIOPrefix('agent') })).length, 1);
    finish.resolve(); const candidate = await pending;
    assert.equal(candidate.status, 'candidate'); assert.equal(candidate.epoch, claim.epoch);
    assert.deepEqual(await other.runs.projectCheckpoints({ agentId: 'agent' }), [{ runId: 'one', revisionId: 'base', entryId, attemptEpoch: replacement.epoch, checkpoint: {} }],
      'the replacement end is missing a checkpoint; the uncommitted old candidate never bypasses the terminal journal fence');
    const { projectCheckpointStatuses } = await import('../dist/source-sync/checkpoints.js');
    assert.equal((await projectCheckpointStatuses(other, 'agent'))[0].status, 'uncertain');
    assert.equal((await other.agents.get('agent')).currentRevision, 'base', 'the orphan candidate never advances the saved project');
    await requireSourceIOIdle(other, 'agent');
  } finally { finish.resolve(); await pending.catch(() => {}); await tools.end(); }
});

test('an aborted dispatched checkpoint retains I/O ownership until its outcome is resolved', { timeout: 30_000 }, async t => {
  const { runProjectCheckpoint } = await import('../dist/runner/project-checkpoint.js');
  const { requireSourceIOIdle } = await import('../dist/source-sync/io.js');
  const f = await setup(t), launch = await f.admit('one'), claim = await f.store.claim('one', 'writer');
  const tools = await runTools(localWorkspace(runFolder(f.data, 'agent', 'one')), undefined, { mode: 1, context: BACKGROUND_CONTEXT });
  const entered = Promise.withResolvers(), finish = Promise.withResolvers(), controller = new AbortController(); let done = false;
  const hook = runProjectCheckpoint({ store: f.store, agentId: 'agent', claim, launch, tools, computer: { release: async () => {}, syncProject: async signal => {
    entered.resolve(); await finish.promise; signal.throwIfAborted();
  } }, workspace: f.options, secrets: async () => [] });
  const pending = hook.capture(controller.signal).finally(() => { done = true; }); pending.catch(() => {});
  try {
    await entered.promise; controller.abort(new Error('fixture sync outcome unknown'));
    await new Promise(resolve => setImmediate(resolve)); assert.equal(done, false);
    await assert.rejects(requireSourceIOIdle(f.store, 'agent'), /source.*operation|source.*writ/i);
    finish.resolve(); await assert.rejects(pending, /fixture sync outcome unknown/);
    assert.equal(hook.uncertain().stage, 'sync');
    await assert.rejects(requireSourceIOIdle(f.store, 'agent'), /source.*operation|source.*writ/i);
  } finally { finish.resolve(); await pending.catch(() => {}); await tools.end(); }
});

test('an unavailable read-only baseline refuses before checkpoint writes or I/O ownership', async t => {
  const { runProjectCheckpoint } = await import('../dist/runner/project-checkpoint.js');
  const { sourceIOPrefix } = await import('../dist/source-sync/io.js');
  const f = await setup(t), launch = await f.admit('one'), claim = await f.store.claim('one', 'writer');
  const cache = await sourceWorkspace(f.store, 'agent', f.options);
  await cache.workspace.remove(`manifests/${f.snapshot.digest}.json`, { force: true }); await cache.end();
  let dispatched = false;
  const hook = runProjectCheckpoint({ store: f.store, agentId: 'agent', claim, launch, tools: { settleProject: async () => { dispatched = true; return []; } },
    computer: { release: async () => {} }, workspace: f.options, secrets: async () => [] });
  await assert.rejects(hook.capture(new AbortController().signal));
  assert.equal(dispatched, false); assert.equal(hook.uncertain().stage, 'read');
  assert.deepEqual(await f.store.settings.all({ prefix: sourceIOPrefix('agent') }), []);
});

test('a capture deadline cannot commit the end or release resources before the actual capture settles', { timeout: 30_000 }, async t => {
  const f = await setup(t); await f.admit('one');
  const aborted = Promise.withResolvers(), finish = Promise.withResolvers(); let released = false;
  const uncertain = { version: 1, status: 'uncertain', sourceId: 'a'.repeat(64), runId: 'one', epoch: 1, reason: 'project_not_settled' };
  const runner = startRunner({ store: f.store, name: 'fixture-runner', ...timing,
    createLoop: createAdapterLoop(async (claim, run) => ({ ...piAdapterSpec({ script: [{ say: 'Saved.' }], tools: {}, hooks: { beforeIntent: async () => {}, beforeResult: async () => {} } })(claim, run), agentId: 'agent',
      projectCheckpoint: { timeoutMs: 20, uncertain: () => uncertain, capture: async signal => { signal.addEventListener('abort', () => aborted.resolve(), { once: true }); if (signal.aborted) aborted.resolve(); await finish.promise; return uncertain; } },
      release: async () => { released = true; } })),
  });
  t.after(async () => { finish.resolve(); await runner.close(); });
  await aborted.promise;
  assert.equal((await f.store.runs.get('one')).state, 'running'); assert.equal(released, false);
  assert.deepEqual(await f.store.runs.projectCheckpoints({ agentId: 'agent' }), []);
  finish.resolve(); await until(async () => (await f.store.runs.get('one')).state === 'ended' && released);
  assert.equal((await f.store.runs.projectCheckpoints({ agentId: 'agent' }))[0].checkpoint.status, 'uncertain');
});
