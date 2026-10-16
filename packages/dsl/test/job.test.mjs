import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { defineJob, runWorkflow, validateWorkflow } from '../dist/index.js';

const workflow = {
  v: 2, name: 'audit', schemas: { Out: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } } },
  output: { schemaId: 'Out', path: 'final' },
  root: { node: 'chain', steps: [{ node: 'code', label: 'finish', code: '() => ({ final: { ok: true } })' }] },
};

test('the job contract compiles strictly, and each shape that is not a job is refused', () => {
  execFileSync(process.execPath, [
    fileURLToPath(new URL('../../../node_modules/typescript/bin/tsc', import.meta.url)),
    '--noEmit', '--strict', '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
    fileURLToPath(new URL('./job-types.ts', import.meta.url)),
  ], { encoding: 'utf8' });
});

test('defineJob returns its argument itself, adds and drops nothing, and the job runs', async () => {
  const files = { 'notes.txt': new Uint8Array([1, 2, 3]) };
  const job = { workflow, input: { project: 'p' }, files };
  assert.equal(defineJob(job), job, 'the same object');
  assert.equal(defineJob(job).files, files);
  const bare = { workflow, input: {} };
  assert.equal(defineJob(bare), bare);
  assert.deepEqual(Object.keys(defineJob(bare)), ['workflow', 'input'], 'no files key is added');
  assert.deepEqual(validateWorkflow(job.workflow), { ok: true });
  const result = await runWorkflow(job.workflow, job.input, {});
  assert.equal(result.status, 'complete');
});
