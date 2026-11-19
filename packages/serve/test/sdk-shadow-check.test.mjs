import assert from 'node:assert/strict';
import { test } from 'node:test';
import { serve, client, follow } from './support.mjs';
import { landWorkflows, promoteChecked } from './learned-workflow-seed-support.mjs';
import { promotionsOf, championOf, recordPromotion } from '../dist/learn/promote.js';
import { workflowDigest } from '../dist/runner/workflow-first.js';
import { toolFlowsFor } from '../dist/runner/promotion.js';
import { learningFolderOf } from '../dist/learning.js';
import { learningCommit } from '../dist/learn/commit.js';

const tool = { name: 'mcp:backend/status', description: 'Read release status.', input_schema: { type: 'object' }, permission: 'allow', price_usd: 0 };
const flow = { name: 'status', description: 'Read release status.', workflow: { v: 2, name: 'status', schemas: { Input: { type: 'object' }, Answer: { type: 'object', properties: { ready: { type: 'boolean' } }, required: ['ready'] } }, input: { schemaId: 'Input' }, output: { schemaId: 'Answer', path: 'answer' }, root: { node: 'call', label: 'read', via: 'tool', tool: tool.name, args: {}, out: 'Answer', as: 'answer', deadline_s: 5 } } };
async function setup(t, runtime = 'eve', runner = true) {
  const server = await serve(t, { runner });
  const id = `shadow-${runtime}`;
  assert.equal((await server.api('POST', '/agents', { definition: { id, name: id, instructions: 'Report readiness.', sdk: { runtime }, learning: { compile_after: 200 }, tools: [] } })).status, 201);
  await landWorkflows(server.data, id, [flow]);
  const start = async key => {
    const response = await server.api('POST', `/agents/${id}/sdk-runs`, { runtime, input: '{}', instructions: 'Report readiness.', workflow_tools: [tool] }, { 'Idempotency-Key': key });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body;
  };
  const send = receipt => client(server.baseUrl, receipt.token);
  return { ...server, id, start, send };
}
const report = (receipt, patch = {}) => ({ type: 'workflow_check', id: receipt.learning.check.id, digest: receipt.learning.check.digest, outcome: 'answered', answer: '{"ready":true}', ...patch });
const evidence = [
  { type: 'tool', id: 'native', name: tool.name, status: 'started', input: {} },
  { type: 'tool', id: 'native', name: tool.name, status: 'completed', output: { ready: true } },
];
async function finish(server, receipt, event, completion = {}) {
  const sdk = server.send(receipt), path = `/sdk-runs/${receipt.run_id}`;
  assert.equal((await sdk('POST', `${path}/events`, { sequence: 1, events: [...evidence, ...(event ? [event] : [])] })).status, 200);
  assert.equal((await sdk('POST', `${path}/complete`, { status: 'completed', answer: '{"ready":true}', ...completion })).status, 200);
  await follow(server.api, receipt.run_id, [completion.status ?? 'completed']);
}

for (const runtime of ['claude-agent-sdk', 'codex-sdk', 'eve']) test(`${runtime}: a compiled draft is withheld, checked against a native answer, then promoted for a fresh run`, async t => {
  const server = await setup(t, runtime);
  const first = await server.start('independent');
  assert.deepEqual(first.learning.workflows, [], 'an unchecked draft never enters model context');
  assert.equal(first.learning.check.workflow.name, flow.name);
  assert.equal(first.learning.check.digest, workflowDigest({ workflow: JSON.stringify(flow.workflow) }));
  assert.deepEqual(await server.start('independent'), first, 'idempotent admission keeps the exact candidate');
  const concurrent = await server.start('concurrent');
  assert.equal(concurrent.learning.check, undefined, 'only one native turn reserves the candidate');
  assert.deepEqual(concurrent.learning.workflows, []);
  await finish(server, first, report(first));
  const champion = championOf(await promotionsOf(server.store.settings, server.id), flow.name);
  assert.equal(champion?.digest, first.learning.check.digest);
  assert.equal(champion?.check.n, 1, 'the promotion explicitly describes one held-out native turn');
  assert.equal(champion?.check.agreed, 1);
  assert.deepEqual(champion?.check.of, [first.run_id]);
  const next = await server.start('promoted');
  assert.equal(next.learning.check, undefined);
  assert.deepEqual(next.learning.workflows.map(one => one.name), [flow.name]);
  await server.api('PUT', `/agents/${server.id}/definition`, { definition: { instructions: 'Report readiness.', learning: false } });
  const off = await server.start('off');
  assert.deepEqual(off.learning, { enabled: false, revision: null, context: '', workflows: [] });
  for (const receipt of [concurrent, next, off]) await server.send(receipt)('POST', `/sdk-runs/${receipt.run_id}/complete`, { status: 'cancelled', answer: '' });
});

