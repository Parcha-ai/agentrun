// The Claude Agent adapter's host side, attacked directly: the Anthropic policy the session's proxy applies, the spawn
// hook that starts the CLI, and the local machine's environment. No network, no CLI.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { request } from 'node:http';
import { ProxyRefusal, startModelProxy } from '@parcha/agentrun-adapters/host';
import { anthropicPolicy } from '@parcha/agentrun-claude-agent';
import { childEnv, localMachine } from '../dist/host/machine.js';
import { gatewayHandler, isBrandedMachine, journalLedger, ModelSteps, settleAbandonedModelSteps } from '../dist/host/process.js';
import { isResumeDir, spawnProblem } from '../dist/spawn.js';

const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-claude-host-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let n = 0;
const scratch = () => mkdtempSync(join(ROOT, `t${n++}-`));

const policy = anthropicPolicy({ model: 'claude-main', smallModel: 'claude-small', tools: ['lookup', 'submit'], maxOutputTokens: 8_000 });
const route = (path) => policy.routes.find((r) => r.path === path);
const MESSAGES = route('/v1/messages');
const COUNT = route('/v1/messages/count_tokens');
const apply = (body, r = MESSAGES) => policy.apply(body, r);
const refused = (fn, status, pattern) => assert.throws(fn, (e) => e instanceof ProxyRefusal && e.status === status && pattern.test(e.message));
const body = (extra = {}) => ({ model: 'claude-main', max_tokens: 1000, messages: [{ role: 'user', content: 'hi' }], ...extra });

test("the routes are the pinned CLI's: the connectivity check answered here, a paid messages route, a free token count", () => {
  assert.deepEqual(policy.routes.map((r) => [r.method, r.path, r.query ?? [], r.local ?? null, r.free ?? false]), [
    ['HEAD', '/api/hello', [], 200, false],
    ['POST', '/v1/messages', ['beta=true'], null, false],
    ['POST', '/v1/messages/count_tokens', ['beta=true'], null, true],
  ]);
  assert.equal(policy.keyOf({ authorization: 'Bearer k1' }), 'k1');
  assert.equal(policy.keyOf({ 'x-api-key': 'k1' }), '', 'the CLI sends the session key as a bearer token only');
  assert.deepEqual(policy.authHeaders('secret'), { 'x-api-key': 'secret' });
  assert.deepEqual(anthropicPolicy({ model: 'm', tools: [], auth: 'bearer' }).authHeaders('secret'), { authorization: 'Bearer secret' });
});

test("the body: the session's model or its small one, clamped output and thinking, and only the session's own tools", () => {
  const out = apply(body({ max_tokens: 1_000_000, thinking: { type: 'enabled', budget_tokens: 50_000 }, tools: [{ name: 'mcp__hands__lookup', input_schema: {} }, { name: 'mcp__hands__other', input_schema: {} }, { name: 'Bash', input_schema: {} }, { type: 'custom', name: 'mcp__hands__submit', input_schema: {} }] }));
  assert.deepEqual([out.model, out.max_tokens, out.thinking.budget_tokens], ['claude-main', 8_000, 7_999]);
  assert.deepEqual(out.tools.map((t) => t.name), ['mcp__hands__lookup', 'mcp__hands__submit']);
  assert.equal(apply(body({ model: 'claude-small' })).model, 'claude-small');
  refused(() => apply(body({ model: 'claude-opus-expensive' })), 403, /the model is not this session's/);
  refused(() => apply(body({ tool_choice: { type: 'tool', name: 'Bash' } })), 403, /tool_choice/);
  refused(() => apply(body({ thinking: { type: 'enabled', budget_tokens: 5_000 }, max_tokens: 900 })), 400, /budget_tokens/);
});

test('nothing the provider would run or fetch on its own passes: hosted tools, MCP, containers, server blocks, URL and file sources', () => {
  for (const type of ['web_search_20250305', 'web_fetch_20250910', 'code_execution_20250825', 'bash_20250124', 'text_editor_20250728', 'computer_20250124', 'memory_20250818', 'tool_search_tool_regex_20251119']) {
    refused(() => apply(body({ tools: [{ type, name: 'x' }] })), 403, /provider-hosted tool is not offered/);
  }
  refused(() => apply(body({ mcp_servers: [{ type: 'url', url: 'https://mcp.example', name: 'x' }] })), 403, /a key outside the API's own/);
  for (const key of ['container', 'service_tier', 'betas']) refused(() => apply(body({ [key]: 'x' })), 403, /a key outside the API's own/);
  const block = (b) => body({ messages: [{ role: 'user', content: [b] }] });
  for (const b of [{ type: 'server_tool_use', name: 'web_search', id: 's', input: {} }, { type: 'web_search_tool_result', tool_use_id: 's', content: [] }, { type: 'web_fetch_tool_result', tool_use_id: 's', content: {} }, { type: 'mcp_tool_use', id: 'm' }, { type: 'mcp_tool_result', tool_use_id: 'm' }, { type: 'container_upload', file_id: 'f' }, { type: 'bash_code_execution_tool_result', tool_use_id: 'b' }]) {
    refused(() => apply(block(b)), 403, /runs on its own/);
  }
  refused(() => apply(block({ type: 'image', source: { type: 'url', url: 'https://example.com/x.png' } })), 403, /would fetch/);
  refused(() => apply(block({ type: 'document', source: { type: 'file', file_id: 'file_1' } })), 403, /would fetch/);
  refused(() => apply(body({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'image', source: { type: 'url', url: 'https://x' } }] }] }] })), 403, /would fetch/);
  refused(() => apply(body({ system: [{ type: 'mcp_tool_result', tool_use_id: 'm' }] })), 403, /runs on its own/);
  // Inline data is the client's own.
  assert.ok(apply(block({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } })));
});

