// Real native SDK execution, HTTP receipts, compilation, checked Git commits and local MCP execution.
// Only model responses are scripted; no provider credentials or paid calls are used.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import * as engine from '@parcha/agentrun-dsl';
import { createWorkflowMcpBridge } from '@parcha/agentrun-client/workflows';
import { withLangGraphLearning } from '@parcha/agentrun-client/langgraph';
import { withOpenAIAgentsLearning } from '@parcha/agentrun-client/openai-agents';
import { nativeLangGraphWorkflow, langGraphAdapters, langGraphPolicy } from '../../client/test/langgraph-native-fixture.mjs';
import { nativeOpenAIAgentsWorkflow } from '../../client/test/openai-agents-native-fixture.mjs';
import { learningRepo, seedOf } from '../dist/learning.js';
import { serve } from './support.mjs';

const instructions = langGraphPolicy;
const statusTool = {
  name: 'mcp:backend/status', description: 'Return the release ready boolean.',
  input_schema: { type: 'object', properties: { release: { type: 'string' } }, required: ['release'] },
  output_schema: { type: 'object', properties: { ready: { type: 'boolean' } }, required: ['ready'] },
  permission: 'allow', readOnly: true,
};

async function langgraph(bridge, execute, config) {
  const native = await nativeLangGraphWorkflow({ bridge, execute });
  const wrapped = withLangGraphLearning(native.graph, { ...config, ...langGraphAdapters, instructions, workflows: bridge });
  return { ...native, flush: () => wrapped.flushLearning(),
    async run(task, thread) {
      const result = await wrapped.invoke({ messages: [{ role: 'user', content: task }] }, { configurable: { thread_id: thread } });
      return result.messages.at(-1).content;
    },
  };
}

async function openai(bridge, execute, config) {
  const native = await nativeOpenAIAgentsWorkflow({ bridge, execute });
  const wrapped = withOpenAIAgentsLearning(native.nativeRun, {
    ...config, instructions: native.policy, callModelInputFilter: null, workflows: bridge,
  });
  return { ...native, get calls() { return native.calls; }, flush: () => wrapped.flushLearning(),
    async run(task) { return (await wrapped(native.agent, task)).finalOutput; },
  };
}

for (const [runtime, setup] of [['langgraph', langgraph], ['openai-agents-sdk', openai]]) {
  for (const priced of [true, false]) test(`${runtime}: native runs ${priced ? 'compile, version and consume a workflow' : 'withhold a workflow awaiting owner approval'}`, { timeout: 90_000 }, async t => {
    const server = await serve(t, { faux: new URL('./fixtures/sdk-workflow-model.mjs', import.meta.url).pathname });
    const agentId = `${runtime}-${priced ? 'learned' : 'pending'}`;
    const callbacks = [], policies = [], receipts = [], completions = [];
    const execute = input => { callbacks.push(input); return { ready: callbacks.length === 1 }; };
    const bridge = await createWorkflowMcpBridge({ engine, nativeMcpServerName: 'agentrun',
      tools: [{ ...statusTool, ...(priced ? { price_usd: 0 } : {}), execute }],
      policy: (name, input) => { policies.push({ name, input }); return 'allow'; },
    });
    t.after(() => bridge.close());
    const native = await setup(bridge, execute, {
      baseUrl: server.baseUrl, apiKey: server.token, agentId, learning: { compile_after: 1 },
      pollIntervalMs: 10, learningTimeoutMs: 60_000,
      fetch: async (url, init) => {
        if (new URL(url).pathname.endsWith('/complete')) completions.push(JSON.parse(init.body));
        const response = await fetch(url, init);
        if (response.ok && new URL(url).pathname.endsWith('/sdk-runs')) receipts.push(await response.clone().json());
        return response;
      },
    });
    t.after(() => native.close());

    assert.equal(await native.run('Check release current readiness.', 'first'), '{"ready":true}');
    await native.flush();
    assert.deepEqual(receipts[0].learning.workflows, [], 'first native run receives no pre-seeded workflow');
    assert.equal(callbacks.length, 1, 'the first run executes the original native callback');
    assert.equal(policies.length, 0, 'the native first run needs no workflow bridge');
    const first = (await server.api('GET', `/runs/${receipts[0].run_id}/learning`)).body;
    assert.equal(first.compiled.workflow, 'release-status', JSON.stringify(first));
    assert.ok(first.compiled.attempts.some(attempt => attempt.ok), 'the draft passes the real compiler checks');
    const folder = learningRepo(server.data, agentId);
    const committed = (await seedOf(server.data, agentId)).sha;
    assert.ok(committed && committed !== receipts[0].learning.revision, 'compilation creates a new Git revision');
    const stored = await readFile(join(folder, 'workflows/release-status/workflow.json'), 'utf8');
    assert.equal(JSON.parse(stored).root.tool, statusTool.name);

    const before = native.calls.length;
    assert.equal(await native.run('Check release current readiness again.', 'second'), '{"ready":false}', 'the next run observes the live callback result, not the first answer');
    await native.flush();
    assert.equal(receipts[1].learning.revision, committed, 'the next receipt pins the compiled revision');
    const secondInput = JSON.stringify(native.calls.slice(before));
    if (priced) {
      assert.deepEqual(receipts[1].learning.workflows.map(flow => flow.name), ['release-status']);
      assert.equal(receipts[1].learning.workflows[0].workflow, stored, 'the native run receives the committed workflow bytes');
      assert.match(secondInput, /Approved workflows for this task/);
      assert.match(secondInput, /release-status/);
      assert.equal(native.toolCalls.filter(call => call.name.includes('learned_workflow')).length, 1);
      assert.equal(policies.length, 1, 'workflow execution checks the original live host policy');
      assert.equal(callbacks.length, 2, 'the learned workflow calls the same original callback once');
      assert.deepEqual(policies[0], { name: statusTool.name, input: { release: 'current' } });
      const second = await server.store.runs.get(receipts[1].run_id);
      assert.equal(second.metrics.path, 'workflow', 'the native MCP envelope is not double counted as agent work');
    } else {
      assert.deepEqual(receipts[1].learning.workflows, []);
      assert.doesNotMatch(secondInput, /Approved workflows for this task/);
      assert.equal(native.toolCalls.filter(call => call.name.includes('learned_workflow')).length, 0);
      assert.equal(policies.length, 0);
      assert.equal(callbacks.length, 2, 'a pending workflow leaves the second native callback in place');
      const learning = (await server.api('GET', `/agents/${agentId}/learning`)).body;
      assert.equal(learning.workflows[0].status, 'pending', 'an unpriced callback still needs owner approval');
    }

    assert.equal((await server.api('PUT', `/agents/${agentId}/definition`, { definition: { instructions, learning: false } })).status, 200);
    const beforeOff = native.calls.length, policyCount = policies.length;
    assert.equal(await native.run('Check release current readiness with learning off.', 'off'), '{"ready":false}');
    await native.flush();
    assert.equal(receipts[2].learning.enabled, false, 'wrapper opt-in never overwrites an existing owner setting');
    assert.deepEqual(receipts[2].learning.workflows, []);
    assert.doesNotMatch(JSON.stringify(native.calls.slice(beforeOff)), /Approved workflows for this task/);
    assert.equal(policies.length, policyCount, 'learning Off returns to the original native tool');
    assert.equal(callbacks.length, 3, 'the third native task still executes its original callback');
    assert.equal(completions.length, 3);
    assert.ok(completions.every(completion => completion.evidence_complete !== false), 'all native evidence is complete');
  });
}
