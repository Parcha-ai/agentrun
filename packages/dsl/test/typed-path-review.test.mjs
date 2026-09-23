// Independent fictional regressions; adapters are deterministic and make no model calls.
import assert from 'node:assert/strict';
import test from 'node:test';
import { validateWorkflow, runWorkflow, inspectWorkflow, formatWorkflowTree } from '../dist/index.js';

const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const value = object({ value: { type: 'number' } });
const judge = async () => ({ answers: { sound: { type: 'noul', noul: 1 } } });
const deps = { runNode: async request => request.label === 'produce' ? { value: 1 } : JSON.parse(request.user), runJudge: judge };

test('tuple prefix items are not constrained by the trailing item schema during preflight', async () => {
  const workflow = { v: 2, name: 'Fictional tuple input', schemas: {
    Input: object({ rows: { type: 'array', prefixItems: [value], items: object({ other: { type: 'string' } }) } }),
    Result: value,
  }, input: { schemaId: 'Input' }, output: { schemaId: 'Result', path: 'result' }, root: {
    node: 'extract', label: 'consume', as: 'result', instructions: 'Return the fictional tuple value.',
    out: 'Result', state: { value: '{rows.0.value}' }, requires: ['rows.0.value'],
  } };
  const input = { rows: [{ value: 7 }, { other: 'fictional' }] };
  assert.deepEqual(validateWorkflow(workflow, { executeCode: false, input }), { ok: true });
  assert.deepEqual((await runWorkflow(workflow, input, deps)).output, { value: 7 });
});

test('a verified producer replaces an old typed verifier sidecar', async () => {
  const workflow = { v: 2, name: 'Fictional overwritten verifier sidecar', schemas: {
    Input: object({ 'answer$verify': object({ old: { type: 'number' } }) }), Result: value,
    Questions: object({ sound: { type: 'boolean', description: 'Is the fictional candidate sound?' } }),
  }, input: { schemaId: 'Input' }, output: { schemaId: 'Result', path: 'result' }, root: { node: 'chain', steps: [
    { node: 'extract', label: 'produce', as: 'answer', instructions: 'Return a fictional number.', out: 'Result', verify: { out: 'Questions' } },
    { node: 'extract', label: 'consume', as: 'result', instructions: 'Return the drive number.', out: 'Result', state: { value: '{answer$verify.drives.0.drive}' } },
  ] } };
  const input = { 'answer$verify': { old: 0 } };
  assert.deepEqual(validateWorkflow(workflow, { executeCode: false, input }), { ok: true });
  assert.deepEqual((await runWorkflow(workflow, input, deps)).output, { value: 1 });
});

test('literal state namespace takes precedence over the optional interpolation alias', async () => {
  const workflow = { v: 2, name: 'Fictional literal state namespace', schemas: {
    Input: object({ state: object({ foo: value }), foo: object({ old: { type: 'number' } }) }), Result: value,
  }, input: { schemaId: 'Input' }, output: { schemaId: 'Result', path: 'result' }, root: {
    node: 'extract', label: 'consume', as: 'result', instructions: 'Use the actual state namespace.', out: 'Result', state: { value: '{state.foo.value}' },
  } };
  const input = { state: { foo: { value: 7 } }, foo: { old: 0 } };
  assert.deepEqual(validateWorkflow(workflow, { executeCode: false, input }), { ok: true });
  assert.deepEqual((await runWorkflow(workflow, input, deps)).output, { value: 7 });
});

test('sift inspection does not mislabel its aggregate with the per-item question schema', async () => {
  const workflow = { v: 2, name: 'Fictional sift wrapper', schemas: {
    Questions: object({ sound: { type: 'boolean', description: 'Does this fictional row qualify?' } }), Result: { type: 'object' },
  }, output: { schemaId: 'Result', path: 'selected' }, root: { node: 'sift', label: 'select', itemsPath: 'rows', out: 'Questions', as: 'selected' } };
  const view = inspectWorkflow(workflow);
  assert.equal(view.nodes[0].outputSchema, undefined);
  assert.deepEqual(Object.keys((await runWorkflow(workflow, { rows: [] }, { runJudge: judge })).output).sort(), ['answers', 'items', 'kept', 'values']);
});

for (const binding of ['omitted', 'explicit', 'resultPath']) test(`map inspection agrees with runtime for ${binding} body binding`, async () => {
  const body = { node: 'extract', label: 'leaf', instructions: 'Return the fictional value.', out: 'Value', state: { value: '{item}' },
    ...(binding === 'explicit' ? { as: 'record' } : {}) };
  const workflow = { v: 2, name: 'Fictional map binding', schemas: { Value: value, Result: { type: 'array' } },
    output: { schemaId: 'Result', path: 'rows' }, root: { node: 'map', label: 'mapped', itemsPath: 'numbers', as: 'rows', body,
      ...(binding === 'resultPath' ? { resultPath: 'leaf.value' } : {}) } };
  const view = inspectWorkflow(workflow), tree = formatWorkflowTree(view);
  const result = (await runWorkflow(workflow, { numbers: [7] }, deps)).output;
  if (binding === 'omitted') {
    assert.equal(view.nodes[0].resultPath, undefined);
    assert.match(tree, /whole item state/);
    assert.deepEqual(result, [{ numbers: [7], item: 7, item_index: 0, leaf: { value: 7 } }]);
  } else if (binding === 'explicit') {
    assert.equal(view.nodes[0].resultPath, 'record');
    assert.match(tree, /select record/);
    assert.deepEqual(result, [{ value: 7 }]);
  } else {
    assert.equal(view.nodes[0].resultPath, 'leaf.value');
    assert.deepEqual(result, [7]);
  }
});
