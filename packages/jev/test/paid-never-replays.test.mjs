// A Jev request is paid once it is sent, so the runner never sends it again unasked. It retries only a request that
// provably never reached Jev (no DNS answer, no connection, no TLS handshake) and a 429 that says when to retry. A 408, a
// 5xx or a connection lost after sending is sent once and fails outcome_unknown: it may have been answered and billed,
// and its cost stays unknown. retryAfterSend: true restores the retries, which can re-send a paid request.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createJevRunner, JevError } from '../dist/index.js';

const questions = { urgent: { type: 'noul', instructions: 'Is action urgent?' } };
const answers = { urgent: { type: 'noul', noul: 0.9 } };
const params = { label: 'test', kind: 'judge', state: { ticket: 'Invoice issue' }, questions };
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const answered = () => response({ model: 'jev-test', answers, usage: { input_tokens: 10, output_tokens: 1 } });
const settings = { apiKey: 'fake-test-key', baseURL: 'https://fake.invalid/gateway', retryBaseMs: 1, retryMaxMs: 2, maxAttempts: 3 };
const failedConnection = (code) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });
/** A fetch that answers each call with the next reply (the last repeats), counting the calls. */
function scripted(replies) {
  let calls = 0;
  const fetch = async () => { const reply = replies[Math.min(calls, replies.length - 1)]; calls++; return reply(); };
  return { fetch, calls: () => calls };
}

test('a 5xx, a 408 or a connection lost after sending is sent once, and is outcome_unknown', async () => {
  const afterSend = [
    ['HTTP 500', () => response({}, 500), 500],
    ['HTTP 503', () => response({}, 503, { 'retry-after': '0' }), 503],
    ['HTTP 529', () => response({}, 529), 529],
    ['HTTP 408', () => response({}, 408), 408],
    ['a lost connection', () => Promise.reject(failedConnection('ECONNRESET')), undefined],
  ];
  for (const [what, reply, status] of afterSend) {
    const t = scripted([reply, answered]);
    await assert.rejects(createJevRunner({ ...settings, fetch: t.fetch })(params), (error) => {
      assert.ok(error instanceof JevError, String(error));
      assert.deepEqual([error.code, error.status, error.attempts], ['outcome_unknown', status, 1], what);
      return true;
    });
    assert.equal(t.calls(), 1, `${what} was sent ${t.calls()} times`);
  }
});

test('a request that provably never reached Jev is retried', async () => {
  for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT']) {
    const t = scripted([() => Promise.reject(failedConnection(code)), answered]);
    assert.deepEqual((await createJevRunner({ ...settings, fetch: t.fetch })(params)).answers, answers, code);
    assert.equal(t.calls(), 2, code);
  }
});

test('a 429 is retried when it says when, and is refused at once without Retry-After', async () => {
  const told = scripted([() => response({}, 429, { 'retry-after': '0' }), answered]);
  assert.deepEqual((await createJevRunner({ ...settings, fetch: told.fetch })(params)).answers, answers);
  assert.equal(told.calls(), 2);
  const untold = scripted([() => response({}, 429), answered]);
  await assert.rejects(createJevRunner({ ...settings, fetch: untold.fetch })(params), (error) => {
    assert.deepEqual([error.code, error.status, error.attempts], ['http', 429, 1]);
    return true;
  });
  assert.equal(untold.calls(), 1);
});

test('retryAfterSend: true restores the retries after sending, which can re-send a paid request', async () => {
  const t = scripted([() => response({}, 503), () => Promise.reject(failedConnection('ECONNRESET')), answered]);
  assert.deepEqual((await createJevRunner({ ...settings, fetch: t.fetch, retryAfterSend: true })(params)).answers, answers);
  assert.equal(t.calls(), 3);
  const spent = scripted([() => response({}, 503)]);
  await assert.rejects(createJevRunner({ ...settings, fetch: spent.fetch, retryAfterSend: true })(params), (error) => {
    assert.deepEqual([error.code, error.status, error.attempts], ['http', 503, 3]);
    return true;
  });
});

test('a request that never reached Jev was not billed: after one, a give-up on 429s reports the 429', async () => {
  const t = scripted([() => Promise.reject(failedConnection('ECONNREFUSED')), () => response({}, 429, { 'retry-after': '0' }), () => response({}, 429, { 'retry-after': '0' })]);
  await assert.rejects(createJevRunner({ ...settings, fetch: t.fetch })(params), (error) => {
    assert.deepEqual([error.code, error.status, error.attempts], ['http', 429, 3], 'every attempt was refused or never sent: none may have been billed');
    return true;
  });
  assert.equal(t.calls(), 3);
});

test('a 5xx after sending that names max_tokens_exceeded keeps that reason and its guidance, on the default path', async () => {
  const t = scripted([() => response({ detail: { error_type: 'max_tokens_exceeded' } }, 503)]);
  await assert.rejects(createJevRunner({ ...settings, fetch: t.fetch })(params), (error) => {
    assert.deepEqual([error.code, error.status, error.attempts], ['outcome_unknown', 503, 1]);
    assert.deepEqual(error.responseDiagnostic, { reason: 'max_tokens_exceeded' });
    assert.match(error.message, /token budget/);
    assert.match(error.message, /Send fewer or shorter items per request/);
    return true;
  });
  assert.equal(t.calls(), 1);
});
