import assert from 'node:assert/strict';
import test from 'node:test';
import { CallbackManager } from '@langchain/core/callbacks/manager';
import { awaitAllCallbacks } from '@langchain/core/callbacks/promises';
import { Command } from '@langchain/langgraph';
import { withLangGraphLearning } from '../dist/langgraph.js';
import { createWorkflowMcpBridge } from '../dist/workflows.js';
import * as workflowEngine from '@parcha/agentrun-dsl';
import { langGraphAdapters, nativeLangGraph, nativeLangGraphWorkflow } from './langgraph-native-fixture.mjs';

function service({ enabled = true, eventsError = false, context = 'Begin every answer with Verified.', workflows = [] } = {}) {
  const requests = [];
  let runs = 0;
  return { requests, config: {
    ...langGraphAdapters, agentId: 'backend-langgraph', learning: true,
    baseUrl: 'https://server.example/v2', apiKey: 'fake-test-key',
    maxRetries: 0, pollIntervalMs: 1, learningTimeoutMs: 1000,
    fetch: async (url, init) => {
      const path = new URL(url).pathname, body = init.body ? JSON.parse(init.body) : undefined;
      requests.push({ path, method: init.method, body });
      if (path === '/v2/agents/backend-langgraph') return Response.json({ definition: { sdk: { runtime: 'langgraph' } } });
      if (path === '/v2/agents/backend-langgraph/sdk-runs') return Response.json({ run_id: `sdk-run-${++runs}`, agent_id: 'backend-langgraph',
        token: 'fixture-scoped-key', console_url: `https://server.example/#/runs/sdk-run-${runs}`, learning: { enabled,
          revision: enabled ? 'approved-revision' : null, context, workflows } });
      if (path.endsWith('/events')) return eventsError ? Response.json({ error: { code: 'unavailable' } }, { status: 503 }) : Response.json({ accepted: true });
      if (path.endsWith('/complete')) return Response.json({ accepted: true });
      if (/\/sdk-runs\/sdk-run-\d+$/.test(path)) return Response.json({ run_id: path.split('/').at(-1), state: 'completed', learning: enabled ? { state: 'merged' } : null });
      throw new Error(`Unexpected fixture route ${path}`);
    },
  } };
}
const input = () => ({ messages: [{ role: 'user', content: 'What is the release status?' }] });
const complete = requests => requests.find(request => request.path.endsWith('/complete')).body;
const events = requests => requests.filter(request => request.path.endsWith('/events')).flatMap(request => request.body.events);

test('native LangGraph receives owner corrections while retaining policy, checkpointer, store, callbacks, and original task evidence', async () => {
  const fixture = nativeLangGraph(), { config, requests } = service();
  await fixture.store.put(['native'], 'preference', { format: 'native memory survives' });
  const observed = [], observer = { name: 'host-observer', handleLLMEnd: (_result, id) => observed.push(id) };
  const options = { configurable: { thread_id: 'fresh-1', host_field: 'retained' }, callbacks: [observer],
    tags: ['native-tag'], metadata: { source: 'host' }, signal: new AbortController().signal, recursionLimit: 8 };
  const wrapped = withLangGraphLearning(fixture.graph, config), task = input();
  const output = await wrapped.invoke(task, options);
  await wrapped.flushLearning();
  assert.equal(output.messages.at(-1).content, 'Verified. The release is ready.');
  assert.equal(fixture.calls.length, 1, 'reflection must not call the native model again');
  assert.equal(fixture.calls[0].messages[0], fixture.policy);
  assert.match(fixture.calls[0].messages[1].content, /Begin every answer with Verified/);
  assert.equal(fixture.calls[0].messages[2].content, task.messages[0].content);
  assert.equal(fixture.nodeOptions[0].configurable.host_field, 'retained');
  assert.ok(fixture.nodeOptions[0].tags.includes('native-tag'));
  assert.deepEqual(options.callbacks, [observer]);
  assert.equal(observed.length, 1);
  assert.equal(fixture.graph.checkpointer, fixture.checkpointer);
  assert.equal(fixture.memories[0].value.format, 'native memory survives');
  assert.equal((await fixture.graph.getState(options)).values.messages.at(-1).content, output.messages.at(-1).content);
  assert.equal(requests.find(request => request.path.endsWith('/sdk-runs')).body.input, task.messages[0].content);
  assert.equal(requests.find(request => request.path.endsWith('/sdk-runs')).body.instructions, config.instructions);
  const tools = events(requests).filter(event => event.type === 'tool');
  assert.equal(tools.length, 2);
  assert.equal(tools[0].name, 'release_status');
  assert.equal(tools[0].id, tools[1].id);
  assert.deepEqual(tools.map(event => event.status), ['started', 'completed']);
  assert.deepEqual(complete(requests).usage, { input_tokens: 8, output_tokens: 6, cache_read_tokens: 8, cache_write_tokens: 4, cost_usd: null });
  assert.equal(complete(requests).session_id, 'fresh-1');
});

