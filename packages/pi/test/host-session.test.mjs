import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelRuntime, ModelRegistry } from '@earendil-works/pi-coding-agent';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { createPiHostRunner, createPiHostSessionFactory } from '../dist/index.js';

const request = { kind: 'agent', label: 'host-child', system: ['Return the count with submit.'], user: 'Count the selected source.', schema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'], additionalProperties: false } };
async function host(responses) {
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const faux = fauxProvider({ tokensPerSecond: Infinity });
  faux.setResponses(responses);
  runtime.registerNativeProvider(faux.provider);
  const registry = new ModelRegistry(runtime);
  const calls = [];
  const ctx = {
    cwd: process.cwd(), model: faux.getModel(), thinkingLevel: 'high',
    modelRegistry: {
      getAll: () => registry.getAll(),
      streamSimple(model, transcript, options) {
        assert.equal(this, ctx.modelRegistry, 'registry receiver must remain bound');
        calls.push({ model, transcript, options });
        return registry.streamSimple(model, transcript, options);
      },
    },
  };
  return { ctx, faux, calls };
}

test('native child Agent uses host transport, explicit tools, inherited thinking, and repairs rejected submission', async () => {
  const source = fauxToolCall('source_search', { query: 'apples' });
  const { ctx, calls, faux } = await host([
    fauxAssistantMessage(source),
    fauxAssistantMessage(fauxToolCall('submit', { value: { count: 1 } })),
    transcript => {
      assert.match(JSON.stringify(transcript.messages), /Expected count two/);
      assert.match(JSON.stringify(transcript.messages), /Two apples/);
      return fauxAssistantMessage(fauxToolCall('submit', { value: { count: 2 } }));
    },
    fauxAssistantMessage('Must not request another model turn'),
  ]);
  let tools = 0;
  const events = [];
  const output = await createPiHostRunner(ctx, {
    maxTurns: 4, timeoutMs: 10_000, onEvent: event => events.push(event),
    tools: [{ name: 'source_search', label: 'Search', description: 'Search the explicit source', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      async execute(_id, args, signal, _update, toolContext) {
        assert.equal(toolContext, ctx);
        assert.equal(args.query, 'apples');
        assert.equal(signal.aborted, false);
        tools++;
        return { content: [{ type: 'text', text: 'Two apples' }], details: {} };
      },
    }],
  })({ ...request, review: value => value.count === 2 ? { accepted: true } : { accepted: false, message: 'Expected count two' } });
  assert.deepEqual(output, { count: 2 });
  assert.equal(tools, 1);
  assert.equal(faux.state.callCount, 3);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.model, ctx.model);
    assert.equal(call.options.reasoning, 'high');
  }
  assert.equal(events.filter(event => event.type === 'turn_start').length, 3);
  assert(events.some(event => event.type === 'tool_execution_end'));
});

test('host thinking can be narrowed by a node and unregistered tools fail before transport', async () => {
  const { ctx, calls } = await host([fauxAssistantMessage(fauxToolCall('submit', { value: { count: 2 } }))]);
  const run = createPiHostRunner(ctx, { timeoutMs: 10_000 });
  await assert.rejects(run({ ...request, tools: ['bash'] }), /not explicitly registered/);
  assert.equal(calls.length, 0);
  assert.deepEqual(await run({ ...request, thinking: 'low' }), { count: 2 });
  assert.equal(calls[0].options.reasoning, 'low');
});

test('missing or unknown active host models fail closed without transport or fallback', async () => {
  const { ctx, calls } = await host([]);
  assert.throws(() => createPiHostRunner({ ...ctx, model: undefined }), /active Pi model/);
  assert.throws(() => createPiHostRunner({ ...ctx, modelRegistry: { ...ctx.modelRegistry, getAll: () => [] } }), /active Pi model/);
  assert.equal(calls.length, 0);
});

test('host child timeout and cancellation abort admitted tools and bound cleanup', async () => {
  for (const mode of ['timeout', 'abort']) {
    const { ctx, calls } = await host([fauxAssistantMessage(fauxToolCall('wait', {}))]);
    const controller = new AbortController();
    let admitted;
    const started = new Promise(resolve => { admitted = resolve; });
    let toolSignal;
    const run = createPiHostRunner(ctx, {
      signal: controller.signal, timeoutMs: mode === 'timeout' ? 1000 : 10_000,
      tools: [{ name: 'wait', label: 'Wait', description: 'Wait for cancellation', parameters: { type: 'object' },
        async execute(_id, _args, signal) {
          toolSignal = signal;
          admitted();
          return new Promise(resolve => signal.addEventListener('abort', () => resolve({ content: [{ type: 'text', text: 'Cancelled' }], details: {} }), { once: true }));
        },
      }],
    });
    const outcome = run(request);
    const rejection = assert.rejects(outcome, error => error.reason === (mode === 'timeout' ? 'timeout' : 'aborted'));
    await started;
    if (mode === 'abort') controller.abort();
    await rejection;
    assert.equal(toolSignal.aborted, true);
    assert.equal(calls.length, 1);
  }
});

test('host factory exposes the same native Agent transport and stops after disposal', async () => {
  const { ctx, calls } = await host([fauxAssistantMessage('Plain Agent reply')]);
  const factory = createPiHostSessionFactory(ctx);
  const { session } = await factory({ model: ctx.model, cwd: ctx.cwd, thinkingLevel: 'low', tools: [], customTools: [], resourceLoader: { getSystemPrompt: () => 'Reply in plain text.', getAgentsFiles: () => ({ agentsFiles: [] }) }, settingsManager: {}, sessionManager: {} });
  await session.prompt('Hello');
  assert.equal(calls.length, 1);
  session.dispose();
  await assert.rejects(session.prompt('Do not run'), /disposed/);
  assert.equal(calls.length, 1);
});

test('native turn limit admits exactly the declared number of model requests', async () => {
  const { ctx, calls } = await host([
    fauxAssistantMessage(fauxToolCall('source_search', {})),
    fauxAssistantMessage(fauxToolCall('source_search', {})),
    fauxAssistantMessage(fauxToolCall('submit', { value: { count: 2 } })),
  ]);
  let tools = 0;
  const runner = createPiHostRunner(ctx, {
    maxTurns: 2, timeoutMs: 10_000,
    tools: [{ name: 'source_search', label: 'Search', description: 'Read a fixture', parameters: { type: 'object' },
      async execute() { tools++; return { content: [{ type: 'text', text: 'Fixture' }], details: {} }; },
    }],
  });
  await assert.rejects(runner(request), error => error.reason === 'turn_limit');
  assert.equal(calls.length, 2);
  assert.equal(tools, 2);
});

test('an accepted submit prevents later tool effects in the same native model turn', async () => {
  const { ctx, calls } = await host([
    fauxAssistantMessage(fauxToolCall('submit', { value: { count: 2 } }), fauxToolCall('effect', {})),
  ]);
  let effects = 0;
  const output = await createPiHostRunner(ctx, {
    timeoutMs: 10_000,
    tools: [{ name: 'effect', label: 'Effect', description: 'Must not execute after submission', parameters: { type: 'object' },
      async execute() { effects++; return { content: [{ type: 'text', text: 'Unexpected effect' }], details: {} }; },
    }],
  })(request);
  assert.deepEqual(output, { count: 2 });
  assert.equal(effects, 0);
  assert.equal(calls.length, 1);
});
