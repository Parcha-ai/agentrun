// Actual built hooks, admission, evidence normalization and client requests; only native state/history and HTTP are ports.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { emptySessionView, foldEvents } from 'eve/events';

const portKey = Symbol.for('agentrun.eve.runtime-test');
const port = globalThis[portKey] = {};
const source = text => `data:text/javascript,${encodeURIComponent(text)}`;
const shared = 'const port=globalThis[Symbol.for("agentrun.eve.runtime-test")];';
const stateModule = source(shared + ['learningState', 'pendingEvidence', 'workflowInvocations'].map(name =>
  `export const ${name}={get:()=>port.${name},update:fn=>{port.${name}=fn(port.${name});}};`).join(''));
const extensionModule = source(shared + 'export default {get config(){return port.config;}};');
const serverModule = source(shared + 'export const sessions={attach:id=>port.attach(id)};');
const dist = new URL('../dist/extension/', import.meta.url).href;
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.startsWith(dist)) {
    if (specifier === 'eve/server') return { url: serverModule, shortCircuit: true };
    const resolved = specifier.startsWith('.') ? new URL(specifier, context.parentURL).href : '';
    if (resolved === `${dist}lib/state.mjs`) return { url: stateModule, shortCircuit: true };
    if (resolved === `${dist}extension.mjs`) return { url: extensionModule, shortCircuit: true };
  }
  return next(specifier, context);
} });
const { instructionsFor, reconcile } = await import('../dist/extension/lib/runtime.mjs');
const { default: learningHook } = await import('../dist/extension/hooks/learning.mjs');
after(() => { hooks.deregister(); delete globalThis[portKey]; });

function fixture({ parent = false, loseCompletion = false, refuseCompletion = false, workflows, admittedWorkflows } = {}) {
  port.learningState = { turns: [] }; port.pendingEvidence = { events: [], bytes: 0 }; port.workflowInvocations = [];
  const rows = [], requests = [], starts = [], completions = [], historyReads = [], now = new Date();
  let view = emptySessionView(), current, remainingLosses = loseCompletion ? 1 : 0;
  port.attach = id => ({ id, async *stream({ startIndex, follow }) {
    assert.equal(follow, false); historyReads.push(startIndex);
    for (const row of rows) if (row.meta.position.line >= startIndex) yield row;
  } });
  port.config = { baseUrl: 'https://agentrun.example/v2', apiKey: 'fake-test-key', agentId: 'eve-runtime',
    instructions: 'Keep the existing agent policy.', maxRetries: 0, workflows,
    async fetch(url, init) {
      const path = new URL(url).pathname, body = init.body ? JSON.parse(init.body) : undefined;
      requests.push({ path, body, headers: init.headers });
      const response = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
      if (path === '/v2/agents/eve-runtime') return response({ definition: { sdk: { runtime: 'eve' }, learning: true } });
      if (path.endsWith('/sdk-runs')) {
        const run_id = `run-${starts.length + 1}`; starts.push({ run_id, body });
        return response({ agent_id: 'eve-runtime', run_id, token: `fake-receipt-${run_id}`,
          learning: { enabled: true, revision: 'checked-revision', context: 'Existing owner correction.',
            ...(admittedWorkflows ? { workflows: admittedWorkflows } : {}) } });
      }
      if (path.endsWith('/complete')) {
        completions.push({ path, body });
        if (remainingLosses-- > 0) throw new Error('lost completion response');
        if (refuseCompletion) return new Response(JSON.stringify({ error: { code: 'unavailable' } }), { status: 503, headers: { 'content-type': 'application/json' } });
        return response({});
      }
      if (path.endsWith('/events')) return response({});
      throw new Error(`Unexpected fixture request ${path}`);
    } };
  const context = () => ({ session: { id: 'native-session', turn: { id: current }, ...(parent ? { parent: { sessionId: 'parent' } } : {}) },
    turn: { id: current, status: 'running', input: [{ kind: 'text', text: 'Do this native task.' }] },
    model: { id: 'native-model' }, view, now, memo: async (_key, fn) => fn() });
  const emit = async (type, data, progress = false) => {
    const event = { type, data, scope: { turnId: current } };
    const row = { ...event, meta: { at: '2026-01-01T00:00:00Z', position: { line: rows.length, index: 0 }, endOfLine: true } };
    rows.push(row); view = foldEvents(view, [row]);
    const ctx = { ...context(), position: row.meta.position };
    await learningHook.events[progress ? type : '*'](event, ctx);
  };
  const start = async (id, follows = null) => {
    current = id;
    await emit('turn.started', { turnId: id, follows, cause: { deliveryId: `delivery-${id}` } });
    await emit('delivery.consumed', { turnId: id, deliveryId: `delivery-${id}`, parts: [{ kind: 'text', text: 'Do this native task.' }] });
    return instructionsFor(context());
  };
  const finish = async ({ oversized = false } = {}) => {
    const runId = `model-${current}`, partId = `answer-${current}`;
    await emit('model.requested', { runId, owner: { turnId: current } });
    await emit('model.started', { runId, modelId: 'native-model', attempt: 0 });
    if (oversized) await emit('content.delta', { partId, delta: 'x'.repeat(4_000_001) }, true);
    await emit('content.completed', { partId, runId, kind: 'text', phase: 'reply', value: 'The actual native answer.' });
    await emit('model.settled', { runId, outcome: 'completed' });
    await emit('turn.settled', { turnId: current, outcome: 'completed', reply: [partId] });
  };
  return { start, finish, context, requests, starts, completions, historyReads, rows };
}

