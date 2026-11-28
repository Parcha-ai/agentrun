import assert from 'node:assert/strict';
import { test } from 'node:test';
import { serve, client, agent } from './support.mjs';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { commitWrites } from '@earendil-works/pi-durable/testing';
import { sourceSnapshotDigest } from '../dist/native/source-snapshot-types.js';

const target = { runtime: 'codex', machine_id: 'fixture-machine', project: '/fixture/project', selector: { kind: 'project' },
  version: 'fixture', model: null, fingerprint: 'a'.repeat(64), configuration: [], skills: [], mcp_servers: [], connected: true,
  state: 'ready', issues: [], capabilities: { launch: true, learning: true, workflows: false, approval: 'unavailable', usage: true } };
const snapshot = (runtime = target.runtime) => {
  const value = { version: 1, complete: true, source: { runtime, machine_id: target.machine_id, project: target.project, selector: target.selector },
    entries: [], blobs: {}, instructions: { text: 'Keep the existing project.', layers: [] }, skills: [],
    configuration: { model: null, tools: [], permissions: {}, credentials: [] }, project: { git: null }, blockers: [] };
  return { ...value, digest: sourceSnapshotDigest(value) };
};
async function connected(t, configSync = true, deploymentRuntime) {
  const s = await serve(t, { runner: false });
  const cap = { native_execution: !deploymentRuntime, history_import: false, config_sync: configSync };
  const enrolled = await s.api('POST', '/connectors/enrollment', { capabilities: cap });
  assert.equal(enrolled.status, 200);
  const registration = await client(s.baseUrl, enrolled.body.enrollment_token)('POST', '/connectors', {
    installation_id: 'source-installation', operation_id: 'register', capabilities: cap,
  });
  assert.equal(registration.status, 200, JSON.stringify(registration.body));
  const id = registration.body.connector.id, api = client(s.baseUrl, registration.body.credential);
  const imported = await api('POST', `/connectors/${id}/import`, { target_id: 'project',
    target: deploymentRuntime ? { ...target, runtime: deploymentRuntime, sync_only: true } : target,
    ...(deploymentRuntime ? { deployment: true } : {}) });
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  return { ...s, worker: api, id, agent: imported.body.agent_id, path: `/connectors/${id}/targets/project/sync` };
}

for (const deploymentRuntime of [undefined, 'claude-code', 'codex', 'pi']) test(`${deploymentRuntime ?? 'native'} sync HTTP requires a source grant and complete bytes; pending deployment cannot run or lose its binding`, async t => {
  const s = await connected(t, true, deploymentRuntime);
  if (deploymentRuntime) {
    assert.deepEqual((await s.api('GET', '/capabilities')).body.source_deployment, { version: 1, runtimes: ['claude-code', 'codex', 'pi'] });
    const agentPath = `/agents/${s.agent}`;
    assert.equal((await s.api('GET', agentPath)).body.definition.native, undefined);
    const pending = await s.api('POST', `${agentPath}/runs`, { input: { content: 'Start before upload.' } });
    assert.equal(pending.status, 409, JSON.stringify(pending.body));
    assert.match(pending.body.error.message, /complete.*deploy/i);
    assert.equal((await s.api('PUT', `${agentPath}/definition`, { definition: { instructions: 'Remove pending state.', tools: [] } })).status, 409);
    const pendingAgent = await s.store.agents.get(s.agent);
    assert.equal((await s.api('POST', `${agentPath}/current`, { revision: pendingAgent.currentRevision })).status, 409);
    assert.equal((await s.worker('POST', `/connectors/${s.id}/poll`, { worker_id: 'worker' })).status, 403);
    assert.equal((await s.worker('POST', `/connectors/${s.id}/targets/project/history`, { sessions: [] })).status, 403);
    assert.equal((await s.api('GET', `${agentPath}/source`)).body.connection.connector_id, s.id);
  }
  const grant = await s.worker('POST', `${s.path}/grant`, {});
  assert.equal(grant.status, 200, JSON.stringify(grant.body));
  assert.equal(grant.body.enabled, true);
  const body = { generation: grant.body.generation, sequence: 0, snapshot: snapshot(deploymentRuntime) };
  const accepted = await s.worker('POST', s.path, body);
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.snapshot, body.snapshot.digest);
  assert.equal((await s.worker('POST', s.path, body)).status, 200);
  const malformed = { ...body, snapshot: { ...body.snapshot, entries: [{ path: '../escape' }] } };
  assert.equal((await s.worker('POST', s.path, malformed)).status, 422, 'a matching replay digest cannot bypass byte/path validation');
  const state = await s.api('GET', `/agents/${s.agent}/source`);
  assert.equal(state.status, 200, JSON.stringify(state.body));
  assert.equal(state.body.state, 'needs_attention');
  assert.equal(state.body.blockers[0].code, 'model_mapping', 'a missing effective source model must not become the host default');
  assert.equal((await s.api('POST', `/agents/${s.agent}/source/move`, { snapshot: 'f'.repeat(64) })).status, 412, 'a different reviewed snapshot refuses before destination preparation');
  assert.equal((await s.api('POST', `/agents/${s.agent}/source/move`, { snapshot: body.snapshot.digest })).status, 409, 'an exact reviewed snapshot reaches destination prerequisite checks');
  assert.equal((await s.api('POST', `/agents/${s.agent}/source/move`, { snapshot: 'invalid' })).status, 422);
  assert.equal((await s.api('POST', `/agents/${s.agent}/source/move`, {})).status, 409);
  if (!deploymentRuntime) assert.equal((await s.api('GET', `/agents/${s.agent}`)).body.definition.native.remote.connector_id, s.id);
  assert.equal((await s.worker('PATCH', `/agents/${s.agent}/source`, { enabled: false })).status, 401, 'source credential has no owner controls');
});

