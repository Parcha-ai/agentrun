// What a dry run synthesizes is bounded too, not only its steps: synthesis counts every value and string character it
// makes against a budget (SYNTHESIS_BUDGET by default, DryRunOptions.budget to set it) and throws past it, so a schema
// that asks for a huge value (two nested arrays of minItems 10000: 100M items) stops at the budget, quickly and having
// built no more than it, and the dry run ends not run, saying the schema is too large to synthesize.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dryRunWorkflow, synthesizeInstance } from '../dist/index.js';

const grid = { type: 'array', minItems: 10_000, items: { type: 'array', minItems: 10_000, items: { type: 'string' } } };
const Question = { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] };
const Answer = { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'] };
/** One extract step; the huge arrays in its input schema (`at: 'input'`) or its output schema (`at: 'output'`). */
const huge = (at) => ({
  v: 2, name: `huge-${at}`,
  schemas: { Question: at === 'input' ? { ...Question, properties: { ...Question.properties, grid } } : Question, Answer: at === 'output' ? { ...Answer, properties: { ...Answer.properties, grid } } : Answer },
  input: { schemaId: 'Question' }, output: { schemaId: 'Answer', path: 'answer' },
  root: { node: 'chain', steps: [{ node: 'extract', label: 'answer', instructions: 'Answer.', out: 'Answer', as: 'answer' }] },
});
const notRunTooLarge = (result) => {
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, 'not_run', JSON.stringify(result));
  assert.ok(result.skipped?.some((reason) => /the schema is too large to synthesize/.test(reason)), JSON.stringify(result.skipped));
};

test('synthesis of a 10000 x 10000 schema throws inside synthesis, at the default budget, within a time bound', () => {
  const started = Date.now();
  assert.throws(() => synthesizeInstance(grid), { name: 'SynthesisTooLarge', message: /the schema is too large to synthesize/ });
  assert.ok(Date.now() - started < 2_000, `stopped in ${Date.now() - started} ms`);
  // A length past what an array may hold at all is the same refusal, never a RangeError.
  assert.throws(() => synthesizeInstance({ type: 'array', minItems: 1e12, items: { type: 'number' } }), { name: 'SynthesisTooLarge' });
  assert.throws(() => synthesizeInstance({ type: 'string', minLength: 1e12 }), { name: 'SynthesisTooLarge' });
});

test('a dry run whose input or step answer would be huge ends not run, the schema too large to synthesize, within a time bound', async () => {
  for (const [flow, input] of [[huge('input'), undefined], [huge('output'), { question: 'q' }]]) {
    const started = Date.now();
    notRunTooLarge(await dryRunWorkflow(flow, input ? { input } : {}));
    assert.ok(Date.now() - started < 5_000, `${flow.name}: stopped in ${Date.now() - started} ms`);
  }
});

test('the budget is the whole dry run\'s and can be set: a small one stops a workflow the default runs', async () => {
  const flow = huge('none');
  flow.schemas.Answer = { ...Answer, properties: { ...Answer.properties, rows: { type: 'array', minItems: 50, items: { type: 'string', minLength: 10 } } } };
  assert.equal((await dryRunWorkflow(flow, { input: { question: 'q' } })).status, 'passed');
  notRunTooLarge(await dryRunWorkflow(flow, { input: { question: 'q' }, budget: { values: 20 } }));
  notRunTooLarge(await dryRunWorkflow(flow, { input: { question: 'q' }, budget: { chars: 100 } }));
});
