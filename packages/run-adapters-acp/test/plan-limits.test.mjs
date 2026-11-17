// Named case 3 of the slice (design TDD §2, "What bounds a plan-billed run"): an agent the vendor bills (Cursor) never
// sends us a model request, so no cap at the paid request can hold. The adapter counts session/prompt turns and tool
// calls itself, from the session's records, and stops at the owner's limits with a named reason.
import assert from 'node:assert/strict';
import { test as nodeTest } from 'node:test';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { ACP_CODES } from '@parcha/agentrun-harness-acp';
import { fakeEvents, fakeRecipe, openSession, scratch, tool, until } from './helpers.mjs';

const test = (name, fn) => nodeTest(name, { timeout: 60_000 }, fn);
const plan = (maxTurns, maxToolCalls) => ({ billing: { kind: 'plan', maxTurns, maxToolCalls } });

test('a plan-billed run stops at M tool calls with a named reason', async (t) => {
  const recipe = fakeRecipe(scratch(), { script: [{ call: 'read' }, { call: 'read' }, { call: 'read' }, { say: 'never' }] }, plan(10, 2));
  let ran = 0;
  const { session, events } = await openSession(t, recipe, { tools: [tool('read', () => ((ran += 1), 'read'), 'safe')] });
  await session.send('go');
  const end = await session.turnEnd();
  assert.equal(end.status, 'failed');
  assert.match(end.error, new RegExp(`^${ACP_CODES.toolCallLimit}: `), end.error);
  assert.match(end.error, /2 tool calls/);
  assert.equal(ran, 2, 'the third call never ran');
  assert.ok(fakeEvents(recipe).some((e) => e.type === 'cancel'), 'the turn was cancelled at the agent');
  assert.equal(events.some((e) => e.type === 'text' && e.delta === 'never'), false);
});

test('a plan-billed run stops at N turns with a named reason, counted across runners', async (t) => {
  const store = memorySessionStore();
  const recipe = fakeRecipe(scratch(), { script: [{ say: 'one' }, { say: 'two' }, { say: 'three' }] }, plan(2, 10));
  const first = await openSession(t, recipe, { store });
  await first.session.send('a');
  assert.equal((await first.session.turnEnd()).status, 'completed');
  await first.session.close();
  // Another runner counts the turns the records hold.
  const second = await openSession(t, recipe, { store });
  await second.session.send('b');
  assert.equal((await second.session.turnEnd()).status, 'completed');
  await second.session.send('c');
  const end = await second.session.turnEnd();
  assert.equal(end.status, 'failed');
  assert.match(end.error, new RegExp(`^${ACP_CODES.turnLimit}: `), end.error);
  assert.match(end.error, /2 turns/);
  assert.equal(fakeEvents(recipe).filter((e) => e.type === 'prompt').length, 2, 'the third prompt was never sent');
});

test('a plan-billed run refuses an agent permission request past the limit, never allowing it', async (t) => {
  const recipe = fakeRecipe(scratch(), { script: [{ call: 'read' }, { native: 'execute', title: 'Run ls' }, { say: 'never' }], style: 'cursor', askMcp: false }, plan(10, 1));
  const asked = [];
  const { session } = await openSession(t, recipe, { tools: [tool('read', () => 'read', 'safe')], gate: async (call) => (asked.push(call), 'allow') });
  await session.send('go');
  const end = await session.turnEnd();
  assert.match(end.error ?? '', new RegExp(`^${ACP_CODES.toolCallLimit}: `));
  assert.deepEqual(asked.map((c) => c.tool), ['read'], 'the native call never reached the gate');
  assert.deepEqual(fakeEvents(recipe).filter((e) => e.type === 'permission').map((e) => e.kind ?? e.outcome), ['reject_once']);
});

// An agent that ignores session/cancel past the limit (it goes on thinking, on the owner's plan): the adapter waits a
// bounded time, then ends the agent's process, and the turn ends on the limit's named reason.
test('a plan-billed agent that ignores the cancel at the call limit is stopped within a bounded wait', async (t) => {
  const recipe = fakeRecipe(scratch(), { script: [{ call: 'read' }, { call: 'read' }, { hang: true }], ignoreCancel: true }, plan(10, 1));
  const { session } = await openSession(t, recipe, { tools: [tool('read', () => 'read', 'safe')] });
  const started = Date.now();
  await session.send('go');
  let timer;
  const end = await Promise.race([session.turnEnd(), new Promise((resolve) => (timer = setTimeout(() => resolve({ status: 'still running' }), 20_000)))]).finally(() => clearTimeout(timer));
  assert.equal(end.status, 'failed', `the turn ended (after ${Date.now() - started} ms)`);
  assert.match(end.error ?? '', new RegExp(`^${ACP_CODES.toolCallLimit}: `), end.error);
  const events = fakeEvents(recipe);
  assert.ok(events.some((e) => e.type === 'cancel'), 'a cancel was sent first');
  assert.ok(events.some((e) => e.type === 'hang'), 'the agent went on past it');
  const pid = events.find((e) => e.type === 'start').pid;
  await until(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }, "the agent's process to end", 10_000);
});
