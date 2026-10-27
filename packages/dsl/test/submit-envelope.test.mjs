// The submit envelope every node runner offers: a node's output schema under `value`, its local pointers moved with it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Compile } from 'typebox/compile';
import { submitParameters } from '@parcha/agentrun-dsl';

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
