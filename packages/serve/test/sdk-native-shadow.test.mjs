// Only model responses are scripted: compile cadence, native wrappers, evidence, caller-side shadow execution,
// promotion records, HTTP MCP and changed-input callbacks all use their real implementations.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { serve, follow } from './support.mjs';
import { landWorkflows } from './learned-workflow-seed-support.mjs';
import { BackendLearningClient } from '@parcha/agentrun-client/learning';
import { withClaudeAgentLearning } from '@parcha/agentrun-client/claude';
import { withCodexAgentLearning } from '@parcha/agentrun-client/codex';
import { createWorkflowBridge, createWorkflowMcpBridge } from '@parcha/agentrun-client/workflows';
import * as engine from '@parcha/agentrun-dsl';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

for (const [runtime, mismatch] of [['claude', false], ['codex', false], ['codex-stream', false], ['claude', true]]) {
  test(mismatch ? 'Claude: a draft that differs from the independent native answer stays held' : `${runtime}: native evidence compiles, independent shadow promotes, later MCP reuse sees fresh data and Off stays native`, { timeout: 90_000 }, async t => {
    const server = await serve(t, { faux: new URL('./fixtures/sdk-workflow-model.mjs', import.meta.url).pathname });
    const id = `shadow-${runtime}`;
    const calls = [], receipts = [], prompts = [];
    let ready = true;
    const callback = (args, ctx) => {
      const value = { ready };
      calls.push({ args: structuredClone(args), value, source: ctx.workflow ? 'workflow' : 'native' });
      return value;
    };
    const bridge = await createWorkflowMcpBridge({ engine, nativeMcpServerName: 'agentrun_workflows', tools: [{
      name: 'mcp:backend/status', description: 'Read release status.',
      input_schema: { type: 'object', properties: { release: { type: 'string' } }, required: ['release'] },
      output_schema: { type: 'object', properties: { ready: { type: 'boolean' } }, required: ['ready'] },
      permission: 'allow', price_usd: 0, readOnly: true, execute: callback,
    }], policy: () => 'allow' });
    const mcp = new Client({ name: 'native-shadow-proof', version: '1' });
    t.after(async () => { await mcp.close(); await bridge.close(); });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(bridge.url), { requestInit: { headers: bridge.headers } }));
    const config = { agentId: id, instructions: 'Use the backend status tool and return its JSON unchanged.',
      baseUrl: server.baseUrl, apiKey: server.token, learning: { compile_after: 1 }, workflows: bridge,
      pollIntervalMs: 5, learningTimeoutMs: 30_000,
      fetch: async (url, options) => {
        const response = await fetch(url, options);
        if (options?.method === 'POST' && new URL(url).pathname.endsWith('/sdk-runs')) {
          const receipt = await response.clone().json();
          assert.ok(response.ok, 'The original native task must be admitted.');
          receipts.push(receipt);
        }
        return response;
      },
    };
    const invocation = async prompt => {
      prompts.push(prompt);
      const capability = /Supply capability "([a-f0-9]+)"/.exec(prompt)?.[1];
      const input = { release: prompt.includes('next-release') ? 'next-release' : 'current' };
      if (capability) {
        const args = { capability, name: 'release-status', input };
        const result = await mcp.callTool({ name: 'learned_workflow', arguments: args });
        assert.ok(!result.isError, 'A promoted workflow should execute through the original callback.');
        return { name: 'mcp:agentrun_workflows/learned_workflow', args, result, answer: result.content[0].text };
      }
      const output = await callback(input, {});
      const answer = JSON.stringify(mismatch && receipts.length === 2 ? { ready: false } : output);
      return { name: 'mcp:backend/status', args: input, result: { content: [{ type: 'text', text: JSON.stringify(output) }] }, answer };
    };
    let wrapper, run;
    if (runtime === 'claude') {
      wrapper = withClaudeAgentLearning(({ prompt }) => (async function* () {
        const result = await invocation(prompt);
        const [, host, tool] = /^mcp:([^/]+)\/(.+)$/.exec(result.name);
        yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'native-call', name: `mcp__${host}__${tool}`, input: result.args }] } };
        yield { type: 'user', tool_use_result: result.result, message: { content: [{ type: 'tool_result', tool_use_id: 'native-call', content: result.result.content }] } };
        yield { type: 'result', subtype: 'success', is_error: false, result: result.answer };
      })(), config);
      run = async prompt => { let answer; for await (const event of wrapper({ prompt })) if (event.type === 'result') answer = event.result; return answer; };
    } else {
      const item = result => {
        const [, server, tool] = /^mcp:([^/]+)\/(.+)$/.exec(result.name);
        return { type: 'mcp_tool_call', id: 'native-call', server, tool, arguments: result.args, status: 'completed', result: { content: result.result.content } };
      };
      wrapper = withCodexAgentLearning({ startThread: () => ({ id: null,
        async run(prompt) { const result = await invocation(prompt); return { finalResponse: result.answer, items: [item(result)] }; },
        async runStreamed(prompt) { return { events: (async function* () {
          const result = await invocation(prompt);
          yield { type: 'item.completed', item: item(result) };
          yield { type: 'item.completed', item: { type: 'agent_message', text: result.answer } };
          yield { type: 'turn.completed' };
        })() }; },
      }) }, config);
      run = runtime === 'codex' ? async prompt => (await wrapper.startThread().run(prompt)).finalResponse : async prompt => {
        let answer;
        for await (const event of (await wrapper.startThread().runStreamed(prompt)).events) if (event.item?.type === 'agent_message') answer = event.item.text;
        return answer;
      };
    }
    assert.equal(await run('{"release":"current"}'), '{"ready":true}');
    await wrapper.flushLearning();
    const compiled = (await server.api('GET', `/agents/${id}/learning`)).body;
    assert.equal(compiled.workflows[0].status, 'checking', 'Compilation alone must never promote.');
    assert.equal(receipts[0].learning.check, undefined);
    assert.deepEqual(receipts[0].learning.workflows, []);

    const beforeCheck = calls.length;
    assert.equal(await run('{"release":"current"}'), mismatch ? '{"ready":false}' : '{"ready":true}');
    await wrapper.flushLearning();
    const check = receipts[1].learning.check;
    assert.equal(check.workflow.name, 'release-status');
    assert.deepEqual(receipts[1].learning.workflows, []);
    assert.equal(prompts[1], '{"release":"current"}', 'The native model must not receive the candidate or shadow capability.');
    assert.equal(calls.length, beforeCheck + 1, 'The shadow reuses recorded evidence without repeating the callback.');
    assert.equal(calls.at(-1).source, 'native');
    const promotions = (await server.api('GET', `/agents/${id}/learning/promotions`)).body;
    if (mismatch) {
      const held = promotions.promotions.findLast(record => record.decided === 'hold');
      assert.ok(held, JSON.stringify(promotions));
      assert.equal(held.digest, check.digest);
      assert.deepEqual([held.check.n, held.check.alone, held.check.agreed], [1, 1, 0]);
      assert.equal(promotions.promotions.some(record => record.decided === 'promote'), false);
      assert.equal((await server.api('GET', `/agents/${id}/learning`)).body.workflows[0].status, 'held');
      assert.equal(calls.length, 2, 'A mismatch is recorded, not retried to seek agreement.');
      return;
    }
    const promoted = promotions.promotions.findLast(record => record.decided === 'promote');
    assert.equal(promoted.digest, check.digest);
    assert.deepEqual([promoted.check.n, promoted.check.alone, promoted.check.agreed], [1, 1, 1]);
    assert.equal((await server.api('GET', `/agents/${id}/learning`)).body.workflows[0].status, 'serving');

    ready = false;
    assert.equal(await run('{"release":"next-release"}'), '{"ready":false}');
    await wrapper.flushLearning();
    assert.deepEqual(receipts[2].learning.workflows.map(workflow => workflow.name), ['release-status']);
    assert.equal(receipts[2].learning.check, undefined);
    assert.equal(calls.at(-1).source, 'workflow');
    assert.equal(calls.at(-1).args.release, 'next-release');
    assert.equal(calls.at(-1).value.ready, false, 'Reuse reads changed live data, not the shadow recording.');

    assert.equal((await server.api('PUT', `/agents/${id}/definition`, { definition: { instructions: config.instructions, learning: false } })).status, 200);
    assert.equal(await run('{"release":"next-release"}'), '{"ready":false}');
    await wrapper.flushLearning();
    assert.deepEqual(receipts[3].learning.workflows, []);
    assert.equal(receipts[3].learning.check, undefined);
    assert.equal(receipts[3].learning.enabled, false);
    assert.equal(calls.at(-1).source, 'native');
    assert.equal(calls.length, 4, 'Four native requests perform four original callback invocations.');
  });
}


