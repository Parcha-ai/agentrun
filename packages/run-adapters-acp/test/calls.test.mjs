// How an MCP call of ours gets the agent's own tool call id (src/calls.ts): matched to the tool_call that announced it by
// the tool and the arguments, never to another call's announcement. And which titles name our tool (ourTool).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { announcedInput, CallIds, declaresToolSummary, mcpServerName, ourTool } from '../dist/calls.js';

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

test("ourTool ties agy 1.5.14's name for our tool, `mcp_agentrun_<tool>`, and its title `Run mcp_agentrun_<tool>`, under a recipe that declares agy's form, and nothing like them", () => {
  assert.equal(ourTool({ name: 'mcp_agentrun_look_up', title: 'Run mcp_agentrun_look_up', kind: 'other' }, TOOLS, 'agy'), 'look_up');
  assert.equal(ourTool({ title: 'Run mcp_agentrun_check_echo', kind: 'other' }, TOOLS, 'agy'), 'check_echo');
  assert.equal(ourTool({ name: 'mcp_agentrun_lookup' }, TOOLS, 'agy'), 'lookup');
  for (const title of ['Run mcp_github_look_up', 'mcp_agentrunx_look_up', 'Run mcp_agentrun_look_up now', 'run mcp_agentrun_look_up', 'Run  mcp_agentrun_look_up', 'Run mcp_agentrun_drop_tables', 'xmcp_agentrun_look_up', 'Run mcp_agentrun_', 'Run mcp_agentrun_look_up · x']) {
    assert.equal(ourTool({ title, kind: 'other' }, TOOLS, 'agy'), undefined, title);
    assert.equal(ourTool({ name: title, kind: 'other' }, TOOLS, 'agy'), undefined, `name ${title}`);
  }
  assert.equal(ourTool({ name: 'mcp_agentrun_look_up', title: 'Run mcp_agentrun_look_up', kind: 'execute' }, TOOLS, 'agy'), undefined, 'a kind with effects of its own');
});

test("agy's form is read under the recipe that declares it alone, and no other form is read under it", () => {
  const agy = { name: 'mcp_agentrun_look_up', title: 'Run mcp_agentrun_look_up', kind: 'other' };
  for (const form of [undefined, 'goose', 'cursor']) {
    assert.equal(ourTool(agy, TOOLS, form), undefined, `under ${form ?? 'no declared form'}`);
    assert.equal(ourTool({ title: 'Run mcp_agentrun_look_up', kind: 'other' }, TOOLS, form), undefined, `title alone, under ${form ?? 'no declared form'}`);
  }
  for (const title of ['agentrun: look up', 'agentrun__look_up', 'agentrun-look_up: look_up', 'agentrun: lookup']) assert.equal(ourTool({ title, kind: 'other' }, TOOLS, 'agy'), undefined, title);
});

test("agy's form is ours only for a call of kind other, or of none", () => {
  assert.equal(ourTool({ title: 'Run mcp_agentrun_look_up' }, TOOLS, 'agy'), 'look_up');
  assert.equal(ourTool({ title: 'Run mcp_agentrun_look_up', kind: null }, TOOLS, 'agy'), 'look_up');
  for (const kind of ['read', 'search', 'think', 'switch_mode', 'execute', 'edit', 'delete', 'move', 'fetch', 'Other', '']) {
    assert.equal(ourTool({ name: 'mcp_agentrun_look_up', title: 'Run mcp_agentrun_look_up', kind }, TOOLS, 'agy'), undefined, kind);
  }
});

test('an agy call that has a name and a title is ours only when both name the same tool of ours', () => {
  assert.equal(ourTool({ name: 'mcp_github_x', title: 'Run mcp_agentrun_look_up', kind: 'other' }, TOOLS, 'agy'), undefined, 'another server by its name');
  assert.equal(ourTool({ name: 'mcp_agentrun_look_up', title: 'Run mcp_github_x', kind: 'other' }, TOOLS, 'agy'), undefined, 'another server by its title');
  assert.equal(ourTool({ name: 'mcp_agentrun_lookup', title: 'Run mcp_agentrun_look_up', kind: 'other' }, TOOLS, 'agy'), undefined, 'two tools of ours');
  assert.equal(ourTool({ name: 'mcp_agentrun_look_up', title: '', kind: 'other' }, TOOLS, 'agy'), undefined, 'an empty title is a title');
});

