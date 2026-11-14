import assert from 'node:assert/strict';
import test from 'node:test';
import { withCodexAgentLearning } from '../dist/codex.js';

function service({ enabled = true, eventsError = false } = {}) {
  const requests = [];
  return { requests, config: {
    agentId: 'backend-codex', instructions: 'Read release status accurately. Never change project files.',
    learning: true, baseUrl: 'https://server.example/v2', apiKey: 'fake-test-key',
    maxRetries: 0, pollIntervalMs: 1, learningTimeoutMs: 1000,
    fetch: async (url, init) => {
      const path = new URL(url).pathname, body = init.body ? JSON.parse(init.body) : undefined;
      requests.push({ path, method: init.method, body });
      if (path === '/v2/agents/backend-codex') return Response.json({ definition: { sdk: { runtime: 'codex-sdk' } } });
      if (path === '/v2/agents/backend-codex/sdk-runs') return Response.json({ run_id: 'sdk-run', agent_id: 'backend-codex',
        token: 'fixture-scoped-key', console_url: 'https://server.example/#/runs/sdk-run', learning: { enabled,
          revision: enabled ? 'approved-revision' : null, context: 'Start release reports with Ready or Blocked.',
          skills: [{ name: 'release-report', files: { 'SKILL.md': 'Keep the report to two sentences.' } }] } });
      if (path === '/v2/sdk-runs/sdk-run/events') return eventsError
        ? Response.json({ error: { code: 'unavailable' } }, { status: 503 }) : Response.json({ accepted: true });
      if (path === '/v2/sdk-runs/sdk-run/complete') return Response.json({ accepted: true });
      if (path === '/v2/sdk-runs/sdk-run') return Response.json({ run_id: 'sdk-run', state: 'completed',
        learning: enabled ? { state: 'merged' } : null });
      throw new Error(`Unexpected fixture route ${path}`);
    },
  } };
}

function native({ result, events = [], failure } = {}) {
  const calls = [], threads = [];
  const codex = {
    marker: 'native-client',
    startThread(options) {
      assert.equal(this, codex);
      let id = null;
      const thread = {
        get id() { return id; },
        options,
        closed: false,
        async run(input, turnOptions) {
          assert.equal(this, thread);
          calls.push({ method: 'run', input, turnOptions });
          if (failure) throw failure;
          id = 'native-thread';
          return result;
        },
        async runStreamed(input, turnOptions) {
          assert.equal(this, thread);
          calls.push({ method: 'runStreamed', input, turnOptions });
          return { events: (async function* () {
            try {
              for (const event of events) {
                if (event.type === 'thread.started') id = event.thread_id;
                yield event;
              }
              if (failure) throw failure;
            } finally { thread.closed = true; }
          })() };
        },
      };
      threads.push(thread);
      return thread;
    },
    resumeThread() { throw new Error('Native resume must not be called by learning wrapper.'); },
    otherMethod() { assert.equal(this, codex); return 'preserved'; },
  };
  return { codex, calls, threads };
}

const response = { items: [
  { id: 'reasoning-1', type: 'reasoning', text: 'private chain of thought' },
  { id: 'tool-1', type: 'command_execution', command: 'private command', aggregated_output: 'private output', status: 'completed' },
  { id: 'message-1', type: 'agent_message', text: 'Ready. Tests passed.' },
], finalResponse: 'Ready. Tests passed.', usage: { input_tokens: 20, cached_input_tokens: 8, cache_write_input_tokens: 4, output_tokens: 6 } };

