import assert from 'node:assert/strict';
import { test } from 'node:test';
import { serve, client, follow } from './support.mjs';
import { landWorkflows, promoteChecked } from './learned-workflow-seed-support.mjs';
import { promotionsOf, promotionOf, championOf, recordPromotion } from '../dist/learn/promote.js';
import { heldNamesOf } from '../dist/learn/compile.js';
import { workflowDigest } from '../dist/runner/workflow-first.js';
import { toolFlowsFor } from '../dist/runner/promotion.js';
import { learningFolderOf, secretsShown } from '../dist/learning.js';
import { learningCommit } from '../dist/learn/commit.js';

const tool = { name: 'mcp:backend/status', description: 'Read release status.', input_schema: { type: 'object' }, permission: 'allow', price_usd: 0 };
// The draft takes a task that names its release: a JSON task without one is not an input of it.
const flow = { name: 'status', description: 'Read release status.', workflow: { v: 2, name: 'status', schemas: { Input: { type: 'object', properties: { release: { type: 'string' } }, required: ['release'] }, Answer: { type: 'object', properties: { ready: { type: 'boolean' } }, required: ['ready'] } }, input: { schemaId: 'Input' }, output: { schemaId: 'Answer', path: 'answer' }, root: { node: 'call', label: 'read', via: 'tool', tool: tool.name, args: {}, out: 'Answer', as: 'answer', deadline_s: 5 } } };
const nextFlow = { ...flow, description: 'Newer status draft.', workflow: { ...flow.workflow, root: { ...flow.workflow.root, args: { mode: 'new' } } } };
const TASK = '{"release":"r1"}';
const RELEASES = 5;
async function setup(t, runtime = 'eve', runner = true) {
  const server = await serve(t, { runner });
  const id = `shadow-${runtime}`;
  assert.equal((await server.api('POST', '/agents', { definition: { id, name: id, instructions: 'Report readiness.', sdk: { runtime }, learning: { compile_after: 200 }, tools: [] } })).status, 201);
  await landWorkflows(server.data, id, [flow]);
  const start = async (key, input = TASK) => {
    const response = await server.api('POST', `/agents/${id}/sdk-runs`, { runtime, input, instructions: 'Report readiness.', workflow_tools: [tool] }, { 'Idempotency-Key': key });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body;
  };
  const send = receipt => client(server.baseUrl, receipt.token);
  const records = () => promotionsOf(server.store.settings, id);
  const latest = async name => (await records()).findLast(one => one.workflow === name);
  return { ...server, id, start, send, records, latest };
}
const report = (receipt, patch = {}) => ({ type: 'workflow_check', id: receipt.learning.check.id, digest: receipt.learning.check.digest, outcome: 'answered', answer: '{"ready":true}', ...patch });
const evidence = [
  { type: 'tool', id: 'native', name: tool.name, status: 'started', input: {} },
  { type: 'tool', id: 'native', name: tool.name, status: 'completed', output: { ready: true } },
];
const assisted = [
  { type: 'tool', id: 'existing-workflow', name: 'learned_workflow', status: 'started', input: { name: flow.name } },
  { type: 'tool', id: 'existing-workflow', name: 'learned_workflow', status: 'completed', output: '{"ready":true}' },
];
async function finish(server, receipt, event, completion = {}, extra = []) {
  const sdk = server.send(receipt), path = `/sdk-runs/${receipt.run_id}`;
  assert.equal((await sdk('POST', `${path}/events`, { sequence: 1, events: [...evidence, ...extra, ...(event ? [event] : [])] })).status, 200);
  assert.equal((await sdk('POST', `${path}/complete`, { status: 'completed', answer: '{"ready":true}', ...completion })).status, 200);
  await follow(server.api, receipt.run_id, [completion.status ?? 'completed']);
}
const cancel = (server, receipt) => server.send(receipt)('POST', `/sdk-runs/${receipt.run_id}/complete`, { status: 'cancelled', answer: '' });
/** Lands `next` as the folder's newest revision of the status workflow, as a recompile or an owner's edit would. */
async function land(server, next = nextFlow) {
  const folder = learningFolderOf(server.data, server.id);
  try {
    const committed = await learningCommit(folder.workspace, { runId: `land-${workflowDigest({ workflow: JSON.stringify(next.workflow) })}`, reason: 'A separately compiled revision.', files: [
      { path: 'workflows/status/workflow.json', text: JSON.stringify(next.workflow) },
      { path: 'workflows/status/README.md', text: `---\nname: status\ndescription: ${next.description}\n---\n` },
    ] });
    assert.equal(committed.ok, true, JSON.stringify(committed));
  } finally { await folder.end(); }
}
/** Moves the reservation of `receipt`'s check two hours back, past its deadline, as a turn the backend never completed. */
async function expire(server, receipt) {
  const pending = promotionOf(await server.records(), flow.name, receipt.learning.check.digest);
  assert.equal(pending.decided, 'replaying');
  await recordPromotion(server.store.settings, server.id, { ...pending, at: new Date(Date.now() - 2 * 3_600_000).toISOString() }, () => true);
}
const settleDeps = async (server, receipt) => {
  const { sdkInbox } = await import('../dist/sdk/runs.js');
  return { store: server.store, agentId: server.id, launch: (await server.store.runs.launch(receipt.run_id)).body, inbox: await sdkInbox(server.store, receipt.run_id), shown: async () => secretsShown([]), log() {} };
};

