import assert from 'node:assert/strict';
import test from 'node:test';
import { CORRECTION, demonstrate, TASK } from './sdk-learning/demo.mjs';
import { createCodexReleaseBackend } from './sdk-learning/codex.mjs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/** A server whose corrections.md starts as `start`; a fresh run of the On agent is given `context(corrections)`. */
function fixture({ start = '', context = (text) => text } = {}) {
  const requests = [], calls = [];
  const counts = new Map();
  let corrections = start, version = 1;
  const fetch = async (url, options) => {
    const path = new URL(url).pathname;
    requests.push(path);
    if (path.endsWith('/learning/corrections')) {
      if (options?.method === 'PUT') { corrections = JSON.parse(options.body).text; version += 1; }
      return Response.json({ text: corrections, etag: `"v${version}"`, cap_bytes: 2048 }, { headers: { etag: `"v${version}"` } });
    }
    if (path.endsWith('/learning')) return Response.json({ main: `main-${version}`, corrections, workflows: [] });
    if (path.endsWith('/sdk-runs')) {
      const agentId = path.split('/').at(-2), turn = (counts.get(agentId) ?? 0) + 1;
      counts.set(agentId, turn);
      const enabled = agentId.endsWith('-on');
      return Response.json({ run_id: `${agentId}-${turn}`, agent_id: agentId, console_url: 'https://console.example/#/runs/test',
        learning: { enabled, revision: enabled ? `main-${version}` : null, context: enabled ? context(corrections) : '' } });
    }
    throw new Error(`Unexpected route: ${options?.method} ${path}`);
  };
  const createBackend = options => ({
    async report(prompt) {
      calls.push({ agentId: options.agentId, prompt });
      await options.fetch(`${options.baseUrl}/agents/${options.agentId}/sdk-runs`, { method: 'POST' });
      return { answer: `${options.learning ? 'Release brief: ' : ''}demo-api 2.4.0 is ready; tests passed.`, toolCalls: 1 };
    },
    async flushLearning() {},
  });
  return { calls, requests, run: () => demonstrate({ runtime: 'test', createBackend, fetch, baseUrl: 'https://server.example/v2', apiKey: 'fake-test-key', agentPrefix: 'fixture' }) };
}

test('SDK live demo appends the owner\'s correction to what corrections.md held and verifies fresh reuse without it in the prompt', async () => {
  const source = fixture({ start: '- Name the service first.' });
  const result = await source.run();
  assert.equal(result.corrections, `- Name the service first.\n- ${CORRECTION}\n`);
  assert.equal(result.correctedRevision, 'main-2');
  assert.deepEqual(source.calls.map((call) => call.prompt), [TASK, TASK, TASK]);
  assert.equal(result.runs[1].correctionGiven, true);
});

test('a fresh run not given the correction fails the demo, whatever its answer says', async () => {
  const source = fixture({ context: () => '' });
  await assert.rejects(source.run(), /was not given the owner's correction/);
  assert.equal(source.calls.length, 3);
});

test('Codex restricted-container example exposes a real read-only MCP tool with observed release facts', { timeout: 20_000 }, async () => {
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('./sdk-learning/release-mcp.mjs', import.meta.url))], stderr: 'pipe' });
  const client = new Client({ name: 'sdk-example-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(tool => tool.name), ['release_status']);
    assert.equal(listed.tools[0].annotations.readOnlyHint, true);
    const result = await client.callTool({ name: 'release_status', arguments: {} });
    assert.deepEqual(JSON.parse(result.content[0].text), { service: 'demo-api', version: '2.4.0', state: 'ready', tests: 'passed' });
    assert.equal(result.isError, undefined);
  } finally { await client.close(); await transport.close(); }
});

test('Codex backend success evidence counts a completed MCP tool and excludes failed native commands', async () => {
  const fetch = async (url, options) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/agents/backend')) return Response.json({ definition: { sdk: { runtime: 'codex-sdk' } } });
    if (path.endsWith('/sdk-runs')) return Response.json({ run_id: 'run', agent_id: 'backend', token: 'fixture-scoped',
      console_url: 'https://console.example/#/runs/run', learning: { enabled: false, revision: null, context: '' } });
    if (path.endsWith('/sdk-runs/run')) return Response.json({ run_id: 'run', state: 'completed', learning: null });
    return Response.json({ accepted: true });
  };
  const native = { startThread: () => ({ id: null, async run() { return {
    finalResponse: 'demo-api 2.4.0 is ready; tests passed.', usage: null, items: [
      { id: 'failed-shell', type: 'command_execution', status: 'failed' },
      { id: 'read-status', type: 'mcp_tool_call', server: 'release', tool: 'release_status', status: 'completed' },
    ],
  }; }, async runStreamed() { throw new Error('Not used in this test'); } }) };
  const backend = createCodexReleaseBackend(native, { agentId: 'backend', instructions: 'Read-only reports.',
    baseUrl: 'https://server.example/v2', apiKey: 'fake-test-key', fetch, pollIntervalMs: 1 }, {});
  const result = await backend.report(TASK);
  await backend.flushLearning();
  assert.equal(result.toolCalls, 1);
});
