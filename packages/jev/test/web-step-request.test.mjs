// The request @parcha/agentrun-web's classifier step sends (its sift and judge requests, pinned in web's
// test/fixtures/decide-requests.json), as jevProvider puts it on the wire: the state and the questions as the step wrote
// them, and no sampling field, since TypeSafe's System One API takes none.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JEV_PUBLISHED_PRICING, jevProvider } from '../dist/index.js';

const pinned = JSON.parse(readFileSync(new URL('../../web/test/fixtures/decide-requests.json', import.meta.url), 'utf8'));
const ctx = () => ({ decisionId: 'web-sift-0', signal: new AbortController().signal, deadlineMs: 5000 });

for (const step of ['sift', 'judge']) {
  test(`web's ${step} request goes to Jev as the step wrote it, with no temperature, and is priced at TypeSafe's published price`, async () => {
    const sent = [];
    const fetch = async (url, init) => {
      sent.push({ url: String(url), body: JSON.parse(init.body) });
      const answers = Object.fromEntries(Object.keys(pinned[step].request.questions).map((id) => [id, { type: 'noul', noul: 0.25 }]));
      return new Response(JSON.stringify({ model: 'jev-1.14.0', answers, usage: { input_tokens: 2000, output_tokens: 0 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const outcome = await jevProvider({ apiKey: 'not-a-secret', baseURL: 'https://fake.invalid/gw', fetch }).decide(pinned[step].request, ctx());
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, 'https://fake.invalid/gw/v1/systemone');
    assert.deepEqual(sent[0].body, { state: pinned[step].request.state, model: 'jev-latest', questions: pinned[step].request.questions });
    for (const sampling of ['temperature', 'top_p', 'top_k']) assert.equal(Object.hasOwn(sent[0].body, sampling), false, sampling);
    assert.deepEqual([outcome.usage, outcome.cost_basis], [{ input_tokens: 2000, output_tokens: 0 }, 'estimate']);
    assert.equal(outcome.cost_usd, (2000 * JEV_PUBLISHED_PRICING.inputUsdPerMillionTokens) / 1e6);
  });
}
