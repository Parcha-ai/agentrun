// A session's remote MCP servers at the model proxy's /mcp/<server>, as a harness's own MCP client meets them: behind the
// session's key, stateless, `server/discover` answered -32601 so a client falls back to `initialize`, its version echoed,
// GET 405, `tools/call` an SSE stream from its first byte with a keepalive, and a disconnect or a cancel aborting the call.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { startModelProxy } from '@parcha/agentrun-kernel/host';

const KEY = 'session-key-for-tests';
const policy = {
  id: 'test',
  routes: [{ method: 'POST', path: '/v1/test' }],
  keyOf: (headers) => { const auth = String(headers.authorization ?? ''); return auth.startsWith('Bearer ') ? auth.slice(7) : ''; },
  authHeaders: (credential) => ({ authorization: `Bearer ${credential}` }),
  apply: (body) => body,
  usageOf: () => undefined,
};
const ADD = { name: 'add', description: 'Add two numbers.', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } };

/** A proxy whose /mcp/fake calls `call`; `calls` records each call with its signal. */
async function proxy(t, call, options = {}) {
  const calls = [];
  const mcp = { servers: [{ name: 'fake', tools: [ADD, { ...ADD, name: 'slow' }] }], call: async (server, tool, args, context) => (calls.push({ server, tool, args, ...context }), call(server, tool, args, context)) };
  const p = await startModelProxy({ policy, model: 'm', origin: 'https://provider.invalid', credential: () => 'provider-secret', hooks: { beforeRequest: async () => {}, afterRequest: async () => {} }, mcp: { session: mcp, client: { callIdMeta: 'claudecode/toolUseId' }, ...options } }, KEY);
  t.after(() => p.close());
  return { p, calls };
}

/** One request: its status, its content type and its body as text; `onChunk` sees the body as it comes. */
function send(url, { path = '/mcp/fake', method = 'POST', key = KEY, body, accept = 'application/json, text/event-stream', onChunk, signal } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(`${url}${path}`, { method, signal, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), 'content-type': 'application/json', accept } }, (res) => {
      let text = '';
      res.setEncoding('utf8').on('data', (chunk) => { text += chunk; onChunk?.(text); }).on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], text }));
    });
    req.once('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const rpc = (method, params = {}, id = 1) => ({ jsonrpc: '2.0', id, method, params });
const messagesOf = (text) => text.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));

test('behind the session key: discover is -32601, initialize echoes a version it speaks, list, ping, GET 405, notifications 202, OAuth paths 404', async (t) => {
  const { p } = await proxy(t, async () => ({ content: [{ type: 'text', text: '5' }] }));
  assert.equal((await send(p.url, { key: null, body: rpc('initialize') })).status, 401, 'no key, no answer');
  assert.equal((await send(p.url, { key: 'wrong', body: rpc('initialize') })).status, 401);
  for (const path of ['/.well-known/oauth-protected-resource/mcp/fake', '/.well-known/oauth-authorization-server', '/register']) assert.equal((await send(p.url, { path, key: null, body: {} })).status, 404, path);
  const discover = JSON.parse((await send(p.url, { body: rpc('server/discover') })).text);
  assert.equal(discover.error.code, -32601, 'a client probing 2026-07-28 falls back to initialize');
  for (const version of ['2025-11-25', '2025-06-18', '2025-03-26']) assert.equal(JSON.parse((await send(p.url, { body: rpc('initialize', { protocolVersion: version }) })).text).result.protocolVersion, version);
  assert.equal(JSON.parse((await send(p.url, { body: rpc('initialize', { protocolVersion: '2099-01-01' }) })).text).result.protocolVersion, '2025-11-25', 'an unknown version gets the newest');
  assert.deepEqual(JSON.parse((await send(p.url, { body: rpc('tools/list') })).text).result.tools.map((tool) => tool.name), ['add', 'slow']);
  assert.deepEqual(JSON.parse((await send(p.url, { body: rpc('ping') })).text).result, {});
  assert.equal((await send(p.url, { method: 'GET', body: undefined })).status, 405);
  assert.equal((await send(p.url, { body: { jsonrpc: '2.0', method: 'notifications/initialized' } })).status, 202);
  assert.equal((await send(p.url, { path: '/mcp/other', body: rpc('tools/list') })).status, 404, 'a server the session does not have');
});

test('tools/call: an SSE stream from its first byte, a keepalive while the call runs, then the result; a tool not granted is an error the model reads', async (t) => {
  let finish;
  const { p, calls } = await proxy(t, () => new Promise((resolve) => (finish = resolve)), { keepaliveMs: 50 });
  const beats = [];
  const answer = send(p.url, { body: rpc('tools/call', { name: 'add', arguments: { a: 2, b: 3 }, _meta: { progressToken: 'p1', 'claudecode/toolUseId': 'toolu_1' } }, 7), onChunk: (text) => beats.push(messagesOf(text).length) });
  while (beats.at(-1) === undefined || beats.at(-1) < 2) await new Promise((resolve) => setTimeout(resolve, 20));
  finish({ content: [{ type: 'text', text: '5' }] });
  const { status, type, text } = await answer;
  assert.deepEqual([status, type], [200, 'text/event-stream']);
  const messages = messagesOf(text);
  assert.ok(messages.slice(0, -1).length >= 2 && messages.slice(0, -1).every((m) => m.method === 'notifications/progress' && m.params.progressToken === 'p1'), JSON.stringify(messages));
  assert.deepEqual(messages.at(-1), { jsonrpc: '2.0', id: 7, result: { content: [{ type: 'text', text: '5' }] } });
  assert.deepEqual([calls[0].tool, calls[0].args, calls[0].callId], ['add', { a: 2, b: 3 }, 'toolu_1']);
  const json = JSON.parse((await send(p.url, { accept: 'application/json', body: rpc('tools/call', { name: 'nope', arguments: {} }) })).text);
  assert.equal(json.result.isError, true, 'a JSON-only client gets JSON; an ungranted tool is never called');
  assert.equal(calls.length, 1);
});

