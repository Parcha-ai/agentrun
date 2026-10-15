// The hero's live path, checked without running it: its configuration from the environment, the eyes and the lead's models built the way the broker takes
// them, and `--see` refusing until agentrun #506 lands. Nothing here starts a browser or a model.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { liveBrowser, liveConfig, liveEyes, liveModels } from './hero/live.ts';
import { heroRun } from './hero/run.ts';

const here = process.execPath; // a file that exists, standing in for a Chrome binary

test('liveConfig --chrome: a Chrome is required, and only for the loopback fixtures', () => {
  assert.throws(() => liveConfig({}, 'chrome'), /set CHROME_PATH/);
  assert.throws(() => liveConfig({ CHROME_PATH: '/no/such/chrome' }, 'chrome'), /set CHROME_PATH/);
  assert.equal(liveConfig({ CHROME_PATH: here }, 'chrome').chrome, here);
  assert.equal(liveConfig({ CHROME_PATH: here }, 'chrome').browserbase, false);
});

test('liveConfig --live: it needs the go-ahead, the browser is Browserbase and nothing else, the key is in the environment, and no message prints it', () => {
  assert.throws(() => liveConfig({ CHROME_PATH: here, HERO_LIVE_SPEND_OK: '1' }, 'live'), /PI_BROWSER_PROVIDER=browserbase/, 'a local Chrome never visits a real page');
  assert.throws(() => liveConfig({ HERO_LIVE_SPEND_OK: '1', PI_BROWSER_PROVIDER: 'cdp', BROWSERBASE_API_KEY: 'bb_secret_value' }, 'live'), (error) => /PI_BROWSER_PROVIDER=browserbase/.test(error.message) && !error.message.includes('bb_secret_value'));
  assert.throws(() => liveConfig({ HERO_LIVE_SPEND_OK: '1', PI_BROWSER_PROVIDER: 'browserbase' }, 'live'), /BROWSERBASE_API_KEY/);
  const config = liveConfig({ HERO_LIVE_SPEND_OK: '1', PI_BROWSER_PROVIDER: 'browserbase', BROWSERBASE_API_KEY: 'bb_secret_value' }, 'live');
  assert.deepEqual(config, { browserbase: true, broker: 'http://127.0.0.1:9421/v1', eyes: 'openrouter/google/gemini-3.7-flash', lead: 'openai/gpt-6-luna', leadPrice: null });
  assert.ok(!JSON.stringify(config).includes('bb_secret_value'), 'the config never holds the key');
  assert.deepEqual(liveConfig({ HERO_LIVE_SPEND_OK: '1', PI_BROWSER_PROVIDER: 'browserbase', BB_API_KEY: 'x', HERO_BROKER_URL: 'http://127.0.0.1:1/v1', HERO_EYES: 'openrouter/a/b', HERO_LEAD: 'openrouter/c/d', HERO_LEAD_PRICE: '1.5, 6' }, 'live'),
    { browserbase: true, broker: 'http://127.0.0.1:1/v1', eyes: 'openrouter/a/b', lead: 'openrouter/c/d', leadPrice: { input: 1.5, output: 6 } });
});

test('the live browser is Browserbase on its list prices, built without a network call; it takes no fixture pages', async () => {
  const config = liveConfig({ HERO_LIVE_SPEND_OK: '1', PI_BROWSER_PROVIDER: 'browserbase', BROWSERBASE_API_KEY: 'x' }, 'live');
  const { browser, close } = await liveBrowser({ id: 'r', root: '/tmp/none', work: '/tmp/none/work', store: '/tmp/none/store' }, config, { env: { BROWSERBASE_API_KEY: 'x' } });
  const provider = await browser.provider({ conversationId: 1, plane: 'default', config: {} });
  assert.equal(provider.name, 'browserbase');
  assert.equal(browser.prices, undefined, 'the host\'s zero prices are for fakes: a live session is priced');
  close();
  await assert.rejects(() => liveBrowser({ id: 'r', root: '/tmp/none', work: '/tmp/none/work', store: '/tmp/none/store' }, config, { pages: {} }), /does not serve fixture pages/);
});

test('the eyes are the catalog entry at the broker, and a model that takes no images is refused', () => {
  const config = liveConfig({ CHROME_PATH: here }, 'chrome');
  const eyes = liveEyes(config);
  assert.equal(eyes.model, 'google/gemini-3.7-flash');
  assert.equal(eyes.accepts.image, true);
  assert.throws(() => liveEyes({ ...config, eyes: 'openrouter/no/such-model' }), /no model/);
  assert.throws(() => liveEyes({ ...config, eyes: 'nonsense' }), /not <provider>\/<model id>/);
});

