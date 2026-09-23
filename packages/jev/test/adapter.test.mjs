import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createJevRunner, JevError } from '../dist/index.js';

const questions = {
  team: { type: 'choice', instructions: 'Which team?', criteria: { billing: 'Invoices', other: null } },
  urgent: { type: 'noul', instructions: 'Is action urgent?' },
  severity: { type: 'score', instructions: 'How severe?', criteria: ['Low', 'High'] },
};
const answers = {
  team: { type: 'choice', choice: 'billing', probabilities: { billing: 0.8, other: 0.2 }, confidence: 0.6 },
  urgent: { type: 'noul', noul: 0.9 },
  severity: { type: 'score', score: 0.7, legend: { 0: 'Low', 1: 'High' }, probabilities: { 0: 0.3, 1: 0.7 }, confidence: 0.4 },
};
const payload = () => ({ model: 'jev-test', answers: structuredClone(answers), usage: { input_tokens: 100, output_tokens: 10 } });
const params = { label: 'test', kind: 'judge', state: { ticket: 'Invoice issue' }, questions };
const response = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const settings = { apiKey: 'fake-test-key', baseURL: 'https://fake.invalid/gateway', retryBaseMs: 1, retryMaxMs: 2 };
const code = expected => error => { assert.ok(error instanceof JevError); assert.equal(error.code, expected); return true; };

test('explicit null uses host cancellation only without scheduling deadlines or passing SDK defaults', async t => {
  t.mock.method(globalThis, 'setTimeout', () => { throw new Error('Unexpected adapter deadline'); });
  const runner = createJevRunner({ timeoutMs: null, client: { async systemOne(_request, options) {
    assert.equal(Object.hasOwn(options, 'timeout'), false);
    assert(options.signal instanceof AbortSignal);
    assert.equal(options.retry.maxRetries, 0);
    return payload();
  } } });
  assert.deepEqual((await runner(params)).answers, answers);
});

test('uncapped host clients still stop promptly on cancellation', async t => {
  t.mock.method(globalThis, 'setTimeout', () => { throw new Error('Unexpected adapter deadline'); });
  const controller = new AbortController();
  let attempts = 0;
  const runner = createJevRunner({ timeoutMs: null, signal: controller.signal, client: { systemOne() {
    attempts++;
    queueMicrotask(() => controller.abort());
    return new Promise(() => {});
  } } });
  await assert.rejects(runner(params), code('aborted'));
  assert.equal(attempts, 1);
});

test('uncapped SDK configuration fails clearly instead of inheriting its finite timeout', () => {
  assert.throws(() => createJevRunner({ ...settings, timeoutMs: null }), /cancellation-only host client/);
});

test('official SDK transport retains all primitive answers, usage and model; no implicit price', async () => {
  let calls = 0;
  let requestBody;
  const runner = createJevRunner({ ...settings, fetch: async (url, init) => {
    calls++;
    assert.equal(url, 'https://fake.invalid/gateway/v1/systemone');
    assert.equal(init.headers.Authorization, 'Bearer fake-test-key');
    requestBody = init.body;
    const sent = JSON.parse(requestBody);
    assert.deepEqual(sent.questions, questions);
    assert.deepEqual(sent.state, calls === 1 ? params.state : { ticket: 'A different invoice issue' });
    assert.equal(sent.model, 'jev-latest');
    return response(payload());
  } });
  assert.equal(calls, 0);
  const result = await runner(params);
  assert.equal(calls, 1);
  assert.deepEqual(result.answers, answers);
  assert.deepEqual(result.usage, { input_tokens: 100, output_tokens: 10 });
  assert.equal(result.model, 'jev-test');
  assert.equal(result.cost_usd, null);
  assert.equal(result.request_sha256, createHash('sha256').update(requestBody).digest('hex'));
  const changed = await runner({ ...params, state: { ticket: 'A different invoice issue' } });
  assert.notEqual(changed.request_sha256, result.request_sha256);
  assert.equal(changed.request_sha256, createHash('sha256').update(requestBody).digest('hex'));
});

