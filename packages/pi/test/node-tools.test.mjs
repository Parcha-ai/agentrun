// An agent node of a workflow the root agent runs. Its conversation is one the run's task owns, which pi-durable starts
// from a copy of the root's agent, and the node host's agent is a change on that copy (NodeHost.agent): a host that gives
// its own instructions and the node's extensions and tools as lists replaces all three. Such a node is offered exactly
// the tools it names and is sent nothing of the root's.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hostTools, LEARNED, MODEL, NODE_RULES, NODE_TOOLS, ROOT_RULES, runNodeTools, STAGEHAND } from './fixtures/node-tools-rig.mjs';

test('an agent node in a run is offered exactly the tools it names, Stagehand-shaped ones as the host defined them, and nothing of the root agent\'s', async () => {
  const asked = [];
  const { outcome, root, node, requests } = await runNodeTools((request, byName) => {
    asked.push(request.tools);
    return { model: MODEL, instructions: NODE_RULES, extensions: [hostTools], tools: byName(request.tools) };
  });
  assert.deepEqual([outcome.status, outcome.output], ['complete', { business: 'Acme makes valves.' }]);
  assert.equal(requests, 4, 'the root inspects, runs and answers; the node delivers once');
  assert.deepEqual(asked, [NODE_TOOLS], 'the host is asked once, with the names the node gives');

  // What the root had for a node to inherit: its rules, the learning section, and every tool of its extensions.
  assert.ok(root.json.includes(ROOT_RULES) && root.json.includes(LEARNED));
  assert.deepEqual(root.tools.map((tool) => tool.name), ['learn', 'snapshot', 'run', 'screenshot', 'browser_read', 'fetch_page', 'answer', 'agentrun']);

  // The node: the tools it names, in its order, then submit; each Stagehand-shaped one with the parameters the host defined.
  assert.deepEqual(node.tools.map((tool) => tool.name), [...NODE_TOOLS, 'submit']);
  for (const defined of STAGEHAND.filter((tool) => NODE_TOOLS.includes(tool.name))) {
    assert.deepEqual(node.tools.find((tool) => tool.name === defined.name).parameters, defined.parameters, defined.name);
  }
  // Its prompt: the runner's task and the host's instructions, none of the root's rules or sections.
  assert.deepEqual(Object.keys(node.sections), ['task', 'instructions']);
  assert.ok(node.sections.instructions.includes(NODE_RULES));
  assert.equal(node.json.includes(ROOT_RULES), false, 'the root\'s rules');
  assert.equal(node.json.includes(LEARNED), false, 'the root\'s learning section');
});
