// An optional placeholder: a whole-string state value marked `?` ("{draft?}") is null while its path is absent and the
// path's value once present. A re-pick loop's answer step reads its own failed draft that way: its state map names the
// compact facts and "{answer?}", so the first pass (no draft yet) reads null and the second the draft, and the step
// never needs the whole state (the pages included) to see it. Unmarked, an absent path still fails the step.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runWorkflow, validateWorkflow } from '../dist/index.js';

const SCHEMAS = {
  In: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
  Answer: { type: 'object', properties: { text: { type: 'string' }, done: { type: 'boolean' } }, required: ['text', 'done'] },
};
const flow = (state) => ({
  v: 2, name: 'repick', schemas: SCHEMAS, input: { schemaId: 'In' }, output: { schemaId: 'Answer', path: 'answer' },
  root: { node: 'loop', label: 'repick', maxIters: 2, until: { predicate: 'field_true', path: 'answer.done' },
    body: { node: 'decide', label: 'answer', instructions: 'Answer the question; a draft in state was not done.', state, out: 'Answer', as: 'answer' } },
});
/** Runs `doc`: each pass's prompt state, and the n-th answer done only on the second pass. */
const run = async (doc) => {
  const seen = [];
  const result = await runWorkflow(doc, { question: 'Why?' }, {
    // The node's prompt state is its user message, as JSON.
    runNode: async ({ user }) => {
      seen.push(JSON.parse(user));
      return { text: `pass ${seen.length}`, done: seen.length === 2 };
    },
  }).catch((error) => ({ status: 'threw', error }));
  return { result, seen };
};

test('an optional placeholder is null on the loop\'s first pass and the failed draft on its second, its type kept', async () => {
  const doc = flow({ question: '{question}', draft: '{answer?}' });
  assert.equal(validateWorkflow(doc, { input: { question: 'Why?' } }).ok, true, JSON.stringify(validateWorkflow(doc, { input: { question: 'Why?' } })));
  const { result, seen } = await run(doc);
  assert.equal(result.status, 'complete', JSON.stringify(result));
  assert.deepEqual(seen, [{ question: 'Why?', draft: null }, { question: 'Why?', draft: { text: 'pass 1', done: false } }]);
  assert.deepEqual(result.output, { text: 'pass 2', done: true });
});

test('unmarked, the same absent path fails the first pass with missing_interpolation, as before', async () => {
  const { result, seen } = await run(flow({ question: '{question}', draft: '{answer}' }));
  assert.equal(seen.length, 0, 'the step never ran');
  assert.match(String(result.error?.message ?? JSON.stringify(result)), /interpolation path "answer" is not present in the state/);
});

test('the mark reads the state. prefix and a nested path; inside a longer string it is literal text, never a placeholder', async () => {
  const nested = await run(flow({ draft: '{state.answer.text?}', note: 'was {answer?}' }));
  assert.equal(nested.result.status, 'complete', JSON.stringify(nested.result));
  assert.deepEqual(nested.seen, [{ draft: null, note: 'was {answer?}' }, { draft: 'pass 1', note: 'was {answer?}' }]);
});
