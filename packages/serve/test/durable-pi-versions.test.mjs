// What the package holds pi-durable 1.5 to: a tool result's blocks are its `output`, a result whose blocks are only
// under pi 1.1's `content` is refused (it would reach the model empty), and a failed Session's error is the storage's.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RESULT_KEY, resultBlocks, storageError, toolResult, ToolResultKeyError } from '../dist/workflow/pi-versions.js';

const blocks = [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }];

test('the result key is output', () => {
  assert.equal(RESULT_KEY, 'output');
});

test('a result this package writes carries its blocks under output only, its own copy, with its other fields', () => {
  const result = toolResult(blocks, { isError: true, details: { why: 'x' }, control: { terminate: true } });
  assert.deepEqual(result, { isError: true, details: { why: 'x' }, control: { terminate: true }, output: blocks });
  assert.equal('content' in result, false, 'no pi 1.1 key');
  assert.notEqual(result.output[0], blocks[0]);
});

test('a received result is read under output; one with its blocks only under content is refused, naming the tool', () => {
  assert.deepEqual(resultBlocks('search', { output: blocks }), blocks);
  assert.deepEqual(resultBlocks('search', toolResult(blocks)), blocks);
  assert.equal(resultBlocks('search', { details: { streamed: true } }), undefined, 'no blocks: pi shows what the tool streamed');
  assert.equal(resultBlocks('search', 'plain text'), undefined);
  assert.equal(resultBlocks('search', null), undefined);
  assert.throws(() => resultBlocks('search', { content: blocks }), (error) => {
    assert.ok(error instanceof ToolResultKeyError);
    assert.equal(error.code, 'TOOL_RESULT_KEY');
    assert.equal(error.tool, 'search');
    assert.equal(error.message, 'search returned its result under "content", and pi-durable reads "output": the model would receive an empty result. Return the blocks under "output".');
    return true;
  });
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