test('a token count carries only its own keys, the same tools and model rules, and is not clamped', () => {
  refused(() => apply(body(), COUNT), 403, /count_tokens: a key outside/);
  const out = apply({ model: 'claude-small', messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'mcp__hands__other' }] }, COUNT);
  assert.deepEqual([out.model, out.tools, out.max_tokens], ['claude-small', [], undefined]);
  refused(() => apply({ model: 'x', messages: [] }, COUNT), 403, /not this session's/);
});

test("anthropic-beta: the pinned CLI's values pass; any other refuses the request", () => {
  assert.equal(policy.header('anthropic-beta', 'claude-code-20250219,interleaved-thinking-2025-05-14'), 'claude-code-20250219,interleaved-thinking-2025-05-14');
  for (const other of ['context-1m-2025-08-07', 'prompt-caching-2024-07-31', 'fine-grained-tool-streaming-2025-05-14']) refused(() => policy.header('anthropic-beta', other), 403, /not one the pinned CLI sends/);
  assert.equal(policy.header('anthropic-version', '2023-06-01'), '2023-06-01');
  refused(() => policy.header('anthropic-beta', 'claude-code-20250219, files-api-2025-04-14'), 403, /not one the pinned CLI sends/);
});

test("usage: a stream's message_start and last message_delta, a whole body's, and nothing for a cut stream", () => {
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const stream = ev('message_start', { message: { usage: { input_tokens: 120, cache_read_input_tokens: 30, cache_creation_input_tokens: 5, output_tokens: 1 } } }) + ev('content_block_delta', { delta: { type: 'text_delta', text: 'hi' } }) + ev('message_delta', { usage: { output_tokens: 7 } }) + ev('message_delta', { usage: { output_tokens: 42 } });
  assert.deepEqual(policy.usageOf(stream + ev('message_stop', {})), { input: 120, output: 42, cacheRead: 30, cacheWrite: 5 });
  assert.equal(policy.usageOf(stream), undefined, 'a stream cut before message_stop');
  assert.deepEqual(policy.usageOf(JSON.stringify({ id: 'm', usage: { input_tokens: 3, output_tokens: 4 } })), { input: 3, output: 4, cacheRead: 0, cacheWrite: 0 });
});

