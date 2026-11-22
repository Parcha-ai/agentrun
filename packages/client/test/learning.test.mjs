import assert from 'node:assert/strict';
import test from 'node:test';
import { BackendLearningClient, renderLearningContext } from '../dist/learning.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function service(options = {}) {
  const requests = [];
  let exists = options.exists ?? true;
  let polls = 0;
  const fetch = async (url, init) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ path, method: init.method, headers: init.headers, body });
    if (path === '/v2/agents/backend' && init.method === 'GET') return exists
      ? json({ agent_id: 'backend', definition: { sdk: { runtime: options.runtime ?? 'codex-sdk', ...(options.platform !== undefined ? { platform: options.platform } : {}) }, learning: false } })
      : json({ error: { code: 'not_found' } }, 404);
    if (path === '/v2/agents' && init.method === 'POST') { exists = true; return json({ agent_id: 'backend' }, 201); }
    if (path === '/v2/agents/backend/sdk-runs') return options.startError
      ? json({ error: { code: 'agent_not_runnable' } }, 422)
      : json({ run_id: 'sdk-run', agent_id: 'backend', token: 'scoped-token', console_url: 'https://console.example/#/runs/sdk-run', learning: { enabled: options.enabled ?? false, revision: 'seed-revision', context: '- Read the lookup first.' } });
    if (path === '/v2/sdk-runs/sdk-run/events') return options.eventsError
      ? json({ error: { code: 'unavailable' } }, 503)
      : json({ accepted: true });
    if (path === '/v2/sdk-runs/sdk-run/complete') return json({ accepted: true });
    if (path === '/v2/sdk-runs/sdk-run') {
      polls++;
      return json(options.status?.(polls) ?? { run_id: 'sdk-run', state: 'completed', learning: options.enabled ? { state: 'merged', reason: null } : null });
    }
    throw new Error(`Unexpected route ${init.method} ${path}`);
  };
  return { requests, config: { baseUrl: 'https://server.example/v2', apiKey: 'fake-test-key', agentId: 'backend', fetch, maxRetries: 0, pollIntervalMs: 1, learningTimeoutMs: 1000 } };
}
const begin = (client) => client.begin({ runtime: 'codex-sdk', input: 'Original task', instructions: 'Backend policy', model: 'test-model' });

test('registers only missing agents with explicit opt-in; leaves existing owner toggle alone', async () => {
  const server = service({ exists: false });
  const client = new BackendLearningClient({ ...server.config, learning: true });
  await begin(client);
  await begin(client);
  const creations = server.requests.filter(r => r.path === '/v2/agents');
  assert.equal(creations.length, 1);
  assert.deepEqual(creations[0].body, { definition: { id: 'backend', name: 'backend', instructions: 'Backend policy', sdk: { runtime: 'codex-sdk' }, learning: true } });
  assert.equal(server.requests.some(r => r.method === 'PUT' || r.method === 'PATCH'), false);
  const defaults = service({ exists: false });
  await begin(new BackendLearningClient(defaults.config));
  assert.equal(defaults.requests.find(r => r.path === '/v2/agents').body.definition.learning, false);
});

test('runtime mismatch or refused start is visible before the SDK could run', async () => {
  const wrong = service({ runtime: 'claude-agent-sdk' });
  await assert.rejects(begin(new BackendLearningClient(wrong.config)), /runtime/);
  assert.equal(wrong.requests.length, 1);
  const refused = service({ startError: true });
  await assert.rejects(begin(new BackendLearningClient(refused.config)), /agent_not_runnable/);
});

test('sends original source separately, uses only scoped run credentials, and serializes immutable evidence', async () => {
  const server = service();
  const client = new BackendLearningClient(server.config);
  const session = await begin(client);
  const event = { type: 'text', text: 'Original observation' };
  const first = session.event(event);
  event.text = 'Changed after enqueue';
  const second = session.event({ type: 'tool', id: 'call-1', name: 'lookup', status: 'completed' });
  client.track(session.complete({ status: 'completed', answer: 'Original result', usage: { input_tokens: 10 } }));
  await Promise.all([first, second, client.flushLearning()]);
  const start = server.requests.find(r => r.path.endsWith('/sdk-runs'));
  assert.equal(start.headers.authorization, 'Bearer fake-test-key');
  assert.ok(start.headers['Idempotency-Key']);
  assert.deepEqual(start.body, { runtime: 'codex-sdk', input: 'Original task', instructions: 'Backend policy', model: 'test-model' });
  const runRequests = server.requests.filter(r => r.path.startsWith('/v2/sdk-runs/'));
  assert.ok(runRequests.every(r => r.headers.authorization === 'Bearer scoped-token'));
  assert.deepEqual(runRequests.filter(r => r.path.endsWith('/events')).map(r => r.body.sequence), [1, 2]);
  assert.equal(runRequests[0].body.events[0].text, 'Original observation');
  const complete = runRequests.find(r => r.path.endsWith('/complete'));
  assert.equal(complete.body.answer, 'Original result');
  assert.equal(complete.body.usage.output_tokens, null);
  assert.equal(runRequests.indexOf(complete), 2);
  await assert.rejects(session.event({ type: 'text', text: 'Too late' }), /after completion/);
});

