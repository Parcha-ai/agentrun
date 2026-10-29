// A decision node names its provider, pins its model, says what evidence it needs and bounds its own time: `provider`,
// `model`, `evidence` and `timeoutMs` on judge, pick, sift, route and ask. A host's providers are checked against the
// nodes before any node runs; each node is asked through its own provider and model, within the shorter of the two
// deadlines; the provider's evidence travels with the answer; and a pinned model is part of what the decision is.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as dsl from '../dist/index.js';
import { memoryStore, openRecovery, withRecovery } from '../dist/recovery/index.js';
import { DecisionProviderError, runWorkflow, validateWorkflow } from '../dist/index.js';

const SCHEMAS = {
  Out: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
  Check: { type: 'object', required: ['legit'], properties: { legit: { type: 'boolean', description: 'Is this filing a legitimate certificate of incorporation?' } } },
  Scored: { type: 'object', required: ['grade'], properties: { grade: { type: 'integer', description: 'How complete is it?', criteria: ['missing', 'partial', 'complete'] } } },
  Item: { type: 'object', required: ['keep'], properties: { keep: { type: 'boolean', description: 'Keep this filing?' } } },
};
const FIELDS = { provider: 'parallel', model: 'base-1', evidence: 'if_supported', timeoutMs: 1500 };
const judge = (extra = {}, out = 'Check', label = 'check') => ({ node: 'judge', label, state: { text: '{text}' }, out, as: label, ...extra });
const finish = { node: 'code', label: 'finish', code: '() => ({ final: { ok: true } })' };
const doc = (steps) => ({ v: 2, name: 'decision-node-fields', schemas: SCHEMAS, output: { schemaId: 'Out', path: 'final' }, root: { node: 'chain', steps: [...steps, finish] } });
const INPUT = { text: 'a filing', filings: [{ id: 'a' }, { id: 'b' }] };

const capabilities = (over = {}) => ({ types: ['noul', 'choice', 'score'], inputs: ['text', 'json'], evidence: 'citations', probability: 'model', grounding: false, replay: 'never', maxQuestions: 8, maxStateBytes: null, ...over });
const EVIDENCE = [{ url: 'https://registry.example/filings/1', title: 'Filing 1', excerpts: ['Certificate of Incorporation'], scope: 'call' }];
/** A provider that answers every question yes, with `evidence`, and keeps what it was asked. */
const provider = (id, over = {}, evidence = EVIDENCE) => {
  const asked = [];
  return { id, needs: [], capabilities: capabilities(over), asked, decide: async (request, ctx) => {
    asked.push({ request, ctx });
    const answers = Object.fromEntries(Object.entries(request.questions).map(([qid, q]) => [qid, q.type === 'noul' ? { type: 'noul', noul: 0.9 } : q.type === 'score' ? { type: 'score', score: 2, legend: q.criteria ?? [], probabilities: [0, 0, 1], confidence: 1 } : { type: 'choice', choice: Object.keys(q.criteria ?? {})[0], probabilities: { [Object.keys(q.criteria ?? {})[0]]: 1 }, confidence: 1 }]));
    return { answers, evidence, model: request.model ?? `${id}-default`, usage: null, cost_usd: 0.001, cost_basis: 'estimate', provider_request_id: `${id}-req` };
  } };
};
/** The host's providers, as a run gets them: the dispatching runJudge and the registry its pre-run check reads. */
function hosted(providers, { fallback = providers[0].id, deadlineMs = 2000 } = {}) {
  assert.equal(typeof dsl.judgeFromProviders, 'function', 'judgeFromProviders is exported');
  const registry = Object.fromEntries(providers.map((p) => [p.id, p]));
  return { runJudge: dsl.judgeFromProviders({ providers: registry, default: fallback, deadlineMs }), decisionProviders: { providers: registry, default: fallback } };
}
const outcomeOf = (promise) => promise.then((result) => ({ status: result.status, result }), (error) => ({ status: 'threw', message: String(error?.message ?? error) }));

