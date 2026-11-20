import assert from 'node:assert/strict';
import test from 'node:test';
import { BackendLearningClient } from '../dist/learning.js';

const source = { runtime: 'eve', input: 'Read the current release.', instructions: 'Use original permissions.' };
function service({ check, bridge, loseCompletion = false, loseStart = false } = {}) {
  const requests = [], admissions = new Map();
  let completionLost = false, startLost = false;
  const config = { baseUrl: 'https://agentrun.example/v2', apiKey: 'fake-test-key', agentId: 'existing', maxRetries: 0,
    pollIntervalMs: 1, learningTimeoutMs: 1000, workflows: bridge,
    async fetch(url, init) {
      const path = new URL(url).pathname, body = init.body ? JSON.parse(init.body) : undefined;
      requests.push({ path, body, key: init.headers['Idempotency-Key'], auth: init.headers.authorization });
      if (path === '/v2/agents/existing') return Response.json({ definition: { sdk: { runtime: 'eve' } } });
      if (path.endsWith('/sdk-runs')) {
        const key = init.headers['Idempotency-Key'];
        if (!admissions.has(key)) admissions.set(key, { run_id: `run-${admissions.size + 1}`, token: 'fake-scoped-token', agent_id: 'existing',
          console_url: 'https://agentrun.example/#/runs/one', learning: { enabled: true, revision: null, context: '', workflows: [], ...(check ? { check } : {}) } });
        if (loseStart && !startLost) { startLost = true; throw new Error('lost admission'); }
        return Response.json(admissions.get(key));
      }
      if (path.endsWith('/complete') && loseCompletion && !completionLost) { completionLost = true; throw new Error('lost completion'); }
      if (path.endsWith('/complete') || path.endsWith('/events')) return Response.json({ accepted: true });
      return Response.json({ run_id: path.split('/').at(-1), state: 'completed', learning: { state: 'merged' } });
    } };
  return { config, requests, admissions };
}
const events = [{ type: 'text', text: 'The native result.' }];
const outcome = { status: 'completed', answer: 'The native result.' };

test('caller admission key survives an ambiguous response and durable resume never admits another turn', async () => {
  const s = service({ loseStart: true });
  await assert.rejects(new BackendLearningClient(s.config).begin(source, undefined, { idempotencyKey: 'native:turn-one' }), /Cannot reach the server/);
  const session = await new BackendLearningClient(s.config).begin(source, undefined, { idempotencyKey: 'native:turn-one' });
  assert.equal(s.admissions.size, 1);
  const saved = session.checkpoint(), before = s.requests.length;
  saved.receipt.learning.context = 'A durable local copy.';
  assert.equal(session.checkpoint().receipt.learning.context, '');
  const restored = new BackendLearningClient(s.config).resume(structuredClone(saved));
  assert.equal(restored.runId, session.runId);
  assert.equal(s.requests.length, before);
  for (const change of [{ baseUrl: 'https://other.example/v2' }, { agentId: 'other' }]) {
    assert.throws(() => new BackendLearningClient({ ...s.config, ...change }).resume(saved), /another server or agent/);
  }
  await restored.submit(events, outcome, { waitForLearning: false });
  assert.equal(s.requests.filter(row => row.path.endsWith('/sdk-runs')).length, 2);
});

test('one-shot delivery retries byte-identical batches and outcome with scoped credentials', async () => {
  const s = service({ loseCompletion: true }), client = new BackendLearningClient(s.config);
  const session = await client.begin(source), checkpoint = session.checkpoint();
  const text = 'Contains fake-test-key and fake-scoped-token.';
  const rows = [{ type: 'session', session_id: 'native' }, { type: 'text', text }];
  await assert.rejects(session.submit(rows, { ...outcome, answer: text }, { waitForLearning: false }), /Cannot reach the server/);
  await client.resume(checkpoint).submit(rows, { ...outcome, answer: text }, { waitForLearning: false });
  const writes = s.requests.filter(row => /\/(events|complete)$/.test(row.path));
  assert.equal(writes.length, 4);
  assert.deepEqual(writes.slice(0, 2), writes.slice(2));
  assert.ok(writes.every(row => row.auth === 'Bearer fake-scoped-token'));
  assert.doesNotMatch(JSON.stringify(writes.map(row => row.body)), /fake-test-key|fake-scoped-token/);
});

const candidate = { id: 'check-one', revision: 'candidate-revision', digest: 'candidate-digest',
  workflow: { name: 'draft-only', workflow: '{}', description: 'Never advertise this draft to the native model.' } };
const raw = [
  { type: 'tool', id: 'tool-one', name: 'mcp:release/status', status: 'started', input: { release: 'fresh' } },
  { type: 'tool', id: 'tool-one', name: 'mcp:release/status', status: 'completed', output: { secret: 'local-result' } },
];
function checkingBridge(checked) {
  return { catalog: [], adapters: [], bind(session) { assert.deepEqual(session.workflows, []); return { context: '', close() {} }; },
    async check(check, turn) { checked.push({ check, turn }); return { type: 'workflow_check', id: check.id, digest: check.digest, outcome: 'answered', answer: 'The native result.' }; } };
}