test('a client that disconnects, or cancels, aborts its call; a cancel of a call that ended is ignored', async (t) => {
  const { p, calls } = await proxy(t, (server, tool, args, { signal }) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ content: [{ type: 'text', text: 'stopped' }], isError: true }), { once: true })));
  const gone = new AbortController();
  const cut = send(p.url, { body: rpc('tools/call', { name: 'slow', arguments: {} }, 1), signal: gone.signal }).catch(() => 'cut');
  while (calls.length < 1) await new Promise((resolve) => setTimeout(resolve, 10));
  gone.abort();
  assert.equal(await cut, 'cut');
  while (!calls[0].signal.aborted) await new Promise((resolve) => setTimeout(resolve, 10));
  const held = send(p.url, { body: rpc('tools/call', { name: 'slow', arguments: {} }, 2) });
  while (calls.length < 2) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await send(p.url, { body: { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } } })).status, 202);
  assert.equal(messagesOf((await held).text).at(-1).result.isError, true);
  assert.equal(calls[1].signal.aborted, true, 'the cancel reached the call');
  assert.equal((await send(p.url, { body: { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } } })).status, 202, 'a cancel for a finished id is ignored');
});

test("a server and a tool named like an object's own properties are served like any other", async (t) => {
  const tool = { ...ADD, name: "toString" };
  const mcp = { servers: [{ name: "constructor", tools: [tool] }], call: async (server, name) => ({ content: [{ type: "text", text: `${server}/${name}` }] }) };
  const p = await startModelProxy({ policy, model: 'm', origin: 'https://provider.invalid', credential: () => 'c', hooks: { beforeRequest: async () => {}, afterRequest: async () => {} }, mcp: { session: mcp, client: { callIdMeta: 'claudecode/toolUseId' } } }, KEY);
  t.after(() => p.close());
  assert.deepEqual(JSON.parse((await send(p.url, { path: '/mcp/constructor', body: rpc('tools/list') })).text).result.tools.map((t) => t.name), ['toString']);
  assert.deepEqual(messagesOf((await send(p.url, { path: '/mcp/constructor', body: rpc('tools/call', { name: 'toString', arguments: {} }) })).text).at(-1).result.content[0].text, 'constructor/toString');
  assert.equal(JSON.parse((await send(p.url, { path: '/mcp/constructor', accept: 'application/json', body: rpc('tools/call', { name: 'hasOwnProperty', arguments: {} }) })).text).result.isError, true);
  const { p: other } = await proxy(t, async () => ({ content: [] }));
  assert.equal((await send(other.url, { path: '/mcp/constructor', body: rpc('tools/list') })).status, 404, 'a session without that server has none of that name');
});

test("the proxy mounts /mcp/<server> itself from the session's MCP and its harness's client fact: the call id comes from the _meta key the harness declared, and from no other", async (t) => {
  const meta = { 'claudecode/toolUseId': 'toolu_9', callId: 'call_9' };
  const seen = {};
  for (const [harness, client] of [['claude-agent', { callIdMeta: 'claudecode/toolUseId' }], ['codex', { callIdMeta: 'callId' }]]) {
    const calls = [];
    const session = { servers: [{ name: 'fake', tools: [ADD] }], call: async (server, tool, args, context) => (calls.push(context.callId), { content: [{ type: 'text', text: '5' }] }) };
    const p = await startModelProxy({ policy, model: 'm', origin: 'https://provider.invalid', credential: () => 'c', hooks: { beforeRequest: async () => {}, afterRequest: async () => {} }, mcp: { session, client } }, KEY);
    t.after(() => p.close());
    const both = await send(p.url, { accept: 'application/json', body: rpc('tools/call', { name: 'add', arguments: { a: 2, b: 3 }, _meta: meta }) });
    assert.equal(both.status, 200, both.text);
    const own = client.callIdMeta === 'callId' ? { callId: 'call_1' } : { 'claudecode/toolUseId': 'toolu_1' };
    const other = client.callIdMeta === 'callId' ? { 'claudecode/toolUseId': 'toolu_2' } : { callId: 'call_2' };
    await send(p.url, { accept: 'application/json', body: rpc('tools/call', { name: 'add', arguments: { a: 1, b: 1 }, _meta: own }, 2) });
    await send(p.url, { accept: 'application/json', body: rpc('tools/call', { name: 'add', arguments: { a: 1, b: 1 }, _meta: other }, 3) });
    seen[harness] = calls;
  }
  assert.deepEqual(seen, { 'claude-agent': ['toolu_9', 'toolu_1', undefined], codex: ['call_9', 'call_1', undefined] });
});