test("Goose's and Cursor's forms are each read under their own recipe, and both under a recipe that declares none", () => {
  assert.equal(ourTool({ title: 'agentrun__look_up' }, TOOLS, 'goose'), 'look_up');
  assert.equal(ourTool({ title: 'agentrun: look up', kind: 'other' }, TOOLS, 'goose'), 'look_up');
  assert.equal(ourTool({ title: 'agentrun: look up · proof.txt', kind: 'other' }, TOOLS, 'goose'), 'look_up');
  assert.equal(ourTool({ title: 'agentrun: lookup', kind: 'other' }, TOOLS, 'goose'), 'lookup');
  assert.equal(ourTool({ title: 'agentrun-look_up: look_up' }, TOOLS, 'goose'), undefined, "Cursor's form under Goose");
  assert.equal(ourTool({ title: 'agentrun-look_up: look_up' }, TOOLS, 'cursor'), 'look_up');
  assert.equal(ourTool({ title: 'agentrun: look_up', kind: 'other' }, TOOLS, 'cursor'), 'look_up', "Cursor's late update names the tool as it is");
  assert.equal(ourTool({ title: 'agentrun__look_up' }, TOOLS, 'cursor'), undefined, "Goose's name under Cursor");
  assert.equal(ourTool({ title: 'agentrun: look up', kind: 'other' }, TOOLS, 'cursor'), undefined, "Goose 1.59.2's spaces under Cursor");
  for (const title of ['agentrun__look_up', 'agentrun: look up', 'agentrun-look_up: look_up', 'agentrun: look_up']) assert.equal(ourTool({ title, kind: 'other' }, TOOLS), 'look_up', title);
});

test("under agy's recipe our MCP server is served under a name of its start's own, agentrun and 16 hex digits; under any other, agentrun", () => {
  const a = mcpServerName('agy');
  const b = mcpServerName('agy');
  assert.match(a, /^agentrun[0-9a-f]{16}$/, 'no _ or -, so mcp_<server>_<tool> splits at its first _ after mcp_');
  assert.notEqual(a, b, 'a fresh name at each start');
  for (const form of [undefined, 'goose', 'cursor']) assert.equal(mcpServerName(form), 'agentrun', `under ${form ?? 'no declared form'}`);
});

test("agy joins server and tool with one _: under agy's recipe only our server's own name is ours, so another server's tool that spells one of ours is the agent's own", () => {
  const server = 'agentrun0123456789abcdef';
  assert.equal(ourTool({ name: `mcp_${server}_look_up`, title: `Run mcp_${server}_look_up`, kind: 'other' }, TOOLS, 'agy', server), 'look_up');
  assert.equal(ourTool({ title: `Run mcp_${server}_check_echo` }, TOOLS, 'agy', server), 'check_echo');
  // A server named agentrun_look with a tool up: agy names its call mcp_agentrun_look_up, our look_up's old name.
  for (const said of ['mcp_agentrun_look_up', 'Run mcp_agentrun_look_up', `mcp_${server}x_look_up`, `mcp_agentrun_${server}_look_up`, `Run mcp_${server.slice(0, -1)}_look_up`]) {
    assert.equal(ourTool({ title: said, kind: 'other' }, TOOLS, 'agy', server), undefined, said);
    assert.equal(ourTool({ name: said, kind: 'other' }, TOOLS, 'agy', server), undefined, `name ${said}`);
  }
  assert.deepEqual(announcedInput({ title: `Run mcp_${server}_look_up` }, { q: 'x', toolSummary: 'Look x up' }, 'agy', server), { q: 'x' });
  assert.deepEqual(announcedInput({ title: 'Run mcp_agentrun_look_up' }, { q: 'x', toolSummary: 'kept' }, 'agy', server), { q: 'x', toolSummary: 'kept' }, "another server's call");
});