test('client-side redaction cannot turn different protected native and shadow answers into an agreement', { timeout: 30_000 }, async t => {
  const server = await serve(t), id = 'shadow-client-redaction';
  assert.equal((await server.api('POST', '/agents', { definition: {
    id, name: id, instructions: 'Use original permissions.', sdk: { runtime: 'eve' },
    learning: { compile_after: 200 }, tools: [],
  } })).status, 201);
  const tool = { name: 'mcp:backend/status', description: 'Return a status string.',
    input_schema: { type: 'object' }, output_schema: { type: 'string' }, permission: 'allow', price_usd: 0 };
  await landWorkflows(server.data, id, [{ name: 'status', description: 'Read a status string.', workflow: {
    v: 2, name: 'status', schemas: { Input: { type: 'object' }, Answer: { type: 'string' } },
    input: { schemaId: 'Input' }, output: { schemaId: 'Answer', path: 'answer' },
    root: { node: 'call', label: 'read', via: 'tool', tool: tool.name, args: {}, out: 'Answer', as: 'answer', deadline_s: 5 },
  } }]);
  const bridge = createWorkflowBridge({ engine, tools: [{ ...tool, readOnly: true,
    execute() { assert.fail('Shadow replay must not invoke a callback again.'); },
  }], policy: () => 'allow' });
  t.after(() => bridge.close());
  const uploads = [];
  const client = new BackendLearningClient({ agentId: id, baseUrl: server.baseUrl, apiKey: server.token,
    workflows: bridge, maxRetries: 0, fetch: async (url, options) => {
      if (/\/(events|complete)$/.test(new URL(url).pathname)) uploads.push(JSON.parse(options.body));
      return fetch(url, options);
    },
  });
  const session = await client.begin({ runtime: 'eve', input: '{}', instructions: 'Use original permissions.' });
  const checkpoint = session.checkpoint(), nativeAnswer = server.token, shadowAnswer = checkpoint.receipt.token;
  assert.notEqual(nativeAnswer, shadowAnswer, 'The actual native and shadow answers differ.');
  assert.ok(checkpoint.receipt.learning.check, 'The real server must reserve the draft.');
  const events = [
    { type: 'tool', id: 'native', name: tool.name, status: 'started', input: {} },
    { type: 'tool', id: 'native', name: tool.name, status: 'completed' },
  ];
  const nativeEvents = [events[0], { ...events[1], output: shadowAnswer }];
  await session.submit(events, { status: 'completed', answer: nativeAnswer }, { nativeEvents, waitForLearning: false });
  await follow(server.api, session.runId, ['completed']);
  const body = (await server.api('GET', `/agents/${id}/learning/promotions`)).body;
  assert.equal(body.promotions.some(record => record.decided === 'promote'), false,
    'Distinct protected answers must not promote after both are redacted to the same placeholder.');
  const held = body.promotions.findLast(record => record.decided === 'hold');
  assert.ok(held, 'The unchecked comparison remains held.');
  assert.equal(held.check.agreed, 0);
  const written = JSON.stringify(uploads);
  assert.ok(!written.includes(nativeAnswer) && !written.includes(shadowAnswer), 'Neither protected value leaves the client.');
});