test('native CallbackManager is copied, preserving handlers, inheritance, tags, and metadata', async () => {
  const fixture = nativeLangGraph({ checkpoint: false }), { config } = service();
  let observed = 0;
  const manager = CallbackManager.fromHandlers({ handleLLMEnd() { observed++; } });
  manager.addTags(['manager-tag']);
  manager.addMetadata({ manager: true });
  const originalHandlers = [...manager.handlers];
  const wrapped = withLangGraphLearning(fixture.graph, config);
  await wrapped.invoke(input(), { callbacks: manager });
  await wrapped.flushLearning();
  assert.equal(observed, 1);
  assert.deepEqual(manager.handlers, originalHandlers);
  assert.ok(fixture.calls[0].runManager.tags.includes('manager-tag'));
  assert.equal(fixture.calls[0].runManager.metadata.manager, true);
});

test('bound and per-invocation native callback managers both retain their inherited handlers', async () => {
  const fixture = nativeLangGraph({ checkpoint: false }), { config } = service();
  let boundCalls = 0, localCalls = 0;
  const bound = CallbackManager.fromHandlers({ handleLLMEnd() { boundCalls++; } });
  const local = CallbackManager.fromHandlers({ handleLLMEnd() { localCalls++; } });
  const graph = fixture.graph.withConfig({ callbacks: bound, tags: ['bound-tag'] });
  const wrapped = withLangGraphLearning(graph, config);
  await wrapped.invoke(input(), { callbacks: local, tags: ['local-tag'] });
  await wrapped.flushLearning();
  assert.equal(boundCalls, 1);
  assert.equal(localCalls, 1);
  assert.equal(bound.handlers.length, 1);
  assert.equal(local.handlers.length, 1);
  assert.ok(fixture.calls[0].runManager.tags.includes('bound-tag'));
  assert.ok(fixture.calls[0].runManager.tags.includes('local-tag'));
});

test('native evidence admission does not wait behind an unrelated background callback queue', async () => {
  const fixture = nativeLangGraph({ checkpoint: false }), { config, requests } = service();
  const { promise: blocked, resolve: release } = Promise.withResolvers();
  let backgroundStarted = false;
  const background = { name: 'host-background-observer', awaitHandlers: false,
    handleChatModelStart() { backgroundStarted = true; return blocked; } };
  const wrapped = withLangGraphLearning(fixture.graph, config);
  try {
    await wrapped.invoke(input(), { callbacks: [background] });
    assert.equal(backgroundStarted, true);
    await wrapped.flushLearning();
    assert.ok(events(requests).some(event => event.type === 'text' && event.text.includes('Verified')));
    assert.equal(complete(requests).evidence_complete, undefined);
  } finally { release(); await awaitAllCallbacks(); }
});

test('Off never calls injection and retains original input identity with the same native graph result', async () => {
  const fixture = nativeLangGraph({ checkpoint: false }), { config, requests } = service({ enabled: false });
  const originalInvoke = fixture.graph.invoke.bind(fixture.graph), task = input();
  let nativeResult, nativeInput;
  fixture.graph.invoke = async (value, options) => { nativeInput = value; nativeResult = await originalInvoke(value, options); return nativeResult; };
  const wrapped = withLangGraphLearning(fixture.graph, { ...config, withLearning() { throw new Error('Off must not inject'); } });
  assert.equal(await wrapped.invoke(task), nativeResult);
  await wrapped.flushLearning();
  assert.equal(nativeInput, task);
  assert.equal(nativeResult.messages.at(-1).content, 'The release is ready.');
  assert.doesNotMatch(fixture.calls[0].messages.map(message => message.content).join('\n'), /AgentRun accepted learning|Verified/);
  assert.equal(complete(requests).answer, 'The release is ready.');
});

test('fresh invocations without a checkpointer retain cross-thread native store memory', async () => {
  const fixture = nativeLangGraph({ checkpoint: false }), { config, requests } = service();
  const wrapped = withLangGraphLearning(fixture.graph, config);
  await fixture.store.put(['native'], 'preference', { value: 'first' });
  await wrapped.invoke(input());
  await fixture.store.put(['native'], 'preference', { value: 'second' });
  await wrapped.invoke(input());
  await wrapped.flushLearning();
  assert.deepEqual(fixture.memories.map(memory => memory.value.value), ['first', 'second']);
  assert.equal(requests.filter(request => request.path.endsWith('/complete')).length, 2);
});