test('flush waits for the run\'s learning to close after SDK execution completes', async () => {
  const server = service({ enabled: true, status: n => ({ run_id: 'sdk-run', state: 'completed', learning: { state: n < 3 ? 'reflecting' : 'merged', reason: null } }) });
  const client = new BackendLearningClient(server.config);
  const session = await begin(client);
  client.track(session.complete({ status: 'completed', answer: 'Done' }));
  await client.flushLearning();
  assert.equal(server.requests.filter(r => r.path === '/v2/sdk-runs/sdk-run').length, 3);
});

test('failed evidence disables reflection without changing successful SDK task status', async () => {
  const server = service({ eventsError: true });
  const client = new BackendLearningClient(server.config);
  const session = await begin(client);
  await assert.rejects(session.event({ type: 'text', text: 'Observation' }));
  client.track(session.complete({ status: 'completed', answer: 'SDK succeeded' }));
  await assert.rejects(client.flushLearning(), /503/);
  const completion = server.requests.find(r => r.path.endsWith('/complete'));
  assert.equal(completion.body.status, 'completed');
  assert.equal(completion.body.answer, 'SDK succeeded');
  assert.equal(completion.body.evidence_complete, false);
});

test('oversized evidence is refused, never silently truncated or learned from', async () => {
  const server = service();
  const client = new BackendLearningClient(server.config);
  const session = await begin(client);
  await assert.rejects(session.event({ type: 'text', text: 'x'.repeat(128_001) }), /evidence/);
  client.track(session.complete({ status: 'completed', answer: 'Done' }));
  await assert.rejects(client.flushLearning(), /evidence/);
  assert.equal(server.requests.some(r => r.path.endsWith('/events')), false);
  assert.equal(server.requests.find(r => r.path.endsWith('/complete')).body.evidence_complete, false);
});

test('an oversized result preserves successful task status with an explicit placeholder and skips learning', async () => {
  const server = service();
  const client = new BackendLearningClient(server.config);
  const session = await begin(client);
  client.track(session.complete({ status: 'completed', answer: 'x'.repeat(128_001) }));
  await assert.rejects(client.flushLearning(), /answer.*limit/);
  const completion = server.requests.find(r => r.path.endsWith('/complete'));
  assert.equal(completion.body.status, 'completed');
  assert.equal(completion.body.evidence_complete, false);
  assert.match(completion.body.answer, /not stored/);
  assert.ok(completion.body.answer.length < 500);
});

test('learning failures and timeouts surface through flush, while legitimate rejected proposals do not', async () => {
  for (const reason of ['reflect_failed', 'checker']) {
    const server = service({ enabled: true, status: () => ({ run_id: 'sdk-run', state: 'completed', learning: { state: 'dropped', reason } }) });
    const client = new BackendLearningClient(server.config);
    client.track((await begin(client)).complete({ status: 'completed', answer: 'Done' }));
    if (reason === 'reflect_failed') await assert.rejects(client.flushLearning(), /reflect_failed/);
    else await client.flushLearning();
  }
  const server = service({ status: () => ({ run_id: 'sdk-run', state: 'processing' }) });
  const client = new BackendLearningClient({ ...server.config, learningTimeoutMs: 5 });
  client.track((await begin(client)).complete({ status: 'completed', answer: 'Done' }));
  await assert.rejects(client.flushLearning(), /within/);
  assert.equal(server.requests.filter(r => r.path.endsWith('/complete')).length, 1);
});

test('context rendering includes the corrections and workflow context only when self-improving is enabled', () => {
  const snapshot = { learningEnabled: true, revision: 'rev', context: '- Keep the report short.', workflowContext: 'Workflow release-status is bound.' };
  const text = renderLearningContext(snapshot);
  assert.match(text, /Keep the report short/);
  assert.match(text, /Workflow release-status is bound/);
  assert.equal(renderLearningContext({ ...snapshot, learningEnabled: false }), '');
  assert.equal(renderLearningContext({ ...snapshot, context: '', workflowContext: '' }), '', 'nothing learned: no context');
});

for (const platform of ['openclaw', 'capy', '自分の agent 🦀', '🦀'.repeat(80)]) test(`${platform} is an external source: registered and started with its platform label`, async () => {
  const server = service({ exists: false, runtime: 'external', platform });
  const client = new BackendLearningClient(server.config);
  const session = await client.begin({ runtime: 'external', platform, input: 'Overnight job', instructions: 'Platform policy' });
  const creation = server.requests.find(r => r.path === '/v2/agents');
  assert.deepEqual(creation.body.definition.sdk, { runtime: 'external', platform });
  const start = server.requests.find(r => r.path === '/v2/agents/backend/sdk-runs');
  assert.deepEqual(start.body, { runtime: 'external', platform, input: 'Overnight job', instructions: 'Platform policy' });
  const checkpoint = session.checkpoint();
  assert.equal(checkpoint.source.platform, platform);
  const restored = new BackendLearningClient(server.config).resume(checkpoint);
  assert.deepEqual(restored.checkpoint().source, checkpoint.source);
});

