// A Box question locates what its instructions describe in the request's image (Jev 1.14). A host-side question: the answer
// types, validation, confidence and synthetic answer carry it; no workflow node declares one.
import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAnswers, answerConfidence, answersSidecar, synthesizeAnswers, answersToValue, isSystemOneResponseReason } from '../dist/index.js';

const questions = { mug: { type: 'box', instructions: 'the mug in <photo>' }, open: { type: 'noul', instructions: 'Is the lid open?' } };
const box = { top: 0.1, bottom: 0.6, left: 0.2, right: 0.5 };
const answers = (over = {}) => ({ mug: { type: 'box', box, confidence: 0.8, ...over }, open: { type: 'noul', noul: 0.25 } });
const rejects = (reason, a, q = questions) => assert.throws(() => validateAnswers(q, a), error => error.responseReason === reason);

test('a box answer validates beside other answers, with a confidence or none', () => {
  validateAnswers(questions, answers());
  validateAnswers(questions, answers({ confidence: null }));
  validateAnswers({ mug: questions.mug }, { mug: { type: 'box', box: { top: 0, bottom: 1, left: 0, right: 1 }, confidence: 0 } });
});

test('a box answer outside its shape is refused with a fixed reason', () => {
  assert.equal(isSystemOneResponseReason('box_coordinates'), true);
  for (const bad of [{ ...box, top: -0.1 }, { ...box, right: 1.01 }, { ...box, left: NaN }, { ...box, bottom: '0.5' }, { top: 0, bottom: 1, left: 0 }, { ...box, extra: 0 }, null, [0, 1, 0, 1]])
    rejects('box_coordinates', answers({ box: bad }));
  for (const confidence of [-1, 1.5, NaN, '0.5', undefined]) rejects('confidence', answers({ confidence }));
  rejects('answer_type', { mug: { type: 'noul', noul: 0.5 }, open: { type: 'noul', noul: 0.5 } });
  rejects('answer_type', { mug: { type: 'box', box, confidence: 1 }, open: { type: 'box', box, confidence: 1 } });
});

test('a box has the confidence it reported; one the provider left out counts as none, never as sure', () => {
  assert.equal(answerConfidence({ type: 'box', box, confidence: 0.8 }), 0.8);
  assert.equal(answerConfidence({ type: 'box', box, confidence: null }), 0);
  const sidecar = answersSidecar(answers({ confidence: 0.4 }));
  assert.deepEqual([sidecar.weakest, sidecar.min_confidence], ['mug', 0.4]);
});

test('a box question has a synthetic answer that validates, and a value that is its box', () => {
  const synthetic = synthesizeAnswers(questions);
  validateAnswers(questions, synthetic);
  assert.deepEqual(synthetic.mug, { type: 'box', box: { top: 0, bottom: 1, left: 0, right: 1 }, confidence: 0 });
  assert.deepEqual(answersToValue(answers(), questions), { mug: box, open: false });
});
