// A keyed decision request never follows a redirect: Anthropic's and Parallel's x-api-key and OpenRouter's bearer are
// sent with redirect "error". A 307 from the provider's address to another port fails the decision, and the other port
// never sees a request, so never the key. Both servers are on loopback; the keys are canaries.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { anthropicProvider, openrouterProvider, parallelProvider } from '../dist/index.js';

const KEY = 'decisions-redirect-canary-0123456789';
const ctx = () => ({ decisionId: 'decision-1', signal: new AbortController().signal, deadlineMs: 5000 });
const request = { label: 'x', kind: 'judge', state: {}, questions: { holds: { type: 'noul', instructions: 'Does it hold?' } } };
const retries = { retryBaseMs: 1, retryMaxMs: 2, maxAttempts: 2 };

/** Two loopback servers: `from` counts each request and answers it with a 307 to `to`, which records what reaches it. */
async function redirecting(t) {
  const reached = [];
  let sent = 0;
  const listen = (handler) => new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
    t.after(() => new Promise((done) => server.close(done)));
  });
  const to = await listen((req, res) => {
    reached.push({ url: req.url, headers: req.headers });
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
  const toUrl = `http://127.0.0.1:${to.address().port}`;
  const from = await listen((req, res) => {
    sent += 1;
    req.resume();
    res.writeHead(307, { location: `${toUrl}${req.url}` }).end();
  });
  return { fromUrl: `http://127.0.0.1:${from.address().port}`, reached, sent: () => sent };
}

for (const [who, make] of [
  ['Anthropic', (baseURL) => anthropicProvider({ apiKey: KEY, baseURL, ...retries })],
  ['Parallel', (baseURL) => parallelProvider({ apiKey: KEY, baseURL, ...retries })],
  ['OpenRouter', (baseURL) => openrouterProvider({ apiKey: KEY, baseURL, model: 'liquid/d1', ...retries })],
]) {
  test(`${who}'s keyed decision refuses a 307 to another port, and the other port never sees the key`, async (t) => {
    const { fromUrl, reached, sent } = await redirecting(t);
    await assert.rejects(make(fromUrl).decide(request, ctx()), `${who}: the decision fails`);
    assert.ok(sent() > 0, `${who}: the request reached the redirecting address`);
    assert.equal(reached.length, 0, `${who}: the redirect's target never sees a request`);
    assert.ok(!JSON.stringify(reached).includes(KEY), `${who}: the redirect's target never sees the key`);
  });
}
