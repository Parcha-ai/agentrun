// A provider that takes a request and then sends nothing (its headers and first event, then silence; or not even its
// headers) is stopped by the session's model proxy at its stall bound, never left to the transport. Node's fetch cut such
// an answer after 5 minutes as "terminated", which every client retries: a run on a provider that went silent stayed
// working with no words, a request at a time. Stopped by the proxy, the client is told in words it does not ask again on,
// the request is booked once, a host that ends turns (onFinal) is told, and the turn's next answer request is refused
// until the host opens its next turn. The bound runs on mocked timers: the test moves the clock, never waits on it. No
// network: the provider is a fetch that answers what the test tells it to.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import * as host from '@parcha/agentrun-kernel/host';

const { startModelProxy } = host;

const KEY = 'session-key-for-tests';
const STALL_MS = 60_000;
/** The proxy's words and code for a request it stopped at the bound, as a client reads them. */
const MODEL_STALLED = 'model_stalled';
const stalledWords = (ms) => `the model sent nothing for ${Math.round(ms / 1000)} s, so the request was stopped`;
/** The default bound: 4 minutes. */
const MODEL_STALL_MS = 240_000;
const policy = {
  id: 'test',
  routes: [{ method: 'POST', path: '/v1/test' }],
  keyOf: (headers) => String(headers.authorization ?? '').replace(/^Bearer /, ''),
  authHeaders: (credential) => ({ authorization: `Bearer ${credential}` }),
  apply: (body) => body,
  modelOf: (body) => body.model,
  usageOf: () => undefined,
};
const encode = (text) => new TextEncoder().encode(text);
const FIRST_EVENT = 'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n';

/** Turns of the event loop (never a timer: those are mocked) until `ready()` holds. */
async function until(ready, what) {
  for (let turns = 0; !ready(); turns++) {
    if (turns > 200_000) throw new Error(`never: ${what}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** A proxy over a provider each request of which the test drives: `answers[i]` is the i-th request's, with `head()` to
 *  send its headers, `piece(text)` to send a piece, `end()` to close it, and `aborted` once the proxy stopped it before
 *  it ended. */
async function drivenProxy(t, { onFinal, stallMs } = {}) {
  const answers = [];
  const booked = [];
  const finals = [];
  const fetch = (_url, init) => new Promise((resolve, reject) => {
    let stream;
    const answer = {
      aborted: false,
      ended: false,
      head: () => resolve(new Response(new ReadableStream({ start: (c) => void (stream = c) }), { status: 200, headers: { 'content-type': 'text/event-stream' } })),
      piece: (text) => stream.enqueue(encode(text)),
      end: () => { answer.ended = true; stream.close(); },
    };
    // The proxy lets go of every request once its client is answered; only an abort before the answer ended stops it.
    init.signal.addEventListener('abort', () => {
      if (answer.ended) return;
      answer.aborted = true;
      const reason = init.signal.reason;
      if (stream) stream.error(reason);
      else reject(reason);
    }, { once: true });
    answers.push(answer);
  });
  const hooks = {
    beforeRequest: async () => ({ turn: 1 }),
    afterRequest: async (usage, _ticket, ended) => void booked.push({ usage, ended }),
  };
  const p = await startModelProxy({
    policy, model: 'main-model', origin: 'https://provider.invalid', credential: () => 'provider-secret', hooks, price: () => 0.001, log: () => {}, fetch,
    ...(stallMs === undefined ? {} : { stallMs }),
    ...(onFinal ? { onFinal: (message, code) => void finals.push({ message, code }) } : {}),
  }, KEY);
  t.after(() => p.close());
  const { hostname, port } = new URL(p.url);
  /** One request from the client: its status, headers and body as they come, and whether it ended. */
  const send = () => {
    const got = { status: undefined, type: undefined, body: '', ended: false, failed: false };
    const req = request({ host: hostname, port, method: 'POST', path: '/v1/test', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` } }, (res) => {
      got.status = res.statusCode;
      got.type = res.headers['content-type'];
      res.setEncoding('utf8');
      res.on('data', (text) => (got.body += text));
      res.on('end', () => (got.ended = true));
      res.on('error', () => (got.failed = true));
    });
    req.on('error', () => (got.failed = true));
    req.end(JSON.stringify({ model: 'main-model', messages: [{ role: 'user', text: 'Hello.' }] }));
    return got;
  };
  return { answers, booked, finals, send, proxy: p };
}

/** The data of the stream's events, parsed. */
const eventsOf = (body) => body.split('\n\n').filter(Boolean).map((event) => ({ name: /^event: (.*)$/m.exec(event)?.[1], data: JSON.parse(/^data: (.*)$/m.exec(event)[1]) }));

test('the stall bound is 4 minutes, under the 5 minutes Node fetch waits, and its words say none of what a client asks again on', () => {
  assert.equal(host.MODEL_STALL_MS, MODEL_STALL_MS);
  assert.ok(MODEL_STALL_MS < 300_000);
  assert.equal(host.MODEL_STALLED, MODEL_STALLED);
  assert.equal(host.stalledWords?.(MODEL_STALL_MS), stalledWords(MODEL_STALL_MS));
  // pi-ai's retry reads a status code, "timeout"/"timed out", "terminated" or a stream's early end as worth asking again.
  assert.doesNotMatch(stalledWords(MODEL_STALL_MS), /(?<![a-z0-9])(?:429|500|502|503|504|520|524)(?![a-z0-9])|timed? out|timeout|terminated|ended without|stream ended/i);
  assert.equal(stalledWords(MODEL_STALL_MS), 'the model sent nothing for 240 s, so the request was stopped');
});

