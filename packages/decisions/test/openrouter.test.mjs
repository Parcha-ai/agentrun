// OpenRouter's Decisions models as a DecisionProvider, on a fake fetch: the DSL's provider conformance suite, the request
// as sent (the System One shape Jev takes, the node's model), images as base64 JSON assets to an image-capable model only,
// the cost the response reports (else null, never 0), what is retried and what never is, and the faux service a host
// rehearses with.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DecisionProviderError, judgeFromProvider, judgeFromProviders, runWorkflow, validateAnswers } from '@parcha/agentrun-dsl';
import { registerDecisionProviderConformance } from '@parcha/agentrun-dsl/testing';
import { openrouterProvider } from '../dist/index.js';
import fauxSystemOne from '../dist/testing/faux-system-one.js';

const KEY = 'openrouter-canary-key-0123456789';
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'));
const json = (body, status = 200, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const settings = { apiKey: KEY, baseURL: 'https://fake.invalid/api', retryBaseMs: 1, retryMaxMs: 2, maxAttempts: 3, model: 'liquid/d1', takesImages: () => true };
const ctx = (over = {}) => ({ decisionId: 'decision-1', signal: new AbortController().signal, deadlineMs: 5000, ...over });
const QUESTIONS = { holds: { type: 'noul', instructions: 'Does it hold?' } };
const answered = (extra = {}) => json({ id: 'gen-123', model: 'liquid/d1', answers: { holds: { type: 'noul', noul: 0.8 } }, usage: { input_tokens: 400, output_tokens: 0, cost: 0.000008 }, ...extra });
/** A fetch that answers each call with the next of `replies` (the last repeats), and the requests it saw. */
function fakeFetch(replies) {
  const seen = [];
  const fetch = async (url, init) => {
    const reply = replies[Math.min(seen.length, replies.length - 1)];
    seen.push({ url: String(url), init });
    return typeof reply === 'function' ? reply(init) : reply.clone();
  };
  return { fetch, seen };
}

registerDecisionProviderConformance('openrouter', {
  canary: KEY, refuses: true,
  build(replies) {
    let calls = 0;
    const fetch = async (_url, init) => {
      const reply = replies[Math.min(calls, replies.length - 1)];
      calls++;
      if (reply.kind === 'hang') return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
      if (reply.kind === 'status') return json({ error: { message: 'refused', code: reply.status } }, reply.status);
      if (reply.kind === 'malformed') return json('{"answers": [not json');
      if (reply.kind === 'lost') throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
      return json({ id: 'gen-1', model: 'liquid/d1', answers: reply.answers, usage: { input_tokens: 120, output_tokens: 0, cost: 0.0000024 } });
    };
    return { provider: openrouterProvider({ ...settings, fetch }), calls: () => calls };
  },
});

test('it posts the System One request to /v1/systemone with the node\'s model and a bearer key, and books the reported cost', async () => {
  const { fetch, seen } = fakeFetch([answered()]);
  const result = await judgeFromProvider(openrouterProvider({ ...settings, fetch }))({ label: 'x', kind: 'judge', state: { claim: 'c' }, questions: QUESTIONS, model: 'perplexity/pplx-decider-v1.2' });
  assert.equal(seen[0].url, 'https://fake.invalid/api/v1/systemone');
  assert.equal(seen[0].init.headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(JSON.parse(seen[0].init.body), { state: { claim: 'c' }, model: 'perplexity/pplx-decider-v1.2', questions: QUESTIONS });
  assert.deepEqual([result.cost_usd, result.cost_basis, result.usage, result.provider_request_id, result.model], [0.000008, 'reported', { input_tokens: 400, output_tokens: 0 }, 'gen-123', 'liquid/d1']);
});

test('a response with no cost is booked unknown, null and never 0', async () => {
  const { fetch } = fakeFetch([answered({ usage: { input_tokens: 400, output_tokens: 0 } })]);
  const outcome = await openrouterProvider({ ...settings, fetch }).decide({ label: 'x', kind: 'judge', state: {}, questions: QUESTIONS }, ctx());
  assert.deepEqual([outcome.cost_usd, outcome.cost_basis], [null, 'unknown']);
});

test('a node that names no model, with no default, is refused before anything is sent', async () => {
  const { fetch, seen } = fakeFetch([answered()]);
  await assert.rejects(openrouterProvider({ ...settings, model: undefined, fetch }).decide({ label: 'x', kind: 'judge', state: {}, questions: QUESTIONS }, ctx()), (e) => e.code === 'invalid_request' && /names its model/.test(e.message));
  assert.equal(seen.length, 0);
});

test('images go as base64 JSON assets under their tokens with the image header, only to a model the catalog lists with image input', async () => {
  const { fetch, seen } = fakeFetch([answered(), answered()]);
  const images = { '<page1>': { bytes: PNG, mime: 'image/png', ref: 'pages/acme/1.png' } };
  const request = { label: 'x', kind: 'judge', state: { doc: 'acme.pdf', page: '<page1>' }, questions: QUESTIONS, model: 'liquid/d1', images };
  await openrouterProvider({ ...settings, fetch }).decide(request, ctx());
  const sent = seen[0].init;
  assert.equal(sent.headers['TypeSafe-Danger-Zone-Images'], 'true');
  assert.equal(sent.headers['content-type'], 'application/json', 'OpenRouter refuses a multipart body (live: "invalid content-type: multipart/form-data")');
  const body = JSON.parse(sent.body);
  assert.deepEqual(body.assets, { '<page1>': { type: 'image', format: 'png', data_base64: Buffer.from(PNG).toString('base64') } });
  // A model other than Jev reads an image only as a top-level item of an array state: the node's object state goes as one.
  assert.deepEqual(body.state, [{ doc: 'acme.pdf' }, '<page1>']);
  // Jev reads a token anywhere, inside text too, and gets the state as the node wrote it.
  await openrouterProvider({ ...settings, fetch }).decide({ ...request, model: 'typesafe/jev-1.14', state: { doc: 'acme.pdf', note: 'see <page1>' } }, ctx());
  assert.deepEqual(JSON.parse(seen[1].init.body).state, { doc: 'acme.pdf', note: 'see <page1>' });
  // The catalog decides by default: a text-only model is refused before the request is sent.
  const catalog = json({ data: [{ id: 'liquid/d1', architecture: { input_modalities: ['text', 'image'] } }, { id: 'nace-ai/drex-v2.0', architecture: { input_modalities: ['text'] } }] });
  const routed = fakeFetch([(init) => (init?.method === 'POST' ? answered() : catalog.clone())]);
  const provider = openrouterProvider({ ...settings, takesImages: undefined, fetch: routed.fetch });
  await assert.rejects(provider.decide({ ...request, model: 'nace-ai/drex-v2.0' }, ctx()), (e) => e.code === 'invalid_request' && /takes no image input/.test(e.message));
  await provider.decide(request, ctx());
  assert.deepEqual(routed.seen.map((s) => s.url), ['https://fake.invalid/api/v1/models?output_modalities=decisions', 'https://fake.invalid/api/v1/systemone'], 'the catalog is read once');
  assert.deepEqual(provider.experimental.inputs, ['image']);
  const refuses = fakeFetch([answered()]);
  await assert.rejects(openrouterProvider({ ...settings, fetch: refuses.fetch }).decide({ ...request, model: 'typesafe/jev-1.14', state: { page: 'none' } }, ctx()), (e) => e.code === 'invalid_request' && /must appear/.test(e.message));
  await assert.rejects(openrouterProvider({ ...settings, fetch: refuses.fetch }).decide({ ...request, state: { note: 'see <page1>' } }, ctx()), (e) => e.code === 'invalid_request' && /whole top-level value/.test(e.message), 'a token inside text is refused for a model that reads it only as a state item');
  assert.equal(refuses.seen.length, 0, 'nothing is sent for a refused image request');
});

test('live response shapes (2026-10-30) read as answered: model with its dated slug, the reported cost, the generation id', async () => {
  const live = JSON.parse(readFileSync(new URL('./fixtures/openrouter-live-20261030.json', import.meta.url), 'utf8'));
  for (const { model, response } of live) {
    const { fetch } = fakeFetch([json(response)]);
    const questions = Object.fromEntries(Object.entries(response.answers).map(([id, a]) => [id, a.type === 'choice' ? { type: 'choice', instructions: 'Which?', criteria: Object.fromEntries(Object.keys(a.probabilities).map((o) => [o, o])) } : { type: 'noul', instructions: 'Does it hold?' }]));
    const outcome = await openrouterProvider({ ...settings, fetch }).decide({ label: 'x', kind: 'judge', state: {}, questions, model }, ctx());
    assert.equal(outcome.model, response.model);
    assert.deepEqual([outcome.cost_usd, outcome.cost_basis, outcome.provider_request_id], [response.usage.cost, 'reported', response.id]);
    assert.deepEqual(outcome.usage, { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens });
    validateAnswers(questions, outcome.answers);
  }
});

test('a 429 with Retry-After is sent again; one without, a 5xx, a 408 or a lost connection never is', async () => {
  const limited = fakeFetch([json({}, 429, { 'retry-after': '0' }), answered()]);
  const outcome = await openrouterProvider({ ...settings, fetch: limited.fetch }).decide({ label: 'x', kind: 'judge', state: {}, questions: QUESTIONS }, ctx());
  assert.equal(outcome.answers.holds.noul, 0.8);
  assert.equal(limited.seen.length, 2);
  for (const [reply, code] of [[json({}, 429), 'rate_limited'], [json({}, 502), 'outcome_unknown'], [json({}, 408), 'outcome_unknown'], [() => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); }, 'outcome_unknown']]) {
    const once = fakeFetch([reply, answered()]);
    await assert.rejects(openrouterProvider({ ...settings, fetch: once.fetch }).decide({ label: 'x', kind: 'judge', state: {}, questions: QUESTIONS }, ctx()), (e) => {
      assert.equal(e.code, code);
      if (code === 'outcome_unknown') assert.deepEqual([e.costUsd, e.costBasis], [null, 'unknown']);
      return true;
    });
    assert.equal(once.seen.length, 1);
  }
  const unreachable = fakeFetch([() => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }, answered()]);
  await openrouterProvider({ ...settings, fetch: unreachable.fetch }).decide({ label: 'x', kind: 'judge', state: {}, questions: QUESTIONS }, ctx());
  assert.equal(unreachable.seen.length, 2, 'a connect error before sending is sent again');
});

