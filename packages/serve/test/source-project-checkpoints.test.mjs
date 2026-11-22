import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { commitWrites } from '@earendil-works/pi-durable/testing';
import { storeOn } from './store-helpers.mjs';
const api = () => import('../dist/source-sync/checkpoints.js');
const source = { id: 'a'.repeat(64), snapshot: 'b'.repeat(64), project: 'b'.repeat(64), configuration: 'c'.repeat(64) };
async function fixture(t) {
  const { store } = await storeOn(t);
  await store.agents.create({ id: 'agent', name: 'Moved' }, { id: 'base', kind: 'agentic', body: { instructions: 'Kept policy.', sourceSync: source }, mcpPin: { kept: true } });
  return store;
}
async function run(store, id, revision = 'base', baseline = source.project) {
  await store.runs.create({ id, agentId: 'agent', revisionId: revision }, { body: { input: { content: 'Work.' }, title: 'Work', place: { mode: 'runner' }, source_project: { version: 1, sourceId: source.id, baselineRevision: revision, digest: baseline, receipt: 'd'.repeat(64) } } });
  const claim = await store.claim(id, 'fixture-runner', { leaseMs: 60_000 }), journal = store.journal(claim);
  await commitWrites(journal, [{ type: 'conversation', value: { id: 1 } }], BACKGROUND_CONTEXT);
  return { claim, journal };
}
async function terminal(journal, checkpoint) {
  const id = await journal.mintId(); journal.stage({ run: { state: 'ended' }, effect: id });
  await commitWrites(journal, [{ type: 'entry', value: { id, conversationId: 1, kind: 'agentrun.end', data: { state: 'ended', projectCheckpoint: checkpoint } } }], BACKGROUND_CONTEXT);
  await journal.close();
}
async function candidate(id, epoch = 1, baselineRevision = 'base', baselineDigest = source.project, digest = 'e'.repeat(64)) {
  return (await api()).projectCandidate({ sourceId: source.id, runId: id, epoch, baselineRevision, baselineDigest, digest });
}

test('only a committed terminal candidate advances its exact baseline, preserving policy and pins', async t => {
  const store = await fixture(t), active = await run(store, 'one'), own = await candidate('one');
  const { reconcileProjectCheckpoints } = await api();
  assert.deepEqual(await reconcileProjectCheckpoints(store, 'agent'), []);
  assert.equal((await store.agents.get('agent')).currentRevision, 'base');
  await terminal(active.journal, own);
  const status = await reconcileProjectCheckpoints(store, 'agent');
  assert.equal(status[0].status, 'published');
  const saved = await store.agents.revision(own.revision);
  assert.equal(saved.parent, 'base'); assert.equal(saved.body.sourceSync.project, own.digest);
  assert.equal(saved.body.instructions, 'Kept policy.'); assert.deepEqual(saved.mcpPin, { kept: true });
  await store.agents.addRevision({ agentId: 'agent', id: 'owner-edit', kind: 'agentic', body: { ...saved.body, instructions: 'Owner edit.' } });
  assert.equal((await reconcileProjectCheckpoints(store, 'agent'))[0].status, 'published');
  assert.equal((await store.agents.get('agent')).currentRevision, 'owner-edit', 'idempotent publication cannot reset a newer pointer');
});

test('concurrent candidates retain the losing checkpoint and never overwrite or rebase it', async t => {
  const store = await fixture(t), a = await run(store, 'a'), b = await run(store, 'b');
  const first = await candidate('a'), second = await candidate('b', 1, 'base', source.project, 'f'.repeat(64));
  await terminal(a.journal, first); await terminal(b.journal, second);
  const { reconcileProjectCheckpoints } = await api();
  const results = await reconcileProjectCheckpoints(store, 'agent');
  assert.deepEqual(results.map(row => row.status), ['published', 'conflict']);
  assert.equal((await store.agents.get('agent')).currentRevision, first.revision);
  assert.equal(await store.agents.revision(second.revision), undefined);
  assert.equal((await store.runs.projectCheckpoints({ agentId: 'agent', runId: 'b' }))[0].checkpoint.digest, second.digest);
});

test('a publication response lost after commit resolves by the exact deterministic revision', async t => {
  const store = await fixture(t), active = await run(store, 'lost'), own = await candidate('lost'); await terminal(active.journal, own);
  const original = store.agents.addRevision;
  store.agents.addRevision = async value => { await original(value); throw new Error('fixture lost commit response'); };
  assert.equal((await (await api()).reconcileProjectCheckpoints(store, 'agent'))[0].status, 'published');
  assert.equal((await store.agents.get('agent')).currentRevision, own.revision);
});

