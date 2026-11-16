// Jev's context (https://docs.typesafe.ai/models): 32k tokens for the state plus any one question, 64k for the state plus
// all of them, 262k for both with the TypeSafe-Danger-Zone-Long-Context header; past them Jev answers HTTP 400
// max_tokens_exceeded and nothing. A workflow's judge step fed whole pages crossed it (a learned workflow's rubric step,
// 104-174 KB of state and questions), failed, and failed the workflow. The runner never sends a request over it: one that
// may not fit the default goes with the long-context header; one that may not fit that either has its longest state
// values cut, each ending "[cut]"; on OpenRouter, which documents no long context, they are cut to the default.
import assert from 'node:assert/strict';
import test from 'node:test';
import { judgeFromProvider, runWorkflow } from '@parcha/agentrun-dsl';
import { createJevRunner, jevProvider, JevError } from '../dist/index.js';

// Jev's published context, in tokens, as the faux holds it, and the mark a cut value ends with.
const JEV_CONTEXT_TOKENS = { perQuestion: 32_000, perRequest: 64_000, long: 262_000 };
const JEV_CUT_MARK = ' [cut]';
const KEY = 'fake-test-key';
const LONG = 'typesafe-danger-zone-long-context';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');

/** A faux Jev that counts a token per 3 bytes (real text runs 3 to 4) and refuses, as Jev does, a request over its
 *  context: the default one, or the long one when the request carries the header. It answers yes to every question. */
function fauxJev() {
  const sent = [];
  const fetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    const long = new Headers(init.headers).get(LONG) === 'true';
    sent.push({ request, long });
    const tokens = (value) => Math.ceil(bytes(value) / 3);
    const state = tokens(request.state);
    const perQuestion = state + Math.max(...Object.entries(request.questions).map(([id, q]) => tokens({ [id]: q })));
    const perRequest = state + tokens(request.questions);
    const limit = long ? { perQuestion: JEV_CONTEXT_TOKENS.long, perRequest: JEV_CONTEXT_TOKENS.long } : JEV_CONTEXT_TOKENS;
    if (perQuestion > limit.perQuestion || perRequest > limit.perRequest) return json({ detail: { error_type: 'max_tokens_exceeded' } }, 400);
    const answers = Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: 'noul', noul: 0.9 }]));
    return json({ model: 'jev-1.14.0', answers, usage: { input_tokens: perRequest, output_tokens: 0 } });
  };
  return { fetch, sent };
}

// A rubric of yes/no questions over a merchant's pages, the shape of the step that failed (fictional words throughout).
const FLAGS = ['adult', 'gambling', 'crypto', 'money_services', 'financial_services', 'regulated_goods', 'nutraceuticals', 'subscription',
  'free_trial', 'travel', 'future_delivery', 'high_ticket', 'digital_goods', 'marketplace'];
const rubricFlow = {
  v: 2, name: 'rubric', schemas: {
    Rubric: { type: 'object', required: FLAGS, properties: Object.fromEntries(FLAGS.map((flag) => [flag, { type: 'boolean', description: `Do the merchant's pages show ${flag.replace(/_/g, ' ')}? Read every page; a passing mention does not count.` }])) },
  },
  output: { schemaId: 'Rubric', path: 'rubric' },
  root: { node: 'judge', label: 'rubric', state: { merchant: '{merchant}', home: '{home}', pages: '{pages}' }, out: 'Rubric', as: 'rubric' },
};
const page = (n, size, word = 'fictional storefront text ') => ({ url: `https://shop.example/page-${n}`, content: word.repeat(Math.ceil(size / word.length)).slice(0, size) });
const judgeOn = (options) => judgeFromProvider(jevProvider({ apiKey: KEY, baseURL: 'https://fake.invalid/gateway', retryBaseMs: 1, retryMaxMs: 2, ...options }));

