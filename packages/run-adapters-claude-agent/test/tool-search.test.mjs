// Claude Code's own tool search, on when the session has an MCP server's tools (`mcp__<server>__<tool>`): the CLI runs
// with ENABLE_TOOL_SEARCH=true and its ToolSearch among its tools, so the MCP tools (served through `hands`) are deferred
// and each reaches the model once ToolSearch finds it; the session's other tools are listed to load always. The session's
// proxy admits what the pinned CLI sends with it on (its beta, ToolSearch and its placeholder, a tool_reference naming
// one of the session's own tools inside a tool result) and nothing more; without MCP tools all of it stays refused.
//
// The real-CLI cases skip without the pinned CLI; with AGENTRUN_CLAUDE_AGENT_REQUIRE_BINARY=1 (CI) a missing or different
// one fails. No network: the provider is a scripted Anthropic API on the loopback interface.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ProxyRefusal } from '@parcha/agentrun-kernel/host';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { anthropicPolicy, claudeAgentAdapter, verifyClaudeAgent } from '@parcha/agentrun-harness-claude';
import { fakeAnthropic } from '@parcha/agentrun-harness-claude/testing';
import { claudeToolSearch } from '../dist/harness.js';
import { CLAUDE_TOOL_SEARCH_BETA } from '../dist/host/policy.js';
import { ALWAYS_LOAD_KEY, listedTools } from '../dist/host/tool-server.js';

const required = process.env.AGENTRUN_CLAUDE_AGENT_REQUIRE_BINARY === '1';
let problem;
try { verifyClaudeAgent({}); } catch (error) { problem = `${error.name}: ${error.message}`; }
const skip = problem && !required ? problem : false;
const MODEL = 'claude-sonnet-5-5';
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-claude-tool-search-'));
const MESSAGES = { method: 'POST', path: '/v1/messages', query: ['beta=true'] };

const refused = (fn, status, words) => assert.throws(fn, (error) => error instanceof ProxyRefusal && error.status === status && words.test(error.message));

test('tool search is on exactly when the session has an MCP server\'s tools, and only those wait behind it', () => {
  assert.equal(claudeToolSearch(['lookup', 'mcp__github__get_issue']), 'true');
  assert.equal(claudeToolSearch(['lookup', 'tools_search']), 'false');
  const listed = listedTools([{ name: 'lookup', description: 'd', inputSchema: { type: 'object' } }, { name: 'mcp__github__get_issue', description: 'd', inputSchema: { type: 'object' } }]);
  assert.equal(listed[0]._meta[ALWAYS_LOAD_KEY], true, 'a tool of the session\'s own is never deferred');
  assert.equal(listed[1]._meta[ALWAYS_LOAD_KEY], undefined, 'an MCP server\'s tool is deferred');
});

test('the proxy admits the tool search\'s beta, tools and references only with it on, and a reference only to one of the session\'s tools', () => {
  const on = anthropicPolicy({ model: MODEL, tools: ['lookup', 'mcp__github__get_issue'], toolSearch: true });
  const off = anthropicPolicy({ model: MODEL, tools: ['lookup', 'mcp__github__get_issue'] });
  const beta = `claude-code-20250219,${CLAUDE_TOOL_SEARCH_BETA}`;
  assert.equal(on.header('anthropic-beta', beta), beta);
  refused(() => off.header('anthropic-beta', beta), 403, /not one the pinned CLI sends/);
  const body = (name) => ({
    model: MODEL,
    max_tokens: 1000,
    tools: [{ name: 'ToolSearch', description: 'd', input_schema: { type: 'object' } }, { name: 'DeferredToolPlaceholder', description: 'd', input_schema: { type: 'object' }, defer_loading: true }, { name: 'mcp__hands__mcp__github__get_issue', description: 'd', input_schema: { type: 'object' }, defer_loading: true }],
    messages: [
      { role: 'user', content: 'find it' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'ToolSearch', input: { query: 'issue' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'tool_reference', tool_name: name }] }] },
    ],
  });
  const sent = on.apply(body('mcp__hands__mcp__github__get_issue'), MESSAGES, {});
  assert.deepEqual(sent.tools.map((tool) => tool.name), ['ToolSearch', 'DeferredToolPlaceholder', 'mcp__hands__mcp__github__get_issue'], 'its tools pass, the deferred one with them');
  refused(() => on.apply(body('mcp__hands__other'), MESSAGES, {}), 403, /tool reference to a tool this session does not have/);
  refused(() => on.apply(body('Bash'), MESSAGES, {}), 403, /tool reference to a tool this session does not have/);
  refused(() => off.apply(body('mcp__hands__mcp__github__get_issue'), MESSAGES, {}), 403, /a block of a type this session does not send/);
  assert.deepEqual(off.apply({ ...body('x'), messages: [{ role: 'user', content: 'hi' }] }, MESSAGES, {}).tools.map((tool) => tool.name), ['mcp__hands__mcp__github__get_issue'], 'off, ToolSearch and its placeholder are dropped');
});

