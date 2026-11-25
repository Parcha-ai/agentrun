// A turn's answer is the agent's text after its last call, never the narration it wrote while a call of its was in
// flight: Cursor 2026.11.13 writes "Running it now…" after announcing its own shell call and before it ends, and the
// answer came out "…approved.6765". The narration is the answer only when nothing follows it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fakeRecipe, openSession, scratch, transcript } from './helpers.mjs';

const answers = async (store) => (await transcript(store)).filter((e) => e.type === 'message' && e.role === 'assistant').map((e) => e.text);

for (const style of ['cursor', 'goose-1.59']) {
  test(`the narration written while the agent's own call is in flight is not part of the answer after it (${style})`, async (t) => {
    const recipe = fakeRecipe(scratch(), { script: [{ native: 'execute', title: 'python3 fib.py', input: { command: 'python3 fib.py' }, narrate: 'Running it now, using the same command the person approved.' }, { say: '6765' }], style });
    const { session, store } = await openSession(t, recipe, { gate: async () => 'allow' });
    await session.send('go');
    assert.equal((await session.turnEnd()).status, 'completed');
    // Before: ['Running it now, using the same command the person approved.6765'].
    assert.deepEqual(await answers(store), ['6765']);
  });
}

test('narration with nothing after the call is the answer, not an empty one', async (t) => {
  const recipe = fakeRecipe(scratch(), { script: [{ native: 'execute', title: 'ls', input: { command: 'ls' }, narrate: 'Listed the folder; fib.py is not there.' }], style: 'cursor' });
  const { session, store } = await openSession(t, recipe, { gate: async () => 'allow' });
  await session.send('go');
  assert.equal((await session.turnEnd()).status, 'completed');
  assert.deepEqual(await answers(store), ['Listed the folder; fib.py is not there.']);
});