test('--see waits on agentrun #506: the run refuses it and says why, before anything starts', { timeout: 60_000 }, async (t) => {
  const run = await heroRun({ see: true });
  t.after(() => run.cleanup());
  assert.equal(run.processes[0].outcome, undefined);
  assert.match(run.processes[0].stderr, /#506/);
});

/** A loopback broker that answers every chat request with one line, and keeps what it was asked. */
async function broker(t) {
  const { createServer } = await import('node:http');
  const seen = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      seen.push({ url: request.url, auth: request.headers.authorization, model: JSON.parse(body || '{}').model });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'x', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      response.end(chunk({ role: 'assistant', content: 'seen at the broker' }) + chunk({}, 'stop') + 'data: [DONE]\n\n');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}/v1`, seen };
}

const ask = async (config) => {
  const { catalog, lead } = liveModels(config);
  return { lead, model: catalog.getModel(lead.provider, lead.modelId), answer: await catalog.complete(catalog.getModel(lead.provider, lead.modelId), { messages: [{ role: 'user', content: 'hi', timestamp: 0 }] }) };
};

test('the default lead, openai/gpt-6-luna, is the broker\'s model id: the catalog\'s OpenRouter entry for it gives its price, and the broker is sent that id and the placeholder key', { timeout: 60_000 }, async (t) => {
  const loopback = await broker(t);
  const config = liveConfig({ CHROME_PATH: here, HERO_BROKER_URL: loopback.url }, 'chrome');
  assert.equal(config.lead, 'openai/gpt-6-luna');
  const { lead, model, answer } = await ask(config);
  assert.deepEqual(lead, { provider: 'broker', modelId: 'openai/gpt-6-luna' });
  assert.deepEqual([model.api, model.baseUrl, model.cost.input, model.cost.output], ['openai-completions', loopback.url, 0.1, 0.5]);
  assert.equal(answer.stopReason, 'stop', String(answer.errorMessage ?? ''));
  assert.match(answer.content.map((block) => block.text ?? '').join(''), /seen at the broker/);
  assert.deepEqual(loopback.seen.map((request) => [request.url, request.auth, request.model]), [['/v1/chat/completions', 'Bearer placeholder', 'openai/gpt-6-luna']]);
});

test('a broker model id pi-ai\'s catalog does not know is built by the host: unpriced unless HERO_LEAD_PRICE says so, and sent as written', { timeout: 60_000 }, async (t) => {
  const loopback = await broker(t);
  const unpriced = await ask(liveConfig({ CHROME_PATH: here, HERO_BROKER_URL: loopback.url, HERO_LEAD: 'acme/not-in-the-catalog' }, 'chrome'));
  assert.deepEqual([unpriced.model.cost.input, unpriced.model.cost.output, unpriced.model.api], [0, 0, 'openai-completions']);
  const priced = liveModels(liveConfig({ CHROME_PATH: here, HERO_LEAD: 'acme/not-in-the-catalog', HERO_LEAD_PRICE: '0.4,1.6' }, 'chrome'));
  const model = priced.catalog.getModel(priced.lead.provider, priced.lead.modelId);
  assert.deepEqual([model.cost.input, model.cost.output], [0.4, 1.6]);
  assert.equal(unpriced.answer.stopReason, 'stop', String(unpriced.answer.errorMessage ?? ''));
  assert.deepEqual(loopback.seen.map((request) => request.model), ['acme/not-in-the-catalog']);
});

test('the other option, google/gemini-3.7-flash on the OpenRouter entry, is the catalog\'s model at the broker: its own definition, the broker\'s base URL, the same placeholder key', { timeout: 60_000 }, async (t) => {
  const loopback = await broker(t);
  const { lead, model, answer } = await ask(liveConfig({ CHROME_PATH: here, HERO_BROKER_URL: loopback.url, HERO_LEAD: 'openrouter/google/gemini-3.7-flash' }, 'chrome'));
  assert.deepEqual(lead, { provider: 'broker', modelId: 'google/gemini-3.7-flash' });
  assert.deepEqual([model.baseUrl, model.cost.input > 0, model.input], [loopback.url, true, ['text', 'image']], 'the catalog\'s own price and abilities');
  assert.equal(answer.stopReason, 'stop', String(answer.errorMessage ?? ''));
  assert.deepEqual(loopback.seen.map((request) => [request.url, request.auth, request.model]), [['/v1/chat/completions', 'Bearer placeholder', 'google/gemini-3.7-flash']]);
});
