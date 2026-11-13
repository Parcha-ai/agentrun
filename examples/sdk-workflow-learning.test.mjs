import assert from 'node:assert/strict';
import test from 'node:test';
import { createReleaseWorkflowTools, RELEASES } from './sdk-learning/workflow-tools.mjs';

test('workflow fixture calls the same existing callbacks with fresh observed values', async () => {
  const backend = createReleaseWorkflowTools();
  const native = { signal: new AbortController().signal, runId: 'native', idempotencyKey: 'native-call' };
  const workflow = { ...native, runId: 'workflow-run', workflow: 'release-brief', idempotencyKey: 'workflow-call' };
  const first = await backend.tools[0].execute({ service: 'demo-api' }, native);
  const second = await backend.tools[0].execute({ service: 'billing-api' }, workflow);
  assert.equal(first.version, RELEASES['demo-api'].version);
  assert.equal(second.version, RELEASES['billing-api'].version);
  assert.notEqual(first.observation, second.observation);
  const report = await backend.tools[1].execute({ status: second }, workflow);
  assert.equal(report.brief, 'Release brief: billing-api 3.1.2; tests passed; ready.');
  assert.deepEqual(backend.calls.map(call => [call.tool, call.source]), [
    ['mcp:release/release_status', 'native'], ['mcp:release/release_status', 'workflow'], ['mcp:release/format_release_brief', 'workflow'],
  ]);
  await assert.rejects(backend.tools[1].execute({ status: { ...second, version: first.version } }, workflow), /observed/);
  await assert.rejects(backend.tools[1].execute({ status: { ...second, observation: 'invented' } }, workflow), /observed/);
});

test('native MCP uses the same existing callback objects and returns fresh tool evidence', { timeout: 20_000 }, async () => {
  const { serveReleaseTools } = await import('./sdk-learning/workflow-native-mcp.mjs');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const backend = createReleaseWorkflowTools(), mcp = await serveReleaseTools(backend.tools);
  const client = new Client({ name: 'release-test', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url), { requestInit: { headers: mcp.headers } }));
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['release_status', 'format_release_brief']);
    const status = await client.callTool({ name: 'release_status', arguments: { service: 'demo-api' } });
    const report = await client.callTool({ name: 'format_release_brief', arguments: { status: status.structuredContent } });
    assert.equal(report.structuredContent.brief, 'Release brief: demo-api 2.4.0; tests passed; ready.');
    assert.equal(backend.calls.length, 2);
    assert.ok(backend.calls.every(call => call.source === 'native'));
    const refused = await fetch(mcp.url, { method: 'POST', body: '{}' });
    assert.equal(refused.status, 403);
  } finally { await client.close(); await mcp.close(); }
});

test('workflow proof rejects a good answer produced by direct-tool fallback or a different seed', async () => {
  const { assertWorkflowReuse } = await import('./sdk-learning/workflow-demo.mjs');
  const backend = createReleaseWorkflowTools();
  const ctx = { signal: new AbortController().signal, runId: 'run-2', workflow: 'release-brief', idempotencyKey: 'call' };
  const status = await backend.tools[0].execute({ service: 'billing-api' }, ctx);
  const answer = await backend.tools[1].execute({ status }, ctx);
  const result = { answer: answer.brief, calls: backend.calls,
    workflowEvents: [{ type: 'workflow.end', status: 'completed', workflow: 'release-brief', runId: 'run-2' }] };
  const receipt = { runId: 'run-2', revision: 'accepted', workflows: ['release-brief'] };
  assertWorkflowReuse(result, receipt, 'accepted', ['release-brief']);
  assert.throws(() => assertWorkflowReuse({ ...result, workflowEvents: [] }, receipt, 'accepted', ['release-brief']), /No accepted workflow completed/);
  assert.throws(() => assertWorkflowReuse(result, { ...receipt, revision: 'different' }, 'accepted', ['release-brief']), /different learning revision/);
  assert.throws(() => assertWorkflowReuse({ ...result, calls: result.calls.map(call => ({ ...call, source: 'native' })) }, receipt, 'accepted', ['release-brief']), /formatter callback/);
});

