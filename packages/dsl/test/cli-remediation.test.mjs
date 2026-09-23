import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dryRunWorkflow, runWorkflow, WorkflowInputInvalidError } from '../dist/index.js';
import { supportTriage } from '../dist/demo.js';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const invoke = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 10_000 });
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const plan = (input = object({ count: { type: 'integer', minimum: 2 } })) => ({
  v: 2, name: 'input-contract', schemas: { Input: input, Result: object({ count: { type: 'integer' } }) },
  input: { schemaId: 'Input' }, output: { schemaId: 'Result', path: 'result' },
  root: { node: 'code', label: 'increment', code: 's => ({ result: { count: s.count + 1 } })' },
});

test('the guide example → validate → dry-run sequence succeeds without keys', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentrun-guide-'));
  try {
    const workflow = join(dir, 'workflow.json');
    for (const args of [['example', workflow], ['validate', workflow, '--trusted'], ['dry-run', workflow, '--trusted']]) {
      const result = invoke(args);
      assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
      if (args[0] !== 'example') assert.equal(JSON.parse(result.stdout).ok, true);
    }
    assert.deepEqual(JSON.parse(await readFile(workflow, 'utf8')).input, { schemaId: 'Input' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('validate and dry-run accept explicit input and reject wrong, missing and extra fields', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentrun-input-'));
  try {
    const workflow = join(dir, 'workflow.json'), input = join(dir, 'input.json');
    await writeFile(workflow, JSON.stringify(plan()));
    for (const value of [{ count: 3 }, {}, { count: 'three' }, { count: 3, extra: true }]) {
      await writeFile(input, JSON.stringify(value));
      for (const command of ['validate', 'dry-run']) {
        const result = invoke([command, '--trusted', workflow, input]);
        const valid = typeof value.count === 'number' && !('extra' in value);
        assert.equal(result.status, valid ? 0 : 1, `${command} ${JSON.stringify(value)}\n${result.stdout}\n${result.stderr}`);
        assert.equal(JSON.parse(result.stdout).ok, valid);
      }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('CLI reports invalid input files and arguments without silently ignoring them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentrun-input-errors-'));
  try {
    const workflow = join(dir, 'workflow.json'), input = join(dir, 'input.json');
    await writeFile(workflow, JSON.stringify(plan()));
    for (const command of ['validate', 'dry-run', 'run']) {
      for (const invalid of ['null', '[]', '3', '"text"']) {
        await writeFile(input, invalid);
        const result = invoke([command, workflow, input, '--trusted']);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /Input JSON must be an object/);
      }
      await writeFile(input, '{ broken');
      assert.match(invoke([command, workflow, input, '--trusted']).stderr, /Cannot read input JSON file/);
      assert.match(invoke([command, workflow, '--oops', '--trusted']).stderr, /Unknown option/);
      assert.match(invoke([command, workflow, input, 'extra.json', '--trusted']).stderr, /Usage:/);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('dry-run synthesizes declared input including sibling refs, and respects explicit input', async () => {
  const workflow = plan();
  workflow.schemas.Input.properties.count = { $ref: '#/definitions/Count' };
  workflow.schemas.Count = { type: 'integer', minimum: 2 };
  assert.deepEqual(await dryRunWorkflow(workflow), { ok: true });
  assert.deepEqual(await dryRunWorkflow(workflow, { input: { count: 5 } }), { ok: true });
  assert.equal((await dryRunWorkflow(workflow, { input: {} })).ok, false);
  assert.equal((await dryRunWorkflow(workflow, { input: { count: 'bad' } })).ok, false);
  workflow.schemas.Result.properties.count.const = 6;
  assert.equal((await dryRunWorkflow(workflow)).ok, false);
  assert.deepEqual(await dryRunWorkflow(workflow, { input: { count: 5 } }), { ok: true });
});

test('dry-run has no ambient question or context, but explicit reference fixtures remain supported', async () => {
  const workflow = plan();
  delete workflow.input;
  workflow.root.code = 's => { if (Object.keys(s).length) throw new Error("unexpected input"); return { result: { count: 1 } }; }';
  assert.deepEqual(await dryRunWorkflow(workflow), { ok: true });
  workflow.root.code = 's => ({ result: { count: s.context.references.reference.length } })';
  assert.equal((await dryRunWorkflow(workflow)).ok, false);
  assert.deepEqual(await dryRunWorkflow(workflow, { probeContext: { references: { reference: 'abc' } } }), { ok: true });
  workflow.schemas.Result.properties.count.const = 5;
  assert.deepEqual(await dryRunWorkflow(workflow, { input: { context: { references: { reference: 'input' } } }, probeContext: { references: {} } }), { ok: true });
});

test('support triage rejects incomplete input as input_invalid before invoking adapters', async () => {
  let calls = 0;
  for (const input of [{}, { ticket: 3 }, { ticket: '' }, { ticket: 'hello', extra: true }]) {
    await assert.rejects(runWorkflow(supportTriage, input, { runJudge: async () => { calls++; throw new Error('must not run'); } }), WorkflowInputInvalidError);
  }
  assert.equal(calls, 0);
});

test('invalid explicit input is not masked by unsupported synthetic schema constructs', async () => {
  const workflow = plan(object({ count: { type: 'integer', minimum: 2, multipleOf: 2 } }));
  const result = await dryRunWorkflow(workflow, { input: { count: 3 } });
  assert.equal(result.ok, false, JSON.stringify(result));
});
