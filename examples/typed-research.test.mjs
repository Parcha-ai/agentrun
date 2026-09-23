import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { runTypedWorkflow, runWorkflow, runWorkflowSlice } from '@parcha/agentrun-dsl';
import { deepResearch, researchQuestion } from './typed-research.ts';
import { question, subquestions, sourceSets, researchFixtures } from './typed-research-fixtures.ts';

test('the quickstart shows completion and exposes missing evidence as an unsuccessful run', () => {
  const run = (...args) => spawnSync(process.execPath, ['examples/run-typed-research.ts', ...args], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 15_000,
  });
  const complete = run();
  assert.equal(complete.status, 0, complete.stderr);
  assert.match(complete.stdout, /3 subquestions researched; 3 sources retained/);
  assert.match(complete.stdout, /3 tools, 3 system one decisions, 5 model steps/);
  const missing = run('--no-evidence');
  assert.equal(missing.status, 2, missing.stderr);
  assert.match(missing.stdout, /Stopped before writing findings or a report/);
  assert.match(missing.stdout, /1 model step\./);
  assert.doesNotMatch(missing.stdout, /Report: Pilot/);
});

test('typed research composes isolated subworkflows and excludes unsupported passages', async () => {
  const { deps, calls } = researchFixtures();
  const result = await runTypedWorkflow(deepResearch, { question }, deps);
  assert.equal(result.status, 'complete');
  assert.equal(result.output.findings.length, 3);
  assert.deepEqual(result.output.findings.map(finding => finding.sources.map(source => source.id)), sourceSets.map(sources => [sources[0].id]));
  assert.equal(calls.filter(call => call.startsWith('tool:')).length, 3);
  assert.equal(calls.filter(call => call.startsWith('jev:')).length, 3);
  assert.equal(calls.filter(call => call.startsWith('model:')).length, 5);
  assert.deepEqual((await runWorkflow(JSON.parse(JSON.stringify(deepResearch)), { question }, researchFixtures().deps)).output, result.output);
});

test('the same child is evaluated alone with its boundary contract', async () => {
  const { deps, calls } = researchFixtures();
  const result = await runTypedWorkflow(researchQuestion, { question: subquestions[1] }, deps);
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.output.sources, [sourceSets[1][0]]);
  assert.equal(calls.length, 3);
});

test('screen-evidence is evaluated without search or agent calls, retaining raw probabilities', async () => {
  const { deps, calls } = researchFixtures();
  const result = await runWorkflowSlice(researchQuestion,
    { question: subquestions[0], search: { sources: sourceSets[0] } },
    { from: 'screen-evidence' }, { runJudge: deps.runJudge });
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.state.evidence.items, [sourceSets[0][0]]);
  assert.equal(result.state.evidence.answers[0].answers.answersQuestion.noul, 0.95);
  assert.deepEqual(calls, ['jev:screen-evidence']);
});

test('missing evidence escalates without producing a confident final report', async () => {
  const { deps, calls } = researchFixtures({ noEvidence: true });
  const result = await runTypedWorkflow(deepResearch, { question }, deps);
  assert.equal(result.status, 'escalated');
  assert.equal(result.escalation.kind, 'needs_research');
  assert.equal(calls.includes('model:write-report'), false);
  assert.equal(calls.some(call => call.endsWith('write-finding')), false);
});

test('input is checked before even the planning call', async () => {
  const { deps, calls } = researchFixtures();
  await assert.rejects(runTypedWorkflow(deepResearch, { question: '' }, deps), /input/i);
  assert.deepEqual(calls, []);
});
