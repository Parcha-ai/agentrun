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
/** A whole JSON body's own fields, or undefined when `text` is not one. */
const body = (text) => { try { const value = JSON.parse(text); return value !== null && typeof value === 'object' ? value : undefined; } catch { return undefined; } };
const encoder = new TextEncoder();

/** The answer `pieces`, each its own piece, through the proxy: what the policy was handed (in characters), what was sent,
 *  the stops it told, how many by the booking, whether the client had the stop's last piece when it was told, and the
 *  usage booked. The stop is `{"stop":"refusal"}`, in an event's data or a whole body's field. */
async function through(t, pieces, stopPiece) {
  const seen = { read: 0, sent: 0, told: [], client: '' };
  const policy = {
    id: 'test',
    routes: [{ method: 'POST', path: '/v1/test' }],
    keyOf: (headers) => String(headers.authorization ?? '').replace(/^Bearer /, ''),
    authHeaders: (credential) => ({ authorization: `Bearer ${credential}` }),
    apply: (value) => ({ ...value, model: 'session-model' }),
    usageOf: (text) => events(text).find((e) => e.end)?.usage ?? body(text)?.usage,
    filtered: (text) => {
      seen.read += text.length;
      return events(text).some((e) => e.stop === 'refusal') || body(text)?.stop === 'refusal';
    },
  };
  const fetch = async () => new Response(new ReadableStream({
    start(controller) {
      for (const piece of pieces) {
        seen.sent += piece.length;
        controller.enqueue(encoder.encode(piece));
      }
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const p = await startModelProxy({
    policy, model: 'session-model', origin: 'https://provider.invalid', credential: () => 'provider-secret', price: () => 0.002, log: () => {},
    hooks: { beforeRequest: async () => {}, afterRequest: async (usage) => { seen.toldByBooking = seen.told.length; seen.booked = usage; } }, fetch,
    onFiltered: (message) => { seen.told.push(message); seen.clientHadStop = seen.client.includes(stopPiece); },
  }, KEY);
  t.after(() => p.close());
  await new Promise((resolve, reject) => {
    const { hostname, port } = new URL(p.url);
    const req = request({ host: hostname, port, method: 'POST', path: '/v1/test', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` } }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => { seen.client += chunk; });
      res.on('end', resolve);
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end('{}');
  });
  assert.equal(seen.client.length, seen.sent, 'the whole answer reached the client');
  return seen;
}

/** An event stream of `count` deltas, then its stop on the filter in three pieces (a line read across pieces), then its
 *  usage at the end. */
const stream = (count) => [
  ...Array.from({ length: count }, (_, i) => `data: {"delta":"word ${String(i % 1000).padStart(3, '0')} "}\n\n`),
  'data: {"st', 'op":"ref', 'usal"}\n\n',
  'data: {"end":true,"usage":{"input":12,"output":3,"cacheRead":0}}\n\n',
];

test("an answer's stop is read off each line once: what the policy reads per piece stays flat as the answer grows fourfold", { timeout: 60_000 }, async (t) => {
  // About 17 KB, and about 70 KB: past the 64 KiB the proxy keeps of an answer's end.
  const short = await through(t, stream(600), 'usal"}');
  const long = await through(t, stream(2400), 'usal"}');
  for (const [name, seen] of [['short', short], ['long', long]]) {
    assert.equal(seen.told.length, 1, `the ${name} answer's stop, its line across three pieces, is told once`);
    // Read as its line ended, before its client had that line's last piece: not left to the whole-answer read after the
    // booking.
    assert.equal(seen.toldByBooking, 1, `the ${name} answer's stop is told before the answer ends`);
    assert.equal(seen.clientHadStop, false, `the ${name} answer's stop is told before its client has the stop's last piece`);
    // Each line once (and the separators not at all): about what was sent, never a window per piece.
    assert.ok(seen.read <= 2 * seen.sent, `the ${name} answer: the policy read ${seen.read} characters of ${seen.sent} sent`);
    // The usage at its end, read from what the proxy kept of it.
    assert.deepEqual([seen.booked?.input, seen.booked?.output], [12, 3], `the ${name} answer is booked at its usage: ${JSON.stringify(seen.booked)}`);
  }
  const perPiece = (seen, count) => seen.read / (count + 4);
  assert.ok(perPiece(long, 2400) <= 1.5 * perPiece(short, 600), `read per piece: ${perPiece(short, 600).toFixed(1)} at 600 pieces, ${perPiece(long, 2400).toFixed(1)} at 2400`);
});

test('a whole JSON body printed across lines, its stop in no one line, is still told before its client has its last piece', { timeout: 30_000 }, async (t) => {
  const whole = JSON.stringify({ stop: 'refusal', text: 'word '.repeat(200), usage: { input: 12, output: 3, cacheRead: 0 } }, null, 2);
  const pieces = whole.match(/[\s\S]{1,64}/g);
  const seen = await through(t, pieces, pieces.at(-1));
  assert.equal(seen.told.length, 1, 'its stop is told once');
  assert.equal(seen.toldByBooking, 1, 'its stop is told before the body ends, never left to the read after the booking');
  assert.equal(seen.clientHadStop, false, "its stop is told before its client has the body's last piece");
});
