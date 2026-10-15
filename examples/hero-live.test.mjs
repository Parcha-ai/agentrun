// The hero's live path, checked without running it: its configuration from the environment, the eyes and the lead's models built the way the broker takes
// them, and `--see` refusing until agentrun #506 lands. Nothing here starts a browser or a model.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { liveConfig, liveEyes, liveModels } from './hero/live.ts';
import { heroRun } from './hero/run.ts';

const here = process.execPath; // a file that exists, standing in for a Chrome binary

test('liveConfig: a Chrome is required, the broker and the models default to the machine\'s, and the environment overrides them', () => {
  assert.throws(() => liveConfig({}), /set CHROME_PATH/);
  assert.throws(() => liveConfig({ CHROME_PATH: '/no/such/chrome' }), /set CHROME_PATH/);
  assert.deepEqual(liveConfig({ CHROME_PATH: here }), { chrome: here, broker: 'http://127.0.0.1:9421/v1', eyes: 'openrouter/google/gemini-3.7-flash', lead: 'openrouter/google/gemini-3.7-flash' });
  assert.deepEqual(liveConfig({ CHROME_PATH: here, HERO_BROKER_URL: 'http://127.0.0.1:1/v1', HERO_EYES: 'openrouter/a/b', HERO_LEAD: 'openrouter/c/d' }), { chrome: here, broker: 'http://127.0.0.1:1/v1', eyes: 'openrouter/a/b', lead: 'openrouter/c/d' });
  assert.ok(existsSync(here));
});

test('the eyes are the catalog entry at the broker, and a model that takes no images is refused', () => {
  const config = liveConfig({ CHROME_PATH: here });
  const eyes = liveEyes(config);
  assert.equal(eyes.model, 'google/gemini-3.7-flash');
  assert.equal(eyes.accepts.image, true);
  assert.throws(() => liveEyes({ ...config, eyes: 'openrouter/no/such-model' }), /no model/);
  assert.throws(() => liveEyes({ ...config, eyes: 'nonsense' }), /not <provider>\/<model id>/);
});

test('the lead\'s models are one provider whose model is the catalog entry', () => {
  const { catalog, lead } = liveModels(liveConfig({ CHROME_PATH: here }));
  assert.deepEqual(lead, { provider: 'broker', modelId: 'google/gemini-3.7-flash' });
  const model = catalog.getModel(lead.provider, lead.modelId);
  assert.equal(model?.id, 'google/gemini-3.7-flash');
  assert.equal(model?.baseUrl, 'http://127.0.0.1:9421/v1');
});

test('--see waits on agentrun #506: the run refuses it and says why, before anything starts', { timeout: 60_000 }, async (t) => {
  const run = await heroRun({ see: true });
  t.after(() => run.cleanup());
  assert.equal(run.processes[0].outcome, undefined);
  assert.match(run.processes[0].stderr, /#506/);
});

test('the lead\'s model is reached at the broker\'s base URL with the placeholder key: a loopback broker sees the request and its answer comes back', { timeout: 60_000 }, async (t) => {
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
  const { catalog, lead } = liveModels(liveConfig({ CHROME_PATH: here, HERO_BROKER_URL: `http://127.0.0.1:${server.address().port}/v1` }));
  const answer = await catalog.complete(catalog.getModel(lead.provider, lead.modelId), { messages: [{ role: 'user', content: 'hi', timestamp: 0 }] });
  assert.equal(answer.stopReason, 'stop', JSON.stringify(answer.errorMessage ?? ''));
  assert.match(answer.content.map((block) => block.text ?? '').join(''), /seen at the broker/);
  assert.deepEqual(seen.map((request) => [request.url, request.auth, request.model]), [['/v1/chat/completions', 'Bearer placeholder', 'google/gemini-3.7-flash']]);
});