function demoFixture({ held = false } = {}) {
  const counts = new Map(), prompts = [];
  const fetch = async (url, options) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/sdk-runs')) {
      const agentId = path.split('/').at(-2), turn = (counts.get(agentId) ?? 0) + 1;
      counts.set(agentId, turn);
      const enabled = agentId.endsWith('-on'), ready = enabled && turn > 5;
      return Response.json({ run_id: `${agentId}-${turn}`, agent_id: agentId, console_url: 'https://console.example/#/runs/example',
        learning: { enabled, revision: !enabled ? null : ready ? 'promoted' : 'seed', workflows: ready ? [{ name: 'release-brief' }] : [] } });
    }
    if (path.includes('/learning/files/')) return Response.json({ version: 1, root: { kind: 'call', tool: 'mcp:release/release_status' } });
    if (path.endsWith('/learning')) {
      const ready = (counts.get('fixture-on') ?? 0) >= 5;
      return Response.json({ main: ready ? 'promoted' : 'seed', skills: [{ status: 'active', run: 'teach', name: 'release-brief' }],
        workflows: ready ? [{ name: 'release-brief', file: 'workflows/release-brief/workflow.json', status: held ? 'pending' : 'active', run: 'practice' }] : [] });
    }
    throw new Error(`Unexpected ${options?.method}: ${path}`);
  };
  const createBackend = async learning => {
    const backend = createReleaseWorkflowTools();
    return {
      async report(prompt) {
        prompts.push(prompt);
        const receipt = await (await learning.fetch(`${learning.baseUrl}/agents/${learning.agentId}/sdk-runs`, { method: 'POST' })).json();
        const workflow = receipt.learning.workflows.length ? 'release-brief' : undefined;
        const ctx = { signal: new AbortController().signal, runId: receipt.run_id, idempotencyKey: receipt.run_id, ...(workflow ? { workflow } : {}) };
        const service = prompt.includes('billing-api') ? 'billing-api' : 'demo-api', from = backend.calls.length;
        const status = await backend.tools[0].execute({ service }, ctx);
        const brief = await backend.tools[1].execute({ status }, ctx);
        return { answer: brief.brief, calls: backend.calls.slice(from), workflowEvents: workflow ? [
          { type: 'workflow.start', workflow, runId: receipt.run_id }, { type: 'workflow.end', workflow, runId: receipt.run_id, status: 'completed' },
        ] : [] };
      },
      async flushLearning() {}, async close() {},
    };
  };
  return { prompts, counts, options: { runtime: 'test', createBackend, fetch, baseUrl: 'https://server.example/v2', apiKey: 'fake-test-key', agentPrefix: 'fixture' } };
}

test('workflow demo preserves ordinary practice cadence and compares the same fresh task with learning Off', async () => {
  const { demonstrateWorkflows } = await import('./sdk-learning/workflow-demo.mjs');
  const { releaseTask } = await import('./sdk-learning/workflow-tools.mjs');
  const fixture = demoFixture();
  const result = await demonstrateWorkflows(fixture.options);
  assert.deepEqual(result.stages.map(stage => stage.stage), ['teach', 'practice-1', 'practice-2', 'practice-3', 'practice-4', 'fresh-workflow-reuse', 'learning-off-control']);
  assert.equal(fixture.prompts.at(-2), releaseTask('billing-api'));
  assert.equal(fixture.prompts.at(-1), releaseTask('billing-api'));
  assert.equal(result.runs.at(-1).enabled, false);
  assert.equal(result.acceptedRevision, 'promoted');
});

test('workflow demo stops at owner review instead of approving or claiming workflow reuse', async () => {
  const { demonstrateWorkflows } = await import('./sdk-learning/workflow-demo.mjs');
  const fixture = demoFixture({ held: true });
  await assert.rejects(demonstrateWorkflows(fixture.options), /needs owner review/);
  assert.equal(fixture.prompts.length, 5);
  assert.equal(fixture.counts.has('fixture-off'), false);
});

