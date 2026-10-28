// The submit envelope every node runner offers: a node's output schema under `value`, its local pointers moved with it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Compile } from 'typebox/compile';
import { readFileSync } from 'node:fs';
import { submitParameters } from '@parcha/agentrun-dsl';
import { runWorkflow } from '../dist/index.js';

test('a schema with a root ref and definitions becomes a valid tool input whose refs still resolve', () => {
  const schema = { $ref: '#/definitions/Answer', definitions: { Answer: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' }, next: { $ref: '#/definitions/Answer' } } } } };
  const envelope = submitParameters(schema);
  assert.deepEqual([envelope.type, envelope.required, envelope.additionalProperties], ['object', ['value'], false]);
  assert.equal(envelope.properties.value.$ref, '#/properties/value/definitions/Answer');
  assert.equal(envelope.properties.value.definitions.Answer.properties.next.$ref, '#/properties/value/definitions/Answer');
  const check = Compile(envelope);
  assert.equal(check.Check({ value: { answer: 'a', next: { answer: 'b' } } }), true);
  assert.equal(check.Check({ value: { answer: 1 } }), false);
  assert.equal(check.Check({ answer: 'a' }), false, 'the value must be under value');
});

test('a subschema with its own $id keeps its local refs, literal data is not rewritten, and the input is not changed', () => {
  const schema = { type: 'object', properties: { inner: { $id: 'urn:inner', $ref: '#/definitions/X', definitions: { X: { type: 'string' } } }, label: { const: { $ref: '#/not-a-schema' } } } };
  const before = structuredClone(schema);
  const envelope = submitParameters(schema);
  assert.equal(envelope.properties.value.properties.inner.$ref, '#/definitions/X');
  assert.deepEqual(envelope.properties.value.properties.label.const, { $ref: '#/not-a-schema' });
  assert.deepEqual(schema, before);
});

// `criteria` is System One's question keyword: DSL vocabulary, not JSON Schema. The model sees the submit envelope as a
// tool's input schema, so the keyword is left out of it (a harness that refuses unknown keywords would refuse the
// tool). A property or definition NAMED criteria is data and stays. Validation still runs on the original schema.

const triage = JSON.parse(readFileSync(new URL('../../../examples/issue-triage/workflow.json', import.meta.url), 'utf8'));
const criteria = { yes: 'It is.', no: 'It is not.' };
// Every key named criteria in a schema tree, with the path it sits at.
const criteriaKeys = (node, path = '') => !node || typeof node !== 'object' ? []
  : Object.entries(node).flatMap(([key, value]) => [...(key === 'criteria' ? [`${path}/${key}`] : []), ...criteriaKeys(value, `${path}/${key}`)]);

test('the issue-triage Judgment schema reaches the submit tool with no criteria anywhere, and keeps the rest', () => {
  const judgment = triage.schemas.Judgment;
  assert.ok(criteriaKeys(judgment).length >= 3, 'the example carries criteria');
  const value = submitParameters(judgment).properties.value;
  assert.deepEqual(criteriaKeys(value), []);
  assert.deepEqual(value.properties.label.enum, ['bug', 'feature', 'docs', 'question']);
  assert.equal(value.properties.label.description, judgment.properties.label.description);
  assert.deepEqual(value.required, judgment.required);
  assert.ok(criteriaKeys(judgment).length >= 3, 'the input is not changed');
});

test('criteria is left out of every nested schema position, through every keyword the envelope walks', () => {
  const schema = {
    type: 'object', criteria,
    properties: {
      text: { type: 'string', criteria },
      list: { type: 'array', criteria, items: { type: 'string', criteria } },
      tuple: { type: 'array', prefixItems: [{ type: 'string', criteria }] },
      any: { anyOf: [{ type: 'string', criteria }, { $ref: '#/$defs/Leaf' }] },
      one: { oneOf: [{ type: 'number', criteria }] },
      all: { allOf: [{ type: 'boolean', criteria }] },
      map: { type: 'object', additionalProperties: { type: 'string', criteria } },
      deep: { $ref: '#/$defs/Deep' },
      old: { $ref: '#/definitions/Old' },
    },
    $defs: { Leaf: { type: 'string', criteria }, Deep: { type: 'object', criteria, properties: { inner: { anyOf: [{ type: 'string', criteria }] } } } },
    definitions: { Old: { type: 'string', criteria } },
  };
  const envelope = submitParameters(schema);
  assert.deepEqual(criteriaKeys(envelope), []);
  const value = envelope.properties.value;
  assert.equal(value.properties.any.anyOf[1].$ref, '#/properties/value/$defs/Leaf', 'the relocated $defs');
  assert.deepEqual(value.$defs.Deep.properties.inner.anyOf, [{ type: 'string' }]);
  assert.deepEqual(value.properties.list, { type: 'array', items: { type: 'string' } });
  const check = Compile(envelope);
  assert.equal(check.Check({ value: { text: 'a', any: 'b', deep: { inner: 'c' }, old: 'd', map: { k: 'v' } } }), true);
  assert.equal(check.Check({ value: { deep: { inner: 1 } } }), false);
});

test('a property or definition NAMED criteria keeps its name and its own schema', () => {
  const schema = {
    type: 'object', required: ['criteria'],
    properties: {
      criteria: { type: 'string', description: 'The reviewer\'s criteria, in words.' },
      nested: { type: 'object', properties: { criteria: { type: 'array', items: { type: 'string' }, criteria } } },
      named: { $ref: '#/$defs/criteria' },
    },
    $defs: { criteria: { type: 'integer' }, Holder: { type: 'object', properties: { criteria: { type: 'boolean' } } } },
  };
  const value = submitParameters(schema).properties.value;
  assert.deepEqual(value.required, ['criteria']);
  assert.deepEqual(value.properties.criteria, { type: 'string', description: 'The reviewer\'s criteria, in words.' });
  assert.deepEqual(value.properties.nested.properties.criteria, { type: 'array', items: { type: 'string' } }, 'its name stays; its own keyword goes');
  assert.deepEqual(value.$defs.criteria, { type: 'integer' });
  assert.deepEqual(value.$defs.Holder.properties.criteria, { type: 'boolean' });
  assert.equal(value.properties.named.$ref, '#/properties/value/$defs/criteria');
  assert.equal(Compile(submitParameters(schema)).Check({ value: { criteria: 'x', named: 3 } }), true);
});

test('only criteria is left out: annotations and other keywords the envelope does not know stay as written', () => {
  const schema = { type: 'string', title: 'Label', description: 'The label.', examples: ['bug'], default: 'bug', 'x-note': 'kept', $comment: 'kept', criteria };
  const { criteria: _dropped, ...rest } = schema;
  assert.deepEqual(submitParameters(schema).properties.value, rest);
});

test('a submission valid against the original schema is valid in the envelope, and one that is not is refused by both', () => {
  const judgment = triage.schemas.Judgment;
  const original = Compile(judgment), envelope = Compile(submitParameters(judgment));
  for (const value of [{ label: 'bug', good_first_issue: true, actionable: false }, { label: 'docs', good_first_issue: false, actionable: true }]) {
    assert.equal(original.Check(value), true); assert.equal(envelope.Check({ value }), true);
  }
  for (const value of [{ label: 'wontfix', good_first_issue: true, actionable: false }, { label: 'bug', good_first_issue: true }, { label: 'bug', good_first_issue: true, actionable: false, criteria: 'x' }]) {
    assert.equal(original.Check(value), false); assert.equal(envelope.Check({ value }), false);
  }
});

test('the interpreter hands runNode the original schema, criteria included, and validates the submission against it', async () => {
  // The local $ref only resolves against the original document: a validator compiled from the envelope's relocated
  // copy would not accept a valid submission.
  const Out = { type: 'object', required: ['label'], additionalProperties: false, properties: { label: { $ref: '#/definitions/Label' } },
    definitions: { Label: { type: 'string', enum: ['bug', 'docs'], criteria: { bug: 'Broken.', docs: 'Documentation.' } } } };
  const wf = { v: 2, name: 't', schemas: { Out }, output: { schemaId: 'Out', path: 'result' }, root: { node: 'agent', label: 'classify', instructions: 'Classify.', out: 'Out', as: 'result' } };
  const seen = [];
  const done = await runWorkflow(wf, {}, { runNode: async (request) => { seen.push(request.schema); return { label: 'bug' }; } });
  assert.equal(done.status, 'complete', JSON.stringify(done.error));
  assert.deepEqual(done.output, { label: 'bug' });
  assert.deepEqual(criteriaKeys(seen[0]), ['/definitions/Label/criteria'], 'the runner receives the schema as written');
  await assert.rejects(runWorkflow(wf, {}, { runNode: async () => ({ label: 'wontfix' }) }), (error) => error.code === 'output_invalid');
});
