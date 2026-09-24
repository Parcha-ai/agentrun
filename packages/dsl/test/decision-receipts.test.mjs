import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorkflow, runWorkflowSlice, synthesizeAnswers, workflowSha256 } from '../dist/index.js';

const review = { type: 'object', required: ['ready'], properties: { ready: { type: 'boolean', description: 'Is the request ready?' } } };
const judgment = { node: 'judge', label: 'classify', state: { request: '{request}' }, out: 'review', as: 'decision' };
const workflow = root => ({ v: 2, name: 'receipts', schemas: { review, result: { type: 'object' } }, output: { schemaId: 'result' }, root });
const metadata = {
  model: 'recorded-jev', usage: { input_tokens: 20, output_tokens: 2 }, cost_usd: .000024,
  request_sha256: 'same-content-hash', provider_request_id: 'provider-1',
  pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 },
  transport_attempts: [{ id: 'attempt-1', number: 1, status: 'answered', elapsed_ms: 4, http_status: null, usage: { input_tokens: 20, output_tokens: 2 }, cost_usd: .000024 }],
};
const recorded = async ({ questions }) => ({ ...structuredClone(metadata), answers: synthesizeAnswers(questions) });

test('all semantic paths retain metadata before their answers affect the workflow', async () => {
  const nodes = [
    judgment,
    { node: 'pick', label: 'pick', itemsPath: 'items', describe: '{item}', instructions: 'Choose.', as: 'picked' },
    { node: 'sift', label: 'sift', itemsPath: 'items', out: 'review', as: 'selected' },
    { node: 'route', label: 'route', state: { request: '{request}' }, instructions: 'Which branch?', branches: {
      a: { body: { node: 'code', label: 'a', code: 's => ({})' } }, b: { body: { node: 'code', label: 'b', code: 's => ({})' } },
    } },
    { node: 'escalate', label: 'ask', when: { predicate: 'ask', instructions: 'Needs escalation?' }, kind: 'review', stage: 'ask', summary: 'Review' },
    { node: 'loop', label: 'loop', body: { node: 'code', label: 'attempt', code: 's => ({})' }, maxIters: 1, until: { predicate: 'ask', instructions: 'Ready?' } },
    { node: 'agent', label: 'author', instructions: 'Return a result.', out: 'result', as: 'draft', verify: { out: 'review' } },
  ];
  for (const node of nodes) {
    const receipts = [], events = [];
    const flow = workflow(node);
    await runWorkflow(flow, { request: 'private source text', items: ['a', 'b'] }, {
      runJudge: recorded, runNode: async () => ({}),
      decisionContext: { runId: 'run', attemptId: 'host-attempt', phase: 'qualification' },
      recordDecision: async (receipt, request) => { receipts.push(receipt); assert.ok(request.questions); },
      onEvent: event => events.push(event),
    });
    assert.equal(receipts.length, 1, node.node);
    const receipt = receipts[0];
    assert.equal(receipt.status, 'answered');
    assert.equal(receipt.workflow_sha256, workflowSha256(flow));
    assert.equal(receipt.run_id, 'run');
    assert.equal(receipt.attempt_id, 'host-attempt');
    assert.equal(receipt.phase, 'qualification');
    assert.equal(receipt.execution_path, node.node === 'loop' ? '/root/iterations/0' : '/root');
    assert.deepEqual(receipt.metadata, { ...metadata, replayed: false });
    const decision = events.find(e => e.type === 'decision.receipt');
    assert.doesNotMatch(JSON.stringify(decision), /private source text/);
    const applied = events.find(e => ['judge.answered', 'route.chosen', 'ask.evaluated', 'verify.answered'].includes(e.type));
    assert.equal(applied.detail.decision_id, receipt.id);
    assert.deepEqual(applied.detail.usage, metadata.usage);
    assert.equal(applied.detail.request_sha256, metadata.request_sha256);
  }
});

test('file-backed required persistence survives completed-node recovery without another call or charge', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'agentrun-receipts-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let calls = 0, receipts = 0, committed;
  const flow = workflow(judgment);
  const deps = {
    runJudge: async request => { calls++; return recorded(request); },
    recordDecision: async (receipt, request) => { receipts++; await writeFile(join(dir, 'receipt.json'), JSON.stringify({ receipt, request })); },
    recovery: {
      resume: async () => committed,
      commit: async (_node, state) => { assert.equal(JSON.parse(await readFile(join(dir, 'receipt.json'))).receipt.status, 'answered'); committed = state; },
      pollStartedAt: () => 0, wait: async () => {},
    },
  };
  const first = await runWorkflow(flow, { request: 'source' }, deps);
  const resumed = await runWorkflow(flow, { request: 'source' }, deps);
  assert.deepEqual(resumed, first);
  assert.equal(calls, 1); assert.equal(receipts, 1);
  const saved = JSON.parse(await readFile(join(dir, 'receipt.json')));
  assert.deepEqual(saved.receipt.metadata.usage, metadata.usage);
  assert.equal(saved.request.state.request, 'source');
});

