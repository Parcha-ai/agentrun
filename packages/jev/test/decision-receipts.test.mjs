import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { runWorkflow } from '@parcha/agentrun-dsl';
import { createJevRunner } from '../dist/index.js';

const questions = { ready: { type: 'noul', instructions: 'Is it ready?' } };
const params = { label: 'judge', kind: 'judge', state: { source: 'original' }, questions };
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
const answer = () => ({ model: 'recorded-jev', answers: { ready: { type: 'noul', noul: .9 } }, usage: { input_tokens: 10, output_tokens: 2 } });
const settings = { apiKey: 'fake-test-key', baseURL: 'http://fixture.invalid', pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 }, retryBaseMs: 0, retryMaxMs: 0 };

test('each retry and repeated identical request gets a distinct transport identity', async () => {
  let calls = 0;
  const runner = createJevRunner({ ...settings, fetch: async () => ++calls === 1 ? response({}, 429) : response(answer()) });
  const first = await runner(params), second = await runner(params);
  assert.equal(first.request_sha256, second.request_sha256);
  const attempts = [...first.transport_attempts, ...second.transport_attempts];
  assert.equal(new Set(attempts.map(a => a.id)).size, 3);
  assert.deepEqual(first.transport_attempts.map(a => [a.number, a.status, a.http_status]), [[1, 'failed', 429], [2, 'answered', null]]);
  assert.equal(first.transport_attempts[0].usage, null);
  assert.equal(first.transport_attempts[0].cost_usd, null);
  assert.deepEqual(first.transport_attempts[1].usage, answer().usage);
  assert.deepEqual(first.pricing, settings.pricing);
});

test('billed malformed answers retain metering on the error and never expose provider body', async () => {
  const runner = createJevRunner({ ...settings, fetch: async () => response({ ...answer(), secret: 'do-not-log', answers: {} }) });
  await assert.rejects(runner(params), error => {
    assert.equal(error.code, 'invalid_response');
    assert.deepEqual(error.metadata.usage, answer().usage);
    assert.equal(error.metadata.cost_usd, .000014);
    assert.equal(error.metadata.transport_attempts[0].status, 'failed');
    assert.doesNotMatch(JSON.stringify(error), /do-not-log/);
    return true;
  });
});

test('cancellation retains the in-flight attempt as unknown', async () => {
  const controller = new AbortController();
  const runner = createJevRunner({ timeoutMs: null, client: { systemOne() {
    queueMicrotask(() => controller.abort()); return new Promise(() => {});
  } } });
  await assert.rejects(runner({ ...params, signal: controller.signal }), error => {
    assert.equal(error.code, 'aborted');
    assert.equal(error.metadata.transport_attempts.length, 1);
    assert.equal(error.metadata.transport_attempts[0].status, 'unknown');
    assert.equal(error.metadata.usage, null);
    return true;
  });
});

test('CPU end-to-end: local HTTP fixture through SDK, adapter, interpreter, durable callback and recovery', async t => {
  let calls = 0;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    assert.equal(req.url, '/v1/systemone');
    assert.equal(JSON.parse(body).state.source, 'original');
    calls++;
    res.writeHead(calls === 1 ? 503 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(calls === 1 ? {} : answer()));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const runner = createJevRunner({ ...settings, baseURL: `http://127.0.0.1:${server.address().port}` });
  const flow = { v: 2, name: 'adapter receipt', schemas: { result: { type: 'object', required: ['ready'], properties: { ready: { type: 'boolean', description: 'Is it ready?' } } } },
    output: { schemaId: 'result', path: 'result' }, root: { node: 'judge', label: 'judge', state: { source: 'original' }, out: 'result', as: 'result' } };
  let receipt, committed;
  const deps = {
    runJudge: runner, recordDecision: async value => { receipt = structuredClone(value); },
    recovery: { resume: async () => committed, commit: async (_node, state) => { assert(receipt); committed = state; }, pollStartedAt: () => 0, wait: async () => {} },
  };
  assert.deepEqual((await runWorkflow(flow, {}, deps)).output, { ready: true });
  assert.equal(receipt.metadata.transport_attempts.length, 2);
  assert.deepEqual(receipt.metadata.usage, answer().usage);
  const originalId = receipt.id;
  assert.deepEqual((await runWorkflow(flow, {}, deps)).output, { ready: true });
  assert.equal(calls, 2);
  assert.equal(receipt.id, originalId);
});