test('T1: provider, model, evidence and timeoutMs validate on judge, pick, sift, route and ask; a bad value or a field on another node is refused by name', () => {
  const nodes = {
    judge: judge(FIELDS),
    pick: { node: 'pick', label: 'pickOne', itemsPath: 'filings', describe: '{item.id}', instructions: 'Which filing is the certificate?', as: 'picked', ...FIELDS },
    sift: { node: 'sift', label: 'siftThem', itemsPath: 'filings', out: 'Item', as: 'kept', ...FIELDS },
    route: { node: 'route', label: 'triage', state: { text: '{text}' }, instructions: 'Which desk takes it?', as: 'desk', ...FIELDS,
      branches: { calm: { criteria: 'a routine filing', body: { node: 'code', label: 'calm', code: '() => ({})' } }, odd: { criteria: 'an unusual filing', body: { node: 'code', label: 'odd', code: '() => ({})' } } } },
    ask: { node: 'loop', label: 'retry', maxIters: 2, until: { predicate: 'ask', instructions: 'Is it complete?', ...FIELDS }, body: { node: 'code', label: 'tick', code: '() => ({})' } },
  };
  for (const [kind, node] of Object.entries(nodes)) {
    const checked = validateWorkflow(doc([node]));
    assert.equal(checked.ok, true, `${kind} takes the four fields: ${JSON.stringify(checked.errors ?? [])}`);
  }
  for (const [field, bad] of [['evidence', 'always'], ['timeoutMs', 0], ['timeoutMs', -5], ['timeoutMs', 1.5], ['timeoutMs', 120_001], ['provider', ''], ['provider', 'Parallel AI'], ['model', '']]) {
    const checked = validateWorkflow(doc([judge({ [field]: bad })]));
    assert.equal(checked.ok, false, `${field}: ${JSON.stringify(bad)} is refused`);
    assert.match(checked.errors.join(' '), new RegExp(field), `the refusal names ${field}`);
  }
  const asked = validateWorkflow(doc([{ ...nodes.ask, until: { ...nodes.ask.until, timeoutMs: 120_001, model: '' } }]));
  assert.equal(asked.ok, false, 'an ask predicate\'s fields are checked too');
  assert.match(asked.errors.join(' '), /ask\.timeoutMs/);
  assert.match(asked.errors.join(' '), /ask\.model/);
  const byValue = { node: 'route', label: 'desk', valuePath: 'text', branches: { calm: { body: { node: 'code', label: 'calm', code: '() => ({})' } }, odd: { body: { node: 'code', label: 'odd', code: '() => ({})' } } }, otherwise: 'calm' };
  assert.equal(validateWorkflow(doc([byValue])).ok, true, JSON.stringify(validateWorkflow(doc([byValue])).errors ?? []));
  const pinned = validateWorkflow(doc([{ ...byValue, provider: 'parallel' }]));
  assert.equal(pinned.ok, false, 'a route by value asks no question, so it takes no provider');
  assert.match(pinned.errors.join(' '), /provider/);
  const agent = { node: 'extract', label: 'read', instructions: 'Read it.', out: 'Check', as: 'read', provider: 'parallel' };
  assert.equal(validateWorkflow(doc([agent])).ok, false, 'an agent node takes no provider');
});

test('T2: the host\'s providers are checked against the nodes before any node runs: evidence a provider cannot give, an unknown provider, a question type it does not answer', async () => {
  const cases = [
    ['evidence: "required" on a provider that gives none', judge({ provider: 'jev', evidence: 'required' }), /evidence/],
    ['an unknown provider', judge({ provider: 'nobody' }), /nobody/],
    ['a question type the provider does not answer', judge({ provider: 'jev' }, 'Scored'), /score/],
  ];
  for (const [what, node, names] of cases) {
    const jev = provider('jev', { evidence: 'none', types: ['noul', 'choice'] }, []);
    let ran = 0;
    const first = { node: 'code', label: 'first', code: '() => ({ seen: true })' };
    const outcome = await outcomeOf(runWorkflow(doc([first, node]), INPUT, { ...hosted([jev]), onEvent: (event) => { if (event.type === 'node.end' && event.label === 'first') ran += 1; } }));
    assert.equal(outcome.status, 'threw', `${what}: the run is refused`);
    assert.match(outcome.message, names, `${what}: the refusal names it`);
    assert.match(outcome.message, /check/, `${what}: the refusal names the node`);
    assert.deepEqual([ran, jev.asked.length], [0, 0], `${what}: refused before any node runs, the provider never asked`);
  }
});

