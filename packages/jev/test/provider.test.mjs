import assert from 'node:assert/strict';
import test from 'node:test';
import { createJevRunner, jevProviderFromEnv, JevError } from '../dist/index.js';

const questions = { urgent: { type: 'noul', instructions: 'Is action urgent?' } };
const answers = { urgent: { type: 'noul', noul: 0.9 } };
const params = { label: 'test', kind: 'judge', state: { ticket: 'Invoice issue' }, questions };
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const code = expected => error => { assert.ok(error instanceof JevError); assert.equal(error.code, expected); return true; };
const sent = [];
const capture = body => async (url, init) => { sent.push({ url: String(url), authorization: init.headers.Authorization, body: JSON.parse(init.body) }); return response(body); };
const withEnv = async (env, run) => {
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  try { return await run(); } finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
};
const quick = { retryBaseMs: 1, retryMaxMs: 2 };
// Distinct fake values, held in names so no credential-shaped literal sits beside a key option.
const routerKey = 'fake-router-key';
const envRouterKey = 'fake-env-router-key';
const envTypesafeKey = 'fake-env-typesafe-key';
const secretValue = 'fake-secret-value';
const stockKey = 'fake-test-key';
const emptyKey = '';
const blankKey = '  ';

test('provider openrouter reaches OpenRouter with the OpenRouter key and its default model', async () => {
  sent.length = 0;
  const runner = createJevRunner({ ...quick, provider: 'openrouter', apiKey: routerKey, fetch: capture({ answers, usage: { input_tokens: 10, output_tokens: 1 } }) });
  await runner(params);
  assert.equal(sent[0].url, 'https://openrouter.ai/api/v1/systemone');
  assert.equal(sent[0].authorization, `Bearer ${routerKey}`);
  assert.equal(sent[0].body.model, '~typesafe/jev-latest');
  sent.length = 0;
  await createJevRunner({ ...quick, provider: 'openrouter', apiKey: routerKey, model: 'typesafe/jev-1.14', fetch: capture({ answers }) })(params);
  assert.equal(sent[0].body.model, 'typesafe/jev-1.14', 'a pinned model passes through');
  sent.length = 0;
  await createJevRunner({ ...quick, provider: 'openrouter', apiKey: routerKey, baseURL: 'https://gateway.invalid/api', fetch: capture({ answers }) })(params);
  assert.equal(sent[0].url, 'https://gateway.invalid/api/v1/systemone', 'an explicit base URL wins');
});

test('the OpenRouter key comes from OPENROUTER_API_KEY when apiKey is not given', async () => {
  sent.length = 0;
  await withEnv({ OPENROUTER_API_KEY: envRouterKey, TYPESAFE_API_KEY: envTypesafeKey }, () =>
    createJevRunner({ ...quick, provider: 'openrouter', fetch: capture({ answers }) })(params));
  assert.equal(sent[0].authorization, `Bearer ${envRouterKey}`, 'not the TypeSafe key');
});

