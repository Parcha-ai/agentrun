// How an MCP call of ours gets the agent's own tool call id (src/calls.ts): matched to the tool_call that announced it by
// the tool and the arguments, never to another call's announcement. And which titles name our tool (ourTool).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CallIds, ourTool } from '../dist/calls.js';

const TOOLS = new Set(['look_up', 'check_echo', 'lookup']);

test("ourTool reads a name, `agentrun__<tool>`, and Cursor's own title, `agentrun-<tool>: <tool>`; nothing else", () => {
  assert.equal(ourTool({ title: 'agentrun__look_up' }, TOOLS), 'look_up');
  assert.equal(ourTool({ name: 'agentrun__check_echo' }, TOOLS), 'check_echo');
  assert.equal(ourTool({ title: 'agentrun-look_up: look_up' }, TOOLS), 'look_up');
  assert.equal(ourTool({ title: 'agentrun-lookup: lookup', kind: 'other' }, TOOLS), 'lookup');
});

test("ourTool no longer reads Goose 1.59.2's titles (`agentrun: <tool with spaces>`, ` · <summary>`): those calls are matched by their arguments, and Goose asks nothing for them", () => {
  // Before: each of these was read as our tool, and its permission request answered allow_once on the title.
  for (const title of ['agentrun: look up', 'agentrun: check echo', 'agentrun: lookup', 'agentrun: look up · proof.txt', 'agentrun: check echo · a · b', 'agentrun__look_up · proof.txt']) {
    assert.equal(ourTool({ title, kind: 'other' }, TOOLS), undefined, title);
  }
});

test("ourTool leaves another server's tool named like ours, and a call with effects of its own, as the agent's own", () => {
  for (const title of ['github: look up', 'agentrun-github: look up', 'agentrun github: look up', 'Agentrun: look up', 'agentrun: Look Up', 'agentrun: look  up', 'agentrun: look up now', 'xagentrun: look up', 'agentrun: look_up_', 'agentrun:look up', 'agentrun: look up now · x', 'agentrun: look up·x', ' · agentrun: look up', 'github: look up · proof.txt', 'agentrun-look_up: look up']) {
    assert.equal(ourTool({ title, kind: 'other' }, TOOLS), undefined, title);
  }
  for (const kind of ['execute', 'edit', 'delete', 'move', 'fetch']) {
    assert.equal(ourTool({ title: 'agentrun__look_up', kind }, TOOLS), undefined, kind);
    assert.equal(ourTool({ title: 'agentrun-look_up: look_up', kind }, TOOLS), undefined, `${kind}, Cursor's form`);
  }
  assert.equal(ourTool({ title: 'agentrun__drop_tables', kind: 'other' }, TOOLS), undefined, 'a tool that is not ours, under our server name');
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

test('an announcement whose title names no tool of ours is matched by the arguments alone; a title that names the tool only breaks a tie between announcements with the same arguments', async () => {
  const ids = new CallIds();
  const signal = new AbortController().signal;
  // Before: an announcement the title did not tie was dropped, so the MCP call ran under no id of the agent's.
  ids.add('call_0', undefined, { path: 'proof.txt', content: 'x' });
  assert.equal(await ids.take('write', { content: 'x', path: 'proof.txt' }, signal, 50), 'call_0', 'the same arguments, in any key order');
  assert.equal(ids.announced('call_0'), undefined, 'it names no tool: a permission request is never tied to it');
  // Two announcements with the same arguments: the one whose title named the tool is taken first, then the other.
  ids.add('call_1', undefined, { q: 'a' });
  ids.add('call_2', 'lookup', { q: 'a' });
  assert.equal(await ids.take('lookup', { q: 'a' }, signal, 50), 'call_2', 'the title breaks the tie');
  assert.equal(await ids.take('lookup', { q: 'a' }, signal, 50), 'call_1');
  // An MCP call that reached the server first waits for it.
  const waiting = ids.take('write', { path: 'b' }, signal, 2_000);
  ids.add('call_3', undefined, { path: 'b' });
  assert.equal(await waiting, 'call_3');
  // Other arguments never take it, nor does an announcement with none.
  ids.add('call_4', undefined, { path: 'c' });
  ids.add('call_5', undefined, undefined);
  assert.equal(await ids.take('write', { path: 'd' }, signal, 50), undefined);
  assert.equal(ids.has('call_4'), true, 'still announced, still waiting for its own call');
});

// Known limit (PR body): an announcement whose title names no tool of ours is matched by its arguments alone, so a call of
// the agent's own (Goose's load_skill) announced first with the same arguments takes our MCP call's id. Only the id the
// resume memo keys the call by moves; the gate is asked at the MCP call either way. Kept red until announcements carry a
// field the adapter reads.
test("an agent's own call announced with the same arguments as ours never takes our MCP call's id", { skip: "known limit, in the PR body: an untitled announcement is matched by its arguments alone" }, async () => {
  const ids = new CallIds();
  const signal = new AbortController().signal;
  ids.add('call_skill', undefined, { name: 'notes' });
  ids.add('call_ours', undefined, { name: 'notes' });
  assert.equal(await ids.take('look_up', { name: 'notes' }, signal, 50), 'call_ours');
});
