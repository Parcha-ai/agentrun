// Jev as a DecisionProvider: jevProvider wraps createJevRunner, and passes the DSL's provider conformance suite over a
// fake fetch that answers as System One does. Jev's wire format has no refusal, so that rule is skipped for it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { registerDecisionProviderConformance } from '@parcha/agentrun-dsl/testing';
import { jevProvider } from '../dist/index.js';

const KEY = 'jev-canary-key-0123456789';
const json = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function build(replies) {
  let calls = 0;
  const fetch = async (_url, init) => {
    const reply = replies[Math.min(calls, replies.length - 1)];
    calls++;
    if (reply.kind === 'hang') return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal.reason ?? new DOMException('aborted', 'AbortError')), { once: true }));
    if (reply.kind === 'status') return json({ error: { message: 'refused' } }, reply.status);
    if (reply.kind === 'malformed') return json('{"answers": [not json');
    if (reply.kind === 'lost') throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
    return json({ model: 'jev-test', answers: reply.answers, usage: { input_tokens: 12, output_tokens: 3 } });
  };
  return { provider: jevProvider({ apiKey: KEY, baseURL: 'https://fake.invalid/gateway', fetch, retryBaseMs: 1, retryMaxMs: 2, maxAttempts: 3, maxStateBytes: 4096 }), calls: () => calls };
}

registerDecisionProviderConformance('jev', { canary: KEY, refuses: false, build });

test('jevProvider declares what Jev answers, and the key it reads by name', () => {
  const provider = jevProvider({ apiKey: KEY, baseURL: 'https://fake.invalid/gateway' });
  assert.equal(provider.id, 'jev');
  assert.deepEqual(provider.needs, ['TYPESAFE_API_KEY']);
  assert.deepEqual(provider.capabilities.types, ['noul', 'choice', 'score', 'box']);
  assert.deepEqual([provider.capabilities.evidence, provider.capabilities.probability, provider.capabilities.grounding, provider.capabilities.replay], ['none', 'model', false, 'never']);
  assert.deepEqual(jevProvider({ provider: 'openrouter', apiKey: KEY }).needs, ['OPENROUTER_API_KEY']);
});

test('a Jev request in flight past the runner\'s own timeout is outcome_unknown at an unknown cost; the host\'s cancel stays aborted', async () => {
  const hang = (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason ?? new DOMException('aborted', 'AbortError')), { once: true }));
  const questions = { holds: { type: 'noul', instructions: 'Does it hold?' } };
  const timed = jevProvider({ apiKey: KEY, baseURL: 'https://fake.invalid/gateway', fetch: hang, timeoutMs: 50 });
  await assert.rejects(timed.decide({ label: 'x', kind: 'judge', state: {}, questions }, { decisionId: 'd', signal: new AbortController().signal, deadlineMs: null }), (error) => {
    assert.deepEqual([error.code, error.costUsd, error.costBasis], ['outcome_unknown', null, 'unknown']);
    return true;
  });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(jevProvider({ apiKey: KEY, baseURL: 'https://fake.invalid/gateway', fetch: hang }).decide({ label: 'x', kind: 'judge', state: {}, questions }, { decisionId: 'd', signal: controller.signal, deadlineMs: 10_000 }), (error) => error.code === 'aborted');
});

test('a cost Jev reports, or one priced from the configured estimate, is booked with its basis', async () => {
  const questions = { holds: { type: 'noul', instructions: 'Does it hold?' } };
  const answers = { holds: { type: 'noul', noul: 0.9 } };
  const reported = jevProvider({ apiKey: KEY, baseURL: 'https://fake.invalid/gateway', fetch: async () => json({ model: 'jev-test', answers, usage: { input_tokens: 1000, output_tokens: 0, cost: 0.002 } }) });
  const priced = jevProvider({ apiKey: KEY, baseURL: 'https://fake.invalid/gateway', pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 }, fetch: async () => json({ model: 'jev-test', answers, usage: { input_tokens: 1000, output_tokens: 0 } }) });
  const ctx = { decisionId: 'd', signal: new AbortController().signal, deadlineMs: 5000 };
  const a = await reported.decide({ label: 'x', kind: 'judge', state: {}, questions }, ctx);
  const b = await priced.decide({ label: 'x', kind: 'judge', state: {}, questions }, ctx);
  assert.deepEqual([a.cost_usd, a.cost_basis], [0.002, 'reported']);
  assert.deepEqual([b.cost_usd, b.cost_basis], [0.001, 'estimate']);
});