test('a judge step fed long pages, over the default context, is sent whole with the long-context header and answered', async () => {
  const jev = fauxJev();
  // 160 KB of pages: about 53k tokens at 3 bytes a token, over 32k; the failed rubric requests were 108-174 KB.
  const input = { merchant: 'Example Outfitters', home: page(0, 40_000).content, pages: Array.from({ length: 8 }, (_, i) => page(i + 1, 15_000)) };
  const result = await runWorkflow(rubricFlow, input, { runJudge: judgeOn({ fetch: jev.fetch }) });
  assert.equal(result.status, 'complete', `the rubric answered, got ${result.status}: ${result.error ?? ''}`);
  assert.equal(jev.sent.length, 1, 'one request, never a refused one first');
  assert.equal(jev.sent[0].long, true, 'sent with the long-context header');
  assert.deepEqual(jev.sent[0].request.state, input, 'nothing cut: the pages went whole');
  assert.equal(result.output.adult, true);
});

test('a request that fits the default context goes as it always did: no header, nothing cut', async () => {
  const jev = fauxJev();
  const input = { merchant: 'Example Outfitters', home: page(0, 4_000).content, pages: [page(1, 4_000)] };
  const result = await runWorkflow(rubricFlow, input, { runJudge: judgeOn({ fetch: jev.fetch }) });
  assert.equal(result.status, 'complete');
  assert.deepEqual(jev.sent.map((each) => each.long), [false]);
  assert.deepEqual(jev.sent[0].request.state, input);
});

test('pages past even the long context are cut, longest first, each ending [cut]; short values stay whole; nothing is split mid-character', async () => {
  const jev = fauxJev();
  // 1.2 MB of pages, in two-byte characters: over 262k tokens by any count.
  const input = { merchant: 'Example Outfitters', home: page(0, 300_000, 'é text ').content, pages: Array.from({ length: 6 }, (_, i) => page(i + 1, 150_000, 'é text ')).concat([page(7, 900)]) };
  const result = await runWorkflow(rubricFlow, input, { runJudge: judgeOn({ fetch: jev.fetch }) });
  assert.equal(result.status, 'complete', `the rubric answered, got ${result.status}: ${result.error ?? ''}`);
  assert.equal(jev.sent.length, 1);
  const { request, long } = jev.sent[0];
  assert.equal(long, true);
  assert.ok(bytes(request.state) + bytes(request.questions) <= JEV_CONTEXT_TOKENS.long, 'its bytes, which bound its tokens, fit the long context');
  assert.equal(request.state.merchant, input.merchant, 'a short value is never cut');
  assert.deepEqual(request.state.pages[6], input.pages[6], 'a page under the cut stays whole');
  assert.ok(request.state.home.endsWith(JEV_CUT_MARK) && input.home.startsWith(request.state.home.slice(0, -JEV_CUT_MARK.length)), 'the home page is its own start, then [cut]');
  for (const each of request.state.pages.slice(0, 6)) {
    assert.ok(each.content.endsWith(JEV_CUT_MARK), 'every long page ends [cut]');
    assert.equal(each.url.endsWith(JEV_CUT_MARK), false, 'its url, short, is whole');
  }
  assert.doesNotMatch(JSON.stringify(request.state), /�/, 'no character was split');
});

test('on OpenRouter, which documents no long context, long pages are cut to the default context and answered; longContext cannot be asked there', async () => {
  const jev = fauxJev();
  const input = { merchant: 'Example Outfitters', home: page(0, 40_000).content, pages: Array.from({ length: 8 }, (_, i) => page(i + 1, 15_000)) };
  const result = await runWorkflow(rubricFlow, input, { runJudge: judgeOn({ provider: 'openrouter', baseURL: undefined, fetch: jev.fetch }) });
  assert.equal(result.status, 'complete', `the rubric answered, got ${result.status}: ${result.error ?? ''}`);
  assert.equal(jev.sent.length, 1);
  assert.equal(jev.sent[0].long, false, 'no header OpenRouter does not document');
  const { request } = jev.sent[0];
  assert.ok(bytes(request.state) + bytes(request.questions) <= JEV_CONTEXT_TOKENS.perRequest);
  assert.ok(request.state.home.endsWith(JEV_CUT_MARK));
  assert.throws(() => createJevRunner({ provider: 'openrouter', apiKey: KEY, longContext: true }), (error) => error instanceof JevError && error.code === 'configuration');
});

