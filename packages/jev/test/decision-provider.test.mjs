// Jev as a DecisionProvider: jevProvider wraps createJevRunner, and passes the DSL's provider conformance suite over a
// fake fetch that answers as System One does. Jev's wire format has no refusal, so that rule is skipped for it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { registerDecisionProviderConformance } from '@parcha/agentrun-dsl/testing';
import { judgeFromProvider, judgeFromProviders } from '@parcha/agentrun-dsl';
import * as jev from '../dist/index.js';
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

test('a box question is refused before anything is sent: no node asks one', async () => {
  let calls = 0;
  const provider = jevProvider({ apiKey: KEY, baseURL: 'https://fake.invalid/gateway', model: 'jev-preview', fetch: async () => { calls++; return json({}); } });
  await assert.rejects(judgeFromProvider(provider)({ label: 'x', kind: 'judge', state: 'a <photo>', questions: { spot: { type: 'box', instructions: 'Where is the door?' } } }), (error) => error.code === 'invalid_request' && /does not answer box questions/.test(error.message), 'refused by the declared capabilities, not inside the request');
  assert.equal(calls, 0);
});

test('a question named __proto__ round-trips through Jev and the seam, and is accepted', async () => {
  const questions = JSON.parse('{"__proto__": {"type": "noul", "instructions": "Does it hold?"}}');
  const answers = JSON.parse('{"__proto__": {"type": "noul", "noul": 0.8}}');
  const provider = jevProvider({ apiKey: KEY, baseURL: 'https://fake.invalid/gateway', fetch: async () => json({ model: 'jev-test', answers, usage: { input_tokens: 1, output_tokens: 1 } }) });
  const result = await judgeFromProvider(provider)({ label: 'x', kind: 'judge', state: {}, questions });
  assert.ok(Object.hasOwn(result.answers, '__proto__'));
  assert.equal(result.answers.__proto__.noul, 0.8);
});

test('a node\'s pinned model is the model Jev is sent; unpinned, the provider\'s own; Jev declares no model list, since it takes every pin it is given', async () => {
  const sent = [];
  const jev = jevProvider({ apiKey: KEY, baseURL: 'https://fake.invalid/gateway', fetch: async (_url, init) => {
    sent.push(JSON.parse(init.body).model);
    return json({ model: sent.at(-1), answers: { holds: { type: 'noul', noul: 0.8 } }, usage: { input_tokens: 1, output_tokens: 1 } });
  } });
  const ask = { label: 'x', kind: 'judge', state: {}, questions: { holds: { type: 'noul', instructions: 'Does it hold?' } }, decisionId: 'd' };
  const runJudge = judgeFromProviders({ providers: { jev }, default: 'jev' });
  const pinned = await runJudge({ ...ask, model: 'jev-1.14.0' });
  await runJudge(ask);
  assert.deepEqual(sent, ['jev-1.14.0', 'jev-latest'], 'the pin reaches the request body');
  assert.equal(pinned.model, 'jev-1.14.0');
  assert.equal(jev.capabilities.models ?? null, null);
});

