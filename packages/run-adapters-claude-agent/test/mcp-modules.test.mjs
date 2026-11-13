// A host that installed the Agent SDK elsewhere than beside this package (AgentRun Server, on first use, into its data)
// hands the adapter the MCP library it loaded from there (`mcp`): the session's tool server is built with that library,
// never with one imported by name here. Through the adapter and the pinned CLI, with a scripted model behind the proxy.
//
// Without the pinned CLI this skips; with AGENTRUN_CLAUDE_AGENT_REQUIRE_BINARY=1 (CI) a missing or different one fails.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createHarnessRunner } from '@parcha/agentrun-kernel';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { claudeAgentAdapter, verifyClaudeAgent } from '@parcha/agentrun-harness-claude';
import { fakeAnthropic } from '@parcha/agentrun-harness-claude/testing';

const required = process.env.AGENTRUN_CLAUDE_AGENT_REQUIRE_BINARY === '1';
let problem;
try { verifyClaudeAgent({}); } catch (error) { problem = `${error.name}: ${error.message}`; }
const skip = problem && !required ? problem : false;
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-claude-mcp-modules-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const MODEL = 'claude-sonnet-5-5';

test("an adapter handed the MCP library (mcp) serves the session's tools with it", { skip, timeout: 240_000 }, async (t) => {
  const dir = mkdtempSync(join(ROOT, 'run-'));
  const [server, types] = await Promise.all([import('@modelcontextprotocol/sdk/server/mcp.js'), import('@modelcontextprotocol/sdk/types.js')]);
  // The host's copy, told apart by what it builds: each server made with it is counted.
  let built = 0;
  const hostServer = { ...server, McpServer: class extends server.McpServer { constructor(...args) { super(...args); built += 1; } } };
  const plan = [{ tool: { name: 'mcp__hands__submit', input: { value: { answer: 'ok' } } } }];
  let main = 0;
  const provider = await fakeAnthropic({ reply: (r) => (r.model === MODEL ? plan[main++] ?? { text: 'done' } : { text: 'ok' }) });
  t.after(() => provider.close());
  const adapter = claudeAgentAdapter({ model: MODEL, provider: { origin: provider.url, credential: () => 'provider-secret' }, sessionsDir: join(dir, 'sessions'), mcp: { server: hostServer, types } });
  const runNode = createHarnessRunner(adapter, { store: memorySessionStore(), tools: [], maxTurns: 10, timeoutMs: 200_000 });
  const output = await runNode({ kind: 'agent', label: 'modules', system: ['Answer.'], user: 'Answer ok.', schema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } }, tools: [] });
  assert.deepEqual(output, { answer: 'ok' });
  assert.ok(built >= 1, `the session's tool server was built with the host's MCP library (${built} built)`);
});