test('uncertain and unbound receipts cannot publish a project', async t => {
  const store = await fixture(t), a = await run(store, 'uncertain'), b = await run(store, 'invalid');
  await terminal(a.journal, { version: 1, status: 'uncertain', sourceId: source.id, runId: 'uncertain', epoch: 1, reason: 'project_not_settled' });
  await terminal(b.journal, { ...await candidate('invalid'), baselineRevision: 'unrelated' });
  const results = await (await api()).reconcileProjectCheckpoints(store, 'agent');
  assert.deepEqual(results.map(row => row.status).sort(), ['uncertain', 'uncertain']);
  assert.equal((await store.agents.get('agent')).currentRevision, 'base');
});

test('a reopened run checkpoints from its own committed predecessor rather than resetting to the original project', async t => {
  const store = await fixture(t), first = await run(store, 'follow'), initial = await candidate('follow'); await terminal(first.journal, initial);
  const { reconcileProjectCheckpoints, projectBaseline } = await api(); await reconcileProjectCheckpoints(store, 'agent');
  await store.runs.reopen('follow', { kind: 'steer', body: { text: 'Continue.' } });
  const claim = await store.claim('follow', 'second-runner', { leaseMs: 60_000 }), journal = store.journal(claim);
  assert.deepEqual(await projectBaseline(store, 'follow'), { sourceId: source.id, revision: initial.revision, digest: initial.digest, epoch: 1 });
  const later = await candidate('follow', claim.epoch, initial.revision, initial.digest, 'f'.repeat(64)); await terminal(journal, later);
  assert.deepEqual((await reconcileProjectCheckpoints(store, 'agent')).map(row => row.status), ['published', 'published']);
  assert.equal((await store.agents.get('agent')).currentRevision, later.revision);
  assert.equal((await store.agents.revision(later.revision)).parent, initial.revision);
});

test('read-only checkpoint status distinguishes a pending candidate without moving the agent pointer', async t => {
  const store = await fixture(t), active = await run(store, 'pending'), own = await candidate('pending'); await terminal(active.journal, own);
  const { projectCheckpointStatuses } = await api();
  assert.equal((await projectCheckpointStatuses(store, 'agent'))[0].status, 'pending');
  assert.equal((await store.agents.get('agent')).currentRevision, 'base'); assert.equal(await store.agents.revision(own.revision), undefined);
  await store.agents.addRevision({ agentId: 'agent', id: 'owner-edit', kind: 'agentic', body: { instructions: 'Owner choice.', sourceSync: source } });
  assert.equal((await projectCheckpointStatuses(store, 'agent'))[0].status, 'conflict');
  assert.equal((await store.agents.get('agent')).currentRevision, 'owner-edit');
});


test('read-only status retains a bound uncertainty reason and reports an already published checkpoint without writing', async t => {
  const store = await fixture(t), first = await run(store, 'done'), own = await candidate('done'); await terminal(first.journal, own);
  const { projectCheckpointStatuses, reconcileProjectCheckpoints } = await api(); await reconcileProjectCheckpoints(store, 'agent');
  const second = await run(store, 'uncertain-reason', own.revision, own.digest);
  await terminal(second.journal, { version: 1, status: 'uncertain', sourceId: source.id, runId: 'uncertain-reason', epoch: 1, reason: 'project_capture_failed' });
  store.agents.addRevision = async () => { throw new Error('a status read must not write'); };
  const status = await projectCheckpointStatuses(store, 'agent');
  assert.equal(status.find(row => row.runId === 'done').status, 'published');
  assert.equal(status.find(row => row.runId === 'uncertain-reason').reason, 'project_capture_failed');
  assert.equal((await store.agents.get('agent')).currentRevision, own.revision);
});

test('the run-ended hook publishes only after its existing resource cleanup and remains idempotent', async t => {
  const store = await fixture(t), active = await run(store, 'hook'), own = await candidate('hook'); await terminal(active.journal, own);
  const { projectRunEnded } = await api(); const cleaned = [];
  const ended = projectRunEnded(store, async claim => {
    cleaned.push(claim.runId);
    if (cleaned.length === 1) assert.equal((await store.agents.get('agent')).currentRevision, 'base');
  });
  await ended(active.claim); await ended(active.claim);
  assert.deepEqual(cleaned, ['hook', 'hook']);
  assert.equal((await store.agents.get('agent')).currentRevision, own.revision);
});
