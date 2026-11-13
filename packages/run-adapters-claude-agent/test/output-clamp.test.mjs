// A request the host admitted with an output limit (its ticket's `outputTokensMax`, what is left of a spend cap can buy)
// reaches the provider with max_tokens at most that limit, through the session's model proxy under the Claude policy.
// A thinking budget is squeezed under it so that 1,024 tokens stay for the answer, never below the provider's least
// budget (1,024): a limit that cannot hold both was not admitted. The body is never made longer than the one its input
// bound was measured on. No network: the provider is a scripted fetch.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import * as host from '@parcha/agentrun-kernel/host';
import { anthropicPolicy } from '@parcha/agentrun-harness-claude';

const { startModelProxy } = host;
const options = { model: 'claude-main', smallModel: 'claude-small', tools: ['lookup'], maxOutputTokens: 64_000 };
const bodyWith = (extra) => ({ model: 'claude-main', max_tokens: 32_000, messages: [{ role: 'user', content: 'What is six times seven?' }], ...extra });

function send(url, body) {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ host: hostname, port, method: 'POST', path: '/v1/messages?beta=true', headers: { 'content-type': 'application/json', authorization: 'Bearer session-key', 'anthropic-version': '2023-06-01' } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

/** A proxy under the Claude policy whose host admits each request with `limit` output tokens (none: no limit). */
async function admitting(t, limit) {
  const sent = [];
  const asked = [];
  const p = await startModelProxy({
    policy: anthropicPolicy(options), model: 'claude-main', origin: 'https://provider.invalid', credential: () => 'provider-secret', price: () => 0.001, log: () => {},
    hooks: { beforeRequest: async (r) => { asked.push(r); return { turn: 1, ...(limit === undefined ? {} : { outputTokensMax: limit }) }; }, afterRequest: async () => {} },
    fetch: async (_url, init) => { sent.push(String(init.body)); return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }); },
  }, 'session-key');
  t.after(() => p.close());
  return { p, sent, asked, forwarded: () => sent.map((raw) => JSON.parse(raw)) };
}

test('a request admitted with an output limit reaches the provider with max_tokens at that limit', async (t) => {
  const { p, forwarded } = await admitting(t, 5_000);
  assert.equal((await send(p.url, bodyWith({}))).status, 200);
  assert.equal(forwarded()[0].max_tokens, 5_000);
});

test('a limit above what the CLI asked for raises nothing: its own max_tokens goes', async (t) => {
  const { p, forwarded } = await admitting(t, 5_000);
  assert.equal((await send(p.url, bodyWith({ max_tokens: 2_000 }))).status, 200);
  assert.equal(forwarded()[0].max_tokens, 2_000);
});

test('a thinking budget is squeezed under the limit, keeping 1,024 tokens for the answer', async (t) => {
  const { p, forwarded } = await admitting(t, 5_000);
  assert.equal((await send(p.url, bodyWith({ thinking: { type: 'enabled', budget_tokens: 16_000 } }))).status, 200);
  const [body] = forwarded();
  assert.deepEqual([body.max_tokens, body.thinking], [5_000, { type: 'enabled', budget_tokens: 3_976 }]);
});

test('a thinking budget that already fits with room for the answer is left as the CLI sent it; adaptive thinking keeps its type', async (t) => {
  const { p, forwarded } = await admitting(t, 5_000);
  assert.equal((await send(p.url, bodyWith({ thinking: { type: 'enabled', budget_tokens: 2_000 } }))).status, 200);
  assert.equal((await send(p.url, bodyWith({ thinking: { type: 'adaptive' } }))).status, 200);
  const [fits, adaptive] = forwarded();
  assert.deepEqual([fits.max_tokens, fits.thinking], [5_000, { type: 'enabled', budget_tokens: 2_000 }]);
  assert.deepEqual([adaptive.max_tokens, adaptive.thinking], [5_000, { type: 'adaptive' }]);
});

test('the body sent is never longer than the one its input bound was measured on', async (t) => {
  const { p, sent, asked } = await admitting(t, 5_000);
  const body = bodyWith({ thinking: { type: 'enabled', budget_tokens: 16_000 } });
  assert.equal((await send(p.url, body)).status, 200);
  const measured = asked[0].inputTokensMax;
  assert.ok(typeof measured === 'number' && Buffer.byteLength(sent[0], 'utf8') <= measured, `${Buffer.byteLength(sent[0], 'utf8')} bytes sent, ${measured} measured`);
});

test('with no limit (no cap) the body goes as the policy shapes it', async (t) => {
  const { p, forwarded } = await admitting(t, undefined);
  assert.equal((await send(p.url, bodyWith({ thinking: { type: 'enabled', budget_tokens: 16_000 } }))).status, 200);
  assert.deepEqual([forwarded()[0].max_tokens, forwarded()[0].thinking], [32_000, { type: 'enabled', budget_tokens: 16_000 }]);
});