test('the spawn hook starts only the pinned binary, with exactly the env the harness gave, and a resume dir that holds only the transcript', () => {
  const given = { HOME: '/s/home', CLAUDE_CONFIG_DIR: '/s/config', ANTHROPIC_AUTH_TOKEN: randomUUID() };
  const ok = { command: '/pinned/claude', args: ['--x'], env: { ...given, CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_AGENT_SDK_VERSION: '0.3.286' }, signal: new AbortController().signal };
  const options = { executable: '/pinned/claude', env: given };
  assert.equal(spawnProblem(ok, options), undefined);
  assert.match(spawnProblem({ ...ok, command: '/usr/bin/node' }, options), /not the pinned binary/);
  assert.match(spawnProblem({ ...ok, env: { ...ok.env, ANTHROPIC_API_KEY: 'sk' } }, options), /ANTHROPIC_API_KEY is not one the harness gave/);
  assert.match(spawnProblem({ ...ok, env: { ...ok.env, ANTHROPIC_AUTH_TOKEN: 'other' } }, options), /does not have the harness's value/);
  assert.match(spawnProblem({ ...ok, env: { ...ok.env, HOME: undefined } }, options), /HOME is missing/);
  assert.match(spawnProblem({ ...ok, env: { ...ok.env, CLAUDE_CONFIG_DIR: '/nonexistent/operator-home/.claude' } }, options), /neither the session's nor/);
  // A resume dir the SDK made: only projects/** may be in it.
  const resume = mkdtempSync(join(tmpdir(), 'claude-resume-'));
  try {
    assert.ok(isResumeDir(resume));
    mkdirSync(join(resume, 'projects', 'session'), { recursive: true });
    writeFileSync(join(resume, 'projects', 'session', 'a.jsonl'), '{}\n');
    const resumed = { ...ok, env: { ...ok.env, CLAUDE_CONFIG_DIR: resume } };
    assert.equal(spawnProblem(resumed, options), undefined);
    writeFileSync(join(resume, '.credentials.json'), '{}');
    assert.match(spawnProblem(resumed, options), /beside the transcript/);
    rmSync(join(resume, '.credentials.json'));
    symlinkSync('/etc/hostname', join(resume, 'projects', 'session', 'link.jsonl'));
    assert.match(spawnProblem(resumed, options), /is a link/);
  } finally {
    rmSync(resume, { recursive: true, force: true });
  }
});

test("a child's environment is the allowlist and what the harness names: no host secret reaches the CLI", async () => {
  const host = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC', HOME: '/nonexistent/host-home', ANTHROPIC_API_KEY: 'sk-host', CLAUDE_CODE_OAUTH_TOKEN: 'oauth', CLAUDE_CONFIG_DIR: '/nonexistent/host-home/.claude', GITHUB_TOKEN: 't' };
  assert.deepEqual(childEnv(host, { HOME: '/session/home' }), { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC', HOME: '/session/home' });
  const handler = gatewayHandler({ routes: [], models: { model: 'claude-main' }, credential: () => 'provider-secret', target: 'https://provider.invalid' });
  const acquire = localMachine({ dir: scratch(), env: host, proxy: { hooks: { beforeRequest: async () => {}, afterRequest: async () => {} }, tools: [] } });
  const machine = await acquire({ ctx: { runId: 'r1' }, model: handler });
  try {
    assert.ok(isBrandedMachine(machine));
    assert.match(machine.modelUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    const child = machine.start({ command: process.execPath, args: ['-e', 'process.stdout.write(JSON.stringify({ env: process.env, cwd: process.cwd() }))'], env: { HOME: machine.dirs.home, ANTHROPIC_AUTH_TOKEN: machine.modelKey } });
    let out = '';
    child.child.stdout.on('data', (d) => { out += d; });
    await child.exited;
    const seen = JSON.parse(out);
    assert.deepEqual(Object.keys(seen.env).sort(), ['ANTHROPIC_AUTH_TOKEN', 'HOME', 'LANG', 'PATH', 'TZ']);
    assert.equal(seen.cwd, machine.root, "the CLI works in the session's own empty directory");
  } finally {
    await machine.close();
  }
});

test("upstream's model steps and journal ledger record nothing: the runner alone accounts model spend", async () => {
  const ledger = journalLedger({ append: () => { throw new Error('the ledger wrote to the journal'); } });
  ledger.turn('t1');
  ledger.add(1.5, { method: 'POST', path: '/v1/messages' });
  assert.deepEqual(ledger.spent(), { turnUsd: 0, sessionUsd: 0 });
  const ctx = new Proxy({}, { get: () => { throw new Error('a model step touched the drive'); } });
  const steps = new ModelSteps(ctx);
  steps.request();
  await steps.settleAbandoned();
  await steps.close();
  await settleAbandonedModelSteps(ctx);
});

test("a refusal never carries the request's content: a canary in every field and header is in no answer, report or error", async () => {
  const CANARY = 'CANARY-7f3a91';
  const logged = [];
  let forwarded = 0;
  const proxy = await startModelProxy({ policy, model: 'claude-main', origin: 'https://provider.invalid', credential: () => 'provider-secret', hooks: { beforeRequest: async () => {}, afterRequest: async () => {} }, log: (message, detail) => logged.push({ message, ...detail }), fetch: async () => { forwarded += 1; return new Response('{}'); } }, 'session-key');
  const text = (extra) => body({ messages: [{ role: 'user', content: `say ${CANARY}` }], metadata: { user_id: CANARY }, stop_sequences: [CANARY], ...extra });
  const requests = [
    text({ model: `claude-${CANARY}` }),
    text({ tools: [{ type: `web_search_${CANARY}`, name: CANARY }] }),
    text({ messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: `https://${CANARY}.example/x.png` } }] }] }),
    text({ messages: [{ role: 'user', content: [{ type: 'server_tool_use', name: CANARY, id: CANARY, input: { q: CANARY } }] }] }),
    text({ mcp_servers: [{ type: 'url', url: `https://${CANARY}.example`, name: CANARY }] }),
    text({ container: CANARY }),
    text({ tool_choice: { type: 'tool', name: CANARY } }),
    text({ thinking: { type: 'enabled', budget_tokens: -1, note: CANARY } }),
  ];
  const answers = [];
  const post = (payload, headers = {}) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: new URL(proxy.url).port, method: 'POST', path: '/v1/messages?beta=true', headers: { 'content-type': 'application/json', authorization: 'Bearer session-key', 'anthropic-version': '2023-06-01', ...headers } }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode, text: out, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(payload));
  });
  try {
    for (const payload of requests) answers.push(await post(payload));
    answers.push(await post(body(), { 'anthropic-beta': `claude-code-20250219,${CANARY}` }));
  } finally {
    await proxy.close();
  }
  assert.equal(forwarded, 0, 'every one was refused');
  for (const a of answers) assert.ok(a.status === 400 || a.status === 403, String(a.status));
  assert.equal(logged.length, answers.length);
  for (const where of [JSON.stringify(answers), JSON.stringify(logged)]) assert.ok(!where.includes(CANARY), where.slice(0, 300));
  for (const payload of requests) {
    try { policy.apply(payload, MESSAGES); assert.fail('not refused'); } catch (error) { assert.ok(!String(error?.message).includes(CANARY), error?.message); }
  }
});

