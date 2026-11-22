import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandsOf, operationsOf } from './generate-clients.mjs';
import { SDK_PATHS } from '../packages/serve/dist/sdk/schema.js';

const map = { commands: {}, secretBody: [], omit: {}, handWritten: {}, multiSegment: {} };
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const command = schema => commandsOf(operationsOf({ paths: { '/things': { post: {
  operationId: 'createThing', tags: ['things'], requestBody: { required: true, content: { 'application/json': { schema } } }, responses: {},
} } } }), map)[0];

test('SDK start keeps the existing scalar flags and adds the start time, the title and the external platform label', () => {
  const operations = operationsOf({ paths: SDK_PATHS });
  const start = commandsOf(operations, map).find(row => row.operationId === 'startSdkRun');
  // `labels` is an object, so it is no flag: a caller passes it in the body.
  assert.deepEqual(start.bodyFlags.map(({ name, type, required }) => ({ name, type, required })), [
    { name: 'runtime', type: 'string', required: true },
    { name: 'input', type: 'string', required: true },
    { name: 'instructions', type: 'string', required: true },
    { name: 'model', type: 'string', required: false },
    { name: 'started_at', type: 'string', required: false },
    { name: 'title', type: 'string', required: false },
    { name: 'platform', type: 'string', required: false },
  ]);
  assert.deepEqual(start.bodyFlags.find(row => row.name === 'runtime').enum, ['claude-agent-sdk', 'codex-sdk', 'eve', 'external']);
  assert.equal(start.bodyFill, undefined, 'no variant discriminator is filled on behalf of the caller');
  assert.equal(operations.find(row => row.operationId === 'startSdkRun').body.type.oneOf.length, 2, 'client types retain their closed alternatives');
});

test('object alternatives expose only compatible flags, union literals, and require only common fields', () => {
  const result = command({ oneOf: [
    object({ kind: { enum: ['sdk', 'eve'] }, input: { type: 'string' }, mode: { enum: ['fast'] },
      value: { type: 'string' }, payload: { type: 'object' }, version: { const: 1 }, tries: { type: 'integer' } }),
    object({ kind: { const: 'external' }, input: { type: 'string' }, mode: { type: 'string' }, platform: { type: 'string' },
      value: { type: 'number' }, payload: { type: 'array' }, version: { const: 1 }, tries: { type: 'integer' } }, ['kind', 'input', 'platform', 'version']),
  ] });
  assert.deepEqual(result.bodyFlags.map(row => row.name), ['kind', 'input', 'mode', 'tries', 'platform']);
  assert.deepEqual(result.bodyFlags.find(row => row.name === 'kind').enum, ['sdk', 'eve', 'external']);
  assert.equal(result.bodyFlags.find(row => row.name === 'mode').enum, undefined, 'a free-text alternative must not inherit another branch’s enum restriction');
  assert.equal(result.bodyFlags.find(row => row.name === 'tries').required, false);
  assert.equal(result.bodyFlags.find(row => row.name === 'platform').required, false);
  assert.deepEqual(result.bodyFill, { version: 1 }, 'only a value fixed and required in every branch is filled');
});

test('open, nested and non-object alternatives keep the whole JSON body instead of guessing flags', () => {
  const closed = object({ kind: { const: 'a' }, input: { type: 'string' } });
  for (const other of [
    { ...closed, additionalProperties: true },
    { ...closed, additionalProperties: undefined },
    { type: 'string' },
    { oneOf: [closed, object({ other: { type: 'string' } })] },
    { allOf: [closed] },
  ]) assert.deepEqual(command({ oneOf: [closed, other] }).bodyFlags, []);
});

test('envelope unions and overlapping or optional discriminators keep body-only input', () => {
  const definition = object({ name: { type: 'string' }, instructions: { type: 'string' } });
  assert.deepEqual(command({ oneOf: [definition, object({ definition })] }).bodyFlags, []);
  for (const variants of [
    [object({ kind: { enum: ['a', 'b'] }, input: { type: 'string' } }), object({ kind: { const: 'b' }, input: { type: 'string' } })],
    [object({ kind: { const: 'a' }, input: { type: 'string' } }, ['input']), object({ kind: { const: 'b' }, input: { type: 'string' } })],
    [object({ kind: { type: 'string' }, input: { type: 'string' } }), object({ kind: { const: 'b' }, input: { type: 'string' } })],
  ]) assert.deepEqual(command({ oneOf: variants }).bodyFlags, []);
});
