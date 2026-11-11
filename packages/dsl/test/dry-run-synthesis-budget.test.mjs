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

test('a const or an enum literal is charged its size: a long literal does not escape the character budget', () => {
  const long = 'x'.repeat(5_000);
  assert.throws(() => synthesizeInstance({ const: long }, {}, 0, { chars: 1_000 }), { name: 'SynthesisTooLarge' });
  assert.throws(() => synthesizeInstance({ enum: [{ text: long }] }, {}, 0, { chars: 1_000 }), { name: 'SynthesisTooLarge' });
  assert.equal(synthesizeInstance({ const: 'short' }, {}, 0, { chars: 1_000 }), 'short');
});

test('a budget field given as undefined keeps the default: it never lifts the limit', () => {
  assert.throws(() => synthesizeInstance(grid, {}, 0, { values: undefined, chars: undefined }), { name: 'SynthesisTooLarge' });
});

test('a $ref, an anyOf or a oneOf is no value of its own: one value is charged per value produced', () => {
  const definitions = { N: { type: 'number' } };
  // Each wraps one number: exactly one value, so a budget of one value holds it.
  for (const schema of [{ $ref: '#/definitions/N' }, { anyOf: [{ type: 'null' }, { type: 'number' }] }, { oneOf: [{ $ref: '#/definitions/N' }] }]) {
    assert.equal(synthesizeInstance(schema, definitions, 0, { values: 1 }), 0, JSON.stringify(schema));
  }
});

test('the budget is shared by the whole dry run: an input and two answers that each fit alone stop it together', async () => {
  const rows = { type: 'array', minItems: 30, items: { type: 'number' } };
  const Rows = { type: 'object', properties: { rows }, required: ['rows'] };
  const flow = {
    v: 2, name: 'shared', schemas: { Rows },
    input: { schemaId: 'Rows' }, output: { schemaId: 'Rows', path: 'second' },
    root: { node: 'chain', steps: [
      { node: 'extract', label: 'first', instructions: 'Copy.', out: 'Rows', as: 'first' },
      { node: 'extract', label: 'second', instructions: 'Copy.', out: 'Rows', as: 'second' },
    ] },
  };
  // One Rows is 32 values (the object, the array, 30 numbers): each of the three fits 40 alone; together they are 96.
  assert.doesNotThrow(() => synthesizeInstance(Rows, {}, 0, { values: 40 }));
  notRunTooLarge(await dryRunWorkflow(flow, { budget: { values: 40 } }));
  notRunTooLarge(await dryRunWorkflow(flow, { budget: { values: 80 } }));
  assert.equal((await dryRunWorkflow(flow, { budget: { values: 100 } })).status, 'passed');
});

test('a loop whose body asks for nothing (a map over an empty list) and never ends stops at its node visits\' bound, within a time bound', async () => {
  const Q = { type: 'object', properties: { items: { type: 'array', maxItems: 0, items: { type: 'string' } }, done: { type: 'boolean' } }, required: ['items', 'done'] };
  const flow = {
    v: 2, name: 'spin', schemas: { Q, Answer },
    input: { schemaId: 'Q' }, output: { schemaId: 'Answer', path: 'answer' },
    root: { node: 'chain', steps: [
      { node: 'loop', label: 'spin', maxIters: 100_000_000, until: { predicate: 'field_true', path: 'done' }, body: { node: 'map', label: 'each', itemsPath: 'items', as: 'seen', body: { node: 'extract', label: 'one', instructions: 'x', out: 'Answer', as: 'one' } } },
      { node: 'extract', label: 'answer', instructions: 'Answer.', out: 'Answer', as: 'answer' },
    ] },
  };
  const started = Date.now();
  const result = await dryRunWorkflow(flow, { input: { items: [], done: false }, maxSteps: 500 });
  assert.ok(Date.now() - started < 5_000, `stopped in ${Date.now() - started} ms`);
  assert.equal(result.status, 'not_run', JSON.stringify(result));
  assert.ok(result.skipped?.some((reason) => /stopped after 5000 node visits/.test(reason)), `ten times maxSteps by default: ${JSON.stringify(result.skipped)}`);
  const capped = await dryRunWorkflow(flow, { input: { items: [], done: false }, maxVisits: 50 });
  assert.ok(capped.skipped?.some((reason) => /stopped after 50 node visits/.test(reason)), JSON.stringify(capped.skipped));
});

