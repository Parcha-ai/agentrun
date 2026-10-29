// judgeFromProvider turns a DecisionProvider into the interpreter's runJudge: the request goes to the provider with the
// decision's id, its signal and a deadline; what comes back is the runJudge result, with a missing choice or score
// confidence derived and its source named, the provider's evidence and request id, and its cost with the basis of it. A
// question beyond what the provider declares it can answer is refused before the provider is asked.
import assert from 'node:assert/strict';
import test from 'node:test';
import { judgeFromProvider, DecisionProviderError, runWorkflow, DECISION_INTERRUPTED } from '../dist/index.js';
import { DECISION_INTERRUPTED as RECOVERY_DECISION_INTERRUPTED } from '../dist/recovery/index.js';

const capabilities = { types: ['noul', 'choice', 'score'], inputs: ['text', 'json'], evidence: 'citations', probability: 'model', grounding: true, replay: 'never', maxQuestions: 2, maxStateBytes: 1000 };
const questions = { holds: { type: 'noul', instructions: 'Does it hold?' }, pick: { type: 'choice', instructions: 'Which?', criteria: { a: null, b: null } } };
const params = { label: 'check', kind: 'judge', state: { doc: 'x' }, questions, decisionId: 'decision-1' };
const outcome = {
  answers: { holds: { type: 'noul', noul: 0.9 }, pick: { type: 'choice', choice: 'a', probabilities: { a: 0.75, b: 0.25 } } },
  evidence: [{ url: 'https://example.com/a', title: 'A', excerpts: ['text'], scope: 'call' }],
  model: 'fast', usage: { input_tokens: 10, output_tokens: 0 }, cost_usd: 0.001, cost_basis: 'estimate', provider_request_id: 'req-1',
};
const providerOf = (decide, over = {}) => ({ id: 'test', needs: ['TEST_KEY'], capabilities: { ...capabilities, ...over }, decide });
const code = (expected) => (error) => { assert.ok(error instanceof DecisionProviderError, String(error)); assert.equal(error.code, expected); return true; };

test('the provider gets the request with the decision id, a signal and the deadline', async () => {
  let seen;
  const judge = judgeFromProvider(providerOf(async (request, ctx) => { seen = { request, ctx }; return outcome; }), { deadlineMs: 5000 });
  await judge(params);
  assert.deepEqual(seen.request.questions, questions);
  assert.deepEqual(seen.request.state, { doc: 'x' });
  assert.equal(seen.ctx.decisionId, 'decision-1');
  assert.ok(seen.ctx.signal instanceof AbortSignal);
  assert.equal(seen.ctx.deadlineMs, 5000);
});

test('the result carries the answers with a derived confidence named, the evidence, the request id and the cost basis', async () => {
  const result = await judgeFromProvider(providerOf(async () => outcome))(params);
  assert.equal(result.answers.pick.confidence, 0.5);
  assert.deepEqual(result.confidence_source, { pick: 'derived' });
  assert.deepEqual(result.evidence, outcome.evidence);
  assert.equal(result.provider_request_id, 'req-1');
  assert.deepEqual([result.cost_usd, result.cost_basis, result.model], [0.001, 'estimate', 'fast']);
});

test('a question type the provider does not declare is refused before it is asked', async () => {
  let asked = 0;
  const judge = judgeFromProvider(providerOf(async () => { asked++; return outcome; }, { types: ['noul'] }));
  await assert.rejects(judge(params), code('invalid_request'));
  assert.equal(asked, 0);
});

test('more questions than the provider declares, or a larger state, are refused before it is asked', async () => {
  let asked = 0;
  const decide = async () => { asked++; return outcome; };
  await assert.rejects(judgeFromProvider(providerOf(decide, { maxQuestions: 1 }))(params), code('invalid_request'));
  await assert.rejects(judgeFromProvider(providerOf(decide))({ ...params, state: { doc: 'x'.repeat(2000) } }), code('invalid_request'));
  assert.equal(asked, 0);
});

test('a provider answer that does not match the questions is invalid_response, never answers', async () => {
  const judge = judgeFromProvider(providerOf(async () => ({ ...outcome, answers: { holds: outcome.answers.holds } })));
  await assert.rejects(judge(params), code('invalid_response'));
});

test('a workflow runs on a provider through runJudge, and the receipt holds the derived-confidence source', async () => {
  const receipts = [];
  const flow = {
    v: 2, name: 'judged', schemas: { Verdict: { type: 'object', required: ['legit'], properties: { legit: { type: 'boolean', description: 'Is it legitimate?' } } } },
    output: { schemaId: 'Verdict', path: 'verdict' },
    root: { node: 'judge', label: 'check', state: { doc: 'x' }, out: 'Verdict', as: 'verdict' },
  };
  const provider = providerOf(async (request) => ({ ...outcome, answers: { legit: { type: 'noul', noul: request.questions.legit ? 0.8 : 0 } } }));
  const run = await runWorkflow(flow, {}, { runJudge: judgeFromProvider(provider), recordDecision: async (receipt, exchange) => { receipts.push({ receipt, exchange }); } });
  assert.deepEqual(run.output, { legit: true });
  assert.deepEqual(receipts[0].receipt.confidence_source, {});
  assert.deepEqual([receipts[0].receipt.cost_usd, receipts[0].exchange.result.cost_basis], [0.001, 'estimate']);
  assert.deepEqual(receipts[0].exchange.result.evidence, outcome.evidence);
});

test('a decision whose outcome is unknown after it was sent escalates as interrupted, booked at the cost the provider estimates', async () => {
  const receipts = [];
  const flow = {
    v: 2, name: 'judged', schemas: { Verdict: { type: 'object', required: ['legit'], properties: { legit: { type: 'boolean', description: 'Is it legitimate?' } } } },
    output: { schemaId: 'Verdict', path: 'verdict' },
    root: { node: 'judge', label: 'check', state: { doc: 'x' }, out: 'Verdict', as: 'verdict' },
  };
  let asked = 0;
  const provider = providerOf(async () => { asked++; throw new DecisionProviderError('outcome_unknown', 'HTTP 503 after the request was sent.', { status: 503, attempts: 1, costUsd: 0.001, costBasis: 'estimate' }); });
  const result = await runWorkflow(flow, { filing: 'case-9' }, { runJudge: judgeFromProvider(provider), recordDecision: async (receipt) => { receipts.push(receipt); } });
  assert.equal(result.status, 'escalated', 'an outcome the run cannot know goes to a person, not to a failed run');
  assert.deepEqual([result.escalation.kind, result.escalation.stage, result.escalation.label], ['decision_interrupted', 'decision', 'check']);
  assert.equal(result.escalation.kind, DECISION_INTERRUPTED, 'the one exported kind, from the main entry');
  assert.equal(DECISION_INTERRUPTED, RECOVERY_DECISION_INTERRUPTED, 'and the same constant recovery escalates with');
  assert.match(result.escalation.summary, /"check"/);
  assert.equal(result.escalation.state.filing, 'case-9');
  assert.equal(asked, 1, 'it is not asked again');
  assert.deepEqual([receipts.length, receipts[0].status, receipts[0].cost_usd], [1, 'failed', 0.001]);
});
