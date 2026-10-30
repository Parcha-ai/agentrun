// What one of the port's patches changes, pinned so that dropping one goes red by name (the port's patch files name these
// tests in their `Pins:` lines). The built-in begin is pinned in kernel.test.mjs; the other patches change comments only.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDrive } from '@parcha/agentrun-kernel/kernel';
import * as shared from '@parcha/agentrun-kernel/process';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';

test("the shared process layer's errors name this package", async () => {
  const drive = await openDrive({ writer: await memorySessionStore().open('run-1'), signal: new AbortController().signal });
  const tool = { name: 'pay', description: 'Pay.', inputSchema: { type: 'object' }, replay: 'safe', execute: async () => 'paid' };
  await assert.rejects(shared.toolBridge(drive, [tool]).call('pay', {}, ''), /^TypeError: agentrun-kernel: a call to pay has no call id/);
  await assert.rejects(new shared.BuiltinCalls(drive, { live: false }).begin({ callId: '', name: 'Bash', input: {}, replay: 'safe' }), /^TypeError: agentrun-kernel: a built-in Bash call has no call id/);
  const dir = await mkdtemp(join(tmpdir(), 'agentrun-tail-'));
  try {
    const file = join(dir, 'session.jsonl');
    await writeFile(file, '{"a":1}\n{"a":2}\n');
    const tail = new shared.FileTail(file);
    assert.equal(tail.read().length, 2);
    await writeFile(file, '{"a":1}\n');
    assert.throws(() => tail.read(), /^Error: agentrun-kernel: .* shrank from /);
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
