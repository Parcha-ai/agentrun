// What the package holds pi-durable 1.5 to: a tool result's blocks are its `output`, a failed Session's error is the
// storage's, and a wait runs on a signal that never aborts, so no waiter pi-durable makes goes unhandled (durableWait).
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { setImmediate as macrotask } from 'node:timers/promises';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import { durableWait, storageError, toolResult } from '../dist/workflow/pi-versions.js';

const blocks = [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }];

test('a result this package writes carries its blocks under output only, its own copy, with its other fields', () => {
  const result = toolResult(blocks, { isError: true, details: { why: 'x' }, control: { terminate: true } });
  assert.deepEqual(result, { isError: true, details: { why: 'x' }, control: { terminate: true }, output: blocks });
  assert.equal('content' in result, false, 'no pi 1.1 key');
  assert.notEqual(result.output[0], blocks[0]);
});

test("a failed Session's error is the storage's; any other error is itself", () => {
  const cause = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  const failed = Object.assign(new Error('Session failed after a storage error; close and reopen it', { cause }), { name: 'SessionFailed' });
  assert.equal(storageError(failed), cause);
  const plain = new Error('other');
  assert.equal(storageError(plain), plain);
  const named = Object.assign(new Error('no cause'), { name: 'SessionFailed' });
  assert.equal(storageError(named), named, 'a SessionFailed with no cause is kept');
  assert.equal(storageError('text'), 'text');
});

test("durableWait: the wait runs on a signal of its own that never aborts; an abort while it waits rejects with its reason, and the wait settling later goes unhandled nowhere", async (t) => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(String(reason?.message ?? reason));
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  const claim = new AbortController();
  const asked = [];
  let closeSession = () => {};
  const waiting = durableWait(async (context) => {
    asked.push(context.abortSignal);
    // A waiter whose signal never aborts: it settles when its Session closes (pi-durable's Submissions close rejects it).
    return new Promise((_, reject) => (closeSession = () => reject(new Error('the session closed'))));
  }, withAbortSignal(claim.signal, BACKGROUND_CONTEXT));
  await macrotask();
  claim.abort(new Error('the runner is closing'));
  await assert.rejects(waiting, { message: 'the runner is closing' });
  closeSession();
  for (let i = 0; i < 3; i++) await macrotask();
  assert.equal(asked.length, 1, 'the wait was asked once');
  assert.ok(asked[0] instanceof AbortSignal && asked[0] !== claim.signal, "on a signal of its own, not the caller's");
  assert.equal(asked[0].aborted, false, "the caller's abort never reaches it");
  assert.deepEqual(unhandled, []);
});

// pi-durable's own waiters (harness/util.js, not in its exports): the waits durableWait fronts register through them.
const { Waiters } = await import(new URL('./harness/util.js', import.meta.resolve('@earendil-works/pi-durable')).href);

/** pi-durable's Submissions.wait over `waiters` (harness/submissions.js): the read on the Session's line registers the
 *  waiter, and the line hands it back only once every earlier commit published; `fail(error)` fails the Session there
 *  (a commit's storage error): its close rejects every waiter, and the line never hands this one back. */
function submissionWait(waiters) {
  let fail = () => {};
  const published = new Promise((_, reject) => (fail = reject));
  const wait = async (context) => {
    const found = { promise: waiters.add('submission-1', context) };
    await published;
    return found.promise;
  };
  const failSession = (error) => {
    waiters.rejectAll(error);
    fail(error);
  };
  return { wait, failSession };
}

for (const [aborted, words] of [[true, 'after the caller aborted'], [false, 'with the caller still waiting']]) {
  test(`durableWait: a waiter pi-durable made, then its Session failed before the line handed it back, ${words}: no rejection goes unhandled`, async (t) => {
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(String(reason?.message ?? reason));
    process.on('unhandledRejection', onUnhandled);
    t.after(() => process.off('unhandledRejection', onUnhandled));
    const waiters = new Waiters();
    const { wait, failSession } = submissionWait(waiters);
    const claim = new AbortController();
    const waiting = durableWait(wait, withAbortSignal(claim.signal, BACKGROUND_CONTEXT));
    waiting.catch(() => undefined);
    await macrotask();
    assert.deepEqual(waiters.keys(), ['submission-1'], 'the waiter is registered and not yet handed back');
    if (aborted) {
      claim.abort(new Error('the runner is closing'));
      await assert.rejects(waiting, { message: 'the runner is closing' });
    }
    failSession(new Error('Session failed after a storage error; close and reopen it', { cause: new Error('the test ended') }));
    if (!aborted) await assert.rejects(waiting, { message: /Session failed after a storage error/ });
    for (let i = 0; i < 3; i++) await macrotask();
    assert.deepEqual(unhandled, []);
  });
}

test('durableWait: a wait asked once the signal aborted is never started; one with no caller signal is the wait itself, on a signal that never aborts; one that settles first answers', async () => {
  const claim = new AbortController();
  claim.abort(new Error('claim lost'));
  let asked = 0;
  await assert.rejects(durableWait(async () => { asked += 1; }, withAbortSignal(claim.signal, BACKGROUND_CONTEXT)), { message: 'claim lost' });
  assert.equal(asked, 0);
  const own = Promise.resolve('done');
  let bare;
  assert.equal(durableWait((context) => ((bare = context.abortSignal), own), BACKGROUND_CONTEXT), own, 'no signal: the wait itself');
  assert.equal(bare?.aborted, false, 'with no caller signal, the wait still gets one that never aborts');
  const live = new AbortController();
  assert.equal(await durableWait(async (context) => (context.abortSignal === live.signal ? 'signalled' : 'done'), withAbortSignal(live.signal, BACKGROUND_CONTEXT)), 'done');
  await assert.rejects(durableWait(async () => { throw new Error('Submission 7 does not exist'); }, withAbortSignal(live.signal, BACKGROUND_CONTEXT)), { message: 'Submission 7 does not exist' });
  assert.equal(getEventListeners(live.signal, 'abort').length, 0, 'a settled wait leaves no listener on the signal');
});
