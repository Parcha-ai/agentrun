import assert from 'node:assert/strict';
import { test } from 'node:test';
const load = () => import('../dist/runner/project-drain.js');
test('checkpoint drain waits for the actual admitted write, and refuses a later dispatch without invoking it', async () => {
  const { ProjectDrain } = await load(), gate = new ProjectDrain(), entered = Promise.withResolvers(), finish = Promise.withResolvers();
  let written = false;
  const active = gate.run(async () => { entered.resolve(); await finish.promise; written = true; }); await entered.promise;
  let drained = false; const closing = gate.close(new AbortController().signal).then(() => { drained = true; });
  await assert.rejects(gate.run(async () => assert.fail('late effect dispatched')), /closed/);
  assert.equal(drained, false); assert.equal(written, false);
  finish.resolve(); await Promise.all([active, closing]); assert.equal(written, true); assert.equal(drained, true);
});
test('an effect that ignores abort leaves the drain uncertain and is never re-dispatched', async () => {
  const { ProjectDrain } = await load(), gate = new ProjectDrain(), finish = Promise.withResolvers(), abort = new AbortController(); let calls = 0;
  const active = gate.run(async () => { calls++; await finish.promise; });
  let closed = false; const closing = gate.close(abort.signal).finally(() => { closed = true; }); closing.catch(() => {});
  abort.abort(new Error('fixture deadline'));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false); assert.equal(calls, 1);
  await assert.rejects(gate.run(async () => { calls++; }), /closed/);
  finish.resolve(); await active; await assert.rejects(closing, /fixture deadline/); assert.equal(calls, 1);
});
