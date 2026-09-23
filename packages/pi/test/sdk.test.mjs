import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { createPiRunner } from '../dist/index.js';

async function makeRuntime(responses) {
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const faux = fauxProvider({ tokensPerSecond: Infinity });
  faux.setResponses(responses);
  modelRuntime.registerNativeProvider(faux.provider);
  return { modelRuntime, model: faux.getModel(), faux };
}
const request = { kind: 'agent', label: 'sdk', system: ['Submit the requested count.'], user: 'Count to two', schema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] } };
test('real Pi SDK carries host rejection to the next model turn and stops at accepted submit', async () => {
  let receivedFeedback = false;
  const runtime = await makeRuntime([
    fauxAssistantMessage(fauxToolCall('submit', { value: { count: 1 } })),
    context => {
      receivedFeedback = JSON.stringify(context.messages).includes('Count must equal two');
      return fauxAssistantMessage(fauxToolCall('submit', { value: { count: 2 } }));
    },
    fauxAssistantMessage('Unexpected extra model call'),
  ]);
  const output = await createPiRunner({ ...runtime, maxTurns: 3, timeoutMs: 10_000 })({ ...request, review: async value => value.count === 2 ? { accepted: true } : { accepted: false, message: 'Count must equal two' } });
  assert.deepEqual(output, { count: 2 });
  assert.equal(receivedFeedback, true);
  assert.equal(runtime.faux.state.callCount, 2);
});
test('real Pi SDK honors a hard turn bound with repeated non-delivery', async () => {
  const runtime = await makeRuntime([fauxAssistantMessage('I will do it'), fauxAssistantMessage('I will do it'), fauxAssistantMessage('Must not be called')]);
  await assert.rejects(createPiRunner({ ...runtime, maxTurns: 2, timeoutMs: 10_000 })(request), error => error.reason === 'turn_limit');
  assert.equal(runtime.faux.state.callCount, 2);
});
test('real Pi SDK provider failure is observable and never automatically retried', async () => {
  const runtime = await makeRuntime([
    fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'Fixture provider failure' }),
    fauxAssistantMessage(fauxToolCall('submit', { value: { count: 2 } })),
  ]);
  const events = [];
  await assert.rejects(createPiRunner({ ...runtime, maxTurns: 3, timeoutMs: 10_000, onEvent: event => events.push(event) })(request), error => error.reason === 'model_error');
  assert.equal(runtime.faux.state.callCount, 1);
  assert(events.some(event => event.type === 'turn_end' && event.message.errorMessage === 'Fixture provider failure'));
});