test('Codex uses the original client and thread, preserves result identity and options, and pins approved context', async () => {
  const { config, requests } = service(), { codex, calls, threads } = native({ result: response });
  const wrapped = withCodexAgentLearning(codex, config);
  const options = { model: 'native-model', sandboxMode: 'read-only', workingDirectory: '/fixture-project', approvalPolicy: 'never' };
  const thread = wrapped.startThread(options), controller = new AbortController();
  const turnOptions = { signal: controller.signal, outputSchema: { type: 'object' } };
  const result = await thread.run('Report the release status.', turnOptions);
  await wrapped.flushLearning();
  assert.equal(result, response);
  assert.equal(thread.id, 'native-thread');
  assert.equal(threads[0].options, options);
  assert.equal(calls[0].turnOptions, turnOptions);
  assert.equal(calls.length, 1, 'reflection must not call the native SDK a second time');
  assert.equal(wrapped.otherMethod(), 'preserved');
  assert.match(calls[0].input, /Start release reports with Ready or Blocked/);
  assert.match(calls[0].input, /Keep the report to two sentences/);
  const start = requests.find(r => r.path.endsWith('/sdk-runs'));
  assert.equal(start.body.input, 'Report the release status.');
  assert.equal(start.body.instructions, config.instructions);
  assert.equal(start.body.model, 'native-model');
  assert.doesNotMatch(JSON.stringify(requests), /private chain of thought|private command|private output/);
  const toolEvents = requests.filter(r => r.path.endsWith('/events')).flatMap(r => r.body.events).filter(event => event.type === 'tool');
  assert.deepEqual(toolEvents, [
    { type: 'tool', id: 'tool-1', name: 'command_execution', status: 'started' },
    { type: 'tool', id: 'tool-1', name: 'command_execution', status: 'completed' },
  ], 'buffered results need a paired tool identity before their completion can render correctly');
  const complete = requests.find(r => r.path.endsWith('/complete')).body;
  assert.equal(complete.session_id, 'native-thread');
  assert.equal(complete.answer, response.finalResponse);
  assert.equal(complete.usage.input_tokens, 8, 'uncached input excludes reported cache reads and writes');
  assert.equal(complete.usage.cache_read_tokens, 8);
  assert.equal(complete.usage.cache_write_tokens, 4);
});

test('missing Codex cache counters leave exclusive input unknown rather than inventing zero', async () => {
  const { config, requests } = service();
  const { codex } = native({ result: { ...response, usage: { input_tokens: 20, output_tokens: 6 } } });
  const wrapped = withCodexAgentLearning(codex, config);
  await wrapped.startThread().run('Report status.');
  await wrapped.flushLearning();
  const usage = requests.find(r => r.path.endsWith('/complete')).body.usage;
  assert.equal(usage.input_tokens, null);
  assert.equal(usage.cache_read_tokens, null);
  assert.equal(usage.cache_write_tokens, null);
});

test('learning Off preserves input by identity, including multimodal native inputs', async () => {
  const { config, requests } = service({ enabled: false }), { codex, calls } = native({ result: response });
  const wrapped = withCodexAgentLearning(codex, config);
  const input = [{ type: 'text', text: 'Describe the release diagram.' }, { type: 'local_image', path: '/private/diagram.png' }];
  assert.equal(await wrapped.startThread().run(input), response);
  await wrapped.flushLearning();
  assert.equal(calls[0].input, input);
  assert.equal(requests.find(r => r.path.endsWith('/sdk-runs')).body.input, 'Describe the release diagram.');
  assert.doesNotMatch(JSON.stringify(requests), /private\/diagram/);
});

test('multimodal calls preserve native image objects but cannot learn from images the grader has not seen', async () => {
  const { config, requests } = service(), { codex, calls } = native({ result: response });
  const wrapped = withCodexAgentLearning(codex, config);
  const image = { type: 'local_image', path: '/private/diagram.png' };
  const input = [{ type: 'text', text: 'Describe the release diagram.' }, image];
  assert.equal(await wrapped.startThread().run(input), response);
  await assert.rejects(wrapped.flushLearning(), /Image inputs/);
  assert.equal(calls[0].input.at(-1), image);
  assert.doesNotMatch(JSON.stringify(requests), /private\/diagram/);
  assert.equal(requests.find(r => r.path.endsWith('/complete')).body.evidence_complete, false);
});

