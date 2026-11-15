// Real-model integration proof. No generated workflow is written or approved by this script.
import assert from 'node:assert/strict';
import { AgentRun } from '@parcha/agentrun-client';
import { WORKFLOW_INSTRUCTIONS, releaseTask, teachReleaseTask } from './workflow-tools.mjs';

export function assertOriginalToolChain(result, service, source) {
  const calls = result.calls.filter(call => !source || call.source === source);
  const formatted = calls.findLast(call => call.tool === 'mcp:release/format_release_brief');
  assert.ok(formatted, 'The existing formatter callback did not run.');
  const read = calls.find(call => call.tool === 'mcp:release/release_status' && call.result.observation === formatted.args.status.observation);
  assert.ok(read, 'The formatter did not receive fresh data from the existing status callback.');
  assert.equal(read.args.service, service);
  assert.equal(formatted.args.status.service, service);
  assert.equal(result.answer.trim(), formatted.result.brief, 'The native answer must preserve the existing formatter result.');
  return { read, formatted };
}

export function assertWorkflowReuse(result, receipt, acceptedRevision, names) {
  assert.equal(receipt.revision, acceptedRevision, 'The fresh run received a different learning revision.');
  assert.ok(receipt.workflows.some(name => names.includes(name)), 'The fresh run received no accepted workflow.');
  const completed = result.workflowEvents.find(event => event.type === 'workflow.end' && event.status === 'completed');
  assert.ok(completed && names.includes(completed.workflow), 'No accepted workflow completed through MCP; direct-tool fallback cannot prove reuse.');
  const chain = assertOriginalToolChain(result, 'billing-api', 'workflow');
  assert.equal(chain.read.workflow, completed.workflow);
  assert.equal(chain.formatted.workflow, completed.workflow);
  assert.equal(chain.read.runId, receipt.runId);
  assert.equal(chain.formatted.runId, receipt.runId);
}

export async function demonstrateWorkflows({ runtime, createBackend,
  baseUrl = process.env.AGENTRUN_BASE_URL, apiKey = process.env.AGENTRUN_API_KEY,
  agentPrefix = `sdk-workflow-${runtime}-${Date.now()}`, fetch: send = globalThis.fetch, onProgress = () => {} }) {
  if (!baseUrl || !apiKey) throw new Error('Set AGENTRUN_BASE_URL (ending /v2) and AGENTRUN_API_KEY in the backend environment.');
  const receipts = [], stages = [];
  const capture = async (url, options) => {
    const response = await send(url, options);
    if (response.ok && options?.method === 'POST' && new URL(url).pathname.endsWith('/sdk-runs')) {
      const receipt = await response.clone().json();
      // Never retain run tokens, MCP capabilities, original native prompts, or MCP request arguments.
      receipts.push({ runId: receipt.run_id, agentId: receipt.agent_id, consoleUrl: receipt.console_url,
        enabled: receipt.learning.enabled, revision: receipt.learning.revision,
        workflows: (receipt.learning.workflows ?? []).map(workflow => workflow.name) });
    }
    return response;
  };
  const options = { baseUrl, apiKey, fetch: capture, instructions: WORKFLOW_INSTRUCTIONS, learningTimeoutMs: 180_000 };
  const client = new AgentRun({ baseUrl, apiKey, fetch: send });
  const agentId = `${agentPrefix}-on`, controlId = `${agentPrefix}-off`;
  const on = await createBackend({ ...options, agentId, name: `${runtime} workflow release reporter`, learning: true });
  let off;
  const run = async (stage, backend, prompt, service) => {
    onProgress({ stage, state: 'running' });
    const result = await backend.report(prompt);
    await backend.flushLearning();
    assertOriginalToolChain(result, service);
    stages.push({ stage, ...result });
    onProgress({ stage, state: 'completed' });
    return result;
  };
  try {
    await run('teach', on, teachReleaseTask('demo-api'), 'demo-api');
    let learned = await client.learning.get(agentId);
    assert.ok(learned.skills.some(skill => skill.status === 'active' && skill.run),
      'No checked skill was accepted. Inspect Learning Dojo; this demo does not seed or approve learning.');
    // The ordinary compiler considers a job after five completed runs (or three kept notes),
    // when it has no workflow and no recent compile. Teaching plus four practice runs reaches
    // that run threshold without changing policy or fabricating history.
    for (let index = 1; index <= 4; index++) {
      await run(`practice-${index}`, on, releaseTask('demo-api'), 'demo-api');
      learned = await client.learning.get(agentId);
      if (learned.workflows.some(workflow => workflow.status === 'pending'))
        throw new Error('A workflow needs owner review. Inspect Learning Dojo; the demo never auto-approves it.');
      if (learned.workflows.some(workflow => workflow.status === 'active' && workflow.run)) break;
    }
    const accepted = learned.workflows.filter(workflow => workflow.status === 'active' && workflow.run);
    assert.ok(accepted.length, 'No checked workflow was accepted after the ordinary practice cadence. Inspect Learning Dojo before running more paid tasks.');
    const workflowFiles = [];
    for (const item of accepted) {
      const response = await client.learning.read(agentId, item.file);
      workflowFiles.push({ name: item.name, file: item.file, fromRun: item.run, document: response.body });
    }
    const acceptedRevision = learned.main;
    const reused = await run('fresh-workflow-reuse', on, releaseTask('billing-api'), 'billing-api');
    assertWorkflowReuse(reused, receipts.filter(receipt => receipt.agentId === agentId).at(-1), acceptedRevision, accepted.map(item => item.name));
    off = await createBackend({ ...options, agentId: controlId, name: `${runtime} workflow reporter (learning Off)`, learning: false });
    const control = await run('learning-off-control', off, releaseTask('billing-api'), 'billing-api');
    assert.equal(control.calls.filter(call => call.source === 'workflow').length, 0);
    assert.equal(control.workflowEvents.filter(event => event.type === 'workflow.start').length, 0);
    const offReceipt = receipts.find(receipt => receipt.agentId === controlId);
    assert.equal(offReceipt.enabled, false); assert.equal(offReceipt.revision, null); assert.deepEqual(offReceipt.workflows, []);
    return { agentId, controlId, acceptedRevision, workflowFiles, stages, runs: receipts };
  } finally { await off?.close(); await on.close(); }
}
