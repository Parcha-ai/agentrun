import assert from 'node:assert/strict';
import test from 'node:test';
import { MemorySession, tool } from '@openai/agents';
import { assistantMessage, functionCall } from '@openai/agents/testing';
import { withOpenAIAgentsLearning } from '../dist/openai-agents.js';
import { createWorkflowMcpBridge } from '../dist/workflows.js';
import * as workflowEngine from '@parcha/agentrun-dsl';
import { nativeOpenAIAgents, nativeOpenAIAgentsWorkflow, openAIAgentsPolicy, response } from './openai-agents-native-fixture.mjs';

function service({ enabled = true, eventsError = false, context = 'Begin every answer with Verified.', workflows = [] } = {}) {
  const requests = [];
  let runs = 0;
  return { requests, config: { agentId: 'backend-openai-agents', learning: true, callModelInputFilter: null,
    baseUrl: 'https://server.example/v2', apiKey: 'fake-test-key', maxRetries: 0, pollIntervalMs: 1, learningTimeoutMs: 1000,
    fetch: async (url, init) => {
      const path = new URL(url).pathname, body = init.body ? JSON.parse(init.body) : undefined;
      requests.push({ path, method: init.method, body });
      if (path === '/v2/agents/backend-openai-agents') return Response.json({ definition: { sdk: { runtime: 'openai-agents-sdk' } } });
      if (path === '/v2/agents/backend-openai-agents/sdk-runs') return Response.json({ run_id: `sdk-run-${++runs}`, agent_id: 'backend-openai-agents',
        token: 'fixture-scoped-key', console_url: `https://server.example/#/runs/sdk-run-${runs}`,
        learning: { enabled, revision: enabled ? 'approved-revision' : null, context, workflows } });
      if (path.endsWith('/events')) return eventsError ? Response.json({ error: { code: 'unavailable' } }, { status: 503 }) : Response.json({ accepted: true });
      if (path.endsWith('/complete')) return Response.json({ accepted: true });
      if (/\/sdk-runs\/sdk-run-\d+$/.test(path)) return Response.json({ run_id: path.split('/').at(-1), state: 'completed', learning: enabled ? { state: 'merged' } : null });
      throw new Error(`Unexpected fixture route ${path}`);
    },
  } };
}
const task = 'What is the release status?';
const complete = requests => requests.find(request => request.path.endsWith('/complete')).body;
const events = requests => requests.filter(request => request.path.endsWith('/events')).flatMap(request => request.body.events);

test('native Agent, policy, guardrails, session, context and result identity survive learned reference', async () => {
  const { config, requests } = service(), session = new MemorySession(), guardrailInputs = [];
  await session.addItems([{ role: 'user', content: 'Native saved preference.' }, assistantMessage('Native saved reply.')]);
  const context = { host: 'unchanged' };
  const fixture = nativeOpenAIAgents({ agentOptions: { inputGuardrails: [{ name: 'native guardrail', runInParallel: false,
    execute: async ({ input }) => { guardrailInputs.push(input); return { tripwireTriggered: false, outputInfo: {} }; } }] } });
  const observations = [];
  const original = fixture.nativeRun;
  let nativeResult;
  const wrapped = withOpenAIAgentsLearning(async (agent, input, options) => {
    observations.push({ agent, input, options });
    nativeResult = await original(agent, input, options);
    return nativeResult;
  }, config);
  const hostFilter = ({ modelData, context: received }) => { assert.equal(received, context); return { ...modelData, instructions: modelData.instructions + '\nHost filter policy.' }; };
  const options = { session, context, callModelInputFilter: hostFilter, maxTurns: 3 };
  const result = await wrapped(fixture.agent, task, options);
  assert.equal(result, nativeResult);
  await wrapped.flushLearning();
  assert.equal(result.finalOutput, 'Verified. The release is ready.');
  assert.equal(fixture.calls.length, 1);
  assert.equal(observations[0].agent, fixture.agent);
  assert.equal(observations[0].input, task);
  assert.equal(observations[0].options.session, session);
  assert.equal(options.callModelInputFilter, hostFilter);
  assert.equal(fixture.agent.instructions, openAIAgentsPolicy);
  assert.match(fixture.calls[0].request.systemInstructions, /^Report the release status accurately/);
  assert.match(fixture.calls[0].request.systemInstructions, /Host filter policy\.[\s\S]+AgentRun accepted learning/);
  assert.match(JSON.stringify(fixture.calls[0].request.input), /Native saved preference/);
  assert.doesNotMatch(JSON.stringify(await session.getItems()), /AgentRun accepted learning|Host filter policy/);
  assert.doesNotMatch(JSON.stringify(guardrailInputs), /AgentRun accepted learning/);
  assert.equal(requests.find(request => request.path.endsWith('/sdk-runs')).body.input, task);
  assert.equal(requests.find(request => request.path.endsWith('/sdk-runs')).body.instructions, openAIAgentsPolicy);
  assert.deepEqual(complete(requests).usage, { input_tokens: null, output_tokens: 3, cache_read_tokens: 2, cache_write_tokens: null, cost_usd: null });
});

