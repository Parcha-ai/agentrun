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

const { errorCut, echoForms } = await import('../dist/host/proxy.js');

/** A proxy whose provider answers `status` with `text` under `redact`; the text the client reads back. `pieces`: the
 *  answer's chunks, each its own (default the whole text); `contentType` and the host's `headers` as given. */
async function answered(t, status, text, redact, { pieces, contentType = 'application/json', headers } = {}) {
  const hooks = { beforeRequest: async () => undefined, afterRequest: async () => {} };
  const fetch = async () => new Response(new ReadableStream({
    start(c) {
      for (const piece of pieces ?? [text]) c.enqueue(new TextEncoder().encode(piece));
      c.close();
    },
  }), { status, headers: { 'content-type': contentType } });
  const p = await startModelProxy({ policy, model: 'm', origin: 'https://provider.invalid', credential: () => CREDENTIAL, hooks, price: () => 0, log: () => {}, fetch, ...(redact ? { redact } : {}), ...(headers ? { headers } : {}) }, KEY);
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

test("a value only the host's redactor knows is cut from an error answer wherever a chunk boundary falls in it", async (t) => {
  const body = JSON.stringify({ error: { message: "the org's token tok-ORG-123 has no access to this model" } });
  const redact = (text) => text.replaceAll('tok-ORG-123', '[redacted]');
  const at = body.indexOf('tok-ORG-123');
  for (let split = at + 1; split < at + 'tok-ORG-123'.length; split++) {
    const got = await answered(t, 403, body, redact, { pieces: [body.slice(0, split), body.slice(split)] });
    assert.ok(!got.text.includes('tok-ORG-123') && got.text.includes('[redacted]'), `split at ${split}: ${got.text}`);
  }
});

test("an error event reaches the client cut whatever its layout: the type after the message, an id line or a comment before the event's name", async (t) => {
  const healthy = 'data: {"type":"response.created","response":{"id":"r1"}}\n\n';
  for (const event of [
    `data: {"message":"Incorrect API key provided: ${CREDENTIAL}","type":"error"}\n\n`,
    `id: 7\nevent: error\ndata: {"type":"error","error":{"message":"bad key ${CREDENTIAL}"}}\n\n`,
    `: keepalive\nevent: error\ndata: {"type":"error","error":{"message":"bad key ${CREDENTIAL}"}}\n\n`,
    `data: {"response":{"status":"failed","error":{"message":"bad key ${CREDENTIAL}"}},"type":"response.failed"}\n\n`,
  ]) {
    for (const pieces of [undefined, [...(healthy + event)]]) {
      const got = await answered(t, 200, healthy + event, undefined, { pieces, contentType: 'text/event-stream' });
      assert.ok(!got.text.includes(CREDENTIAL) && got.text.includes('[redacted]') && got.text.startsWith(healthy), JSON.stringify(got.text));
    }
  }
});

test("a header value the host added, with a quote and a slash, is cut in its JSON-escaped and slash-escaped spelling", async (t) => {
  const TAG = 'dummy-tag/with"quote-0123';
  const encoded = JSON.stringify({ error: { message: `unknown tag ${TAG}` } }).replaceAll('/', '\\/');
  assert.ok(encoded.includes('dummy-tag\\/with\\"quote-0123'), 'the provider spells it with both escapes');
  const got = await answered(t, 400, encoded, undefined, { headers: { 'x-host-tag': TAG } });
  assert.ok(!got.text.includes('dummy-tag\\/with\\"quote-0123') && got.text.includes('[redacted]'), got.text);
  assert.ok(echoForms([TAG]).includes('dummy-tag\\/with\\"quote-0123'));
});

/** The most of the input the relay holds at any moment, fed `pieces`. */
function mostHeld(relay, pieces) {
  let fed = 0;
  let out = 0;
  let most = 0;
  for (const piece of pieces) {
    fed += piece.length;
    out += relay.push(piece).length;
    most = Math.max(most, fed - out);
  }
  return { most, rest: relay.end() };
}

test("the relay holds a bounded part of a long answer: a successful stream with no line ends, and an error event that never ends, are both passed on as they come", () => {
  const piece = 'x'.repeat(64 * 1024);
  const healthy = mostHeld(errorCut('events', echoForms([CREDENTIAL]), undefined, () => {}), Array.from({ length: 64 }, () => piece));
  assert.ok(healthy.most <= 128 * 1024, `a stream with no line ends: at most ${healthy.most} characters held`);
  const said = [];
  const failed = mostHeld(errorCut('events', echoForms([CREDENTIAL]), (text) => text, (m) => said.push(m)), ['event: error\ndata: {"type":"error","message":"', `bad key ${CREDENTIAL} `, ...Array.from({ length: 64 }, () => piece)]);
  assert.ok(failed.most <= 128 * 1024, `an error event that never ends: at most ${failed.most} characters held`);
});

test("events end at every line end the format has, LF, CRLF and a bare CR, wherever a chunk boundary falls: a healthy event goes out as it ends, and an error event is cut", () => {
  for (const nl of ['\n', '\r\n', '\r']) {
    const healthy = `data: {"type":"response.created"}${nl}${nl}`;
    const failed = `event: error${nl}data: {"type":"error","message":"bad key ${CREDENTIAL}"}${nl}${nl}`;
    for (let split = 0; split <= healthy.length + failed.length; split++) {
      const answer = healthy + failed;
      const relay = errorCut('events', echoForms([CREDENTIAL]), undefined, () => {});
      const first = relay.push(answer.slice(0, split));
      const out = first + relay.push(answer.slice(split));
      // Whole by the time the answer's last piece is in: nothing waits for an end the stream never sends.
      assert.ok(out.startsWith(healthy), `${JSON.stringify(nl)} split ${split}: the healthy event went out: ${JSON.stringify(out)}`);
      assert.ok(out.includes('[redacted]') && !out.includes(CREDENTIAL), `${JSON.stringify(nl)} split ${split}: the error event went out cut: ${JSON.stringify(out)}`);
      assert.equal(relay.end(), '', `${JSON.stringify(nl)} split ${split}: nothing left for the end`);
    }
  }
});

test("no event's name exempts its data: an error under a healthy event name is cut, the host's redactor included, and a healthy event whose data echoes the credential is cut too, wherever a chunk boundary falls", async (t) => {
  const redact = (text) => text.replaceAll('tok-ORG-123', '[redacted]');
  const healthy = 'event: message_start\ndata: {"type":"message_start","message":{"id":"m1"}}\n\n';
  const named = `event: message\ndata: {"error":{"message":"Incorrect API key provided: ${CREDENTIAL}; the org's token tok-ORG-123 has no access"}}\n\n`;
  const echoed = `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"the key is ${CREDENTIAL}"}}\n\n`;
  for (const event of [named, echoed]) {
    for (const pieces of [undefined, [...(healthy + event)]]) {
      const got = await answered(t, 200, healthy + event, redact, { pieces, contentType: 'text/event-stream' });
      assert.ok(got.text.startsWith(healthy), JSON.stringify(got.text));
      assert.ok(!got.text.includes(CREDENTIAL) && !got.text.includes('tok-ORG-123') && got.text.includes('[redacted]'), JSON.stringify(got.text));
    }
  }
  // A healthy event with no form in it goes out byte for byte as it ends.
  const relay = errorCut('events', echoForms([CREDENTIAL]), redact, () => {});
  assert.equal(relay.push(healthy), healthy);
});

test("an error answer the cut holds part of reaches the client character for character: the hold never splits a character in two", async (t) => {
  // The window the host's redactor reads would end between the emoji's two halves.
  const body = `a\u{1F600}${'x'.repeat(4095)}`;
  const got = await answered(t, 500, body, (text) => text);
  assert.equal(got.text, body);
});
