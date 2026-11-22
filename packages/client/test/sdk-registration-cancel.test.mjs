import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { withClaudeAgentLearning } from '../dist/claude.js';
import { withCodexAgentLearning } from '../dist/codex.js';

function service(kind, stage, fails = false) {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const requests = [];
  let held = false, sequence = 0;
  const config = {
    agentId: 'backend', instructions: 'Report the release status.', learning: false,
    baseUrl: 'https://server.example/v2', apiKey: 'fake-test-key', maxRetries: 0,
    timeoutMs: 1000, pollIntervalMs: 1, learningTimeoutMs: 1000,
    fetch: async (url, init) => {
      const path = new URL(url).pathname, body = init.body ? JSON.parse(init.body) : undefined;
      requests.push({ path, body });
      if (!held && path === (stage === 'registration' ? '/v2/agents/backend' : '/v2/agents/backend/sdk-runs')) {
        held = true;
        entered.resolve();
        await release.promise;
        if (fails) return Response.json({ error: { code: 'registration_refused' } }, { status: 503 });
      }
      if (path === '/v2/agents/backend') return Response.json({ definition: { sdk: { runtime: kind === 'claude' ? 'claude-agent-sdk' : 'codex-sdk' } } });
      if (path === '/v2/agents/backend/sdk-runs') {
        const run = `sdk-${++sequence}`;
        return Response.json({ run_id: run, agent_id: 'backend', token: 'fake-scoped-key',
          console_url: `https://server.example/#/runs/${run}`,
          learning: { enabled: false, revision: null, context: '' } });
      }
      if (path.endsWith('/complete') || path.endsWith('/events')) return Response.json({ accepted: true });
      return Response.json({ run_id: path.split('/').at(-1), state: 'completed' });
    },
  };
  return { config, requests, entered: entered.promise, release: () => release.resolve() };
}

function wrapper(kind, config) {
  let calls = 0;
  if (kind === 'claude') {
    const wrapped = withClaudeAgentLearning(() => {
      calls++;
      return (async function* () { yield { type: 'result', subtype: 'success', is_error: false, result: 'Ready.' }; })();
    }, config);
    return { calls: () => calls, flush: () => wrapped.flushLearning(),
      query: controller => wrapped({ prompt: 'Check release.', options: { abortController: controller } }),
      run: async controller => { for await (const _ of wrapped({ prompt: 'Check release.', options: { abortController: controller } })) {} },
    };
  }
  const wrapped = withCodexAgentLearning({ startThread() { return {
    id: null,
    async run() { calls++; return { finalResponse: 'Ready.', items: [] }; },
    async runStreamed() { calls++; return { events: (async function* () { yield { type: 'turn.completed' }; })() }; },
  }; } }, config);
  return { calls: () => calls, flush: () => wrapped.flushLearning(),
    run: async controller => {
      const thread = wrapped.startThread();
      if (kind === 'codex') return thread.run('Check release.', { signal: controller.signal });
      const { events } = await thread.runStreamed('Check release.', { signal: controller.signal });
      for await (const _ of events) {}
    },
  };
}

for (const kind of ['claude', 'codex', 'codex-stream']) {
  for (const stage of ['registration', 'receipt']) {
    for (const fails of [false, true]) {
      test(`${kind}: abort releases a stalled ${stage} before its later ${fails ? 'refusal' : 'answer'}`, async () => {
        const server = service(kind, stage, fails), app = wrapper(kind, server.config);
        const controller = new AbortController(), reason = new Error('Original application cancellation');
        const outcome = app.run(controller).then(value => ({ value }), error => ({ error }));
        await server.entered;
        controller.abort(reason);
        try {
          assert.deepEqual(await Promise.race([outcome, setImmediate().then(() => 'still blocked')]), { error: reason });
          assert.equal(app.calls(), 0, 'aborting before admission must never invoke native work');
          let flushed = false;
          const flush = app.flush().then(() => { flushed = true; return null; }, error => error);
          if (stage === 'receipt') {
            await setImmediate();
            assert.equal(flushed, false, 'flush must wait for the late receipt and its cancellation');
          }
          server.release();
          const error = await flush;
          if (stage === 'receipt' && fails) assert.match(error?.message ?? '', /registration_refused/);
          else assert.equal(error, null);
          await setImmediate();
          assert.deepEqual(await outcome, { error: reason }, 'a later service refusal cannot replace the original abort');
          assert.equal(app.calls(), 0);
          const starts = server.requests.filter(request => request.path.endsWith('/sdk-runs'));
          const completions = server.requests.filter(request => request.path.endsWith('/complete'));
          assert.equal(starts.length, stage === 'receipt' ? 1 : 0);
          assert.equal(completions.length, stage === 'receipt' && !fails ? 1 : 0);
          if (completions.length) assert.equal(completions[0].body.status, 'cancelled');
        } finally {
          server.release();
          await outcome;
          await app.flush().catch(() => undefined);
        }
      });
    }
  }

  test(`${kind}: cancelling one caller leaves another caller's shared registration usable`, async () => {
    const server = service(kind, 'registration'), app = wrapper(kind, server.config);
    const first = new AbortController(), second = new AbortController(), reason = new Error('Only the first caller stopped');
    const stopped = app.run(first).then(value => ({ value }), error => ({ error }));
    await server.entered;
    const continuing = app.run(second);
    first.abort(reason);
    try {
      assert.deepEqual(await Promise.race([stopped, setImmediate().then(() => 'still blocked')]), { error: reason });
      server.release();
      await continuing;
      await app.flush();
      assert.equal(app.calls(), 1);
      assert.equal(server.requests.filter(request => request.path === '/v2/agents/backend').length, 1);
      assert.equal(server.requests.filter(request => request.path.endsWith('/sdk-runs')).length, 1);
      assert.equal(server.requests.find(request => request.path.endsWith('/complete')).body.status, 'completed');
    } finally {
      server.release();
      await stopped;
      await continuing;
      await app.flush();
    }
  });

  test(`${kind}: an already aborted task makes no registration or native request`, async () => {
    const server = service(kind, 'receipt'), app = wrapper(kind, server.config);
    const controller = new AbortController(), reason = { message: 'Original non-Error abort reason' };
    controller.abort(reason);
    const outcome = app.run(controller).then(value => ({ value }), error => ({ error }));
    try {
      assert.deepEqual(await Promise.race([outcome, setImmediate().then(() => 'still blocked')]), { error: reason });
      await app.flush();
      assert.equal(app.calls(), 0);
      assert.equal(server.requests.length, 0);
    } finally {
      server.release();
      await outcome;
      await app.flush().catch(() => undefined);
    }
  });
}

test('closing a Claude query releases its pending iteration and closes a late receipt', async () => {
  const server = service('claude', 'receipt'), app = wrapper('claude', server.config);
  const query = app.query(new AbortController());
  const next = query.next().then(value => ({ value }), error => ({ error }));
  await server.entered;
  query.close();
  try {
    const outcome = await Promise.race([next, setImmediate().then(() => 'still blocked')]);
    assert.equal(outcome.error?.name, 'AbortError');
    server.release();
    await app.flush();
    assert.equal(app.calls(), 0);
    assert.equal(server.requests.find(request => request.path.endsWith('/complete')).body.status, 'cancelled');
  } finally {
    server.release();
    await next;
    await app.flush().catch(() => undefined);
  }
});
