import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runTypedWorkflow, runWorkflowSlice } from '@parcha/agentrun-dsl';
import { evidenceWorkflow } from './workflow.js';
import { offlineAdapters, question, sources } from './offline.js';

test('retains the policy and its exception, rejects marketing, and needs no agent', async () => {
  const deps = offlineAdapters();
  assert.equal(deps.runNode, undefined);
  const result = await runTypedWorkflow(evidenceWorkflow, { question }, deps);
  assert.equal(result.status, 'complete');
  if (result.status === 'complete') {
    assert.deepEqual(result.output.map(source => source.id), ['review-policy', 'incident-policy']);
  }
});

test('missing evidence stops the workflow', async () => {
  const result = await runTypedWorkflow(evidenceWorkflow, { question }, offlineAdapters(true));
  assert.equal(result.status, 'escalated');
  if (result.status === 'escalated') assert.equal(result.escalation.kind, 'needs_research');
});

test('invalid input fails before search', async () => {
  const deps = offlineAdapters();
  let searched = false;
  deps.runEffect = async () => { searched = true; throw new Error('Must not run'); };
  await assert.rejects(runTypedWorkflow(evidenceWorkflow, { question: '' }, deps));
  assert.equal(searched, false);
});

test('the evidence selector runs alone without search or an agent', async () => {
  const { runJudge } = offlineAdapters();
  const result = await runWorkflowSlice(evidenceWorkflow, { question, search: { sources } },
    { from: 'screen-evidence', to: 'screen-evidence' }, { runJudge });
  assert.equal(result.status, 'complete');
  assert.deepEqual((result.state.evidence as { kept: number[] }).kept, [0, 1]);
});