test('a private candidate checks the native result before completion without advertising or uploading raw tool payloads', async () => {
  const checked = [], s = service({ check: candidate, bridge: checkingBridge(checked) });
  const session = await new BackendLearningClient(s.config).begin(source);
  assert.equal(session.workflowContext, ''); assert.deepEqual(session.workflows, []);
  for (const { input, output, ...event } of raw) await session.nativeEvent(event, { input, output });
  await session.complete(outcome);
  assert.deepEqual(checked[0].turn.events, raw);
  assert.equal(checked[0].turn.input, source.input);
  assert.deepEqual(checked[0].turn.outcome, outcome);
  const uploaded = s.requests.filter(row => row.path.endsWith('/events'));
  assert.equal(uploaded.at(-1).body.events[0].type, 'workflow_check');
  assert.doesNotMatch(JSON.stringify(uploaded), /local-result|fresh/);
  assert.ok(s.requests.indexOf(uploaded.at(-1)) < s.requests.findIndex(row => row.path.endsWith('/complete')));
});

test('recorded turns use local replay evidence while failed or incomplete native turns never check a candidate', async () => {
  for (const [status, complete] of [['completed', true], ['completed', false], ['failed', true], ['cancelled', true]]) {
    const checked = [], s = service({ check: candidate, bridge: checkingBridge(checked) });
    const session = await new BackendLearningClient(s.config).begin(source);
    await session.submit(events, { ...outcome, status }, { nativeEvents: raw, evidenceComplete: complete, waitForLearning: false });
    assert.equal(checked.length, status === 'completed' && complete ? 1 : 0);
    if (checked.length) assert.deepEqual(checked[0].turn.events, raw);
    assert.doesNotMatch(JSON.stringify(s.requests), /local-result/);
  }
});

test('failed shadow execution records failure without replacing the native answer', async () => {
  const bridge = checkingBridge([]); bridge.check = async () => { throw new Error('private callback detail'); };
  const s = service({ check: candidate, bridge }), session = await new BackendLearningClient(s.config).begin(source);
  await session.submit(events, outcome, { nativeEvents: raw, waitForLearning: false });
  const checks = s.requests.flatMap(row => row.body?.events ?? []).filter(event => event.type === 'workflow_check');
  assert.deepEqual(checks, [{ type: 'workflow_check', id: candidate.id, digest: candidate.digest, outcome: 'failed', reason: 'shadow_execution_failed' }]);
  assert.equal(s.requests.find(row => row.path.endsWith('/complete')).body.answer, outcome.answer);
  assert.doesNotMatch(JSON.stringify(s.requests), /private callback detail/);
});

test('client redaction cannot turn different native and shadow answers into an agreeing check', async () => {
  let executions = 0, checkpoint;
  const bridge = checkingBridge([]); bridge.check = async check => {
    executions++;
    return { type: 'workflow_check', id: check.id, digest: check.digest, outcome: 'answered', answer: 'fake-scoped-token' };
  };
  const s = service({ check: candidate, bridge, loseCompletion: true }), client = new BackendLearningClient(s.config);
  const session = await client.begin(source);
  const native = { ...outcome, answer: 'fake-test-key' };
  const options = { waitForLearning: false, onCheckpoint(value) { checkpoint = structuredClone(value); } };
  await assert.rejects(session.submit(events, native, options), /Cannot reach the server/);
  await client.resume(checkpoint).submit(events, native, options);
  assert.equal(executions, 0, 'A redacted native answer is not valid comparison evidence.');
  const checks = s.requests.flatMap(row => row.body?.events ?? []).filter(event => event.type === 'workflow_check');
  assert.deepEqual(checks, Array(2).fill({ type: 'workflow_check', id: candidate.id, digest: candidate.digest,
    outcome: 'failed', reason: 'client_redacted_evidence' }));
  assert.equal(s.requests.find(row => row.path.endsWith('/complete')).body.answer, '[withheld]');
  assert.doesNotMatch(JSON.stringify(s.requests.map(row => row.body)), /fake-test-key|fake-scoped-token/);
  assert.equal(checkpoint.shadow.event.answer, undefined);
  await assert.rejects(client.resume(checkpoint).submit(events, { ...native, answer: 'fake-scoped-token' }, options), /different native evidence/);
});