test('an answer whose provider goes silent after its first event is stopped at the bound: the client reads an error event in the stall\'s words and the end, it is booked once, and the host ends the turn', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { answers, booked, finals, send } = await drivenProxy(t, { onFinal: true, stallMs: STALL_MS });
  const got = send();
  await until(() => answers.length === 1, 'the request reached the provider');
  answers[0].head();
  answers[0].piece(FIRST_EVENT);
  await until(() => got.body.includes('message_start'), 'the client has the first event');
  t.mock.timers.tick(STALL_MS - 1);
  await until(() => true, 'a turn');
  assert.equal(answers[0].aborted, false, 'one ms short of the bound, the request goes on');
  t.mock.timers.tick(1);
  await until(() => got.ended || got.failed, 'the client\'s answer ended');
  assert.equal(answers[0].aborted, true, 'the provider\'s request was stopped');
  assert.equal(got.status, 200);
  assert.equal(got.ended, true, 'the stream ends, it is not cut');
  const events = eventsOf(got.body);
  assert.deepEqual(events.map((event) => event.name), ['message_start', 'error']);
  const words = stalledWords(STALL_MS);
  assert.deepEqual(events[1].data, { type: 'error', code: MODEL_STALLED, message: words, error: { type: 'agentrun_proxy', code: MODEL_STALLED, message: words } });
  await until(() => booked.length === 1, 'the request was booked');
  assert.equal(booked[0].usage.usd, null, 'cut short: its cost is unknown');
  assert.deepEqual(finals, [{ message: words, code: MODEL_STALLED }]);
});

test('a request whose provider never sends its headers is stopped at the bound and answered at the refused status with the stall\'s code and words', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { answers, booked, finals, send } = await drivenProxy(t, { onFinal: true, stallMs: STALL_MS });
  const got = send();
  await until(() => answers.length === 1, 'the request reached the provider');
  t.mock.timers.tick(STALL_MS);
  await until(() => got.ended || got.failed, 'the client\'s answer ended');
  assert.equal(answers[0].aborted, true);
  assert.equal(got.status, 400, 'a status no client asks again on');
  assert.deepEqual(JSON.parse(got.body), { error: { message: stalledWords(STALL_MS), type: 'agentrun_proxy', code: MODEL_STALLED } });
  await until(() => booked.length === 1, 'the request was booked');
  assert.deepEqual(finals, [{ message: stalledWords(STALL_MS), code: MODEL_STALLED }]);
});

test('after a stall, a host that ends turns has its client\'s next answer request refused unsent until it opens its next turn', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { answers, send, proxy } = await drivenProxy(t, { onFinal: true, stallMs: STALL_MS });
  const first = send();
  await until(() => answers.length === 1, 'the request reached the provider');
  t.mock.timers.tick(STALL_MS);
  await until(() => first.ended || first.failed, 'the first answer ended');
  const again = send();
  await until(() => again.ended || again.failed, 'the retry was answered');
  assert.equal(again.status, 400);
  assert.match(JSON.parse(again.body).error.message, /stopped after 60 s with nothing from the model/);
  assert.equal(answers.length, 1, 'the retry never reached the provider');
  proxy.openTurn();
  send();
  await until(() => answers.length === 2, 'the next turn\'s request reached the provider');
});

test('with no host that ends turns, the client is told the same, and its next request goes to the provider', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { answers, finals, send } = await drivenProxy(t, { stallMs: STALL_MS });
  const first = send();
  await until(() => answers.length === 1, 'the request reached the provider');
  t.mock.timers.tick(STALL_MS);
  await until(() => first.ended || first.failed, 'the first answer ended');
  assert.equal(first.status, 400);
  assert.equal(JSON.parse(first.body).error.code, MODEL_STALLED);
  assert.deepEqual(finals, []);
  send();
  await until(() => answers.length === 2, 'the next request reached the provider');
});

test('an answer that keeps coming is never stopped, however long it takes: each piece starts the bound again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { answers, booked, finals, send } = await drivenProxy(t, { onFinal: true, stallMs: STALL_MS });
  const got = send();
  await until(() => answers.length === 1, 'the request reached the provider');
  t.mock.timers.tick(STALL_MS - 1);
  answers[0].head();
  answers[0].piece(FIRST_EVENT);
  await until(() => got.body.includes('message_start'), 'the client has the first event');
  // Ten pieces, each one ms short of the bound after the last: ten bounds in all, never one with nothing.
  for (let i = 0; i < 10; i++) {
    t.mock.timers.tick(STALL_MS - 1);
    const before = got.body.length;
    answers[0].piece(`event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${i}"}}\n\n`);
    await until(() => got.body.length > before, `piece ${i} reached the client`);
  }
  answers[0].end();
  await until(() => got.ended, 'the answer ended');
  assert.equal(answers[0].aborted, false);
  assert.equal(eventsOf(got.body).filter((event) => event.name === 'error').length, 0);
  await until(() => booked.length === 1, 'the request was booked');
  assert.deepEqual(finals, []);
});

test('the default bound applies when the host sets none', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { answers, send } = await drivenProxy(t, { onFinal: true });
  const got = send();
  await until(() => answers.length === 1, 'the request reached the provider');
  t.mock.timers.tick(MODEL_STALL_MS - 1);
  await until(() => true, 'a turn');
  assert.equal(answers[0].aborted, false);
  t.mock.timers.tick(1);
  await until(() => got.ended || got.failed, 'the client\'s answer ended');
  assert.equal(JSON.parse(got.body).error.message, stalledWords(MODEL_STALL_MS));
});
