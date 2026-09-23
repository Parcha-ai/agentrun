import assert from 'node:assert/strict';
import test from 'node:test';
import { APIError } from '@typesafe-ai/sdk';
import { createJevRunner, JevError, isJevResponseReason } from '../dist/index.js';

const secret = 'PRIVATE_PROVIDER_BODY_HEADERS_ID_SENTINEL';
const questions = { n: { type: 'noul', instructions: 'Fictional support?' }, c: { type: 'choice', instructions: 'Fictional option?', criteria: { yes: null, no: null } },
  s: { type: 'score', instructions: 'Fictional level?', criteria: ['Low', 'High'] } };
const good = () => ({ answers: { n: { type: 'noul', noul: 0.7 }, c: { type: 'choice', choice: 'yes', probabilities: { yes: 0.6, no: 0.4 }, confidence: 0.2 },
  s: { type: 'score', score: 0.4, legend: { 0: 'Low', 1: 'High' }, probabilities: { 0: 0.6, 1: 0.4 }, confidence: 0.2 } }, usage: { input_tokens: 100, output_tokens: 2 }, model: 'fictional' });
const params = { label: 'fictional', kind: 'judge', state: {}, questions };
const safe = error => { assert.doesNotMatch(error.message + JSON.stringify(error), new RegExp(secret)); assert.equal(error.cause, undefined); };

test('real adapter preserves all response invariants with one attempt and safe legacy messages', async () => {
  for (const [reason, change, extra] of [
    ['response_shape', () => secret], ['answers_shape', x => { x.answers = null; }],
    ['answer_keys', x => { delete x.answers.n; }], ['answer_shape', x => { x.answers.n = secret; }],
    ['answer_type', x => { x.answers.n.type = secret; }], ['noul_probability', x => { x.answers.n.noul = Infinity; }],
    ['confidence', x => { x.answers.c.confidence = NaN; }], ['probabilities', x => { x.answers.c.probabilities.yes = secret; }],
    ['probability_keys', x => { delete x.answers.c.probabilities.no; }], ['probability_mass', x => { x.answers.c.probabilities.no = 0.3; }],
    ['score_legend', x => { x.answers.s.legend[0] = secret; }], ['score_consistency', x => { x.answers.s.score = -1; }],
    ['choice_option', x => { x.answers.c.choice = secret; }], ['score_range', x => { x.answers.s.score = undefined; }],
    ['token_usage', x => { x.usage.input_tokens = secret; }], ['model_identifier', x => { x.model = {}; }],
    ['cost_range', () => {}, { pricing: { inputUsdPerMillionTokens: Number.MAX_VALUE, outputUsdPerMillionTokens: 0 } }],
    ['answer_validation', x => { Object.defineProperty(x.answers, 'n', { get() { throw new Error(secret); } }); }],
  ]) {
    let calls = 0;
    const runner = createJevRunner({ ...extra, maxAttempts: 3, client: { async systemOne() { calls++; const value = good(); return change(value) ?? value; } } });
    await assert.rejects(runner(params), error => { assert.equal(error.code, 'invalid_response'); assert.equal(error.responseDiagnostic.reason, reason); assert.equal(error.attempts, 1); safe(error); return true; });
    assert.equal(calls, 1);
  }
});

test('HTTP statuses and exact structured capacity code survive without provider text', async () => {
  for (const status of [400, 401, 413, 422, 429, 503, 529]) {
    let calls = 0;
    const runner = createJevRunner({ apiKey: 'fake-test-key', baseURL: 'https://fictional.invalid', maxAttempts: 1, fetch: async () => {
      calls++; return new Response(JSON.stringify({ detail: { error_type: 'max_tokens_exceeded', message: secret }, extra: secret }), { status,
        headers: { 'content-type': 'application/json', 'x-typesafe-request-id': secret } });
    } });
    await assert.rejects(runner(params), error => { assert.equal(error.status, status); assert.equal(error.responseDiagnostic.reason, 'max_tokens_exceeded'); safe(error); return true; });
    assert.equal(calls, 1);
  }
});

test('generic adapter does not parse broker messages, unknown codes or wrong paths', async () => {
  for (const body of [secret, { message: 'max_tokens_exceeded' }, { detail: { error_type: 'MAX_TOKENS_EXCEEDED' } },
    { detail: { error_type: secret } }, { error: { message: JSON.stringify({ detail: { error_type: 'max_tokens_exceeded' } }) } },
    { error: { detail: { error_type: 'max_tokens_exceeded' } } }]) {
    const run = createJevRunner({ maxAttempts: 3, client: { async systemOne() { throw new APIError(400, body, new Headers({ private: secret })); } } });
    await assert.rejects(run(params), error => { assert.equal(error.code, 'http'); assert.equal(error.status, 400); assert.equal(error.responseDiagnostic, undefined); safe(error); return true; });
  }
});

test('HTTP retry ownership is unchanged and a capacity hint does not retry400', async () => {
  for (const status of [400, 401, 408, 429, 503, 529]) {
    let calls = 0; const retryable = [408, 429, 503, 529].includes(status);
    const run = createJevRunner({ maxAttempts: 3, retryBaseMs: 0, retryMaxMs: 0, client: { async systemOne() {
      calls++; throw new APIError(status, { detail: { error_type: 'max_tokens_exceeded' } }, new Headers());
    } } });
    await assert.rejects(run(params), error => { assert.equal(error.attempts, retryable ? 3 : 1); return true; });
    assert.equal(calls, retryable ? 3 : 1);
  }
});

test('malformed HTTP status and forged diagnostic cannot disclose arbitrary values', async () => {
  for (const status of [secret, NaN, Infinity, 99, 600, 400.5]) {
    const run = createJevRunner({ maxAttempts: 1, client: { async systemOne() { throw new APIError(status, secret, new Headers()); } } });
    await assert.rejects(run(params), error => { assert.equal(error.code, 'http'); assert.equal(error.status, undefined); safe(error); return true; });
  }
  assert.equal(isJevResponseReason(secret), false);
  const error = new JevError('invalid_response', 'fixed', 1, undefined, undefined, { reason: secret, extra: secret });
  assert.equal(error.responseDiagnostic, undefined); safe(error);
});

test('abort wins over lateinvalid response, late400, and retrybackoff', async () => {
  for (const variant of ['response', 'http', 'backoff', 'before']) {
    const controller = new AbortController(); let calls = 0;
    if (variant === 'before') controller.abort();
    const run = createJevRunner({ signal: controller.signal, timeoutMs: null, maxAttempts: 3, retryBaseMs: 50, retryMaxMs: 50,
      client: { async systemOne() { calls++;
        if (variant === 'backoff') setTimeout(() => controller.abort(), 0); else controller.abort();
        if (variant !== 'response') throw new APIError(variant === 'backoff' ? 503 : 400, { detail: { error_type: 'max_tokens_exceeded' } }, new Headers());
        return null;
      } } });
    await assert.rejects(run(params), error => { assert.equal(error.code, 'aborted'); assert.equal(error.responseDiagnostic, undefined); return true; });
    assert.equal(calls, variant === 'before' ? 0 : 1);
  }
});