test('longContext false cuts to the default context instead of sending the header', async () => {
  const jev = fauxJev();
  const run = createJevRunner({ apiKey: KEY, baseURL: 'https://fake.invalid/gateway', fetch: jev.fetch, longContext: false });
  const questions = { holds: { type: 'noul', instructions: 'Does the page hold a refund policy?' } };
  const result = await run({ label: 'policy', state: { page: 'fictional policy text '.repeat(10_000) }, questions });
  assert.equal(result.answers.holds.noul, 0.9);
  assert.equal(jev.sent[0].long, false);
  assert.ok(jev.sent[0].request.state.page.endsWith(JEV_CUT_MARK));
  assert.ok(bytes(jev.sent[0].request.state) + bytes(questions) <= JEV_CONTEXT_TOKENS.perQuestion);
});

test('questions too long for the context even with every value cut are refused before anything is sent', async () => {
  const jev = fauxJev();
  const run = createJevRunner({ apiKey: KEY, baseURL: 'https://fake.invalid/gateway', fetch: jev.fetch, longContext: false });
  const questions = { holds: { type: 'noul', instructions: 'Does the page hold it? '.repeat(2_000) } };
  await assert.rejects(run({ label: 'policy', state: { page: 'x'.repeat(10) }, questions }), (error) => {
    assert.ok(error instanceof JevError);
    assert.equal(error.code, 'invalid_request');
    assert.equal(error.attempts, 0);
    assert.equal(error.requestDiagnostic.reason, 'over_context');
    return true;
  });
  assert.equal(jev.sent.length, 0);
});

// Images count toward Jev's context too ("Image tokens also count toward the request's context length", and each use of a
// reference adds the image again: https://docs.typesafe.ai/images). TypeSafe publishes no per-image figure, so this faux
// charges a full-size image (1568x1568) 3,278 tokens a use, Claude's 750 square pixels a token at the same side limit, and
// a token per byte of text, the most text can cost.
const be = (n, width) => Array.from({ length: width }, (_, i) => (n >>> (8 * (width - 1 - i))) & 0xff);
const png = (side) => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...be(side, 4), ...be(side, 4), 8, 2, 0, 0, 0, 1]);
const SHOT = { '<shot>': { bytes: png(1568), mime: 'image/png' } };
function fauxImageJev() {
  const sent = [];
  const client = {
    async systemOne(request, options) {
      const long = new Headers(options.headers ?? {}).get(LONG) === 'true';
      sent.push({ request, long });
      const text = JSON.stringify([request.state, request.questions]);
      const uses = Object.keys(request.assets ?? {}).reduce((n, reference) => n + text.split(reference).length - 1, 0);
      const tokens = bytes(request.state) + bytes(request.questions) + uses * 3_278;
      if (tokens > (long ? JEV_CONTEXT_TOKENS.long : JEV_CONTEXT_TOKENS.perQuestion)) throw new Error('HTTP 400 max_tokens_exceeded');
      return { model: 'jev-1.14.0', answers: Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: 'noul', noul: 0.9 }])), usage: { input_tokens: tokens, output_tokens: 0 } };
    },
  };
  return { client, sent };
}
const shotQuestions = { holds: { type: 'noul', instructions: 'Does the page, or its screenshot, show a refund policy?' } };

test('an image takes room in the context: text that fits alone, with a full-size image beside it, goes with the long-context header', async () => {
  const jev = fauxImageJev();
  const run = createJevRunner({ client: jev.client });
  const state = { shot: '<shot>', page: 'fictional policy text '.repeat(1_340) };
  const result = await run({ label: 'policy', state, questions: shotQuestions, assets: SHOT });
  assert.equal(result.answers.holds.noul, 0.9);
  assert.equal(jev.sent.length, 1);
  assert.equal(jev.sent[0].long, true, 'the image left the text too little of the default context');
  assert.deepEqual(jev.sent[0].request.state, state, 'nothing cut');
});

