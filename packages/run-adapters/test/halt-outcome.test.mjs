// How a turn whose drive was aborted ends (kernel/errors.ts abortedOutcome): interrupted when the session itself stopped
// it (its own interrupt or close, told apart by identity) or its host did; failed, with the reason, when anything else
// halted it (a spend cap, the transcript mirror, a refused spawn).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { abortedOutcome, SessionHalt } from '@parcha/agentrun-kernel/kernel';
import { fauxAdapter, memorySessionStore } from '@parcha/agentrun-kernel/testing';

const abortedBy = (reason) => { const c = new AbortController(); c.abort(reason); return c.signal; };
const live = new AbortController().signal;

test("the session's own interrupt and close, and its host's stop, end the turn interrupted", () => {
  assert.deepEqual(abortedOutcome(abortedBy(new SessionHalt('interrupted')), live), { status: 'interrupted' });
  assert.deepEqual(abortedOutcome(abortedBy(new SessionHalt('closed')), live), { status: 'interrupted' });
  const host = new AbortController();
  host.abort(new Error('the process died'));
  assert.deepEqual(abortedOutcome(abortedBy(new Error('the process died')), host.signal), { status: 'interrupted' });
});

test('any other halt ends the turn failed, with its reason: told apart by identity, never by its text', () => {
  assert.deepEqual(abortedOutcome(abortedBy(new Error('spend_cap_reached: the turn cap')), live), { status: 'failed', error: 'spend_cap_reached: the turn cap' });
  // A reason whose text happens to be the session's word is still another halt's.
  assert.deepEqual(abortedOutcome(abortedBy(new Error('interrupted')), live), { status: 'failed', error: 'interrupted' });
  assert.equal(abortedOutcome(abortedBy(undefined), live).status, 'failed');
});

test("the faux adapter's halt step ends its turn failed, naming why; its own interrupt ends it interrupted", async () => {
  const store = memorySessionStore();
  const models = { beforeRequest: async () => {}, afterRequest: async () => {} };
  const open = async (script, key) => fauxAdapter({ script: () => script }).open({ key, label: 'f', system: [], tools: [], context: 'fresh' }, { store, writer: await store.open(key), models, signal: new AbortController().signal, onEvent: () => {} });
  const halted = await open([{ halt: 'spend_cap_reached: the turn cap' }], 'step:halt');
  await halted.send('go');
  assert.deepEqual(await halted.turnEnd(), { status: 'failed', error: 'spend_cap_reached: the turn cap' });
  await halted.close();
  const hung = await open([{ hang: true }], 'step:hang');
  await hung.send('go');
  const ending = hung.turnEnd();
  await hung.interrupt();
  assert.deepEqual(await ending, { status: 'interrupted' });
  await hung.close();
});