test('explicit bound Runner filter and per-run overrides retain native precedence', async () => {
  let defaults = 0, overrides = 0;
  const defaultFilter = ({ modelData }) => { defaults++; return { ...modelData, instructions: modelData.instructions + '\nDefault host filter.' }; };
  const fixture = nativeOpenAIAgents({ runnerOptions: { callModelInputFilter: defaultFilter } }), { config } = service();
  const wrapped = withOpenAIAgentsLearning(fixture.nativeRun, { ...config, callModelInputFilter: defaultFilter });
  await wrapped(fixture.agent, task);
  await wrapped(fixture.agent, task, { callModelInputFilter: ({ modelData }) => { overrides++; return modelData; } });
  await wrapped.flushLearning();
  assert.equal(defaults, 1);
  assert.equal(overrides, 1);
});

test('Off preserves exact native options and invokes its own filter normally', async () => {
  const fixture = nativeOpenAIAgents(), { config, requests } = service({ enabled: false });
  const options = { context: { native: true } };
  let passed;
  const wrapped = withOpenAIAgentsLearning((agent, input, opts) => { passed = opts; return fixture.nativeRun(agent, input, opts); }, config);
  assert.equal((await wrapped(fixture.agent, task, options)).finalOutput, 'The release is ready.');
  await wrapped.flushLearning();
  assert.equal(passed, options);
  assert.equal(fixture.calls[0].request.systemInstructions, openAIAgentsPolicy);
  assert.equal(complete(requests).answer, 'The release is ready.');
});

test('unsupported inputs, streams, resume, output formats and undeclared filters fail before registration', async () => {
  const fixture = nativeOpenAIAgents(), { config, requests } = service();
  const wrapped = withOpenAIAgentsLearning(fixture.nativeRun, config);
  for (const input of [[], {}, null, [{ role: 'user', content: task }]]) await assert.rejects(wrapped(fixture.agent, input), /fresh text/);
  for (const options of [{ stream: true }, { previousResponseId: 'old' }, { conversationId: 'conversation' }]) await assert.rejects(wrapped(fixture.agent, task, options), /fresh text/);
  await assert.rejects(wrapped({ ...fixture.agent, instructions: () => 'dynamic' }, task), /explicit instructions snapshot/);
  await assert.rejects(wrapped({ ...fixture.agent, outputType: {} }, task), /text output/);
  const { callModelInputFilter: _, ...undeclared } = config;
  await assert.rejects(withOpenAIAgentsLearning(fixture.nativeRun, undeclared)(fixture.agent, task), /Declare/);
  assert.equal(requests.length, 0);
  assert.equal(fixture.calls.length, 0);
});

test('dynamic host policy remains dynamic while the explicit source snapshot is recorded', async () => {
  const fixture = nativeOpenAIAgents({ instructions: context => `Dynamic native policy ${context.context.release}.` });
  const { config, requests } = service();
  const wrapped = withOpenAIAgentsLearning(fixture.nativeRun, { ...config, instructions: 'Source policy snapshot.' });
  await wrapped(fixture.agent, task, { context: { release: 'current' } });
  await wrapped.flushLearning();
  assert.match(fixture.calls[0].request.systemInstructions, /^Dynamic native policy current/);
  assert.equal(requests.find(request => request.path.endsWith('/sdk-runs')).body.instructions, 'Source policy snapshot.');
});

