// The proxy reads an answer's content-filter stop off each line once, as the line ends: a long answer, in tens of
// thousands of pieces, costs each piece the length of what it carries, never a read of the kept window again for every
// piece. A read of the window per piece held a runner's one thread for most of a minute on a 1 MB answer: its store's
// commits ran out their deadline behind it, and its run never ended. Counted in the characters the policy is handed,
// at two answer sizes, never in time. No network: the provider is a scripted fetch.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import * as host from '@parcha/agentrun-kernel/host';

const { startModelProxy } = host;
const KEY = 'session-key-for-tests';
const events = (text) => text.split('\n').filter((line) => line.startsWith('data: ')).map((line) => { try { return JSON.parse(line.slice(6)); } catch { return undefined; } }).filter(Boolean);
const encoder = new TextEncoder();

/** One answer of `count` pieces, each one SSE event, then its stop on the filter in three pieces (a line read across
 *  pieces), then its usage: what the policy was handed, in characters and calls, and the stops it told. */
async function streamed(t, count) {
  const seen = { read: 0, sent: 0, told: [] };
  const policy = {
    id: 'test',
    routes: [{ method: 'POST', path: '/v1/test' }],
    keyOf: (headers) => String(headers.authorization ?? '').replace(/^Bearer /, ''),
    authHeaders: (credential) => ({ authorization: `Bearer ${credential}` }),
    apply: (body) => ({ ...body, model: 'session-model' }),
    usageOf: (text) => events(text).find((e) => e.end)?.usage,
    filtered: (text) => {
      seen.read += text.length;
      return events(text).some((e) => e.stop === 'refusal');
    },
  };
  const fetch = async () => new Response(new ReadableStream({
    start(controller) {
      const put = (text) => {
        seen.sent += text.length;
        controller.enqueue(encoder.encode(text));
      };
      for (let i = 0; i < count; i++) put(`data: {"delta":"word ${String(i % 1000).padStart(3, '0')} "}\n\n`);
      put('data: {"st');
      put('op":"ref');
      put('usal"}\n\n');
      put('data: {"end":true,"usage":{"input":12,"output":3,"cacheRead":0}}\n\n');
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const p = await startModelProxy({
    policy, model: 'session-model', origin: 'https://provider.invalid', credential: () => 'provider-secret', price: () => 0.002, log: () => {},
    hooks: { beforeRequest: async () => {}, afterRequest: async () => { seen.toldByBooking = seen.told.length; } }, fetch,
    onFiltered: (message) => { seen.told.push(message); },
  }, KEY);
  t.after(() => p.close());
  const answer = await new Promise((resolve, reject) => {
    const { hostname, port } = new URL(p.url);
    const req = request({ host: hostname, port, method: 'POST', path: '/v1/test', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve(text));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end('{}');
  });
  assert.ok(answer.includes('"delta"'), 'the answer reached the client');
  return seen;
}

test("an answer's stop is read off each line once: what the policy reads per piece stays flat as the answer grows fourfold", { timeout: 60_000 }, async (t) => {
  const short = await streamed(t, 500);
  const long = await streamed(t, 2000);
  for (const [name, seen] of [['short', short], ['long', long]]) {
    assert.equal(seen.told.length, 1, `the ${name} answer's stop, its line across three pieces, is told once`);
    // Read as its line ended, before the answer did: not left to the whole-answer read after the booking.
    assert.equal(seen.toldByBooking, 1, `the ${name} answer's stop is told before the answer ends`);
    // Each line once (and the separators not at all): about what was sent, never a window per piece.
    assert.ok(seen.read <= 2 * seen.sent, `the ${name} answer: the policy read ${seen.read} characters of ${seen.sent} sent`);
  }
  const perPiece = (seen, count) => seen.read / (count + 4);
  assert.ok(perPiece(long, 2000) <= 1.5 * perPiece(short, 500), `read per piece: ${perPiece(short, 500).toFixed(1)} at 500 pieces, ${perPiece(long, 2000).toFixed(1)} at 2000`);
});
