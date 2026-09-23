import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runWorkflow, validateWorkflow } from '@parcha/agentrun-dsl';

const fixture = async name => JSON.parse(await readFile(new URL('../skills/author/examples/' + name, import.meta.url), 'utf8'));
const workflow = await fixture('evidence-gate.json');
const input = await fixture('evidence-gate.input.json');
const gate = workflow.root.steps.find(node => node.label === 'probability-gate');
const scriptedJudge = p => async request => {
  assert.deepEqual(request.state, { record: input.record });
  assert.equal(request.questions.supported.instructions, workflow.schemas.Questions.properties.supported.description);
  return { answers: { supported: { type: 'noul', noul: p } } };
};

test('fictional evidence gate runs actual DSL code with a fake Jev adapter and sibling schema refs', async () => {
  assert.deepEqual(validateWorkflow(workflow, { inputKeys: ['record'] }), { ok: true });
  let calls = 0;
  const result = await runWorkflow(workflow, input, { runJudge: async request => {
    calls++;
    return scriptedJudge(.9)(request);
  } });
  assert.equal(calls, 1);
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.output, { record: input.record, accepted: true });
  assert.deepEqual(result.state.record, input.record, 'omitting as merges the original-record patch, not a replacement state');
  assert.deepEqual(result.state.gate, { accepted: true }, 'as wraps exactly once');
  assert.equal(result.state.accepted, undefined, 'as does not leak returned fields to top-level state');
  assert.equal(result.state['check$answers'].answers.supported.noul, .9);
  assert.ok(input.record.claim.startsWith('  '), 'code leaves input untouched');
});

test('a true decoded boolean below the raw probability threshold escalates before assembly', async () => {
  for (const p of [.5, .89]) {
    const result = await runWorkflow(workflow, input, { runJudge: scriptedJudge(p) });
    assert.equal(result.state.check.supported, true);
    assert.equal(result.state.gate.accepted, false);
    assert.equal(result.status, 'escalated');
    assert.equal(result.state.result, undefined);
  }
});

test('the exact bundled code fails closed for absent, nonnumeric, nonfinite, or out-of-range sidecars', async () => {
  const gateOnly = { v: 2, name: 'test-gate-only', schemas: { Gate: workflow.schemas.Gate }, output: { schemaId: 'Gate', path: 'gate' }, root: gate };
  const missing = [{}, { 'check$answers': {} }, { 'check$answers': { answers: {} } }];
  const invalid = [undefined, null, '0.99', NaN, Infinity, -Infinity, -.1, 1.01, .899];
  for (const state of [...missing, ...invalid.map(p => ({ 'check$answers': { answers: { supported: { noul: p } } } }))]) {
    const result = await runWorkflow(gateOnly, state, {});
    assert.deepEqual(result.output, { accepted: false });
  }
  for (const p of [.9, 1]) {
    const result = await runWorkflow(gateOnly, { 'check$answers': { answers: { supported: { noul: p } } } }, {});
    assert.deepEqual(result.output, { accepted: true });
  }
});

test('unsupported code prompt fields, judge instructions, and bare sibling refs are rejected', () => {
  for (const [key, value] of Object.entries({ state: { record: '{record}' }, requires: ['record'], out: 'Gate', instructions: 'Compute the gate.' })) {
    const altered = structuredClone(workflow);
    altered.root.steps[2][key] = value;
    assert.equal(validateWorkflow(altered).ok, false, key);
  }
  const judge = structuredClone(workflow);
  judge.root.steps[1].instructions = 'An unsupported field.';
  assert.equal(validateWorkflow(judge).ok, false);
  const ref = structuredClone(workflow);
  ref.schemas.Input.properties.record.$ref = 'Record';
  assert.equal(validateWorkflow(ref).ok, false);
  const bare = structuredClone(workflow);
  bare.root.steps[2].code = 'const p = 1; return { accepted: true };';
  assert.equal(validateWorkflow(bare).ok, false);
});

test('code transforms are synchronous and final output remains schema-checked', async () => {
  const asyncCode = { v: 2, name: 'test-async-rejection', schemas: { Gate: workflow.schemas.Gate }, output: { schemaId: 'Gate', path: 'gate' }, root: { ...gate, code: 'async (s) => ({ accepted: true })' } };
  await assert.rejects(runWorkflow(asyncCode, {}, {}), /synchronous/);
  const badOutput = structuredClone(workflow);
  badOutput.root.steps.at(-1).code = '(s) => ({ accepted: s.gate.accepted })';
  await assert.rejects(runWorkflow(badOutput, input, { runJudge: scriptedJudge(.95) }), /output does not satisfy schema/);
});

test('documented synchronous collections work while Date remains unavailable', async () => {
  const scalar = { v: 2, name: 'fictional-code-globals', schemas: { Value: { type: 'number' } }, output: { schemaId: 'Value', path: 'value' }, root: { node: 'code', label: 'compute', as: 'value', code: '(s) => Math.max(...new Set([2, 4, 4])) + new Map([["x", 3]]).get("x")' } };
  assert.equal((await runWorkflow(scalar, {}, {})).output, 7);
  const unavailable = structuredClone(scalar);
  unavailable.root.code = '(s) => new Date("2001-01-01").getUTCFullYear()';
  await assert.rejects(runWorkflow(unavailable, {}, {}), error => {
    assert.equal(error.code, 'code_transform_failed');
    assert.equal(error.stage, 'compute');
    assert.match(error.cause.message, /Date/, 'trusted SDK callers retain the original cause');
    return true;
  });
});
