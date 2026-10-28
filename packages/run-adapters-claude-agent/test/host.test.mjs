// The Claude Agent adapter's host side, attacked directly: the Anthropic policy the session's proxy applies, the spawn
// hook that starts the CLI, and the local machine's environment. No network, no CLI.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { request } from 'node:http';
import { ProxyRefusal, startModelProxy } from '@parcha/agentrun-adapters/host';
import { anthropicPolicy } from '@parcha/agentrun-claude-agent';
import { childEnv, confined, launchCommand, localMachine } from '../dist/host/machine.js';
import { PARENT_WATCH_SHIM, parentWatched, SETPRIV } from '@parcha/agentrun-adapters/host';
import { CLAUDE_BETAS } from '../dist/host/policy.js';
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
    refused(() => apply(block(b)), 403, /a block of a type this session does not send/);
  }
  // A session sends no image or document (its tools answer in text): by URL, by Files API id or inline, none passes.
  const NOT_SENT = /a block of a type this session does not send/;
  refused(() => apply(block({ type: 'image', source: { type: 'url', url: 'https://example.com/x.png' } })), 403, NOT_SENT);
  refused(() => apply(block({ type: 'document', source: { type: 'file', file_id: 'file_1' } })), 403, NOT_SENT);
  refused(() => apply(block({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } })), 403, NOT_SENT);
  refused(() => apply(body({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'image', source: { type: 'url', url: 'https://x' } }] }] }] })), 403, NOT_SENT);
  refused(() => apply(body({ system: [{ type: 'mcp_tool_result', tool_use_id: 'm' }] })), 403, NOT_SENT);
  // What the CLI sends passes: text, thinking, a tool call and its result, in a message, the system prompt and a result.
  assert.ok(apply(body({ system: [{ type: 'text', text: 's' }], messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: [{ type: 'thinking', thinking: 't', signature: 'x' }, { type: 'redacted_thinking', data: 'x' }, { type: 'tool_use', id: 't1', name: 'mcp__hands__lookup', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'found' }] }] }] })));
});

// A block type the API adds later (a new server tool's result, say) is not one the session sends, whatever its name: in a
// message, in the system prompt and inside a tool result it refuses the request, names no type, and nothing is forwarded.
test('a content block of a type the session does not send is refused in a message, the system prompt and a tool result: 403, nothing forwarded', async () => {
  const logged = [];
  let forwarded = 0;
  const proxy = await startModelProxy({ policy, model: 'claude-main', origin: 'https://provider.invalid', credential: () => 'provider-secret', hooks: { beforeRequest: async () => {}, afterRequest: async () => {} }, log: (message, detail) => logged.push({ message, ...detail }), fetch: async () => { forwarded += 1; return new Response('{}'); } }, 'session-key');
  const post = async (payload) => {
    const res = await fetch(`${proxy.url}/v1/messages?beta=true`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer session-key', 'anthropic-version': '2023-06-01' }, body: JSON.stringify(payload) });
    return { status: res.status, text: await res.text() };
  };
  const places = {
    message: (b) => body({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }, b] }] }),
    system: (b) => body({ system: [{ type: 'text', text: 's' }, b] }),
    'tool result': (b) => body({ messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'mcp__hands__lookup', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'ok' }, b] }] }] }),
  };
  const answers = [];
  try {
    for (const type of ['tool_search_tool_result', 'future_server_tool_result']) {
      for (const [where, at] of Object.entries(places)) {
        const a = await post(at({ type, tool_use_id: 's', content: [] }));
        assert.equal(a.status, 403, `${type} in ${where}`);
        assert.match(a.text, /a block of a type this session does not send/, `${type} in ${where}`);
        answers.push(a);
      }
    }
  } finally {
    await proxy.close();
  }
  assert.equal(forwarded, 0, 'nothing was forwarded');
  for (const where of [JSON.stringify(answers), JSON.stringify(logged)]) assert.ok(!/tool_search_tool_result|future_server/.test(where), 'the refusal names no type');
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

// A beta can turn on a capability on the provider's side (its files, code execution, the web, an MCP client, computer
// use, its skills, a tool search, a wider context). The body rules refuse those tools; a beta is no way around them: a
// request that carries one is refused whole, never forwarded with the value dropped, even beside the CLI's own values.
/** Every `anthropic-beta` value the pinned CLI (2.1.286) knows, read from its beta table (and two internal markers it
 *  defines beside it): the allowlist's nine, and the ones it would send on another model, sign-in or feature. */
