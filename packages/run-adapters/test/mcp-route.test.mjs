// A session's remote MCP servers at the model proxy's /mcp/<server>, as a harness's own MCP client meets them: behind the
// session's key, stateless, `server/discover` answered -32601 so a client falls back to `initialize`, its version echoed,
// GET 405, `tools/call` an SSE stream from its first byte with a keepalive, and a disconnect or a cancel aborting the call.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { mcpRoute, startModelProxy } from '@parcha/agentrun-kernel/host';

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
  const p = await startModelProxy({ policy, model: 'm', origin: 'https://provider.invalid', credential: () => 'provider-secret', hooks: { beforeRequest: async () => {}, afterRequest: async () => {} }, mcp: mcpRoute(mcp, options) }, KEY);
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
