import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { Compile } from 'typebox/compile';
import { workflowShapeErrors } from '../dist/workflow-shape.js';

// Fictional structural fixtures only; no adapters, inference or code execution.
const schema = createRequire(import.meta.url)('../schema/workflow.schema.json');
const original = Compile(schema);
const workflow = root => ({ v: 2, name: 'Fictional shape diagnostics', schemas: { Result: { type: 'object' } },
  output: { schemaId: 'Result' }, root });
const call = { node: 'call', label: 'read-original', via: 'tool', tool: 'read', args: {}, out: 'Result' };
const messages = root => workflowShapeErrors(workflow(root), true).join('\n');

test('selected call errors identify missing as/deadline rather than unrelated union members', () => {
  const errors = messages({ node: 'chain', steps: [call] });
  assert.match(errors, /workflow\/root\/steps\/0:.*as/);
  assert.match(errors, /deadline_s/);
  assert.doesNotMatch(errors, /required properties (steps|code|instructions)/);
  assert.equal(original.Check(workflow({ node: 'chain', steps: [call] })), false);
});

test('diagnostics traverse nested map, route and child workflow using generated schema references', () => {
  const nested = { node: 'map', label: 'map', itemsPath: 'items', as: 'rows', body: {
    node: 'route', label: 'route', instructions: 'Fictional choice.', state: { item: '{item}' }, branches: {
      'a/b~c': { body: { node: 'workflow', label: 'child', as: 'child', out: 'Result', input: {}, workflow: workflow(call) } },
      other: { body: { node: 'code', label: 'keep', code: '(s) => s' } },
    },
  } };
  assert.match(messages(nested), /workflow\/root\/body\/branches\/a~1b~0c\/body\/workflow\/root:.*as/);
  assert.match(messages(nested), /deadline_s/);
});

test('discriminator selection preserves full-validator acceptance for every node kind and malformed discriminator', () => {
  const roots = schema.definitions.WorkflowNode.anyOf.flatMap(branch => [
    { node: branch.properties.node.const }, { node: branch.properties.node.const, label: 7 },
  ]);
  roots.push(null, 7, [], {}, { node: 'unknown' }, { node: 7 },
    { ...call, as: 'source', deadline_s: 30 },
    { node: 'chain', steps: [{ ...call, as: 'source', deadline_s: 30 }] });
  for (const root of roots) {
    const document = workflow(root);
    assert.equal(workflowShapeErrors(document, true).length === 0, original.Check(document), JSON.stringify(root));
  }
});

test('top-level errors and unknown nested node tags retain rejection without requiring a recognized branch', () => {
  for (const document of [null, [], { ...workflow(call), name: 7 }, workflow({ node: 'chain', steps: [null] }),
    workflow({ node: 'chain', steps: [{ node: 'not-a-node' }] })]) {
    assert.equal(original.Check(document), false);
    assert(workflowShapeErrors(document, true).length > 0);
  }
});

test('diagnostics remain bounded and do not evaluate code or echo supplied argument values', () => {
  const sentinel = 'PRIVATE_ARGUMENT_VALUE_SENTINEL';
  const root = { node: 'chain', steps: [
    { node: 'code', label: 'never-evaluate', code: '(() => { throw new Error("must never execute"); })()' },
    ...Array.from({ length: 20 }, () => ({ ...call, args: { private: sentinel } })),
  ] };
  const errors = workflowShapeErrors(workflow(root), true);
  assert(errors.length > 0 && errors.length <= 8);
  assert.doesNotMatch(errors.join('\n'), /PRIVATE_ARGUMENT_VALUE_SENTINEL|must never execute/);
  assert.match(errors[0], /\/root\/steps\/1:.*as/);
});
