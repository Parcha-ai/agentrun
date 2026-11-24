// The debug line for each call the agent announces ("acp: the agent announced a call"): its toolCallId, its kind, the
// word at the recipe's announces.tool and the tool of ours it named, never its input or the agent's text. Written only
// with the adapter's debug option (serve's AGENTRUN_LOG=debug) and only on a recipe that declares announces.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fakeRecipe, openSession, scratch, tool } from './helpers.mjs';

const LINE = 'acp: the agent announced a call';
const SCRIPT = { script: [{ call: 'ping', args: { secret: 'never logged' } }, { say: 'done' }] };

async function announced(t, recipe, options) {
  const lines = [];
  const { session } = await openSession(t, recipe, {
    tools: [tool('ping', () => 'pong')],
    options: { ...options, log: (message, fields) => lines.push({ message, ...fields }) },
  });
  await session.send('go');
  assert.equal((await session.turnEnd()).status, 'completed');
  return lines.filter((line) => line.message === LINE);
}

test('with debug on a recipe that declares announces, each announced call is logged by its toolCallId, kind and the word its field holds, never its input', async (t) => {
  const lines = await announced(t, fakeRecipe(scratch(), SCRIPT), { debug: true });
  assert.deepEqual(lines, [{ message: LINE, toolCallId: 'call_0', kind: 'other', field: 'agentrun__ping', ours: 'ping' }]);
  assert.equal(JSON.stringify(lines).includes('never logged'), false);
});

test('with debug on a recipe that declares no announces field, no announced call is logged', async (t) => {
  assert.deepEqual(await announced(t, fakeRecipe(scratch(), SCRIPT, { announces: undefined }), { debug: true }), []);
});

test('without debug, no announced call is logged', async (t) => {
  assert.deepEqual(await announced(t, fakeRecipe(scratch(), SCRIPT), {}), []);
});
