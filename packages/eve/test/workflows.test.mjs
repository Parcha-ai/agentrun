import assert from 'node:assert/strict';
import test from 'node:test';
import { executeLearnedWorkflow, reserveWorkflowInvocation, workflowBinding, workflowInstructions, workflowInvocation, workflowScope } from '../dist/extension/lib/workflows.mjs';
import { readWorkflowResult } from '../dist/extension/lib/workflow-evidence.mjs';
import { collectTurn } from '../dist/extension/lib/evidence.mjs';

const inputSchema = { type: 'object', properties: { service: { type: 'string' } }, required: ['service'], additionalProperties: false };
const native = () => ({ sessionId: 'session-one', turnId: 'turn-one', callId: 'call-one', signal: new AbortController().signal });
const input = { name: 'release-report', input: { service: 'demo-api' } };
function fixture({ learning = true, policy = () => 'allow', permission = 'allow', execute, maxToolCalls } = {}) {
  const invocations = [], reads = [];
  // A host-owned test interpreter; the real MCP transport still validates and dispatches every effect.
  const engine = {
    inspectWorkflow() { return { nodes: [], requires: { adapters: ['runEffect'], tools: ['mcp:release/status'], sopSections: [], executableCode: false } }; },
    resolveSchemaForWorkflow(_doc, schema) { return schema; },
    async runWorkflow(_doc, args, deps) {
      deps.onEvent({ type: 'node.start' });
      const result = await deps.runEffect({ node: { via: 'tool', tool: 'mcp:release/status' }, input: args, signal: deps.signal, idempotencyKey: 'status' });
      return { status: 'complete', output: { brief: result.brief } };
    },
  };
  const options = { engine, policy, ...(maxToolCalls ? { maxToolCalls } : {}), tools: [{ name: 'mcp:release/status', nativeName: 'release_status', readOnly: true,
    description: 'Read the current release.', input_schema: inputSchema, output_schema: { type: 'object', properties: { brief: { type: 'string' } }, required: ['brief'] }, permission,
    async execute(args, context) { invocations.push({ args, context }); return execute ? execute(args, context) : { brief: `${args.service}: original callback result` }; } }] };
  const config = { baseUrl: 'https://agentrun.example/v2', apiKey: 'fake-test-key', agentId: 'eve-release', instructions: 'Use the original release policy.', workflows: options,
    maxRetries: 0, fetch: async (url, init) => {
      reads.push({ url: String(url), method: init.method });
      return new Response(JSON.stringify({ definition: { sdk: { runtime: 'eve' }, learning } }), { headers: { 'content-type': 'application/json' } });
    } };
  const record = { baseUrl: config.baseUrl, agentId: config.agentId, expiresAt: Date.now() + 60_000,
    source: { sessionId: 'session-one', turnId: 'turn-one' }, workflowBinding: workflowBinding(options),
    receipt: { run_id: 'run-one', token: 'receipt-secret-test', learning: { enabled: true, revision: 'accepted-revision', workflows: [
      { name: 'release-report', description: 'Read a release report.', workflow: JSON.stringify({ schemas: { Input: inputSchema }, input: { schemaId: 'Input' } }) },
    ] } } };
  return { config, record, options, invocations, reads };
}

test('real MCP dispatch uses the exact original callback, pinned workflow and run identity', async () => {
  const f = fixture(), result = await executeLearnedWorkflow(f.config, f.record, input, native());
  assert.equal(result.isError, false);
  assert.equal(result.agentrun.complete, true);
  assert.equal(result.text, 'demo-api: original callback result');
  assert.equal(f.invocations.length, 1);
  assert.deepEqual(f.invocations[0].args, input.input);
  assert.equal(f.invocations[0].context.runId, 'run-one');
  assert.equal(f.invocations[0].context.workflow, 'release-report');
  assert.match(f.invocations[0].context.idempotencyKey, /:status$/);
  assert.deepEqual(result.agentrun.events.map(({ name, status }) => [name, status]), [
    ['learned_workflow', 'started'], ['mcp:release/status', 'started'], ['mcp:release/status', 'completed'], ['learned_workflow', 'completed'],
  ]);
  const [parent, child] = result.agentrun.events;
  assert.deepEqual(parent.input, { name: 'release-report' });
  assert.equal(child.parent_tool_use_id, parent.id);
  assert.deepEqual(readWorkflowResult(result, workflowScope(f.record), 'call-one'), result);
  assert.doesNotMatch(JSON.stringify(result), /fake-test-key|receipt-secret-test|capability|Bearer/);
  assert.doesNotMatch(JSON.stringify(result.agentrun.events), /demo-api|original callback result/);
});

