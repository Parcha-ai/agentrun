import test from 'node:test';
import assert from 'node:assert/strict';
import { workflowToolContext } from '../dist/workflow/tool-context.js';
import { PiRunError } from '../dist/workflow/run-error.js';

test('a workflow tool context keeps the host context and answers a nested call with an error outcome', async () => {
  const host = { cwd: '/work', get model() { return 'm'; } };
  const ctx = workflowToolContext(host);
  assert.equal(ctx.cwd, '/work');
  assert.equal(ctx.model, 'm');
  assert.deepEqual([...ctx.tools], []);
  const outcome = await ctx.executeTool('search', { q: 'x' });
  assert.equal(outcome.isError, true);
  assert.equal(outcome.toolCall.name, 'search');
  assert.deepEqual(outcome.toolCall.arguments, { q: 'x' });
  assert.match(outcome.result.content[0].text, /cannot call the tool search/);
  assert.equal(Object.hasOwn(host, 'executeTool'), false);
});

test('PiRunError names its reason and the turns and submissions it reached', () => {
  const error = new PiRunError('timeout', 2, 1);
  assert.equal(error.name, 'PiRunError');
  assert.match(error.message, /timeout \(2 turns, 1 submissions\)/);
});