test('fresh checkpoint admission handles bound thread configuration and rejects repeated or existing threads', async () => {
  const fixture = nativeLangGraph(), { config, requests } = service();
  const bound = fixture.graph.withConfig({ configurable: { thread_id: 'bound-fresh' } });
  const wrapped = withLangGraphLearning(bound, config);
  await wrapped.invoke(input());
  await wrapped.flushLearning();
  await assert.rejects(wrapped.invoke(input()), /fresh thread_id/);
  const again = withLangGraphLearning(fixture.graph, config);
  await assert.rejects(again.invoke(input(), { configurable: { thread_id: 'bound-fresh' } }), /existing checkpoint/);
  assert.equal(fixture.calls.length, 1);
  assert.equal(requests.filter(request => request.path.endsWith('/sdk-runs')).length, 1);
});

test('concurrent wrappers cannot both admit the same native checkpoint thread', async () => {
  const fixture = nativeLangGraph(), { config } = service();
  const first = withLangGraphLearning(fixture.graph, config), second = withLangGraphLearning(fixture.graph, config);
  const options = { configurable: { thread_id: 'concurrent' } };
  const running = first.invoke(input(), options);
  await assert.rejects(second.invoke(input(), options), /fresh thread_id/);
  await running;
  await first.flushLearning();
  assert.equal(fixture.calls.length, 1);
});

test('resume, streaming modes, and unsupported callback containers fail before native or server work', async () => {
  const fixture = nativeLangGraph(), { config, requests } = service(), wrapped = withLangGraphLearning(fixture.graph, config);
  for (const task of [null, new Command({ resume: 'yes' })]) await assert.rejects(wrapped.invoke(task), /fresh/);
  for (const options of [{ configurable: { checkpoint_id: 'old' } }, { streamMode: 'updates' },
    { interruptBefore: ['agent'] }, { callbacks: {} }, {}]) await assert.rejects(wrapped.invoke(input(), options));
  assert.equal(fixture.calls.length, 0);
  assert.equal(requests.length, 0);
});

test('dynamic native interruption returns the original result, retains resumable checkpoint, and cannot learn', async () => {
  const fixture = nativeLangGraph({ pause: true }), { config, requests } = service();
  const wrapped = withLangGraphLearning(fixture.graph, config), options = { configurable: { thread_id: 'paused' } };
  const result = await wrapped.invoke(input(), options);
  assert.ok(result.__interrupt__.length);
  await assert.rejects(wrapped.flushLearning(), /No LangChain model callbacks/);
  assert.deepEqual((await fixture.graph.getState(options)).next, ['agent']);
  assert.equal(complete(requests).status, 'cancelled');
  assert.equal(complete(requests).evidence_complete, false);
  assert.equal(complete(requests).answer, '');
  assert.equal(fixture.calls.length, 0);
});

for (const usage of [undefined, { input_tokens: 20, output_tokens: 6, total_tokens: 26 },
  { input_tokens: NaN, output_tokens: -1, total_tokens: 0, input_token_details: { cache_read: '8', cache_creation: null } }]) {
  test(`unknown or malformed usage stays unknown (${String(usage?.input_tokens)})`, async () => {
    const fixture = nativeLangGraph({ checkpoint: false, usage: usage ?? null }), { config, requests } = service();
    const wrapped = withLangGraphLearning(fixture.graph, config);
    await wrapped.invoke(input());
    await wrapped.flushLearning();
    assert.equal(complete(requests).usage.input_tokens, null);
    assert.equal(complete(requests).usage.cache_read_tokens, null);
    assert.equal(complete(requests).usage.cache_write_tokens, null);
    assert.equal(complete(requests).usage.output_tokens, usage?.output_tokens === 6 ? 6 : null);
  });
}