for (const runtime of ['claude-agent-sdk', 'codex-sdk', 'eve']) test(`${runtime}: a compiled draft is withheld, checked against a native answer, then promoted for a fresh run`, async t => {
  const server = await setup(t, runtime);
  const first = await server.start('independent');
  assert.deepEqual(first.learning.workflows, [], 'an unchecked draft never enters model context');
  assert.equal(first.learning.check.workflow.name, flow.name);
  assert.equal(first.learning.check.digest, workflowDigest({ workflow: JSON.stringify(flow.workflow) }));
  assert.equal((await server.latest(flow.name)).via, 'sdk', 'the reservation says it is a connected agent check');
  assert.deepEqual(await server.start('independent'), first, 'idempotent admission keeps the exact candidate');
  const concurrent = await server.start('concurrent');
  assert.equal(concurrent.learning.check, undefined, 'only one native turn reserves the candidate');
  assert.deepEqual(concurrent.learning.workflows, []);
  await finish(server, first, report(first));
  const champion = championOf(await server.records(), flow.name);
  assert.equal(champion?.digest, first.learning.check.digest);
  assert.equal(champion?.via, 'sdk');
  assert.equal(champion?.check.n, 1, 'the promotion explicitly describes one held-out native turn');
  assert.equal(champion?.check.agreed, 1);
  assert.deepEqual(champion?.check.of, [first.run_id]);
  assert.equal(champion?.check.fresh_reads, undefined, 'every call answered from the recording');
  const next = await server.start('promoted');
  assert.equal(next.learning.check, undefined);
  assert.deepEqual(next.learning.workflows.map(one => one.name), [flow.name]);
  await server.api('PUT', `/agents/${server.id}/definition`, { definition: { instructions: 'Report readiness.', learning: false } });
  const off = await server.start('off');
  assert.deepEqual(off.learning, { enabled: false, revision: null, context: '', workflows: [] });
  for (const receipt of [concurrent, next, off]) await cancel(server, receipt);
});

test('a different native answer holds the draft, and the held digest is not checked again', async t => {
  const server = await setup(t);
  const first = await server.start('different');
  await finish(server, first, report(first, { answer: '{"ready":false}' }));
  const records = await server.records();
  assert.equal(championOf(records, flow.name), undefined);
  assert.equal(records.at(-1).decided, 'hold');
  assert.equal(records.at(-1).via, 'sdk');
  assert.match(records.at(-1).reason, /connected SDK checks do not use a semantic grader/);
  assert.doesNotMatch(records.at(-1).reason, /AGENT_MODEL_FAST/);
  const next = await server.start('not-reused');
  assert.deepEqual(next.learning.workflows, []);
  assert.equal(next.learning.check, undefined, 'a held digest is not silently checked again');
  await cancel(server, next);
});

