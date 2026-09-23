import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { runWorkflow, validateWorkflow, WorkflowInvalidError } from '../dist/index.js';

const workflow = code => ({
  v: 2, name: 'synchronous-code', schemas: { Result: { type: 'object' } },
  output: { schemaId: 'Result' },
  root: { node: 'code', label: 'transform', code },
});

test('declared async code is rejected before any preceding effect runs', async () => {
  const candidate = workflow('async state => { throw new Error("must not execute"); }');
  candidate.root = { node: 'chain', steps: [
    { node: 'call', label: 'prior effect', via: 'tool', tool: 'read', args: {}, out: 'Result', as: 'read', deadline_s: 1 },
    candidate.root,
  ] };
  const validation = validateWorkflow(candidate, { input: {} });
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join('\n'), /transforms are synchronous/);
  let calls = 0;
  await assert.rejects(runWorkflow(candidate, {}, { runEffect: async () => { calls++; return {}; } }), WorkflowInvalidError);
  assert.equal(calls, 0);
});

for (const code of [
  'async state => { throw new Error("async failure"); }',
  'state => (async () => { throw new Error("returned rejection"); })()',
  'state => ({ then(resolve, reject) { reject(new Error("thenable rejection")); } })',
  'state => ({ async then() { throw new Error("must not invoke thenable"); } })',
  'state => ({ then() { console.log("must not invoke thenable"); } })',
]) {
  test(`handled invalid code does not crash the host: ${code}`, () => {
    const script = `
      import assert from 'node:assert/strict';
      import { runWorkflow, validateWorkflow } from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)};
      const workflow = ${JSON.stringify(workflow(code))};
      validateWorkflow(workflow, { input: {} });
      await assert.rejects(runWorkflow(workflow, {}, {}), /transforms are synchronous/);
      await new Promise(resolve => setImmediate(resolve));
      console.log('host survived');
    `;
    const result = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'host survived');
    assert.equal(result.stderr, '');
  });
}