test('a dry run stops by the clock too: past its deadline it ends not run', async () => {
  const Q = { type: 'object', properties: { items: { type: 'array', maxItems: 0, items: { type: 'string' } }, done: { type: 'boolean' } }, required: ['items', 'done'] };
  const flow = {
    v: 2, name: 'slow', schemas: { Q, Answer }, input: { schemaId: 'Q' }, output: { schemaId: 'Answer', path: 'answer' },
    root: { node: 'chain', steps: [
      { node: 'loop', label: 'spin', maxIters: 100_000_000, until: { predicate: 'field_true', path: 'done' }, body: { node: 'map', label: 'each', itemsPath: 'items', as: 'seen', body: { node: 'extract', label: 'one', instructions: 'x', out: 'Answer', as: 'one' } } },
      { node: 'extract', label: 'answer', instructions: 'Answer.', out: 'Answer', as: 'answer' },
    ] },
  };
  const started = Date.now();
  const result = await dryRunWorkflow(flow, { input: { items: [], done: false }, maxSteps: 1e12, maxVisits: 1e12, deadlineMs: 200 });
  assert.ok(Date.now() - started < 5_000, `stopped in ${Date.now() - started} ms`);
  assert.equal(result.status, 'not_run', JSON.stringify(result));
  assert.ok(result.skipped?.some((reason) => /past its 200 ms deadline/.test(reason)), JSON.stringify(result.skipped));
});

test('an object\'s property names are charged their characters: 10,000 items each named by a 100,000-character key stop at the character budget, fast', async () => {
  const key = 'k'.repeat(100_000);
  const Rows = { type: 'object', properties: { rows: { type: 'array', minItems: 10_000, items: { type: 'object', properties: { [key]: { type: 'number' } } } } }, required: ['rows'] };
  let started = Date.now();
  assert.throws(() => synthesizeInstance(Rows), { name: 'SynthesisTooLarge' });
  assert.ok(Date.now() - started < 2_000, `stopped in ${Date.now() - started} ms`);
  const flow = {
    v: 2, name: 'keys', schemas: { Q: Question, Rows },
    input: { schemaId: 'Q' }, output: { schemaId: 'Rows', path: 'rows' },
    root: { node: 'chain', steps: [{ node: 'extract', label: 'rows', instructions: 'List.', out: 'Rows', as: 'rows' }] },
  };
  started = Date.now();
  notRunTooLarge(await dryRunWorkflow(flow, { input: { question: 'q' } }));
  assert.ok(Date.now() - started < 5_000, `stopped in ${Date.now() - started} ms`);
  // One key's characters count once per value built under it: a small budget stops a short key too.
  assert.throws(() => synthesizeInstance({ type: 'object', properties: { abcdefghij: { type: 'number' } } }, {}, 0, { chars: 5 }), { name: 'SynthesisTooLarge' });
});

test('a schema synthesis cannot read is a one-character "x", charged as one', () => {
  assert.equal(synthesizeInstance({ type: 'mystery' }, {}, 0, { chars: 1 }), 'x');
  assert.throws(() => synthesizeInstance({ type: 'object', properties: { a: { type: 'mystery' }, b: { type: 'mystery' } } }, {}, 0, { chars: 3 }), { name: 'SynthesisTooLarge' });
});

test('a judge\'s synthetic answers are charged to the shared budget: a map of 6,000 judges whose first choice is 100,000 characters ends not run, fast', async () => {
  const long = 'c'.repeat(100_000);
  const Items = { type: 'object', properties: { items: { type: 'array', minItems: 6_000, items: { type: 'string' } } }, required: ['items'] };
  const Pick = { type: 'object', required: ['kind'], properties: { kind: { type: 'string', enum: [long, 'other'], description: 'Which kind is it?' } } };
  const Out = { type: 'object', properties: { seen: { type: 'array' } } };
  const flow = {
    v: 2, name: 'judges', schemas: { Items, Pick, Out },
    input: { schemaId: 'Items' }, output: { schemaId: 'Out', path: 'all' },
    root: { node: 'chain', steps: [
      { node: 'map', label: 'each', itemsPath: 'items', as: 'seen', body: { node: 'judge', label: 'judge', state: { item: '{item}' }, out: 'Pick', as: 'pick' } },
      { node: 'code', label: 'all', code: 's => ({ all: { seen: s.seen } })' },
    ] },
  };
  const started = Date.now();
  const result = await dryRunWorkflow(flow, { maxSteps: 100_000, maxVisits: 1_000_000, runCode: async (_node, state) => ({ all: { seen: state.seen } }) });
  assert.ok(Date.now() - started < 10_000, `stopped in ${Date.now() - started} ms`);
  notRunTooLarge(result);
});