const CLI_BETAS = ['claude-code-20250219', 'oauth-2025-04-20', 'interleaved-thinking-2025-05-14', 'context-1m-2025-08-07', 'context-management-2025-06-27', 'structured-outputs-2025-12-15', 'web-search-2025-03-05', 'advanced-tool-use-2025-11-20', 'tool-search-tool-2025-10-19', 'effort-2025-11-24', 'task-budgets-2026-03-13', 'prompt-caching-scope-2026-01-05', 'prompt-caching-evict-2026-05-12', 'cache-keepalive-2026-09-03', 'extended-cache-ttl-2025-04-11', 'fast-mode-2026-02-01', 'redact-thinking-2026-02-12', 'thinking-resumption-2026-07-17', 'thinking-token-count-2026-05-13', 'afk-mode-2026-01-31', 'advisor-tool-2026-03-01', 'cache-diagnosis-2026-04-07', 'context-hint-2026-04-09', 'mcp-servers-2025-12-04', 'files-api-2025-04-14', 'environments-2025-11-01', 'ccr-byoc-2025-07-29', 'mid-conversation-system-2026-04-07', 'per-turn-control-2026-07-01', 'timing-2026-09-09', 'mid-conversation-tool-changes-2026-07-01', 'inline-tools-2026-09-15', 'server-side-fallback-2026-06-01', 'server-side-fallback-2026-07-01', 'fallback-credit-2026-06-01', 'x-cc-internal-mid-conv-cache-promotion', 'x-cc-internal-mid-conv-cache-promotion-ok', 'auto-mode-classifier-2026-07-16', 'dangerous-tool-use-2026-09-03', 'thinking-display-updates-2026-08-18', 'thinking-binding-controls-2026-08-01', 'message-threads-2026-08-12', 'mid-conversation-system-clear-at-2026-08-21'];
/** The API's betas for a tool the provider runs (code execution, the web, an MCP client, computer use, skills). */
const HOSTED_TOOL_BETAS = ['code-execution-2025-05-22', 'code-execution-2025-08-25', 'web-fetch-2025-09-10', 'mcp-client-2025-04-04', 'mcp-client-2025-11-20', 'computer-use-2025-01-24', 'computer-use-2025-11-24', 'skills-2025-10-02'];
const CAPABILITY_BETAS = [...CLI_BETAS.filter((b) => !CLAUDE_BETAS.has(b)), ...HOSTED_TOOL_BETAS];

test("the allowlist is a part of the pinned CLI's own beta table", () => {
  for (const beta of CLAUDE_BETAS) assert.ok(CLI_BETAS.includes(beta), beta);
  assert.equal(CAPABILITY_BETAS.length, CLI_BETAS.length - CLAUDE_BETAS.size + HOSTED_TOOL_BETAS.length);
});

