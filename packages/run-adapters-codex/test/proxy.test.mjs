// The session's model proxy and its local machine, attacked from the side Codex sits on. No network: the provider is a
// scripted fetch.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { applyPolicy, matchRoute, parseStrict, startModelProxy, usageOf } from '../dist/host/proxy.js';
import { CODEX_ROUTES, gatewayHandler, isBrandedMachine } from '../dist/host/process.js';
import { childEnv, localMachine } from '../dist/host/machine.js';

const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-codex-proxy-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let n = 0;
const scratch = () => mkdtempSync(join(ROOT, `t${n++}-`));

const KEY = 'session-key-for-tests';
const route = { routes: CODEX_ROUTES, models: { model: 'luna-test' }, credential: () => 'provider-secret', target: 'https://provider.invalid' };
const sse = (usage = { input_tokens: 7, output_tokens: 2 }) => `data: ${JSON.stringify({ delta: 'hi' })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: { usage } })}\n\n`;

/** A proxy with recorded hooks and a provider that records what reached it. */
async function proxy(extra = {}) {
  const forwarded = [];
  const hooks = { before: [], after: [] };
  const p = await startModelProxy({
    route,
    hooks: { beforeRequest: async (r) => { hooks.before.push(r); if (extra.refuse) throw new Error(extra.refuse); }, afterRequest: async (u) => { hooks.after.push(u); } },
    price: () => 0.001,
    fetch: extra.fetch ?? (async (url, init) => { forwarded.push({ url, headers: init.headers, body: JSON.parse(init.body) }); return new Response(sse(), { status: 200, headers: { 'content-type': 'text/event-stream' } }); }),
  }, KEY);
  after(() => p.close());
  return { p, forwarded, hooks };
}

/** A raw request to the proxy: any method, any path text, any key. */
function send(url, { method = 'POST', path = '/v1/responses', key = KEY, body = { model: 'luna-test', input: 'hi' } } = {}) {
  const { port } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json', ...(key === null ? {} : { authorization: `Bearer ${key}` }) } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
}

