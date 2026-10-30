// How a turn whose drive was aborted ends (kernel/errors.ts abortedOutcome): interrupted when the session itself stopped
// it (its own interrupt or close, told apart by identity) or its host did; failed, with the reason, when anything else
// halted it (a spend cap, the transcript mirror, a refused spawn).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { abortedOutcome, SessionHalt } from '@parcha/agentrun-adapters/kernel';

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
