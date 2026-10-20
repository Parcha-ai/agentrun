import assert from 'node:assert/strict';
import test from 'node:test';
import { createJevRunner, JevError } from '../dist/index.js';

const questions = { urgent: { type: 'noul', instructions: 'Is action urgent?' } };
const answers = { urgent: { type: 'noul', noul: 0.9 } };
const params = { label: 'test', kind: 'judge', state: { ticket: 'Invoice issue' }, questions };
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const settings = { apiKey: 'fake-test-key', baseURL: 'https://fake.invalid/gateway', retryBaseMs: 10, retryMaxMs: 20 };
// Each fetch is answered by the next entry; the time of every call is kept.
const scripted = answersInOrder => {
  const calls = [];
  return { calls, fetch: async () => { calls.push(Date.now()); return answersInOrder[Math.min(calls.length, answersInOrder.length) - 1](); } };
};
const gaps = calls => calls.slice(1).map((at, index) => at - calls[index]);

test('a 429 with Retry-After in seconds waits that long, past the backoff, then succeeds', async () => {
  const t = scripted([() => response({}, 429, { 'retry-after': '1' }), () => response({ answers })]);
  const result = await createJevRunner({ ...settings, fetch: t.fetch })(params);
  assert.deepEqual(result.answers, answers);
  assert.equal(t.calls.length, 2);
  assert.ok(gaps(t.calls)[0] >= 1000, `waited ${gaps(t.calls)[0]} ms, not the 1000 ms Retry-After asked for`);
});

test('a persistent 429 waits Retry-After before every retry and gives up as today at maxAttempts', async () => {
  const t = scripted([() => response({}, 429, { 'retry-after': '1' })]);
  await assert.rejects(createJevRunner({ ...settings, maxAttempts: 3, fetch: t.fetch })(params), error => {
    assert.ok(error instanceof JevError);
    assert.equal(error.code, 'http');
    assert.equal(error.status, 429);
    assert.equal(error.attempts, 3);
    assert.equal(error.message, 'Jev returned HTTP 429.');
    return true;
  });
  assert.equal(t.calls.length, 3);
  for (const gap of gaps(t.calls)) assert.ok(gap >= 1000, `waited ${gap} ms, not the 1000 ms Retry-After asked for`);
});

test('a Retry-After longer than the time left gives up at once without sleeping', async () => {
  const t = scripted([() => response({}, 429, { 'retry-after': '120' }), () => response({ answers })]);
  const started = Date.now();
  await assert.rejects(createJevRunner({ ...settings, timeoutMs: 2000, fetch: t.fetch })(params), error => {
    assert.ok(error instanceof JevError);
    assert.equal(error.code, 'http');
    assert.equal(error.status, 429);
    assert.equal(error.attempts, 1);
    return true;
  });
  const took = Date.now() - started;
  assert.ok(took < 1500, `took ${took} ms`);
  assert.equal(t.calls.length, 1, 'no retry was sent after a wait that could not fit');
});

test('a Retry-After that fits, under a backoff that does not, gives up at once: no retry is sent with no time left', async () => {
  const t = scripted([() => response({}, 429, { 'retry-after': '0' }), () => response({ answers })]);
  const started = Date.now();
  await assert.rejects(createJevRunner({ ...settings, timeoutMs: 900, retryBaseMs: 1000, retryMaxMs: 1000, fetch: t.fetch })(params), error => {
    assert.ok(error instanceof JevError);
    assert.equal(error.code, 'http');
    assert.equal(error.status, 429);
    assert.equal(error.attempts, 1);
    return true;
  });
  assert.ok(Date.now() - started < 800, 'it did not sleep the backoff past the deadline');
  assert.equal(t.calls.length, 1, 'exactly one call');
});

test('a give-up reports 429 only when no earlier attempt may have been billed: after a 503 or a lost answer, it names that one', async () => {
  const mixed = scripted([() => response({}, 503), () => response({}, 429), () => response({}, 429)]);
  await assert.rejects(createJevRunner({ ...settings, maxAttempts: 3, fetch: mixed.fetch })(params), error => {
    assert.ok(error instanceof JevError);
    assert.deepEqual([error.code, error.status, error.attempts], ['http', 503, 3], 'a 503 may have been billed: the cost stays unknown');
    return true;
  });
  let calls = 0;
  const lost = async () => { calls += 1; if (calls === 1) throw new TypeError('socket hang up'); return response({}, 429); };
  await assert.rejects(createJevRunner({ ...settings, maxAttempts: 2, fetch: lost })(params), error => {
    assert.ok(error instanceof JevError);
    assert.deepEqual([error.code, error.status, error.attempts], ['connection', undefined, 2], 'a lost answer may have been billed');
    return true;
  });
  const only = scripted([() => response({}, 429)]);
  await assert.rejects(createJevRunner({ ...settings, maxAttempts: 2, fetch: only.fetch })(params), error => error instanceof JevError && error.code === 'http' && error.status === 429, 'every attempt refused: 429');
});

test('a 503 with Retry-After as an HTTP date waits until that date', async () => {
  const t = scripted([() => response({}, 503, { 'retry-after': new Date(Date.now() + 2000).toUTCString() }), () => response({ answers })]);
  const result = await createJevRunner({ ...settings, fetch: t.fetch })(params);
  assert.deepEqual(result.answers, answers);
  assert.ok(gaps(t.calls)[0] >= 900, `waited ${gaps(t.calls)[0]} ms for a date at least 1000 ms ahead`);
});

test('an unusable Retry-After, or one on 408 and other 5xx, keeps the backoff', async () => {
  for (const [status, value] of [[429, ''], [429, 'soon'], [503, '1.5'], [500, '120'], [502, '120'], [408, '120']]) {
    const t = scripted([() => response({}, status, { 'retry-after': value }), () => response({ answers })]);
    const started = Date.now();
    const result = await createJevRunner({ ...settings, timeoutMs: 2000, fetch: t.fetch })(params);
    assert.deepEqual(result.answers, answers);
    assert.equal(t.calls.length, 2, `${status} with Retry-After ${JSON.stringify(value)} retries`);
    assert.ok(Date.now() - started < 500, `${status} with Retry-After ${JSON.stringify(value)} waits only the backoff`);
  }
});
