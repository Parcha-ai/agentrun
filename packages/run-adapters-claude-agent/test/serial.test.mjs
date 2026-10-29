// K11: a drive opened on a session's writer after another drive was halted must fold what the halted drive wrote last.
// The adapter opens every drive on one serialized writer (src/serial.ts), so the new drive's first read waits for the
// halted drive's queued write. (The probe is the DSL TL's, shaped on the adapter's reopen after an interrupt.)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { foldSession, openDrive } from '@parcha/agentrun-adapters/kernel';
import { memorySessionStore } from '@parcha/agentrun-adapters/testing';
import { serialWriter } from '../dist/serial.js';

/** A session writer whose first outcome append is held until the test releases it. */
async function holdingWriter() {
  const raw = await memorySessionStore().open('s');
  let release;
  let held = false;
  const writer = { key: raw.key, read: () => raw.read(), append: async (records) => {
    if (!held && records.some((r) => r.kind === 'kernel.end')) { held = true; await new Promise((resolve) => { release = resolve; }); }
    return raw.append(records);
  } };
  return { raw, writer, isHeld: () => held, release: () => release() };
}

test('K11: a drive reopened on the serialized writer after a halt folds the halted drive\'s last outcome: a never effect that ran stays completed', async () => {
  const { raw, writer, isHeld, release } = await holdingWriter();
  const serial = serialWriter(writer);
  const a = await openDrive({ writer: serial, signal: new AbortController().signal });
  const done = a.effect('tool:c1', { name: 'tool.pay', replay: 'never' }, async () => 'paid').catch((e) => e);
  while (!isHeld()) await new Promise((resolve) => setTimeout(resolve, 1));
  a.halt(new Error('interrupted'));
  const opening = openDrive({ writer: serial, signal: new AbortController().signal });
  release();
  const b = await opening;
  await done;
  const fresh = foldSession('s', await raw.read()).effects.get('tool:c1');
  assert.equal(fresh.status, 'completed', `the tool ran and paid, but the log says ${fresh.status}`);
  assert.deepEqual([b.state().effects.get('tool:c1').status, b.state().effects.get('tool:c1').output], ['completed', 'paid'], 'the reopened drive folds it completed');
});

test('a serialized writer runs reads and appends in call order, and a failed one does not stall the next', async () => {
  const order = [];
  let fail = true;
  const raw = await memorySessionStore().open('s');
  const serial = serialWriter({ key: raw.key, read: async () => { order.push('read'); return raw.read(); }, append: async (records) => { order.push('append'); if (fail) { fail = false; throw new Error('the disk is full'); } return raw.append(records); } });
  const results = await Promise.allSettled([serial.append([{ kind: 'x', data: 1 }]), serial.read(), serial.append([{ kind: 'x', data: 2 }]), serial.read()]);
  assert.deepEqual(order, ['append', 'read', 'append', 'read']);
  assert.deepEqual(results.map((r) => r.status), ['rejected', 'fulfilled', 'fulfilled', 'fulfilled']);
  assert.deepEqual(results[3].value.map((r) => r.data), [2]);
});
