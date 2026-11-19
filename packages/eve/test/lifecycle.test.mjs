import assert from 'node:assert/strict';
import { test } from 'node:test';
import { beginTurn, learningInstructions, submitTurn } from '../dist/extension/lib/lifecycle.mjs';

function service({ definition, check } = {}) {
  const requests = [], runs = new Map();
  let registered = Boolean(definition), failAfterCommit = false, revision = 'accepted-one', enabled = true;
  const fetch = async (url, options) => {
    const path = new URL(url).pathname, body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ path, method: options.method, headers: options.headers, body });
    const answer = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/v2/agents/eve-support' && options.method === 'GET') return registered
      ? answer({ definition })
      : answer({ error: { code: 'not_found', message: 'missing' } }, 404);
    if (path === '/v2/agents' && options.method === 'POST') { registered = true; definition = body.definition; return answer({}); }
    if (path === '/v2/agents/eve-support/sdk-runs') {
      const key = options.headers['Idempotency-Key'];
      if (!runs.has(key)) runs.set(key, { run_id: `run-${runs.size + 1}`, agent_id: 'eve-support', token: 'scoped-private-token',
        console_url: 'https://console.example/#/runs/one', learning: { enabled, revision, context: 'Use a release brief.', ...(check ? { check } : {}) } });
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
  assert.equal(registration.learning, true);
  assert.deepEqual(registration.sdk, { runtime: 'eve' });
  assert.equal(registration.instructions, 'Keep existing tool permissions.');
});

test('new agents keep configured loop numbers with or without workflow bindings; existing settings remain unchanged', async () => {
  const workflows = { engine: { inspectWorkflow() {}, runWorkflow() {}, resolveSchemaForWorkflow() {} }, policy: () => 'allow',
    tools: [{ name: 'mcp:release/status', nativeName: 'release_status', description: 'Read release status.',
      input_schema: { type: 'object' }, permission: 'allow', readOnly: true, async execute() {} }] };
  const learning = { compile_after: 5, agree_min: 0.9, alone_min: 0.7 };
  for (const bindings of [workflows, undefined]) {
    const server = service();
    await beginTurn({ ...config(server.fetch), learning, workflows: bindings }, source);
    const registration = server.requests.find(row => row.path === '/v2/agents').body.definition;
    assert.deepEqual(registration.learning, learning);
  }
  for (const existing of [false, true, { compile_after: 40, agree_min: 0.95 }]) {
    const server = service({ definition: { id: 'eve-support', sdk: { runtime: 'eve' }, learning: existing } });
    await beginTurn({ ...config(server.fetch), learning, workflows }, source);
    assert.equal(server.requests.some(row => row.path === '/v2/agents' || row.method === 'PUT' || row.method === 'PATCH'), false,
      'A mount must never replace the owner setting with its initial-registration defaults.');
    assert.deepEqual(server.requests.find(row => row.path.endsWith('/sdk-runs')).body.workflow_tools.map(tool => tool.name), ['mcp:release/status']);
  }
});

test('Learning Off never renders owner corrections', () => {
  const record = { receipt: { learning: { enabled: false, revision: 'old', context: 'Existing owner correction.' } } };
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
  const completion = JSON.parse(writes.get(`${record.receipt.run_id}:complete`));
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


for (const [label, raw, answer] of [
  ['object', { brief: 'The original answer.' }, 'The original answer.'],
  ['JSON-looking string', '42', '42'],
  ['business content', { name: 'raw', content: [{ type: 'text', text: '42' }] }, '{"name":"raw","content":[{"type":"text","text":"42"}]}'],
  ['business structuredContent', { name: 'raw', structuredContent: { name: 'inner' } }, '{"name":"raw","structuredContent":{"name":"inner"}}'],
]) test(`Eve preserves ${label} in its private shadow and persists the result before upload`, async () => {
  const engine = await import('@parcha/agentrun-dsl');
  const schema = { type: 'object', properties: { service: { type: 'string' } }, required: ['service'], additionalProperties: false };
  const output = { type: typeof raw === 'string' ? 'string' : 'object', const: raw };
  const workflow = { v: 2, name: 'release', schemas: { Input: schema, Output: output }, input: { schemaId: 'Input' },
    output: { schemaId: 'Output', path: 'result' }, root: { node: 'call', label: 'read', via: 'tool', tool: 'mcp:release/status',
      args: { service: '{service}' }, out: 'Output', as: 'result', deadline_s: 5 } };
  const check = { id: 'shadow-one', revision: 'candidate-revision', digest: '1234567890abcdef',
    workflow: { name: 'release', workflow: JSON.stringify(workflow), description: 'Private candidate.' } };
  const server = service({ check }), writes = [];
  let persisted, callbacks = 0, loseCompletion = true;
  const settings = { ...config(async (url, init) => {
    if (!new URL(url).pathname.startsWith('/v2/sdk-runs/')) return server.fetch(url, init);
    const body = JSON.parse(init.body);
    if (body.events?.some(row => row.type === 'workflow_check')) assert.equal(persisted.shadow.state, 'complete');
    writes.push(body);
    if (new URL(url).pathname.endsWith('/complete') && loseCompletion) { loseCompletion = false; throw new Error('lost response'); }
    return Response.json({});
  }), workflows: { engine, policy: () => 'allow', tools: [{ name: 'mcp:release/status', nativeName: 'release_status',
    description: 'Read the release.', input_schema: schema, output_schema: output, permission: 'allow', readOnly: true,
    execute() { callbacks++; assert.fail('The native recording already holds the result.'); } }] } };
  const record = await beginTurn(settings, source);
  assert.doesNotMatch(learningInstructions(record, settings.workflows), /Private candidate|shadow-one/);
  const rows = [];
  for await (const row of completedReader().stream()) rows.push(row);
  rows.splice(5, 0,
    { type: 'call.requested', data: { callId: 'native-call', owner: { runId: 'model' }, capability: { name: 'release_status', kind: 'tool' }, input: { service: 'private-service' } } },
    { type: 'call.started', data: { callId: 'native-call' } },
    { type: 'call.settled', data: { callId: 'native-call', outcome: 'completed', output: raw } });
  const reader = { id: source.sessionId, async *stream() {
    for (const [line, row] of rows.entries()) yield { ...row, scope: { turnId: source.turnId },
      meta: { at: '2026-01-01T00:00:00Z', position: { line, index: 0 }, endOfLine: true } };
  } };
  const persist = saved => { persisted = structuredClone(saved); };
  await assert.rejects(submitTurn(settings, record, reader, persist), /Cannot reach the server/);
  assert.equal(await submitTurn(settings, persisted, reader, persist), true);
  assert.equal(callbacks, 0);
  const checks = writes.flatMap(row => row.events ?? []).filter(row => row.type === 'workflow_check');
  assert.equal(checks.length, 2);
  assert.deepEqual(checks[0], { type: 'workflow_check', id: check.id, digest: check.digest, outcome: 'answered', answer });
  assert.deepEqual(checks[1], checks[0]);
  assert.doesNotMatch(JSON.stringify(writes), /private-service|scoped-private-token|fake-test-key/);
});
