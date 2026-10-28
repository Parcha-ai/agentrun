// The Codex request policy behind the session's model proxy (@parcha/agentrun-adapters/host), through a real proxy to a
// scripted provider. No network.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { after, test } from 'node:test';
import { startModelProxy } from '@parcha/agentrun-adapters/host';
import { codexPolicy } from '../dist/host/policy-stub.js';

const KEY = 'session-key-for-tests';
const sse = (usage = { input_tokens: 7, output_tokens: 2 }) => `data: ${JSON.stringify({ delta: 'hi' })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: { usage } })}\n\n`;

async function proxy(tools = ['lookup']) {
  const forwarded = [];
  const reports = [];
  const p = await startModelProxy({
    policy: codexPolicy({ model: 'luna-test', tools }),
    hooks: { beforeRequest: async () => {}, afterRequest: async (u) => { reports.push(u); } },
    model: 'luna-test',
    origin: 'https://provider.invalid',
    credential: () => 'provider-secret',
    price: () => 0.001,
    fetch: async (url, init) => { forwarded.push({ url, headers: init.headers, body: JSON.parse(init.body) }); return new Response(sse(), { status: 200, headers: { 'content-type': 'text/event-stream' } }); },
  }, KEY);
  after(() => p.close());
  return { p, forwarded, reports };
}

function send(url, body, path = '/v1/responses') {
  const { port } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: 'POST', path, headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

test('the provider gets the session model, no stored response, clamped output, its own key, and the route path only', async () => {
  const { p, forwarded } = await proxy();
  const r = await send(p.url, { model: 'expensive-model', store: true, max_output_tokens: 10_000_000, input: 'hi', tools: [{ type: 'function', name: 'lookup' }] });
  assert.equal(r.status, 200);
  const [f] = forwarded;
  assert.equal(f.url, 'https://provider.invalid/v1/responses');
  assert.equal(f.headers.authorization, 'Bearer provider-secret');
  assert.deepEqual([f.body.model, f.body.store, f.body.max_output_tokens], ['luna-test', false, 32_000]);
  assert.ok(!JSON.stringify(f).includes(KEY), 'the session key never reaches the provider');
});

test('a provider-hosted tool (web search, file search, code interpreter, computer use, MCP, a shell) is never offered to the model', async () => {
  const { p, forwarded } = await proxy();
  for (const type of ['web_search', 'web_search_preview', 'file_search', 'code_interpreter', 'computer_use_preview', 'image_generation', 'mcp', 'local_shell', 'shell', '', 'other']) {
    assert.equal((await send(p.url, { model: 'luna-test', tools: [{ type: 'function', name: 'lookup' }, { type }] })).status, 403, type);
  }
  assert.equal((await send(p.url, { tools: {} })).status, 400);
  assert.equal(forwarded.length, 0);
});

test("only the session's own tools reach the model, in `tools` and in code mode's `additional_tools`, with code mode's carriers", async () => {
  const { p, forwarded } = await proxy();
  const own = { type: 'function', name: 'lookup' };
  const r = await send(p.url, {
    input: [{ type: 'additional_tools', tools: [own, { type: 'function', name: 'request_user_input' }, { type: 'custom', name: 'exec' }, { type: 'function', name: 'wait' }, { type: 'function', name: 'exec' }, { type: 'namespace', name: 'ns', tools: [own, { type: 'function', name: 'other' }] }] }, { role: 'user', content: 'hi' }],
    tools: [own, { type: 'function', name: 'request_user_input' }, { type: 'custom', name: 'exec' }],
  });
  assert.equal(r.status, 200);
  const [f] = forwarded;
  assert.deepEqual(f.body.tools, [own]);
  assert.deepEqual(f.body.input[0].tools, [own, { type: 'custom', name: 'exec' }, { type: 'function', name: 'wait' }, { type: 'namespace', name: 'ns', tools: [own] }]);
});

test('usage comes back once a response completes, cached tokens included', async () => {
  const { p, reports } = await proxy();
  await send(p.url, { input: 'hi' });
  assert.deepEqual(reports, [{ input: 7, output: 2, cacheRead: 0, usd: 0.001 }]);
  const policy = codexPolicy({ model: 'm', tools: [] });
  assert.deepEqual(policy.usageOf(sse({ input_tokens: 5, input_tokens_details: { cached_tokens: 3 }, output_tokens: 1 })), { input: 5, cacheRead: 3, output: 1 });
  assert.equal(policy.usageOf('data: {"delta":"hi"}\n\n'), undefined);
});