test('a source failure preserves last complete snapshot and only a later successful sequence clears it', async t => {
  const s = await connected(t), grant = (await s.worker('POST', `${s.path}/grant`, {})).body;
  const snap = snapshot();
  await s.worker('POST', s.path, { generation: grant.generation, sequence: 0, snapshot: snap });
  const failed = await s.worker('POST', `${s.path}/status`, { generation: grant.generation, sequence: 1, code: 'source_changed' });
  assert.equal(failed.status, 200, JSON.stringify(failed.body));
  assert.equal(failed.body.snapshot, snap.digest);
  assert.equal(failed.body.attempt.code, 'source_changed');
  assert.equal((await s.worker('POST', s.path, { generation: grant.generation, sequence: 0, snapshot: snap })).status, 412);
  const recovered = await s.worker('POST', s.path, { generation: grant.generation, sequence: 2, snapshot: snap });
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.attempt.code, undefined);
  assert.deepEqual(recovered.body.attempt.blockers, []);
});

test('owner pause and connector revocation cannot be undone by the source grant endpoint', async t => {
  const s = await connected(t), grant = (await s.worker('POST', `${s.path}/grant`, {})).body;
  const paused = await s.api('PATCH', `/agents/${s.agent}/source`, { enabled: false });
  assert.equal(paused.status, 200);
  assert.equal((await s.worker('POST', `${s.path}/grant`, {})).body.enabled, false);
  assert.equal((await s.worker('POST', `${s.path}/grant`, { source_consent: true })).status, 422);
  assert.equal((await s.worker('POST', s.path, { generation: grant.generation, sequence: 0, snapshot: snapshot() })).status, 403);
  await s.api('DELETE', `/connectors/${s.id}`);
  assert.equal((await s.worker('POST', `${s.path}/grant`, {})).status, 401);
  assert.equal((await s.api('PATCH', `/agents/${s.agent}/source`, { enabled: true })).status, 403);
  assert.equal((await s.api('GET', `/agents/${s.agent}/source`)).body.state, 'paused');
});

test('legacy connector capabilities do not acquire project export authority', async t => {
  const s = await connected(t, false);
  assert.equal((await s.worker('POST', `${s.path}/grant`, {})).status, 403);
  assert.equal((await s.api('GET', `/agents/${s.agent}/source`)).body.state, 'needs_connection');
});

test('a connector can revoke its own epoch and receives its successful revocation receipt', async t => {
  const s = await connected(t);
  const revoked = await s.worker('DELETE', `/connectors/${s.id}`);
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  assert.equal(revoked.body.connector.status, 'revoked');
  assert.equal((await s.worker('POST', `${s.path}/grant`, {})).status, 401);
});

test('an accepted HTTP run stays replayable after an uncertain project receipt blocks new runs', async t => {
  const s = await serve(t, { runner: false });
  assert.equal((await s.api('POST', '/agents', agent('project-retry'))).status, 201);
  const path = '/agents/project-retry/runs', input = { input: { content: 'Keep working.' } };
  const accepted = await s.api('POST', path, input, { 'Idempotency-Key': 'original' });
  assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
  const runId = accepted.body.run_id, claim = await s.store.claim(runId, 'fixture', { leaseMs: 60_000 });
  const journal = s.store.journal(claim);
  await commitWrites(journal, [{ type: 'conversation', value: { id: 1 } }], BACKGROUND_CONTEXT);
  const entryId = await journal.mintId();
  journal.stage({ run: { state: 'ended' }, effect: entryId });
  await commitWrites(journal, [{ type: 'entry', value: { id: entryId, conversationId: 1, kind: 'agentrun.end', data: {
    state: 'ended', projectCheckpoint: { version: 1, status: 'uncertain', sourceId: 'a'.repeat(64), runId, epoch: 1, reason: 'project_capture_failed' },
  } } }], BACKGROUND_CONTEXT);
  await journal.close();
  const current = await s.store.agents.get('project-retry'), revision = await s.store.agents.revision(current.currentRevision);
  await s.store.agents.addRevision({ agentId: current.id, id: 'moved', kind: revision.kind, ifCurrent: current.currentRevision,
    body: { ...revision.body, sourceSync: { id: 'a'.repeat(64), snapshot: 'b'.repeat(64), project: 'b'.repeat(64), configuration: 'c'.repeat(64) } } });
  const replay = await s.api('POST', path, input, { 'Idempotency-Key': 'original' });
  assert.equal(replay.status, 202, JSON.stringify(replay.body));
  assert.equal(replay.body.run_id, runId, 'recovery returns the original admission without another dispatch');
  const next = await s.api('POST', path, input, { 'Idempotency-Key': 'next' });
  assert.equal(next.status, 409, JSON.stringify(next.body));
  assert.equal(next.body.error.code, 'agent_not_runnable');
  assert.equal(next.body.error.details.project_issues[0].run_id, runId);
});
