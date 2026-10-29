// Parallel Decisions as a DecisionProvider, on a fake fetch: the DSL's provider conformance suite, the 28 recorded
// responses replayed through the seam, the request as sent, Parallel's limits checked before sending, and its errors typed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DecisionProviderError, judgeFromProvider, runWorkflow, validateAnswers } from '@parcha/agentrun-dsl';
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
      if (reply.kind === 'lost') throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
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

test('a question named __proto__ round-trips through Parallel and the seam, and is accepted', async () => {
  const questions = JSON.parse('{"__proto__": {"type": "choice", "instructions": "Which?", "criteria": {"a": "first", "b": "second"}}}');
  const answers = JSON.parse('{"__proto__": {"type": "choice", "choice": "b", "probabilities": {"a": 0.2, "b": 0.8}}}');
  const { fetch, seen } = fakeFetch([json(wire(answers))]);
  const result = await judgeFromProvider(parallelProvider({ ...settings, fetch }))({ label: 'x', kind: 'judge', state: {}, questions });
  assert.ok(Object.hasOwn(JSON.parse(seen[0].init.body).questions, '__proto__'), 'the question was sent under its own name');
  assert.ok(Object.hasOwn(result.answers, '__proto__'));
  assert.equal(result.answers.__proto__.choice, 'b');
  validateAnswers(questions, result.answers);
});

test('a connection that drops after the 200 headers, before the body ends, is outcome_unknown at list price; a whole body that does not parse is invalid_response', async () => {
  const questions = { holds: { type: 'noul', instructions: 'Q?' } };
  const dropped = () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"mode": "fast", "answers": {"hol'));
    controller.error(Object.assign(new TypeError('terminated'), { cause: Object.assign(new Error('other side closed'), { code: 'ECONNRESET' }) }));
  } }), { status: 200, headers: { 'content-type': 'application/json' } });
  const lost = fakeFetch([dropped]);
  await assert.rejects(parallelProvider({ ...settings, fetch: lost.fetch }).decide({ label: 'x', kind: 'judge', state: {}, questions }, ctx()), (error) => {
    code('outcome_unknown')(error);
    assert.deepEqual([error.costUsd, error.costBasis], [PARALLEL_LIST_PRICE_USD, 'estimate']);
    return true;
  });
  assert.equal(lost.seen.length, 1);
  const malformed = fakeFetch([json('{"mode": "fast", "answers": [not json')]);
  await assert.rejects(parallelProvider({ ...settings, fetch: malformed.fetch }).decide({ label: 'x', kind: 'judge', state: {}, questions }, ctx()), code('invalid_response'));
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

test('a 5xx, a 408 or a connection lost after sending is sent once, booked at list price as an estimate, and is outcome_unknown', async () => {
  const questions = { holds: { type: 'noul', instructions: 'Q?' } };
  const afterSend = [
    ['a 503', () => json({ type: 'error', error: {} }, 503)],
    ['a 500', () => json({ type: 'error', error: {} }, 500)],
    ['a 408', () => json({ type: 'error', error: {} }, 408)],
    ['a lost connection', () => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) }))],
  ];
  for (const [what, reply] of afterSend) {
    const { fetch, seen } = fakeFetch([reply, () => json(wire({ holds: { type: 'noul', noul: 0.4 } }))]);
    await assert.rejects(parallelProvider({ ...settings, fetch }).decide({ label: 'x', kind: 'judge', state: {}, questions }, ctx()), (error) => {
      code('outcome_unknown')(error);
      assert.deepEqual([error.costUsd, error.costBasis], [PARALLEL_LIST_PRICE_USD, 'estimate'], what);
      return true;
    });
    assert.equal(seen.length, 1, `${what} was sent ${seen.length} times`);
  }
});

test('a workflow whose Parallel decision meets a 503 after sending escalates as interrupted, sent once and booked once at list price', async () => {
  const { fetch, seen } = fakeFetch([json({ type: 'error', error: {} }, 503), () => json(wire({ legit: { type: 'noul', noul: 0.9 } }))]);
  const receipts = [];
  const flow = {
    v: 2, name: 'checked', schemas: { Verdict: { type: 'object', required: ['legit'], properties: { legit: { type: 'boolean', description: 'Is the filing legitimate?' } } } },
    output: { schemaId: 'Verdict', path: 'verdict' },
    root: { node: 'judge', label: 'check', state: { doc: 'text' }, out: 'Verdict', as: 'verdict' },
  };
  const result = await runWorkflow(flow, {}, { runJudge: judgeFromProvider(parallelProvider({ ...settings, fetch })), recordDecision: async (receipt) => { receipts.push(receipt); } });
  assert.deepEqual([result.status, result.escalation.kind, result.escalation.stage], ['escalated', 'decision_interrupted', 'decision']);
  assert.equal(seen.length, 1, 'a paid request is never sent twice');
  assert.deepEqual([receipts.length, receipts[0].status, receipts[0].cost_usd], [1, 'failed', PARALLEL_LIST_PRICE_USD]);
});

