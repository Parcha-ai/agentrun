// A provider's error reaches the harness through the proxy with the provider's credential cut out (a provider echoes a
// wrong key back), then through the host's redactor (ModelProxyOptions.redact) when it has one; a redactor that throws
// leaves the credential's cut. The cut holds no more of an error answer than could still begin the key: an error body
// the provider never finishes reaches the client as it comes. A successful answer passes as it came. No network.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { startModelProxy } from '@parcha/agentrun-kernel/host';

const KEY = 'session-key-for-tests';
const CREDENTIAL = `dummy-provider-secret-${'k'.repeat(12)}`;
const policy = {
  id: 'test',
  routes: [{ method: 'POST', path: '/v1/test' }],
  keyOf: (headers) => String(headers.authorization ?? '').replace(/^Bearer /, ''),
  authHeaders: (credential) => ({ authorization: `Bearer ${credential}` }),
  apply: (body) => body,
  usageOf: () => ({ input: 1, output: 1, cacheRead: 0 }),
};

/** A proxy whose provider answers `status` with `text` under `redact`; the text the client reads back. */
async function answered(t, status, text, redact) {
  const hooks = { beforeRequest: async () => undefined, afterRequest: async () => {} };
  const fetch = async () => new Response(text, { status, headers: { 'content-type': 'application/json' } });
  const p = await startModelProxy({ policy, model: 'm', origin: 'https://provider.invalid', credential: () => CREDENTIAL, hooks, price: () => 0, log: () => {}, fetch, ...(redact ? { redact } : {}) }, KEY);
  t.after(() => p.close());
  const { hostname, port } = new URL(p.url);
  return new Promise((resolve, reject) => {
    const req = request({ host: hostname, port, method: 'POST', path: '/v1/test', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` } }, (res) => {
      let got = '';
      res.setEncoding('utf8');
      res.on('data', (piece) => (got += piece));
      res.on('end', () => resolve({ status: res.statusCode, text: got }));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ model: 'm' }));
  });
}

test("a provider's error answer reaches the harness with the provider's credential cut out, then through the host's redactor; a throwing redactor keeps the cut; a successful answer is left as it came", async (t) => {
  const error = JSON.stringify({ error: { message: `Incorrect API key provided: ${CREDENTIAL}; the org's token tok-ORG-123 has no access` } });
  const cut = await answered(t, 401, error);
  assert.equal(cut.status, 401);
  assert.ok(!cut.text.includes(CREDENTIAL) && cut.text.includes('Incorrect API key provided: [redacted]'), cut.text);
  const redacted = await answered(t, 401, error, (text) => text.replaceAll('tok-ORG-123', '[redacted]'));
  assert.ok(!redacted.text.includes(CREDENTIAL) && !redacted.text.includes('tok-ORG-123'), redacted.text);
  const thrown = await answered(t, 401, error, () => { throw new Error('the redactor failed'); });
  assert.ok(!thrown.text.includes(CREDENTIAL) && thrown.text.includes('tok-ORG-123'), thrown.text);
  const ok = await answered(t, 200, '{"usage":{},"note":"tok-ORG-123"}', (text) => text.replaceAll('tok-ORG-123', '[redacted]'));
  assert.equal(ok.text, '{"usage":{},"note":"tok-ORG-123"}');
});

test("a gateway's error event inside a streamed answer (data: {\"error\": ...}) reaches the client with the credential cut out; the events before it pass as sent", async (t) => {
  const hooks = { beforeRequest: async () => undefined, afterRequest: async () => {} };
  const healthy = 'data: {"id":"c1","choices":[{"delta":{"content":"Hi"}}]}\n\n';
  const failed = `data: {"error":{"message":"Incorrect API key provided: ${CREDENTIAL}","code":401}}\n\n`;
  const fetch = async () => new Response(healthy + failed, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const p = await startModelProxy({ policy, model: 'm', origin: 'https://provider.invalid', credential: () => CREDENTIAL, hooks, price: () => 0, log: () => {}, fetch }, KEY);
  t.after(() => p.close());
  const { hostname, port } = new URL(p.url);
  const got = await new Promise((resolve, reject) => {
    const req = request({ host: hostname, port, method: 'POST', path: '/v1/test', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (piece) => (text += piece));
      res.on('end', () => resolve(text));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ model: 'm' }));
  });
  assert.equal(got, healthy + failed.replace(CREDENTIAL, '[redacted]'));
});

test("an error body the provider never finishes reaches the client as it comes: the cut holds back only what could still begin the key", async (t) => {
  const hooks = { beforeRequest: async () => undefined, afterRequest: async () => {} };
  const fetch = async (_url, init) => new Response(new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('{"error":{"type":"overloaded"'));
      init.signal.addEventListener('abort', () => c.error(new Error('aborted')), { once: true });
    },
  }), { status: 529, headers: { 'content-type': 'application/json' } });
  const p = await startModelProxy({ policy, model: 'm', origin: 'https://provider.invalid', credential: () => CREDENTIAL, hooks, price: () => 0, log: () => {}, fetch }, KEY);
  t.after(() => p.close());
  const { hostname, port } = new URL(p.url);
  const first = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no byte of the error body reached the client')), 5_000);
    const req = request({ host: hostname, port, method: 'POST', path: '/v1/test', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` } }, (res) => {
      res.setEncoding('utf8');
      res.once('data', (piece) => { clearTimeout(timer); req.destroy(); resolve(piece); });
    });
    req.on('error', () => undefined);
    req.end(JSON.stringify({ model: 'm' }));
  });
  assert.equal(first, '{"error":{"type":"overloaded"');
});
