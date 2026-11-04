// A turn its session interrupted (a person's stop) is still open when the next process opens the session: an interrupt
// writes no end. settleOpenTurn() records it as ended, interrupted, and sends nothing, so it is never resumed: the session
// is idle in this process and in the next one, and the next message is a turn of its own. The faux adapter, in-memory
// store; each "process" is a store open and a faux session.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FAUX_RECORDS, fauxAdapter, memorySessionStore } from '@parcha/agentrun-kernel/testing';

const SESSION = 'chat:stop';
const models = { beforeRequest: async () => {}, afterRequest: async () => {} };

test("the faux session settles a turn its interrupt left open: ended interrupted, nothing sent, idle here and in the next process; the next message is a turn of its own", async () => {
  const store = memorySessionStore();
  let inside;
  const reached = new Promise((resolve) => { inside = resolve; });
  const wait = { name: 'wait', description: 'Wait.', inputSchema: { type: 'object' }, replay: 'safe', call: (_args, { signal }) => { inside(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cut')), { once: true })); } };
  // The first process's turn holds at the stop: its call is cut, and nothing after it runs (faux answers a cut call as an
  // error and would go on). A later process's script goes on to the next turn's answer.
  let stopped = false;
  const adapter = fauxAdapter({ script: () => [{ call: 'wait' }, ...(stopped ? [{ say: 'the next turn' }, { end: true }] : [{ hang: true }])] });
  const spec = { key: SESSION, label: 'stop', system: [], tools: [wait], context: 'fresh' };
  const open = async () => adapter.open(spec, { writer: await store.open(SESSION), models, signal: new AbortController().signal, onEvent: () => {} });

  const first = await open();
  await first.send('go');
  await reached;
  const ending = first.turnEnd();
  await first.interrupt();
  assert.equal((await ending).status, 'interrupted');
  await first.close();
  stopped = true;

  const next = await open();
  assert.equal(next.state, 'open_turn', 'the interrupted turn is open to the next process');
  const requests = adapter.requests;
  await next.settleOpenTurn();
  assert.equal(next.state, 'idle');
  assert.equal(adapter.requests, requests, 'nothing sent');
  const ends = (await store.read(SESSION)).filter((r) => r.kind === FAUX_RECORDS.turnEnd).map((r) => r.data.status);
  assert.deepEqual(ends, ['interrupted'], 'the turn ended, interrupted, in the session');
  await next.close();

  const text = [];
  const later = await adapter.open(spec, { writer: await store.open(SESSION), models, signal: new AbortController().signal, onEvent: (e) => { if (e.type === 'text') text.push(e.delta); } });
  assert.equal(later.state, 'idle', 'settled for good: the next process finds no open turn');
  await later.send('and now?');
  assert.equal((await later.turnEnd()).status, 'completed');
  assert.equal(text.join(''), 'the next turn', 'the next message is answered by its own turn');
  await later.close();
});

test('settleOpenTurn() refuses a session with no open turn', async () => {
  const store = memorySessionStore();
  const adapter = fauxAdapter({ script: () => [{ say: 'hi' }, { end: true }] });
  const session = await adapter.open({ key: SESSION, label: 'stop', system: [], tools: [], context: 'fresh' }, { writer: await store.open(SESSION), models, signal: new AbortController().signal, onEvent: () => {} });
  assert.equal(session.state, 'new');
  await assert.rejects(session.settleOpenTurn(), /no turn to settle/);
  await session.close();
});
