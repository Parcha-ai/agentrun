import assert from 'node:assert/strict';
import { test } from 'node:test';
import { beginTurn, learningInstructions, submitTurn } from '../dist/extension/lib/lifecycle.mjs';

function service() {
  const requests = [], runs = new Map();
  let registered = false, failAfterCommit = false, revision = 'accepted-one', enabled = true;
  const fetch = async (url, options) => {
    const path = new URL(url).pathname, body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ path, method: options.method, headers: options.headers, body });
    const answer = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/v2/agents/eve-support' && options.method === 'GET') return registered
      ? answer({ definition: { id: 'eve-support', sdk: { runtime: 'eve' } } })
      : answer({ error: { code: 'not_found', message: 'missing' } }, 404);
    if (path === '/v2/agents' && options.method === 'POST') { registered = true; return answer({}); }
    if (path === '/v2/agents/eve-support/sdk-runs') {
      const key = options.headers['Idempotency-Key'];
      if (!runs.has(key)) runs.set(key, { run_id: `run-${runs.size + 1}`, agent_id: 'eve-support', token: 'scoped-private-token',
        console_url: 'https://console.example/#/runs/one', learning: { enabled, revision, context: 'Use a release brief.', skills: [] } });
      if (failAfterCommit) { failAfterCommit = false; throw new Error('connection lost'); }
      return answer(runs.get(key));
    }
    throw new Error(`Unexpected request ${options.method} ${path}`);
  };
  return { fetch, requests, runs, failNext: () => { failAfterCommit = true; }, advance: () => { revision = 'accepted-two'; enabled = false; } };
}
const source = { sessionId: 'session-one', turnId: 'turn-one', input: 'Check this release.', model: 'original-model', startIndex: 0, complete: true };
const config = fetch => ({ baseUrl: 'https://agentrun.example/v2', apiKey: 'fake-test-key', agentId: 'eve-support', instructions: 'Keep existing tool permissions.', learning: true, fetch, maxRetries: 0 });

test('retry after a lost admission response keeps one run and its original learning revision', async () => {
  const server = service(); server.failNext();
  await assert.rejects(beginTurn(config(server.fetch), source));
  server.advance();
  const restored = await beginTurn(config(server.fetch), source);
  assert.equal(server.runs.size, 1);
  assert.equal(restored.receipt.learning.revision, 'accepted-one');
  assert.equal(restored.receipt.learning.enabled, true);
  assert.match(learningInstructions(restored), /release brief/);
  const next = await beginTurn(config(server.fetch), { ...source, turnId: 'turn-two' });
  assert.equal(server.runs.size, 2);
  assert.equal(next.receipt.learning.enabled, false);
  assert.equal(learningInstructions(next), '');
  assert.equal(server.requests.filter(row => row.path === '/v2/agents').length, 1);
});

test('different sessions do not share receipts, and an existing agent setting is never patched', async () => {
  const server = service();
  const first = await beginTurn(config(server.fetch), source);
  const second = await beginTurn(config(server.fetch), { ...source, sessionId: 'session-two' });
  assert.notEqual(first.receipt.run_id, second.receipt.run_id);
  assert.equal(server.requests.some(row => row.method === 'PUT' || row.method === 'PATCH'), false);
  const registration = server.requests.find(row => row.path === '/v2/agents').body.definition;
  assert.equal(registration.learning, 'notes');
  assert.deepEqual(registration.sdk, { runtime: 'eve' });
  assert.equal(registration.instructions, 'Keep existing tool permissions.');
});

test('Learning Off never renders a supplied skill or context', () => {
  const record = { receipt: { learning: { enabled: false, revision: 'old', context: 'old note', skills: [{ name: 'old', files: { 'SKILL.md': 'old skill' } }] } } };
  assert.equal(learningInstructions(record), '');
});

test('source requires actual task identity before admission', async () => {
  const server = service();
  await assert.rejects(beginTurn(config(server.fetch), { ...source, turnId: '' }), /turn id/);
  assert.equal(server.requests.length, 0);
});

function completedReader(text = 'The original answer.') {
  const turnId = source.turnId;
  const facts = [
    ['session.started', {}],
    ['turn.started', { turnId, follows: null, cause: { deliveryId: 'input' } }],
    ['delivery.consumed', { turnId, deliveryId: 'input', parts: [{ kind: 'text', text: source.input }] }],
    ['model.requested', { runId: 'model', owner: { turnId } }],
    ['model.started', { runId: 'model', modelId: 'original-model', attempt: 0 }],
    ['content.completed', { partId: 'answer', runId: 'model', kind: 'text', phase: 'reply', value: text }],
    ['model.settled', { runId: 'model', outcome: 'completed' }],
    ['turn.settled', { turnId, outcome: 'completed', reply: ['answer'] }],
  ];
  return { id: source.sessionId, async *stream() {
    for (const [line, [type, data]] of facts.entries()) yield {
      type, data, scope: { turnId }, meta: { at: '2026-01-01T00:00:00.000Z', position: { line, index: 0 }, endOfLine: true },
    };
  } };
}

test('lost completion response retries identical evidence and outcome with scoped credentials only', async () => {
  const server = service(), writes = new Map();
  let loseCompletion = true, attempts = 0;
  const fetch = async (url, options) => {
    const path = new URL(url).pathname;
    if (!path.startsWith('/v2/sdk-runs/')) return server.fetch(url, options);
    assert.equal(new Headers(options.headers).get('authorization'), 'Bearer scoped-private-token');
    const key = options.headers['Idempotency-Key'];
    if (writes.has(key)) assert.equal(writes.get(key), options.body);
    else writes.set(key, options.body);
    assert.doesNotMatch(options.body, /fake-test-key|scoped-private-token/);
    if (path.endsWith('/complete')) {
      attempts++;
      if (loseCompletion) { loseCompletion = false; throw new Error('lost after commit'); }
    }
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  };
  const settings = config(fetch), record = await beginTurn(settings, source);
  const reader = completedReader('The result includes fake-test-key and scoped-private-token.');
  await assert.rejects(submitTurn(settings, record, reader));
  assert.equal(await submitTurn(settings, structuredClone(record), reader), true);
  assert.equal(server.runs.size, 1);
  assert.equal(attempts, 2);
  assert.equal(writes.size, 2);
  const completion = JSON.parse(writes.get(`${record.receipt.run_id}:eve:complete`));
  assert.equal(completion.status, 'completed');
  assert.equal(completion.answer, 'The result includes [withheld] and [withheld].');
});

test('unavailable history never invents a terminal outcome or self-improvement evidence', async () => {
  const server = service(), settings = config(server.fetch), record = await beginTurn(settings, source);
  const before = server.requests.length;
  const reader = { id: source.sessionId, stream() { throw new Error('unavailable'); } };
  assert.equal(await submitTurn(settings, record, reader), false);
  assert.equal(server.requests.length, before);
});

test('a receipt cannot upload to a changed server or another agent/session', async () => {
  const server = service(), settings = config(server.fetch), record = await beginTurn(settings, source);
  const before = server.requests.length;
  await assert.rejects(submitTurn({ ...settings, baseUrl: 'https://another.example/v2' }, record, completedReader()), /another server/);
  await assert.rejects(submitTurn({ ...settings, agentId: 'another-agent' }, record, completedReader()), /another server/);
  await assert.rejects(submitTurn(settings, record, { ...completedReader(), id: 'other-session' }), /another server/);
  assert.equal(server.requests.length, before);
});
