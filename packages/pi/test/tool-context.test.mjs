import test from 'node:test';
import assert from 'node:assert/strict';
import { workflowToolContext } from '../dist/tool-context.js';
import { PiRunError } from '../dist/run-error.js';
import { PiRunError as exported } from '../dist/index.js';

test('a workflow tool context keeps the host context and answers a nested call with an error outcome', async () => {
  const host = { cwd: '/work', get model() { return 'm'; } };
  const ctx = workflowToolContext(host);
  assert.equal(ctx.cwd, '/work');
  assert.equal(ctx.model, 'm');
  assert.deepEqual([...ctx.tools], []);
  const outcome = await ctx.executeTool('search', { q: 'x' });
  assert.equal(outcome.isError, true);
  assert.equal(outcome.toolCall.name, 'search');
  assert.deepEqual(outcome.toolCall.arguments, { q: 'x' });
  assert.match(outcome.result.content[0].text, /cannot call the tool search/);
  assert.equal(Object.hasOwn(host, 'executeTool'), false);
});

test('PiRunError is one class whether it is loaded from the runner or from the workflow service seam', () => {
  assert.equal(exported, PiRunError);
  const error = new PiRunError('timeout', 2, 1);
  assert.equal(error.name, 'PiRunError');
  assert.match(error.message, /timeout \(2 turns, 1 submissions\)/);
});

test('the workflow service loads without any pi package resolvable', async () => {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(process.execPath, ['--input-type=module', '-e',
    `import { register } from 'node:module';
     register('data:text/javascript,' + encodeURIComponent('export async function resolve(s,c,n){ if (s.startsWith("@earendil-works/")) throw new Error("pi package loaded: "+s); return n(s,c); }'));
     const m = await import(${JSON.stringify(new URL('../dist/extension-service.js', import.meta.url).href)});
     console.log(typeof m.WorkflowExtensionService);`], { encoding: 'utf8' });
  assert.equal(out.trim(), 'function');
});
