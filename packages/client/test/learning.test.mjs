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
      ? json({ agent_id: 'backend', definition: { sdk: { runtime: options.runtime ?? 'codex-sdk' }, learning: false } })
      : json({ error: { code: 'not_found' } }, 404);
    if (path === '/v2/agents' && init.method === 'POST') { exists = true; return json({ agent_id: 'backend' }, 201); }
    if (path === '/v2/agents/backend/sdk-runs') return options.startError
      ? json({ error: { code: 'agent_not_runnable' } }, 422)
      : json({ run_id: 'sdk-run', agent_id: 'backend', token: 'scoped-token', console_url: 'https://console.example/#/runs/sdk-run', learning: { enabled: options.enabled ?? false, revision: 'seed-revision', context: 'Approved note.', skills: [{ name: 'lookup', files: { 'SKILL.md': 'Read the lookup first.' } }] } });
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
  assert.deepEqual(creations[0].body, { definition: { id: 'backend', name: 'backend', instructions: 'Backend policy', sdk: { runtime: 'codex-sdk' }, learning: 'notes' } });
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

test('flush waits for the independent learning verdict after SDK execution completes', async () => {
  const server = service({ enabled: true, status: n => ({ run_id: 'sdk-run', state: 'completed', learning: { state: n < 3 ? 'proposed' : 'merged', reason: null } }) });
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
  for (const reason of ['grade_failed', 'checker']) {
    const server = service({ enabled: true, status: () => ({ run_id: 'sdk-run', state: 'completed', learning: { state: 'dropped', reason } }) });
    const client = new BackendLearningClient(server.config);
    client.track((await begin(client)).complete({ status: 'completed', answer: 'Done' }));
    if (reason === 'grade_failed') await assert.rejects(client.flushLearning(), /grade_failed/);
    else await client.flushLearning();
  }
  const server = service({ status: () => ({ run_id: 'sdk-run', state: 'processing' }) });
  const client = new BackendLearningClient({ ...server.config, learningTimeoutMs: 5 });
  client.track((await begin(client)).complete({ status: 'completed', answer: 'Done' }));
  await assert.rejects(client.flushLearning(), /within/);
  assert.equal(server.requests.filter(r => r.path.endsWith('/complete')).length, 1);
});

test('context rendering includes accepted skills only when self-improving is enabled', () => {
  const snapshot = { learningEnabled: true, revision: 'rev', context: 'Accepted note', skills: [{ name: 'lookup', files: { 'SKILL.md': 'Use lookup', 'references/schema.txt': 'Schema' } }] };
  const text = renderLearningContext(snapshot);
  assert.match(text, /Accepted note/);
  assert.match(text, /Use lookup/);
  assert.match(text, /references\/schema.txt/);
  assert.equal(renderLearningContext({ ...snapshot, learningEnabled: false }), '');
});