test('configured prices produce an explicit estimate; missing usage remains unknown', async () => {
  const pricing = { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 };
  const run = createJevRunner({ ...settings, pricing, fetch: async () => response(payload()) });
  assert.equal((await run(params)).cost_usd, 0.00012);
  const noUsage = createJevRunner({ ...settings, pricing, fetch: async () => response({ answers }) });
  assert.equal((await noUsage(params)).cost_usd, null);
});

for (const [name, mutate] of [
  ['missing answer', value => { delete value.answers.urgent; }],
  ['missing option', value => { delete value.answers.team.probabilities.other; }],
  ['extra option', value => { value.answers.team.probabilities.surprise = 0; }],
  ['unnormalized distribution', value => { value.answers.team.probabilities.billing = 0.7; }],
  ['wrong answer type', value => { value.answers.urgent = { type: 'score', score: 1 }; }],
  ['malformed usage', value => { value.usage.input_tokens = -1; }],
  ['malformed model', value => { value.model = { secret: 'private' }; }],
]) {
  test(`rejects ${name} without retrying`, async () => {
    let calls = 0;
    const runner = createJevRunner({ ...settings, fetch: async () => { calls++; const value = payload(); mutate(value); return response(value); } });
    await assert.rejects(runner(params), code('invalid_response'));
    assert.equal(calls, 1);
  });
}

