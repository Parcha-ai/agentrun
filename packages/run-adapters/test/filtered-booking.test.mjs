// An answer the provider stopped on its content filter is booked at the usage it reports, though the harness ends the
// turn (and its client goes away) as soon as the proxy reads the stop: the proxy reads the provider's answer to its end
// for the usage, which comes after the stop (Anthropic's message_delta, then message_stop). Any other answer whose client
// leaves is cut off as before. No network: the provider is a scripted fetch.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import * as host from '@parcha/agentrun-kernel/host';

const { startModelProxy } = host;
const KEY = 'session-key-for-tests';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const events = (text) => text.split('\n').filter((line) => line.startsWith('data: ')).map((line) => { try { return JSON.parse(line.slice(6)); } catch { return undefined; } }).filter(Boolean);
/** A policy whose answers end with `{ end, usage }` (no usage before it) and stop on the filter with `{ stop: "refusal" }`. */
const policy = {
  id: 'test',
  routes: [{ method: 'POST', path: '/v1/test' }],
  keyOf: (headers) => String(headers.authorization ?? '').replace(/^Bearer /, ''),
  authHeaders: (credential) => ({ authorization: `Bearer ${credential}` }),
  apply: (body) => ({ ...body, model: 'session-model' }),
  usageOf: (text) => events(text).find((e) => e.end)?.usage,
  filtered: (text) => events(text).some((e) => e.stop === 'refusal'),
};

