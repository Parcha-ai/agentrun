// How an MCP call of ours gets the agent's own tool call id (src/calls.ts): matched to the tool_call that announced it by
// the tool and the arguments, never to another call's announcement. And which titles name our tool (ourTool).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { announcedInput, CallIds, ourTool } from '../dist/calls.js';

const TOOLS = new Set(['look_up', 'check_echo', 'lookup']);

test("ourTool ties each agent's title for our tool: `agentrun__<tool>`, `agentrun-<tool>: <tool>`, and Goose 1.59.2's `agentrun: <tool with spaces>`", () => {
  assert.equal(ourTool({ title: 'agentrun: look up', kind: 'other' }, TOOLS), 'look_up');
  assert.equal(ourTool({ title: 'agentrun: check echo' }, TOOLS), 'check_echo');
  assert.equal(ourTool({ title: 'agentrun: lookup', kind: 'other' }, TOOLS), 'lookup');
  assert.equal(ourTool({ title: 'agentrun__look_up' }, TOOLS), 'look_up');
  assert.equal(ourTool({ title: 'agentrun-look_up: look_up' }, TOOLS), 'look_up');
  // Goose 1.59.2 writes a summary of the call's arguments (a path) after the title: `agentrun: write · proof.txt`.
  assert.equal(ourTool({ title: 'agentrun: look up · proof.txt', kind: 'other' }, TOOLS), 'look_up');
  assert.equal(ourTool({ title: 'agentrun: check echo · a · b' }, TOOLS), 'check_echo', 'cut at the first');
});

test("ourTool ties agy 1.5.14's name for our tool, `mcp_agentrun_<tool>`, and its title `Run mcp_agentrun_<tool>`, and nothing like them", () => {
  assert.equal(ourTool({ name: 'mcp_agentrun_look_up', title: 'Run mcp_agentrun_look_up', kind: 'other' }, TOOLS), 'look_up');
  assert.equal(ourTool({ title: 'Run mcp_agentrun_check_echo', kind: 'other' }, TOOLS), 'check_echo');
  assert.equal(ourTool({ name: 'mcp_agentrun_lookup' }, TOOLS), 'lookup');
  for (const title of ['Run mcp_github_look_up', 'mcp_agentrunx_look_up', 'Run mcp_agentrun_look_up now', 'run mcp_agentrun_look_up', 'Run  mcp_agentrun_look_up', 'Run mcp_agentrun_drop_tables', 'xmcp_agentrun_look_up', 'Run mcp_agentrun_', 'Run mcp_agentrun_look_up · x']) {
    assert.equal(ourTool({ title, kind: 'other' }, TOOLS), undefined, title);
    assert.equal(ourTool({ name: title, kind: 'other' }, TOOLS), undefined, `name ${title}`);
  }
  assert.equal(ourTool({ name: 'mcp_agentrun_look_up', title: 'Run mcp_agentrun_look_up', kind: 'execute' }, TOOLS), undefined, 'a kind with effects of its own');
});

test("an agy call's input is matched without agy's own toolSummary; any other agent's input is as reported", () => {
  const agy = { name: 'mcp_agentrun_look_up', title: 'Run mcp_agentrun_look_up' };
  assert.deepEqual(announcedInput(agy, { q: 'x', toolSummary: 'Look x up' }), { q: 'x' });
  assert.deepEqual(announcedInput({ title: 'Run mcp_agentrun_look_up' }, { q: 'x', toolSummary: 'Look x up' }), { q: 'x' });
  assert.deepEqual(announcedInput(agy, { q: 'x' }), { q: 'x' });
  assert.deepEqual(announcedInput(agy, { q: 'x', toolSummary: 3 }), { q: 'x', toolSummary: 3 }, 'not agy summary-shaped');
  assert.deepEqual(announcedInput({ title: 'agentrun: look up' }, { q: 'x', toolSummary: 'kept' }), { q: 'x', toolSummary: 'kept' });
  assert.deepEqual(announcedInput({ title: 'agentrun__look_up' }, { q: 'x', toolSummary: 'kept' }), { q: 'x', toolSummary: 'kept' });
  assert.equal(announcedInput(agy, null), null);
});

test("ourTool leaves another server's tool named like ours, and a call with effects of its own, as the agent's own", () => {
  for (const title of ['github: look up', 'agentrun-github: look up', 'agentrun github: look up', 'Agentrun: look up', 'agentrun: Look Up', 'agentrun: look  up', 'agentrun: look up now', 'xagentrun: look up', 'agentrun: look_up_', 'agentrun:look up', 'agentrun: look up now · x', 'agentrun: look up·x', ' · agentrun: look up', 'github: look up · proof.txt']) {
    assert.equal(ourTool({ title, kind: 'other' }, TOOLS), undefined, title);
  }
  for (const kind of ['execute', 'edit', 'delete', 'move', 'fetch']) {
    assert.equal(ourTool({ title: 'agentrun: look up', kind }, TOOLS), undefined, kind);
    assert.equal(ourTool({ title: 'agentrun: look up · proof.txt', kind }, TOOLS), undefined, `${kind}, with a summary`);
  }
  assert.equal(ourTool({ title: 'agentrun: drop tables', kind: 'other' }, TOOLS), undefined, 'a tool that is not ours, under our server name');
});

test('two parallel calls whose announcements come in reverse order each get their own id', async () => {
  const ids = new CallIds();
  const signal = new AbortController().signal;
  // The MCP call with args a reaches the server before either announcement.
  const a = ids.take('lookup', { q: 'a' }, signal, 2_000);
  ids.add('call_b', 'lookup', { q: 'b' });
  ids.add('call_a', 'lookup', { q: 'a' });
  const b = ids.take('lookup', { q: 'b' }, signal, 2_000);
  assert.deepEqual(await Promise.all([a, b]), ['call_a', 'call_b']);
});

test('an announcement with no input still matches a waiting call of its tool', async () => {
  const ids = new CallIds();
  const waiting = ids.take('lookup', { q: 'a' }, new AbortController().signal, 2_000);
  ids.add('call_0', 'lookup', undefined);
  assert.equal(await waiting, 'call_0');
});
