// What two of the port's patches change, pinned so that dropping one goes red by name (the port's patch files name these
// tests in their `Pins:` lines). The other patches are pinned in kernel.test.mjs (the built-in begin) or change comments only.
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

test('the shared process layer exports no waitForSubmissions', () => {
  assert.equal('waitForSubmissions' in shared, false);
  assert.equal(typeof shared.placeSubmissions, 'function', 'the rest of the inbox is still exported');
});