test('nine unlearnable native turns cannot poison the session or block the next native task', async () => {
  const f = fixture();
  for (let index = 0; index < 9; index++) {
    await f.start(`oversized-${index}`);
    await f.finish({ oversized: true });
  }
  assert.equal(f.completions.length, 0, 'No oversized trace may fabricate a complete outcome.');
  const nextStart = f.rows.length;
  await f.start('healthy'); await f.finish();
  assert.equal(f.starts.length, 10, 'The extension must not stop the native task at eight old receipts.');
  assert.equal(f.completions.length, 1);
  assert.equal(f.completions[0].body.evidence_complete, true);
  assert.equal(f.completions[0].body.answer, 'The actual native answer.');
  assert.ok(f.historyReads.includes(nextStart), 'Read the target turn from its actual source line, not session line zero.');
});

test('bounded turn reads preserve child-session and conversation-followup exclusions', async () => {
  for (const [parent, follows] of [[true, null], [false, 'prior-conversation']]) {
    const f = fixture({ parent });
    await f.start('not-independent', follows); await f.finish();
    assert.equal(f.completions.length, 1);
    assert.equal(f.completions[0].body.evidence_complete, false);
  }
});

test('a lost response retries byte-identical evidence without later session content', async () => {
  const f = fixture({ loseCompletion: true });
  await f.start('first'); await f.finish();
  assert.equal(f.completions.length, 1);
  await f.start('later');
  assert.equal(f.completions.length, 2);
  const firstWrites = f.requests.filter(row => row.path.includes('/run-1/'));
  assert.equal(firstWrites.length, 4);
  assert.deepEqual(firstWrites.slice(0, 2), firstWrites.slice(2));
  await f.finish();
  assert.equal(f.completions.length, 3);
  await reconcile();
  assert.equal(f.completions.length, 3);
});

test('the actual dynamic instructions carry the host-resolved workflow input schema', async () => {
  const engine = await import('@parcha/agentrun-dsl');
  const release = { type: 'object', properties: { service: { type: 'string' } }, required: ['service'], additionalProperties: false };
  const workflow = { v: 2, name: 'release', schemas: { Input: { $ref: '#/definitions/Release' }, Release: release },
    input: { schemaId: 'Input' } };
  const f = fixture({ workflows: { engine, policy: () => 'allow', tools: [{ name: 'mcp:release/status', nativeName: 'release_status',
    description: 'Read status.', input_schema: release, readOnly: true, permission: 'allow', execute() { assert.fail('Rendering must not execute a callback.'); } }] },
    admittedWorkflows: [{ name: 'release', description: 'Read a release.', workflow: JSON.stringify(workflow) }] });
  const instructions = await f.start('workflow-turn');
  const [, list] = instructions.match(/Compiled workflows pinned to this task \(reference data\):\n([^\n]+)/) ?? [];
  assert.ok(list, 'The admitted workflow must reach the native dynamic instructions.');
  assert.deepEqual(JSON.parse(list)[0].input_schema, { $ref: '#/definitions/Release', definitions: { Release: release } });
});


test('a refused previous delivery does not reject the next native turn or lose the pending receipt', async () => {
  const f = fixture({ refuseCompletion: true });
  await f.start('first'); await f.finish();
  const before = f.starts.length;
  await f.start('second');
  assert.equal(f.starts.length, before + 1, 'Admission must remain available when old telemetry is refused.');
  assert.equal(port.learningState.turns.find(row => row.source.turnId === 'first').submitted, undefined);
  assert.equal(port.learningState.turns.find(row => row.source.turnId === 'first').expired, undefined);
  assert.ok(f.completions.length >= 2, 'Retry delivery without replaying native work.');
});
