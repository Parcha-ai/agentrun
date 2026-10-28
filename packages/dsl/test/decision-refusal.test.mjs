// A provider may decline to answer a question ({type: "refusal"}). A refusal is never read as a value: not false, not the
// first option, not a score of 0. It fails the node that asked, except a route with an `unsure` branch, which takes that
// branch as it would for an answer of no confidence. Either way the receipt names the refused questions.
import assert from 'node:assert/strict';
import test from 'node:test';
import { runWorkflow, validateAnswers, answersToValue, answerConfidence, answersSidecar, rederiveDecision, SystemOneError } from '../dist/index.js';

const refusal = { type: 'refusal' };
const refusedError = (ids) => (error) => {
  assert.ok(error instanceof SystemOneError, `a refusal fails with a SystemOneError, got ${error}`);
  assert.equal(error.responseReason, 'refusal');
  for (const id of ids) assert.match(error.message, new RegExp(`"${id}"`));
  return true;
};
const recorder = () => { const receipts = []; return { receipts, recordDecision: async (receipt) => { receipts.push(receipt); } }; };

test('a refusal is a valid answer to a noul, choice or score question', () => {
  const questions = {
    holds: { type: 'noul', instructions: 'Does it hold?' },
    pick: { type: 'choice', instructions: 'Which?', criteria: { a: null, b: null } },
    level: { type: 'score', instructions: 'How much?', criteria: ['low', 'high'] },
  };
  validateAnswers(questions, { holds: refusal, pick: refusal, level: refusal });
});

test('a refused noul never decodes to false, and a refused choice never decodes to an option', () => {
  const questions = { holds: { type: 'noul', instructions: 'Does it hold?' }, pick: { type: 'choice', instructions: 'Which?', criteria: { a: null, b: null } } };
  assert.throws(() => answersToValue({ holds: refusal, pick: { type: 'choice', choice: 'a', probabilities: { a: 0.9, b: 0.1 }, confidence: 0.8 } }, questions), refusedError(['holds']));
  assert.throws(() => answersToValue({ holds: { type: 'noul', noul: 0.9 }, pick: refusal }, questions), refusedError(['pick']));
});

test('a refusal has confidence 0 in the sidecar', () => {
  assert.equal(answerConfidence(refusal), 0);
  const sidecar = answersSidecar({ holds: refusal, sure: { type: 'noul', noul: 1 } });
  assert.equal(sidecar.confidence.holds, 0);
  assert.equal(sidecar.weakest, 'holds');
});

const judgeFlow = {
  v: 2, name: 'judged', schemas: { Verdict: { type: 'object', required: ['legit'], properties: { legit: { type: 'boolean', description: 'Is the filing legitimate?' } } } },
  output: { schemaId: 'Verdict', path: 'verdict' },
  root: { node: 'judge', label: 'check', state: { doc: 'text' }, out: 'Verdict', as: 'verdict' },
};

test('a judge node whose answer is refused fails, and its failed receipt names the refused question', async () => {
  const { receipts, recordDecision } = recorder();
  await assert.rejects(runWorkflow(judgeFlow, {}, { runJudge: async () => ({ answers: { legit: refusal } }), recordDecision }), refusedError(['legit']));
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].status, 'failed');
  assert.deepEqual(receipts[0].refused, ['legit']);
  assert.equal(receipts[0].action, null);
});

const routeFlow = (unsure) => ({
  v: 2, name: 'routed', schemas: { Out: { type: 'object' } }, output: { schemaId: 'Out', path: 'out' },
  root: {
    node: 'route', label: 'triage', instructions: 'Which desk?', state: { doc: 'text' }, as: 'desk',
    ...(unsure ? { unsure: { gte: 0.5, branch: 'review' } } : {}),
    branches: {
      accept: { criteria: 'clearly fine', body: { node: 'code', label: 'accepted', code: '() => ({ out: { taken: "accept" } })' } },
      review: { criteria: 'needs a person', body: { node: 'code', label: 'reviewed', code: '() => ({ out: { taken: "review" } })' } },
    },
  },
});

test('a refused route with an unsure branch takes it, and its answered receipt re-derives the same action', async () => {
  const { receipts, recordDecision } = recorder();
  const result = await runWorkflow(routeFlow(true), {}, { runJudge: async () => ({ answers: { branch: refusal } }), recordDecision });
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.output, { taken: 'review' });
  assert.equal(receipts[0].status, 'answered');
  assert.deepEqual(receipts[0].refused, ['branch']);
  assert.deepEqual(receipts[0].action, { branch: null, taken: 'review', unsure: true, refused: true });
  assert.deepEqual(rederiveDecision(receipts[0]), receipts[0].action);
});

test('a refused route with no unsure branch fails: there is no branch to take', async () => {
  const { receipts, recordDecision } = recorder();
  await assert.rejects(runWorkflow(routeFlow(false), {}, { runJudge: async () => ({ answers: { branch: refusal } }), recordDecision }), refusedError(['branch']));
  assert.equal(receipts[0].status, 'failed');
  assert.deepEqual(receipts[0].refused, ['branch']);
});

test('a refused ask predicate fails its loop instead of reading as "does not hold"', async () => {
  const flow = {
    v: 2, name: 'asked', schemas: { Out: { type: 'object' } }, output: { schemaId: 'Out', path: 'out' },
    root: { node: 'loop', label: 'until', maxIters: 2, until: { predicate: 'ask', instructions: 'Is it done?' },
      body: { node: 'code', label: 'step', as: 'out', code: '() => ({})' } },
  };
  await assert.rejects(runWorkflow(flow, {}, { runJudge: async () => ({ answers: { holds: refusal } }) }), refusedError(['holds']));
});

test('a refused verify question fails the review instead of reading as unmet', async () => {
  const flow = {
    v: 2, name: 'verified', schemas: {
      Draft: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
      Review: { type: 'object', required: ['complete'], properties: { complete: { type: 'boolean', description: 'Is the draft complete?' } } },
    },
    output: { schemaId: 'Draft', path: 'draft' },
    root: { node: 'agent', label: 'write', instructions: 'Write it.', out: 'Draft', as: 'draft', verify: { out: 'Review', maxDrives: 2 } },
  };
  let judged = 0;
  await assert.rejects(runWorkflow(flow, {}, {
    runNode: async ({ review }) => { const value = { text: 'x' }; await review(value); return value; },
    runJudge: async () => { judged++; return { answers: { complete: refusal } }; },
  }), refusedError(['complete']));
  assert.equal(judged, 1, 'a refusal is not retried as a doubted field');
});
