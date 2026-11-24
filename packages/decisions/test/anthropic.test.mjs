// A prompted Claude model (POST /v1/messages) as a DecisionProvider, on a fake fetch: the DSL's provider conformance
// suite, the request as sent (the System One request as the user message, a JSON schema for the answers, no sampling
// field), the answers read from the text block, the cost at Anthropic's published price, and its errors typed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DecisionProviderError } from '@parcha/agentrun-dsl';
import { registerDecisionProviderConformance } from '@parcha/agentrun-dsl/testing';
import { ANTHROPIC_PUBLISHED_PRICING, ANTHROPIC_SYSTEM, anthropicProvider } from '../dist/index.js';

const KEY = 'anthropic-canary-key-0123456789';
const settings = { apiKey: KEY, baseURL: 'https://fake.invalid', retryBaseMs: 1, retryMaxMs: 2, maxAttempts: 3 };
const ctx = (over = {}) => ({ decisionId: 'decision-1', signal: new AbortController().signal, deadlineMs: 5000, ...over });
const json = (body, status = 200, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const message = (text, extra = {}) => ({ id: 'msg_01', type: 'message', model: 'claude-haiku-5-5', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text }], usage: { input_tokens: 1000, output_tokens: 50 }, ...extra });
const code = (expected) => (error) => { assert.ok(error instanceof DecisionProviderError, String(error)); assert.equal(error.code, expected); return true; };
/** The DSL's answers as the model writes them: a noul's probability, a choice's probabilities by option. */
const wire = (answers) => Object.fromEntries(Object.entries(answers).map(([id, a]) => [id, a.type === 'noul' ? a.noul : a.probabilities]));
const QUESTIONS = { holds: { type: 'noul', instructions: 'Does it hold?', criteria: { true: 'it holds', false: 'it does not' } }, pick: { type: 'choice', instructions: 'Which fits?', criteria: { first: 'the first', second: null } } };
const request = { label: 'x', kind: 'judge', state: { claim: 'Widgets are registered in Delaware.' }, questions: QUESTIONS };

registerDecisionProviderConformance('anthropic', {
  canary: KEY, refuses: false,
  build(replies) {
    let calls = 0;
    const fetch = async (_url, init) => {
      const reply = replies[Math.min(calls, replies.length - 1)];
      calls++;
      if (reply.kind === 'hang') return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
      if (reply.kind === 'status') return json({ type: 'error', error: { type: 'api_error', message: 'refused' } }, reply.status);
      if (reply.kind === 'malformed') return json('{"content": [not json');
      if (reply.kind === 'lost') throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
      return json(message(JSON.stringify(wire(reply.answers))));
    };
    return { provider: anthropicProvider({ ...settings, fetch }), calls: () => calls };
  },
});

test('the request: POST /v1/messages, the key and API version as headers, the System One request as the user message, a schema for the answers, low effort, no sampling field', async () => {
  const seen = [];
  const fetch = async (url, init) => (seen.push({ url: String(url), init }), json(message(JSON.stringify({ holds: 0.9, pick: { first: 0.7, second: 0.3 } }))));
  await anthropicProvider({ ...settings, fetch }).decide(request, ctx());
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://fake.invalid/v1/messages');
  const headers = new Headers(seen[0].init.headers);
  assert.deepEqual([headers.get('x-api-key'), headers.get('anthropic-version'), headers.get('content-type')], [KEY, '2023-06-01', 'application/json']);
  assert.deepEqual(JSON.parse(seen[0].init.body), {
    model: 'claude-haiku-5-5',
    max_tokens: 8192,
    system: ANTHROPIC_SYSTEM,
    messages: [{ role: 'user', content: JSON.stringify({ state: request.state, questions: QUESTIONS }) }],
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: {
        type: 'object', additionalProperties: false, required: ['holds', 'pick'],
        properties: { holds: { type: 'number' }, pick: { type: 'object', additionalProperties: false, required: ['first', 'second'], properties: { first: { type: 'number' }, second: { type: 'number' } } } },
      } },
    },
  });
});

test('the system prompt states the task and nothing of web search: the questions carry their own words', () => {
  assert.match(ANTHROPIC_SYSTEM, /decision model/);
  assert.match(ANTHROPIC_SYSTEM, /probability, from 0 to 1, that its answer is true/);
  assert.doesNotMatch(ANTHROPIC_SYSTEM, /search|passage|result/i);
});

