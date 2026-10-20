// The host's side of a run's prompt choice: the record prompt.json keeps and the run's guide, around
// @parcha/pi-durable-agent's choosePrompt (whose own tests hold the pass, threshold, lookup and generic rules), and the
// judge's options and the lookups the host gives it. Offline: Jev, Browserbase and Wikipedia are fakes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composePrompt, jevOptionsOf, lookups, promptForRun, searchLookup, wikipediaLookup } from './select.ts';

/** A home's variants as readAgentHome gives them: the question row, two overlays on it, the base and the generic. */
const stored = {
  kind: { role: 'question', label: 'Kind', text: 'What kind of organisation is it?', criteria: { public: 'listed', nonprofit: 'charity', other: 'anything else' } },
  base: { role: 'base', label: 'Base', text: 'Research it.' },
  public: { role: 'overlay', label: 'Public company', text: 'Start at EDGAR.', when: { question: 'kind', option: 'public', threshold: 0.8 } },
  nonprofit: { role: 'overlay', label: 'Non-profit', text: 'Start at the 990s.', when: { question: 'kind', option: 'nonprofit', threshold: 0.9 } },
  generic: { role: 'generic', label: 'Not sure', text: 'Start at its own site.' },
};

const pass = (choice, p, confidence = p) => ({ choice, probabilities: { public: 0, nonprofit: 0, other: 0, [choice]: p }, confidence });

/** A fake Jev that answers each call with the next pass, and keeps what it was asked. */
function jev(...answers) {
  const asked = [];
  const judge = async (params) => {
    asked.push(params);
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return { answers: { kind: { type: 'choice', ...next } }, model: 'jev-test', usage: null, cost_usd: 0.00002, request_sha256: 'x' };
  };
  return { judge, asked };
}

test('the run\'s prompt (choosePrompt on the home\'s variants): what startRun records and what prompt.json holds', async () => {
  const sources = [{ via: 'browserbase_search', url: 'https://www.habitat.org/', title: 'Habitat for Humanity' }];
  const now = () => new Date('2026-10-20T04:00:00.000Z');
  const { judge, asked } = jev(pass('nonprofit', 0.53, 0.41), pass('nonprofit', 0.95));
  const chosen = await promptForRun({ stored, input: 'Habitat', judge, lookup: async (query) => (assert.equal(query, 'Habitat'), { text: 'A housing charity.', sources }), now });
  assert.deepEqual(chosen.prompt, { id: 'nonprofit', reason: chosen.record.reason });
  assert.deepEqual(asked.map((call) => call.state), [{ input: 'Habitat' }, { input: 'Habitat', lookup: 'A housing charity.' }], 'the lookup\'s text goes to the second pass');
  assert.deepEqual({ ...chosen.record, passes: chosen.record.passes.map(({ latency_ms, ...rest }) => (assert.equal(typeof latency_ms, 'number'), rest)) }, {
    version: 1,
    question: 'kind',
    input: 'Habitat',
    variant: 'nonprofit',
    passes: [{ ...pass('nonprofit', 0.53, 0.41), model: 'jev-test', cost_usd: 0.00002 }, { ...pass('nonprofit', 0.95), model: 'jev-test', cost_usd: 0.00002 }],
    lookup: { used: true, chars: 'A housing charity.'.length, sources },
    reason: chosen.record.reason,
    selected_at: '2026-10-20T04:00:00.000Z',
  });
  assert.match(chosen.record.reason, /nonprofit at 53%.*after the lookup.*nonprofit at 95%/);
  assert.equal('instructions' in chosen.record, false, 'the record leaves the instructions to the run');

  const sure = await promptForRun({ stored, input: 'Caterpillar Inc.', judge: jev(pass('public', 1)).judge, lookup: async () => assert.fail('no lookup when Jev is sure'), now });
  assert.deepEqual([sure.prompt.id, sure.record.lookup.used, sure.record.passes.length], ['public', false, 1]);
  const down = await promptForRun({ stored, input: 'Zzq', judge: jev(new Error('connection refused')).judge, lookup: async () => null, now });
  assert.deepEqual([down.prompt.id, down.record.passes], ['generic', []]);
  assert.match(down.record.reason, /Jev failed \(connection refused\)/);

  assert.equal(await promptForRun({ stored: {}, input: 'x', judge, lookup: async () => null }), null, 'a home with no variants');
  assert.equal(await promptForRun({ stored: undefined, input: 'x', judge, lookup: async () => null }), null, 'a home whose package keeps none');
});

test('the run\'s guide is the home\'s base and then the chosen variant, by id', () => {
  assert.equal(composePrompt(stored, 'public'), 'Research it.\n\nStart at EDGAR.');
  assert.equal(composePrompt(stored, 'generic'), 'Research it.\n\nStart at its own site.');
  assert.throws(() => composePrompt(stored, 'base'), /no variant base/);
  assert.throws(() => composePrompt(stored, 'kind'), /no variant kind/, 'the question row is no prompt');
  assert.throws(() => composePrompt(stored, 'ecommerce'), /no variant ecommerce/);
});

