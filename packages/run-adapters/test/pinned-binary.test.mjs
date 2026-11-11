// A harness's binary hashed for its pins with the host's event loop free: the async pair gives the synchronous pair's
// answers, and a check that passed under one answers the other at once.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { checkedOnce, checkedOnceAsync, sha256OfFile, sha256OfFileAsync } from '@parcha/agentrun-kernel/host';

const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-pinned-binary-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

test('the async sha256 is the synchronous one, and it hands the event loop back between chunks', async () => {
  const path = join(ROOT, 'binary');
  writeFileSync(path, randomBytes(5 * (1 << 20) + 7));
  let ran = false;
  // Queued before the hash starts: a hash that held the event loop to its end would leave it unrun until after.
  setImmediate(() => { ran = true; });
  const hashing = sha256OfFileAsync(path);
  const found = await hashing;
  assert.equal(found, sha256OfFile(path));
  assert.ok(ran, 'a callback queued before the hash ran while it read the file');
  await assert.rejects(sha256OfFileAsync(join(ROOT, 'none')), { code: 'ENOENT' });
});

test('a check that passed under checkedOnceAsync is answered by checkedOnce at once, and a refusal is never kept', async () => {
  const path = join(ROOT, 'checked');
  writeFileSync(path, 'a binary');
  let checks = 0;
  const ok = (result) => result === 'pinned';
  assert.equal(await checkedOnceAsync(path, 'pins-a', async () => (checks++, 'pinned'), ok), 'pinned');
  assert.equal(checkedOnce(path, 'pins-a', () => (checks++, 'checked again'), ok), 'pinned', "the synchronous check: the async one's answer");
  assert.equal(await checkedOnceAsync(path, 'pins-a', async () => (checks++, 'checked again'), ok), 'pinned');
  assert.equal(checks, 1);
  assert.equal(await checkedOnceAsync(path, 'pins-b', async () => (checks++, 'refused'), ok), 'refused');
  assert.equal(await checkedOnceAsync(path, 'pins-b', async () => (checks++, 'refused'), ok), 'refused', 'a refusal is checked again');
  assert.equal(checks, 3);
});