test('receipt failure stops continuation; failed adapter plus failed persistence preserve both failures', async () => {
  let continuations = 0;
  const flow = workflow({ node: 'chain', steps: [judgment, { node: 'agent', label: 'continuation', instructions: 'Continue.', out: 'result', as: 'result' }] });
  const disk = new Error('disk unavailable');
  const deps = { runJudge: recorded, runNode: async () => { continuations++; return {}; }, recordDecision: async () => { throw disk; } };
  await assert.rejects(runWorkflow(flow, { request: 'source' }, deps), e => e.cause === disk);
  assert.equal(continuations, 0);
  const provider = new Error('sensitive provider failure');
  await assert.rejects(runWorkflow(flow, { request: 'source' }, { ...deps, runJudge: async () => { throw provider; } }), e => {
    assert(e instanceof AggregateError); assert.deepEqual(e.errors, [provider, disk]); return true;
  });
});

test('malformed answers retain known usage and sanitized error without entering state', async () => {
  let saved;
  await assert.rejects(runWorkflow(workflow(judgment), { request: 'source' }, {
    runJudge: async () => ({ ...metadata, answers: { ready: { type: 'noul', noul: 2 } } }),
    recordDecision: async receipt => { saved = receipt; },
  }), /not a probability/);
  assert.equal(saved.status, 'failed');
  assert.equal(saved.answers, null);
  assert.equal(saved.error.reason, 'noul_probability');
  assert.deepEqual(saved.metadata.usage, metadata.usage);
});

test('verification drives have distinct receipt IDs even with identical question and request hashes', async () => {
  const receipts = [];
  const flow = workflow({ node: 'agent', label: 'author', instructions: 'Return result.', out: 'result', as: 'draft', verify: { out: 'review' } });
  await runWorkflow(flow, {}, {
    runNode: async ({ review }) => { assert.equal((await review({ text: 'first' })).accepted, false); await review({ text: 'second' }); return { text: 'second' }; },
    runJudge: async params => ({ ...metadata, answers: { ready: { type: 'noul', noul: params.state.submission.text === 'second' ? .9 : .1 } } }),
    recordDecision: async receipt => { receipts.push(receipt); },
  });
  assert.equal(receipts.length, 2);
  assert.notEqual(receipts[0].id, receipts[1].id);
  assert.equal(receipts[0].questions_sha256, receipts[1].questions_sha256);
  assert.notEqual(receipts[0].input_sha256, receipts[1].input_sha256);
});

test('unknown metering remains null and mutation by a persistence sink cannot change the answer', async () => {
  let saved;
  const result = await runWorkflow(workflow(judgment), { request: 'source' }, {
    runJudge: async () => ({ answers: { ready: { type: 'noul', noul: .9 } } }),
    recordDecision: async receipt => { saved = structuredClone(receipt); receipt.answers.ready.noul = .1; },
    onEvent: () => { throw new Error('best effort observer unavailable'); },
  });
  assert.equal(result.state.decision.ready, true);
  for (const field of ['usage', 'cost_usd', 'pricing', 'request_sha256', 'transport_attempts']) assert.equal(saved.metadata[field], null);
});

test('parallel map receipts identify item paths and slices retain original document hash', async () => {
  const receipts = [];
  const flow = workflow({ node: 'chain', steps: [
    { node: 'code', label: 'seed', code: 's => ({})' },
    { node: 'map', label: 'classify items', itemsPath: 'items', as: 'results', body: { ...judgment, state: { request: '{item}' } } },
  ] });
  const deps = { runJudge: recorded, recordDecision: async receipt => { receipts.push(receipt); } };
  await runWorkflowSlice(flow, { items: ['a', 'b'] }, { from: 'classify items' }, deps);
  assert.deepEqual(receipts.map(r => r.execution_path).sort(), ['/root/steps/1/items/0/body', '/root/steps/1/items/1/body']);
  assert(receipts.every(r => r.workflow_sha256 === workflowSha256(flow)));
});