test('non-JSON and HTTP errors never expose response bodies or keys', async () => {
  for (const status of [200, 401, 422]) {
    let calls = 0;
    const run = createJevRunner({ ...settings, fetch: async () => { calls++; return response('private-password fake-test-key', status); } });
    await assert.rejects(run(params), error => {
      assert.equal(error.code, status === 200 ? 'invalid_response' : 'http');
      assert.doesNotMatch(String(error) + JSON.stringify(error), /private-password|fake-test-key/);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('transient HTTP failures have one bounded retry owner', async () => {
  let calls = 0;
  const run = createJevRunner({ ...settings, maxAttempts: 3, fetch: async () => { calls++; return response('secret-provider-body', 503); } });
  await assert.rejects(run(params), error => { assert.equal(error.code, 'http'); assert.equal(error.status, 503); assert.equal(error.attempts, 3); return true; });
  assert.equal(calls, 3);
});

test('429 and 529 retry then succeed', async () => {
  let calls = 0;
  const run = createJevRunner({ ...settings, fetch: async () => { calls++; return calls < 3 ? response({}, calls === 1 ? 429 : 529) : response(payload()); } });
  assert.deepEqual((await run(params)).answers, answers);
  assert.equal(calls, 3);
});

test('connection error is sanitized after the exact retry budget', async () => {
  let calls = 0;
  const run = createJevRunner({ ...settings, maxAttempts: 2, fetch: async () => { calls++; throw new Error('secret transport URL'); } });
  await assert.rejects(run(params), error => { assert.equal(error.code, 'connection'); assert.doesNotMatch(JSON.stringify(error) + String(error), /secret/); return true; });
  assert.equal(calls, 2);
});

test('pre-aborted call makes no requests and does not expose abort reason', async () => {
  let calls = 0;
  const run = createJevRunner({ ...settings, fetch: async () => { calls++; return response(payload()); } });
  await assert.rejects(run({ ...params, signal: AbortSignal.abort('secret cancellation') }), error => { assert.equal(error.code, 'aborted'); assert.doesNotMatch(String(error), /secret/); return true; });
  assert.equal(calls, 0);
});

test('abort during retry backoff returns promptly with no additional request', async () => {
  let calls = 0;
  const controller = new AbortController();
  const run = createJevRunner({ ...settings, retryBaseMs: 10_000, retryMaxMs: 10_000, fetch: async () => {
    calls++;
    setTimeout(() => controller.abort(), 30);
    return response({}, 503);
  } });
  const started = Date.now();
  await assert.rejects(run({ ...params, signal: controller.signal }), code('aborted'));
  assert.ok(Date.now() - started < 1000);
  assert.equal(calls, 1);
});

test('total deadline includes backoff and prevents another attempt', async () => {
  let calls = 0;
  const run = createJevRunner({ ...settings, timeoutMs: 40, retryBaseMs: 500, retryMaxMs: 500, fetch: async () => { calls++; return response({}, 503); } });
  await assert.rejects(run(params), code('timeout'));
  assert.equal(calls, 1);
});

test('total deadline bounds a custom client that ignores cancellation', async () => {
  let seen;
  const run = createJevRunner({ timeoutMs: 30, client: { systemOne: (_request, options) => { seen = options; return new Promise(() => {}); } } });
  await assert.rejects(run(params), code('timeout'));
  assert.equal(seen.signal.aborted, true);
  assert.equal(seen.retry.maxRetries, 0);
});

test('invalid state and configurations fail before network effects', async () => {
  let calls = 0;
  const run = createJevRunner({ ...settings, fetch: async () => { calls++; return response(payload()); } });
  const cyclic = {}; cyclic.self = cyclic;
  for (const state of [cyclic, 42]) await assert.rejects(run({ ...params, state }), code('invalid_request'));
  assert.equal(calls, 0);
  for (const options of [{ maxAttempts: 0 }, { maxAttempts: 11 }, { timeoutMs: NaN }, { retryBaseMs: -1 }, { pricing: { inputUsdPerMillionTokens: -1, outputUsdPerMillionTokens: 0 } }]) {
    assert.throws(() => createJevRunner({ ...settings, ...options }), code('configuration'));
  }
});

test('configured state-size diagnostics measure exact UTF-8 bytes without exposing state or sending HTTP', async () => {
  const maxStateBytes = 1024;
  let calls = 0;
  const run = createJevRunner({ maxStateBytes, client: { systemOne: async () => { calls++; return payload(); } } });
  await run({ ...params, state: 'x'.repeat(maxStateBytes - 2) });
  assert.equal(calls, 1, 'the exact boundary, including JSON quotes, is accepted');
  await run({ ...params, state: 'é'.repeat((maxStateBytes - 2) / 2) });
  assert.equal(calls, 2, 'the exact multibyte boundary is accepted');
  for (const state of ['x'.repeat(maxStateBytes - 1), 'é'.repeat((maxStateBytes - 2) / 2) + 'x',
    { evidence: 'private-source-sentinel' + 'é'.repeat(maxStateBytes / 2) }]) await assert.rejects(run({ ...params, state }), error => {
    assert.equal(error.code, 'invalid_request'); assert.equal(error.attempts, 0);
    assert.deepEqual(error.requestDiagnostic, { reason: 'state_too_large', label: 'test',
      stateBytes: Buffer.byteLength(JSON.stringify(state), 'utf8'), maxStateBytes });
    assert.match(error.message, /UTF-8 bytes.*configured host limit/);
    assert.doesNotMatch(JSON.stringify(error) + String(error), /private-source-sentinel|é/);
    return true;
  });
  assert.equal(calls, 2, 'oversize inputs make no additional HTTP requests');
  for (const [override, reason] of [[{ state: 42 }, 'invalid_state'], [{ questions: {} }, 'invalid_questions']]) {
    await assert.rejects(run({ ...params, ...override }), error => {
      assert.deepEqual(error.requestDiagnostic, { reason, label: 'test' }); assert.equal(error.attempts, 0); return true;
    });
  }
  assert.equal(calls, 2);
});

test('omitted, undefined and null state caps send large state and questions unchanged in one request', async () => {
  const state = { evidence: 'é'.repeat(40 * 1024), rows: ['fictional', 'original context'] };
  const largeQuestions = structuredClone(questions);
  largeQuestions.urgent.instructions += ' Full rubric.'.repeat(8 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(state), 'utf8') > 48 * 1024);
  for (const options of [{}, { maxStateBytes: undefined }, { maxStateBytes: null }]) {
    let calls = 0;
    const run = createJevRunner({ ...options, ...settings, fetch: async (_url, init) => {
      calls++;
      const sent = JSON.parse(init.body);
      assert.deepEqual(sent.state, state);
      assert.deepEqual(sent.questions, largeQuestions);
      return response(payload());
    } });
    assert.deepEqual((await run({ ...params, state, questions: largeQuestions })).answers, answers);
    assert.equal(calls, 1);
  }
});

test('host state caps accept all positive safe integers and do not estimate question tokens', async () => {
  for (const maxStateBytes of [1, 2, 64 * 1024, Number.MAX_SAFE_INTEGER]) {
    assert.doesNotThrow(() => createJevRunner({ maxStateBytes, client: { systemOne: async () => payload() } }));
  }
  const largeQuestions = structuredClone(questions);
  largeQuestions.urgent.instructions += ' Full rubric.'.repeat(8 * 1024);
  let calls = 0;
  const run = createJevRunner({ maxStateBytes: 2, client: { async systemOne(request) {
    calls++;
    assert.equal(request.state, '');
    assert.deepEqual(request.questions, largeQuestions);
    return payload();
  } } });
  await run({ ...params, state: '', questions: largeQuestions });
  assert.equal(calls, 1);
});

test('provider rejection of large state remains an HTTP error without splitting or retrying', async () => {
  const state = 'fictional source '.repeat(8 * 1024);
  let calls = 0;
  const run = createJevRunner({ ...settings, fetch: async (_url, init) => {
    calls++;
    assert.equal(JSON.parse(init.body).state, state);
    return response('private-provider-context-detail', 413);
  } });
  await assert.rejects(run({ ...params, state }), error => {
    assert.equal(error.code, 'http');
    assert.equal(error.status, 413);
    assert.equal(error.attempts, 1);
    assert.equal(error.requestDiagnostic, undefined);
    assert.doesNotMatch(JSON.stringify(error) + String(error), /private-provider-context-detail/);
    return true;
  });
  assert.equal(calls, 1);
});

test('invalid host state caps fail before transport without exposing option values', () => {
  let calls = 0;
  for (const maxStateBytes of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 'private-option-sentinel', false, {}]) {
    assert.throws(() => createJevRunner({ maxStateBytes, client: { async systemOne() { calls++; return payload(); } } }), error => {
      assert.equal(error.code, 'configuration');
      assert.equal(error.attempts, 0);
      assert.equal(error.message, 'maxStateBytes must be null or a positive safe integer.');
      assert.doesNotMatch(JSON.stringify(error) + String(error), /private-option-sentinel/);
      return true;
    });
  }
  assert.equal(calls, 0);
});

test('state is serialized once so the validated bytes are the state sent to the client', async () => {
  let serializations = 0, sent;
  const run = createJevRunner({ maxStateBytes: Buffer.byteLength(JSON.stringify({ fixture: 'one serialization' })),
    client: { systemOne: async request => { sent = request.state; return payload(); } } });
  await run({ ...params, state: { toJSON() { serializations++; return { fixture: 'one serialization' }; } } });
  assert.equal(serializations, 1); assert.deepEqual(sent, { fixture: 'one serialization' });
});

test('cancelling an active SDK request aborts transport without retry', async () => {
  const controller = new AbortController();
  let calls = 0;
  let transportSignal;
  const run = createJevRunner({ ...settings, signal: controller.signal, fetch: (_url, init) => {
    calls++;
    transportSignal = init.signal;
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('private cancelled request')), { once: true });
      setTimeout(() => controller.abort(), 20);
    });
  } });
  await assert.rejects(run({ ...params, state: 'x'.repeat(64 * 1024) }), code('aborted'));
  assert.equal(transportSignal.aborted, true);
  assert.equal(calls, 1);
});

test('total deadline aborts response-body streaming', async () => {
  let cancelled = false;
  const run = createJevRunner({ ...settings, timeoutMs: 30, fetch: async (_url, init) => {
    init.signal.addEventListener('abort', () => { cancelled = true; }, { once: true });
    return new Response(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode('{')); } }), { headers: { 'content-type': 'application/json' } });
  } });
  await assert.rejects(run(params), code('timeout'));
  assert.equal(cancelled, true);
});
