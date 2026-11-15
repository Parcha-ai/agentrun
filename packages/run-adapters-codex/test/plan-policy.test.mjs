// The Codex policy on a person's ChatGPT plan (`plan: true`): the request goes with no output limit and none of the keys
// the plan's Responses API does not take, a system-role message is refused in words, each request names its originator,
// the usage is booked to the plan, and the proxy neither limits output nor counts input. Off the plan, nothing changes.
// No network: the policy is called directly.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as host from '@parcha/agentrun-kernel/host';
import { codexPolicy } from '../dist/host/policy.js';

const sse = (events) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
const usage = { input_tokens: 120, output_tokens: 12, total_tokens: 132 };
const answer = sse([{ type: 'response.completed', response: { object: 'response', status: 'completed', usage } }]);
const user = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'What is six times seven?' }] };
const body = { model: 'any', input: [user], stream: true, store: false, max_output_tokens: 4096 };
const ROUTE = { method: 'POST', path: '/v1/responses' };

test('on the plan: no output limit, no input count, an originator, and the usage booked to the plan', async () => {
  const policy = codexPolicy({ model: 'gpt-6.1-sol', tools: [], plan: true });
  const sent = await policy.apply(structuredClone(body), ROUTE);
  assert.equal('max_output_tokens' in sent, false, 'no output limit is sent on the plan');
  assert.equal(sent.model, 'gpt-6.1-sol');
  const unsupported = { temperature: 0.2, top_p: 0.9, metadata: { a: 'b' }, user: 'example', safety_identifier: 'example', truncation: 'auto', background: false, prompt_cache_retention: '24h' };
  const trimmed = await policy.apply({ ...structuredClone(body), ...unsupported }, ROUTE);
  assert.deepEqual(Object.keys(trimmed).filter((key) => key in unsupported), [], 'the keys the plan does not take are dropped');
  assert.deepEqual(policy.authHeaders('fake-test-key'), { authorization: 'Bearer fake-test-key', originator: 'agentrun' });
  assert.equal(policy.limitOutput, undefined);
  assert.equal(policy.countInput, undefined);
  assert.deepEqual(policy.usageOf(answer, sent), { input: 120, output: 12, cacheRead: 0, cacheWrite: 0, billing: 'plan' });
});

test('off the plan, the same request keeps its output limit, no originator, and is booked by its tokens', async () => {
  const policy = codexPolicy({ model: 'gpt-6.1-sol', tools: [] });
  const sent = await policy.apply(structuredClone(body), ROUTE);
  assert.equal(sent.max_output_tokens, 4096);
  assert.deepEqual(policy.authHeaders('fake-test-key'), { authorization: 'Bearer fake-test-key' });
  assert.equal(typeof policy.limitOutput, 'function');
  assert.equal('billing' in policy.usageOf(answer, sent), false);
});

test("a system-role message is refused on the plan in words, and the plan's own keys go only off it", async () => {
  const policy = codexPolicy({ model: 'gpt-6.1-sol', tools: [], plan: true });
  const system = { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'Be brief.' }] };
  assert.throws(() => policy.apply({ ...structuredClone(body), input: [system, user] }, ROUTE), (error) => error instanceof host.ProxyRefusal && /no system-role message/.test(error.message));
  const developer = { ...system, role: 'developer' };
  const sent = await policy.apply({ ...structuredClone(body), input: [developer, user] }, ROUTE);
  assert.deepEqual(sent.input.map((item) => item.role), ['developer', 'user'], 'a developer message goes as it is');
});
