import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkflowInputInvalidError, WorkflowOutputInvalidError, WorkflowStateError } from '@parcha/agentrun-dsl';
import { createJevRunner } from '@parcha/agentrun-jev';
import { WorkflowExtensionService } from '../dist/extension-service.js';
const Result = { type: 'object', additionalProperties: false, required: ['accept'], properties: { accept: { type: 'boolean', description: 'Does the evidence support the claim?' } } };
const workflow = root => ({ v: 2, name: 'screen', schemas: { Result }, output: { schemaId: 'Result', path: 'decision' }, root: root ?? { node: 'judge', label: 'screen', state: { evidence: '{evidence}' }, out: 'Result', as: 'decision' } });
const answer = async ({ questions }) => ({ answers: Object.fromEntries(Object.keys(questions).map(id => [id, { type: 'noul', noul: .95 }])) });
const agent = () => ({ node: 'agent', label: 'research', instructions: 'Research the supplied evidence.', out: 'Result', as: 'decision' });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

test('host-bounded sift gives safe local feedback, then explicit per-item revision completes', async () => {
  let requests = 0;
  const judge = createJevRunner({ maxStateBytes: 48 * 1024, client: { async systemOne(request) {
    requests++;
    return { answers: Object.fromEntries(Object.keys(request.questions).map(id => [id, { type: 'noul', noul: .9 }])) };
  } } });
  const service = new WorkflowExtensionService();
  const source = workflow({ node: 'sift', label: 'check-originals', itemsPath: 'originals', state: { question: '{question}' }, out: 'Result', as: 'decision' });
  source.schemas.Batch = { type: 'object' }; source.output = { schemaId: 'Batch' };
  const input = { question: 'Does the fictional evidence apply?', originals: Array.from({ length: 3 }, (_, i) => ({
    document: `fictional-${i}`, page: i, text: 'private-source-sentinel' + 'é'.repeat(10000),
  })) };
  service.preflight(source, input); service.prepare(source);
  const failed = await service.run(input, { deps: { runJudge: judge } });
  assert.equal(failed.status, 'failed'); assert.equal(failed.error.code, 'jev_state_too_large');
  assert.equal(failed.error.stage, 'check-originals');
  assert.ok(failed.error.stateBytes > failed.error.maxStateBytes); assert.equal(failed.error.maxStateBytes, 49152);
  assert.match(failed.error.message, /sift batches every item/);
  assert.doesNotMatch(JSON.stringify(failed), /private-source-sentinel/); assert.equal(requests, 0);
  assert.equal(failed.calls.judge, 1, 'service counts adapter admission, not HTTP transport');
  const repaired = structuredClone(source);
  repaired.root = { node: 'map', label: 'per-original', itemsPath: 'originals', as: 'decisions', maxConcurrency: 3,
    body: { node: 'judge', label: 'check-one-original', state: { question: '{question}', original: '{item}' }, out: 'Result', as: 'decision' } };
  service.preflight(repaired, input); service.prepare(repaired);
  const complete = await service.run(input, { deps: { runJudge: judge } });
  assert.equal(complete.status, 'complete'); assert.equal(requests, 3); assert.equal(complete.calls.judge, 3);
  assert.deepEqual(complete.output.decisions, [{ accept: true }, { accept: true }, { accept: true }]);
});

test('preflight shares admission but neither executes factories nor grants trust or changes prepared state', async () => {
  const service = new WorkflowExtensionService();
  const retained = service.prepare(workflow(agent()));
  Math.__preflightProbe = 0;
  try {
    const code = workflow({ node: 'code', label: 'fixture', code: '(Math.__preflightProbe++, s => ({decision:{accept:true}}))' });
    service.preflight(code);
    assert.equal(Math.__preflightProbe, 0);
    assert.equal(service.inspect().current.digest, retained.digest);
    assert.throws(() => service.prepare(code), /allowExecutableCandidates/);
    for (const root of [
      { node: 'parallel', label: 'too-many', branches: Array.from({ length: 9 }, (_, i) => ({ ...agent(), label: `a${i}`, as: `a${i}` })) },
      { node: 'map', label: 'too-wide', itemsPath: 'items', as: 'results', maxConcurrency: 9, body: agent() },
      { ...agent(), tools: ['unregistered'] },
    ]) assert.throws(() => service.preflight(workflow(root)), /8|registered/);
    assert.equal(service.inspect().current.digest, retained.digest);
  } finally { delete Math.__preflightProbe; }
});