test('original native error identity survives and persistence failure is reported only by flush', async () => {
  const failure = new Error('native model failed'), fixture = nativeLangGraph({ checkpoint: false, failure }), failedService = service();
  const wrapped = withLangGraphLearning(fixture.graph, failedService.config);
  await assert.rejects(wrapped.invoke(input()), error => error === failure);
  await wrapped.flushLearning();
  assert.equal(complete(failedService.requests).status, 'failed');
  assert.equal(fixture.calls.length, 1);
  const successful = nativeLangGraph({ checkpoint: false }), { config, requests } = service({ eventsError: true });
  const withErrors = withLangGraphLearning(successful.graph, config);
  assert.equal((await withErrors.invoke(input())).messages.at(-1).content, 'Verified. The release is ready.');
  await assert.rejects(withErrors.flushLearning(), /503/);
  assert.equal(complete(requests).status, 'completed');
  assert.equal(complete(requests).evidence_complete, false);
});

test('abort is passed to the native model and never causes an automatic retry', async () => {
  const controller = new AbortController(), failure = new Error('native cancelled');
  const fixture = nativeLangGraph({ checkpoint: false, respond: async (_messages, options) => {
    controller.abort(failure);
    options.signal.throwIfAborted();
  } }), { config, requests } = service();
  const wrapped = withLangGraphLearning(fixture.graph, config);
  await assert.rejects(wrapped.invoke(input(), { signal: controller.signal }));
  await wrapped.flushLearning();
  assert.equal(complete(requests).status, 'cancelled');
  assert.equal(fixture.calls.length, 1);
  const before = requests.length;
  await assert.rejects(wrapped.invoke(input(), { signal: controller.signal }), error => error === failure);
  assert.equal(requests.length, before);
});

test('unknown content prevents learning while reasoning and raw native tool data stay local', async () => {
  const fixture = nativeLangGraph({ checkpoint: false, respond: () => [
    { type: 'text', text: 'The release is ready.' }, { type: 'reasoning', text: 'hidden reasoning' }, { type: 'image', source: 'private-image' },
  ] }), { config, requests } = service();
  const wrapped = withLangGraphLearning(fixture.graph, { ...config, answerText: () => 'The release is ready.' });
  await wrapped.invoke(input());
  await assert.rejects(wrapped.flushLearning(), /non-text/);
  assert.equal(complete(requests).evidence_complete, false);
  assert.doesNotMatch(JSON.stringify(requests), /hidden reasoning|private-image/);
});

test('duplicate model callbacks are counted once; conflicting completions make evidence incomplete', async () => {
  for (const conflict of [false, true]) {
    const { config, requests } = service();
    const result = { messages: [{ content: 'The release is ready.' }] };
    const output = text => ({ generations: [[{ message: { content: text, usage_metadata: {
      input_tokens: 10, output_tokens: 3, total_tokens: 13, input_token_details: { cache_read: 2, cache_creation: 0 },
    } } }]] });
    const graph = { async invoke(_input, options) {
      const observer = options.callbacks.at(-1);
      observer.handleChatModelStart({}, [], 'model-1');
      observer.handleLLMEnd(output('The release is ready.'), 'model-1');
      observer.handleLLMEnd(output(conflict ? 'different answer' : 'The release is ready.'), 'model-1');
      return result;
    } };
    const wrapped = withLangGraphLearning(graph, config);
    assert.equal(await wrapped.invoke(input()), result);
    if (conflict) await assert.rejects(wrapped.flushLearning(), /conflicting/);
    else await wrapped.flushLearning();
    assert.equal(events(requests).filter(event => event.type === 'text').length, 1);
    assert.equal(complete(requests).usage.input_tokens, conflict ? null : 8);
    assert.equal(complete(requests).usage.output_tokens, conflict ? null : 3);
    if (conflict) assert.equal(complete(requests).evidence_complete, false);
  }
});

test('missing model callbacks and observation overflow preserve results but cannot learn or invent usage', async () => {
  for (const overflow of [false, true]) {
    const { config, requests } = service(), result = { messages: [{ content: 'The release is ready.' }] };
    const graph = { async invoke(_input, options) {
      if (overflow) for (let i = 0; i < 300; i++) options.callbacks.at(-1).handleChatModelStart({}, [], `model-${i}`);
      return result;
    } };
    const wrapped = withLangGraphLearning(graph, config);
    assert.equal(await wrapped.invoke(input()), result);
    await assert.rejects(wrapped.flushLearning(), overflow ? /bounded model observation/ : /No LangChain model callbacks/);
    assert.equal(complete(requests).evidence_complete, false);
    assert.equal(complete(requests).usage, undefined);
  }
});

const workflow = {
  v: 2, name: 'release-status', schemas: {
    Input: { type: 'object', properties: { release: { type: 'string' } }, required: ['release'] },
    Status: { type: 'object', properties: { ready: { type: 'boolean' } }, required: ['ready'] },
  }, input: { schemaId: 'Input' }, output: { schemaId: 'Status', path: 'status' },
  root: { node: 'call', label: 'status', via: 'tool', tool: 'mcp:backend/status', args: { release: '{release}' }, out: 'Status', as: 'status', deadline_s: 5 },
};

