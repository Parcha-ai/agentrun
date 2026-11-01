// Codex's own web search, live (`webSearch: "live"`), through the pinned Codex binary and the adapter: the model searches
// the web (a `web_search_call` the provider ran), then submits. The provider is a scripted fetch behind the session's proxy
// answering in the Responses API's documented format, with OpenAI's `tool_usage.web_search.num_requests`. No network.
//
// Without the binary the round trip skips; with AGENTRUN_CODEX_REQUIRE_BINARY=1 (CI) a missing or different binary fails.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createHarnessRunner } from '@parcha/agentrun-adapters';
import { memorySessionStore } from '@parcha/agentrun-adapters/testing';
import { codexAdapter } from '@parcha/agentrun-codex';
import { findCodex } from '../dist/binary.js';
import { checkConfig, codexConfig, toToml } from '../dist/config.js';
import { localMachine } from '../dist/host/machine.js';
import { CODEX_ROUTES, gatewayHandler } from '../dist/host/process.js';
import { verifyCodexBinary } from '../dist/verify.js';

const binary = verifyCodexBinary(findCodex());
const problem = binary instanceof Error ? binary.message : undefined;
const skip = problem && process.env.AGENTRUN_CODEX_REQUIRE_BINARY !== '1' ? problem : false;
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-codex-search-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const LIVE_TOOL = JSON.parse(readFileSync(new URL('./fixtures/responses-request-web-search-live.json', import.meta.url), 'utf8')).tools.find((t) => t.type === 'web_search');
const usage = { input_tokens: 100, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 10, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 110 };
const sse = (n, items, searches) => [
  { type: 'response.created', response: { id: `resp_${n}`, object: 'response', status: 'in_progress' } },
  ...items.flatMap((item, i) => [{ type: 'response.output_item.added', output_index: i, item: { ...item, status: 'in_progress' } }, { type: 'response.output_item.done', output_index: i, item }]),
  { type: 'response.completed', response: { id: `resp_${n}`, object: 'response', status: 'completed', output: items, usage, tool_usage: { web_search: { num_requests: searches } } } },
].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const SEARCH = { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'capital of France' } };
const SUBMIT = { type: 'function_call', name: 'submit', arguments: JSON.stringify({ value: { answer: 'Paris' } }), call_id: 'call_submit' };
const SAY = { type: 'message', role: 'assistant', id: 'msg_2', status: 'completed', content: [{ type: 'output_text', text: 'done', annotations: [] }] };

test("the machine sets Codex's web search to live only when asked, and a caller still may not set web_search itself", async () => {
  const route = { routes: CODEX_ROUTES, models: { model: 'gpt-5.4-mini' }, credential: () => 'provider-secret', target: 'https://provider.invalid' };
  const base = { model: 'm', baseUrl: 'http://127.0.0.1:1/v1', envKey: 'KEY', contextWindow: 1000 };
  /** The config.toml the harness writes on a machine with `webSearch`: its config, through the machine's configure hook. */
  const written = async (webSearch) => {
    const acquire = localMachine({ dir: mkdtempSync(join(ROOT, 'machine-')), ...(webSearch ? { webSearch } : {}), proxy: { hooks: { beforeRequest: async () => {}, afterRequest: async () => {} }, tools: [] } });
    const machine = await acquire({ ctx: { runId: 'r' }, model: gatewayHandler(route) });
    try {
      const config = codexConfig(base);
      machine.configure?.(config);
      return { hook: typeof machine.configure, toml: toToml(config) };
    } finally {
      await machine.close();
    }
  };
  const off = await written(undefined);
  const on = await written('live');
  assert.deepEqual([off.hook, on.hook], ['undefined', 'function'], 'off, the config is written as the harness made it');
  assert.equal(off.toml, toToml(codexConfig(base)));
  assert.match(off.toml, /^web_search = "disabled"$/m);
  // On differs by that one line, and the session's provider needs no capability for it.
  assert.equal(on.toml, off.toml.replace('web_search = "disabled"\n', 'web_search = "live"\n'));
  assert.notEqual(on.toml, off.toml);
  for (const config of [{ web_search: 'live' }, { tools: { web_search: true } }, { 'tools.web_search': true }]) {
    assert.throws(() => checkConfig(config), /config\.(tools\.)?web_search is set by the harness/, JSON.stringify(config));
  }
});

test('webSearch is "live" or absent', () => {
  for (const webSearch of ['cached', 'indexed', true]) {
    assert.throws(() => codexAdapter({ model: 'gpt-5.4-mini', webSearch, provider: { origin: 'https://provider.invalid', credential: () => '' } }), /^TypeError: agentrun-codex: webSearch is "live" or absent/);
  }
});

test('web search live through the pinned binary: the run completes past a web_search_call, the proxy forwards the recorded live tool, and the search is booked', { skip, timeout: 120_000 }, async () => {
  const seen = [];
  const fetch = async (_url, init) => {
    seen.push(JSON.parse(init.body));
    const first = seen.length === 1;
    return new Response(sse(seen.length, first ? [SEARCH, SUBMIT] : [SAY], first ? 1 : 0), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const events = [];
  const codex = codexAdapter({ model: 'gpt-5.4-mini', webSearch: 'live', provider: { origin: 'https://provider.invalid', credential: () => 'provider-secret' }, sessionsDir: join(ROOT, 'sessions'), fetch, price: (_model, u) => (u.input * 2 + u.output * 8) / 1e6 });
  const runNode = createHarnessRunner(codex, { store: memorySessionStore(), timeoutMs: 90_000, onEvent: (e) => events.push(e) });
  const output = await runNode({ kind: 'agent', label: 'search', system: ['Answer.'], user: 'What is the capital of France?', schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] }, tools: [] });

  assert.deepEqual(output, { answer: 'Paris' });
  assert.equal(seen.length, 2);
  // The binary sent its live web search tool exactly as recorded (the proxy refuses any other), beside the host's submit.
  for (const body of seen) assert.deepEqual(body.tools.map((t) => (t.type === 'function' ? t.name : t)), ['submit', LIVE_TOOL]);
  // Codex took the provider's web_search_call and sends it back, unchanged, with the next request.
  assert.deepEqual(seen[1].input.filter((it) => it.type === 'web_search_call'), [SEARCH]);
  const booked = events.filter((e) => e.type === 'request_end').map((e) => e.usage);
  assert.deepEqual(booked.map((u) => u.webSearches), [1, 0]);
  const tokens = (100 * 2 + 10 * 8) / 1e6;
  assert.ok(Math.abs(booked[0].usd - (tokens + 0.01)) < 1e-12 && Math.abs(booked[1].usd - tokens) < 1e-12, JSON.stringify(booked));
});
