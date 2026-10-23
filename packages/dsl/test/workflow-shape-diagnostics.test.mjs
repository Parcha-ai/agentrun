import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { Compile } from 'typebox/compile';
import { workflowShapeErrors } from '../dist/workflow-shape.js';
import { inspectWorkflow } from '@parcha/agentrun-dsl';

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

test('a route is diagnosed against the route variant it is: a judged route against the judged route, a route by value against its own', () => {
  // The schema has two route variants, both with node "route"; a judged route asks a question, a route by value reads a state path.
  const branches = { a: { body: { node: 'code', label: 'a', code: '(s) => s' } }, b: { body: { node: 'code', label: 'b', code: '(s) => s' } } };
  const judgedMissingState = messages({ node: 'route', label: 'r', instructions: 'Which one?', branches });
  assert.match(judgedMissingState, /state/);
  assert.doesNotMatch(judgedMissingState, /valuePath/, 'a judged route is never told it needs a valuePath');
  assert.equal(messages({ node: 'route', label: 'r', instructions: 'Which one?', state: { q: '{q}' }, branches }), '', 'a valid judged route has nothing to say');
  assert.equal(messages({ node: 'route', label: 'r', valuePath: 'kind', otherwise: 'a', branches }), '', 'a valid route by value has nothing to say');
  const byValueBadPath = messages({ node: 'route', label: 'r', valuePath: 7, otherwise: 'a', branches });
  assert.match(byValueBadPath, /valuePath/);
  assert.doesNotMatch(byValueBadPath, /instructions|required properties state/, 'a route by value is never told it needs a question');
  // A tie (as many errors against each variant) goes to the variant first in the schema, the judged route: a bare route is
  // asked for what a judged route needs.
  assert.equal(messages({ node: 'route' }), 'workflow/root: must have required properties branches, instructions, label, state');
  assert.equal(messages({ node: 'route', label: 'r' }), 'workflow/root: must have required properties branches, instructions, state');
  // The same through inspectWorkflow, which an authoring agent reads: it names the judged route's missing state.
  let inspected = '';
  try { inspectWorkflow(workflow({ node: 'route', label: 'r', instructions: 'Which one?', branches })); } catch (error) { inspected = error.message; }
  assert.match(inspected, /state/);
  assert.doesNotMatch(inspected, /valuePath/);
});