test('a request whose images alone are over the long context is refused before anything is sent', async () => {
  const jev = fauxImageJev();
  const run = createJevRunner({ client: jev.client });
  const state = { shots: Array.from({ length: 21 }, () => '<shot>') };
  await assert.rejects(run({ label: 'policy', state, questions: shotQuestions, assets: SHOT }), (error) => {
    assert.ok(error instanceof JevError);
    assert.equal(error.code, 'invalid_request');
    assert.equal(error.requestDiagnostic?.reason, 'over_context');
    assert.match(error.message, /image/);
    return true;
  });
  assert.equal(jev.sent.length, 0);
});

test('cut to the default context, the text leaves room for the images beside it, and the result says what was cut', async () => {
  const jev = fauxImageJev();
  const run = createJevRunner({ client: jev.client, longContext: false });
  const page = 'fictional policy text '.repeat(2_000);
  const result = await run({ label: 'policy', state: { shot: '<shot>', page }, questions: shotQuestions, assets: SHOT });
  assert.equal(result.answers.holds.noul, 0.9, 'answered, not refused for the image');
  const sentState = jev.sent[0].request.state;
  assert.equal(sentState.shot, '<shot>');
  assert.ok(sentState.page.endsWith(JEV_CUT_MARK));
  assert.deepEqual(result.state_sent, { state: sentState, cut: [{ path: '/page', bytes: Buffer.byteLength(page), sent_bytes: Buffer.byteLength(sentState.page) }] });
});

test("a decision receipt holds the state Jev was sent: cut values as cut, and which were cut, from their length as asked to as sent", async () => {
  const jev = fauxJev();
  const receipts = [];
  const input = { merchant: 'Example Outfitters', home: page(0, 40_000).content, pages: [page(1, 30_000), page(2, 900)] };
  const result = await runWorkflow(rubricFlow, input, { runJudge: judgeOn({ fetch: jev.fetch, longContext: false }), recordDecision: async (receipt) => { receipts.push(receipt); } });
  assert.equal(result.status, 'complete', `the rubric answered, got ${result.status}: ${result.error ?? ''}`);
  const sentState = jev.sent[0].request.state;
  assert.ok(sentState.home.endsWith(JEV_CUT_MARK));
  assert.equal(receipts.length, 1);
  assert.deepEqual(receipts[0].state, sentState, 'the receipt shows what Jev read, not the pages it never saw');
  assert.equal(receipts[0].state_truncated, false);
  assert.deepEqual(receipts[0].state_cut, [
    { path: '/home', bytes: Buffer.byteLength(input.home), sent_bytes: Buffer.byteLength(sentState.home) },
    { path: '/pages/0/content', bytes: Buffer.byteLength(input.pages[0].content), sent_bytes: Buffer.byteLength(sentState.pages[0].content) },
  ]);
});

test('a cut request whose outcome is lost is receipted with the state it was sent with', async () => {
  const sent = [];
  const lost = async (_url, init) => { sent.push(JSON.parse(init.body)); return json({}, 502); };
  const receipts = [];
  const input = { merchant: 'Example Outfitters', home: page(0, 40_000).content, pages: [] };
  const result = await runWorkflow(rubricFlow, input, { runJudge: judgeOn({ fetch: lost, longContext: false }), recordDecision: async (receipt) => { receipts.push(receipt); } });
  assert.equal(result.status, 'escalated');
  assert.equal(sent.length, 1);
  assert.equal(receipts[0].status, 'failed');
  assert.deepEqual(receipts[0].state, sent[0].state);
  assert.deepEqual(receipts[0].state_cut.map((each) => each.path), ['/home']);
});