for (const scenario of ['different answer', 'incomplete evidence', 'failed check', 'missing check', 'cancelled task']) test(`shadow check refuses promotion: ${scenario}`, async t => {
  const server = await setup(t);
  const first = await server.start(scenario);
  const event = scenario === 'missing check' ? undefined : report(first, scenario === 'different answer' ? { answer: '{"ready":false}' } : scenario === 'failed check' ? { outcome: 'failed', answer: undefined, reason: 'No trustworthy input binding.' } : {});
  await finish(server, first, event, scenario === 'incomplete evidence' ? { evidence_complete: false } : scenario === 'cancelled task' ? { status: 'cancelled' } : {});
  const records = await promotionsOf(server.store.settings, server.id);
  assert.equal(championOf(records, flow.name), undefined);
  assert.equal(records.at(-1).decided, 'hold');
  if (scenario === 'different answer') {
    assert.match(records.at(-1).reason, /connected SDK checks do not use a semantic grader/);
    assert.doesNotMatch(records.at(-1).reason, /AGENT_MODEL_FAST/);
  }
  const next = await server.start('not-reused');
  assert.deepEqual(next.learning.workflows, []);
  assert.equal(next.learning.check, undefined, 'a failed digest is not silently checked again');
  await server.send(next)('POST', `/sdk-runs/${next.run_id}/complete`, { status: 'cancelled', answer: '' });
});

test('shadow report is bound to one run, candidate, and immutable event sequence', async t => {
  const server = await setup(t, 'eve', false), first = await server.start('first'), second = await server.start('second');
  const sdk = server.send(first), path = `/sdk-runs/${first.run_id}/events`;
  for (const patch of [{ id: 'foreign-check' }, { digest: 'foreign-digest' }, { outcome: 'approved' }, { answer: undefined }, { agreed: true }]) {
    const response = await sdk('POST', path, { sequence: 1, events: [report(first, patch)] });
    assert.equal(response.status, 422, JSON.stringify(response.body));
  }
  assert.equal((await server.send(second)('POST', `/sdk-runs/${second.run_id}/events`, { sequence: 1, events: [report(first)] })).status, 422);
  const batch = { sequence: 1, events: [report(first)] };
  assert.equal((await sdk('POST', path, batch)).status, 200);
  assert.equal((await sdk('POST', path, batch)).status, 200);
  assert.equal((await sdk('POST', path, { sequence: 2, events: [report(first)] })).status, 422);
  assert.equal((await sdk('POST', path, { sequence: 1, events: [report(first, { answer: 'different' })] })).status, 409);
});

test('server-native learned_workflow tool also withholds drafts without promotion records', async t => {
  const server = await setup(t, 'eve', false);
  const laid = [{ ...flow, workflow: JSON.stringify(flow.workflow) }];
  const deps = { store: server.store, agentId: server.id, log() {} };
  assert.deepEqual(await toolFlowsFor(deps, {}, laid, {}), []);
  await promoteChecked(server.store.settings, server.id, [flow]);
  assert.deepEqual(await toolFlowsFor(deps, {}, laid, {}), laid);
  const record = championOf(await promotionsOf(server.store.settings, server.id), flow.name);
  await recordPromotion(server.store.settings, server.id, { ...record, decided: 'hold', reason: 'Owner held it.' }, () => true);
  assert.deepEqual(await toolFlowsFor(deps, {}, laid, {}), []);
});

test('shadow agreement uses the owner-selected decision fields, not unrelated response text', async t => {
  const server = await setup(t);
  await server.api('PUT', `/agents/${server.id}/definition`, { definition: { instructions: 'Report readiness.', learning: { compile_after: 200, agree_on: ['ready'], agree_min: 1, alone_min: 1 } } });
  const first = await server.start('decision-fields');
  await finish(server, first, report(first, { answer: '{"ready":true,"explanation":"Different phrasing"}' }));
  const champion = championOf(await promotionsOf(server.store.settings, server.id), flow.name);
  assert.equal(champion?.check.agreed, 1);
  assert.deepEqual(champion?.check.agree_on, ['ready']);
  assert.equal(champion?.check.agree_min, 1);
  assert.equal(champion?.check.alone_min, 1);
});

