import assert from 'node:assert/strict';
import test from 'node:test';
import { demonstrate, TASK } from './sdk-learning/demo.mjs';
import { createCodexReleaseBackend } from './sdk-learning/codex.mjs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

function fixture({ notes = [], skills = [], seedSkills = [], context = '' }) {
  const requests = [], calls = [];
  const counts = new Map();
  const fetch = async (url, options) => {
    const path = new URL(url).pathname;
    requests.push(path);
    if (path.endsWith('/learning')) return Response.json({ main: 'accepted-revision', notes: { items: notes }, skills });
    if (path.endsWith('/sdk-runs')) {
      const agentId = path.split('/').at(-2), turn = (counts.get(agentId) ?? 0) + 1;
      counts.set(agentId, turn);
      const enabled = agentId.endsWith('-on'), seeded = enabled && turn > 1;
      return Response.json({ run_id: `${agentId}-${turn}`, agent_id: agentId, console_url: 'https://console.example/#/runs/test',
        learning: { enabled, revision: seeded ? 'accepted-revision' : null,
          context: seeded ? context : '', skills: seeded ? seedSkills : [] } });
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
  return { calls, requests, run: () => demonstrate({ runtime: 'test', createBackend, fetch, baseUrl: 'https://server.example/v2', apiKey: 'fixture-key', agentPrefix: 'fixture' }) };
}

test('SDK live demo accepts a checked run-origin note and verifies fresh reuse without the teaching prompt', async () => {
  const source = fixture({ notes: [{ status: 'active', origin: 'run', file: 'notes/release.md' }], context: 'Approved note content.' });
  const result = await source.run();
  assert.deepEqual(result.acceptedLessonFiles, ['notes/release.md']);
  assert.equal(source.calls[1].prompt, TASK);
  assert.equal(source.calls[2].prompt, TASK);
  assert.equal(result.runs[1].contextPresent, true);
});

test('SDK live demo also accepts an independently checked active skill, including a skill-only seed', async () => {
  const source = fixture({ skills: [
    { name: 'release', file: 'skills/release/SKILL.md', status: 'active', run: 'teaching-run', last_change: { by: 'run' } },
    { name: 'pending', file: 'skills/pending/SKILL.md', status: 'pending', run: 'teaching-run' },
    { name: 'manual', file: 'skills/manual/SKILL.md', status: 'active', run: null },
  ], seedSkills: [{ name: 'release', files: { 'SKILL.md': 'Approved release reporting skill.' } }] });
  const result = await source.run();
  assert.deepEqual(result.acceptedLessonFiles, ['skills/release/SKILL.md']);
  assert.equal(result.runs[1].contextPresent, true);
});

test('pending notes and skills cannot count as accepted learning or trigger the reuse call', async () => {
  const source = fixture({ notes: [{ status: 'pending', origin: 'run', file: 'notes/pending.md' }],
    skills: [{ name: 'pending', file: 'skills/pending/SKILL.md', status: 'pending', run: 'teaching-run' }] });
  await assert.rejects(source.run(), /No checked (?:note|learning|lesson)/);
  assert.equal(source.calls.length, 1);
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
      console_url: 'https://console.example/#/runs/run', learning: { enabled: false, revision: null, context: '', skills: [] } });
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
    baseUrl: 'https://server.example/v2', apiKey: 'fixture-owner', fetch, pollIntervalMs: 1 }, {});
  const result = await backend.report(TASK);
  await backend.flushLearning();
  assert.equal(result.toolCalls, 1);
});