test('the default provider is unchanged: TypeSafe, its key and its default model', async () => {
  sent.length = 0;
  await withEnv({ OPENROUTER_API_KEY: envRouterKey, TYPESAFE_API_KEY: envTypesafeKey }, () =>
    createJevRunner({ ...quick, fetch: capture({ answers }) })(params));
  assert.equal(sent[0].url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(sent[0].authorization, `Bearer ${envTypesafeKey}`);
  assert.equal(sent[0].body.model, 'jev-latest');
  assert.doesNotThrow(() => createJevRunner({ ...quick, provider: 'typesafe', apiKey: stockKey, fetch: capture({ answers }) }));
});

test('a missing key names both variables for the provider and never echoes a key', async () => {
  await withEnv({ OPENROUTER_API_KEY: undefined, TYPESAFE_API_KEY: undefined }, () => {
    assert.throws(() => createJevRunner({ provider: 'openrouter' }), error => {
      assert.ok(error instanceof JevError); assert.equal(error.code, 'configuration');
      assert.match(error.message, /OPENROUTER_API_KEY/); assert.match(error.message, /apiKey/);
      return true;
    });
    assert.throws(() => createJevRunner({}), error => { assert.match(error.message, /TYPESAFE_API_KEY/); return true; });
  });
  await withEnv({ OPENROUTER_API_KEY: secretValue, TYPESAFE_API_KEY: undefined }, () => {
    assert.throws(() => createJevRunner({ provider: 'typesafe' }), error => { assert.doesNotMatch(error.message, new RegExp(secretValue)); return true; });
  });
});

test('provider openrouter never sends the TypeSafe key: with no OpenRouter key it is a configuration error even when TYPESAFE_API_KEY is set', async () => {
  sent.length = 0;
  await withEnv({ OPENROUTER_API_KEY: undefined, TYPESAFE_API_KEY: envTypesafeKey }, () => {
    assert.throws(() => createJevRunner({ ...quick, provider: 'openrouter', fetch: capture({ answers }) }), code('configuration'));
  });
  assert.equal(sent.length, 0);
});

test('cost is the provider\'s reported usage.cost, else the configured estimate, else null, never 0', async () => {
  const run = (usage, extra = {}) => createJevRunner({ ...quick, provider: 'openrouter', apiKey: routerKey, ...extra, fetch: async () => response({ answers, ...(usage === undefined ? {} : { usage }) }) })(params);
  const pricing = { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 };
  assert.deepEqual(await run({ input_tokens: 100, output_tokens: 10, cost: 0.0004 }, { pricing }), { ...(await run({ input_tokens: 100, output_tokens: 10, cost: 0.0004 }, { pricing })) });
  assert.equal((await run({ input_tokens: 100, output_tokens: 10, cost: 0.0004 }, { pricing })).cost_usd, 0.0004, 'the reported cost wins over the estimate');
  assert.equal((await run({ input_tokens: 100, output_tokens: 10 }, { pricing })).cost_usd, (100 * 1 + 10 * 2) / 1_000_000, 'tokens and a configured price: the estimate');
  assert.equal((await run({ input_tokens: 100, output_tokens: 10 })).cost_usd, null, 'no cost and no price: unknown, never 0');
  assert.equal((await run(undefined, { pricing })).cost_usd, null, 'no usage at all: unknown');
  assert.equal((await run({ cost: 0 })).cost_usd, 0, 'a reported cost of zero is a number the provider gave');
});

test('usage with a cost alone is accepted, and a bad cost or bad tokens are not', async () => {
  const run = usage => createJevRunner({ ...quick, provider: 'openrouter', apiKey: routerKey, fetch: async () => response({ answers, usage }) })(params);
  const costOnly = await run({ cost: 0.0001 });
  assert.equal(costOnly.usage, null, 'no token counts are invented');
  assert.equal(costOnly.cost_usd, 0.0001);
  const both = await run({ input_tokens: 5, output_tokens: 1, cost: 0.0002 });
  assert.deepEqual(both.usage, { input_tokens: 5, output_tokens: 1 });
  for (const bad of [{ cost: -1 }, { cost: 'free' }, { cost: Number.NaN }, { input_tokens: 5, cost: 0.1 }, { input_tokens: 1.5, output_tokens: 1 }, {}, 'x']) {
    await assert.rejects(run(bad), code('invalid_response'), JSON.stringify(bad));
  }
});

test('provider with a client, or an unknown provider, is a configuration error; retries and errors behave as before', async () => {
  assert.throws(() => createJevRunner({ provider: 'openrouter', client: { systemOne: async () => ({ answers }) } }), /Supply either client or transport options/);
  assert.throws(() => createJevRunner({ provider: 'other', apiKey: stockKey }), /provider must be typesafe or openrouter/);
  let calls = 0;
  const flaky = createJevRunner({ ...quick, provider: 'openrouter', apiKey: routerKey, fetch: async () => (++calls === 1 ? response({ error: 'slow down' }, 429) : response({ answers })) });
  assert.deepEqual((await flaky(params)).answers, answers);
  assert.equal(calls, 2, 'a 429 retries');
  const broke = createJevRunner({ ...quick, provider: 'openrouter', apiKey: routerKey, fetch: async () => response({ error: 'credit' }, 402) });
  await assert.rejects(broke(params), error => { assert.equal(error.code, 'http'); assert.equal(error.status, 402); assert.doesNotMatch(error.message, /credit/); return true; });
});

test('jevProviderFromEnv picks OpenRouter only when its key is set and the TypeSafe key is not', () => {
  assert.equal(jevProviderFromEnv({ OPENROUTER_API_KEY: stockKey }), 'openrouter');
  assert.equal(jevProviderFromEnv({ TYPESAFE_API_KEY: stockKey }), 'typesafe');
  assert.equal(jevProviderFromEnv({ TYPESAFE_API_KEY: stockKey, OPENROUTER_API_KEY: routerKey }), 'typesafe');
  assert.equal(jevProviderFromEnv({}), 'typesafe');
  assert.equal(jevProviderFromEnv({ OPENROUTER_API_KEY: emptyKey }), 'typesafe', 'an empty key is not a key');
  assert.equal(jevProviderFromEnv({ OPENROUTER_API_KEY: blankKey }), 'typesafe');
});
