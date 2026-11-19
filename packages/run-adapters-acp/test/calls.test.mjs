// How an MCP call of ours gets the agent's own tool call id (src/calls.ts): matched to the tool_call that announced it by
// the tool and the arguments, never to another call's announcement. And which titles name our tool (ourTool).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CallIds, ourTool } from '../dist/calls.js';

const TOOLS = new Set(['look_up', 'check_echo', 'lookup']);

test("ourTool ties each agent's title for our tool: `agentrun__<tool>`, `agentrun-<tool>: <tool>`, and Goose 1.59.2's `agentrun: <tool with spaces>`", () => {
  assert.equal(ourTool({ title: 'agentrun: look up', kind: 'other' }, TOOLS), 'look_up');
  assert.equal(ourTool({ title: 'agentrun: check echo' }, TOOLS), 'check_echo');
  assert.equal(ourTool({ title: 'agentrun: lookup', kind: 'other' }, TOOLS), 'lookup');
  assert.equal(ourTool({ title: 'agentrun__look_up' }, TOOLS), 'look_up');
  assert.equal(ourTool({ title: 'agentrun-look_up: look_up' }, TOOLS), 'look_up');
});

test("ourTool leaves another server's tool named like ours, and a call with effects of its own, as the agent's own", () => {
  for (const title of ['github: look up', 'agentrun-github: look up', 'agentrun github: look up', 'Agentrun: look up', 'agentrun: Look Up', 'agentrun: look  up', 'agentrun: look up now', 'xagentrun: look up', 'agentrun: look_up_', 'agentrun:look up']) {
    assert.equal(ourTool({ title, kind: 'other' }, TOOLS), undefined, title);
  }
  for (const kind of ['execute', 'edit', 'delete', 'move', 'fetch']) assert.equal(ourTool({ title: 'agentrun: look up', kind }, TOOLS), undefined, kind);
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