// Script only the native model and server receipt. Execute the actual wrapper, HTTP MCP,
// pinned-workflow interpreter and original fixture callbacks for both example configurations.
for (const runtime of ['claude', 'codex']) test(`${runtime} example wires native MCP and executes the same callbacks through the real workflow bridge`, { timeout: 20_000 }, async () => {
  const { assertWorkflowReuse } = await import('./sdk-learning/workflow-demo.mjs');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const tools = createReleaseWorkflowTools().tools;
  const workflow = { v: 2, name: 'release-brief', schemas: {
    Input: tools[0].input_schema, Status: tools[0].output_schema, Brief: tools[1].output_schema,
  }, input: { schemaId: 'Input' }, output: { schemaId: 'Brief', path: 'brief' }, root: { node: 'chain', steps: [
    { node: 'call', label: 'status', via: 'tool', tool: tools[0].name, args: { service: '{service}' }, out: 'Status', as: 'status', deadline_s: 10 },
    { node: 'call', label: 'brief', via: 'tool', tool: tools[1].name, args: { status: '{status}' }, out: 'Brief', as: 'brief', deadline_s: 10 },
  ] } };
  const uploads = []; let capability, mcp;
  const learning = { agentId: 'fixture', baseUrl: 'https://server.example/v2', apiKey: 'fake-test-key', instructions: 'Report only observed facts.',
    fetch: async (url, options) => {
      const path = new URL(url).pathname;
      uploads.push(options?.body ?? '');
      if (path.endsWith('/agents/fixture')) return Response.json({ definition: { sdk: { runtime: `${runtime === 'claude' ? 'claude-agent' : 'codex'}-sdk` } } });
      if (path.endsWith('/sdk-runs')) return Response.json({ run_id: 'reuse', agent_id: 'fixture', token: 'fixture-scoped', console_url: 'https://console.example/#/runs/reuse',
        learning: { enabled: true, revision: 'accepted', context: '', skills: [], workflows: [{ name: 'release-brief', description: 'Read and format release data.', workflow: JSON.stringify(workflow) }] } });
      if (path.endsWith('/sdk-runs/reuse')) return Response.json({ run_id: 'reuse', state: 'completed', learning: { state: 'dropped' } });
      return Response.json({ accepted: true });
    },
  };
  const perform = async (prompt, servers) => {
    assert.ok(prompt.includes('"input_schema"'), 'The native agent must receive the workflow input schema.');
    capability = /Supply capability "([a-f0-9]+)"/.exec(prompt)?.[1];
    assert.ok(capability, 'The native task must receive a scoped workflow capability.');
    const original = servers.release, bridge = servers.agentrun_workflows;
    mcp = new Client({ name: 'example-native-sdk-test', version: '1.0.0' });
    const originalClient = new Client({ name: 'existing-tools-test', version: '1.0.0' });
    try {
      await originalClient.connect(new StreamableHTTPClientTransport(new URL(original.url), { requestInit: { headers: original.headers ?? original.http_headers } }));
      assert.deepEqual((await originalClient.listTools()).tools.map(tool => tool.name), ['release_status', 'format_release_brief']);
      await mcp.connect(new StreamableHTTPClientTransport(new URL(bridge.url), { requestInit: { headers: bridge.headers ?? bridge.http_headers } }));
      const result = await mcp.callTool({ name: 'learned_workflow', arguments: { capability, name: 'release-brief', input: { service: 'billing-api' } } });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      return result.content[0].text;
    } finally { await originalClient.close(); }
  };
  let backend;
  try {
    if (runtime === 'claude') {
      const { createClaudeWorkflowReleaseBackend } = await import('./sdk-learning/workflow-claude.mjs');
      backend = await createClaudeWorkflowReleaseBackend({ query: ({ prompt, options }) => (async function* () {
        assert.equal(options.model, 'keep-existing-model');
        yield { type: 'result', subtype: 'success', is_error: false, result: await perform(prompt, options.mcpServers) };
      })() }, learning, { model: 'keep-existing-model' });
    } else {
      const { createCodexWorkflowReleaseBackend } = await import('./sdk-learning/workflow-codex.mjs');
      backend = await createCodexWorkflowReleaseBackend(config => ({ startThread(options) {
        assert.equal(options.model, 'keep-existing-model'); assert.equal(options.sandboxMode, 'read-only');
        return { async run(prompt) { return { finalResponse: await perform(prompt, config.mcp_servers), items: [] }; } };
      } }), learning, { model: 'keep-existing-model' });
    }
    const result = await backend.report('Prepare a release brief for billing-api from its current release data.');
    await backend.flushLearning();
    assertWorkflowReuse(result, { runId: 'reuse', revision: 'accepted', workflows: ['release-brief'] }, 'accepted', ['release-brief']);
    assert.ok(uploads.some(body => body.includes('workflow_tools')));
    assert.ok(uploads.every(body => !body.includes(capability)), 'Capability leaked into uploaded evidence.');
    const expired = await mcp.callTool({ name: 'learned_workflow', arguments: { capability, name: 'release-brief', input: { service: 'billing-api' } } });
    assert.equal(expired.isError, true, 'The native task must revoke its capability after completion.');
  } finally { await mcp?.close(); await backend?.close(); }
});