test('notes-only config has no executable workflow binding or supplemental instructions', () => {
  assert.equal(workflowBinding(), undefined);
  const f = fixture(); delete f.record.workflowBinding;
  assert.equal(workflowInstructions(f.record), '');
  assert.equal(workflowScope(f.record), undefined);
});

test('configured learning loops dispatch original callbacks, but switching Off revokes an admitted turn', async () => {
  for (const learning of [{}, { compile_after: 5, agree_min: 0.9, alone_min: 0.7 }, { audit_every: 5, hold_window: 10, hold_disagree: 3 }]) {
    const f = fixture({ learning });
    const completed = await executeLearnedWorkflow(f.config, f.record, input, native());
    assert.equal(completed.isError, false);
    assert.equal(completed.agentrun.complete, true);
    assert.equal(f.invocations.length, 1);
    f.config.fetch = async () => new Response(JSON.stringify({ definition: { sdk: { runtime: 'eve' }, learning: false } }),
      { headers: { 'content-type': 'application/json' } });
    const stopped = await executeLearnedWorkflow(f.config, f.record, input, native());
    assert.equal(stopped.isError, true);
    assert.equal(stopped.agentrun.complete, false);
    assert.equal(f.invocations.length, 1, 'Off must prevent another callback despite the previously admitted workflow.');
  }
});

test('an explicit custom mount name and native aliases are pinned without exporting callbacks', () => {
  const f = fixture(); f.options.toolName = 'my_learning__learned_workflow';
  f.record.workflowBinding = workflowBinding(f.options);
  assert.equal(f.record.workflowBinding.toolName, 'my_learning__learned_workflow');
  assert.deepEqual(f.record.workflowBinding.aliases, [{ nativeName: 'release_status', name: 'mcp:release/status' }]);
  assert.match(workflowInstructions(f.record), /my_learning__learned_workflow/);
  assert.doesNotMatch(workflowInstructions(f.record), /secret|capability|Bearer/);
  assert.doesNotMatch(JSON.stringify(f.record.workflowBinding.manifest), /nativeName|execute|readOnly/);
});

test('mutating, unbound, duplicate or host-generative capabilities cannot be declared', () => {
  for (const mutate of [
    options => { options.tools[0].readOnly = false; }, options => { delete options.tools[0].execute; },
    options => { options.tools[0].nativeName = ''; }, options => { options.tools.push(options.tools[0]); },
    options => { options.runNode = async () => 'hidden model'; }, options => { options.runJudge = async () => true; },
    options => { options.toolName = 'release_status'; }, options => { options.policy = undefined; },
  ]) { const f = fixture(); mutate(f.options); assert.throws(() => workflowBinding(f.options)); }
});

test('first ordered request owns the turn even when sibling tool steps share the same state snapshot', async () => {
  const rows = reserveWorkflowInvocation([], 'run-one', 'call-first', input);
  const reserved = reserveWorkflowInvocation(rows, 'run-one', 'call-second', input);
  assert.equal(reserved, rows);
  const attempts = await Promise.allSettled(['call-first', 'call-second'].map(async callId => workflowInvocation(structuredClone(reserved), 'run-one', callId, input)));
  assert.deepEqual(attempts.map(row => row.status), ['fulfilled', 'rejected']);
  assert.throws(() => workflowInvocation(rows, 'run-one', 'call-first', { ...input, input: { service: 'changed' } }));
  const cached = { ...rows[0], result: { text: 'already completed' } };
  assert.equal(workflowInvocation([cached], 'run-one', 'call-first', { input: { service: 'demo-api' }, name: 'release-report' }).result, cached.result);
  assert.equal(reserveWorkflowInvocation(rows, 'run-two', 'new-call', input).length, 2);
});

test('Off, notes-only, denied and ask policies refuse execution and cannot produce complete training evidence', async () => {
  for (const options of [{ learning: false }, { learning: 'notes' }, { learning: null }, { learning: [] }, { policy: () => 'deny' }, { policy: () => 'ask' }, { permission: 'ask' }]) {
    const f = fixture(options), result = await executeLearnedWorkflow(f.config, f.record, input, native());
    assert.equal(result.isError, true);
    assert.equal(result.agentrun.complete, false);
    assert.equal(f.invocations.length, 0);
  }
});

test('mismatched identity, stale revision binding and expired/submitted turns fail before dispatch', async () => {
  for (const change of [
    f => { f.record.expiresAt = Date.now() - 1; }, f => { f.record.submitted = true; },
    f => { f.record.source.sessionId = 'different'; }, f => { f.record.source.turnId = 'different'; },
    f => { f.record.agentId = 'different'; }, f => { f.record.baseUrl = 'https://different.example/v2'; },
    f => { f.record.workflowBinding.digest = 'different'; }, f => { f.record.receipt.learning.enabled = false; },
    f => { f.record.receipt.learning.workflows = []; },
  ]) {
    const f = fixture(); change(f);
    await assert.rejects(executeLearnedWorkflow(f.config, f.record, input, native()), /matching active/);
    assert.equal(f.invocations.length, 0); assert.equal(f.reads.length, 0);
  }
});

