import assert from 'node:assert/strict';
import test from 'node:test';
import { compileQuestions, dryRunWorkflow, runWorkflow, validateWorkflow } from '../dist/index.js';

const question = { type: 'boolean', description: 'Does the evidence support the answer?' };
const questionSchema = { type: 'object', required: ['ok'], properties: { ok: { $ref: '#/definitions/Decision' } } };
const judgeFlow = schemas => ({
  v: 2, name: 'reference-contract', schemas, output: { schemaId: 'Questions', path: 'answer' },
  root: { node: 'judge', label: 'review', state: { evidence: 'source' }, out: 'Questions', as: 'answer' },
});

test('inline question definitions take precedence over conflicting workflow catalog entries', async () => {
  const flow = judgeFlow({
    Questions: { ...questionSchema, definitions: { Decision: question } },
    Decision: { type: 'string', enum: ['yes', 'no'], description: 'Choose a label.' },
  });
  assert.deepEqual(validateWorkflow(flow), { ok: true });
  const result = await runWorkflow(flow, {}, { runJudge: async ({ questions }) => {
    assert.equal(questions.ok.type, 'noul');
    assert.equal(questions.ok.instructions, question.description);
    return { answers: { ok: { type: 'noul', noul: 0.9 } } };
  } });
  assert.deepEqual(result.output, { ok: true });
});

for (const location of ['root', 'property']) {
  test(`question compilation follows ${location} reference chains through the workflow catalog`, async () => {
    const schemas = location === 'root' ? {
      Questions: { $ref: '#/definitions/Alias' }, Alias: { $ref: '#/definitions/QuestionObject' },
      QuestionObject: { type: 'object', required: ['ok'], properties: { ok: question } },
    } : {
      Questions: questionSchema, Decision: { $ref: '#/definitions/Alias' }, Alias: question,
    };
    const flow = judgeFlow(schemas);
    assert.deepEqual(validateWorkflow(flow), { ok: true });
    const result = await runWorkflow(flow, {}, { runJudge: async ({ questions }) => {
      assert.equal(questions.ok.type, 'noul');
      return { answers: { ok: { type: 'noul', noul: 0.9 } } };
    } });
    assert.deepEqual(result.output, { ok: true });
  });
}

test('cyclic question aliases fail with diagnostics and inherited names never resolve', () => {
  const definitions = { A: { $ref: '#/definitions/B' }, B: { $ref: '#/definitions/A' } };
  for (const schema of [
    { $ref: '#/definitions/A' },
    { type: 'object', properties: { ok: { $ref: '#/definitions/A' } } },
    { type: 'object', properties: { ok: { $ref: '#/definitions/constructor' } } },
  ]) {
    const result = compileQuestions(schema, definitions);
    assert.equal(result.ok, false);
    assert.ok(result.errors.length);
  }
});

const textSchema = { type: 'object', required: ['name'], properties: { name: { $ref: '#/definitions/Name' } } };
const textFlow = schemas => ({
  v: 2, name: 'text-reference', schemas, output: { schemaId: 'Result', path: 'answer' },
  root: { node: 'agent', label: 'write', instructions: 'Write a name.', out: 'Result', as: 'answer' },
});

test('dry-run generative submissions use inline definitions, including catalog collisions', async () => {
  for (const collision of [false, true]) {
    const flow = textFlow({
      Result: { ...textSchema, definitions: { Name: { type: 'string' } } },
      ...(collision ? { Name: { type: 'number' } } : {}),
    });
    assert.equal((await runWorkflow(flow, {}, { runNode: async () => ({ name: 'real name' }) })).status, 'complete');
    assert.deepEqual(await dryRunWorkflow(flow), { ok: true });
  }
});

test('dry-run generative child submissions use the child catalog rather than the parent catalog', async () => {
  const child = textFlow({ Input: { type: 'object' }, Result: textSchema, Name: { type: 'string' } });
  child.input = { schemaId: 'Input' };
  const parent = {
    v: 2, name: 'parent', schemas: { Result: { type: 'object' }, Name: { type: 'number' } },
    output: { schemaId: 'Result', path: 'answer' },
    root: { node: 'workflow', label: 'child', workflow: child, input: {}, out: 'Result', as: 'answer' },
  };
  assert.deepEqual(await dryRunWorkflow(parent), { ok: true });
});
