// What the package holds pi-durable 1.5 to: a tool result's blocks are its `output`, a failed Session's error is the
// storage's, and a wait never holds a signal that can abort (durableWait).
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

test('durableWait: the wait runs with no signal; an abort while it waits rejects with its reason, and the wait settling later goes unhandled nowhere', async (t) => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(String(reason?.message ?? reason));
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  const claim = new AbortController();
  const asked = [];
  let closeSession = () => {};
  const waiting = durableWait(async (context) => {
    asked.push(context.abortSignal);
    // A waiter with no signal: it settles when its Session closes (pi-durable's Submissions close rejects it).
    return new Promise((_, reject) => (closeSession = () => reject(new Error('the session closed'))));
  }, withAbortSignal(claim.signal, BACKGROUND_CONTEXT));
  await macrotask();
  claim.abort(new Error('the runner is closing'));
  await assert.rejects(waiting, { message: 'the runner is closing' });
  closeSession();
  for (let i = 0; i < 3; i++) await macrotask();
  assert.deepEqual(asked, [undefined], 'the wait was asked once, with no signal');
  assert.deepEqual(unhandled, []);
});

test('durableWait: a wait asked once the signal aborted is never started; one with no signal is the wait itself; one that settles first answers', async () => {
  const claim = new AbortController();
  claim.abort(new Error('claim lost'));
  let asked = 0;
  await assert.rejects(durableWait(async () => { asked += 1; }, withAbortSignal(claim.signal, BACKGROUND_CONTEXT)), { message: 'claim lost' });
  assert.equal(asked, 0);
  const own = Promise.resolve('done');
  assert.equal(durableWait(() => own, BACKGROUND_CONTEXT), own, 'no signal: the wait itself');
  const live = new AbortController();
  assert.equal(await durableWait(async (context) => (context.abortSignal === undefined ? 'done' : 'signalled'), withAbortSignal(live.signal, BACKGROUND_CONTEXT)), 'done');
  await assert.rejects(durableWait(async () => { throw new Error('Submission 7 does not exist'); }, withAbortSignal(live.signal, BACKGROUND_CONTEXT)), { message: 'Submission 7 does not exist' });
  assert.equal(getEventListeners(live.signal, 'abort').length, 0, 'a settled wait leaves no listener on the signal');
});