/** A real-CLI session over `tools` whose model, when ToolSearch is offered, searches for "weather city", then calls the
 *  weather tool, then answers: what ran, and each main-model request. */
async function session(t, tools) {
  let n = 0;
  const provider = await fakeAnthropic({
    reply: (request) => {
      if (request.model !== MODEL) return { text: 'title' };
      n += 1;
      if (n === 1 && request.tools.includes('ToolSearch')) return { tool: { name: 'ToolSearch', input: { query: 'weather city', max_results: 3 } } };
      if (!request.messages.some((message) => Array.isArray(message.content) && message.content.some((block) => block.type === 'tool_use' && block.name !== 'ToolSearch'))) return { tool: { name: 'mcp__hands__mcp__probe__weather', input: { city: 'Paris' } } };
      return { text: 'done' };
    },
  });
  t.after(() => provider.close());
  const store = memorySessionStore();
  const spec = { key: `step:tool-search-${tools.length}`, label: 'tool-search', system: ['Answer briefly.'], tools, context: 'fresh' };
  const models = { beforeRequest: async () => {}, afterRequest: async () => {}, note: () => undefined };
  const adapter = claudeAgentAdapter({ model: MODEL, provider: { origin: provider.url, credential: () => 'provider-secret' }, sessionsDir: mkdtempSync(join(ROOT, 's-')) });
  const open = await adapter.open(spec, { store, writer: await store.open(spec.key), models, signal: new AbortController().signal, onEvent: () => {} });
  await open.send('What is the weather in Paris?');
  const end = await open.turnEnd();
  await open.close();
  return { end, main: provider.messages().filter((request) => request.model === MODEL) };
}

const ran = [];
const weather = { name: 'mcp__probe__weather', description: 'Look up the weather in a city.', inputSchema: { type: 'object', properties: { city: { type: 'string' } } }, replay: 'safe', call: async (args) => (ran.push(args), { text: 'sunny' }) };
const filler = Array.from({ length: 20 }, (_, i) => ({ name: `mcp__probe__other_${i}`, description: `Another MCP tool ${i}.`, inputSchema: { type: 'object', properties: {} }, replay: 'safe', call: async () => ({ text: 'other' }) }));
const lookup = { name: 'lookup', description: 'Look a thing up.', inputSchema: { type: 'object', properties: {} }, replay: 'safe', call: async () => ({ text: 'found' }) };

test('the real CLI with an MCP server\'s tools: they are deferred, ToolSearch finds one through hands, and it runs once', { skip, timeout: 180_000 }, async (t) => {
  ran.length = 0;
  const { end, main } = await session(t, [lookup, weather, ...filler]);
  assert.equal(end.status, 'completed', JSON.stringify(end).slice(0, 300));
  const first = main[0].body;
  const offered = first.tools.map((tool) => tool.name);
  assert.ok(offered.includes('ToolSearch'), `ToolSearch is offered: ${JSON.stringify(offered)}`);
  assert.ok(offered.includes('mcp__hands__lookup'), `the session's own tool loads always: ${JSON.stringify(offered)}`);
  assert.ok(!offered.some((name) => name.startsWith('mcp__hands__mcp__probe__')), `the MCP tools wait behind the search: ${JSON.stringify(offered)}`);
  assert.match(main[0].headers['anthropic-beta'], new RegExp(CLAUDE_TOOL_SEARCH_BETA));
  const second = main[1].body;
  const result = second.messages.flatMap((message) => (Array.isArray(message.content) ? message.content : [])).find((block) => block.type === 'tool_result');
  assert.deepEqual(result.content.filter((block) => block.type === 'tool_reference').map((block) => block.tool_name), ['mcp__hands__mcp__probe__weather'], 'ToolSearch found the tool through hands');
  assert.ok(second.tools.some((tool) => tool.name === 'mcp__hands__mcp__probe__weather' && tool.defer_loading === true), 'and the found tool reached the model');
  assert.deepEqual(ran, [{ city: 'Paris' }], 'the found tool ran once');
});

test('the real CLI with no MCP server\'s tools: no tool search, every tool offered whole', { skip, timeout: 180_000 }, async (t) => {
  ran.length = 0;
  const { end, main } = await session(t, [lookup, { ...weather, name: 'weather' }]);
  assert.equal(end.status, 'completed', JSON.stringify(end).slice(0, 300));
  const offered = main[0].body.tools.map((tool) => tool.name);
  assert.deepEqual(offered.sort(), ['mcp__hands__lookup', 'mcp__hands__weather'], JSON.stringify(offered));
  assert.doesNotMatch(main[0].headers['anthropic-beta'], new RegExp(CLAUDE_TOOL_SEARCH_BETA));
});