test('additional source instructions retain the static Agent policy and never replace native policy', async () => {
  const fixture = nativeOpenAIAgents(), { config, requests } = service();
  const wrapped = withOpenAIAgentsLearning(fixture.nativeRun, { ...config, instructions: 'Additional host policy snapshot.' });
  await wrapped(fixture.agent, task);
  await wrapped.flushLearning();
  const source = requests.find(request => request.path.endsWith('/sdk-runs')).body.instructions;
  assert.equal(source, `Additional host policy snapshot.\n\n${openAIAgentsPolicy}`);
  assert.equal(fixture.agent.instructions, openAIAgentsPolicy);
});

test('a native result arriving after caller abort is preserved but completed as cancelled', async () => {
  const fixture = nativeOpenAIAgents(), { config, requests } = service(), controller = new AbortController();
  let nativeResult;
  const wrapped = withOpenAIAgentsLearning(async (...args) => {
    nativeResult = await fixture.nativeRun(...args);
    controller.abort(new Error('late caller cancellation'));
    return nativeResult;
  }, config);
  assert.equal(await wrapped(fixture.agent, task, { signal: controller.signal }), nativeResult);
  await wrapped.flushLearning();
  assert.equal(complete(requests).status, 'cancelled');
});

test('native error state retains measured usage from completed calls before max-turn failure', async t => {
  const fixture = await nativeOpenAIAgentsWorkflow();
  t.after(fixture.close);
  const { config, requests } = service();
  let failure;
  const wrapped = withOpenAIAgentsLearning(async (...args) => {
    try { return await fixture.nativeRun(...args); } catch (error) { failure = error; throw error; }
  }, config);
  await assert.rejects(wrapped(fixture.agent, task, { maxTurns: 1 }), error => error === failure);
  await assert.rejects(wrapped.flushLearning(), /complete public evidence/);
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.toolCalls.length, 1);
  assert.equal(complete(requests).usage.output_tokens, 3);
  assert.equal(complete(requests).usage.cache_read_tokens, 2);
  assert.equal(complete(requests).usage.input_tokens, null);
});

test('native model failure and cancellation retain error identity without a second native call', async () => {
  for (const cancelled of [false, true]) {
    const controller = new AbortController(), failure = new Error('original private native failure');
    const fixture = nativeOpenAIAgents({ respond: () => { if (cancelled) controller.abort(failure); throw failure; } });
    const { config, requests } = service(), wrapped = withOpenAIAgentsLearning(fixture.nativeRun, config);
    await assert.rejects(wrapped(fixture.agent, task, { signal: controller.signal }), error => error === failure);
    await assert.rejects(wrapped.flushLearning(), /complete public evidence/);
    assert.equal(fixture.calls.length, 1);
    assert.equal(complete(requests).status, cancelled ? 'cancelled' : 'failed');
    assert.doesNotMatch(JSON.stringify(requests), /original private native failure/);
    if (cancelled) {
      const before = requests.length;
      await assert.rejects(wrapped(fixture.agent, task, { signal: controller.signal }), error => error === failure);
      assert.equal(requests.length, before);
    }
  }
});

test('persistence failure is reported through flush while the native result survives', async () => {
  const fixture = nativeOpenAIAgents(), { config, requests } = service({ eventsError: true });
  const wrapped = withOpenAIAgentsLearning(fixture.nativeRun, config);
  assert.equal((await wrapped(fixture.agent, task)).finalOutput, 'Verified. The release is ready.');
  await assert.rejects(wrapped.flushLearning(), /503/);
  assert.equal(complete(requests).evidence_complete, false);
  assert.equal(complete(requests).status, 'completed');
});

test('reasoning stays private; unknown public output preserves result but prevents learning', async () => {
  const fixture = nativeOpenAIAgents({ respond: () => response([
    { type: 'reasoning', content: [{ type: 'input_text', text: 'private reasoning' }] },
    { ...assistantMessage('Public answer.'), content: [{ type: 'output_text', text: 'Public answer.' }, { type: 'image', image: 'private image' }] },
  ]) });
  const { config, requests } = service(), wrapped = withOpenAIAgentsLearning(fixture.nativeRun, config);
  assert.equal((await wrapped(fixture.agent, task)).finalOutput, 'Public answer.');
  await assert.rejects(wrapped.flushLearning(), /non-text/);
  assert.equal(complete(requests).evidence_complete, false);
  assert.doesNotMatch(JSON.stringify(requests), /private reasoning|private image/);
});

