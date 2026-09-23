import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Compile } from 'typebox/compile';
import { dryRunWorkflow, synthesizeInstance } from '../dist/index.js';

const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const workflow = (schema, root) => ({ v: 2, name: 'dry-run-boundary', schemas: { Result: schema }, output: { schemaId: 'Result', path: 'result' }, root });

test('numeric synthesis intersects inclusive and exclusive bounds on both sides', async () => {
  const intervals = [
    { minimum: 0, exclusiveMinimum: 5, maximum: 10 },
    { minimum: 8, exclusiveMinimum: 5, maximum: 10 },
    { minimum: 0, maximum: 10, exclusiveMaximum: 5 },
    { minimum: 0, maximum: 3, exclusiveMaximum: 5 },
    { minimum: 5, exclusiveMinimum: 5, maximum: 10 },
    { minimum: 0, maximum: 5, exclusiveMaximum: 5 },
    { minimum: 0, exclusiveMinimum: 5, maximum: 10, exclusiveMaximum: 8 },
    { minimum: -10, exclusiveMinimum: -5, maximum: -1, exclusiveMaximum: -2 },
    { minimum: -10, maximum: -1, exclusiveMaximum: -5 },
  ];
  for (const type of ['number', 'integer']) {
    for (const interval of intervals) {
      const field = { type, ...interval };
      const value = synthesizeInstance(field);
      assert.equal(Compile(field).Check(value), true, `${JSON.stringify(field)} synthesized invalid ${value}`);
      const candidate = workflow(object({ value: field }), { node: 'extract', label: 'extract', instructions: 'Return a bounded value', out: 'Result', as: 'result' });
      assert.deepEqual(await dryRunWorkflow(candidate), { ok: true }, JSON.stringify(field));
    }
  }
});

test('numeric bounds remain strict when an inclusive and exclusive endpoint coincide', () => {
  assert.equal(synthesizeInstance({ type: 'integer', minimum: 5, exclusiveMinimum: 5, maximum: 6 }), 6);
  assert.equal(synthesizeInstance({ type: 'integer', minimum: -6, maximum: -5, exclusiveMaximum: -5 }), -6);
  const schema = { type: 'number', minimum: 0, exclusiveMinimum: 0, maximum: Number.MIN_VALUE };
  assert.equal(Compile(schema).Check(synthesizeInstance(schema)), true);
});

test('a thrown error mentioning context is a failure, including with caller-provided context', async () => {
  const candidate = workflow(object({ count: { type: 'number' } }), { node: 'code', label: 'explode', code: 's => { throw new Error("context.invalid"); }' });
  for (const options of [{}, { input: { context: { actual: true } } }, { probeContext: { references: {} } }]) {
    const result = await dryRunWorkflow(candidate, options);
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.stage, 'explode');
    assert.match(result.problems.join('\n'), /context\.invalid/);
    assert.equal('skipped' in result, false);
  }
});

test('validation errors mentioning context cannot become successful skips', async () => {
  const candidate = workflow(object({ count: { type: 'number' } }), { node: 'unknown', label: 'context.invalid' });
  candidate.name = 'context.invalid';
  const result = await dryRunWorkflow(candidate);
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.match(result.problems.join('\n'), /context\.invalid/);
});

test('dry run discovers unsupported synthesis constraints inside a mapped child', async () => {
  const resultSchema = object({ code: { type: 'string', pattern: '^ABC$' } });
  const child = workflow(resultSchema, { node: 'extract', label: 'extract-code', instructions: 'Return the code.', out: 'Result', as: 'result' });
  child.schemas.Input = { type: 'object' };
  child.input = { schemaId: 'Input' };
  const candidate = workflow({ type: 'array', items: { type: 'object' } }, {
    node: 'map', label: 'records', itemsPath: 'records', as: 'result',
    body: { node: 'workflow', label: 'screen', workflow: child, input: {}, out: 'ChildResult', as: 'result' },
  });
  candidate.schemas.ChildResult = { type: 'object' };
  const result = await dryRunWorkflow(candidate, { input: { records: [{}] } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.skipped.some(reason => /Result\/properties\/code: pattern/.test(reason)), JSON.stringify(result));
});
