import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  defineWorkflow, runTypedWorkflow, runWorkflow, workflowSha256, validateWorkflow,
  WorkflowSchemaConversionError, WorkflowInvalidError,
} from '../dist/index.js';

const Request = z.strictObject({ subject: z.string() });
const Brief = z.strictObject({ summary: z.string(), sources: z.array(z.string()) });
const source = () => ({
  name: 'research', schemas: { Request, Brief }, input: 'Request',
  output: { schema: 'Brief', path: 'brief' },
  steps: [{ node: 'agent', label: 'research', instructions: 'Research {subject}.', out: 'Brief', as: 'brief' }],
});
const brief = { summary: 'Battery recycling research', sources: ['https://example.org/paper'] };

test('Zod schema inference and negative type contracts compile strictly', () => {
  execFileSync(process.execPath, [
    fileURLToPath(new URL('../../../node_modules/typescript/bin/tsc', import.meta.url)),
    '--noEmit', '--strict', '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
    fileURLToPath(new URL('./authoring-types.ts', import.meta.url)),
  ], { encoding: 'utf8' });
});

test('Zod-authored workflow is ordinary JSON with identical raw and typed execution', async () => {
  const authored = defineWorkflow(source());
  const exported = JSON.parse(JSON.stringify(authored));
  assert.deepEqual(authored, exported);
  assert.equal(workflowSha256(authored), workflowSha256(exported));
  assert.deepEqual(validateWorkflow(exported), { ok: true });
  assert.equal(JSON.stringify(authored).includes('~standard'), false);
  assert.deepEqual(Object.getOwnPropertySymbols(authored), []);
  const deps = { runNode: async () => brief };
  const input = { subject: 'battery recycling' };
  assert.deepEqual(await runTypedWorkflow(authored, input, deps), await runWorkflow(exported, input, deps));
});

test('input and output constraints run through the existing interpreter', async () => {
  const workflow = defineWorkflow(source());
  let calls = 0;
  const deps = { runNode: async () => { calls++; return brief; } };
  await assert.rejects(runTypedWorkflow(workflow, { subject: 42 }, deps), error => error.code === 'input_invalid');
  assert.equal(calls, 0);
  await assert.rejects(runTypedWorkflow(workflow, { subject: 'batteries' }, {
    runNode: async () => ({ summary: 42, sources: [] }),
  }), /schema|submission/i);
});

test('copied or modified documents cannot retain stale inferred boundary types', async () => {
  const workflow = defineWorkflow(source());
  const changed = { ...workflow, schemas: { ...workflow.schemas, Brief: {
    type: 'object', required: ['summary'], properties: { summary: { type: 'number' } },
  } } };
  let calls = 0;
  const deps = { runNode: async () => { calls++; return { summary: 123 }; } };
  for (const copy of [{ ...workflow }, changed, JSON.parse(JSON.stringify(workflow))]) {
    await assert.rejects(runTypedWorkflow(copy, { subject: 'batteries' }, deps), /original document returned by defineWorkflow/);
  }
  assert.equal(calls, 0);
  // Ordinary documents still use the original interpreter with unknown output types.
  assert.equal((await runWorkflow(changed, { subject: 'batteries' }, deps)).output.summary, 123);
});

test('raw criteria survive alongside Zod schemas without metadata or caller mutation', () => {
  const definition = source();
  definition.schemas.Decision = {
    type: 'object', required: ['samePerson'], properties: {
      samePerson: { type: 'boolean', description: 'Do the identity details agree?', criteria: { true: 'Full name and birth year agree.', false: 'Name or birth year conflicts.' } },
    },
  };
  const workflow = defineWorkflow(definition);
  definition.schemas.Decision.properties.samePerson.criteria.true = 'Changed later';
  definition.steps[0].instructions = 'Changed later';
  assert.equal(workflow.schemas.Decision.properties.samePerson.criteria.true, 'Full name and birth year agree.');
  assert.equal(workflow.root.steps[0].instructions, 'Research {subject}.');
  assert.equal(Object.isFrozen(workflow.schemas.Brief.properties.summary), true);
  assert.throws(() => { workflow.schemas.Brief.properties.summary.type = 'number'; }, TypeError);
  assert.throws(() => { workflow.root.steps.push({ node: 'code', label: 'late', code: '() => ({})' }); }, TypeError);
});

test('unsupported Zod types and transforms fail at definition, including input transforms', () => {
  for (const bad of [z.date(), z.bigint(), z.string().transform(value => value.length)]) {
    for (const schemaId of ['Request', 'Brief']) {
      const definition = source();
      definition.schemas[schemaId] = z.object({ value: bad });
      assert.throws(() => defineWorkflow(definition), error => error instanceof WorkflowSchemaConversionError && error.schemaId === schemaId);
    }
  }
});

test('a converter cannot inject functions, invalid numbers or cyclic schemas', () => {
  const cycle = {}; cycle.self = cycle;
  for (const invalid of [null, [], { type: 'object', callback() {} }, { enum: [Infinity] }, cycle]) {
    const definition = source();
    definition.schemas.Brief = { '~standard': {
      version: 1, vendor: 'test', jsonSchema: { input: () => invalid, output: () => invalid },
    } };
    assert.throws(() => defineWorkflow(definition), WorkflowSchemaConversionError);
  }
});