// A turn that cannot be the check's baseline gives the reservation back: nothing is decided, and the next turn the draft
// takes is reserved in its place.
const releases = {
  'incomplete evidence': first => [report(first), { evidence_complete: false }],
  'failed check': first => [report(first, { outcome: 'failed', answer: undefined, reason: 'No trustworthy input binding.' })],
  'missing check': () => [undefined],
  'cancelled task': first => [report(first), { status: 'cancelled' }],
  'workflow-assisted turn': first => [report(first), {}, assisted],
  'skipped write': first => [report(first, { outcome: 'skipped_write', answer: undefined, skipped: { tool: tool.name }, reason: 'This exact call was absent from the native recording.' })],
  'redacted answer': (first, server) => [report(first, { answer: first.token }), { answer: server.token }],
};
for (const [scenario, turn] of Object.entries(releases)) test(`a turn that cannot be the baseline releases its reservation: ${scenario}`, async t => {
  const server = await setup(t);
  const first = await server.start(scenario);
  const [event, completion, extra] = turn(first, server);
  await finish(server, first, event, completion, extra);
  const waiting = promotionOf(await server.records(), flow.name, first.learning.check.digest);
  assert.equal(championOf(await server.records(), flow.name), undefined);
  assert.equal(waiting.decided, 'replaying', JSON.stringify(waiting));
  assert.equal(waiting.via, 'sdk');
  assert.equal(waiting.runs, undefined, 'no turn is reserved while it waits');
  assert.equal(waiting.check.released, 1);
  assert.match(waiting.reason, /given back \(1 of 5/);
  assert.ok(!JSON.stringify(await server.records()).includes(server.token));
  const next = await server.start(`${scenario} again`);
  assert.equal(next.learning.check?.digest, first.learning.check.digest, 'the next turn the draft takes checks it');
  assert.notEqual(next.learning.check.id, first.learning.check.id);
  assert.deepEqual((await server.latest(flow.name)).runs, [next.run_id]);
  await finish(server, next, report(next));
  const champion = championOf(await server.records(), flow.name);
  assert.equal(champion?.check.released, 1, 'the promotion says how many turns were given back');
  assert.deepEqual(champion?.check.of, [next.run_id]);
});

test(`${RELEASES} given-back turns stop the check with nothing checked and no recompile`, async t => {
  const server = await setup(t);
  for (let at = 1; at <= RELEASES; at++) {
    const receipt = await server.start(`cancel-${at}`);
    assert.ok(receipt.learning.check, `turn ${at} is reserved`);
    await finish(server, receipt, report(receipt), { status: 'cancelled' });
  }
  const stopped = await server.latest(flow.name);
  assert.equal(stopped.decided, 'hold');
  assert.equal(stopped.check.stopped, true);
  assert.equal(stopped.check.released, RELEASES);
  assert.equal(stopped.check.n, 0);
  assert.match(stopped.reason, /^nothing to check it on: the connected agent gave back 5 reserved native turns/);
  assert.ok(!heldNamesOf(await server.records()).has(flow.name), 'a stop with nothing checked asks no recompile');
  const after = await server.start('after-stop');
  assert.equal(after.learning.check, undefined);
  await cancel(server, after);
});

test('a JSON task the draft does not take, and a protected start, reserve no check', async t => {
  const server = await setup(t, 'eve', false);
  const other = await server.start('other-task', '{"build":7}');
  assert.equal(other.learning.check, undefined, 'a task with no release is not an input of the draft');
  for (const field of ['input', 'instructions']) {
    const response = await server.api('POST', `/agents/${server.id}/sdk-runs`, {
      runtime: 'eve', input: TASK, instructions: 'Report readiness.', workflow_tools: [tool], [field]: field === 'input' ? `{"release":"${server.token}"}` : server.token,
    }, { 'Idempotency-Key': `protected-${field}` });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.learning.check, undefined, `a redacted ${field} is not an intact baseline`);
  }
  assert.deepEqual(await server.records(), []);
  const prose = await server.start('prose', 'Is release r1 ready?');
  assert.ok(prose.learning.check, 'a prose task is reserved: the client resolves its input from the turn');
});