test('a request in flight past its own timeout or the host\'s deadline is outcome_unknown, sent once, booked at list price; the host\'s cancel stays aborted', async (t) => {
  const questions = { holds: { type: 'noul', instructions: 'Q?' } };
  const hang = (init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  // A fake fetch holds no socket, and the deadline's timer does not keep the process up: this does.
  const hold = setInterval(() => {}, 1_000);
  t.after(() => clearInterval(hold));
  for (const [what, provider, context] of [['its own timeoutMs', { timeoutMs: 50 }, ctx({ deadlineMs: 10_000 })], ['the host\'s deadline', {}, ctx({ deadlineMs: 50 })]]) {
    const { fetch, seen } = fakeFetch([hang]);
    await assert.rejects(parallelProvider({ ...settings, ...provider, fetch }).decide({ label: 'x', kind: 'judge', state: {}, questions }, context), (error) => {
      code('outcome_unknown')(error);
      assert.deepEqual([error.costUsd, error.costBasis], [PARALLEL_LIST_PRICE_USD, 'estimate'], what);
      return true;
    });
    assert.equal(seen.length, 1, what);
  }
  const controller = new AbortController();
  const { fetch } = fakeFetch([hang]);
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(parallelProvider({ ...settings, fetch }).decide({ label: 'x', kind: 'judge', state: {}, questions }, ctx({ signal: controller.signal })), code('aborted'));
});

test('a response whose body stalls past the timeout after its 200 headers is outcome_unknown, sent once, booked at list price', async (t) => {
  // The headers arrived, so Parallel answered: a body cut off by the deadline is a lost outcome, not a plain timeout.
  const stalled = (init) => new Response(new ReadableStream({ start(controller) { init.signal.addEventListener('abort', () => controller.error(init.signal.reason), { once: true }); } }), { status: 200, headers: { 'content-type': 'application/json' } });
  const hold = setInterval(() => {}, 1_000);
  t.after(() => clearInterval(hold));
  const { fetch, seen } = fakeFetch([stalled]);
  await assert.rejects(parallelProvider({ ...settings, fetch, timeoutMs: 50 }).decide({ label: 'x', kind: 'judge', state: {}, questions: { holds: { type: 'noul', instructions: 'Q?' } } }, ctx({ deadlineMs: 10_000 })), (error) => {
    code('outcome_unknown')(error);
    assert.deepEqual([error.costUsd, error.costBasis], [PARALLEL_LIST_PRICE_USD, 'estimate']);
    return true;
  });
  assert.equal(seen.length, 1);
});

test('a request that provably never reached Parallel is retried, and only the answered attempt is booked', async () => {
  const refused = () => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }));
  const { fetch, seen } = fakeFetch([refused, () => json(wire({ holds: { type: 'noul', noul: 0.4 } }))]);
  const result = await parallelProvider({ ...settings, fetch }).decide({ label: 'x', kind: 'judge', state: {}, questions: { holds: { type: 'noul', instructions: 'Q?' } } }, ctx());
  assert.equal(seen.length, 2);
  assert.deepEqual([result.cost_usd, result.cost_basis], [PARALLEL_LIST_PRICE_USD, 'estimate']);
});

test('a 429 whose Retry-After is an HTTP date waits until that date and retries; a date past the deadline gives up at once', async () => {
  const questions = { holds: { type: 'noul', instructions: 'Q?' } };
  const soon = fakeFetch([() => json({ type: 'error', error: {} }, 429, { 'retry-after': new Date(Date.now() + 1000).toUTCString() }), () => json(wire({ holds: { type: 'noul', noul: 0.4 } }))]);
  const result = await parallelProvider({ ...settings, fetch: soon.fetch }).decide({ label: 'x', kind: 'judge', state: {}, questions }, ctx());
  assert.equal(soon.seen.length, 2);
  assert.equal(result.answers.holds.noul, 0.4);
  const late = fakeFetch([() => json({ type: 'error', error: {} }, 429, { 'retry-after': new Date(Date.now() + 120_000).toUTCString() }), () => json(wire({ holds: { type: 'noul', noul: 0.4 } }))]);
  const started = Date.now();
  await assert.rejects(parallelProvider({ ...settings, fetch: late.fetch, timeoutMs: 5_000 }).decide({ label: 'x', kind: 'judge', state: {}, questions }, ctx()), code('rate_limited'));
  assert.equal(late.seen.length, 1);
  assert.ok(Date.now() - started < 1_000, 'a wait that would not end before the deadline is never started');
});

test('a 429 is retried only when it says when: without Retry-After it is rate_limited at once', async () => {
  const { fetch, seen } = fakeFetch([json({ type: 'error', error: {} }, 429), () => json(wire({ holds: { type: 'noul', noul: 0.4 } }))]);
  await assert.rejects(parallelProvider({ ...settings, fetch }).decide({ label: 'x', kind: 'judge', state: {}, questions: { holds: { type: 'noul', instructions: 'Q?' } } }, ctx()), code('rate_limited'));
  assert.equal(seen.length, 1);
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