test('the Wikipedia lookup reads the top pages and the first one\'s summary, keyless', async () => {
  const urls = [];
  const fake = async (url, init) => {
    urls.push([url, init.headers['user-agent']]);
    if (url.includes('/search/page')) return Response.json({ pages: [{ key: 'Habitat_for_Humanity', title: 'Habitat for Humanity', description: 'Housing charity' }, { key: 'Habitat', title: 'Habitat', description: null }] });
    return Response.json({ type: 'standard', title: 'Habitat for Humanity', extract: 'Habitat for Humanity International is a <b>non-profit</b> housing organization.', content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Habitat_for_Humanity' } } });
  };
  const found = await wikipediaLookup({ fetch: fake })('Habitat & Co');
  assert.equal(urls[0][0], 'https://en.wikipedia.org/w/rest.php/v1/search/page?q=Habitat%20%26%20Co&limit=3');
  assert.equal(urls[1][0], 'https://en.wikipedia.org/api/rest_v1/page/summary/Habitat_for_Humanity');
  assert.match(urls[0][1], /agentrun/, 'Wikipedia asks callers to name themselves');
  assert.deepEqual(found.sources, [{ via: 'wikipedia', url: 'https://en.wikipedia.org/wiki/Habitat_for_Humanity', title: 'Habitat for Humanity' }]);
  assert.equal(found.text, 'Wikipedia\'s top pages for "Habitat & Co":\n- Habitat for Humanity: Housing charity\n- Habitat\nThe first, Habitat for Humanity: Habitat for Humanity International is a non-profit housing organization.');

  assert.equal(await wikipediaLookup({ fetch: async () => Response.json({ pages: [] }) })('Zzq'), null);
  await assert.rejects(wikipediaLookup({ fetch: async () => new Response('', { status: 503 }) })('Zzq'), /Wikipedia answered 503/);
});

test('the search lookup lists the top results; the lookups run together, and fail only when every one fails', async () => {
  const asked = [];
  const search = async (request, signal) => (asked.push([request, signal instanceof AbortSignal]), { results: [{ url: 'https://www.habitat.org/', title: 'Habitat for Humanity' }, { url: 'https://www.habitat.co.uk/', title: null }] });
  const found = await searchLookup(search)('Habitat');
  assert.deepEqual(asked, [[{ query: 'Habitat', n: 5 }, true]]);
  assert.equal(found.text, 'Web search results for "Habitat":\n- Habitat for Humanity (https://www.habitat.org/)\n- (no title) (https://www.habitat.co.uk/)');
  assert.deepEqual(found.sources.map((s) => [s.via, s.url]), [['browserbase_search', 'https://www.habitat.org/'], ['browserbase_search', 'https://www.habitat.co.uk/']]);
  assert.equal(await searchLookup(async () => ({ results: [] }))('Zzq'), null);

  const wiki = async () => ({ text: 'A housing charity.', sources: [{ via: 'wikipedia', url: 'https://en.wikipedia.org/wiki/Habitat_for_Humanity', title: 'Habitat for Humanity' }] });
  const both = await lookups(searchLookup(search), wiki)('Habitat');
  assert.equal(both.text, `${found.text}\n\nA housing charity.`, 'both texts go to Jev, the search first');
  assert.deepEqual(both.sources.map((s) => s.via), ['browserbase_search', 'browserbase_search', 'wikipedia']);
  const down = async () => { throw new Error('search answered 401'); };
  assert.deepEqual((await lookups(down, wiki)('Habitat')).sources.map((s) => s.via), ['wikipedia'], 'one failure leaves the other');
  assert.equal(await lookups(down, async () => null)('Zzq'), null);
  await assert.rejects(lookups(down, async () => { throw new Error('Wikipedia answered 503'); })('Zzq'), /search answered 401; Wikipedia answered 503/);
});

test('Jev through the model gateway\'s TypeSafe pass-through on the gateway\'s key, or TypeSafe on its own key', () => {
  assert.deepEqual(jevOptionsOf({ AGENT_MODEL_BASE_URL: 'http://gateway:9421/v1', AGENT_MODEL_API_KEY: 'gw' }), { apiKey: 'gw', pricing: { inputUsdPerMillionTokens: 0.042, outputUsdPerMillionTokens: 0 }, baseURL: 'http://gateway:9421/typesafe' });
  assert.equal(jevOptionsOf({ AGENT_MODEL_BASE_URL: 'http://gateway:9421/v1', AGENT_MODEL_API_KEY: 'gw', TYPESAFE_API_KEY: 'ts' }).apiKey, 'ts');
  assert.deepEqual(jevOptionsOf({ TYPESAFE_API_KEY: 'ts' }), { apiKey: 'ts', pricing: { inputUsdPerMillionTokens: 0.042, outputUsdPerMillionTokens: 0 } });
});