test('T3: each node is asked through its own provider and model, an unnamed one through the default, within the shorter deadline', async () => {
  const jev = provider('jev'), parallel = provider('parallel');
  const workflow = doc([judge({ provider: 'parallel', model: 'base-1', timeoutMs: 500 }, 'Check', 'pinned'), judge({ timeoutMs: 9000 }, 'Check', 'plain')]);
  const outcome = await outcomeOf(runWorkflow(workflow, INPUT, hosted([jev, parallel], { fallback: 'jev', deadlineMs: 2000 })));
  assert.equal(outcome.status, 'complete', JSON.stringify(outcome).slice(0, 300));
  assert.deepEqual(parallel.asked.map(({ request }) => [request.label, request.model]), [['pinned', 'base-1']], 'the pinned node went to its provider with its model');
  assert.deepEqual(jev.asked.map(({ request }) => request.label), ['plain'], 'the unnamed node went to the default');
  assert.equal(parallel.asked[0].ctx.deadlineMs, 500, 'a node may shorten the deadline');
  assert.equal(jev.asked[0].ctx.deadlineMs, 2000, 'and never lengthen it past the provider\'s');
});

test('T4: the provider\'s evidence travels with the answer to the sidecar, the receipt and judge.answered; "off" drops it; "required" with none is refused', async () => {
  const run = async (evidence, given = EVIDENCE) => {
    const receipts = [], events = [];
    const outcome = await outcomeOf(runWorkflow(doc([judge({ provider: 'parallel', evidence })]), INPUT, { ...hosted([provider('parallel', {}, given)]),
      recordDecision: async (receipt) => { receipts.push(receipt); }, onEvent: (event) => { if (event.type === 'judge.answered') events.push(event); } }));
    return { outcome, receipts, events };
  };
  const kept = await run('if_supported');
  assert.equal(kept.outcome.status, 'complete', JSON.stringify(kept.outcome).slice(0, 300));
  assert.deepEqual(kept.outcome.result.state.check$answers?.evidence, EVIDENCE, 'the sidecar holds the evidence');
  assert.deepEqual(kept.receipts.map((receipt) => receipt.evidence), [EVIDENCE], 'the receipt holds the evidence');
  assert.deepEqual(kept.receipts.map((receipt) => receipt.provider), ['parallel'], 'the receipt names its provider');
  assert.deepEqual(kept.events.map((event) => event.detail.evidence), [EVIDENCE], 'judge.answered holds the evidence');
  const off = await run('off');
  assert.equal(off.outcome.status, 'complete');
  assert.deepEqual([off.outcome.result.state.check$answers?.evidence, off.receipts[0]?.evidence, off.events[0]?.detail.evidence], [undefined, undefined, undefined], '"off" carries none');
  const required = await run('required', []);
  assert.equal(required.outcome.status, 'threw', '"required" with no evidence fails the request');
  assert.match(required.outcome.message, /evidence/);
});

test('T5: a pinned model is part of what the decision is: changed, the decision is asked again; unpinned, its id is today\'s', async () => {
  const receipts = [];
  // A host that keeps decision receipts and nothing else: every run starts again, and answers from the receipts it kept.
  const kept = { recordDecision: async (receipt) => { receipts.push(receipt); }, recovery: { supportsExecutionPaths: true, resume: async () => undefined, commit: async () => {},
    pollStartedAt: () => Date.now(), wait: async () => {}, decision: async (id) => receipts.find((receipt) => receipt.id === id && receipt.status === 'answered') } };
  const parallel = provider('parallel');
  for (const model of ['base-1', 'base-1', 'base-2']) {
    const outcome = await outcomeOf(runWorkflow(doc([judge({ provider: 'parallel', model })]), INPUT, { ...hosted([parallel]), ...kept }));
    assert.equal(outcome.status, 'complete', JSON.stringify(outcome).slice(0, 300));
  }
  assert.deepEqual(parallel.asked.map(({ request }) => request.model), ['base-1', 'base-2'], 'the same pin replays its receipt; a new pin is asked again');
  // The id an unpinned judge got before these fields existed: its receipts keep replaying.
  const plain = [];
  await runWorkflow(doc([judge()]), INPUT, { runJudge: async () => ({ answers: { legit: { type: 'noul', noul: 0.9 } } }), recordDecision: async (receipt) => { plain.push(receipt.id); } });
  assert.deepEqual(plain, [UNPINNED_ID]);
});
const UNPINNED_ID = 'f680dbb73881784a417934253f4228aaef909b0626ef0ccbbc6975230bc9448f';

