// The host's prompt choice before a run: Jev's pass on the input, the lookup when it is unsure, and the generic prompt
// when it stays unsure or anything fails. Offline: Jev and Wikipedia are fakes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composePrompt, GENERIC, jevOptionsOf, lookups, overlayOf, promptForRun, searchLookup, selectPrompt, wikipediaLookup } from './select.ts';

const prompts = {
  question: { id: 'kind', instructions: 'What kind of organisation is it?', criteria: { public: 'listed', nonprofit: 'charity', other: 'anything else' } },
  variants: [
    { id: 'base', role: 'base', label: 'Base', text: 'Research it.' },
    { id: 'public', role: 'overlay', label: 'Public company', text: 'Start at EDGAR.', when: { question: 'kind', option: 'public', threshold: 0.8 } },
    { id: 'nonprofit', role: 'overlay', label: 'Non-profit', text: 'Start at the 990s.', when: { question: 'kind', option: 'nonprofit', threshold: 0.9 } },
    { id: 'generic', role: 'generic', label: 'Not sure', text: 'Start at its own site.' },
  ],
};

const pass = (choice, p, confidence = p) => ({ choice, probabilities: { public: 0, nonprofit: 0, other: 0, [choice]: p }, confidence });

/** A fake Jev that answers each call with the next pass, and keeps the states it was asked about. */
function jev(...answers) {
  const asked = [];
  const judge = async (params) => {
    asked.push(params);
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return { answers: { kind: { type: 'choice', ...next } }, model: 'jev-test', usage: null, cost_usd: null, request_sha256: 'x' };
  };
  return { judge, asked };
}

test('a sure first pass picks its overlay, and no lookup runs', async () => {
  const { judge, asked } = jev(pass('public', 0.97));
  let looked = 0;
  const chosen = await selectPrompt({ input: 'Caterpillar Inc.', prompts, judge, lookup: async () => (looked++, null) });
  assert.equal(chosen.variant, 'public');
  assert.deepEqual(chosen.lookup, { used: false, sources: [] });
  assert.equal(chosen.passes.length, 1);
  assert.equal(looked, 0);
  assert.deepEqual(asked[0].state, { input: 'Caterpillar Inc.' });
  assert.deepEqual(Object.keys(asked[0].questions), ['kind']);
  assert.equal(asked[0].questions.kind.type, 'choice');
  assert.match(chosen.reason, /public at 97%/);
});

test('each overlay has its own threshold: the top option under it goes to the lookup', async () => {
  assert.equal(overlayOf(prompts, pass('nonprofit', 0.85)), null, '0.85 is under nonprofit\'s 0.9');
  assert.equal(overlayOf(prompts, pass('public', 0.85)).id, 'public', '0.85 meets public\'s 0.8');
  assert.equal(overlayOf(prompts, pass('other', 0.99)), null, 'an option with no overlay never picks one');
});

test('unsure, then sure after the lookup: the overlay, with the lookup and both passes recorded', async () => {
  const { judge, asked } = jev(pass('nonprofit', 0.53, 0.41), pass('nonprofit', 0.95));
  const sources = [{ via: 'wikipedia', url: 'https://en.wikipedia.org/wiki/Habitat_for_Humanity', title: 'Habitat for Humanity' }];
  const chosen = await selectPrompt({ input: 'Habitat', prompts, judge, lookup: async () => ({ text: 'A housing charity.', sources }) });
  assert.equal(chosen.variant, 'nonprofit');
  assert.deepEqual(chosen.lookup, { used: true, sources });
  assert.deepEqual(chosen.passes.map((p) => [p.choice, p.probabilities.nonprofit, p.confidence]), [['nonprofit', 0.53, 0.41], ['nonprofit', 0.95, 0.95]]);
  assert.deepEqual(asked[1].state, { input: 'Habitat', lookup: 'A housing charity.' });
  assert.match(chosen.reason, /nonprofit at 53%, under 90%.*after the lookup, Jev: nonprofit at 95%/);
});

test('a sure "other" (no overlay) still gets its lookup, and stays generic when Jev stays there', async () => {
  const { judge } = jev(pass('other', 0.96), pass('other', 0.9));
  const sources = [{ via: 'wikipedia', url: 'https://en.wikipedia.org/wiki/Cargill', title: 'Cargill' }];
  const chosen = await selectPrompt({ input: 'Cargill', prompts, judge, lookup: async () => ({ text: 'A private company.', sources }) });
  assert.equal(chosen.variant, GENERIC);
  assert.equal(chosen.passes.length, 2);
  assert.deepEqual(chosen.lookup, { used: true, sources });
  assert.match(chosen.reason, /other at 96% \(no prompt for it\).*so the generic prompt$/);
});