test('an unknown backend runtime is refused before any request', async () => {
  const server = service();
  await assert.rejects(new BackendLearningClient(server.config).begin({ runtime: 'shell', input: 'x', instructions: 'y' }), /Unsupported backend SDK runtime/);
  assert.equal(server.requests.length, 0);
});

for (const platform of ['openclaw', 'capy', 'codex-sdk']) test(`${platform} with a workflow bridge is refused before any request`, async () => {
  const server = service({ runtime: 'external', platform });
  const workflows = { catalog: [], adapters: [] };
  await assert.rejects(new BackendLearningClient({ ...server.config, workflows }).begin({ runtime: 'external', platform, input: 'x', instructions: 'y' }), /workflow bridge/);
  assert.equal(server.requests.length, 0);
});

test('invalid external platform labels fail before any request', async () => {
  for (const platform of [undefined, null, 12, '', ' ', ' capy', 'capy ', 'x'.repeat(81), '🦀'.repeat(81), 'capy\njob', 'capy\u0000job', 'capy\u007fjob', 'capy\u0085job', '\ud800', '\udc00']) {
    const server = service({ runtime: 'external', platform });
    await assert.rejects(new BackendLearningClient(server.config).begin({ runtime: 'external', platform, input: 'x', instructions: 'y' }), /platform/);
    assert.equal(server.requests.length, 0);
  }
});

test('SDK runtimes refuse platform labels and platform names are not runtime values', async () => {
  for (const runtime of ['claude-agent-sdk', 'codex-sdk', 'eve']) {
    const server = service({ runtime });
    await assert.rejects(new BackendLearningClient(server.config).begin({ runtime, platform: 'capy', input: 'x', instructions: 'y' }), /platform/);
    assert.equal(server.requests.length, 0);
  }
  for (const runtime of ['openclaw', 'capy']) {
    const server = service({ runtime });
    await assert.rejects(new BackendLearningClient(server.config).begin({ runtime, input: 'x', instructions: 'y' }), /Unsupported backend SDK runtime/);
    assert.equal(server.requests.length, 0);
  }
});

test('an existing agent with another platform is refused before starting a run', async () => {
  const server = service({ runtime: 'external', platform: 'openclaw' });
  await assert.rejects(new BackendLearningClient(server.config).begin({ runtime: 'external', platform: 'capy', input: 'x', instructions: 'y' }), /platform/);
  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].method, 'GET');
});

test('cached registration and restored receipts cannot switch external platform', async () => {
  const server = service({ runtime: 'external', platform: 'capy' });
  const client = new BackendLearningClient(server.config);
  const session = await client.begin({ runtime: 'external', platform: 'capy', input: 'x', instructions: 'y' });
  const count = server.requests.length;
  await assert.rejects(client.begin({ runtime: 'external', platform: 'openclaw', input: 'x', instructions: 'y' }), /platform/);
  const checkpoint = session.checkpoint();
  assert.throws(() => client.resume({ ...checkpoint, source: { ...checkpoint.source, platform: 'openclaw' } }), /platform/);
  const restored = new BackendLearningClient(server.config);
  restored.resume(checkpoint);
  await assert.rejects(restored.begin({ runtime: 'external', platform: 'openclaw', input: 'x', instructions: 'y' }), /platform/);
  assert.equal(server.requests.length, count, 'changing the platform sends no new request');
});

test('restoring external receipts validates the label and refuses workflow bridges', async () => {
  const server = service({ runtime: 'external', platform: 'capy' });
  const session = await new BackendLearningClient(server.config).begin({ runtime: 'external', platform: 'capy', input: 'x', instructions: 'y' });
  const checkpoint = session.checkpoint();
  const count = server.requests.length;
  for (const platform of [undefined, '', '\ud800', ' capy'])
    assert.throws(() => new BackendLearningClient(server.config).resume({ ...checkpoint, source: { ...checkpoint.source, platform } }), /platform/);
  assert.throws(() => new BackendLearningClient({ ...server.config, workflows: { catalog: [], adapters: [] } }).resume(checkpoint), /workflow bridge/);
  assert.equal(server.requests.length, count);
});

test('eve retains its explicit workflow bridge support', async () => {
  const server = service({ runtime: 'eve' });
  const workflows = { catalog: [], adapters: [], bind: () => ({ context: '', close() {} }) };
  await new BackendLearningClient({ ...server.config, workflows }).begin({ runtime: 'eve', input: 'x', instructions: 'y' });
  const start = server.requests.find(r => r.path.endsWith('/sdk-runs'));
  assert.deepEqual(start.body.workflow_tools, []);
});