test("a toolSummary our tool's schema declares is its argument, never agy's own line: kept", () => {
  const agy = { name: 'mcp_agentrun_look_up', title: 'Run mcp_agentrun_look_up' };
  assert.deepEqual(announcedInput(agy, { q: 'x', toolSummary: 'mine' }, 'agy', 'agentrun', true), { q: 'x', toolSummary: 'mine' });
  assert.deepEqual(announcedInput(agy, { q: 'x', toolSummary: 'Look x up' }, 'agy', 'agentrun', false), { q: 'x' });
});

test("a schema declares toolSummary at its top, in allOf, anyOf or oneOf at any depth, or behind a $ref to its own $defs; a $ref it cannot read may", () => {
  const summary = { toolSummary: { type: 'string' } };
  for (const schema of [
    { type: 'object', properties: summary },
    { type: 'object', allOf: [{ properties: { q: {} } }, { properties: summary }] },
    { type: 'object', anyOf: [{ properties: { q: {} } }, { properties: summary }] },
    { type: 'object', oneOf: [{ allOf: [{ properties: summary }] }] },
    { type: 'object', $ref: '#/$defs/args', $defs: { args: { properties: summary } } },
    { type: 'object', allOf: [{ $ref: '#/definitions/args' }], definitions: { args: { allOf: [{ properties: summary }] } } },
    { type: 'object', allOf: [{ $ref: 'https://example.com/args.json' }] },
    { type: 'object', $ref: '#/$defs/missing', $defs: {} },
  ]) assert.equal(declaresToolSummary(schema), true, JSON.stringify(schema));
  for (const schema of [
    { type: 'object', properties: { q: {} } },
    { type: 'object', allOf: [{ properties: { q: {} } }], anyOf: [{ properties: { r: {} } }] },
    { type: 'object', $ref: '#/$defs/args', $defs: { args: { properties: { q: {} } } } },
    { type: 'object', properties: { nested: { type: 'object', properties: summary } } },
    { type: 'object', $ref: '#/$defs/a', $defs: { a: { $ref: '#/$defs/a' } } },
    {}, null, undefined, 'object',
  ]) assert.equal(declaresToolSummary(schema), false, JSON.stringify(schema));
});

test("an agy call's input is matched without agy's own toolSummary, under agy's recipe alone; any other input is as reported", () => {
  const agy = { name: 'mcp_agentrun_look_up', title: 'Run mcp_agentrun_look_up' };
  assert.deepEqual(announcedInput(agy, { q: 'x', toolSummary: 'Look x up' }, 'agy'), { q: 'x' });
  assert.deepEqual(announcedInput({ title: 'Run mcp_agentrun_look_up' }, { q: 'x', toolSummary: 'Look x up' }, 'agy'), { q: 'x' });
  assert.deepEqual(announcedInput(agy, { q: 'x' }, 'agy'), { q: 'x' });
  assert.deepEqual(announcedInput(agy, { q: 'x', toolSummary: 3 }, 'agy'), { q: 'x', toolSummary: 3 }, 'not agy summary-shaped');
  for (const form of [undefined, 'goose', 'cursor']) assert.deepEqual(announcedInput(agy, { q: 'x', toolSummary: 'kept' }, form), { q: 'x', toolSummary: 'kept' }, `under ${form ?? 'no declared form'}`);
  assert.deepEqual(announcedInput({ title: 'agentrun: look up' }, { q: 'x', toolSummary: 'kept' }, 'agy'), { q: 'x', toolSummary: 'kept' });
  assert.deepEqual(announcedInput({ title: 'agentrun__look_up' }, { q: 'x', toolSummary: 'kept' }), { q: 'x', toolSummary: 'kept' });
  assert.equal(announcedInput(agy, null, 'agy'), null);
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
