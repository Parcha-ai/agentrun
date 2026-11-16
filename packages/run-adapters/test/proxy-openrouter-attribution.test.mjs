// AgentRun's OpenRouter app attribution (host/openrouter-attribution.ts) on the model proxy every harness's requests go
// through: a proxy whose upstream is OpenRouter's origin sends HTTP-Referer, X-OpenRouter-Title and
// X-OpenRouter-Categories with each request, never X-OpenRouter-App-Visibility; one whose upstream is any other provider
// (Anthropic, OpenAI, a ChatGPT plan, a gateway) sends none; AGENTRUN_OPENROUTER_ATTRIBUTION=off where the proxy starts
// sends none to OpenRouter either. A client's own attribution headers never reach the provider. No network: the provider
// is a fake fetch.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as host from '@parcha/agentrun-kernel/host';

const { startModelProxy, openRouterAttribution, OPENROUTER_APP } = host;
const KEY = 'session-key-for-tests';
const NAMES = ['http-referer', 'x-openrouter-title', 'x-openrouter-categories', 'x-openrouter-app-visibility', 'x-title'];
const URL_ID = 'https://github.com/Parcha-ai/agentrun';
const ATTRIBUTED = { 'http-referer': URL_ID, 'x-openrouter-title': 'AgentRun', 'x-openrouter-categories': 'cloud-agent,personal-agent' };
const policy = {
  id: 'test',
  routes: [{ method: 'POST', path: '/v1/test', headers: ['http-referer', 'x-title'] }],
  keyOf: (headers) => String(headers.authorization ?? '').replace(/^Bearer /, ''),
  authHeaders: (credential) => ({ authorization: `Bearer ${credential}` }),
  apply: (body) => ({ ...body, model: 'session-model' }),
  usageOf: () => undefined,
};

/** The attribution headers one request through a proxy over `origin` reached the provider with; `env`, the proxy's
 *  environment as it starts. `clientHeaders`: what the client itself sent. */
async function sentThrough(t, origin, env = {}, clientHeaders = {}) {
  const sent = [];
  const fetch = async (url, init) => {
    const headers = new Headers(init.headers);
    sent.push({ url: String(url), headers: Object.fromEntries(NAMES.flatMap((name) => (headers.has(name) ? [[name, headers.get(name)]] : []))) });
    return Response.json({ ok: true });
  };
  const saved = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
  Object.assign(process.env, env);
  let p;
  try {
    p = await startModelProxy({
      policy, model: 'session-model', origin, credential: () => 'fake-provider-credential', price: () => 0, log: () => {},
      hooks: { beforeRequest: async () => ({}), afterRequest: async () => {} }, fetch,
    }, KEY);
  } finally {
    for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  t.after(() => p.close());
  const res = await globalThis.fetch(`${p.url}/v1/test`, { method: 'POST', headers: { ...clientHeaders, 'content-type': 'application/json', authorization: `Bearer ${KEY}` }, body: '{}' });
  assert.equal(res.status, 200);
  await res.text();
  assert.equal(sent.length, 1);
  return sent[0].headers;
}

test("OpenRouter's origin, with or without /v1: each request carries AgentRun's attribution, and no visibility header", async (t) => {
  assert.deepEqual(await sentThrough(t, 'https://openrouter.ai/api'), ATTRIBUTED);
  assert.deepEqual(await sentThrough(t, 'https://openrouter.ai/api/v1'), ATTRIBUTED);
});

test('no other provider gets them: Anthropic, OpenAI, a ChatGPT plan, a gateway (one in front of OpenRouter included)', async (t) => {
  for (const origin of ['https://api.anthropic.com', 'https://api.openai.com', 'https://chatgpt.com/backend-api/codex', 'https://gateway.example/api', 'https://openrouter.ai.gateway.example']) {
    assert.deepEqual(await sentThrough(t, origin), {}, origin);
  }
});

test("a client's own attribution headers never reach a provider: AgentRun's replace them on OpenRouter's", async (t) => {
  const client = { 'HTTP-Referer': 'https://client.example', 'X-Title': 'client' };
  const onOpenRouter = await sentThrough(t, 'https://openrouter.ai/api', {}, client);
  assert.equal(onOpenRouter['http-referer'], URL_ID);
  assert.equal(onOpenRouter['x-openrouter-title'], 'AgentRun');
});

test('AGENTRUN_OPENROUTER_ATTRIBUTION=off where the proxy starts: OpenRouter gets no attribution header', async (t) => {
  const headers = await sentThrough(t, 'https://openrouter.ai/api', { AGENTRUN_OPENROUTER_ATTRIBUTION: 'off' });
  assert.equal(headers['http-referer'], undefined);
  assert.equal(headers['x-openrouter-title'], undefined);
  assert.equal(headers['x-openrouter-categories'], undefined);
});

test("the values: the URL AgentRun's app page exists under, the name, two of OpenRouter's own categories; off in any case turns them off", () => {
  assert.deepEqual(OPENROUTER_APP, { url: URL_ID, title: 'AgentRun', categories: 'cloud-agent,personal-agent' });
  assert.ok(OPENROUTER_APP.categories.split(',').length <= 2);
  for (const off of ['off', 'OFF', ' Off ']) assert.deepEqual(openRouterAttribution({ AGENTRUN_OPENROUTER_ATTRIBUTION: off }), {});
  for (const on of [undefined, '', 'on', '1']) assert.equal(Object.keys(openRouterAttribution({ AGENTRUN_OPENROUTER_ATTRIBUTION: on })).length, 3, String(on));
});
