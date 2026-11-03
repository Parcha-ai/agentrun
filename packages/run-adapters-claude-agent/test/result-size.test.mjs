// A host tool's long result on the Claude Agent adapter: it reaches the model whole. The pinned CLI has two checks on an
// MCP tool's result. One counts characters: past 50,000 (or the tool's `anthropic/maxResultSizeChars`) the result is
// saved to tool-results/<tool_use_id>.json under the CLI's config dir and the model is told to read that file, which a
// confined session cannot. The other counts tokens: past MAX_MCP_OUTPUT_TOKENS (25,000 by default; estimated at four
// characters a token, counted exactly past half of it) the result is saved the same way, or cut when it holds an image.
// The adapter lists every host tool with the host's result bound (HOST_RESULT_MAX_CHARS) as its maxResultSizeChars and
// sets MAX_MCP_OUTPUT_TOKENS to it, so a result within the bound is neither.
//
// Without the pinned CLI the CLI tests skip; with AGENTRUN_CLAUDE_AGENT_REQUIRE_BINARY=1 (CI) they run.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import * as kernel from '@parcha/agentrun-kernel';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { claudeAgentAdapter, verifyClaudeAgent } from '@parcha/agentrun-harness-claude';
import { fakeAnthropic, fakeSdk } from '@parcha/agentrun-harness-claude/testing';

const required = process.env.AGENTRUN_CLAUDE_AGENT_REQUIRE_BINARY === '1';
let problem;
try { verifyClaudeAgent({}); } catch (error) { problem = `${error.name}: ${error.message}`; }
const skip = problem && !required ? problem : false;
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-claude-size-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
const MODEL = 'claude-sonnet-5-5';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const MODELS = { beforeRequest: async () => {}, afterRequest: async () => {} };

/** `size` characters of numbered lines, so a cut or a summary of it shows. */
const pageOf = (size) => {
  let text = '';
  for (let n = 1; text.length < size; n++) text += `line ${String(n).padStart(6, '0')}: the "answer" is forty-two.\n`;
  return text.slice(0, size);
};
/** A tool_result block's text, its blocks joined. */
const textOf = (block) => (typeof block.content === 'string' ? block.content : (block.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join(''));
const toolResults = (body) => (body?.messages ?? []).flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b?.type === 'tool_result');

/** One turn on the pinned CLI in which the model calls `tool` once, then says done: the tool_result the CLI sent back. */
async function oneCall(t, tool) {
  let main = 0;
  const provider = await fakeAnthropic({ reply: (r) => (r.model !== MODEL ? { text: 'ok' } : ++main === 1 ? { tool: { name: `mcp__hands__${tool.name}`, input: {} } } : { text: 'done' }) });
  t.after(() => provider.close());
  const adapter = claudeAgentAdapter({ model: MODEL, provider: { origin: provider.url, credential: () => 'provider-secret' }, sessionsDir: mkdtempSync(join(ROOT, 'run-')) });
  const spec = { key: `step:${tool.name}`, label: tool.name, system: ['Read the page.'], tools: [tool], context: 'fresh' };
  const store = memorySessionStore();
  const session = await adapter.open(spec, { store, writer: await store.open(spec.key), models: MODELS, signal: new AbortController().signal, onEvent: () => {} });
  await session.send('Read the page.');
  assert.equal((await session.turnEnd()).status, 'completed');
  await session.close();
  const second = provider.messages().filter((r) => r.model === MODEL)[1]?.body;
  const [result] = toolResults(second);
  assert.ok(result, 'the CLI sent the call\'s result back to the model');
  return result;
}

test("on the pinned CLI, a host tool's text result past the CLI's 50,000-character default reaches the model whole, never saved to a file it is told to read", { skip, timeout: 240_000 }, async (t) => {
  // Just under the host's bound (past the CLI's default token limit too, at four characters a token).
  const size = kernel.HOST_RESULT_MAX_CHARS - 1_000;
  const text = pageOf(size);
  const page = { name: 'page', description: 'A long page.', inputSchema: { type: 'object' }, replay: 'safe', call: async () => ({ text }) };
  const result = await oneCall(t, page);
  const got = textOf(result);
  assert.ok(!/<persisted-output>|Output too large|Output has been saved to|exceeds maximum allowed tokens/.test(got), `not saved to a file: ${got.slice(0, 300)}`);
  assert.equal(got.length, size, 'every character');
  assert.equal(got, text);
});

test("on the pinned CLI, a result with an image whose text is past the CLI's default token limit reaches the model whole: its MCP token limit is the host's bound", { skip, timeout: 240_000 }, async (t) => {
  // An image keeps a result from being saved to a file: the token check cuts it instead, at 25,000 tokens by default.
  // Just under the host's bound, past 100,000 characters (25,000 tokens at four characters a token).
  const size = kernel.HOST_RESULT_MAX_CHARS - 1_000;
  const text = pageOf(size);
  const shot = { name: 'shot', description: 'A long page and its screenshot.', inputSchema: { type: 'object' }, replay: 'safe', call: async () => ({ text, images: [{ mimeType: 'image/png', data: PNG }] }) };
  const result = await oneCall(t, shot);
  const got = textOf(result);
  assert.ok(!/OUTPUT TRUNCATED|token limit/.test(got), `not cut: ${got.slice(-400)}`);
  assert.equal(got, text, 'every character');
  assert.deepEqual(result.content.find((c) => c.type === 'image')?.source, { type: 'base64', media_type: 'image/png', data: PNG }, 'with its image');
});

test("every host tool is listed to the CLI with the host's result bound as its maxResultSizeChars, and the CLI's MAX_MCP_OUTPUT_TOKENS is that bound", async (t) => {
  process.env.AGENTRUN_CLAUDE_AGENT_STANDIN = '1';
  t.after(() => { delete process.env.AGENTRUN_CLAUDE_AGENT_STANDIN; });
  const bound = kernel.HOST_RESULT_MAX_CHARS;
  assert.equal(typeof bound, 'number', 'the kernel states the host result bound');
  const provider = await fakeAnthropic({ reply: () => ({ text: 'ok' }) });
  t.after(() => provider.close());
  const sdk = fakeSdk({ remoteModel: true, mirrorLagMs: 5, script: ['call lookup {}', 'call submit {"value":{"answer":"ok"}}'] });
  const adapter = claudeAgentAdapter({ model: 'claude-test', provider: { origin: provider.url, credential: () => 'k' }, sessionsDir: join(mkdtempSync(join(ROOT, 'listed-')), 's'), standIn: { command: process.execPath }, sdk });
  const lookup = { name: 'lookup', description: 'Look it up.', inputSchema: { type: 'object' }, replay: 'safe', call: async () => ({ text: 'found' }) };
  const runNode = kernel.createHarnessRunner(adapter, { store: memorySessionStore(), tools: [lookup] });
  assert.deepEqual(await runNode({ kind: 'agent', label: 'listed', system: [], user: 'Go.', schema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } }, tools: ['lookup'] }), { answer: 'ok' });
  const listed = sdk.listed.flat();
  assert.deepEqual([...new Set(listed.map((tool) => tool.name))].sort(), ['lookup', 'submit'], 'the host\'s tool and submit');
  for (const tool of listed) assert.equal(tool._meta?.['anthropic/maxResultSizeChars'], bound, `${tool.name}, with the bound`);
  assert.ok(sdk.queries.length > 0);
  for (const query of sdk.queries) assert.equal(query.env?.MAX_MCP_OUTPUT_TOKENS, String(bound), "the CLI's MCP token limit");
});
