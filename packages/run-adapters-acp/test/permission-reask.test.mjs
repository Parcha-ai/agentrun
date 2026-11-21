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
import { fakeEvents, fakeRecipe, openSession, scratch, streamRecords, transcript, until } from './helpers.mjs';

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

/** A Cursor-style fake whose shell step asks `Run ls` first and another command each time it is taken again; `after`,
 *  steps it takes next. */
function reasking(dir, load, after = []) {
  const nativeLog = join(dir, 'native.log');
  const step = { native: 'execute', title: 'Run ls', input: { command: 'ls' }, retitled: ['Run ls -la', 'Run ls -la /', 'Run pwd', 'Run pwd -P', 'Run id'] };
  const recipe = fakeRecipe(dir, { script: [step, ...after, { sayLastResult: true }], style: 'cursor', load, http: load, nativeLog, tally: join(dir, 'tally') });
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
    assert.ok(resumed.includes('{"command":"ls"}'), `the note carries the request's input, so the agent can ask for it again: ${resumed}`);
  });

  test(`an answer taken by a runner that stopped before its prompt still reaches the agent's note on the next one (${how})`, async (t) => {
    const dir = scratch();
    const { recipe } = reasking(dir, load);
    const store = memorySessionStore();
    const asked = [];
    const parked = await parkFirst(t, recipe, store, asked);
    const sentBefore = prompts(recipe).length;

    // The second runner takes the person's answer and is lost right after, before the agent gets a prompt.
    let second;
    second = await openSession(t, recipe, { store, gate: async (call) => (asked.push(call), setImmediate(() => second.stop(new Error('the runner was lost'))), 'allow') });
    second.session.recover().catch(() => undefined);
    await until(() => asked.length === 2, 'the gate to be asked about the parked call');
    await second.session.turnEnd().catch(() => undefined);
    const records = await streamRecords(store, 'acp.permission');
    assert.deepEqual(records.filter((r) => r.type === 'answered').map((r) => [r.callId, r.answer]), [[parked, 'allow']], 'the answer was taken and saved');
    assert.equal(prompts(recipe).length, sentBefore, 'the lost runner sent the agent nothing');

    // The third runner has nothing waiting to settle; the saved answer must still be in what the agent is told.
    const third = await openSession(t, recipe, { store, gate: async (call) => (asked.push(call), PARK) });
    third.session.recover().catch(() => undefined);
    await until(() => prompts(recipe).length > sentBefore, 'a prompt to reach the agent');
    await until(() => asked.length === 3, 'the agent to ask again');
    third.stop(new Error('the run parked again'));
    await third.session.turnEnd().catch(() => undefined);
    const resumed = prompts(recipe).slice(sentBefore).map((e) => e.text.join('\n')).join('\n');
    assert.match(resumed, /allowed it once/, `the saved answer is in the note: ${resumed}`);
    assert.ok(resumed.includes('{"command":"ls"}'), 'with the input the person allowed');
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
  let promptsAtLast = 0;
  for (let runner = 0; runner < REASK_LIMIT + 2 && !end; runner++) {
    const allowed = new Set(asked.map((c) => c.callId));
    const count = asked.length;
    promptsAtLast = prompts(recipe).length;
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
  // Ended on the resume, before the agent started again: a park commits the run parked, so the limit never answers one.
  assert.equal(prompts(recipe).length, promptsAtLast, 'the last runner sent the agent nothing');
  assert.deepEqual(fakeEvents(recipe).filter((e) => e.type === 'permission' && e.kind === 'reject_once'), [], 'no request was refused at the protocol');
  const records = await streamRecords(store, 'acp.permission');
  assert.equal(records.filter((r) => r.type === 'reasked').length, REASK_LIMIT, 'each counted ask parked');
});

test('a message sent while the run waited at the limit still reaches the agent, as a turn of its own', async (t) => {
  const dir = scratch();
  const { recipe } = reasking(dir, true);
  const store = memorySessionStore();
  const asked = [];
  await parkFirst(t, recipe, store, asked);
  // REASK_LIMIT runners: each allows what was asked before; the agent asks for another command, which parks.
  for (let runner = 0; runner < REASK_LIMIT; runner++) {
    const allowed = new Set(asked.map((c) => c.callId));
    const count = asked.length;
    const next = await openSession(t, recipe, { store, gate: async (call) => (asked.push(call), allowed.has(call.callId) ? 'allow' : PARK) });
    next.session.recover().catch(() => undefined);
    await until(() => asked.length > count + 1, 'the run to park again');
    next.stop(new Error('the run parked again'));
    await next.session.turnEnd().catch(() => undefined);
  }
  // The person answers the last park and sends new instructions; the resume ends the old turn at the limit.
  const allowed = new Set(asked.map((c) => c.callId));
  const before = prompts(recipe).length;
  const last = await openSession(t, recipe, { store, gate: async (call) => (asked.push(call), allowed.has(call.callId) ? 'allow' : PARK) });
  await last.session.send('then print the date');
  await until(() => prompts(recipe).slice(before).some((e) => e.text.join('\n').includes('then print the date')), 'the new message to reach the agent');
  last.stop(new Error('done'));
  await last.session.turnEnd().catch(() => undefined);
  const sent = prompts(recipe).slice(before).map((e) => e.text.join('\n'));
  assert.ok(sent.every((text) => !text.includes('[Recovery]')), `the ended turn is not recovered: ${JSON.stringify(sent)}`);
  const entries = await transcript(store);
  assert.ok(entries.some((e) => e.type === 'turn' && e.status === 'failed' && new RegExp(`^${REASK_CODE}: `).test(e.error ?? '')), 'the old turn ended at the limit, in words');
});

for (const load of [true, false]) {
  test(`other commands the tool's setting allows without parking never count toward ${REASK_LIMIT} (${load ? 'with' : 'without'} session/load)`, async (t) => {
    const dir = scratch();
    const after = [{ native: 'execute', title: 'Run cat a', input: { command: 'cat a' } }, { native: 'execute', title: 'Run cat b', input: { command: 'cat b' } }];
    const { recipe, nativeLog } = reasking(dir, load, after);
    const store = memorySessionStore();
    const asked = [];
    await parkFirst(t, recipe, store, asked);
    // The person allowed the parked `ls`; the tool is set to allow, so every other command is allowed with no park.
    const second = await openSession(t, recipe, { store, gate: async (call) => (asked.push(call), 'allow') });
    await second.session.recover();
    const end = await second.session.turnEnd();
    assert.notEqual(end.status, 'failed', `a working turn is not cut: ${end.error}`);
    assert.doesNotMatch(end.error ?? '', new RegExp(REASK_CODE));
    assert.deepEqual(lines(nativeLog), ['Run ls -la', 'Run cat a', 'Run cat b'], 'each command allowed by the setting ran');
  });
}

test('an allow-once is used once: the same request from a later agent process asks the gate again', async (t) => {
  const dir = scratch();
  const nativeLog = join(dir, 'native.log');
  const recipe = fakeRecipe(dir, { script: [{ native: 'execute', title: 'Run ls', input: { command: 'ls' } }, { hang: true }], style: 'cursor', load: false, http: false, nativeLog });
  const store = memorySessionStore();
  const asked = [];
  // The person allows `ls` once; it runs; the runner is lost mid-turn.
  const first = await openSession(t, recipe, { store, gate: async (call) => (asked.push(call), 'allow') });
  await first.session.send('list the folder');
  await until(() => lines(nativeLog).length === 1 && fakeEvents(recipe).some((e) => e.type === 'hang'), 'ls to run and the model to hang');
  first.stop(new Error('the runner was lost'));
  await first.session.turnEnd().catch(() => undefined);

  // The next process's agent, started without its session, asks for `ls` again: a new card, not the old allow.
  const second = await openSession(t, recipe, { store, gate: async (call) => (asked.push(call), PARK) });
  second.session.recover().catch(() => undefined);
  await until(() => asked.length === 2 || lines(nativeLog).length === 2, 'the gate to be asked again, or ls to run again');
  second.stop(new Error('the run parked'));
  await second.session.turnEnd().catch(() => undefined);
  assert.deepEqual(lines(nativeLog), ['Run ls'], 'ls ran once, on its one allow');
  assert.equal(asked.length, 2, 'the gate was asked about the second ls');
  assert.notEqual(asked[1].callId, asked[0].callId, 'under a call of its own');
});