test('jevProvider declares what Jev answers, and the key it reads by name', () => {
  const provider = jevProvider({ apiKey: KEY, baseURL: 'https://fake.invalid/gateway' });
  assert.equal(provider.id, 'jev');
  assert.deepEqual(provider.needs, ['TYPESAFE_API_KEY']);
  assert.deepEqual(provider.capabilities.types, ['noul', 'choice', 'score']);
  assert.deepEqual(provider.capabilities.inputs, ['text', 'json', 'image'], 'TypeSafe takes images');
  assert.deepEqual(jevProvider({ provider: 'openrouter', apiKey: KEY }).capabilities.inputs, ['text', 'json'], 'the OpenRouter route is not verified for images');
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

test('a Jev 200 that breaks the response rules was paid for: invalid_response at an unknown cost, never $0', async () => {
  const provider = jevProvider({ apiKey: KEY, baseURL: 'https://fake.invalid/gateway', fetch: async () => json({ model: 'jev-test', answers: { holds: { type: 'noul', noul: 1.7 } }, usage: { input_tokens: 1, output_tokens: 1 } }) });
  await assert.rejects(provider.decide({ label: 'x', kind: 'judge', state: {}, questions: { holds: { type: 'noul', instructions: 'Q?' } } }, { decisionId: 'd', signal: new AbortController().signal, deadlineMs: null }), (error) => {
    assert.equal(error.code, 'invalid_response');
    assert.deepEqual([error.costUsd, error.costBasis], [null, 'unknown']);
    return true;
  });
});

const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'));

test('images reach Jev through the seam as assets under their tokens, with the image header, and the result names their digests', async () => {
  const seen = [];
  const fetch = async (_url, init) => {
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const form = await new Response(init.body, { headers: { 'content-type': headers['content-type'] } }).formData();
    const request = JSON.parse(await (typeof form.get('request') === 'string' ? form.get('request') : form.get('request').text()));
    seen.push({ headers, request, part: new Uint8Array(await form.get(request.assets['<page1>'].part).arrayBuffer()) });
    return json({ model: 'jev-test', answers: { sealed: { type: 'noul', noul: 0.7 } }, usage: { input_tokens: 900, output_tokens: 0 } });
  };
  const loads = [];
  const judge = judgeFromProvider(jevProvider({ apiKey: KEY, baseURL: 'https://fake.invalid/gateway', fetch }), { loadImage: async (ref) => { loads.push(ref); return { bytes: PNG, mime: 'image/png' }; } });
  const result = await judge({ label: 'seal', kind: 'judge', state: { page: '<page1>' }, questions: { sealed: { type: 'noul', instructions: 'Does <page1> carry a seal?' } }, images: { '<page1>': 'pages/coi-acme/1.png' } });
  assert.deepEqual(loads, ['pages/coi-acme/1.png']);
  assert.equal(seen[0].headers['typesafe-danger-zone-images'], 'true');
  assert.deepEqual(seen[0].part, PNG);
  assert.equal(result.answers.sealed.noul, 0.7);
  assert.equal(result.images.length, 1);
  assert.deepEqual({ ...result.images[0], sha256: result.images[0].sha256.length }, { token: '<page1>', ref: 'pages/coi-acme/1.png', sha256: 64, mime: 'image/png', bytes: PNG.byteLength });
});

test('a request with images on the OpenRouter route of Jev, or on a host with no loadImage, is refused before anything is sent', async () => {
  let calls = 0;
  const fetch = async () => { calls++; return json({}); };
  const ask = { label: 'x', kind: 'judge', state: { page: '<p>' }, questions: { q: { type: 'noul', instructions: 'Q?' } }, images: { '<p>': 'a.png' } };
  await assert.rejects(judgeFromProvider(jevProvider({ provider: 'openrouter', apiKey: KEY, fetch }), { loadImage: async () => ({ bytes: PNG, mime: 'image/png' }) })(ask), (error) => error.code === 'invalid_request');
  await assert.rejects(judgeFromProvider(jevProvider({ apiKey: KEY, baseURL: 'https://fake.invalid/gateway', fetch }))(ask), (error) => error.code === 'configuration');
  await assert.rejects(judgeFromProvider(jevProvider({ apiKey: KEY, baseURL: 'https://fake.invalid/gateway', fetch }), { loadImage: async () => { throw new Error('ENOENT'); } })(ask), (error) => error.code === 'invalid_request' && /could not be read/.test(error.message));
  assert.equal(calls, 0);
});

test('a 429 with Retry-After is sent again; a 5xx after sending never is', async () => {
  let calls = 0;
  const answer = json({ model: 'jev-test', answers: { holds: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 1, output_tokens: 0 } });
  const limited = async () => (++calls === 1 ? new Response('{}', { status: 429, headers: { 'retry-after': '0', 'content-type': 'application/json' } }) : answer);
  const ask = (provider) => provider.decide({ label: 'x', kind: 'judge', state: {}, questions: { holds: { type: 'noul', instructions: 'Q?' } } }, { decisionId: 'd', signal: new AbortController().signal, deadlineMs: 5000 });
  const outcome = await ask(jevProvider({ apiKey: KEY, baseURL: 'https://fake.invalid/gateway', fetch: limited, retryBaseMs: 1, retryMaxMs: 2 }));
  assert.equal(outcome.answers.holds.noul, 0.9);
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(ask(jevProvider({ apiKey: KEY, baseURL: 'https://fake.invalid/gateway', fetch: async () => { calls++; return json({}, 502); }, retryBaseMs: 1, retryMaxMs: 2 })), (error) => error.code === 'outcome_unknown');
  assert.equal(calls, 1);
});

// TypeSafe's published price: https://docs.typesafe.ai/models ($0.042 per million input tokens; output tokens are free).
const PUBLISHED = { inputUsdPerMillionTokens: 0.042, outputUsdPerMillionTokens: 0 };
const askOnce = (provider) => provider.decide({ label: 'x', kind: 'judge', state: {}, questions: { holds: { type: 'noul', instructions: 'Does it hold?' } } }, { decisionId: 'd', signal: new AbortController().signal, deadlineMs: 5000 });
const answered = (usage) => async () => json({ model: 'jev-test', answers: { holds: { type: 'noul', noul: 0.9 } }, ...(usage === undefined ? {} : { usage }) });

test('a call TypeSafe answers is booked at its published price, as an estimate: input tokens priced, output tokens free', async () => {
  assert.deepEqual(jev.JEV_PUBLISHED_PRICING, PUBLISHED, 'the price the docs publish');
  const outcome = await askOnce(jevProvider({ apiKey: KEY, baseURL: 'https://fake.invalid/gateway', fetch: answered({ input_tokens: 1000, output_tokens: 50 }) }));
  assert.equal(outcome.cost_usd, (1000 * 0.042 + 50 * 0) / 1_000_000);
  assert.equal(outcome.cost_basis, 'estimate');
});

test('a cost TypeSafe reports wins over the published price, and is booked as reported', async () => {
  const outcome = await askOnce(jevProvider({ apiKey: KEY, baseURL: 'https://fake.invalid/gateway', fetch: answered({ input_tokens: 1000, output_tokens: 0, cost: 0.002 }) }));
  assert.deepEqual([outcome.cost_usd, outcome.cost_basis], [0.002, 'reported']);
});

test('a configured price that charges output tokens prices them too', async () => {
  const outcome = await askOnce(jevProvider({ apiKey: KEY, baseURL: 'https://fake.invalid/gateway', pricing: { inputUsdPerMillionTokens: 0.042, outputUsdPerMillionTokens: 1 }, fetch: answered({ input_tokens: 1000, output_tokens: 50 }) }));
  assert.deepEqual([outcome.cost_usd, outcome.cost_basis], [(1000 * 0.042 + 50 * 1) / 1_000_000, 'estimate']);
});

test('with no token counts, a failed call, or the OpenRouter route, the cost is unknown: null, never 0', async () => {
  const bare = await askOnce(jevProvider({ apiKey: KEY, baseURL: 'https://fake.invalid/gateway', fetch: answered(undefined) }));
  assert.deepEqual([bare.cost_usd, bare.cost_basis], [null, 'unknown'], 'no usage: nothing to price');
  await assert.rejects(askOnce(jevProvider({ apiKey: KEY, baseURL: 'https://fake.invalid/gateway', fetch: async () => json({ error: { message: 'down' } }, 503) })),
    (error) => error.code === 'outcome_unknown' && error.costUsd === null && error.costBasis === 'unknown', 'a call that may have been billed is unknown, never 0');
  const routed = await askOnce(jevProvider({ provider: 'openrouter', apiKey: KEY, baseURL: 'https://fake.invalid/gateway', fetch: answered({ input_tokens: 1000, output_tokens: 0 }) }));
  assert.deepEqual([routed.cost_usd, routed.cost_basis], [null, 'unknown'], "TypeSafe's price is not OpenRouter's");
});
