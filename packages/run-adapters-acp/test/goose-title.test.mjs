// Goose 1.59.2 titles a call of an extension's tool `<extension>: <tool, its underscores as spaces>`, so a call of our
// `look_up` reaches the adapter as `agentrun: look up`, both in its tool_call and in its permission request. The adapter
// ties that title to our tool (src/calls.ts ourTool): the permission is answered allow_once and the host's gate is asked
// once, by the bridge, about the call itself, never as the agent's own `acp_other`. Only our server's exact name ties a
// title: another server's tool named like ours (`github: look up`, `agentrun-github: look up`) stays the agent's own.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test as nodeTest } from 'node:test';
import { ourTool } from '../dist/calls.js';
import { fakeEvents, fakeRecipe, openSession, scratch, streamRecords, tool } from './helpers.mjs';

const test = (name, fn) => nodeTest(name, { timeout: 60_000 }, fn);
const texts = (events) => events.filter((e) => e.type === 'text').map((e) => e.delta).join('');
const TOOLS = new Set(['look_up', 'check_echo', 'lookup']);

test("ourTool ties Goose 1.59.2's title, `agentrun: <tool with spaces>`, to our tool", () => {
  assert.equal(ourTool({ title: 'agentrun: look up', kind: 'other' }, TOOLS), 'look_up');
  assert.equal(ourTool({ title: 'agentrun: check echo' }, TOOLS), 'check_echo');
  assert.equal(ourTool({ title: 'agentrun: lookup', kind: 'other' }, TOOLS), 'lookup');
  // The forms already tied stay tied.
  assert.equal(ourTool({ title: 'agentrun__look_up' }, TOOLS), 'look_up');
  assert.equal(ourTool({ title: 'agentrun-look_up: look_up' }, TOOLS), 'look_up');
});

test("ourTool leaves another server's tool named like ours, and a call with effects of its own, as the agent's own", () => {
  for (const title of ['github: look up', 'agentrun-github: look up', 'agentrun github: look up', 'Agentrun: look up', 'agentrun: Look Up', 'agentrun: look  up', 'agentrun: look up now', 'xagentrun: look up', 'agentrun: look_up_', 'agentrun:look up']) {
    assert.equal(ourTool({ title, kind: 'other' }, TOOLS), undefined, title);
  }
  for (const kind of ['execute', 'edit', 'delete', 'move', 'fetch']) assert.equal(ourTool({ title: 'agentrun: look up', kind }, TOOLS), undefined, kind);
  // A tool that is not ours, under our server's name, is not ours either.
  assert.equal(ourTool({ title: 'agentrun: drop tables', kind: 'other' }, TOOLS), undefined);
});

for (const answer of ['allow', 'deny']) {
  test(`a Goose 1.59.2 call of our look_up is ours: allow_once, the gate asked once by the bridge (${answer}), no acp_other`, async (t) => {
    const recipe = fakeRecipe(scratch(), { script: [{ call: 'look_up', args: { q: 'x' } }, { sayLastResult: true }], style: 'goose-1.59' });
    const asked = [];
    let ran = 0;
    const { session, events, store } = await openSession(t, recipe, {
      tools: [tool('look_up', () => ((ran += 1), 'found it'))],
      gate: async (call) => (asked.push(call), answer === 'allow' ? 'allow' : { deny: 'not now' }),
    });
    await session.send('go');
    const end = await session.turnEnd();
    assert.equal(end.status, 'completed', end.error);
    assert.deepEqual(fakeEvents(recipe).filter((e) => e.type === 'permission').map((e) => [e.title, e.kind]), [['agentrun: look up', 'allow_once']]);
    assert.deepEqual(asked.map((c) => [c.tool, c.callId]), [['look_up', 'call_0']], 'the gate is asked once, by the bridge, about the call itself');
    assert.deepEqual(await streamRecords(store, 'acp.permission'), [], 'no record of the agent\'s own call');
    assert.equal(ran, answer === 'allow' ? 1 : 0);
    if (answer === 'allow') assert.equal(texts(events), 'found it');
  });
}

test("another server's tool titled like ours (`github: look up`) asks the host's gate as the agent's own; a deny answers reject_once", async (t) => {
  const dir = scratch();
  const nativeLog = join(dir, 'native.log');
  const recipe = fakeRecipe(dir, { script: [{ native: 'other', title: 'github: look up', input: { q: 'x' } }, { sayLastResult: true }], style: 'goose-1.59', nativeLog });
  const asked = [];
  let ran = 0;
  const { session } = await openSession(t, recipe, {
    tools: [tool('look_up', () => ((ran += 1), 'found it'))],
    gate: async (call) => (asked.push(call), { deny: 'not ours' }),
  });
  await session.send('go');
  assert.equal((await session.turnEnd()).status, 'completed');
  assert.deepEqual(asked.map((c) => [c.tool, c.args.title]), [['acp_other', 'github: look up']]);
  assert.deepEqual(fakeEvents(recipe).filter((e) => e.type === 'permission').map((e) => e.kind), ['reject_once']);
  assert.throws(() => readFileSync(nativeLog, 'utf8'), /ENOENT/, 'the other server\'s call never ran');
  assert.equal(ran, 0);
});