test('a callback failure never claims complete evidence or exposes its private exception', async () => {
  const f = fixture({ execute() { throw new Error('private backend secret'); } });
  const result = await executeLearnedWorkflow(f.config, f.record, input, native());
  assert.equal(result.isError, true); assert.equal(result.agentrun.complete, false);
  assert.equal(f.invocations.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /private backend secret/);
});

function nativeHistory(output, name = 'agentrun__learned_workflow') {
  const facts = [
    ['session.started', {}], ['turn.started', { turnId: 'turn-one', follows: null, cause: { deliveryId: 'delivery-one' } }],
    ['delivery.consumed', { turnId: 'turn-one', deliveryId: 'delivery-one', parts: [{ kind: 'text', text: 'Read a release.' }] }],
    ['model.requested', { runId: 'model-one', owner: { turnId: 'turn-one' } }], ['model.started', { runId: 'model-one', modelId: 'original-model', attempt: 0 }],
    ['call.requested', { callId: 'call-one', owner: { runId: 'model-one' }, capability: { name, kind: 'tool' }, input }],
    ['call.started', { callId: 'call-one' }], ['call.settled', { callId: 'call-one', outcome: 'completed', ...(output ? { output } : {}) }],
    ['content.completed', { partId: 'answer-one', runId: 'model-one', kind: 'text', phase: 'reply', value: 'Original answer.' }],
    ['model.settled', { runId: 'model-one', outcome: 'completed' }], ['turn.settled', { turnId: 'turn-one', outcome: 'completed', reply: ['answer-one'] }],
  ];
  return { id: 'session-one', async *stream() {
    for (const [line, [type, data]] of facts.entries()) yield { type, data, scope: { turnId: 'turn-one' }, meta: { at: '2026-01-01T00:00:00.000Z', position: { line, index: 0 }, endOfLine: true } };
  } };
}

test('durable native workflow output restores exact bridge evidence on replay without exposing its attestation', async () => {
  const f = fixture(), output = await executeLearnedWorkflow(f.config, f.record, input, native());
  const result = await collectTurn(nativeHistory(output), 'turn-one', undefined, workflowScope(f.record));
  assert.equal(result.complete, true);
  assert.deepEqual(result.events.filter(event => event.type === 'tool'), output.agentrun.events);
  assert.doesNotMatch(JSON.stringify(result), /signature|owner-secret|receipt-secret|agentrun__learned_workflow/);
  assert.deepEqual(await collectTurn(nativeHistory(structuredClone(output)), 'turn-one', undefined, workflowScope(f.record)), result);
});

test('missing, tampered, cross-call, cross-turn and misplaced workflow attestations fail closed', async () => {
  const f = fixture(), output = await executeLearnedWorkflow(f.config, f.record, input, native());
  for (const mutate of [
    () => undefined,
    value => { value.signature = '0'.repeat(64); return value; },
    value => { value.agentrun.callId = 'different-call'; return value; },
    value => { value.agentrun.turnId = 'different-turn'; return value; },
    value => { value.agentrun.events.pop(); return value; },
  ]) {
    const result = await collectTurn(nativeHistory(mutate(structuredClone(output))), 'turn-one', undefined, workflowScope(f.record));
    assert.equal(result.complete, false); assert.match(result.reason, /^workflow_evidence_/);
  }
  const misplaced = await collectTurn(nativeHistory(output, 'other_tool'), 'turn-one', undefined, workflowScope(f.record));
  assert.equal(misplaced.complete, false); assert.equal(misplaced.reason, 'workflow_evidence_invalid');
  assert.throws(() => readWorkflowResult(output, workflowScope(f.record), 'other-call'), /invalid_workflow_evidence/);
});

test('ordinary native tools retain their lifecycle and use only explicitly bound canonical names', async () => {
  const f = fixture();
  const mapped = await collectTurn(nativeHistory(undefined, 'release_status'), 'turn-one', undefined, workflowScope(f.record));
  assert.equal(mapped.complete, true);
  assert.deepEqual(mapped.events.filter(event => event.type === 'tool').map(event => event.name), ['mcp:release/status', 'mcp:release/status']);
  const unbound = await collectTurn(nativeHistory(undefined, 'unknown_tool'), 'turn-one', undefined, workflowScope(f.record));
  assert.equal(unbound.complete, true);
  assert.equal(unbound.events.find(event => event.type === 'tool').name, 'unknown_tool');
});
