import test from 'node:test';
import assert from 'node:assert/strict';
import { Compile } from 'typebox/compile';
import Ajv from 'ajv';
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { createPiRunner, createPiHostRunner } from '../dist/index.js';

// All transport and answers here are fictional; the real native Agent validates tools.
const object = { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'], additionalProperties: false };
const request = schema => ({ kind: 'agent', label: 'fictional-contract', system: ['Submit the fictional result.'], user: 'Return the fixture.', schema });
function host(responses, options = {}) {
  const faux = createFauxCore({ tokensPerSecond: Infinity });
  faux.setResponses(responses);
  const model = faux.getModel(), calls = [], events = [];
  const ctx = { cwd: process.cwd(), model, thinkingLevel: 'high', modelRegistry: {
    getAll: () => [model], streamSimple(selected, transcript, config) {
      calls.push(structuredClone(transcript)); return faux.streamSimple(selected, transcript, config);
    },
  } };
  return { calls, events, run: createPiHostRunner(ctx, { maxTurns: 8, timeoutMs: 5000, ...options, onEvent: event => events.push(event) }) };
}
const submit = (args, id) => {
  const call = fauxToolCall('submit', args);
  if (id !== undefined) call.id = id;
  return fauxAssistantMessage(call);
};
const tool = calls => calls[0].messages.find(m => m.role === 'system').toolsAdded.find(t => t.name === 'submit');

test('actual native submit advertises object, primitive, array and union schemas without mutating them', async () => {
  for (const [schema, value] of [[object, { count: 2 }], [{ type: 'boolean' }, true],
    [{ type: 'array', items: { type: 'integer' } }, [2, 3]],
    [{ anyOf: [{ type: 'null' }, object] }, null]]) {
    const before = structuredClone(schema), f = host([submit({ value })]);
    assert.deepEqual(await f.run(request(schema)), value);
    assert.deepEqual(tool(f.calls).parameters.properties.value, before);
    assert.deepEqual(schema, before);
    assert.equal(f.calls.length, 1);
  }
});

test('local definitions and $defs stay resolved after nesting, including transitive refs', async () => {
  for (const defs of ['definitions', '$defs']) {
    const schema = { type: 'object', properties: { count: { $ref: `#/${defs}/Count` } }, required: ['count'],
      [defs]: { Count: { $ref: `#/${defs}/Integer` }, Integer: { type: 'integer', minimum: 2 } } };
    const before = structuredClone(schema), f = host([submit({ value: { count: 2 } })]);
    assert.deepEqual(await f.run(request(schema)), { count: 2 });
    const parameters = tool(f.calls).parameters;
    assert.equal(parameters.properties.value.properties.count.$ref, `#/properties/value/${defs}/Count`);
    const check = Compile(parameters);
    assert(check.Check({ value: { count: 2 } }));
    assert(!check.Check({ value: { count: 1 } }));
    assert(!check.Check({ value: { count: '2' } }));
    assert.deepEqual(schema, before);
  }
});

test('root and nested property pointers retain their targets, while literal $ref data is unchanged', async () => {
  const literal = { $ref: '#/definitions/NotASchema' };
  const schema = { type: 'object', properties: {
    count: { type: 'integer' }, copy: { $ref: '#/properties/count' },
    literal: { const: literal, default: literal, examples: [literal] },
    child: { anyOf: [{ type: 'null' }, { $ref: '#' }] },
  }, required: ['count', 'copy', 'literal', 'child'] };
  const value = { count: 2, copy: 3, literal, child: null }, f = host([submit({ value })]);
  assert.deepEqual(await f.run(request(schema)), value);
  const parameters = tool(f.calls).parameters;
  assert.equal(parameters.properties.value.properties.copy.$ref, '#/properties/value/properties/count');
  assert.equal(parameters.properties.value.properties.child.anyOf[1].$ref, '#/properties/value');
  assert.deepEqual(parameters.properties.value.properties.literal, schema.properties.literal);
});

test('root and nested $id resource boundaries retain local references under both native and independent validators', async () => {
  const resource = { $id: 'https://fictional.invalid/result', type: 'object', properties: { count: { $ref: '#/definitions/Count' } },
    required: ['count'], definitions: { Count: { type: 'integer' } } };
  for (const schema of [resource, { type: 'object', properties: { nested: resource }, required: ['nested'] }]) {
    const value = schema === resource ? { count: 2 } : { nested: { count: 2 } };
    const bad = schema === resource ? { count: '2' } : { nested: { count: '2' } };
    const f = host([submit({ value })]);
    assert.deepEqual(await f.run(request(schema)), value);
    const parameters = tool(f.calls).parameters;
    assert.deepEqual(parameters.properties.value, schema);
    for (const check of [value => Compile(parameters).Check(value), new Ajv({ strict: false }).compile(parameters)]) {
      assert(check({ value })); assert(!check({ value: bad }));
    }
  }
});

test('SDK-rejected JSON strings and malformed envelopes consume finite submission attempts exactly once', async () => {
  for (const args of [{ value: JSON.stringify({ count: 2 }) }, {}, { value: { count: 2 }, extra: true }]) {
    const f = host([submit(args, 'reused'), submit(args, 'reused'), submit({ value: { count: 2 } })], { maxSubmissions: 2 });
    await assert.rejects(f.run(request(object)), error => error.reason === 'submission_limit' && error.submissions === 2);
    assert.equal(f.calls.length, 2);
    assert.equal(f.events.filter(e => e.type === 'tool_execution_start').length, 2);
  }
});

test('valid final permitted attempt succeeds and unlimited malformed attempts can recover', async () => {
  for (const maxSubmissions of [2, null]) {
    const count = maxSubmissions === null ? 6 : 1;
    const f = host([...Array.from({ length: count }, () => submit({ value: 'invalid' }, 'reused')),
      submit({ value: { count: 2 } }, 'reused')], { maxSubmissions });
    assert.deepEqual(await f.run(request(object)), { count: 2 });
    assert.equal(f.calls.length, count + 1);
  }
});

test('native SDK coercion cannot turn an invalid original candidate into accepted typed output', async () => {
  const reviewed = [], f = host([submit({ value: { count: '2' } }), submit({ value: { count: 2 } })], { maxSubmissions: 2 });
  assert.deepEqual(await f.run({ ...request(object), review: value => { reviewed.push(structuredClone(value)); return { accepted: true }; } }), { count: 2 });
  assert.deepEqual(reviewed, [{ count: 2 }]);
  assert.equal(f.calls.length, 2);
});

test('independent semantic review still rejects schema-valid drafts and verifier exceptions stay fatal', async () => {
  const f = host([submit({ value: { count: 1 } }), submit({ value: { count: 2 } })], { maxSubmissions: 2 });
  assert.deepEqual(await f.run({ ...request(object), review: value => ({ accepted: value.count === 2, message: 'Fictional count must be two.' }) }), { count: 2 });
  const error = new Error('Fictional host verifier failure'), fatal = host([submit({ value: { count: 2 } })]);
  await assert.rejects(fatal.run({ ...request(object), review: () => { throw error; } }), actual => actual === error);
});

test('direct session implementations without tool events still count each repeated execute ID', async () => {
  let attempts = 0;
  const run = createPiRunner({ model: {}, maxSubmissions: 2, timeoutMs: 5000,
    sessionFactory: async config => {
      const selected = config.customTools.find(t => t.name === 'submit');
      return { session: { subscribe: () => () => {}, abort: async () => {}, dispose() {}, async prompt() {
        for (let n = 0; n < 2; n++) { attempts++; await selected.execute('reused', { value: 'invalid' }); }
      } } };
    },
  });
  await assert.rejects(run(request(object)), error => error.reason === 'submission_limit' && error.submissions === 2);
  assert.equal(attempts, 2);
});

test('custom session events without correlation IDs count each executed submit once', async () => {
  for (const succeeds of [true, false]) {
    let attempts = 0;
    const run = createPiRunner({ model: {}, maxSubmissions: 2, timeoutMs: 5000,
      sessionFactory: async config => {
        const selected = config.customTools.find(t => t.name === 'submit');
        let emit;
        return { session: { subscribe(listener) { emit = listener; return () => {}; },
          abort: async () => {}, dispose() {}, async prompt() {
            for (const value of ['invalid', succeeds ? { count: 2 } : 'still invalid']) {
              const args = { value };
              emit({ type: 'tool_execution_start', toolName: 'submit', args });
              attempts++;
              await selected.execute('reused', args);
              emit({ type: 'tool_execution_end', toolName: 'submit' });
            }
          },
        } };
      },
    });
    if (succeeds) assert.deepEqual(await run(request(object)), { count: 2 });
    else await assert.rejects(run(request(object)), error => error.reason === 'submission_limit' && error.submissions === 2);
    assert.equal(attempts, 2);
  }
});

test('custom session correlation IDs without optional event args retain the executed candidate', async () => {
  const run = createPiRunner({ model: {}, maxSubmissions: 1, timeoutMs: 5000,
    sessionFactory: async config => {
      const selected = config.customTools.find(t => t.name === 'submit');
      let emit;
      return { session: { subscribe(listener) { emit = listener; return () => {}; },
        abort: async () => {}, dispose() {}, async prompt() {
          emit({ type: 'tool_execution_start', toolName: 'submit', toolCallId: 'fictional-submit' });
          await selected.execute('fictional-submit', { value: { count: 2 } });
          emit({ type: 'tool_execution_end', toolName: 'submit', toolCallId: 'fictional-submit' });
        },
      } };
    },
  });
  assert.deepEqual(await run(request(object)), { count: 2 });
});