test('a turn past its deadline is one failed input through the check, and a recompile that ends there stops', async t => {
  const server = await setup(t, 'eve', false);
  const first = await server.start('abandoned');
  await expire(server, first);
  const swept = await server.start('sweeps');
  assert.equal(swept.learning.check, undefined, 'the decided digest is not reserved again');
  const held = promotionOf(await server.records(), flow.name, first.learning.check.digest);
  assert.equal(held.decided, 'hold');
  assert.equal(held.via, 'sdk');
  assert.equal(held.replay_id, first.learning.check.id);
  assert.equal(held.check.n, 1);
  assert.equal(held.check.outcomes.failed, 1);
  assert.equal(held.check.attempt, 1);
  assert.equal(held.check.stopped, undefined);
  assert.match(held.reason, /checked on 1 of the agent's inputs/);
  assert.match(held.reason, /recompiles it once/);
  assert.ok(heldNamesOf(await server.records()).has(flow.name), 'its hold asks the one recompile');
  await land(server);
  const recompiled = await server.start('recompiled');
  assert.equal(recompiled.learning.check?.digest, workflowDigest({ workflow: JSON.stringify(nextFlow.workflow) }));
  assert.equal((await server.latest(flow.name)).check.attempt, 2);
  await expire(server, recompiled);
  await server.start('sweeps-again');
  const stopped = promotionOf(await server.records(), flow.name, recompiled.learning.check.digest);
  assert.equal(stopped.decided, 'hold');
  assert.equal(stopped.check.stopped, true, 'repeated deadlines end stopped');
  assert.ok(!heldNamesOf(await server.records()).has(flow.name), 'nothing compiles again');
});

test('a turn closed before the backend completed it gives its check back; an expired one is a failed input', async t => {
  const server = await setup(t, 'eve', false);
  const { settleSdkCheck } = await import('../dist/sdk/check.js');
  const first = await server.start('stopped');
  const deps = await settleDeps(server, first);
  await settleSdkCheck({ ...deps, inbox: { ...deps.inbox, closed: 'cancelled' } });
  const waiting = await server.latest(flow.name);
  assert.equal(waiting.decided, 'replaying');
  assert.equal(waiting.check.released, 1);
  assert.match(waiting.reason, /stopped before the backend completed it/);
  const second = await server.start('expires');
  const later = await settleDeps(server, second);
  await settleSdkCheck({ ...later, inbox: { ...later.inbox, closed: 'expired' } });
  const held = await server.latest(flow.name);
  assert.equal(held.decided, 'hold');
  assert.equal(held.check.outcomes.failed, 1);
  assert.deepEqual(held.check.of, [second.run_id]);
});

test('a start that could not be admitted gives its turn back uncounted', async t => {
  const server = await setup(t, 'eve', false);
  const { releaseSdkCheck } = await import('../dist/runner/promotion.js');
  const first = await server.start('admitted');
  const pending = await server.latest(flow.name);
  await releaseSdkCheck({ store: server.store, agentId: server.id, shown: async () => secretsShown([]), log() {} }, pending, 'its start could not be admitted', false);
  const waiting = await server.latest(flow.name);
  assert.equal(waiting.decided, 'replaying');
  assert.equal(waiting.check.released, undefined, 'no turn ran, so none counts');
  assert.doesNotMatch(waiting.reason, /of 5/);
  const next = await server.start('next');
  assert.equal(next.learning.check?.digest, first.learning.check.digest);
});

test('a newer revision sets aside one still waiting for a turn', async t => {
  const server = await setup(t);
  const first = await server.start('waits');
  await finish(server, first, report(first), { status: 'cancelled' });
  await land(server);
  const next = await server.start('newer');
  assert.equal(next.learning.check?.digest, workflowDigest({ workflow: JSON.stringify(nextFlow.workflow) }));
  const aside = promotionOf(await server.records(), flow.name, first.learning.check.digest);
  assert.equal(aside.decided, 'hold');
  assert.equal(aside.check.stopped, true);
  assert.match(aside.reason, /a newer revision of it landed/);
  assert.equal((await server.latest(flow.name)).check.attempt, 1, 'setting it aside spends no recompile');
  await cancel(server, next);
});

test('fresh reads the shadow made are kept on the check record', async t => {
  const server = await setup(t);
  const first = await server.start('fresh');
  await finish(server, first, report(first, { fresh_reads: 2 }));
  assert.equal(championOf(await server.records(), flow.name)?.check.fresh_reads, 2);
});

test('shadow report is bound to one run, candidate, and immutable event sequence', async t => {
  const server = await setup(t, 'eve', false), first = await server.start('first'), second = await server.start('second');
  const sdk = server.send(first), path = `/sdk-runs/${first.run_id}/events`;
  for (const patch of [{ id: 'foreign-check' }, { digest: 'foreign-digest' }, { outcome: 'approved' }, { answer: undefined }, { agreed: true }, { fresh_reads: 0 }, { fresh_reads: 257 }]) {
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
  const record = championOf(await server.records(), flow.name);
  await recordPromotion(server.store.settings, server.id, { ...record, decided: 'hold', reason: 'Owner held it.' }, () => true);
  assert.deepEqual(await toolFlowsFor(deps, {}, laid, {}), []);
});

test('shadow agreement uses the owner-selected decision fields, not unrelated response text', async t => {
  const server = await setup(t);
  await server.api('PUT', `/agents/${server.id}/definition`, { definition: { instructions: 'Report readiness.', learning: { compile_after: 200, agree_on: ['ready'], agree_min: 1, alone_min: 1 } } });
  const first = await server.start('decision-fields');
  await finish(server, first, report(first, { answer: '{"ready":true,"explanation":"Different phrasing"}' }));
  const champion = championOf(await server.records(), flow.name);
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
  await land(server);
  const checking = await server.start('new-draft');
  assert.notEqual(checking.learning.check.digest, first.learning.check.digest);
  assert.deepEqual(checking.learning.workflows, [], 'baseline excludes even the old champion');
  const concurrent = await server.start('while-checking');
  assert.equal(concurrent.learning.check, undefined);
  assert.deepEqual(concurrent.learning.workflows, [original], 'the older checked bytes are read from their own commit');
  await finish(server, checking, report(checking, { answer: '{"ready":false}' }));
  const held = await server.start('new-held');
  assert.deepEqual(held.learning.workflows, [original]);
  for (const receipt of [concurrent, held]) await cancel(server, receipt);
});

test('a delayed report cannot replace a reservation already given back', async t => {
  const server = await setup(t, 'eve', false), receipt = await server.start('not-native');
  const sdk = server.send(receipt), path = `/sdk-runs/${receipt.run_id}`;
  assert.equal((await sdk('POST', `${path}/events`, { sequence: 1, events: [...evidence, ...assisted, report(receipt)] })).status, 200);
  assert.equal((await sdk('POST', `${path}/complete`, { status: 'completed', answer: '{"ready":true}' })).status, 200);
  const { settleSdkCheck } = await import('../dist/sdk/check.js');
  const deps = await settleDeps(server, receipt);
  await settleSdkCheck(deps);
  assert.equal(championOf(await server.records(), flow.name), undefined);
  const waiting = await server.latest(flow.name);
  assert.equal(waiting.decided, 'replaying');
  assert.equal(waiting.check.released, 1);
  await settleSdkCheck({ ...deps, inbox: { ...deps.inbox, batches: [{ sequence: 1, events: [...evidence, report(receipt)] }] } });
  assert.deepEqual(await server.latest(flow.name), waiting, 'a delayed check cannot replace the record kept');
});
