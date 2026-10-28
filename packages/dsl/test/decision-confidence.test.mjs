// A provider that gives a choice or score its probabilities but no confidence gets one derived, with the formulas TypeSafe
// documents for Jev (docs.typesafe.ai/confidence): (p - 1/n) / (1 - 1/n) for the chosen option of n, and, for a score of n
// levels, 1 minus the probability-weighted distance from the most likely level over that distance for an even spread,
// floored at 0. The receipt says which answers' confidence the provider gave and which were derived. Only answers whose
// probabilities are missing or invalid fall back to 0, and validation then refuses them.
import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveConfidence, completeConfidence, runWorkflow } from '../dist/index.js';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);
const choiceOf = (probabilities, choice) => ({ type: 'choice', choice, probabilities });
const scoreOf = (probabilities) => ({ type: 'score', score: probabilities.reduce((sum, p, i) => sum + i * p, 0), legend: Object.fromEntries(probabilities.map((_, i) => [String(i), `level ${i}`])), probabilities: Object.fromEntries(probabilities.map((p, i) => [String(i), p])) });

test('choice confidence: only the chosen option counts; an even split is 0 and certainty is 1', () => {
  close(deriveConfidence(choiceOf({ a: 0.6, b: 0.3, c: 0.1 }, 'a')), 0.4);
  close(deriveConfidence(choiceOf({ a: 0.6, b: 0.2, c: 0.2 }, 'a')), 0.4);
  close(deriveConfidence(choiceOf({ a: 0.5, b: 0.5 }, 'a')), 0);
  close(deriveConfidence(choiceOf({ a: 1, b: 0, c: 0, d: 0 }, 'a')), 1);
  // The chosen option, not the most likely one: a choice below an even split has no confidence.
  close(deriveConfidence(choiceOf({ a: 0.2, b: 0.8 }, 'a')), 0);
});

test('score confidence: neighbouring levels keep some, opposite ends none, one level all', () => {
  close(deriveConfidence(scoreOf([0, 0.5, 0.5])), 0.25);
  close(deriveConfidence(scoreOf([0.5, 0, 0.5])), 0);
  close(deriveConfidence(scoreOf([0, 1, 0])), 1);
  close(deriveConfidence(scoreOf([1, 0, 0, 0, 0])), 1);
});

test('missing or invalid probabilities derive nothing', () => {
  assert.equal(deriveConfidence({ type: 'choice', choice: 'a' }), null);
  assert.equal(deriveConfidence(choiceOf({ a: 'high', b: 0.1 }, 'a')), null);
  assert.equal(deriveConfidence(choiceOf({ a: 0.6, b: 0.4 }, 'c')), null);
  assert.equal(deriveConfidence({ type: 'score', score: 1, probabilities: {} }), null);
});

const questions = {
  pick: { type: 'choice', instructions: 'Which?', criteria: { a: null, b: null } },
  level: { type: 'score', instructions: 'How much?', criteria: ['low', 'mid', 'high'] },
  holds: { type: 'noul', instructions: 'Does it hold?' },
  refused: { type: 'noul', instructions: 'Anything else?' },
};

test('completeConfidence keeps a provider confidence, derives a missing one, and marks which is which', () => {
  const given = { ...choiceOf({ a: 0.9, b: 0.1 }, 'a'), confidence: 0.7 };
  const { answers, confidence_source } = completeConfidence(questions, { pick: given, level: scoreOf([0, 0.5, 0.5]), holds: { type: 'noul', noul: 0.8 }, refused: { type: 'refusal' } });
  assert.equal(answers.pick.confidence, 0.7);
  close(answers.level.confidence, 0.25);
  assert.deepEqual(confidence_source, { pick: 'provider', level: 'derived' });
  assert.equal('confidence' in answers.holds, false, 'a noul carries no confidence');
});

test('completeConfidence falls back to 0 only when there is nothing to derive from', () => {
  const { answers, confidence_source } = completeConfidence(questions, { pick: { type: 'choice', choice: 'a' } });
  assert.equal(answers.pick.confidence, 0);
  assert.deepEqual(confidence_source, { pick: 'derived' });
});

test('a route reads a derived confidence as it would a given one, and its receipt records the source', async () => {
  const receipts = [];
  const flow = {
    v: 2, name: 'routed', schemas: { Out: { type: 'object' } }, output: { schemaId: 'Out', path: 'out' },
    root: { node: 'route', label: 'lane', instructions: 'Which lane?', state: { doc: 'x' }, unsure: { gte: 0.5, branch: 'slow' }, as: 'lane', branches: {
      fast: { criteria: 'simple', body: { node: 'code', label: 'fast-step', code: '() => ({ out: { via: "fast" } })' } },
      slow: { criteria: 'needs care', body: { node: 'code', label: 'slow-step', code: '() => ({ out: { via: "slow" } })' } },
    } },
  };
  // 0.7 of two options derives 0.4, under the 0.5 bar: unsure.
  const runJudge = async () => {
    const done = completeConfidence({ branch: { type: 'choice', instructions: 'Which lane?', criteria: { fast: 'simple', slow: 'needs care' } } }, { branch: choiceOf({ fast: 0.7, slow: 0.3 }, 'fast') });
    return { answers: done.answers, confidence_source: done.confidence_source };
  };
  const run = await runWorkflow(flow, {}, { runJudge, recordDecision: async (receipt) => { receipts.push(receipt); } });
  assert.deepEqual(run.output, { via: 'slow' });
  assert.deepEqual(receipts[0].confidence_source, { branch: 'derived' });
  close(receipts[0].answers.branch.confidence, 0.4);
});