test('local schema and code failures are actionable without revealing submitted values or thrown bodies', async () => {
  const service = new WorkflowExtensionService({ allowedTools: ['source_search'] });
  service.prepare(workflow({ node: 'call', label: 'read-evidence', via: 'tool', tool: 'source_search', args: {}, out: 'Result', as: 'decision', deadline_s: 1 }));
  const bad = await service.run({}, { deps: { runEffect: async () => ({ accept: 'private-provider-payload' }) } });
  assert.equal(bad.error.code, 'output_invalid'); assert.equal(bad.error.stage, 'read-evidence');
  assert.match(bad.error.problems.join(' '), /accept|boolean/);
  assert.doesNotMatch(JSON.stringify(bad.error), /private-provider-payload/);
  const needsInput = workflow(agent());
  needsInput.schemas.Input = { type: 'object', required: ['count'], properties: { count: { type: 'number' } } };
  needsInput.input = { schemaId: 'Input' };
  service.prepare(needsInput);
  const badInput = await service.run({ count: 'private-input-payload' }, { deps: { runNode: async () => { throw new Error('Must not dispatch'); } } });
  assert.equal(badInput.error.code, 'input_invalid'); assert.match(badInput.error.problems.join(' '), /count|number/);
  assert.doesNotMatch(JSON.stringify(badInput), /private-input-payload/); assert.equal(badInput.calls.agent, 0);
  service.prepare(workflow({ node: 'code', label: 'normalize-records', code: 's => { throw new Error("private-code-body"); }' }), { allowExecutableCandidates: true });
  const broken = await service.run({}, { deps: {} });
  assert.equal(broken.error.code, 'code_transform_failed'); assert.equal(broken.error.stage, 'normalize-records');
  assert.doesNotMatch(JSON.stringify(broken), /private-code-body/);
  service.prepare(workflow(agent()));
  const remote = await service.run({}, { deps: { runNode: async () => { throw new Error('private-provider-body'); } } });
  assert.equal(remote.error.code, 'execution_failed'); assert.doesNotMatch(JSON.stringify(remote), /private-provider-body/);
  service.prepare(workflow({ node: 'code', label: 'normalize-records', code: 's => ({decision:{accept:true}})' }), { allowExecutableCandidates: true });
  assert.equal((await service.run({}, { deps: {} })).status, 'complete');
});

test('prepare, inspect and run use one immutable snapshot and the real interpreter', async () => {
  const service = new WorkflowExtensionService();
  const source = workflow();
  const prepared = service.prepare(source);
  source.root.out = 'Missing'; prepared.workflow.root.out = 'Changed';
  const view = service.inspect(); view.current.workflow.root.label = 'Changed';
  const report = await service.run({ evidence: 'A documented observation.' }, { deps: { runJudge: answer } });
  assert.equal(report.status, 'complete'); assert.deepEqual(report.output, { accept: true });
  assert.deepEqual(report.calls, { agent: 0, judge: 1, tool: 0 });
  assert.equal(report.digest, prepared.digest);
  assert.equal(service.inspect().current.workflow.root.label, 'screen');
  assert.ok(report.events.some(event => event.type === 'judge.answered'));
  report.output.accept = false;
  assert.equal(service.inspect().lastReport.output.accept, true);
});

test('code is rejected before probes, and trust applies only to the exact prepared snapshot', async () => {
  globalThis.__extensionProbe = 0;
  const source = workflow({ node: 'code', label: 'code', code: '((function(){}).constructor("globalThis.__extensionProbe++")(), s => ({decision:{accept:true}}))' });
  const service = new WorkflowExtensionService();
  assert.throws(() => service.prepare(source), /allowExecutableCandidates/);
  assert.equal(globalThis.__extensionProbe, 0);
  service.prepare(source, { allowExecutableCandidates: true });
  assert.ok(globalThis.__extensionProbe > 0);
  const result = await service.run({}, { deps: {} }); assert.equal(result.status, 'complete');
  assert.throws(() => service.prepare(source), /allowExecutableCandidates/);
  assert.throws(() => service.prepare(source, { allowExecutableCandidates: 'yes' }), /allowExecutableCandidates/);
  delete globalThis.__extensionProbe;
});