test('streaming defers all work until consumption and preserves event identity and ordering', async () => {
  const events = [{ type: 'thread.started', thread_id: 'stream-thread' },
    { type: 'item.completed', item: response.items[0] },
    { type: 'item.completed', item: response.items[2] }, { type: 'turn.completed', usage: response.usage }];
  const { config, requests } = service(), { codex, calls } = native({ events });
  const wrapped = withCodexAgentLearning(codex, config), thread = wrapped.startThread();
  const options = { signal: new AbortController().signal };
  const stream = await thread.runStreamed('Report status.', options);
  assert.equal(calls.length, 0);
  assert.equal(requests.length, 0);
  const observed = [];
  for await (const event of stream.events) observed.push(event);
  await wrapped.flushLearning();
  assert.deepEqual(observed, events);
  observed.forEach((event, index) => assert.equal(event, events[index]));
  assert.equal(calls[0].turnOptions, options);
  assert.equal(calls.length, 1);
  assert.doesNotMatch(JSON.stringify(requests), /private chain of thought/);
  assert.equal(requests.find(r => r.path.endsWith('/complete')).body.status, 'completed');
});

test('streamed tool evidence pairs native starts and completions once, retaining the tool identity', async () => {
  const command = response.items[1];
  const events = [
    { type: 'item.started', item: { ...command, status: 'in_progress' } },
    { type: 'item.updated', item: { ...command, status: 'in_progress' } },
    { type: 'item.started', item: { ...command, status: 'in_progress' } },
    { type: 'item.completed', item: command },
    { type: 'turn.completed', usage: response.usage },
  ];
  const { config, requests } = service(), { codex } = native({ events });
  const wrapped = withCodexAgentLearning(codex, config);
  const observed = [];
  for await (const event of (await wrapped.startThread().runStreamed('Report status.')).events) observed.push(event);
  await wrapped.flushLearning();
  observed.forEach((event, index) => assert.equal(event, events[index]));
  assert.deepEqual(requests.filter(r => r.path.endsWith('/events')).flatMap(r => r.body.events), [
    { type: 'tool', id: 'tool-1', name: 'command_execution', status: 'started' },
    { type: 'tool', id: 'tool-1', name: 'command_execution', status: 'completed' },
  ]);
});

test('breaking the consumer stream closes its native iterator and records cancellation', async () => {
  const { config, requests } = service(), { codex, threads } = native({ events: [
    { type: 'thread.started', thread_id: 'stream-thread' }, { type: 'turn.completed', usage: response.usage },
  ] });
  const wrapped = withCodexAgentLearning(codex, config);
  for await (const _ of (await wrapped.startThread().runStreamed('Report status.')).events) break;
  await wrapped.flushLearning();
  assert.equal(threads[0].closed, true);
  assert.equal(requests.find(r => r.path.endsWith('/complete')).body.status, 'cancelled');
});

test('original SDK errors survive persistence failures, while flush reports incomplete evidence', async () => {
  const failure = new Error('native failure');
  const failedServer = service(), failedNative = native({ failure });
  const failed = withCodexAgentLearning(failedNative.codex, failedServer.config);
  await assert.rejects(failed.startThread().run('Report status.'), error => error === failure);
  await failed.flushLearning();
  const outcome = failedServer.requests.find(r => r.path.endsWith('/complete')).body;
  assert.equal(outcome.status, 'failed');
  assert.equal(Object.hasOwn(outcome, 'session_id'), false);

  const { config, requests } = service({ eventsError: true }), { codex } = native({ result: response });
  const wrapped = withCodexAgentLearning(codex, config);
  assert.equal(await wrapped.startThread().run('Report status.'), response);
  await assert.rejects(wrapped.flushLearning(), /503/);
  const complete = requests.find(r => r.path.endsWith('/complete')).body;
  assert.equal(complete.status, 'completed');
  assert.equal(complete.evidence_complete, false);
});

test('resume and repeated thread runs are refused before model execution', async () => {
  const { config } = service(), { codex, calls } = native({ result: response });
  const wrapped = withCodexAgentLearning(codex, config), thread = wrapped.startThread();
  assert.throws(() => wrapped.resumeThread('old-thread'), /fresh/);
  await thread.run('Report status.');
  await assert.rejects(thread.run('Report again.'), /one task/);
  await wrapped.flushLearning();
  assert.equal(calls.length, 1);
});