test('the proxy listens on loopback only and admits only the session key', async () => {
  const { p, forwarded } = await proxy();
  assert.match(p.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  for (const key of [null, '', 'wrong', `${KEY}x`, KEY.slice(0, -1)]) assert.equal((await send(p.url, { key })).status, 401, `key ${JSON.stringify(key)}`);
  assert.equal(forwarded.length, 0);
  assert.equal((await send(p.url)).status, 200);
  assert.equal(forwarded.length, 1);
});

test('only POST /v1/responses, by its exact text: an absolute URL, a foreign path, an escape or a query is refused', async () => {
  const { p, forwarded } = await proxy();
  const refused = ['http://evil.example/v1/responses', '//evil.example/v1/responses', '/v1/responses/../files', '/v1/%72esponses', '/v1/responses?x=1', '/v1/files', '/v1/responses/', '/v1//responses', '/v1/chat/completions', '/V1/responses'];
  for (const path of refused) assert.equal((await send(p.url, { path })).status, 403, path);
  assert.equal((await send(p.url, { method: 'GET' })).status, 403);
  assert.equal((await send(p.url, { method: 'PUT' })).status, 403);
  assert.equal(forwarded.length, 0, 'nothing refused reached the provider');
  assert.throws(() => matchRoute(CODEX_ROUTES, 'POST', 'v1/responses'), /not one the table can match/);
});

test('the provider gets the session model, no stored response, clamped output, its own key, and the route path only', async () => {
  const { p, forwarded } = await proxy();
  const r = await send(p.url, { body: { model: 'expensive-model', store: true, max_output_tokens: 10_000_000, input: 'hi', tools: [{ type: 'function', name: 'lookup' }, { type: 'custom', name: 'exec' }] } });
  assert.equal(r.status, 200);
  const [f] = forwarded;
  assert.equal(f.url, 'https://provider.invalid/v1/responses');
  assert.equal(f.headers.authorization, 'Bearer provider-secret');
  assert.deepEqual([f.body.model, f.body.store, f.body.max_output_tokens], ['luna-test', false, 32_000]);
  assert.ok(!JSON.stringify(f).includes(KEY), 'the session key never reaches the provider');
});

test('a duplicate key at any depth, a second JSON value, or bad UTF-8 is refused before anything is asked', async () => {
  const { p, forwarded, hooks } = await proxy();
  for (const body of ['{"model":"luna-test","model":"other"}', '{"input":[{"a":1,"a":2}]}', '{"model":"luna-test"} {}', '[1]', '{"model":', '"text"']) {
    assert.equal((await send(p.url, { body })).status, 400, body);
  }
  assert.throws(() => parseStrict('{"a":{"b":1,"b":2}}'), /appears twice/);
  assert.equal(hooks.before.length + forwarded.length, 0);
});

test("a provider-hosted tool (web search, file search, code interpreter, computer use, MCP, a shell) is never offered to the model", async () => {
  const { p, forwarded } = await proxy();
  for (const type of ['web_search', 'web_search_preview', 'file_search', 'code_interpreter', 'computer_use_preview', 'image_generation', 'mcp', 'local_shell', 'shell', '', 'other']) {
    assert.equal((await send(p.url, { body: { model: 'luna-test', tools: [{ type: 'function', name: 'ok' }, { type }] } })).status, 403, type);
  }
  assert.throws(() => applyPolicy({ tools: {} }, 'm', 1), /not a list/);
  assert.equal(forwarded.length, 0);
});

test('a request the runner refuses is never forwarded, and answers 400 so Codex does not retry it', async () => {
  const { p, forwarded, hooks } = await proxy({ refuse: 'turn_limit' });
  const r = await send(p.url);
  assert.equal(r.status, 400);
  assert.match(r.text, /turn_limit/);
  assert.equal(forwarded.length, 0);
  assert.equal(hooks.after.length, 0);
});

test("usage comes back once a response completes; a stream cut off before its usage reports nothing", async () => {
  const done = await proxy();
  await send(done.p.url);
  assert.deepEqual(done.hooks.after, [{ input: 7, output: 2, cacheRead: 0, usd: 0.001 }]);

  const cut = await proxy({
    fetch: async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ delta: 'hi' })}\n\n`)); c.error(new Error('cut')); } }), { status: 200 }),
  });
  await send(cut.p.url).catch(() => {});
  assert.equal(cut.hooks.before.length, 1);
  assert.equal(cut.hooks.after.length, 0);
  assert.deepEqual(usageOf(sse({ input_tokens: 5, input_tokens_details: { cached_tokens: 3 }, output_tokens: 1 })), { input: 5, cacheRead: 3, output: 1 });
});

test("a child's environment is the allowlist and what the harness names: no host secret reaches Codex", async () => {
  const host = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC', HOME: '/nonexistent/host-home', OPENAI_API_KEY: 'sk-host', CODEX_HOME: '/nonexistent/host-home/.codex', GITHUB_TOKEN: 't' };
  assert.deepEqual(childEnv(host, { HOME: '/session/home' }), { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC', HOME: '/session/home' });

  const dir = scratch();
  const acquire = localMachine({ dir, env: host, proxy: { hooks: { beforeRequest: async () => {}, afterRequest: async () => {} } } });
  const machine = await acquire({ ctx: { runId: 'r1' }, model: gatewayHandler(route) });
  try {
    assert.ok(isBrandedMachine(machine));
    const child = await machine.spawn({ command: process.execPath, args: ['-e', 'process.stdout.write(JSON.stringify({ env: process.env, cwd: process.cwd() }) + "\\n")'], env: { HOME: machine.dirs.home, SESSION_KEY: machine.modelKey } });
    let line;
    for await (const l of child.lines()) { line = l; break; }
    await child.exited;
    const seen = JSON.parse(line);
    assert.deepEqual(Object.keys(seen.env).sort(), ['HOME', 'LANG', 'PATH', 'SESSION_KEY', 'TZ']);
    assert.equal(seen.cwd, machine.root, 'Codex works in an empty directory of the session, never the host workspace');
  } finally {
    await machine.close();
  }
});

test("the machine writes and tails only inside the session's own directories, and never follows a link", async () => {
  const dir = scratch();
  const acquire = localMachine({ dir, proxy: { hooks: { beforeRequest: async () => {}, afterRequest: async () => {} } } });
  const machine = await acquire({ ctx: { runId: 'r2' }, model: gatewayHandler(route) });
  try {
    for (const path of ['../escape', '/etc/passwd', 'a/../../escape', '']) {
      await assert.rejects(machine.files.upload('codex-home', [{ path, bytes: new Uint8Array() }]), /relative path|leaves the session/, path);
    }
    await machine.files.upload('codex-home', [{ path: 'sessions/x.jsonl', bytes: new TextEncoder().encode('one\ntwo\npart') }]);
    const tail = await machine.tail('codex-home', 'sessions/x.jsonl');
    assert.deepEqual(tail.read(), ['one', 'two']);
    const secret = join(dir, 'outside.txt');
    writeFileSync(secret, 'not yours\n');
    symlinkSync(secret, join(machine.dirs['codex-home'], 'sessions', 'link.jsonl'));
    const linked = await machine.tail('codex-home', 'sessions/link.jsonl');
    assert.throws(() => linked.read(), /is a link/);
    await assert.rejects(machine.tail('codex-home', '../outside.txt'), /leaves the session/);
  } finally {
    await machine.close();
  }
  await assert.rejects(machine.spawn({ command: process.execPath }), /closed/);
});