test('a newer compiled revision cannot displace the checked champion before its own independent check', async t => {
  const server = await setup(t);
  const first = await server.start('one');
  await finish(server, first, report(first));
  const original = first.learning.check.workflow;
  const nextFlow = { ...flow, description: 'Newer status draft.', workflow: { ...flow.workflow, root: { ...flow.workflow.root, args: { mode: 'new' } } } };
  const folder = learningFolderOf(server.data, server.id);
  try {
    const committed = await learningCommit(folder.workspace, { runId: 'newer-candidate', reason: 'A separately compiled revision.', files: [
      { path: 'workflows/status/workflow.json', text: JSON.stringify(nextFlow.workflow) },
      { path: 'workflows/status/README.md', text: '---\nname: status\ndescription: Newer status draft.\n---\n' },
    ] });
    assert.equal(committed.ok, true, JSON.stringify(committed));
  } finally { await folder.end(); }
  const checking = await server.start('new-draft');
  assert.notEqual(checking.learning.check.digest, first.learning.check.digest);
  assert.deepEqual(checking.learning.workflows, [], 'baseline excludes even the old champion');
  const concurrent = await server.start('while-checking');
  assert.equal(concurrent.learning.check, undefined);
  assert.deepEqual(concurrent.learning.workflows, [original], 'the older checked bytes are read from their own commit');
  await finish(server, checking, report(checking, { answer: '{"ready":false}' }));
  const held = await server.start('new-held');
  assert.deepEqual(held.learning.workflows, [original]);
  for (const receipt of [concurrent, held]) await server.send(receipt)('POST', `/sdk-runs/${receipt.run_id}/complete`, { status: 'cancelled', answer: '' });
});

test('a workflow-assisted baseline and a stale reservation cannot promote a candidate', async t => {
  const server = await setup(t, 'eve', false), receipt = await server.start('not-native');
  const sdk = server.send(receipt), path = `/sdk-runs/${receipt.run_id}`;
  const events = [...evidence, { type: 'tool', id: 'existing-workflow', name: 'learned_workflow', status: 'started', input: { name: flow.name } }, { type: 'tool', id: 'existing-workflow', name: 'learned_workflow', status: 'completed', output: '{"ready":true}' }, report(receipt)];
  assert.equal((await sdk('POST', `${path}/events`, { sequence: 1, events })).status, 200);
  assert.equal((await sdk('POST', `${path}/complete`, { status: 'completed', answer: '{"ready":true}' })).status, 200);
  const { settleSdkCheck } = await import('../dist/sdk/check.js');
  const { sdkInbox } = await import('../dist/sdk/runs.js');
  const { secretsShown } = await import('../dist/learning.js');
  const run = await server.store.runs.get(receipt.run_id);
  const deps = { store: server.store, agentId: server.id, revisionId: run.revisionId, launch: (await server.store.runs.launch(run.id)).body, inbox: await sdkInbox(server.store, run.id), shown: async () => secretsShown([]), log() {} };
  await settleSdkCheck(deps);
  assert.equal(championOf(await promotionsOf(server.store.settings, server.id), flow.name), undefined);
  const held = (await promotionsOf(server.store.settings, server.id)).at(-1);
  assert.equal(held.decided, 'hold');
  await settleSdkCheck({ ...deps, inbox: { ...deps.inbox, batches: [{ sequence: 1, events: [...evidence, report(receipt)] }] } });
  assert.deepEqual((await promotionsOf(server.store.settings, server.id)).at(-1), held, 'a delayed check cannot replace a decision already kept');
});

test('missing recorded write is held as unchecked and never represented as an agreement', async t => {
  const server = await setup(t), receipt = await server.start('write-missing');
  await finish(server, receipt, report(receipt, { outcome: 'skipped_write', answer: undefined, skipped: { tool: tool.name }, reason: 'This exact call was absent from the native recording.' }));
  const record = (await promotionsOf(server.store.settings, server.id)).at(-1);
  assert.equal(record.decided, 'hold');
  assert.equal(record.check.n, 0);
  assert.equal(record.check.agreed, 0);
  assert.equal(record.check.outcomes.skipped_write, 1);
  assert.equal(record.check.stopped, true);
  assert.match(record.reason, /nothing to check/);
});

test('different protected answers cannot agree merely because both redact to the same placeholder', async t => {
  const server = await setup(t), receipt = await server.start('protected-comparison');
  await finish(server, receipt, report(receipt, { answer: receipt.token }), { answer: server.token });
  const records = await promotionsOf(server.store.settings, server.id);
  assert.equal(championOf(records, flow.name), undefined);
  assert.equal(records.at(-1).decided, 'hold');
  assert.equal(records.at(-1).check.agreed, 0);
  assert.ok(!JSON.stringify(records).includes(receipt.token));
  assert.ok(!JSON.stringify(records).includes(server.token));
});

for (const field of ['input', 'instructions']) test(`a protected SDK start ${field} cannot support promotion from an altered baseline`, async t => {
  const server = await setup(t);
  const response = await server.api('POST', `/agents/${server.id}/sdk-runs`, {
    runtime: 'eve', input: '{}', instructions: 'Report readiness.', workflow_tools: [tool], [field]: server.token,
  }, { 'Idempotency-Key': `protected-${field}` });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const receipt = response.body;
  assert.ok(receipt.learning.check);
  await finish(server, receipt, report(receipt));
  const records = await promotionsOf(server.store.settings, server.id);
  assert.equal(championOf(records, flow.name), undefined, 'redacted task or policy is not an intact independent baseline');
  assert.equal(records.at(-1).decided, 'hold');
  assert.equal(records.at(-1).check.agreed, 0);
  assert.ok(!JSON.stringify(records).includes(server.token));
});
