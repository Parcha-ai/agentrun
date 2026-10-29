// Parallel Decisions as a DecisionProvider, on a fake fetch: the DSL's provider conformance suite, the 28 recorded
// responses replayed through the seam, the request as sent, Parallel's limits checked before sending, and its errors typed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DecisionProviderError, judgeFromProvider, validateAnswers } from '@parcha/agentrun-dsl';
import { registerDecisionProviderConformance } from '@parcha/agentrun-dsl/testing';
import { parallelProvider, PARALLEL_LIST_PRICE_USD } from '../dist/index.js';

const KEY = 'parallel-canary-key-0123456789';
const { responses } = JSON.parse(readFileSync(new URL('./fixtures/parallel-responses.json', import.meta.url), 'utf8'));
const json = (body, status = 200, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const wire = (answers, evidence = []) => ({ mode: 'fast', answers, citations: evidence.map(({ url, title, excerpts }) => ({ url, title, excerpts })), usage: { input_tokens: 120, output_tokens: 0 }, decision_id: 'decisions_0123456789abcdef0123456789abcdef' });
const settings = { apiKey: KEY, baseURL: 'https://fake.invalid', retryBaseMs: 1, retryMaxMs: 2, maxAttempts: 3 };
const ctx = (over = {}) => ({ decisionId: 'decision-1', signal: new AbortController().signal, deadlineMs: 5000, ...over });
const code = (expected) => (error) => { assert.ok(error instanceof DecisionProviderError, String(error)); assert.equal(error.code, expected); return true; };
/** A fetch that answers each call with the next of `replies` (the last repeats), and the requests it saw. */
function fakeFetch(replies) {
  const seen = [];
  const fetch = async (url, init) => {
    const reply = replies[Math.min(seen.length, replies.length - 1)];
    seen.push({ url: String(url), init });
    return typeof reply === 'function' ? reply(init) : reply;
  };
  return { fetch, seen };
}

registerDecisionProviderConformance('parallel', {
  canary: KEY, refuses: true,
  build(replies) {
    let calls = 0;
    const fetch = async (_url, init) => {
      const reply = replies[Math.min(calls, replies.length - 1)];
      calls++;
      if (reply.kind === 'hang') return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
      if (reply.kind === 'status') return json({ type: 'error', error: { ref_id: 'ref-1', message: 'refused' } }, reply.status);
      if (reply.kind === 'malformed') return json('{"answers": [not json');
      return json(wire(reply.answers, reply.evidence));
    };
    return { provider: parallelProvider({ ...settings, fetch }), calls: () => calls };
  },
});

test('every recorded response replays through the seam: valid answers, every citation as evidence, booked at list price', async () => {
  assert.equal(responses.length, 28);
  for (const { name, questions, response } of responses) {
    const { fetch } = fakeFetch([json(response)]);
    const result = await judgeFromProvider(parallelProvider({ ...settings, fetch }))({ label: name, kind: 'judge', state: { case: name }, questions, decisionId: name });
    validateAnswers(questions, result.answers);
    for (const [id, answer] of Object.entries(response.answers)) {
      if (answer.type === 'noul') assert.equal(result.answers[id].noul, answer.noul, `${name} ${id}`);
      else assert.deepEqual([result.answers[id].choice, result.answers[id].confidence], [answer.choice, answer.confidence], `${name} ${id}`);
    }
    assert.equal(result.evidence.length, response.citations.length, name);
    assert.ok(result.evidence.every((e) => e.scope === 'call'), name);
    assert.equal(result.provider_request_id, response.decision_id);
    assert.deepEqual([result.cost_usd, result.cost_basis, result.usage], [PARALLEL_LIST_PRICE_USD, 'estimate', { input_tokens: response.usage.input_tokens, output_tokens: 0 }], name);
  }
});

test('a choice with no confidence gets one derived, and its source says so', async () => {
  const { questions, response } = responses.find((r) => Object.values(r.response.answers).some((a) => a.type === 'choice'));
  const stripped = structuredClone(response);
  for (const answer of Object.values(stripped.answers)) delete answer.confidence;
  const { fetch } = fakeFetch([json(stripped)]);
  const result = await judgeFromProvider(parallelProvider({ ...settings, fetch }))({ label: 'x', kind: 'judge', state: {}, questions });
  for (const [id, answer] of Object.entries(stripped.answers)) {
    if (answer.type !== 'choice') continue;
    const n = Object.keys(answer.probabilities).length;
    const expected = Math.max(0, (answer.probabilities[answer.choice] - 1 / n) / (1 - 1 / n));
    assert.ok(Math.abs(result.answers[id].confidence - expected) < 1e-9, id);
    assert.equal(result.confidence_source[id], 'derived');
  }
});

test('the request is POST /v1/decisions with the key in x-api-key, the questions as asked (an option with no description named by itself) and the excerpts on', async () => {
  const questions = { holds: { type: 'noul', instructions: 'Does it hold?', criteria: { true: 'yes', false: 'no' } }, pick: { type: 'choice', instructions: 'Which?', criteria: { a: 'first', b: null } } };
  const { fetch, seen } = fakeFetch([json(wire({ holds: { type: 'noul', noul: 0.7 }, pick: { type: 'choice', choice: 'a', probabilities: { a: 0.6, b: 0.4 } } }))]);
  await parallelProvider({ apiKey: KEY, fetch }).decide({ label: 'x', kind: 'judge', state: { company: 'Example Ltd' }, questions }, ctx());
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://api.parallel.ai/v1/decisions');
  assert.equal(seen[0].init.method, 'POST');
  assert.equal(new Headers(seen[0].init.headers).get('x-api-key'), KEY);
  assert.deepEqual(JSON.parse(seen[0].init.body), { mode: 'fast', state: { company: 'Example Ltd' }, questions: { holds: questions.holds, pick: { type: 'choice', instructions: 'Which?', criteria: { a: 'first', b: 'b' } } }, include_excerpts: true });
});

test("Parallel's limits are checked before anything is sent", async () => {
  const { fetch, seen } = fakeFetch([json(wire({}))]);
  const provider = parallelProvider({ ...settings, fetch });
  const noul = (i) => [`q${i}`, { type: 'noul', instructions: `Question ${i}?` }];
  const over = [
    Object.fromEntries(Array.from({ length: 101 }, (_, i) => noul(i))),
    { pick: { type: 'choice', instructions: 'Which?', criteria: Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`o${i}`, null])) } },
    { level: { type: 'score', instructions: 'How much?', criteria: Array.from({ length: 11 }, (_, i) => `level ${i}`) } },
    { long: { type: 'noul', instructions: 'x'.repeat(5001) } },
  ];
  for (const questions of over) await assert.rejects(provider.decide({ label: 'x', kind: 'judge', state: {}, questions }, ctx()), code('invalid_request'));
  assert.equal(seen.length, 0);
});

