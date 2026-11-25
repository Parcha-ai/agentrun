// The debug line for each call the agent announces ("acp: the agent announced a call"): its toolCallId, its kind, the
// word at the recipe's announces.tool when it names a tool of ours ("native" when it names another, null when it holds
// none) and the tool of ours it named, never its input or the agent's text. Written only
// with the adapter's debug option (serve's AGENTRUN_LOG=debug) and only on a recipe that declares announces: at the
// tool_call, and again at the later update that names a call announced with no name.
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

test('with debug, a call announced with no name is logged again when a later update names it, by the tool its field holds there, never its input', async (t) => {
  // Cursor's shape (the fake's "late" announce): a tool_call titled "MCP: tool" with no input, then the update that
  // names it in rawInput.toolName; the update after that (in_progress) names nothing new and writes nothing.
  const lines = await announced(t, fakeRecipe(scratch(), { ...SCRIPT, style: 'cursor', announce: 'late' }), { debug: true });
  assert.deepEqual(lines, [
    { message: LINE, toolCallId: 'call_0', kind: 'other', field: null, ours: null },
    { message: LINE, toolCallId: 'call_0', kind: null, field: 'ping', ours: 'ping' },
  ]);
  assert.equal(JSON.stringify(lines).includes('never logged'), false);
});

test('with debug, a native call whose field holds a name that is not one of ours is logged with field "native", never the name', async (t) => {
  // Cursor's recipe reads the name from inside the call's input (rawInput.toolName): a native call whose arguments hold
  // a toolName must not put it in the debug line. Only a name that maps to one of our listed tools is quoted.
  const script = { script: [{ native: 'read', title: 'Read notes.txt', input: { toolName: 'name-held-in-native-input', path: 'notes.txt' } }, { say: 'done' }] };
  const lines = await announced(t, fakeRecipe(scratch(), { ...script, style: 'cursor' }), { debug: true });
  assert.deepEqual(lines, [{ message: LINE, toolCallId: 'native_0', kind: 'read', field: 'native', ours: null }]);
  assert.equal(JSON.stringify(lines).includes('name-held-in-native-input'), false);
});

test('with debug on a recipe that declares no announces field, no announced call is logged', async (t) => {
  assert.deepEqual(await announced(t, fakeRecipe(scratch(), SCRIPT, { announces: undefined }), { debug: true }), []);
});

test('without debug, no announced call is logged', async (t) => {
  assert.deepEqual(await announced(t, fakeRecipe(scratch(), SCRIPT), {}), []);
});
