// The faux harness's `onRefused: "next"` (a CLI that sends another request after its host refused one) across a reopen:
// the script's place is where its last request was, so a session opened again never sends an action again.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FAUX_RECORDS, fauxAdapter, memorySessionStore } from '@parcha/agentrun-kernel/testing';

test('a faux session opened again after a refused request and an answered one goes on from the answered one: no action is sent twice', async () => {
  // Turn 1: action 0 is refused by the host (its admission throws) and the client goes on; action 1 ends the turn. Turn 2,
  // in a session opened again on the same records: action 2.
  const script = () => [{ say: 'refused', onRefused: 'next' }, { end: true }, { say: 'second turn' }, { end: true }];
  const adapter = fauxAdapter({ script });
  const store = memorySessionStore();
  const spec = { key: 'step:faux-refused', label: 'faux', system: ['Answer.'], tools: [], context: 'fresh' };
  let asked = 0;
  const models = { beforeRequest: async () => { if ((asked += 1) === 1) throw new Error('the host refused the request'); }, afterRequest: async () => {} };
  const first = await adapter.open(spec, { store, writer: await store.open(spec.key), models, signal: new AbortController().signal, onEvent: () => {} });
  await first.send('go');
  assert.equal((await first.turnEnd()).status, 'completed');
  await first.close();
  const second = await adapter.open(spec, { store, writer: await store.open(spec.key), models, signal: new AbortController().signal, onEvent: () => {} });
  await second.send('go on');
  assert.equal((await second.turnEnd()).status, 'completed');
  await second.close();
  const records = await (await store.open(spec.key)).read();
  const sent = records.filter((r) => r.kind === FAUX_RECORDS.request).map((r) => r.data.index);
  assert.deepEqual(sent, [1, 2, 3], 'action 1 once, then actions 2 and 3 in the session opened again');
});