test('only host-registered tool effects are permitted even for trusted code candidates', async () => {
  const source = workflow({ node: 'call', label: 'search', via: 'tool', tool: 'source_search', args: {}, out: 'Result', as: 'decision', deadline_s: 1 });
  assert.throws(() => new WorkflowExtensionService().prepare(source), /registered|allowExecutableCandidates/);
  const service = new WorkflowExtensionService({ allowedTools: ['source_search'] });
  service.prepare(source);
  const result = await service.run({}, { deps: { runEffect: async params => { assert.equal(params.node.tool, 'source_search'); return { accept: true }; } } });
  assert.equal(result.status, 'complete'); assert.equal(result.calls.tool, 1);
  for (const root of [
    { node: 'call', label: 'shell', via: 'shell', command: 'echo x', as: 'decision', deadline_s: 1 },
    { node: 'call', label: 'executor', via: 'executor', code: 'return {}', input: {}, out: 'Result', as: 'decision', deadline_s: 1 },
    { node: 'artifact', label: 'file', type: 'markdown', instructions: 'Write a report.' },
  ]) assert.throws(() => service.prepare(workflow(root), { allowExecutableCandidates: true }), /unavailable|Artifact/);
});

test('SOP policy is shared with authoring and every supplied section reaches the node', async () => {
  const service = new WorkflowExtensionService({ rubricSections: { Identity: 'Match the identity.', Evidence: 'Retain contrary evidence.' } });
  assert.throws(() => service.prepare(workflow()), /SOP sections/);
  assert.throws(() => service.prepare(workflow({ ...agent(), sopSection: 'Identity' })), /Evidence/);
  service.prepare(workflow({ ...agent(), sopSection: ['Identity', 'Evidence'] }));
  const result = await service.run({}, { deps: { runNode: async params => { assert.match(params.system.join('\n'), /Match the identity/); assert.match(params.system.join('\n'), /Retain contrary evidence/); assert.deepEqual(params.tools, []); return { accept: true }; } } });
  assert.equal(result.status, 'complete');
});

test('nested loops share an admission budget and fail before dispatching the excess request', async () => {
  const service = new WorkflowExtensionService({ limits: { maxJudgeCalls: 2 } });
  service.prepare(workflow({ node: 'loop', label: 'again', maxIters: 3, until: { predicate: 'field_true', path: 'decision.accept' }, body: workflow().root }));
  let calls = 0;
  const result = await service.run({ evidence: 'x' }, { deps: { runJudge: async ({ questions }) => { calls++; return { answers: Object.fromEntries(Object.keys(questions).map(id => [id, { type: 'noul', noul: 0 }])) }; } } });
  assert.equal(result.status, 'failed'); assert.equal(result.error.code, 'limit'); assert.equal(calls, 2);
});

test('explicit null service limits retain counts beyond defaults and still permit operator stop', async () => {
  const service = new WorkflowExtensionService({ allowedTools: ['source_search'], limits: {
    deadlineMs: null, maxAgentCalls: null, maxJudgeCalls: null, maxToolCalls: null,
  } });
  const source = workflow({ node: 'map', label: 'many', itemsPath: 'items', as: 'results', maxConcurrency: 2, body: {
    node: 'chain', steps: [agent(), workflow().root,
      { node: 'call', label: 'source', via: 'tool', tool: 'source_search', args: {}, out: 'Result', as: 'decision', deadline_s: 1 }],
  } });
  source.output = { schemaId: 'All' }; source.schemas.All = { type: 'object' };
  service.prepare(source);
  const report = await service.run({ items: Array(101).fill('x'), evidence: 'documented' }, {
    deps: { runNode: async () => ({ accept: true }), runJudge: answer, runEffect: async () => ({ accept: true }) },
  });
  assert.equal(report.status, 'complete');
  assert.deepEqual(report.calls, { agent: 101, judge: 101, tool: 101 });
  service.prepare(workflow(agent()));
  const entered = deferred();
  const running = service.run({}, { deps: { runNode: () => { entered.resolve(); return new Promise(() => {}); } } });
  await entered.promise; service.stop();
  assert.equal((await running).status, 'interrupted');
  assert.throws(() => new WorkflowExtensionService({ limits: { maxConcurrency: null } }), /configuration|integer/);
  await service.dispose();
});

test('adapters share a global concurrency bound', async () => {
  const service = new WorkflowExtensionService({ limits: { maxConcurrency: 2 } });
  const source = workflow({ node: 'map', label: 'each', itemsPath: 'items', as: 'results', maxConcurrency: 4, body: agent() });
  source.output = { schemaId: 'All' }; source.schemas.All = { type: 'object' };
  service.prepare(source);
  let active = 0, peak = 0;
  const result = await service.run({ items: [1, 2, 3, 4, 5] }, { deps: { runNode: async () => { active++; peak = Math.max(peak, active); await new Promise(resolve => setImmediate(resolve)); active--; return { accept: true }; } } });
  assert.equal(result.status, 'complete'); assert.equal(peak, 2); assert.equal(result.calls.agent, 5);
});