test('absent raw usage does not turn normalized zero counters into measured usage', async () => {
  const fixture = nativeOpenAIAgents({ usage: null }), { config, requests } = service();
  const wrapped = withOpenAIAgentsLearning(fixture.nativeRun, config);
  await wrapped(fixture.agent, task);
  await wrapped.flushLearning();
  assert.deepEqual(complete(requests).usage, { input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null, cost_usd: null });
});

test('native normalized cache details retain measured reads when raw usage preservation is disabled', async () => {
  for (const cached of [0, 2]) {
    const fixture = nativeOpenAIAgents({ agentOptions: { modelSettings: { preserveRawUsage: false } },
      usage: { input_tokens: 10, output_tokens: 3, input_tokens_details: { cached_tokens: cached } } });
    const { config, requests } = service(), wrapped = withOpenAIAgentsLearning(fixture.nativeRun, config);
    const result = await wrapped(fixture.agent, task);
    assert.equal(result.rawResponses[0].rawUsage, undefined);
    await wrapped.flushLearning();
    assert.deepEqual(complete(requests).usage, { input_tokens: null, output_tokens: 3, cache_read_tokens: cached, cache_write_tokens: null, cost_usd: null });
  }
});

test('malformed evidence accessors and missing items never replace the native result', async () => {
  for (const result of [{ finalOutput: 'Native answer.' }, {
    get newItems() { throw new Error('private accessor failure'); }, finalOutput: 'Native answer.',
  }]) {
    const { config, requests } = service();
    const wrapped = withOpenAIAgentsLearning(async () => result, config);
    assert.equal(await wrapped({ instructions: openAIAgentsPolicy }, task), result);
    await assert.rejects(wrapped.flushLearning(), /no run items|inspected safely/);
    assert.equal(complete(requests).evidence_complete, false);
    assert.doesNotMatch(JSON.stringify(requests), /private accessor failure/);
  }
});

test('native approval interruption remains resumable, executes no denied tool, and cannot learn', async () => {
  let executed = 0;
  const guarded = tool({ name: 'guarded', description: 'Requires host approval.', parameters: { type: 'object', properties: {}, additionalProperties: false },
    needsApproval: true, execute: () => { executed++; return 'done'; } });
  const fixture = nativeOpenAIAgents({ agentOptions: { tools: [guarded] }, respond: () => response([functionCall('guarded', {}, { callId: 'approval' })]) });
  const { config, requests } = service(), wrapped = withOpenAIAgentsLearning(fixture.nativeRun, config);
  const result = await wrapped(fixture.agent, task);
  assert.equal(result.interruptions.length, 1);
  assert.equal(executed, 0);
  await assert.rejects(wrapped.flushLearning(), /unsupported run item|terminal output/);
  assert.equal(complete(requests).status, 'cancelled');
  await assert.rejects(wrapped(fixture.agent, result.state), /fresh text/);
});

const workflow = { v: 2, name: 'release-status', schemas: {
  Input: { type: 'object', properties: { release: { type: 'string' } }, required: ['release'] },
  Status: { type: 'object', properties: { ready: { type: 'boolean' } }, required: ['ready'] },
}, input: { schemaId: 'Input' }, output: { schemaId: 'Status', path: 'status' },
root: { node: 'call', label: 'status', via: 'tool', tool: 'mcp:backend/status', args: { release: '{release}' }, out: 'Status', as: 'status', deadline_s: 5 } };

async function workflowFixture(t, { enabled = true, policy = () => 'allow', serverName = 'agentrun' } = {}) {
  const effects = [];
  const execute = (args, context) => { effects.push({ args, context }); return { ready: true }; };
  const bridge = await createWorkflowMcpBridge({ engine: workflowEngine, nativeMcpServerName: serverName, policy,
    tools: [{ name: 'mcp:backend/status', description: 'Read release readiness.', input_schema: workflow.schemas.Input,
      output_schema: workflow.schemas.Status, permission: 'allow', readOnly: true, execute }] });
  const fixture = await nativeOpenAIAgentsWorkflow({ bridge, execute, serverName });
  t.after(async () => { await fixture.close(); await bridge.close(); });
  const { config, requests } = service({ enabled, context: '', workflows: [{ name: workflow.name,
    description: 'Read fresh release readiness.', workflow: JSON.stringify(workflow) }] });
  const wrapped = withOpenAIAgentsLearning(fixture.nativeRun, { ...config, workflows: bridge });
  return { ...fixture, get calls() { return fixture.model.calls; }, bridge, effects, requests, wrapped };
}