test('a 404 (an unknown model) or 400 is invalid_request; 402 an http error', async () => {
  for (const [status, code] of [[404, 'invalid_request'], [400, 'invalid_request'], [402, 'http']]) {
    const { fetch } = fakeFetch([json({ error: { message: 'no' } }, status)]);
    await assert.rejects(openrouterProvider({ ...settings, fetch }).decide({ label: 'x', kind: 'judge', state: {}, questions: QUESTIONS }, ctx()), (e) => e instanceof DecisionProviderError && e.code === code);
  }
});

test('the faux System One answers valid, stable, per-model answers, with images, a catalog and a reported cost', async () => {
  process.env.AGENTRUN_FAUX_SYSTEM_ONE_DELAY_MS = '0';
  const calls = join(mkdtempSync(join(tmpdir(), 'faux-system-one-')), 'calls.jsonl');
  process.env.AGENTRUN_FAUX_SYSTEM_ONE_CALLS = calls;
  try {
    const questions = { ...QUESTIONS, kind: { type: 'choice', instructions: 'Which kind?', criteria: { a: 'first', b: null, c: 'third' } }, grade: { type: 'score', instructions: 'How good?', criteria: ['bad', 'ok', 'good'] } };
    const provider = openrouterProvider({ apiKey: KEY, fetch: fauxSystemOne });
    const ask = (model, state = { doc: 'x' }) => judgeFromProvider(provider)({ label: 'x', kind: 'judge', state, questions, model });
    const a = await ask('liquid/d1');
    validateAnswers(questions, a.answers);
    assert.deepEqual((await ask('liquid/d1')).answers, a.answers, 'the same request answers the same');
    assert.notDeepEqual((await ask('cloudflare/clef')).answers.holds, a.answers.holds, 'another model answers differently');
    assert.ok(a.cost_usd > 0 && a.cost_basis === 'reported' && /\(faux\)$/.test(a.model));
    assert.ok((await ask('liquid/d1', { doc: 'FAUX_NO' })).answers.holds.noul < 0.2);
    const withImage = await judgeFromProvider(openrouterProvider({ apiKey: KEY, fetch: fauxSystemOne }), { loadImage: async () => ({ bytes: PNG, mime: 'image/png' }) })({ label: 'x', kind: 'judge', state: { page: '<p>' }, questions, model: 'liquid/d1', images: { '<p>': 'p.png' } });
    validateAnswers(questions, withImage.answers);
    await assert.rejects(judgeFromProvider(openrouterProvider({ apiKey: KEY, fetch: fauxSystemOne }), { loadImage: async () => ({ bytes: PNG, mime: 'image/png' }) })({ label: 'x', kind: 'judge', state: { page: '<p>' }, questions, model: 'microsoft/microsoft-decision-1', images: { '<p>': 'p.png' } }), /takes no image input/);
    const lines = readFileSync(calls, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines.at(-1), { ...lines.at(-1), path: '/api/v1/systemone', model: 'liquid/d1', images: 1 });
    process.env.AGENTRUN_FAUX_SYSTEM_ONE_FAIL = 'BROKEN';
    await assert.rejects(ask('liquid/d1', { doc: 'BROKEN' }), (e) => e.code === 'outcome_unknown');
  } finally {
    delete process.env.AGENTRUN_FAUX_SYSTEM_ONE_DELAY_MS; delete process.env.AGENTRUN_FAUX_SYSTEM_ONE_CALLS; delete process.env.AGENTRUN_FAUX_SYSTEM_ONE_FAIL;
  }
});