test('one active operation, stop, immutable input, and late results cannot change a stopped report', async () => {
  const service = new WorkflowExtensionService(); service.prepare(workflow(agent()));
  const entered = deferred(), late = deferred();
  const input = { evidence: 'original' };
  let received;
  const running = service.run(input, { deps: { runNode: async params => { received = JSON.parse(params.user); entered.resolve(); return late.promise; } } });
  input.evidence = 'changed'; await entered.promise;
  assert.equal(received.evidence, 'original');
  assert.throws(() => service.prepare(workflow()), /Stop the current/);
  await assert.rejects(service.run({}, { deps: {} }), /Stop the current/);
  service.stop();
  const report = await running; assert.equal(report.status, 'interrupted');
  const retained = service.inspect().lastReport;
  late.resolve({ accept: true }); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(service.inspect().lastReport, retained);
  await service.dispose(); assert.throws(() => service.inspect(), /disposed/);
});

test('sibling cancellation stops an uncooperative agent in a nested map', { timeout: 2000 }, async () => {
  const service = new WorkflowExtensionService();
  const source = workflow({ node: 'map', label: 'each', itemsPath: 'items', as: 'results', maxConcurrency: 2, body: agent() });
  source.output = { schemaId: 'All' }; source.schemas.All = { type: 'object' }; service.prepare(source);
  const entered = deferred();
  const result = await service.run({ items: [1, 2] }, { deps: { runNode: async ({ item }) => {
    if (item.index === 0) { await entered.promise; throw new Error('secret-provider-body'); }
    entered.resolve(); return new Promise(() => {});
  } } });
  assert.equal(result.status, 'failed'); assert.equal(JSON.stringify(result).includes('secret-provider-body'), false);
});

test('deadline and disposal settle stalled agents without late user notifications', { timeout: 2000 }, async () => {
  const timed = new WorkflowExtensionService({ limits: { deadlineMs: 10 } }); timed.prepare(workflow(agent()));
  const result = await timed.run({}, { deps: { runNode: () => new Promise(() => {}) } });
  assert.equal(result.status, 'interrupted'); assert.equal(result.error.code, 'deadline');
  const disposed = new WorkflowExtensionService(); disposed.prepare(workflow(agent()));
  const entered = deferred(); let messages = 0;
  const running = disposed.run({}, { deps: { runNode: () => { entered.resolve(); return new Promise(() => {}); } }, onEvent: () => { messages++; } });
  await entered.promise; await disposed.dispose();
  const count = messages; assert.equal((await running).status, 'interrupted');
  await new Promise(resolve => setImmediate(resolve)); assert.equal(messages, count);
});

test('malformed graphs and inputs fail before calls, while trace retention is nonfatal and explicit', async () => {
  const service = new WorkflowExtensionService();
  const cycle = workflow(); cycle.root.body = cycle; assert.throws(() => service.prepare(cycle), /cycles/);
  let touched = false; const getter = workflow(); Object.defineProperty(getter, 'name', { get() { touched = true; return 'bad'; } });
  assert.throws(() => service.prepare(getter), /accessors/); assert.equal(touched, false);
  service.prepare(workflow(agent()));
  await assert.rejects(service.run({ evidence: 'x'.repeat(600_000) }, { deps: {} }), /byte limit/);
  const tiny = new WorkflowExtensionService({ limits: { maxTraceBytes: 10 } }); tiny.prepare(workflow(agent()));
  let calls = 0; const result = await tiny.run({}, { deps: { runNode: async () => { calls++; return { accept: true }; } } });
  assert.equal(result.status, 'complete'); assert.deepEqual(result.output, { accept: true });
  assert.equal(result.traceTruncated, true); assert.equal(calls, 1);
  assert.equal(result.trace.retainedBytes, 0); assert.equal(result.trace.droppedEvents, result.trace.receivedEvents);
});

test('provider failures and credential fields never enter retained traces', async () => {
  const service = new WorkflowExtensionService(); service.prepare(workflow(agent()));
  const report = await service.run({}, { deps: { runNode: async () => { throw new Error('authorization: SECRET'); } } });
  assert.equal(report.status, 'failed'); assert.equal(JSON.stringify(service.inspect()).includes('SECRET'), false);
});