async function workflowFixture(t, { enabled = true, policy = () => 'allow' } = {}) {
  const effects = [];
  const execute = (args, context) => { effects.push({ args, context }); return { ready: true }; };
  const bridge = await createWorkflowMcpBridge({ engine: workflowEngine, nativeMcpServerName: 'agentrun', policy,
    tools: [{ name: 'mcp:backend/status', description: 'Read release readiness.', input_schema: workflow.schemas.Input,
      output_schema: workflow.schemas.Status, permission: 'allow', readOnly: true, execute }] });
  const fixture = await nativeLangGraphWorkflow({ bridge, execute });
  t.after(async () => { await fixture.close(); await bridge.close(); });
  const { config, requests } = service({ enabled, context: '', workflows: [{ name: workflow.name,
    description: 'Read fresh release readiness.', workflow: JSON.stringify(workflow) }] });
  const wrapped = withLangGraphLearning(fixture.graph, { ...config, workflows: bridge });
  return { ...fixture, bridge, effects, requests, wrapped };
}

test('host-added native workflow tool executes the pinned bridge, correlates its receipt, and revokes the task capability', async t => {
  const fixture = await workflowFixture(t);
  await fixture.store.put(['native'], 'preference', { format: 'host memory' });
  const output = await fixture.wrapped.invoke(input(), { configurable: { thread_id: 'workflow-fresh' } });
  await fixture.wrapped.flushLearning();
  assert.equal(output.messages.at(-1).content, '{"ready":true}');
  assert.deepEqual(fixture.toolCalls.map(call => call.name), ['mcp__agentrun__learned_workflow']);
  assert.equal(fixture.effects.length, 1, 'one native model tool choice admits exactly one existing host effect');
  assert.deepEqual(fixture.effects[0].args, { release: 'current' });
  assert.equal(complete(fixture.requests).usage.input_tokens, 20, 'two terminal model calls contribute once each');
  assert.equal(complete(fixture.requests).usage.output_tokens, 6);
  assert.equal(fixture.memories[0].value.format, 'host memory');
  const evidence = events(fixture.requests).filter(event => event.type === 'tool');
  assert.deepEqual(evidence.map(event => [event.name, event.status]), [
    ['learned_workflow', 'started'], ['mcp:backend/status', 'started'],
    ['mcp:backend/status', 'completed'], ['learned_workflow', 'completed'],
  ], 'the positively correlated native MCP envelope must not duplicate the bridge receipt');
  const capability = fixture.toolCalls[0].input.capability;
  assert.doesNotMatch(JSON.stringify(fixture.requests), new RegExp(capability));
  assert.ok(fixture.calls[0].messages.some(message => typeof message.content === 'string' && message.content.includes(capability)));
  const start = fixture.requests.find(request => request.path.endsWith('/sdk-runs')).body;
  assert.deepEqual(start.workflow_tools, fixture.bridge.catalog);
  // Reusing the exact native tool outside the completed task must not repeat its host effect.
  await assert.rejects(fixture.model.nativeTools[1].invoke(fixture.toolCalls[0].input), /bridge refused/);
  assert.equal(fixture.effects.length, 1);
});

test('learning Off retains native tools while no workflow context or bridge capability is injected', async t => {
  const fixture = await workflowFixture(t, { enabled: false });
  const output = await fixture.wrapped.invoke(input(), { configurable: { thread_id: 'workflow-off' } });
  await fixture.wrapped.flushLearning();
  assert.equal(output.messages.at(-1).content, '{"ready":true}');
  assert.deepEqual(fixture.toolCalls.map(call => call.name), ['mcp__backend__status']);
  assert.equal(fixture.effects.length, 1);
  assert.doesNotMatch(fixture.calls.flatMap(call => call.messages.map(message => message.content)).join('\n'), /Supply capability|Approved workflows/);
});

test('a host policy denial prevents the pinned workflow effect without native retries', async t => {
  const fixture = await workflowFixture(t, { policy: () => 'deny' });
  await assert.rejects(fixture.wrapped.invoke(input(), { configurable: { thread_id: 'workflow-denied' } }), /bridge refused/);
  await fixture.wrapped.flushLearning();
  assert.equal(fixture.effects.length, 0);
  assert.equal(fixture.toolCalls.length, 1);
  assert.equal(complete(fixture.requests).status, 'failed');
});
