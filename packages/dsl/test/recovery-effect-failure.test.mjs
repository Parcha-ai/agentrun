// Typed failure codes at an effect boundary: the classifier maps a thrown error to a code from the typed facts it
// carries, fed messages that would mislead a text match.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EffectFailure, EFFECT_FAILURE_CODES } from '@parcha/agentrun-dsl';
import { EffectEnvelopeFailure, TypedEffectFailure, classifyEffectFailure, effectRetryClass, transportFactOf } from '@parcha/agentrun-dsl/recovery';

const at = { label: 'lookup', via: 'tool' };

test('classifyEffectFailure reads typed facts, never the message', () => {
  // A fetch abort whose message reads like a 503 and a reset connection.
  const aborted = classifyEffectFailure(new DOMException('HTTP 503 ECONNRESET connection refused', 'AbortError'), at);
  assert.equal(aborted.code, 'effect_timeout');
  // A failure envelope whose text names a timeout and a 429.
  const envelope = classifyEffectFailure(new EffectEnvelopeFailure('registry:lookup', '{"ok":false,"error":"timeout after 429 Too Many Requests"}'), at);
  assert.deepEqual([envelope.code, envelope.retryClass], ['effect_transport', null]);
  // An unknown transport: a via outside the interpreter's list, whatever the error says.
  const unknown = classifyEffectFailure(Object.assign(new Error('ok'), { transport: { status: 503 } }), { label: 'lookup', via: 'carrier-pigeon' });
  assert.deepEqual([unknown.code, unknown.detail], ['effect_unknown_transport', { transport: 'carrier-pigeon' }]);
  // No typed fact: a message full of transport words earns nothing.
  const untyped = classifyEffectFailure(new Error('request timed out: HTTP 504 gateway timeout, socket hang up'), at);
  assert.deepEqual([untyped.code, untyped.retryClass], ['effect_unknown_transport', null]);
  // A typed 503 with a reassuring message is still a transport failure, retryable as a 5xx.
  const typed = classifyEffectFailure(Object.assign(new Error('everything is fine'), { transport: { status: 503 } }), at);
  assert.deepEqual([typed.code, typed.retryClass], ['effect_transport', 'http_5xx']);
  for (const failure of [aborted, envelope, unknown, untyped, typed]) {
    assert.ok(failure instanceof TypedEffectFailure && failure instanceof EffectFailure);
    assert.ok(EFFECT_FAILURE_CODES.includes(failure.code));
    assert.match(failure.message, /^call node "lookup": /);
  }
});

test('a failure already typed passes through; a tool the host did not grant is named by the host', () => {
  const typed = new TypedEffectFailure('effect_exit', 'exit 7', { detail: { exit: 7 } });
  assert.equal(classifyEffectFailure(typed, at), typed);
  class NotGranted extends Error { constructor(tool) { super(`tool ${tool} is not granted`); this.tool = tool; } }
  const notGranted = (error) => error instanceof NotGranted ? error.tool : undefined;
  const refused = classifyEffectFailure(new NotGranted('registry:secret'), at, { notGranted });
  assert.deepEqual([refused.code, refused.detail, refused.retryClass], ['effect_not_granted', { tool: 'registry:secret' }, null]);
  assert.equal(classifyEffectFailure(new Error('not granted, says the text'), at, { notGranted }).code, 'effect_unknown_transport');
});

test('a code implies a retry class only for a deadline and a non-zero exit, unless the transport named one', () => {
  assert.deepEqual(['effect_timeout', 'effect_exit', 'effect_transport', 'effect_not_granted'].map((code) => new TypedEffectFailure(code, 'x').retryClass), ['timeout', 'exit', null, null]);
  assert.equal(new TypedEffectFailure('effect_transport', 'x', { retryClass: 'http_429' }).retryClass, 'http_429');
  assert.equal(new TypedEffectFailure('effect_timeout', 'x', { retryClass: null }).retryClass, null);
});

test('transport facts come from typed fields along the cause chain, the first value found for each', () => {
  const cause = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  const error = Object.assign(new TypeError('fetch failed', { cause }), { status: 502 });
  assert.deepEqual(transportFactOf(error), { errorName: 'TypeError', causeCode: 'ECONNRESET', status: 502 });
  assert.deepEqual(transportFactOf(Object.assign(new Error('x'), { transport: { status: 429, idle: 'body' }, status: 500 })), { status: 429, idle: 'body' });
  assert.deepEqual([{ status: 408 }, { idle: 'headers' }, { errorName: 'TimeoutError' }, { causeCode: 'UND_ERR_HEADERS_TIMEOUT' }, { status: 429 }, { status: 503 }, { causeCode: 'ECONNREFUSED' }, { status: 404 }, {}].map(effectRetryClass),
    ['timeout', 'timeout', 'timeout', 'timeout', 'http_429', 'http_5xx', 'connection', null, null]);
});