test('redacted source, raw native evidence or shadow answers cannot supply comparison evidence', async () => {
  for (const location of ['source', 'native', 'shadow']) {
    let executions = 0, checkpoint;
    const bridge = checkingBridge([]); bridge.check = async check => {
      executions++;
      return { type: 'workflow_check', id: check.id, digest: check.digest, outcome: 'answered', answer: 'fake-scoped-token' };
    };
    const s = service({ check: candidate, bridge, loseCompletion: true }), client = new BackendLearningClient(s.config);
    const session = await client.begin(location === 'source' ? { ...source, input: 'Private task value.' } : source);
    if (location === 'source') session.protect(['Private task value.']);
    const evidence = location === 'native' ? [{ ...raw[0], input: { token: 'fake-scoped-token' } }, raw[1]] : raw;
    const options = { nativeEvents: evidence, waitForLearning: false,
      onCheckpoint(value) { checkpoint = structuredClone(value); } };
    await assert.rejects(session.submit(events, outcome, options), /Cannot reach the server/);
    await client.resume(checkpoint).submit(events, outcome, options);
    assert.equal(executions, location === 'shadow' ? 1 : 0, location);
    assert.deepEqual(checkpoint.shadow.event, { type: 'workflow_check', id: candidate.id, digest: candidate.digest,
      outcome: 'failed', reason: 'client_redacted_evidence' }, location);
    const uploads = s.requests.filter(row => /\/(events|complete)$/.test(row.path));
    assert.doesNotMatch(JSON.stringify(uploads.map(row => row.body)), /fake-test-key|fake-scoped-token|Private task value/);
    assert.equal(uploads.find(row => row.path.endsWith('/complete')).body.answer, outcome.answer);
  }
});


test('native cancellation stays connected until the shadow check settles and preserves the completed native answer', { timeout: 5_000 }, async () => {
  const entered = Promise.withResolvers();
  const bridge = checkingBridge([]);
  bridge.check = async (check, turn) => {
    entered.resolve(turn.signal);
    await new Promise(resolve => turn.signal.addEventListener('abort', resolve, { once: true }));
    return { type: 'workflow_check', id: check.id, digest: check.digest, outcome: 'failed', reason: 'native_cancelled' };
  };
  const s = service({ check: candidate, bridge }), session = await new BackendLearningClient(s.config).begin(source);
  const controller = new AbortController(); session.followAbort(controller.signal);
  const finished = session.complete(outcome), signal = await entered.promise;
  controller.abort(new Error('The original application stopped.'));
  await finished;
  assert.equal(signal.aborted, true);
  assert.equal(s.requests.find(row => row.path.endsWith('/complete')).body.answer, outcome.answer);
  assert.equal(s.requests.find(row => row.path.endsWith('/complete')).body.status, 'completed');
});


test('a lost completion reuses its checkpointed shadow event without repeating the check', async () => {
  let executions = 0, checkpoint;
  const bridge = checkingBridge([]); bridge.check = async check => ({ type: 'workflow_check', id: check.id, digest: check.digest,
    outcome: 'answered', answer: `shadow execution ${++executions}` });
  const s = service({ check: candidate, bridge, loseCompletion: true }), client = new BackendLearningClient(s.config);
  const session = await client.begin(source);
  const options = { nativeEvents: raw, waitForLearning: false, onCheckpoint(value) { checkpoint = structuredClone(value); } };
  await assert.rejects(session.submit(events, outcome, options), /Cannot reach the server/);
  assert.equal(checkpoint.shadow.state, 'complete');
  assert.equal(executions, 1);
  await client.resume(checkpoint).submit(events, outcome, options);
  assert.equal(executions, 1);
  const checks = s.requests.flatMap(row => row.body?.events ?? []).filter(event => event.type === 'workflow_check');
  assert.equal(checks.length, 2); assert.deepEqual(checks[0], checks[1]);
  await assert.rejects(client.resume(checkpoint).submit(events, { ...outcome, answer: 'different native evidence' }, options), /different native evidence/);
  assert.equal(executions, 1);
});

test('a restored started shadow reports unknown outcome instead of repeating host work', async () => {
  let executions = 0, started;
  const bridge = checkingBridge([]); bridge.check = async () => { executions++; assert.fail('A failed durable start barrier must prevent dispatch.'); };
  const s = service({ check: candidate, bridge }), client = new BackendLearningClient(s.config), session = await client.begin(source);
  await assert.rejects(session.submit(events, outcome, { nativeEvents: raw, waitForLearning: false, onCheckpoint(value) {
    started = structuredClone(value); throw new Error('The host stopped after recording the start marker.');
  } }), /host stopped/);
  assert.equal(started.shadow.state, 'started'); assert.equal(executions, 0);
  await client.resume(started).submit(events, outcome, { nativeEvents: raw, waitForLearning: false });
  assert.equal(executions, 0);
  const checks = s.requests.flatMap(row => row.body?.events ?? []).filter(event => event.type === 'workflow_check');
  assert.deepEqual(checks, [{ type: 'workflow_check', id: candidate.id, digest: candidate.digest, outcome: 'failed', reason: 'shadow_outcome_unknown' }]);
  assert.equal(s.requests.find(row => row.path.endsWith('/complete')).body.answer, outcome.answer);
});