test('a jury workflow: one question to several OpenRouter models by node model, each answered and receipted on its own', async () => {
  process.env.AGENTRUN_FAUX_SYSTEM_ONE_DELAY_MS = '0';
  try {
    const schemas = { Any: { type: 'object' }, Q: { type: 'object', required: ['yes'], properties: { yes: { type: 'boolean', description: 'Is the merchant a money transmitter?' } } } };
    const juror = (model, as) => ({ node: 'judge', label: as, provider: 'openrouter', model, state: { merchant: '{merchant}' }, out: 'Q', as });
    const wf = { v: 2, name: 'jury', schemas, output: { schemaId: 'Any' }, root: { node: 'parallel', label: 'jury', branches: [juror('liquid/d1', 'a'), juror('perplexity/pplx-decider-v1.2', 'b'), juror('cloudflare/clef', 'c')] } };
    const providers = { openrouter: openrouterProvider({ apiKey: KEY, fetch: fauxSystemOne }) };
    const receipts = [];
    const result = await runWorkflow(wf, { merchant: 'Acme Remit' }, { runJudge: judgeFromProviders({ providers, default: 'openrouter' }), decisionProviders: { providers, default: 'openrouter' }, recordDecision: async (r) => { receipts.push(r); } });
    assert.equal(result.status, 'complete');
    assert.deepEqual(receipts.map((r) => r.model).sort(), ['cloudflare/clef (faux)', 'liquid/d1 (faux)', 'perplexity/pplx-decider-v1.2 (faux)']);
    assert.ok(receipts.every((r) => r.provider === 'openrouter' && r.cost_usd > 0));
  } finally { delete process.env.AGENTRUN_FAUX_SYSTEM_ONE_DELAY_MS; }
});

