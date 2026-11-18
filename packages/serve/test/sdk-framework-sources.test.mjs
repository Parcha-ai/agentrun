import assert from 'node:assert/strict';
import test from 'node:test';
import { serve, client, follow } from './support.mjs';
import { SDK_RUNTIMES, SDK_WORKFLOW_RUNTIMES } from '../dist/sdk/runtimes.js';
import { RESERVED_HARNESS_IDS } from '../dist/harness.js';

const runtimes = ['openai-agents-sdk', 'langgraph'];
const key = value => ({ 'Idempotency-Key': value });

test('framework SDK sources remain distinct from managed harnesses and admit explicit workflow bridges', () => {
  for (const runtime of runtimes) {
    assert.ok(SDK_RUNTIMES.includes(runtime), `${runtime} can report its own runs`);
    assert.ok(RESERVED_HARNESS_IDS.includes(runtime), `${runtime} cannot be impersonated by a harness module`);
    assert.ok(SDK_WORKFLOW_RUNTIMES.includes(runtime), `${runtime} accepts the existing explicit workflow bridge`);
  }
});

for (const runtime of runtimes) {
  test(`${runtime}: caller-owned execution, replay-safe evidence, controls and usage`, async t => {
    const { api, baseUrl } = await serve(t);
    const id = `${runtime}-conformance`;
    const registration = await api('POST', '/agents', { definition: {
      id, name: id, instructions: 'Preserve the original application policy.', sdk: { runtime }, learning: false,
    } });
    assert.equal(registration.status, 201, JSON.stringify(registration.body));
    assert.equal((await api('POST', `/agents/${id}/runs`, { input: { content: 'No managed dispatch.' } })).status, 409);
    const source = { runtime, input: 'Read release status.', instructions: 'Read status before reporting.' };
    const started = await api('POST', `/agents/${id}/sdk-runs`, source, key('first'));
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const { run_id: runId, token } = started.body;
    assert.equal((await api('POST', `/agents/${id}/sdk-runs`, source, key('first'))).body.run_id, runId);
    const sdk = client(baseUrl, token), path = `/sdk-runs/${runId}`;
    for (const action of ['stop', 'cancel']) assert.equal((await api('POST', `/runs/${runId}/${action}`, {})).status, 409);
    const batch = { sequence: 1, events: [
      { type: 'tool', id: 'read-status', name: 'release_status', status: 'started' },
      { type: 'tool', id: 'read-status', name: 'release_status', status: 'completed', output: 'ready' },
      { type: 'text', text: 'The release is ready.' },
    ] };
    assert.equal((await sdk('POST', `${path}/events`, batch)).status, 200);
    assert.equal((await sdk('POST', `${path}/events`, batch)).status, 200);
    assert.equal((await sdk('POST', `${path}/events`, { ...batch, events: [] })).status, 409);
    const usage = { input_tokens: 7, output_tokens: 3, cache_read_tokens: 2, cache_write_tokens: null, cost_usd: null };
    const done = { status: 'completed', answer: 'The release is ready.', usage };
    assert.equal((await sdk('POST', `${path}/complete`, done)).status, 200);
    assert.equal((await sdk('POST', `${path}/complete`, done)).status, 200);
    await follow(api, runId, ['completed']);
    assert.equal((await sdk('POST', `${path}/complete`, { ...done, answer: 'Changed' })).status, 409);
    const run = (await api('GET', `/runs/${runId}`)).body;
    assert.deepEqual(run.sdk.usage, usage);
    assert.equal(run.sdk.runtime, runtime);
    assert.equal(run.result.final_answer, done.answer);
    const totals = (await api('GET', `/stats?agent=${id}`)).body.analytics.totals;
    assert.deepEqual([totals.runs, totals.input, totals.output, totals.cache_read, totals.cache_write, totals.cost_usd], [1, 7, 3, 2, null, null]);
    assert.equal((await api('POST', `/runs/${runId}/messages`, { content: 'No managed resume.' })).status, 409);
  });

  for (const status of ['failed', 'cancelled']) test(`${runtime}: ${status} reports retain usage without learning`, async t => {
    const { api, baseUrl, store } = await serve(t);
    const id = `${runtime}-${status}`;
    assert.equal((await api('POST', '/agents', { definition: { id, name: id, instructions: 'Keep policy.', sdk: { runtime }, learning: true } })).status, 201);
    const started = await api('POST', `/agents/${id}/sdk-runs`, { runtime, input: 'Read status.', instructions: 'Keep policy.' }, key('first'));
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const { run_id: runId, token } = started.body;
    const sdk = client(baseUrl, token), path = `/sdk-runs/${runId}`;
    assert.equal((await sdk('POST', `${path}/complete`, { status, answer: '', usage: { output_tokens: 4, cost_usd: 0.02 } })).status, 200);
    await follow(api, runId, [status]);
    const run = (await api('GET', `/runs/${runId}`)).body;
    assert.equal(run.learning.state, 'dropped');
    assert.equal(run.sdk.usage.output_tokens, 4);
    assert.equal(run.sdk.usage.cost_usd, 0.02);
    assert.equal(run.sdk.usage.input_tokens, null);
    assert.equal(await store.runs.get(`${runId}-learning`), undefined);
  });
}