test('a lookup that finds nothing or fails, or a Jev that fails, gives the generic prompt and says why', async () => {
  const none = await selectPrompt({ input: 'Zzq', prompts, judge: jev(pass('other', 0.5)).judge, lookup: async () => null });
  assert.deepEqual([none.variant, none.lookup, none.passes.length], [GENERIC, { used: true, sources: [] }, 1]);
  assert.match(none.reason, /the lookup found nothing; so the generic prompt$/);

  const broken = await selectPrompt({ input: 'Zzq', prompts, judge: jev(pass('other', 0.5)).judge, lookup: async () => { throw new Error('Wikipedia answered 503'); } });
  assert.equal(broken.variant, GENERIC);
  assert.match(broken.reason, /the lookup failed \(Wikipedia answered 503\); so the generic prompt$/);

  const down = await selectPrompt({ input: 'Zzq', prompts, judge: jev(new Error('connection refused')).judge, lookup: async () => assert.fail('no lookup when Jev is down') });
  assert.deepEqual([down.variant, down.passes, down.lookup.used], [GENERIC, [], false]);
  assert.match(down.reason, /Jev failed \(connection refused\)/);

  const second = await selectPrompt({ input: 'Zzq', prompts, judge: jev(pass('other', 0.5), new Error('timeout')).judge, lookup: async () => ({ text: 'x', sources: [{ via: 'wikipedia', url: 'https://en.wikipedia.org/wiki/Zzq', title: 'Zzq' }] }) });
  assert.deepEqual([second.variant, second.passes.length, second.lookup.sources.map((s) => s.url)], [GENERIC, 1, ['https://en.wikipedia.org/wiki/Zzq']]);
  assert.match(second.reason, /Jev failed after the lookup \(timeout\)/);
});

test('the run\'s guide is the base and then the chosen variant', () => {
  assert.equal(composePrompt(prompts, 'public'), 'Research it.\n\nStart at EDGAR.');
  assert.equal(composePrompt(prompts, GENERIC), 'Research it.\n\nStart at its own site.');
  assert.throws(() => composePrompt(prompts, 'base'), /no variant base/);
  assert.throws(() => composePrompt(prompts, 'ecommerce'), /no variant ecommerce/);
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

test('the run\'s prompt from the home\'s variants (a record by id): what startRun records and what prompt.json holds', async () => {
  const stored = Object.fromEntries(prompts.variants.map(({ id, ...variant }) => [id, variant]));
  const sources = [{ via: 'browserbase_search', url: 'https://www.habitat.org/', title: 'Habitat for Humanity' }];
  const now = () => new Date('2026-10-20T04:00:00.000Z');
  const { judge } = jev(pass('nonprofit', 0.53, 0.41), pass('nonprofit', 0.95));
  const chosen = await promptForRun({ stored, question: prompts.question, input: 'Habitat', judge, lookup: async () => ({ text: 'A housing charity.', sources }), now });
  assert.deepEqual(chosen.prompt, { id: 'nonprofit', reason: chosen.record.reason });
  assert.deepEqual({ ...chosen.record, passes: chosen.record.passes.map(({ latency_ms, ...rest }) => (assert.equal(typeof latency_ms, 'number'), rest)) }, {
    version: 1,
    question: 'kind',
    input: 'Habitat',
    variant: 'nonprofit',
    passes: [{ ...pass('nonprofit', 0.53, 0.41), model: 'jev-test', cost_usd: null }, { ...pass('nonprofit', 0.95), model: 'jev-test', cost_usd: null }],
    lookup: { used: true, sources },
    reason: 'Jev: nonprofit at 53%, under 90%; after the lookup, Jev: nonprofit at 95%',
    selected_at: '2026-10-20T04:00:00.000Z',
  });

  const sure = await promptForRun({ stored, question: prompts.question, input: 'Caterpillar Inc.', judge: jev(pass('public', 1)).judge, lookup: async () => assert.fail('no lookup'), now });
  assert.deepEqual([sure.prompt.id, sure.record.variant, sure.record.lookup.used, sure.record.passes.length], ['public', 'public', false, 1]);
  const { generic: _, ...overlays } = stored;
  const none = await promptForRun({ stored: { ...overlays, plain: { role: 'generic', label: 'Plain', text: 'Look around.' } }, question: prompts.question, input: 'Zzq', judge: jev(new Error('down')).judge, lookup: async () => null, now });
  assert.deepEqual([none.prompt.id, none.record.variant, none.record.passes], ['plain', 'plain', []], 'the generic is the set\'s own, by its role');

  assert.equal(await promptForRun({ stored: {}, question: prompts.question, input: 'x', judge, lookup: async () => null }), null, 'a home with no variants');
  assert.equal(await promptForRun({ stored, question: null, input: 'x', judge, lookup: async () => null }), null, 'an agent with no question');
});
