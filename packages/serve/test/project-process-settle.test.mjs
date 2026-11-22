import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { readBackOf } from '@parcha/agentrun-computer';
import { localWorkspace } from '../dist/workspace/index.js';
import { runTools } from '../dist/workspace/run-tools.js';
import { fakeComputer } from './workspace-fake-computer.mjs';
async function setup(t, processes) {
  const root = await mkdtemp(join(tmpdir(), 'project-settle-')); t.after(() => rm(root, { recursive: true, force: true }));
  const computer = fakeComputer(root);
  computer.overrides['process.list'] = () => ({ processes, truncated: false, next: 0 });
  const tools = await runTools(localWorkspace(root), { kind: 'sandbox', computer, check: { readBackOf } }, { mode: 1, context: BACKGROUND_CONTEXT });
  return { computer, tools };
}
test('strict project settling refuses an unowned running process instead of treating background cleanup as proof', async t => {
  const { tools } = await setup(t, [{ id: 'p1', argv: ['fixture-process'], running: true, exitCode: null, signal: null, startedAt: 1 }]);
  await assert.rejects(tools.settleProject(), /not settled/);
});
test('strict project settling verifies background termination and names only its exact host log', async t => {
  const processes = [{ id: 'p1', argv: ['sh', '-c', 'fixture', 'agentrun-background', '7'], running: true, exitCode: null, signal: null, startedAt: 1 }];
  const { computer, tools } = await setup(t, processes);
  computer.overrides['process.signal'] = ({ id, signal }) => { assert.equal(id, 'p1'); assert.equal(signal, 'TERM'); processes[0].running = false; processes[0].signal = 'TERM'; return {}; };
  assert.deepEqual(await tools.settleProject(), ['background/7/output.log']);
  assert.ok(computer.calls.filter(([method]) => method === 'process.list').length >= 3, 'the stopped state is observed after the signal');
});
