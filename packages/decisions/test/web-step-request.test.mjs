// The request @parcha/agentrun-web's classifier step sends (its sift and judge requests, pinned in web's
// test/fixtures/decide-requests.json), as each provider here puts it on the wire: Parallel Decisions with the state and
// questions as the step wrote them and no sampling field (its API takes none); the Anthropic control with that same
// state and those same questions as its prompt, and no temperature (claude-haiku-5-5 refuses a non-default one).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { anthropicProvider, parallelProvider, PARALLEL_LIST_PRICE_USD } from '../dist/index.js';

const pinned = JSON.parse(readFileSync(new URL('../../web/test/fixtures/decide-requests.json', import.meta.url), 'utf8'));
const ctx = () => ({ decisionId: 'web-sift-0', signal: new AbortController().signal, deadlineMs: 5000 });
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const nouls = (step, p) => Object.fromEntries(Object.keys(pinned[step].request.questions).map((id) => [id, p]));

for (const step of ['sift', 'judge']) {
  test(`web's ${step} request goes to Parallel Decisions as the step wrote it, with no temperature, at list price`, async () => {
    const sent = [];
    const fetch = async (url, init) => {
      sent.push({ url: String(url), body: JSON.parse(init.body) });
      return json({ decision_id: 'd-1', mode: 'fast', answers: Object.fromEntries(Object.entries(nouls(step, 0.25)).map(([id, noul]) => [id, { type: 'noul', noul }])), citations: [], usage: { input_tokens: 300 } });
    };
    const outcome = await parallelProvider({ apiKey: 'parallel-canary', baseURL: 'https://fake.invalid', fetch }).decide(pinned[step].request, ctx());
    assert.equal(sent[0].url, 'https://fake.invalid/v1/decisions');
    assert.deepEqual(sent[0].body, { mode: 'fast', state: pinned[step].request.state, questions: pinned[step].request.questions, include_excerpts: true });
    for (const sampling of ['temperature', 'top_p', 'top_k']) assert.equal(Object.hasOwn(sent[0].body, sampling), false, sampling);
    assert.deepEqual([outcome.cost_usd, outcome.cost_basis], [PARALLEL_LIST_PRICE_USD, 'estimate']);
  });

  test(`web's ${step} request goes to the Anthropic control as its prompt, word for word, with no sampling field`, async () => {
    const sent = [];
    const fetch = async (url, init) => {
      sent.push({ url: String(url), body: JSON.parse(init.body) });
      return json({ id: 'msg_1', model: 'claude-haiku-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(nouls(step, 0.25)) }], usage: { input_tokens: 900, output_tokens: 30 } });
    };
    await anthropicProvider({ apiKey: 'anthropic-canary', baseURL: 'https://fake.invalid', fetch }).decide(pinned[step].request, ctx());
    const { body } = sent[0];
    assert.equal(body.model, 'claude-haiku-5-5');
    assert.deepEqual(body.messages, [{ role: 'user', content: JSON.stringify({ state: pinned[step].request.state, questions: pinned[step].request.questions }) }]);
    for (const sampling of ['temperature', 'top_p', 'top_k']) assert.equal(Object.hasOwn(body, sampling), false, sampling);
  });
}