test('answers are read from the text block by type: a noul its probability, a choice the likeliest option with its probabilities; the cost at the published price, an estimate', async () => {
  const fetch = async () => json(message(JSON.stringify({ holds: 0.9, pick: { first: 0.2, second: 0.8 } })));
  const outcome = await anthropicProvider({ ...settings, fetch }).decide(request, ctx());
  assert.deepEqual(outcome.answers, { holds: { type: 'noul', noul: 0.9 }, pick: { type: 'choice', choice: 'second', probabilities: { first: 0.2, second: 0.8 } } });
  assert.deepEqual([outcome.model, outcome.usage, outcome.provider_request_id, outcome.evidence], ['claude-haiku-5-5', { input_tokens: 1000, output_tokens: 50 }, 'msg_01', []]);
  const price = ANTHROPIC_PUBLISHED_PRICING['claude-haiku-5-5'];
  assert.deepEqual(price, { inputUsdPerMillionTokens: 0.1, outputUsdPerMillionTokens: 0.5, longPromptTokens: 100_000, longInputUsdPerMillionTokens: 0.5, longOutputUsdPerMillionTokens: 2.5 });
  assert.equal(outcome.cost_usd, (1000 * 0.1 + 50 * 0.5) / 1e6);
  assert.equal(outcome.cost_basis, 'estimate');
});

test('a prompt over 100,000 tokens is priced at the long rates; a model with no published price here costs null (unknown), unless the host prices it', async () => {
  const long = async () => json(message(JSON.stringify({ holds: 0.5, pick: { first: 0.5, second: 0.5 } }), { usage: { input_tokens: 200_000, output_tokens: 100 } }));
  const outcome = await anthropicProvider({ ...settings, fetch: long }).decide(request, ctx());
  assert.equal(outcome.cost_usd, (200_000 * 0.5 + 100 * 2.5) / 1e6);
  const other = await anthropicProvider({ ...settings, model: 'claude-sonnet-5-5', fetch: long }).decide(request, ctx());
  assert.deepEqual([other.cost_usd, other.cost_basis], [null, 'unknown']);
  const priced = await anthropicProvider({ ...settings, model: 'claude-sonnet-5-5', pricing: { inputUsdPerMillionTokens: 2, outputUsdPerMillionTokens: 10 }, fetch: long }).decide(request, ctx());
  assert.equal(priced.cost_usd, (200_000 * 2 + 100 * 10) / 1e6);
});

test('a refusal (stop_reason refusal) refuses every question, and is booked', async () => {
  const fetch = async () => json({ ...message(''), stop_reason: 'refusal', content: [] });
  const outcome = await anthropicProvider({ ...settings, fetch }).decide(request, ctx());
  assert.deepEqual(outcome.answers, { holds: { type: 'refusal' }, pick: { type: 'refusal' } });
  assert.equal(outcome.cost_basis, 'estimate');
});

test('an answer cut at max_tokens, one that is no JSON, a probability out of range or a missing answer is invalid_response, booked at its cost', async () => {
  for (const body of [
    { ...message('{"holds": 0.'), stop_reason: 'max_tokens' },
    message('not json'),
    message(JSON.stringify({ holds: 1.5, pick: { first: 0.5, second: 0.5 } })),
    message(JSON.stringify({ holds: 0.5 })),
    message(JSON.stringify({ holds: 0.5, pick: { first: 0, second: 0 } })),
  ]) {
    const error = await anthropicProvider({ ...settings, fetch: async () => json(body) }).decide(request, ctx()).then(() => null, (e) => e);
    assert.ok(code('invalid_response')(error), JSON.stringify(body));
    assert.deepEqual([error.costUsd, error.costBasis], [(1000 * 0.1 + 50 * 0.5) / 1e6, 'estimate']);
  }
});

test('the key and root come from ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL when not given, read when a request is made; no key is a configuration error before anything is sent', async (t) => {
  const saved = { key: process.env.ANTHROPIC_API_KEY, base: process.env.ANTHROPIC_BASE_URL };
  t.after(() => { for (const [name, value] of [['ANTHROPIC_API_KEY', saved.key], ['ANTHROPIC_BASE_URL', saved.base]]) value === undefined ? delete process.env[name] : (process.env[name] = value); });
  const seen = [];
  const fetch = async (url, init) => (seen.push({ url: String(url), key: new Headers(init.headers).get('x-api-key') }), json(message(JSON.stringify({ holds: 0.5, pick: { first: 0.5, second: 0.5 } }))));
  const provider = anthropicProvider({ fetch });
  assert.deepEqual(provider.needs, ['ANTHROPIC_API_KEY']);
  delete process.env.ANTHROPIC_API_KEY;
  await assert.rejects(provider.decide(request, ctx()), code('configuration'));
  assert.equal(seen.length, 0);
  process.env.ANTHROPIC_API_KEY = KEY;
  process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9/';
  await provider.decide(request, ctx());
  assert.deepEqual(seen, [{ url: 'http://127.0.0.1:9/v1/messages', key: KEY }]);
});
