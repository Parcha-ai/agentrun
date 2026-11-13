// What the package holds pi-durable 1.5 to: a tool result's blocks are its `output`, and a failed Session's error is the storage's.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { storageError, toolResult } from '../dist/workflow/pi-versions.js';

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
