// When the host passes no fetch, Jev's requests to TypeSafe never follow a redirect. The default fetch sends each one
// with redirect "error". A 307 from TypeSafe's address to another port fails the decision, and the other port never
// sees a request, so it never sees the key. Both servers are on loopback, and the key is a canary.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { jevProvider } from '../dist/index.js';

const KEY = 'jev-redirect-canary-0123456789';
const ctx = () => ({ decisionId: 'decision-1', signal: new AbortController().signal, deadlineMs: 5000 });
const request = { label: 'x', kind: 'judge', state: {}, questions: { holds: { type: 'noul', instructions: 'Does it hold?' } } };

/** Two loopback servers: `from` answers every request with a 307 to `to`, which records what reaches it. */
async function redirecting(t) {
  const reached = [];
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
    req.resume();
    res.writeHead(307, { location: `${toUrl}${req.url}` }).end();
  });
  return { fromUrl: `http://127.0.0.1:${from.address().port}`, reached };
}

test("Jev's request to TypeSafe refuses a 307 to another port when the host passes no fetch, and the other port never sees it", async (t) => {
  const { fromUrl, reached } = await redirecting(t);
  const jev = jevProvider({ apiKey: KEY, baseURL: fromUrl, maxAttempts: 2, retryBaseMs: 1, retryMaxMs: 2 });
  await assert.rejects(jev.decide(request, ctx()), 'Jev: the decision fails');
  assert.equal(reached.length, 0, "Jev: the redirect's target never sees a request");
  assert.ok(!JSON.stringify(reached).includes(KEY), "Jev: the redirect's target never sees the key");
});