test('native stream aborts retain the exact original error and record cancellation', async () => {
  const failure = new Error('native abort');
  const { config, requests } = service(), { codex } = native({ failure });
  const wrapped = withCodexAgentLearning(codex, config), controller = new AbortController();
  controller.abort();
  await assert.rejects(async () => {
    for await (const _ of (await wrapped.startThread().runStreamed('Report status.', { signal: controller.signal })).events) {}
  }, error => error === failure);
  await wrapped.flushLearning();
  assert.equal(requests.find(r => r.path.endsWith('/complete')).body.status, 'cancelled');
});

async function promptly(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Native delivery waited for the evidence destination.')), 1000);
    })]);
  } finally { clearTimeout(timer); }
}

test('a stalled evidence destination cannot block native stream events, abort errors or iterator cleanup', async () => {
  const { config, requests } = service(), fetch = config.fetch;
  let release;
  const stalled = new Promise(resolve => { release = resolve; });
  config.fetch = async (url, init) => {
    if (new URL(url).pathname.endsWith('/events')) {
      await stalled;
      return Response.json({ error: { code: 'unavailable' } }, { status: 503 });
    }
    return fetch(url, init);
  };
  const controller = new AbortController(), failure = new Error('original native abort');
  const first = { type: 'thread.started', thread_id: 'stream-thread' };
  let closed = false;
  const codex = { startThread: () => ({ id: null, async runStreamed(_input, options) {
    assert.equal(options.signal, controller.signal);
    return { events: (async function* () {
      try {
        yield first;
        options.signal.throwIfAborted();
        await new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
      } finally { closed = true; }
    })() };
  } }) };
  const wrapped = withCodexAgentLearning(codex, config);
  const { events } = await wrapped.startThread().runStreamed('Report status.', { signal: controller.signal });
  try {
    assert.equal((await promptly(events.next())).value, first);
    const next = events.next();
    controller.abort(failure);
    await assert.rejects(promptly(next), error => error === failure);
    assert.equal(closed, true);
    assert.equal(requests.some(r => r.path.endsWith('/complete')), false, 'completion waits for its evidence queue');
    release();
    await assert.rejects(wrapped.flushLearning(), /503/);
    const outcome = requests.find(r => r.path.endsWith('/complete')).body;
    assert.equal(outcome.status, 'cancelled');
    assert.equal(outcome.evidence_complete, false);
  } finally {
    release();
    controller.abort(failure);
    await events.return();
    await wrapped.flushLearning().catch(() => undefined);
  }
});

test('streamed evidence drains in order before completion without blocking native delivery', async () => {
  const { config, requests } = service(), fetch = config.fetch;
  let release;
  const stalled = new Promise(resolve => { release = resolve; });
  config.fetch = async (url, init) => {
    if (new URL(url).pathname.endsWith('/events') && JSON.parse(init.body).sequence === 1) await stalled;
    return fetch(url, init);
  };
  const events = [{ type: 'thread.started', thread_id: 'stream-thread' },
    { type: 'item.started', item: { ...response.items[1], status: 'in_progress' } },
    { type: 'item.completed', item: response.items[1] },
    { type: 'item.completed', item: response.items[2] }, { type: 'turn.completed', usage: response.usage }];
  const { codex, threads } = native({ events }), wrapped = withCodexAgentLearning(codex, config);
  const stream = (await wrapped.startThread().runStreamed('Report status.')).events;
  try {
    const observed = await promptly((async () => { const result = []; for await (const event of stream) result.push(event); return result; })());
    observed.forEach((event, index) => assert.equal(event, events[index]));
    assert.equal(observed.length, events.length);
    assert.equal(threads[0].closed, true);
    assert.equal(requests.some(r => r.path.endsWith('/complete')), false);
    release();
    await wrapped.flushLearning();
    assert.deepEqual(requests.filter(r => r.path.endsWith('/events')).map(r => r.body.sequence), [1, 2, 3, 4]);
    assert.equal(requests.find(r => r.path.endsWith('/complete')).body.status, 'completed');
    assert.equal(requests.at(-2).path, '/v2/sdk-runs/sdk-run/complete');
  } finally {
    release();
    await stream.return();
    await wrapped.flushLearning().catch(() => undefined);
  }
});
