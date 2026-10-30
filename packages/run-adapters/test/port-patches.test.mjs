// What one of the port's patches changes, pinned so that dropping one goes red by name (the port's patch files name these
// tests in their `Pins:` lines). The built-in begin is pinned in kernel.test.mjs; the other patches change comments only.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDrive } from '@parcha/agentrun-adapters/kernel';
import * as shared from '@parcha/agentrun-adapters/process';
import { memorySessionStore } from '@parcha/agentrun-adapters/testing';

test("the shared process layer's errors name this package", async () => {
  const drive = await openDrive({ writer: await memorySessionStore().open('run-1'), signal: new AbortController().signal });
  const tool = { name: 'pay', description: 'Pay.', inputSchema: { type: 'object' }, replay: 'safe', execute: async () => 'paid' };
  await assert.rejects(shared.toolBridge(drive, [tool]).call('pay', {}, ''), /^TypeError: agentrun-adapters: a call to pay has no call id/);
  await assert.rejects(new shared.BuiltinCalls(drive, { live: false }).begin({ callId: '', name: 'Bash', input: {}, replay: 'safe' }), /^TypeError: agentrun-adapters: a built-in Bash call has no call id/);
  const dir = await mkdtemp(join(tmpdir(), 'agentrun-tail-'));
  try {
    const file = join(dir, 'session.jsonl');
    await writeFile(file, '{"a":1}\n{"a":2}\n');
    const tail = new shared.FileTail(file);
    assert.equal(tail.read().length, 2);
    await writeFile(file, '{"a":1}\n');
    assert.throws(() => tail.read(), /^Error: agentrun-adapters: .* shrank from /);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the tool bridge returns a tool's images as recorded", async () => {
  const drive = await openDrive({ writer: await memorySessionStore().open('run-2'), signal: new AbortController().signal });
  const images = [{ mimeType: 'image/png', data: 'AAAA' }];
  const shot = { name: 'shot', description: 'A screenshot.', inputSchema: { type: 'object' }, replay: 'safe', execute: async () => ({ text: 'the page', images }) };
  const first = await shared.toolBridge(drive, [shot]).call('shot', {}, 'c1');
  assert.deepEqual(first, { text: 'the page', isError: false, images });
  const again = await shared.toolBridge(drive, [shot]).call('shot', {}, 'c1');
  assert.deepEqual(again.images, images, 'a call the log already finished comes back with its images');
});

/** A session whose turn a crash cut off: one prompt placed, one tool call open, and one message sent since. */
async function cutOffSession() {
  const store = memorySessionStore();
  const drive = await openDrive({ writer: await store.open('run-3'), signal: new AbortController().signal });
  await drive.submit({ id: 's1', kind: 'prompt', text: 'Pay the invoice SECRET-PROMPT.' });
  await shared.placeSubmissions(drive, [drive.pending()[0]]);
  await new shared.NativeJournal(drive).message({ type: 'message', role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'pay' }] });
  await drive.submit({ id: 's2', kind: 'followUp', text: 'And the receipt SECRET-PENDING.' });
  return openDrive({ writer: await store.open('run-3'), signal: new AbortController().signal });
}

test('recoverySystemNote carries no user prompt text and starts with the harness prefix', async () => {
  const next = await cutOffSession();
  const note = shared.recoverySystemNote(next.state());
  assert.ok(note?.startsWith('The harness, not the user, adds this about the turn before this one:\n[Recovery] '));
  assert.doesNotMatch(note, /SECRET-PROMPT|SECRET-PENDING|New messages since then|The user's message in that turn/);
  // The same text the Claude adapter builds for the same state: its prefix, then the note without prompts or pending messages.
  assert.equal(note, `The harness, not the user, adds this about the turn before this one:\n${shared.recoveryNote(next.state(), { pending: [] }).text}`);
  assert.equal(shared.recoverySystemNote((await openDrive({ writer: await memorySessionStore().open('run-4'), signal: new AbortController().signal })).state()), undefined, 'nothing to recover, no note');
});

test('recoveryUserTurn gives a bare nudge with nothing lost, and the prompts then pending otherwise', () => {
  assert.equal(shared.recoveryUserTurn([], []), 'Continue.');
  assert.equal(shared.recoveryUserTurn(['first', 'second'], ['third']), 'first\n\nsecond\n\nthird');
  assert.equal(shared.recoveryUserTurn([], ['only pending']), 'only pending');
  assert.equal(shared.recoveryUserTurn(['', ''], []), 'Continue.');
});
