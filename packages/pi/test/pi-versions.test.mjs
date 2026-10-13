// What differs between the pi-durable versions the package supports: the key a tool result's blocks are read from, a
// result every version reads the same, the refusal of a result the loaded version would read as empty, and the storage
// error behind a failed Session.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NewerTaskError, refuseNewerTasks, RESULT_KEY, resultBlocks, storageError, toolResult, ToolResultKeyError } from '../dist/durable/pi-versions.js';
import { hostKey, installedPiDurable, resultOf } from './fixtures/pi-version.mjs';

const OTHER = RESULT_KEY === 'output' ? 'content' : 'output';
const blocks = [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }];

test('the result key is the one the installed pi-durable reads: output from 1.2, content before it', () => {
  const [major, minor] = installedPiDurable().split('.').map(Number);
  assert.equal(RESULT_KEY, major > 1 || minor >= 2 ? 'output' : 'content');
});

test('a result this package writes carries its blocks under both keys, each its own copy, with its other fields', () => {
  const result = toolResult(blocks, { isError: true, details: { why: 'x' }, control: { terminate: true } });
  assert.deepEqual(result, { isError: true, details: { why: 'x' }, control: { terminate: true }, content: blocks, output: blocks });
  assert.notEqual(result.content, result.output);
  assert.notEqual(result.content[0], blocks[0]);
});

test("a received result is read under the loaded version's key; one with its blocks only under the other key is refused, naming the tool", () => {
  assert.deepEqual(resultBlocks('search', resultOf(blocks)), blocks);
  assert.deepEqual(resultBlocks('search', toolResult(blocks)), blocks);
  assert.equal(resultBlocks('search', { details: { streamed: true } }), undefined, 'no blocks: pi shows what the tool streamed');
  assert.equal(resultBlocks('search', 'plain text'), undefined);
  assert.equal(resultBlocks('search', null), undefined);
  assert.throws(() => resultBlocks('search', { [OTHER]: blocks }), (error) => {
    assert.ok(error instanceof ToolResultKeyError);
    assert.equal(error.code, 'TOOL_RESULT_KEY');
    assert.equal(error.tool, 'search');
    assert.equal(error.message, `search returned its result under "${OTHER}", and the loaded pi-durable reads "${RESULT_KEY}": the model would receive an empty result. Return the blocks under "${RESULT_KEY}", or under both keys.`);
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

test('before pi-durable 1.2, a live pi.tool task above version 1 is refused with a typed error; on 1.2, and for any other task, nothing is', async () => {
  const harness = (records) => ({ inspect: async () => ({ tasks: records.map((record) => ({ record })) }) });
  const newer = harness([{ id: 3, kind: 'pi.generation', version: 1 }, { id: 4, kind: 'pi.tool', version: 2 }]);
  if (hostKey() === 'output') await refuseNewerTasks(newer, {});
  else await assert.rejects(refuseNewerTasks(newer, {}), (error) => error instanceof NewerTaskError && error.code === 'PI_TASK_NEWER' && error.kind === 'pi.tool' && error.version === 2);
  await refuseNewerTasks(harness([{ id: 4, kind: 'pi.tool', version: 1 }, { id: 5, kind: 'agentrun.workflow', version: 3 }]), {});
});
