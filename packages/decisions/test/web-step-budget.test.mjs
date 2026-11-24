// The three arms of web's classifier step put byte-identical states on the wire, each within web's STATE_BUDGET_BYTES,
// for a search too wide for one state (10 results with 3,000-character snippets) and a page of 200 passages.
import assert from 'node:assert/strict';
import test from 'node:test';
import { JEV_PUBLISHED_PRICING, jevProvider } from '../../jev/dist/index.js';
import { deciderFrom, QUESTIONS_PER_REQUEST, STATE_BUDGET_BYTES } from '../../web/dist/index.js';
import { anthropicDecisionPrice, anthropicProvider, PARALLEL_DECISION_PRICE, parallelProvider } from '../dist/index.js';

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const half = (questions) => Object.fromEntries(Object.keys(questions).map((id) => [id, 0.5]));
const settings = { apiKey: 'canary-key-0123456789', baseURL: 'https://fake.invalid' };

/** Each arm on a fake transport that answers 0.5 to every question, and the states it sent, in order. */
function arms() {
  const states = { jev: [], parallel: [], anthropic: [] };
  const jev = jevProvider({ ...settings, fetch: async (_url, init) => {
    const body = JSON.parse(init.body);
    states.jev.push(JSON.stringify(body.state));
    return json({ model: 'jev-1.14.0', answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: 'noul', noul: 0.5 }])), usage: { input_tokens: 1000, output_tokens: 0 } });
  } });
  const parallel = parallelProvider({ ...settings, fetch: async (_url, init) => {
    const body = JSON.parse(init.body);
    states.parallel.push(JSON.stringify(body.state));
    return json({ decision_id: 'd', mode: 'fast', answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: 'noul', noul: 0.5 }])), citations: [], usage: { input_tokens: 1000 } });
  } });
  const anthropic = anthropicProvider({ ...settings, fetch: async (_url, init) => {
    const { state, questions } = JSON.parse(JSON.parse(init.body).messages[0].content);
    states.anthropic.push(JSON.stringify(state));
    return json({ id: 'msg', model: 'claude-haiku-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(half(questions)) }], usage: { input_tokens: 1000, output_tokens: 20 } });
  } });
  const deciders = {
    jev: deciderFrom(jev, { price: JEV_PUBLISHED_PRICING }),
    parallel: deciderFrom(parallel, { price: PARALLEL_DECISION_PRICE }),
    anthropic: deciderFrom(anthropic, { price: anthropicDecisionPrice() }),
  };
  return { states, deciders };
}

const ctx = () => ({ signal: new AbortController().signal, deadlineMs: 5_000 });
const wideHits = Array.from({ length: 10 }, (_, i) => ({ url: `https://wide.example/${i}`, title: `Result ${i}`, snippet: `${i} ${'汉'.repeat(2_998)}` }));
const passages = Array.from({ length: 200 }, (_, i) => `${String(i).padStart(3, '0')} ${'word '.repeat(199)}\n\n`);

test("the budget is within every arm's own state limit", () => {
  for (const provider of [parallelProvider(), jevProvider(), anthropicProvider()]) {
    const limit = provider.capabilities.maxStateBytes;
    assert.ok(limit === null || STATE_BUDGET_BYTES <= limit, `${provider.id}: ${limit}`);
    assert.ok(provider.capabilities.maxQuestions === null || QUESTIONS_PER_REQUEST <= provider.capabilities.maxQuestions, provider.id);
  }
});

for (const [what, run] of [
  ['a 10-result search with 3,000-character snippets', (decider) => decider.sift('widgets delaware', wideHits, 'Where is Widgets, Inc. registered?', ctx())],
  ['a page of 200 passages', (decider) => decider.judge('https://wide.example/page', 'Where is Widgets, Inc. registered?', passages, ctx())],
]) {
  test(`every arm sends byte-identical states within the budget for ${what}`, async () => {
    const { states, deciders } = arms();
    const got = {};
    for (const [name, decider] of Object.entries(deciders)) got[name] = await run(decider);
    assert.ok(states.jev.length >= 1);
    assert.deepEqual(states.parallel, states.jev);
    assert.deepEqual(states.anthropic, states.jev);
    for (const state of states.jev) assert.ok(Buffer.byteLength(state) <= STATE_BUDGET_BYTES, String(Buffer.byteLength(state)));
    assert.deepEqual(got.parallel.questions_sha256, got.jev.questions_sha256);
    assert.deepEqual(got.anthropic.questions_sha256, got.jev.questions_sha256);
    assert.deepEqual(got.parallel.trimmed, got.jev.trimmed);
  });
}
