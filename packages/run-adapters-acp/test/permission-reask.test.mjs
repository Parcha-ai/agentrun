// A parked permission of the agent's own tool (its shell), and an agent that, started again, asks for another command
// instead of the one it parked on, as Cursor does: its model writes a new command after the restart. The person's
// answer must still reach the run: the adapter asks the gate about each parked request of the open turn before it
// starts the agent again, so the answer is taken (the run's pending moves on) whatever the agent asks next, and with
// none yet the run parks again with no prompt sent. An agent that keeps asking for other commands instead of the one
// the person approved is stopped after REASK_LIMIT of them, in words, never left to spend its plan.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test as nodeTest } from 'node:test';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import * as acp from '@parcha/agentrun-harness-acp';
import { fakeEvents, fakeRecipe, openSession, scratch, streamRecords, until } from './helpers.mjs';

const test = (name, fn) => nodeTest(name, { timeout: 60_000 }, fn);
const lines = (file) => {
  try {
    return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
};
const PARK = { park: true };
// Read with their values as fallbacks, so a build without them fails on what it does, not on an import.
const REASK_LIMIT = acp.REASK_LIMIT ?? 3;
const REASK_CODE = acp.ACP_CODES.reaskLimit ?? 'ACP_REASK_LIMIT';

/** A Cursor-style fake whose shell step asks `Run ls` first and another command each time it is taken again. */
function reasking(dir, load) {
  const nativeLog = join(dir, 'native.log');
  const step = { native: 'execute', title: 'Run ls', input: { command: 'ls' }, retitled: ['Run ls -la', 'Run ls -la /', 'Run pwd', 'Run pwd -P', 'Run id'] };
  const recipe = fakeRecipe(dir, { script: [step, { sayLastResult: true }], style: 'cursor', load, http: load, nativeLog, tally: join(dir, 'tally') });
  return { recipe, nativeLog };
}

/** The first runner: the agent asks, the gate parks, the runner lets the session go. The parked call's id. */
async function parkFirst(t, recipe, store, asked) {
  const first = await openSession(t, recipe, { store, gate: async (call) => (asked.push(call), PARK) });
  await first.session.send('list the folder');
  await until(() => asked.length === 1, 'the gate to be asked');
  first.stop(new Error('the run parked'));
  await first.session.turnEnd().catch(() => undefined);
  return asked[0].callId;
}

const prompts = (recipe) => fakeEvents(recipe).filter((e) => e.type === 'prompt');

for (const load of [true, false]) {
  const how = load ? 'with session/load' : 'without session/load';

  test(`the person's answer is taken before the agent starts again, though it then asks for another command (${how})`, async (t) => {
    const dir = scratch();
    const { recipe, nativeLog } = reasking(dir, load);
    const store = memorySessionStore();
    const asked = [];
    const parked = await parkFirst(t, recipe, store, asked);
    const sentBefore = prompts(recipe).length;

    // The person allowed the parked call; anything else the agent asks waits for them.
    let askedFirstAt;
    const second = await openSession(t, recipe, { store, gate: async (call) => (asked.push(call), askedFirstAt ??= prompts(recipe).length, call.callId === parked ? 'allow' : PARK) });
    second.session.recover().catch(() => undefined);
    await until(() => asked.length === 3, 'the gate to be asked about the parked call, then about the new one');
    second.stop(new Error('the run parked again'));
    await second.session.turnEnd().catch(() => undefined);

    assert.equal(asked[1].callId, parked, 'the parked call is asked about again: its answer is taken');
    assert.equal(askedFirstAt, sentBefore, 'before any prompt reached the agent again');
    assert.equal(asked[1].tool, 'acp_execute');
    assert.deepEqual(asked[1].args, asked[0].args, 'asked about as it was asked first');
    assert.notEqual(asked[2].callId, parked, 'the other command is a call of its own: one approval never allows another command');
    assert.match(asked[2].args.title, /Run ls -la/);
    assert.deepEqual(lines(nativeLog), [], 'nothing ran: the approved command was not asked for, the other one waits');
    const records = await streamRecords(store, 'acp.permission');
    assert.deepEqual(records.filter((r) => r.type === 'answered').map((r) => [r.callId, r.answer]), [[parked, 'allow']], 'the answer is on the record');
    // The agent was told what the person answered, and how to have it run.
    const resumed = prompts(recipe).slice(sentBefore).map((e) => e.text.join('\n')).join('\n');
    assert.match(resumed, /Run ls/);
    assert.match(resumed, /allowed/i);
  });

  test(`with no answer yet, a parked permission parks the run again and the agent is not started (${how})`, async (t) => {
    const dir = scratch();
    const { recipe } = reasking(dir, load);
    const store = memorySessionStore();
    const asked = [];
    const parked = await parkFirst(t, recipe, store, asked);
    const before = fakeEvents(recipe).length;

    const second = await openSession(t, recipe, { store, gate: async (call) => (asked.push(call), PARK) });
    second.session.recover().catch(() => undefined);
    await until(() => asked.length === 2, 'the gate to be asked about the parked call');
    await new Promise((resolve) => setTimeout(resolve, 500));
    second.stop(new Error('the run parked again'));
    await second.session.turnEnd().catch(() => undefined);

    assert.deepEqual(asked.map((c) => c.callId), [parked, parked], 'the same call, asked again, and nothing new');
    assert.deepEqual(fakeEvents(recipe).slice(before).map((e) => e.type), [], 'the agent was not started: no session, no prompt, nothing spent');
  });
}

test(`an agent that asks for another command instead of the approved one ${REASK_LIMIT} times is stopped in words`, async (t) => {
  const dir = scratch();
  const { recipe, nativeLog } = reasking(dir, true);
  const store = memorySessionStore();
  const asked = [];
  await parkFirst(t, recipe, store, asked);
  // Each runner: the person allowed every call asked before; the agent asks for another one, which parks.
  let end;
  for (let runner = 0; runner < REASK_LIMIT + 2 && !end; runner++) {
    const allowed = new Set(asked.map((c) => c.callId));
    const count = asked.length;
    const next = await openSession(t, recipe, { store, gate: async (call) => (asked.push(call), allowed.has(call.callId) ? 'allow' : PARK) });
    let stopped = false;
    const ended = next.session.recover().then(() => next.session.turnEnd()).then((e) => (stopped ? undefined : (end = e)), () => undefined);
    await until(() => end || asked.length > count + 1, 'the run to park again or end');
    if (end) break;
    stopped = true;
    next.stop(new Error('the run parked again'));
    await ended;
  }
  assert.ok(end, `the turn ended: ${JSON.stringify(asked.map((c) => c.args.title))}`);
  assert.equal(end.status, 'failed');
  assert.match(end.error ?? '', new RegExp(`^${REASK_CODE}: `));
  assert.match(end.error, /Run ls/, 'it names the command the person approved');
  assert.deepEqual(lines(nativeLog), [], 'no command ran on another command\'s approval');
  const refused = fakeEvents(recipe).filter((e) => e.type === 'permission' && e.outcome === 'selected' && e.kind === 'reject_once');
  assert.equal(refused.length, 1, 'the last one is refused at the protocol');
});