test('T5b: under recovery, a decision\'s request record carries the model the node pins', async () => {
  const workflow = doc([judge({ provider: 'parallel', model: 'base-1' })]);
  const store = memoryStore();
  const driver = await openRecovery(store, workflow, { key: 'run-1' });
  try { assert.equal((await runWorkflow(workflow, INPUT, withRecovery(driver, hosted([provider('parallel')])))).status, 'complete'); }
  finally { await driver.close(); }
  const reopened = await openRecovery(store, workflow, { key: 'run-1' });
  try { assert.deepEqual(Object.values(reopened.decisionRequests()).map((request) => [request.status, request.model]), [['answered', 'base-1']]); }
  finally { await reopened.close(); }
});

test('T7: a call cut by its node\'s own timeoutMs after it was sent is outcome_unknown: booked at the list-price estimate, never asked again, and the run goes to review', async () => {
  const LIST_PRICE = 0.004;
  // Once sent, the request is paid whether or not its answer arrives: cut, the provider says so with its list price.
  const slow = { ...provider('parallel'), sent: 0, decide: async (_request, ctx) => {
    slow.sent += 1;
    await new Promise((resolve) => { if (ctx.signal.aborted) resolve(); else ctx.signal.addEventListener('abort', resolve, { once: true }); });
    throw new DecisionProviderError('outcome_unknown', 'the request was sent and its answer did not arrive in time', { costUsd: LIST_PRICE, costBasis: 'estimate' });
  } };
  const receipts = [];
  const started = Date.now();
  const outcome = await outcomeOf(runWorkflow(doc([judge({ provider: 'parallel', timeoutMs: 200 })]), INPUT, { ...hosted([slow], { deadlineMs: 60_000 }), recordDecision: async (receipt) => { receipts.push(receipt); } }));
  assert.ok(Date.now() - started < 30_000, 'the node\'s own timeoutMs cut the call, not the provider\'s deadline');
  assert.equal(slow.sent, 1, 'a call cut after it was sent is never asked again');
  assert.equal(outcome.status, 'escalated', JSON.stringify(outcome).slice(0, 300));
  assert.equal(outcome.result.escalation.kind, 'decision_interrupted', 'it goes to review');
  assert.deepEqual(receipts.map((receipt) => [receipt.status, receipt.cost_usd]), [['failed', LIST_PRICE]], 'booked once, at the list-price estimate');
});

test('T7b: a provider that reports its cut call as aborted, as the conformance suite has it, is still outcome_unknown: never asked again, and the run goes to review', async () => {
  const slow = { ...provider('parallel'), sent: 0, decide: async (_request, ctx) => {
    slow.sent += 1;
    await new Promise((resolve) => { if (ctx.signal.aborted) resolve(); else ctx.signal.addEventListener('abort', resolve, { once: true }); });
    throw new DecisionProviderError('aborted', 'the request was cancelled', { attempts: 1 });
  } };
  const receipts = [];
  const outcome = await outcomeOf(runWorkflow(doc([judge({ provider: 'parallel', timeoutMs: 200 })]), INPUT, { ...hosted([slow], { deadlineMs: 60_000 }), recordDecision: async (receipt) => { receipts.push(receipt); } }));
  assert.equal(slow.sent, 1, 'a call cut after it was sent is never asked again');
  assert.equal(outcome.status, 'escalated', JSON.stringify(outcome).slice(0, 300));
  assert.equal(outcome.result.escalation.kind, 'decision_interrupted', 'it goes to review');
  assert.deepEqual(receipts.map((receipt) => [receipt.status, receipt.cost_usd]), [['failed', null]], 'booked once; the provider gave no estimate');
});

test('T6: the published schema and the author guide carry the four fields', () => {
  const schema = JSON.parse(readFileSync(new URL('../schema/workflow.schema.json', import.meta.url), 'utf8'));
  const nodes = [];
  const walk = (value) => {
    if (!value || typeof value !== 'object') return;
    // A route by value reads its branch from state and asks nothing: it takes no decision fields.
    if (value.properties?.node?.const && ['judge', 'pick', 'sift', 'route'].includes(value.properties.node.const) && !value.required?.includes('valuePath')) nodes.push(value);
    for (const child of Object.values(value)) walk(child);
  };
  walk(schema);
  assert.ok(nodes.length >= 4, 'the schema holds the decision nodes');
  for (const node of nodes) for (const field of ['provider', 'model', 'evidence', 'timeoutMs']) assert.ok(node.properties[field], `${node.properties.node.const} lists ${field}`);
  const guide = readFileSync(new URL('../skills/author/references/jev-decisions.md', import.meta.url), 'utf8');
  for (const words of [/provider/, /evidence: "required"|"required"/, /timeoutMs/]) assert.match(guide, words);
});

void DecisionProviderError;