test('actual native MCP workflow invokes one host effect, correlates bridge evidence, and revokes capability', async t => {
  const fixture = await workflowFixture(t), session = new MemorySession();
  const result = await fixture.wrapped(fixture.agent, task, { session });
  assert.equal(result.finalOutput, '{"ready":true}');
  await fixture.wrapped.flushLearning();
  assert.deepEqual(fixture.toolCalls.map(call => call.name), ['mcp_agentrun__learned_workflow']);
  assert.equal(fixture.effects.length, 1);
  assert.deepEqual(fixture.effects[0].args, { release: 'current' });
  assert.equal(fixture.calls.length, 2);
  const evidence = events(fixture.requests).filter(event => event.type === 'tool');
  assert.deepEqual(evidence.map(event => [event.name, event.status]), [
    ['learned_workflow', 'started'], ['mcp:backend/status', 'started'],
    ['mcp:backend/status', 'completed'], ['learned_workflow', 'completed'],
  ]);
  const capability = fixture.toolCalls[0].input.capability;
  assert.doesNotMatch(JSON.stringify(fixture.requests), new RegExp(capability));
  const memory = await session.getItems();
  assert.doesNotMatch(JSON.stringify(memory.filter(item => item.role === 'user')), new RegExp(capability));
  assert.doesNotMatch(JSON.stringify(memory), /AgentRun accepted learning|Supply capability/);
  assert.equal((await fixture.mcp.callTool('learned_workflow', fixture.toolCalls[0].input)).isError, true);
  assert.equal(fixture.effects.length, 1);
});

test('Off retains the native status tool with no workflow capability injection', async t => {
  const fixture = await workflowFixture(t, { enabled: false });
  assert.equal((await fixture.wrapped(fixture.agent, task)).finalOutput, '{"ready":true}');
  await fixture.wrapped.flushLearning();
  assert.deepEqual(fixture.toolCalls.map(call => call.name), ['mcp__backend__status']);
  assert.equal(fixture.effects.length, 1);
  assert.ok(fixture.calls.every(call => !/Supply capability/.test(call.request.systemInstructions)));
  assert.deepEqual(events(fixture.requests).filter(event => event.type === 'tool').map(event => [event.name, event.status]), [
    ['mcp:backend/status', 'started'], ['mcp:backend/status', 'completed'],
  ]);
});

test('actual native MCP server names containing underscores correlate one bridge receipt without duplicate evidence', async t => {
  const fixture = await workflowFixture(t, { serverName: 'agentrun_workflows' });
  assert.equal((await fixture.wrapped(fixture.agent, task)).finalOutput, '{"ready":true}');
  await fixture.wrapped.flushLearning();
  assert.deepEqual(fixture.toolCalls.map(call => call.name), ['mcp_agentrun_workflows__learned_workflow']);
  assert.equal(fixture.effects.length, 1);
  assert.equal(fixture.calls.length, 2);
  assert.deepEqual(events(fixture.requests).filter(event => event.type === 'tool').map(event => [event.name, event.status]), [
    ['learned_workflow', 'started'], ['mcp:backend/status', 'started'],
    ['mcp:backend/status', 'completed'], ['learned_workflow', 'completed'],
  ]);
});

test('host workflow policy denies effects without native retry', async t => {
  const fixture = await workflowFixture(t, { policy: () => 'deny' });
  const result = await fixture.wrapped(fixture.agent, task);
  assert.match(result.finalOutput, /denied|refused|allow/i);
  await fixture.wrapped.flushLearning();
  assert.equal(fixture.effects.length, 0);
  assert.equal(fixture.toolCalls.length, 1);
  assert.ok(events(fixture.requests).some(event => event.type === 'tool' && event.name === 'learned_workflow' && event.status === 'failed'));
});