test('a 422 keeps the reference Parallel gives it and drops the body', async () => {
  const { fetch } = fakeFetch([json({ type: 'error', error: { ref_id: 'ref-42', message: 'state contains private-detail-xyz' } }, 422)]);
  await assert.rejects(parallelProvider({ ...settings, fetch }).decide({ label: 'x', kind: 'judge', state: {}, questions: { holds: { type: 'noul', instructions: 'Q?' } } }, ctx()), (error) => {
    code('invalid_request')(error);
    assert.equal(error.status, 422);
    assert.equal(error.refId, 'ref-42');
    assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`, /private-detail-xyz/);
    return true;
  });
});

test('a 429 is retried after its Retry-After, and the answer that follows is the result', async () => {
  const { fetch, seen } = fakeFetch([json({ type: 'error', error: {} }, 429, { 'retry-after': '0' }), json(wire({ holds: { type: 'noul', noul: 0.4 } }))]);
  const result = await parallelProvider({ ...settings, fetch }).decide({ label: 'x', kind: 'judge', state: {}, questions: { holds: { type: 'noul', instructions: 'Q?' } } }, ctx());
  assert.equal(seen.length, 2);
  assert.equal(result.answers.holds.noul, 0.4);
});

test('every attempt that may have been billed is booked: a 503 or a lost connection before the answer books two, a 429 one', async () => {
  const questions = { holds: { type: 'noul', instructions: 'Q?' } };
  const answer = () => json(wire({ holds: { type: 'noul', noul: 0.4 } }));
  const decideAfter = async (first) => {
    const { fetch, seen } = fakeFetch([first, answer()]);
    const result = await parallelProvider({ ...settings, fetch }).decide({ label: 'x', kind: 'judge', state: {}, questions }, ctx());
    assert.equal(seen.length, 2);
    return result;
  };
  const after503 = await decideAfter(json({ type: 'error', error: {} }, 503));
  assert.deepEqual([after503.cost_usd, after503.cost_basis], [2 * PARALLEL_LIST_PRICE_USD, 'estimate']);
  const afterLost = await decideAfter(() => Promise.reject(new TypeError('fetch failed')));
  assert.deepEqual([afterLost.cost_usd, afterLost.cost_basis], [2 * PARALLEL_LIST_PRICE_USD, 'estimate']);
  const after429 = await decideAfter(json({ type: 'error', error: {} }, 429, { 'retry-after': '0' }));
  assert.deepEqual([after429.cost_usd, after429.cost_basis], [PARALLEL_LIST_PRICE_USD, 'estimate']);
});

test('with no key, the request is refused naming the variable, and nothing is sent', async () => {
  const { fetch, seen } = fakeFetch([json(wire({}))]);
  const saved = process.env.PARALLEL_API_KEY;
  delete process.env.PARALLEL_API_KEY;
  try {
    await assert.rejects(parallelProvider({ fetch }).decide({ label: 'x', kind: 'judge', state: {}, questions: { holds: { type: 'noul', instructions: 'Q?' } } }, ctx()), (error) => {
      code('configuration')(error);
      assert.match(error.message, /PARALLEL_API_KEY/);
      return true;
    });
  } finally { if (saved !== undefined) process.env.PARALLEL_API_KEY = saved; }
  assert.equal(seen.length, 0);
});

test('the key is read from PARALLEL_API_KEY when none is passed', async () => {
  const { fetch, seen } = fakeFetch([json(wire({ holds: { type: 'noul', noul: 0.9 } }))]);
  const saved = process.env.PARALLEL_API_KEY;
  process.env.PARALLEL_API_KEY = KEY;
  try { await parallelProvider({ fetch }).decide({ label: 'x', kind: 'judge', state: {}, questions: { holds: { type: 'noul', instructions: 'Q?' } } }, ctx()); }
  finally { if (saved === undefined) delete process.env.PARALLEL_API_KEY; else process.env.PARALLEL_API_KEY = saved; }
  assert.equal(new Headers(seen[0].init.headers).get('x-api-key'), KEY);
});

test('parallelProvider declares what Parallel answers, and the key it reads by name', () => {
  const { id, needs, capabilities } = parallelProvider({ apiKey: KEY });
  assert.equal(id, 'parallel');
  assert.deepEqual(needs, ['PARALLEL_API_KEY']);
  assert.deepEqual(capabilities, { types: ['noul', 'choice', 'score'], inputs: ['text', 'json', 'url'], evidence: 'citations', probability: 'model', grounding: true, replay: 'never', maxQuestions: 100, maxStateBytes: 96_000 });
});
