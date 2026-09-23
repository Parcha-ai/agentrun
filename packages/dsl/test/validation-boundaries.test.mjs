import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWorkflow, runWorkflow, runWorkflowSlice, WorkflowInvalidError, assertWorkflowCapabilities, desugarWorkflow, compileQuestions } from '../dist/index.js';

const result = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
const agent = { node: 'agent', label: 'answer', instructions: 'Answer', out: 'Result', as: 'answer' };
const flow = root => ({ v: 2, name: 'boundaries', schemas: { Result: result }, output: { schemaId: 'Result', path: 'answer' }, root });

test('catalog references require actual own definitions, including input and sibling refs', async () => {
  for (const name of ['__proto__', 'constructor', 'toString']) {
    const variants = [
      { ...flow({ ...agent, out: name }), schemas: {}, output: { schemaId: name } },
      { ...flow(agent), input: { schemaId: name } },
      { ...flow(agent), schemas: { Result: { $ref: `#/definitions/${name}` } } },
    ];
    for (const candidate of variants) {
      assert.equal(validateWorkflow(candidate).ok, false, JSON.stringify(candidate));
      let calls = 0;
      await assert.rejects(runWorkflow(candidate, {}, { runNode: async () => { calls++; return { ok: true }; } }), WorkflowInvalidError);
      assert.equal(calls, 0);
    }
    const candidate = { ...flow({ ...agent, out: name }), schemas: JSON.parse(`{"${name}":${JSON.stringify(result)}}`), output: { schemaId: name, path: 'answer' } };
    assert.equal(validateWorkflow(candidate).ok, true);
    assert.deepEqual((await runWorkflow(candidate, {}, { runNode: async () => ({ ok: true }) })).output, { ok: true });
    await assert.rejects(runWorkflow(candidate, {}, { runNode: async () => ({ wrong: true }) }), /does not satisfy/);
  }
});

test('question references cannot resolve inherited catalog members', () => {
  const schema = { type: 'object', properties: { valid: { $ref: '#/definitions/constructor' } } };
  assert.equal(compileQuestions(schema).ok, false);
  assert.equal(compileQuestions(schema, JSON.parse('{"constructor":{"type":"boolean","description":"Valid?"}}')).ok, true);
});

test('malformed JSON returns diagnostics before any adapter or code probe', async () => {
  const malformed = [
    { node: 'chain', steps: {} },
    { ...agent, instructions: 42 },
    { ...agent, sopSection: 42 },
    { ...agent, requires: {} },
    { ...agent, verify: [] },
    { node: 'map', label: 'map', itemsPath: 42, as: 'items', body: agent },
    { node: 'parallel', label: 'parallel', branches: {} },
    { node: 'route', label: 'route', instructions: 'Route', state: {}, branches: { a: null } },
    { node: 'loop', label: 'loop', maxIters: 2, body: agent, until: { predicate: 'ask', instructions: 42 } },
    { node: 'workflow', label: 'child', workflow: null, input: {}, out: 'Result', as: 'child' },
  ];
  for (const node of malformed) {
    const candidate = flow({ node: 'chain', steps: [agent, node] });
    const verdict = validateWorkflow(candidate);
    assert.equal(verdict.ok, false, JSON.stringify(node));
    assert.ok(verdict.errors.length);
    let calls = 0;
    const deps = { runNode: async () => { calls++; return { ok: true }; }, runJudge: async () => { calls++; return {}; } };
    await assert.rejects(runWorkflow(candidate, {}, deps), WorkflowInvalidError);
    await assert.rejects(runWorkflowSlice(candidate, {}, { from: 'answer' }, deps), WorkflowInvalidError);
    assert.equal(calls, 0);
  }
  for (const candidate of [null, [], {}, { ...flow(agent), schemas: [] }]) {
    assert.equal(validateWorkflow(candidate).ok, false);
  }
});

test('raw prose artifact capability check matches its normalized report', () => {
  const candidate = flow({ node: 'artifact', label: 'write', type: 'markdown', instructions: 'Write a report.' });
  for (const root of [candidate.root, desugarWorkflow(candidate).root]) {
    assert.throws(() => assertWorkflowCapabilities(root, {}), /requires runNode/);
    assert.doesNotThrow(() => assertWorkflowCapabilities(root, { runNode: async () => ({}) }));
  }
});

test('explicit reserved sibling and inline definitions resolve and still enforce their schema', async () => {
  for (const name of ['__proto__', 'constructor', 'toString']) {
    const definition = { type: 'boolean' };
    const root = { type: 'object', properties: { ok: { $ref: `#/definitions/${name}` } }, required: ['ok'] };
    for (const inline of [false, true]) {
      const definitions = JSON.parse(`{"${name}":${JSON.stringify(definition)}}`);
      const candidate = flow(agent);
      candidate.schemas = inline ? { Result: { ...root, definitions } } : { Result: root, ...definitions };
      assert.equal(validateWorkflow(candidate).ok, true);
      assert.deepEqual((await runWorkflow(candidate, {}, { runNode: async () => ({ ok: true }) })).output, { ok: true });
      await assert.rejects(runWorkflow(candidate, {}, { runNode: async () => ({ ok: 'wrong' }) }), /does not satisfy/);
    }
  }
});

test('sift filter requires an own question ID', () => {
  const candidate = flow({ node: 'sift', label: 'filter', itemsPath: 'items', out: 'Questions', as: 'answer', keep: { path: 'constructor' } });
  candidate.schemas.Questions = { type: 'object', properties: { ok: { type: 'boolean', description: 'Keep?' } } };
  const verdict = validateWorkflow(candidate);
  assert.equal(verdict.ok, false);
  assert.match(verdict.errors.join('\n'), /names no question/);
});