test('JSON bounds apply before cloning deep or exponentially shared documents', () => {
  let shared = { type: 'string' };
  for (let i = 0; i < 18; i++) shared = { anyOf: [shared, shared] };
  assert.throws(() => defineWorkflow({ ...source(), schemas: { Request, Brief, Shared: shared } }), /exceeds 100000 expanded values/);
  assert.throws(() => defineWorkflow({ ...source(), schemas: { Request, Brief, Sparse: { enum: new Array(100_001) } } }), /exceeds 100000 expanded values/);
  let root = { node: 'agent', label: 'research', instructions: 'Research.', out: 'Brief', as: 'brief' };
  for (let i = 0; i < 1000; i++) root = { node: 'chain', steps: [root] };
  const { steps, ...definition } = source();
  assert.throws(() => defineWorkflow({ ...definition, root }), error => !(error instanceof RangeError) && /nesting depth/.test(error.message));
  let accessed = false;
  const schema = { type: 'object' };
  Object.defineProperty(schema, 'description', { enumerable: true, get() { accessed = true; return 'side effect'; } });
  assert.throws(() => defineWorkflow({ ...source(), schemas: { Request, Brief, Unsafe: schema } }), /accessor/);
  assert.equal(accessed, false);
});

test('converter errors retain the schema name and original cause', () => {
  const cause = new Error('target not supported');
  const definition = source();
  definition.schemas.Brief = { '~standard': {
    version: 1, vendor: 'test', jsonSchema: { input() { throw cause; }, output() { throw cause; } },
  } };
  assert.throws(() => defineWorkflow(definition), error => error.schemaId === 'Brief' && error.cause === cause);
});

test('invalid workflow references fail while authoring before a run exists', () => {
  const definition = source(); definition.steps[0].out = 'Missing';
  assert.throws(() => defineWorkflow(definition), WorkflowInvalidError);
});

test('the same schema key cannot hide different input and output contracts', () => {
  assert.throws(() => defineWorkflow({
    name: 'ambiguous', schemas: { State: z.object({ subject: z.string() }) },
    input: 'State', output: { schema: 'State' },
    steps: [{ node: 'code', label: 'keep', code: '() => ({})' }],
  }), /declare separate input and output/);
  const workflow = defineWorkflow({
    name: 'same-contract', schemas: { State: z.strictObject({ subject: z.string() }) },
    input: 'State', output: { schema: 'State' },
    steps: [{ node: 'code', label: 'keep', code: '() => ({})' }],
  });
  assert.deepEqual(workflow.input, { schemaId: 'State' });
});

test('known lossy Zod semantics fail closed even when the converter omits them', () => {
  const lossy = [
    z.string().default('x'), z.string().prefault('x'), z.string().catch('x'),
    z.coerce.number(), z.string().trim(), z.string().toLowerCase(),
    z.string().refine(value => value.startsWith('a')),
    z.string().superRefine((value, ctx) => { if (value !== 'a') ctx.addIssue({ code: 'custom', message: 'a required' }); }),
    z.string().regex(/example/i), z.string().meta({ type: 'number' }),
    z.url({ normalize: true }), z.url({ hostname: /example\.org$/ }), z.url({ protocol: /^https$/ }),
    z.jwt(), z.jwt({ alg: 'HS256' }), z.stringFormat('must-start-a', value => value.startsWith('a')),
    z.string().readonly(),
  ];
  for (const bad of lossy) {
    const definition = source();
    definition.schemas.Brief = z.object({ nested: z.array(bad) });
    assert.throws(() => defineWorkflow(definition), WorkflowSchemaConversionError);
  }
});

test('authoring rejects nonobject root inputs and accepts object unions', async () => {
  for (const input of [z.string(), z.array(z.string()), z.unknown(), z.object({}).optional(), z.object({}).nullable(), z.union([z.object({}), z.string()]), { type: 'string' }, {}]) {
    const definition = source(); definition.schemas.Request = input;
    assert.throws(() => defineWorkflow(definition), error => error instanceof WorkflowSchemaConversionError && error.schemaId === 'Request');
  }
  const definition = source();
  definition.schemas.Request = z.union([z.strictObject({ subject: z.string() }), z.strictObject({ subject: z.string(), sources: z.array(z.string()) })]);
  const workflow = defineWorkflow(definition);
  assert.equal((await runTypedWorkflow(workflow, { subject: 'batteries' }, { runNode: async () => brief })).status, 'complete');
});

test('accepted string formats have an enforced pattern or built-in runtime format', async () => {
  for (const schema of [z.email(), z.url(), z.uuid(), z.ipv4(), z.base64(), z.stringFormat('must-start-a', /^a/)]) {
    const workflow = defineWorkflow({
      name: 'format-contract', schemas: { Input: z.strictObject({}), Output: z.strictObject({ value: schema }) },
      input: 'Input', output: { schema: 'Output', path: 'result' },
      steps: [{ node: 'agent', label: 'make', instructions: 'Make a value.', out: 'Output', as: 'result' }],
    });
    await assert.rejects(runTypedWorkflow(workflow, {}, { runNode: async () => ({ value: '%%%not-valid%%%' }) }), /schema|submission/i);
  }
});

test('representable Zod constraints and Jev metadata are preserved', () => {
  const definition = source();
  definition.schemas.Decision = z.strictObject({
    samePerson: z.boolean().meta({ description: 'Does the identity match?', criteria: { true: 'Name and birth year agree.', false: 'Identity details conflict.' } }),
    evidenceCount: z.number().int().min(0).max(10),
    sources: z.array(z.string().min(1)).min(1).max(5),
  });
  const workflow = defineWorkflow(definition);
  assert.equal(workflow.schemas.Decision.properties.samePerson.criteria.true, 'Name and birth year agree.');
  assert.deepEqual(workflow.schemas.Decision.properties.evidenceCount, { type: 'integer', minimum: 0, maximum: 10 });
  assert.deepEqual(workflow.schemas.Decision.properties.sources, { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, maxItems: 5 });
});
