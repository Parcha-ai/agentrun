// A client that leaves while its request is being admitted (a person's stop or a cancel lands while the host books the
// request's hold and makes it durable): the proxy never sends it, and books it at nothing, as never having left. Sent
// anyway, it was a paid answer for no one that nothing stopped (the client's close came before the proxy listened for it),
// booked only once the provider ended it, after the run had ended and read the request as cut at an unknown cost: a run
// cancelled before its first request reached the model showed a null cost. No network: the provider is a recording fetch.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { startModelProxy } from '@parcha/agentrun-kernel/host';

const KEY = 'session-key-for-tests';
const policy = {
  id: 'test',
  routes: [{ method: 'POST', path: '/v1/test' }],
  keyOf: (headers) => String(headers.authorization ?? '').replace(/^Bearer /, ''),
  authHeaders: (credential) => ({ authorization: `Bearer ${credential}` }),
  apply: (body) => body,
  modelOf: (body) => body.model,
  usageOf: () => ({ input: 7, output: 2, cacheRead: 0 }),
};
/** How long the fake provider takes to answer a request nobody stops: well past the wait for its booking below. */
const ANSWER_MS = 4_000;
const BOOKED_WITHIN_MS = 2_000;

/** A proxy whose host holds each admission until `admit()`, over a provider that answers after ANSWER_MS unless the
 *  proxy stops it; what it forwarded and booked. */
async function heldProxy(t) {
  const forwarded = [];
  const booked = [];
  let admit;
  const admitted = new Promise((resolve) => (admit = resolve));
  let asked;
  const askedNow = new Promise((resolve) => (asked = resolve));
  const hooks = {
    beforeRequest: async () => {
      asked();
      await admitted;
      return { turn: 1 };
    },
    afterRequest: async (usage, _ticket, ended) => void booked.push({ usage, ended }),
  };
  const fetch = async (_url, init) => {
    forwarded.push(JSON.parse(init.body));
    const body = new ReadableStream({
      start(controller) {
        const timer = setTimeout(() => (controller.enqueue(new TextEncoder().encode('{"usage":{}}')), controller.close()), ANSWER_MS);
        init.signal?.addEventListener('abort', () => (clearTimeout(timer), controller.error(init.signal.reason)), { once: true });
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const p = await startModelProxy({ policy, model: 'main-model', origin: 'https://provider.invalid', credential: () => 'provider-secret', hooks, price: () => 0.001, log: () => {}, fetch }, KEY);
  t.after(() => p.close());
  const { hostname, port } = new URL(p.url);
  const send = () => {
    const req = request({ host: hostname, port, method: 'POST', path: '/v1/test', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` } });
    req.on('error', () => {});
    req.end(JSON.stringify({ model: 'main-model', messages: [{ role: 'user', text: 'Take your time.' }] }));
    return req;
  };
  return { forwarded, booked, admit, askedNow, send };
}

const bookedWithin = async (booked, ms) => {
  const until = Date.now() + ms;
  while (booked.length === 0 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 20));
  return booked;
};

test('a request whose client left while it was admitted is never sent, and is booked at once at nothing, as never having left', async (t) => {
  const p = await heldProxy(t);
  const req = p.send();
  await p.askedNow;
  // The client goes while its request is admitted; the admission ends after the proxy has seen it go.
  req.destroy();
  await new Promise((resolve) => setTimeout(resolve, 200));
  p.admit();
  const booked = await bookedWithin(p.booked, BOOKED_WITHIN_MS);
  assert.equal(p.forwarded.length, 0, 'never sent to the provider');
  assert.deepEqual(booked.map((b) => [b.usage.usd, b.ended]), [[0, { end: 'nothing', label: 'never_left' }]], `booked at nothing, at once: ${JSON.stringify(booked)}`);
});

test('a request whose client stays is sent, and one whose client leaves after it was sent is stopped and booked at once', async (t) => {
  const p = await heldProxy(t);
  const req = p.send();
  await p.askedNow;
  p.admit();
  const until = Date.now() + BOOKED_WITHIN_MS;
  while (p.forwarded.length === 0 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(p.forwarded.length, 1, 'sent');
  req.destroy();
  const booked = await bookedWithin(p.booked, BOOKED_WITHIN_MS);
  assert.equal(booked.length, 1, 'booked once its client left, not when the provider would have ended it');
  assert.notEqual(booked[0].ended.label, 'never_left', `it left: ${JSON.stringify(booked[0].ended)}`);
});
