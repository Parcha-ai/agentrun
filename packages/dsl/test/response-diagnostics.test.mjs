import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAnswers, SystemOneError, isSystemOneResponseReason } from '../dist/index.js';

const secret = 'PRIVATE_QUESTION_OPTION_PROVIDER_SENTINEL';
const question = { type: 'choice', instructions: 'Fictional decision', criteria: { yes: 'Supported', no: null } };
const answer = () => ({ type: 'choice', choice: 'yes', probabilities: { yes: 0.6, no: 0.4 }, confidence: 0.2 });
const score = () => ({ type: 'score', score: 0.4, probabilities: { 0: 0.6, 1: 0.4 }, confidence: 0.2, legend: { 0: 'Low', 1: 'High' } });
const scoreQuestion = { type: 'score', instructions: 'Fictional level', criteria: ['Low', 'High'] };

test('every existing response guard has a fixed safe invariant, preserving precedence', () => {
  const cases = [
    ['answers_shape', { x: question }, null],
    ['answer_keys', { x: question }, {}],
    ['answer_shape', { x: question }, { x: secret }],
    ['answer_type', { x: question }, { x: { ...answer(), type: secret } }],
    ['noul_probability', { x: { type: 'noul' } }, { x: { type: 'noul', noul: secret } }],
    ['confidence', { x: question }, { x: { ...answer(), confidence: Infinity } }],
    ['probabilities', { x: question }, { x: { ...answer(), probabilities: { [secret]: NaN } } }],
    ['probability_keys', { x: question }, { x: { ...answer(), probabilities: { [secret]: 1 } } }],
    ['probability_mass', { x: question }, { x: { ...answer(), probabilities: { yes: 0.6, no: 0.3 } } }],
    ['score_legend', { x: scoreQuestion }, { x: { ...score(), legend: { 0: secret, 1: 'High' } } }],
    ['score_consistency', { x: scoreQuestion }, { x: { ...score(), score: Infinity } }],
    ['choice_option', { x: question }, { x: { ...answer(), choice: secret } }],
    ['score_range', { x: scoreQuestion }, { x: { ...score(), score: NaN } }],
  ];
  for (const [reason, questions, answers] of cases) {
    const q = { [secret]: questions.x }, a = answers && Object.hasOwn(answers, 'x') ? { [secret]: answers.x } : answers;
    assert.throws(() => validateAnswers(q, a), error => {
      assert(error instanceof SystemOneError); assert.equal(error.responseReason, reason); assert.equal(error.retryClass, null);
      assert.doesNotMatch(error.message + JSON.stringify(error), new RegExp(secret)); return true;
    });
  }
});

test('valid primitive identity, fractional scores, arbitrary keys and tolerance are unchanged', () => {
  const questions = { [secret]: question, score: scoreQuestion, n: { type: 'noul' } };
  const answers = { [secret]: answer(), score: score(), n: { type: 'noul', noul: 0 } };
  const before = structuredClone(answers); validateAnswers(questions, answers); assert.deepEqual(answers, before);
  for (const delta of [-0.000009, 0.000009]) {
    const s = score(); s.score += delta; validateAnswers({ x: scoreQuestion }, { x: s });
  }
  for (const delta of [-0.000011, 0.000011]) {
    const s = score(); s.score += delta;
    assert.throws(() => validateAnswers({ x: scoreQuestion }, { x: s }), e => e.responseReason === 'score_consistency');
  }
  for (const delta of [-0.02, 0.02]) {
    const a = answer(); a.probabilities.no += delta; validateAnswers({ x: question }, { x: a });
  }
  for (const delta of [-0.021, 0.021]) {
    const a = answer(); a.probabilities.no += delta;
    assert.throws(() => validateAnswers({ x: question }, { x: a }), e => e.responseReason === 'probability_mass');
  }
  for (const noul of [-1, NaN, Infinity, undefined]) assert.throws(() => validateAnswers({ x: { type: 'noul' } }, { x: { type: 'noul', noul } }), e => e.responseReason === 'noul_probability');
  // Preserve the existing object test: diagnostics must not add an answer-array guard.
  const unusual = []; unusual.type = 'noul'; unusual.noul = 0.5;
  validateAnswers({ x: { type: 'noul' } }, { x: unusual });
  assert.throws(() => validateAnswers({ x: question }, { x: { ...answer(), probabilities: [0.6, 0.4] } }), e => e.responseReason === 'probability_keys');
});

test('two-place rounding drift from System One is accepted without rewriting the answer', () => {
  // Verbatim jev-1.13.0 answer refused by 0.1.0-beta.4: the probabilities sum to 0.99 (#25).
  const criteria = { official_source: 'a', news: 'b', legal_analysis: 'c', court_opinion: 'd', social_primary: 'e', official_travel: 'f', transportation: 'g', web_source: 'h' };
  const questions = { '11.source_class': { type: 'choice', instructions: 'Who published this page?', criteria } };
  const answers = JSON.parse('{"11.source_class":{"type":"choice","choice":"web_source","confidence":0.5,"probabilities":{"transportation":0,"official_source":0.38,"web_source":0.56,"news":0.01,"legal_analysis":0,"official_travel":0,"social_primary":0.04,"court_opinion":0}}}');
  const before = structuredClone(answers);
  validateAnswers(questions, answers);
  assert.deepEqual(answers, before);
  const tie = { type: 'choice', instructions: 'Fictional tie', criteria: { a: null, b: null, c: null } };
  validateAnswers({ x: tie }, { x: { type: 'choice', choice: 'a', probabilities: { a: 0.33, b: 0.33, c: 0.33 }, confidence: 0 } });
});

test('public reason membership and legacy constructor positions are stable', () => {
  const legacy = new SystemOneError('legacy', 'http_429', 429);
  assert.equal(legacy.message, 'legacy'); assert.equal(legacy.status, 429); assert.equal(legacy.responseReason, undefined);
  for (const value of [secret, null, {}, '__proto__', 1]) {
    assert.equal(isSystemOneResponseReason(value), false);
    assert.equal(new SystemOneError('fixed', null, undefined, value).responseReason, undefined);
  }
});
