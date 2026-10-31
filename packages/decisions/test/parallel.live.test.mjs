// Parallel's REST endpoint, live: three small decisions against api.parallel.ai, about $0.003. It runs only with
// PARALLEL_API_KEY set and is skipped otherwise, so the paid REST path is not measured by the suite.
import assert from 'node:assert/strict';
import test from 'node:test';
import { judgeFromProvider, validateAnswers } from '@parcha/agentrun-dsl';
import { parallelProvider } from '../dist/index.js';

const skip = process.env.PARALLEL_API_KEY ? false : 'PARALLEL_API_KEY is not set: the paid REST path is not measured';
const questions = {
  delaware: { type: 'noul', instructions: 'The text in `document` is a plausible Delaware certificate of incorporation.' },
  forgery: { type: 'choice', instructions: 'How strong are the signs that `document` was altered or fabricated?', criteria: { none: 'none', minor: 'small oddities', strong: 'clear contradictions' } },
  detail: { type: 'score', instructions: 'How complete are the statutory articles in `document`?', criteria: ['most are missing', 'some are missing', 'all are present'] },
};
const document = 'STATE OF DELAWARE CERTIFICATE OF INCORPORATION. FIRST: The name of this Corporation is Example Widgets, Inc. SECOND: Its registered office is 251 Little Falls Drive, Wilmington, New Castle County, 19808. THIRD: Any lawful act. FOURTH: 1,000 shares at $0.001 par. FIFTH: Incorporator: A. Person.';

test('three decisions on the paid REST path answer every question and book each at list price', { skip, timeout: 60_000 }, async () => {
  const judge = judgeFromProvider(parallelProvider({ timeoutMs: 20_000 }));
  for (let i = 0; i < 3; i++) {
    const started = Date.now();
    const result = await judge({ label: `live-${i}`, kind: 'judge', state: { document }, questions, decisionId: `live-${i}` });
    validateAnswers(questions, result.answers);
    assert.match(result.provider_request_id, /^decisions_[0-9a-f]+$/);
    assert.equal(result.cost_basis, 'estimate');
    console.log(`live ${i}: ${Date.now() - started} ms, ${result.provider_request_id}, confidence ${JSON.stringify(result.confidence_source)}`);
  }
});