test('an image past Jev\'s 1568 px side is refused before sending to a typesafe/jev model; other models are not held to it', async () => {
  const be = (n, width) => Array.from({ length: width }, (_, i) => (n >>> (8 * (width - 1 - i))) & 0xff);
  const png = (width, height) => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...be(width, 4), ...be(height, 4), 8, 2, 0, 0, 0]);
  const ask = (fetch, model, bytes) => openrouterProvider({ ...settings, fetch }).decide({ label: 'x', kind: 'judge', state: { page: '<page1>' }, questions: QUESTIONS, model, images: { '<page1>': { bytes, mime: 'image/png', ref: 'pages/acme/1.png' } } }, ctx());
  const refused = fakeFetch([answered()]);
  await assert.rejects(ask(refused.fetch, 'typesafe/jev-1.14', png(1569, 400)), (e) => e.code === 'invalid_request' && e.message.includes('1569x400') && e.message.includes('1568') && e.message.includes('pages/acme/1.png'));
  assert.equal(refused.seen.length, 0, 'nothing is sent');
  const sent = fakeFetch([() => answered(), () => answered()]);
  await ask(sent.fetch, 'typesafe/jev-1.14', png(1568, 1568));
  await ask(sent.fetch, 'liquid/d1', png(1569, 400));
  assert.equal(sent.seen.length, 2);
});