/** The provider's answer in two pieces: the stop, then (once `release` resolves) the end with the usage. */
function twoPieces(release, last = '{"end":true,"usage":{"input":12,"output":3,"cacheRead":0}}') {
  const encoder = new TextEncoder();
  // As a real fetch does, an abort of the request ends its body with an error.
  return async (_url, init) => new Response(new ReadableStream({
    async start(controller) {
      let cut = false;
      init?.signal?.addEventListener('abort', () => { cut = true; controller.error(new Error('the request was aborted')); }, { once: true });
      controller.enqueue(encoder.encode('data: {"stop":"refusal"}\n\n'));
      await release;
      if (cut) return;
      controller.enqueue(encoder.encode(`data: ${last}\n\n`));
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** One request through the proxy; its socket is handed to `onSocket`, so the test can take it down as a halt does. */
function send(url, onRequest) {
  const { hostname, port } = new URL(url);
  return new Promise((resolve) => {
    const req = request({ host: hostname, port, method: 'POST', path: '/v1/test', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` } }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve('ended'));
      res.on('error', () => resolve('cut'));
    });
    req.on('error', () => resolve('cut'));
    onRequest(req);
    req.end('{}');
  });
}

test('an answer the provider stopped on its content filter, its client gone at the stop, is read to its end and booked at its usage', { timeout: 30_000 }, async (t) => {
  const booked = [];
  let release;
  const released = new Promise((resolve) => (release = resolve));
  let client;
  const p = await startModelProxy({
    policy, model: 'session-model', origin: 'https://provider.invalid', credential: () => 'provider-secret', price: () => 0.002, log: () => {},
    hooks: { beforeRequest: async () => {}, afterRequest: async (usage) => { booked.push(usage); } },
    fetch: twoPieces(released),
    // The harness halts the turn at the stop: its client (the CLI) goes away before the answer ends.
    onFiltered: () => { client.destroy(); setTimeout(release, 50); },
  }, KEY);
  t.after(() => p.close());
  await send(p.url, (req) => { client = req; });
  for (const end = Date.now() + 10_000; !booked.length; await sleep(20)) assert.ok(Date.now() < end, 'the request is booked');
  assert.deepEqual([booked[0].input, booked[0].output, booked[0].usd], [12, 3, 0.002], `booked at its usage: ${JSON.stringify(booked[0])}`);
});

test('a guard: any other answer whose client leaves is cut off and booked at an unknown cost, as before', { timeout: 30_000 }, async (t) => {
  const booked = [];
  let release;
  const released = new Promise((resolve) => (release = resolve));
  let client;
  const quiet = { ...policy, filtered: () => false };
  const p = await startModelProxy({
    policy: quiet, model: 'session-model', origin: 'https://provider.invalid', credential: () => 'provider-secret', price: () => 0.002, log: () => {},
    hooks: { beforeRequest: async () => {}, afterRequest: async (usage) => { booked.push(usage); } },
    fetch: twoPieces(released),
  }, KEY);
  t.after(() => { release(); return p.close(); });
  const sent = send(p.url, (req) => { client = req; });
  await sleep(200);
  client.destroy();
  await sent;
  for (const end = Date.now() + 10_000; !booked.length; await sleep(20)) assert.ok(Date.now() < end, 'the request is booked');
  assert.equal(booked[0].usd, null, `an answer cut short costs what is unknown: ${JSON.stringify(booked[0])}`);
});

test("a side call the provider's filter stops (a helper request that offers none of the session's tools) is never the turn's stop: the answer request that follows completes, and the harness is told nothing", { timeout: 30_000 }, async (t) => {
  const told = [];
  const encoder = new TextEncoder();
  // The provider stops the helper call on its filter and answers the turn's own request.
  const fetch = async (_url, init) => {
    const body = JSON.parse(String(init.body));
    const text = Array.isArray(body.tools) && body.tools.length ? 'data: {"end":true,"usage":{"input":5,"output":2,"cacheRead":0}}\n\n' : 'data: {"stop":"refusal"}\n\ndata: {"end":true,"usage":{"input":1,"output":0,"cacheRead":0}}\n\n';
    return new Response(encoder.encode(text), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  // The turn's answer request offers the session's tools; a helper call (a title, a summary) offers none.
  const sided = { ...policy, answers: (body) => Array.isArray(body.tools) && body.tools.length > 0 };
  const p = await startModelProxy({
    policy: sided, model: 'session-model', origin: 'https://provider.invalid', credential: () => 'provider-secret', price: () => 0.002, log: () => {},
    hooks: { beforeRequest: async () => {}, afterRequest: async () => {} }, fetch,
    onFiltered: (message) => { told.push(message); },
  }, KEY);
  t.after(() => p.close());
  const post = (body) => new Promise((resolve, reject) => {
    const { hostname, port } = new URL(p.url);
    const req = request({ host: hostname, port, method: 'POST', path: '/v1/test', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve(text));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
  await post({ messages: [{ role: 'user', content: 'Title this conversation.' }] });
  const answer = await post({ messages: [{ role: 'user', content: 'What is 2 plus 2?' }], tools: [{ name: 'mcp__hands__submit' }] });
  assert.match(answer, /"end":true/, 'the answer request completes');
  assert.deepEqual(told, [], "a side call's stop is not the turn's: the harness is told nothing");
});

test("the proxy's close waits for an answer the provider stopped on its filter to be read to its end and booked at its usage", { timeout: 30_000 }, async (t) => {
  const booked = [];
  let release;
  const released = new Promise((resolve) => (release = resolve));
  let client;
  let closed;
  const p = await startModelProxy({
    policy, model: 'session-model', origin: 'https://provider.invalid', credential: () => 'provider-secret', price: () => 0.002, log: () => {},
    hooks: { beforeRequest: async () => {}, afterRequest: async (usage) => { booked.push(usage); } },
    fetch: twoPieces(released),
    // The halt ends the drive, which closes the proxy, before the answer's end (and its usage) comes.
    onFiltered: () => { client.destroy(); closed = p.close(); setTimeout(release, 100); },
  }, KEY);
  t.after(() => p.close());
  await send(p.url, (req) => { client = req; });
  for (const end = Date.now() + 10_000; !closed; await sleep(20)) assert.ok(Date.now() < end, 'the stop is told');
  await closed;
  assert.deepEqual([booked[0]?.input, booked[0]?.output, booked[0]?.usd], [12, 3, 0.002], `booked at its usage before the proxy closed: ${JSON.stringify(booked)}`);
});

test("a guard: the proxy's close waits for a stopped answer at most 5 s, then cuts it off at an unknown cost", { timeout: 30_000 }, async (t) => {
  const booked = [];
  let client;
  let closed;
  const p = await startModelProxy({
    policy, model: 'session-model', origin: 'https://provider.invalid', credential: () => 'provider-secret', price: () => 0.002, log: () => {},
    hooks: { beforeRequest: async () => {}, afterRequest: async (usage) => { booked.push(usage); } },
    // The provider never ends the answer.
    fetch: twoPieces(new Promise(() => {})),
    onFiltered: () => { client.destroy(); closed = p.close(); },
  }, KEY);
  t.after(() => p.close());
  const started = Date.now();
  await send(p.url, (req) => { client = req; });
  for (const end = Date.now() + 10_000; !closed; await sleep(20)) assert.ok(Date.now() < end, 'the stop is told');
  await closed;
  assert.ok(Date.now() - started < 8_000, `the close is bounded: ${Date.now() - started} ms`);
  for (const end = Date.now() + 5_000; !booked.length; await sleep(20)) assert.ok(Date.now() < end, 'the request is booked');
  assert.equal(booked[0].usd, null, `an answer cut short costs what is unknown: ${JSON.stringify(booked[0])}`);
});