test('interrupted tool effects retain uncertainty without exposing provider errors', { timeout: 2000 }, async () => {
  const service = new WorkflowExtensionService({ allowedTools: ['source_search'] });
  service.prepare(workflow({ node: 'call', label: 'search', via: 'tool', tool: 'source_search', args: {}, out: 'Result', as: 'decision', deadline_s: 1 }));
  const entered = deferred(), late = deferred();
  const running = service.run({}, { deps: { runEffect: () => { entered.resolve(); return late.promise; } } });
  await entered.promise; service.stop();
  const result = await running;
  assert.equal(result.status, 'interrupted'); assert.equal(result.uncertainEffects.length, 1);
  assert.equal(result.uncertainEffects[0].outcome, 'unknown');
  assert.match(result.uncertainEffects[0].idempotencyKey, /^[a-f0-9]{64}$/);
  const retained = service.inspect().lastReport;
  late.resolve({ accept: true }); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(service.inspect().lastReport, retained);
});


test('invalid root input has actionable recovery without exposing provider errors or starting work', async () => {
  const service = new WorkflowExtensionService();
  const definition = workflow(agent());
  definition.schemas.Input = { type: 'object', required: ['evidence'], properties: { evidence: { type: 'string' } } };
  definition.input = { schemaId: 'Input' };
  service.prepare(definition);
  let calls = 0;
  const deps = { runNode: async () => { calls++; throw new WorkflowInputInvalidError('private-provider-body', ['private-provider-details']); } };
  const invalid = await service.run({}, { deps });
  assert.equal(invalid.status, 'failed');
  assert.equal(invalid.error.code, 'input_invalid');
  assert.match(invalid.error.message, /Pass input with action run/);
  assert.equal(calls, 0);
  assert.deepEqual(invalid.events, []);
  const providerFailure = await service.run({ evidence: 'A source.' }, { deps });
  assert.equal(providerFailure.error.code, 'execution_failed');
  assert.doesNotMatch(providerFailure.error.message, /private-provider/);
  assert.equal(calls, 1);
  await service.dispose();
});


test('adapter-created workflow errors remain opaque across agent, judge and tool boundaries', async () => {
  const failures = [new WorkflowInputInvalidError('PRIVATE_NAME', ['PRIVATE_DETAIL']),
    new WorkflowOutputInvalidError('PRIVATE_MESSAGE', ['PRIVATE_DETAIL'], 'PRIVATE_STAGE'),
    new WorkflowStateError('PRIVATE_MESSAGE', 'PRIVATE_STAGE', 'PRIVATE_PATH', 'missing_interpolation')];
  for (const kind of ['agent', 'judge', 'tool']) for (const error of failures) {
    const service = new WorkflowExtensionService({ allowedTools: ['source_search'] });
    const node = kind === 'agent' ? agent() : kind === 'judge' ? workflow().root
      : { node: 'call', label: 'read', via: 'tool', tool: 'source_search', args: {}, out: 'Result', as: 'decision', deadline_s: 1 };
    service.prepare(workflow(node));
    const fail = async () => { throw error; };
    const report = await service.run({ evidence: 'Fictional source.' }, { deps: { runNode: fail, runJudge: fail, runEffect: fail } });
    assert.equal(report.error.code, 'execution_failed');
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_/);
    await service.dispose();
  }
});

test('input and output schema diagnostics omit source-derived property names', async () => {
  const service = new WorkflowExtensionService({ allowedTools: ['source_search'] });
  for (const schema of [
    { type: 'object', propertyNames: { pattern: '^allowed' } },
    { type: 'object', patternProperties: { '.*': { type: 'number' } } },
  ]) {
    const definition = workflow({ node: 'call', label: 'read', via: 'tool', tool: 'source_search', args: {}, out: 'Result', as: 'decision', deadline_s: 1 });
    definition.schemas.Result = schema;
    service.prepare(definition);
    const output = await service.run({}, { deps: { runEffect: async () => ({ PRIVATE_SOURCE_KEY: 'PRIVATE_SOURCE_VALUE' }) } });
    assert.equal(output.error.code, 'output_invalid');
    assert.doesNotMatch(JSON.stringify(output.error), /PRIVATE_/);
    definition.schemas.Input = schema; definition.input = { schemaId: 'Input' };
    service.prepare(definition);
    const input = await service.run({ PRIVATE_SOURCE_KEY: 'PRIVATE_SOURCE_VALUE' }, { deps: {} });
    assert.equal(input.error.code, 'input_invalid');
    assert.doesNotMatch(JSON.stringify(input), /PRIVATE_/);
  }
  await service.dispose();
});