test('a capability beta the allowlist lacks refuses the request through the proxy: 403, nothing forwarded, nothing dropped', async () => {
  const logged = [];
  const sent = [];
  const proxy = await startModelProxy({ policy, model: 'claude-main', origin: 'https://provider.invalid', credential: () => 'provider-secret', hooks: { beforeRequest: async () => {}, afterRequest: async () => {} }, log: (message, detail) => logged.push({ message, ...detail }), fetch: async (_url, init) => { sent.push(init); return new Response('{}', { headers: { 'content-type': 'application/json' } }); } }, 'session-key');
  const post = (beta) => fetch(`${proxy.url}/v1/messages?beta=true`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer session-key', 'anthropic-version': '2023-06-01', 'anthropic-beta': beta }, body: JSON.stringify(body()) });
  try {
    for (const beta of CAPABILITY_BETAS) {
      assert.equal(CLAUDE_BETAS.has(beta), false, beta);
      for (const value of [beta, `${[...CLAUDE_BETAS].join(',')},${beta}`, `${beta},claude-code-20250219`]) {
        const res = await post(value);
        await res.text();
        assert.equal(res.status, 403, value);
      }
    }
    assert.equal(sent.length, 0, 'nothing was forwarded');
    assert.equal(logged.filter((l) => /refused/.test(l.message)).length, CAPABILITY_BETAS.length * 3);
    // The CLI's own values, all nine at once, still pass.
    const ok = await post([...CLAUDE_BETAS].join(','));
    await ok.text();
    assert.equal(ok.status, 200);
    assert.equal(sent.length, 1);
  } finally {
    await proxy.close();
  }
});

test("usage: a stream's message_start and last message_delta, a whole body's, and nothing for a cut stream", () => {
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const stream = ev('message_start', { message: { usage: { input_tokens: 120, cache_read_input_tokens: 30, cache_creation_input_tokens: 5, output_tokens: 1 } } }) + ev('content_block_delta', { delta: { type: 'text_delta', text: 'hi' } }) + ev('message_delta', { usage: { output_tokens: 7 } }) + ev('message_delta', { usage: { output_tokens: 42 } });
  assert.deepEqual(policy.usageOf(stream + ev('message_stop', {})), { input: 120, output: 42, cacheRead: 30, cacheWrite: 5 });
  assert.equal(policy.usageOf(stream), undefined, 'a stream cut before message_stop');
  assert.deepEqual(policy.usageOf(JSON.stringify({ id: 'm', usage: { input_tokens: 3, output_tokens: 4 } })), { input: 3, output: 4, cacheRead: 0, cacheWrite: 0 });
});

// Recorded from the Messages API through a LiteLLM gateway (claude-sonnet-5-5, a cached system prompt): the stream wrote
// the cache and the whole body read it. Their usage nests objects (cache_creation, output_tokens_details).
const RECORDED_STREAM = readFileSync(new URL('./fixtures/messages-stream-claude-sonnet-5-5.sse', import.meta.url), 'utf8');
const RECORDED_BODY = readFileSync(new URL('./fixtures/messages-body-claude-sonnet-5-5.json', import.meta.url), 'utf8');
/** Each kind of token at its own rate, per million. */
const RATES = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const priced = (_model, u) => (u.input * RATES.input + u.output * RATES.output + u.cacheRead * RATES.cacheRead + (u.cacheWrite ?? 0) * RATES.cacheWrite) / 1e6;

test('a recorded real answer, streamed and whole, is booked with its input, output and cache tokens and its price', async () => {
  const booked = [];
  const answer = (text, type) => async () => new Response(text, { headers: { 'content-type': type } });
  // A long stream: the proxy keeps only its head and tail, and the usage is read across them.
  const long = RECORDED_STREAM.replace('event: content_block_stop', `${'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"' + 'x'.repeat(200) + '"}}\n\n'.repeat(1)}`.repeat(1500) + 'event: content_block_stop');
  assert.ok(long.length > 3 * 64 * 1024);
  for (const [text, type] of [[RECORDED_STREAM, 'text/event-stream'], [RECORDED_BODY, 'application/json'], [long, 'text/event-stream']]) {
    const proxy = await startModelProxy({ policy, model: 'claude-main', origin: 'https://provider.invalid', credential: () => 'provider-secret', price: priced, hooks: { beforeRequest: async () => {}, afterRequest: async (u) => { booked.push(u); } }, fetch: answer(text, type) }, 'session-key');
    try {
      const res = await fetch(`${proxy.url}/v1/messages?beta=true`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer session-key', 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body({ stream: type === 'text/event-stream' })) });
      assert.equal(await res.text(), text, 'the client gets the answer as it came');
    } finally {
      await proxy.close();
    }
  }
  const tokens = (u) => [u.input, u.output, u.cacheRead, u.cacheWrite];
  assert.deepEqual(booked.map(tokens), [[11, 15, 0, 3842], [11, 15, 3842, 0], [11, 15, 0, 3842]]);
  for (const u of booked) assert.ok(u.usd > 0 && !u.estimated, JSON.stringify(u));
  assert.equal(booked[0].usd, priced('', { input: 11, output: 15, cacheRead: 0, cacheWrite: 3842 }), 'the cache write is priced at its own rate');
  assert.equal(booked[1].usd, priced('', { input: 11, output: 15, cacheRead: 3842, cacheWrite: 0 }), 'the cache read is priced at its own rate');
});

test('usage that cannot be read stays unknown, never zero: no stop, no usage, a usage without counts, an answer that is not JSON', () => {
  const stopless = RECORDED_STREAM.split('event: message_stop')[0];
  assert.equal(policy.usageOf(stopless), undefined);
  assert.equal(policy.usageOf(RECORDED_STREAM.replace(/"usage":\{"input_tokens":11,/g, '"usage":{"in":11,').replace(/,"output_tokens":(4|15)/g, '')), undefined);
  assert.equal(policy.usageOf(JSON.stringify({ id: 'm', usage: { input_tokens: 'many', output_tokens: 4 } })), undefined);
  assert.equal(policy.usageOf('<html>gateway timeout</html>'), undefined);
  assert.equal(policy.usageOf(JSON.stringify({ id: 'm' })), undefined);
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
    // The allowlist, what the harness named, and the machine's own git ceiling (the session's directory): no host value.
    assert.deepEqual(Object.keys(seen.env).sort(), ['ANTHROPIC_AUTH_TOKEN', 'GIT_CEILING_DIRECTORIES', 'HOME', 'LANG', 'PATH', 'TZ']);
    assert.equal(seen.env.GIT_CEILING_DIRECTORIES, dirname(machine.root));
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

test("a main-model request that would not think is said (thinking.disabled), never passed silently; the small model's background calls and token counts are exempt", () => {
  const told = [];
  const watched = anthropicPolicy({ model: 'claude-main', smallModel: 'claude-small', tools: [], onThinkingDisabled: (r) => told.push(r.model) });
  const ask = (extra, r = MESSAGES) => watched.apply(body(extra), r);
  ask({ thinking: { type: 'adaptive' } });
  ask({ thinking: { type: 'enabled', budget_tokens: 2000 }, max_tokens: 4000 });
  ask({ output_config: { effort: 'medium' } });
  ask({ model: 'claude-small' });
  watched.apply({ model: 'claude-main', messages: [{ role: 'user', content: 'hi' }] }, COUNT);
  assert.deepEqual(told, [], 'thinking, a budget or an effort, the small model, and a token count are not told');
  ask({});
  ask({ thinking: { type: 'disabled' } });
  assert.deepEqual(told, ['claude-main', 'claude-main']);
  // A callback that throws never breaks the request.
  const throwing = anthropicPolicy({ model: 'claude-main', tools: [], onThinkingDisabled: () => { throw new Error('host bug'); } });
  assert.equal(throwing.apply(body(), MESSAGES).model, 'claude-main');
});

/** A session's machine under `dir`, with `confine`; returns it and a run of one child to its exit. */
async function machineAt(t, dir, confine) {
  const handler = gatewayHandler({ routes: [], models: { model: 'claude-main' }, credential: () => 'provider-secret', target: 'https://provider.invalid' });
  const acquire = localMachine({ dir, ...(confine ? { confine } : {}), env: { PATH: process.env.PATH }, proxy: { hooks: { beforeRequest: async () => {}, afterRequest: async () => {} }, tools: [] } });
  const machine = await acquire({ ctx: { runId: 'r1' }, model: handler });
  t.after(() => machine.close());
  const run = async (command, args) => {
    const proc = machine.start({ command, args, env: {} });
    let out = '';
    proc.child.stdout.on('data', (c) => { out += c; });
    const { code } = await proc.exited;
    return { code, out };
  };
  return { machine, run };
}

test("a session's git never finds a repository above the session, in a parent the model could write", async (t) => {
  const parent = mkdtempSync(join(tmpdir(), 'agentrun-ceiling-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', parent]);
  const { run } = await machineAt(t, join(parent, 'sessions', 's1'));
  const found = await run('git', ['rev-parse', '--show-toplevel']);
  assert.notEqual(found.code, 0, `git found the repository ${found.out.trim()}`);
  const env = await run(process.execPath, ['-e', 'process.stdout.write(process.env.GIT_CEILING_DIRECTORIES ?? "")']);
  assert.equal(env.out, join(parent, 'sessions', 's1'));
});

test("the host's confinement wraps a child's command and arguments, never its environment, and may only add in front", async (t) => {
  const seen = [];
  const { run } = await machineAt(t, scratch(), (c) => { seen.push(c); return { command: '/usr/bin/env', args: ['--', c.command, ...c.args] }; });
  const out = await run(process.execPath, ['-e', 'process.stdout.write(JSON.stringify([process.argv.length, Object.keys(process.env).sort()]))']);
  assert.equal(out.code, 0);
  // The confinement wraps the child as the machine launches it: watched by this process (it dies with it).
  assert.deepEqual(seen, [parentWatched({ command: process.execPath, args: ['-e', 'process.stdout.write(JSON.stringify([process.argv.length, Object.keys(process.env).sort()]))'] })]);
  assert.deepEqual(JSON.parse(out.out)[1], ['GIT_CEILING_DIRECTORIES', 'PATH'], 'the environment is the machine\'s, untouched by the confinement');
  const child = { command: '/pinned/claude', args: ['--x', 'y'] };
  assert.deepEqual(confined(child, (c) => ({ command: '/usr/bin/setpriv', args: ['--no-new-privs', '--', c.command, ...c.args] })), { command: '/usr/bin/setpriv', args: ['--no-new-privs', '--', '/pinned/claude', '--x', 'y'] });
  for (const bad of [(c) => ({ command: c.command, args: c.args }), () => ({ command: '/usr/bin/env', args: [] }), (c) => ({ command: '/bin/sh', args: ['-c', 'x', '/other', ...c.args] }), (c) => ({ command: '/usr/bin/env', args: [c.command, ...c.args, '--more'] }), () => undefined]) {
    assert.throws(() => confined(child, bad), /confinement must start the child's own command/);
  }
});

test("a child is launched with the host's confinement outermost, then the parent watch, then the child: the watch is set after any switch of user", () => {
  const child = { command: '/pinned/claude', args: ['--x', 'y'] };
  const confine = (c) => ({ command: '/usr/bin/setpriv', args: ['--no-new-privs', '--', c.command, ...c.args] });
  assert.deepEqual(launchCommand(child, confine, 'pdeathsig'), { command: '/usr/bin/setpriv', args: ['--no-new-privs', '--', SETPRIV, '--pdeathsig', 'KILL', '--', '/pinned/claude', '--x', 'y'] });
  assert.deepEqual(launchCommand(child, confine, 'shim'), { command: '/usr/bin/setpriv', args: ['--no-new-privs', '--', process.execPath, PARENT_WATCH_SHIM, String(process.pid), '--', '/pinned/claude', '--x', 'y'] });
  assert.deepEqual(launchCommand(child, undefined, 'pdeathsig'), { command: SETPRIV, args: ['--pdeathsig', 'KILL', '--', '/pinned/claude', '--x', 'y'] }, 'with no confinement, still watched');
});

test('under setpriv --no-new-privs, a child of the session runs with NoNewPrivs set', { skip: !existsSync('/usr/bin/setpriv') && 'no setpriv here' }, async (t) => {
  const { run } = await machineAt(t, scratch(), (c) => ({ command: '/usr/bin/setpriv', args: ['--no-new-privs', '--', c.command, ...c.args] }));
  const out = await run(process.execPath, ['-e', 'process.stdout.write(require("fs").readFileSync("/proc/self/status", "utf8").match(/^NoNewPrivs:\\s*(\\d)/m)[1])']);
  assert.equal(out.code, 0);
  assert.equal(out.out, '1');
});

test("a request on the session's small model is asked about and priced as the small model", async () => {
  const asked = [];
  const rates = { 'claude-main': 15, 'claude-small': 1 };
  const proxy = await startModelProxy({ policy, model: 'claude-main', origin: 'https://provider.invalid', credential: () => 'provider-secret', price: (model, u) => (u.input + u.output) * rates[model] / 1e6, hooks: { beforeRequest: async (r) => { asked.push(r.model); }, afterRequest: async (u) => { asked.push(u.usd); } }, fetch: async () => new Response(RECORDED_STREAM, { headers: { 'content-type': 'text/event-stream' } }) }, 'session-key');
  try {
    for (const model of ['claude-small', 'claude-main']) {
      const res = await fetch(`${proxy.url}/v1/messages?beta=true`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer session-key', 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body({ model, stream: true })) });
      await res.text();
    }
  } finally {
    await proxy.close();
  }
  assert.deepEqual(asked, ['claude-small', (11 + 15) * 1 / 1e6, 'claude-main', (11 + 15) * 15 / 1e6]);
});