test("a token count is free on either answer: a provider's 200 or 404 passes through, no turn is counted, and its status is said once", async () => {
  for (const status of [200, 404]) {
    const handler = gatewayHandler({ routes: [], models: { model: 'claude-main' }, credential: () => 'provider-secret', target: 'https://provider.invalid' });
    const hooks = { before: 0, after: 0 };
    const logged = [];
    const acquire = localMachine({ dir: scratch(), proxy: {
      hooks: { beforeRequest: async () => { hooks.before += 1; }, afterRequest: async () => { hooks.after += 1; } },
      tools: [],
      log: (message, detail) => logged.push({ message, ...detail }),
      fetch: async () => new Response(status === 200 ? '{"input_tokens":12}' : '{"error":{"type":"not_found_error"}}', { status }),
    } });
    const machine = await acquire({ ctx: { runId: 'r' }, model: handler });
    try {
      for (let i = 0; i < 2; i += 1) {
        const res = await fetch(`${machine.modelUrl}/v1/messages/count_tokens?beta=true`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${machine.modelKey}` }, body: JSON.stringify({ model: 'claude-main', messages: [{ role: 'user', content: 'hi' }] }) });
        assert.equal(res.status, status);
        await res.text();
      }
    } finally {
      await machine.close();
    }
    assert.deepEqual(hooks, { before: 0, after: 0 }, 'a token count is never a turn');
    assert.deepEqual(logged, [{ message: 'claude-agent: the provider answered count_tokens', status }], 'said once per session');
  }
});
