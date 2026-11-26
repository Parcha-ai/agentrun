// A permission request for a tool of our server the agent is not given (one its listing does not hold) is refused at
// once: reject_once, a notice on the run naming the tool, no question to the host's gate, nothing journaled, so nothing
// parks and the turn goes on. A tool the agent is given asks as before: at the MCP call where the recipe lets it through
// (Goose's permission file, Cursor's and agy's title tie), at the request where it does not; and a native call of a kind
// with effects, whatever its title, is the gate's.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test as nodeTest } from 'node:test';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { fakeEvents, fakeRecipe, openSession, scratch, streamRecords, tool, until } from './helpers.mjs';

const test = (name, fn) => nodeTest(name, { timeout: 60_000 }, fn);
const texts = (events) => events.filter((e) => e.type === 'text').map((e) => e.delta).join('');
const notices = (events) => events.filter((e) => e.type === 'notice').map((e) => e.text);
const PARK = { park: true };

/** The turn's end, or the gate's first question, whichever comes first: a request the gate parks never ends the turn. */
async function endOrAsked(session, asked) {
  let end;
  void session.turnEnd().then((e) => (end = e), (error) => (end = { status: 'failed', error: String(error) }));
  await until(() => end !== undefined || asked.length > 0, 'the turn to end or the gate to be asked');
  return end;
}

for (const style of ['goose', 'goose-1.59', 'cursor', 'antigravity']) {
  test(`(${style}) a permission request for a tool of ours the agent is not given is refused at once: no question to the gate, a notice naming the tool, nothing journaled, and the turn goes on`, async (t) => {
    const recipe = fakeRecipe(scratch(), { script: [{ call: 'snapshot', args: {} }, { sayLastResult: true }], style, askMcp: true });
    const asked = [];
    let ran = 0;
    const { session, events, store } = await openSession(t, recipe, {
      tools: [tool('lookup', () => ((ran += 1), 'found'))],
      gate: async (call) => (asked.push(call), PARK),
    });
    await session.send('go');
    const end = await endOrAsked(session, asked);
    assert.deepEqual(asked.map((c) => [c.tool, c.args?.title]), [], 'no person is asked about a tool the agent is not given');
    assert.equal(end?.status, 'completed', end?.error);
    assert.deepEqual(fakeEvents(recipe).filter((e) => e.type === 'permission').map((e) => e.kind), ['reject_once'], 'refused at the protocol');
    assert.equal(texts(events), 'the client refused the call', 'the agent read its refusal and went on');
    const said = notices(events);
    assert.equal(said.length, 1, said.join(' | '));
    assert.match(said[0], /tool "snapshot" isn't granted to this agent/, said[0]);
    assert.deepEqual(await streamRecords(store, 'acp.permission'), [], 'nothing journaled for a resume to ask again');
    assert.equal(ran, 0);
  });
}

test("(goose-1.59) a tool the agent is not given, named with underscores (`look_down` titled `agentrun: look down`), is refused at once; one it is given (`look_up`) is not", async (t) => {
  const recipe = fakeRecipe(scratch(), { script: [{ call: 'look_down', args: {} }, { sayLastResult: true }], style: 'goose-1.59', askMcp: true });
  const asked = [];
  const { session, events } = await openSession(t, recipe, { tools: [tool('look_up', () => 'found')], gate: async (call) => (asked.push(call), PARK) });
  await session.send('go');
  const end = await endOrAsked(session, asked);
  assert.deepEqual(asked, []);
  assert.equal(end?.status, 'completed', end?.error);
  assert.match(notices(events).join(' | '), /tool "look down" isn't granted to this agent/);
});

for (const [style, over, gated] of [
  ['goose', {}, 'lookup'],
  ['goose-1.59', {}, 'lookup'],
  ['cursor', {}, 'lookup'],
  ['antigravity', {}, 'lookup'],
  // Without Goose's permission file the agent asks about a tool it is given too: the request is the gate's.
  ['goose', { allowFile: undefined }, 'acp_other'],
]) {
  test(`(${style}${over.allowFile === undefined && 'allowFile' in over ? ', no permission file' : ''}) a tool the agent is given whose setting asks still asks the gate (${gated}) and parks: never refused as not given`, async (t) => {
    const recipe = fakeRecipe(scratch(), { script: [{ call: 'lookup', args: { q: 'x' } }, { sayLastResult: true }], style, askMcp: true }, over);
    const asked = [];
    const { session, events } = await openSession(t, recipe, { tools: [tool('lookup', () => 'found')], gate: async (call) => (asked.push(call), PARK) });
    await session.send('go');
    const end = await endOrAsked(session, asked);
    assert.equal(end, undefined, `the turn waits for the person: ${JSON.stringify(end)}`);
    assert.deepEqual(asked.map((c) => c.tool), [gated], 'the gate is asked once, about the given tool');
    assert.equal(fakeEvents(recipe).some((e) => e.type === 'permission' && e.kind === 'reject_once'), false, 'never refused');
    assert.deepEqual(notices(events), []);
  });
}

test("a native call of a kind with effects titled as a tool of ours the agent is not given (`agentrun__snapshot`, an execute) is the gate's, as any native call with effects", async (t) => {
  const dir = scratch();
  const nativeLog = join(dir, 'native.log');
  const recipe = fakeRecipe(dir, { script: [{ native: 'execute', title: 'agentrun__snapshot', input: { command: 'ls' } }, { sayLastResult: true }], style: 'goose', nativeLog });
  const asked = [];
  const { session, events } = await openSession(t, recipe, { tools: [tool('lookup', () => 'found')], gate: async (call) => (asked.push(call), { deny: 'not now' }) });
  await session.send('go');
  assert.equal((await session.turnEnd()).status, 'completed');
  assert.deepEqual(asked.map((c) => [c.tool, c.args.title]), [['acp_execute', 'agentrun__snapshot']]);
  assert.throws(() => readFileSync(nativeLog, 'utf8'), /ENOENT/);
  assert.deepEqual(notices(events), []);
});

for (const [style, title] of [
  ['goose', 'agentrun_docs__snapshot'],
  ['goose-1.59', 'agentrunner: snapshot'],
  ['cursor', 'agentrun snapshot: snapshot'],
  ['antigravity', 'Run mcp_github_snapshot'],
]) {
  test(`(${style}) a request of the agent's own, of a kind with no effects, titled like a tool of ours but under no server of ours (${JSON.stringify(title)}), is the gate's: never refused as not given`, async (t) => {
    const dir = scratch();
    const nativeLog = join(dir, 'native.log');
    const recipe = fakeRecipe(dir, { script: [{ native: 'other', title, input: { q: 'x' } }, { sayLastResult: true }], style, askNative: ['other'], nativeLog });
    const asked = [];
    const { session, events } = await openSession(t, recipe, { tools: [tool('lookup', () => 'found')], gate: async (call) => (asked.push(call), { deny: 'not now' }) });
    await session.send('go');
    assert.equal((await session.turnEnd()).status, 'completed');
    assert.deepEqual(asked.map((c) => [c.tool, c.args.title]), [['acp_other', title]], 'the gate decides it');
    assert.deepEqual(notices(events), []);
  });
}

test("an agent that calls a tool of ours it is not given without asking (no permission request) is answered by our server in words: tool \"<name>\" isn't granted to this agent", async (t) => {
  const recipe = fakeRecipe(scratch(), { script: [{ call: 'snapshot', args: {} }, { sayLastResult: true }], style: 'goose', askMcp: false });
  const asked = [];
  const { session, events } = await openSession(t, recipe, { tools: [tool('lookup', () => 'found')], gate: async (call) => (asked.push(call), PARK) });
  await session.send('go');
  assert.equal((await session.turnEnd()).status, 'completed');
  assert.deepEqual(asked, []);
  assert.equal(texts(events), 'tool "snapshot" isn\'t granted to this agent');
});

for (const load of [true, false]) {
  test(`a refused request for a tool the agent is not given leaves nothing for a resume to ask: the next runner asks the gate only about the parked call (${load ? 'with' : 'without'} session/load)`, async (t) => {
    const dir = scratch();
    const nativeLog = join(dir, 'native.log');
    const store = memorySessionStore();
    const recipe = fakeRecipe(dir, { script: [{ call: 'snapshot', args: {} }, { native: 'execute', title: 'Run make deploy', input: { command: 'make deploy' } }, { sayLastResult: true }], style: 'cursor', load, http: load, nativeLog });
    const asked = [];
    const first = await openSession(t, recipe, { store, tools: [tool('lookup', () => 'found')], gate: async (call) => (asked.push(call), PARK) });
    await first.session.send('go');
    await until(() => asked.length === 1, 'the gate to be asked about the shell');
    first.stop(new Error('the run parked'));
    await first.session.turnEnd().catch(() => undefined);
    const parked = asked[0].callId;
    assert.equal(asked[0].tool, 'acp_execute');
    assert.deepEqual((await streamRecords(store, 'acp.permission')).map((r) => [r.type, r.callId]), [['asked', parked]], 'only the parked shell is journaled');

    const second = await openSession(t, recipe, { store, tools: [tool('lookup', () => 'found')], gate: async (call) => (asked.push(call), call.callId === parked ? 'allow' : { deny: `not ${call.callId}` }) });
    await second.session.recover();
    const end = await second.session.turnEnd();
    assert.equal(end.status, 'completed', end.error);
    assert.deepEqual(asked.map((c) => c.tool), ['acp_execute', 'acp_execute'], 'the resume asks about the parked shell alone, never the refused request');
    const answered = (await streamRecords(store, 'acp.permission')).filter((r) => r.type === 'answered');
    assert.deepEqual(answered.map((r) => [r.callId, r.answer]), [[parked, 'allow']], 'one answer, the person\'s, for the parked shell');
  });
}

/** A request for `snapshot` left waiting in the records, as a run parked on it keeps it: asked while the agent was given
 *  snapshot (its recipe without Goose's permission file or Cursor's tie, so the request is the gate's), the gate parking,
 *  the runner letting the session go. The store, the recipe, and the parked request's id. */
async function parkedOnSnapshot(t, style, over) {
  const store = memorySessionStore();
  const recipe = fakeRecipe(scratch(), { script: [{ call: 'snapshot', args: {} }, { sayLastResult: true }], style, askMcp: true }, over);
  const asked = [];
  const first = await openSession(t, recipe, { store, tools: [tool('snapshot', () => 'the page')], gate: async (call) => (asked.push(call), PARK) });
  await first.session.send('go');
  await until(() => asked.length === 1, 'the gate to be asked about snapshot');
  first.stop(new Error('the run parked'));
  await first.session.turnEnd().catch(() => undefined);
  assert.equal(asked[0].tool, 'acp_other');
  assert.deepEqual((await streamRecords(store, 'acp.permission')).map((r) => r.type), ['asked'], 'the request waits in the records');
  return { store, recipe, parked: asked[0].callId };
}

for (const [style, over] of [['goose', { allowFile: undefined }], ['cursor', { quirks: undefined }]]) {
  test(`(${style}) a request for a tool the agent is no longer given, left waiting in the records by a parked run, is refused on the resume: the gate is never asked, a settled deny is journaled in the words, and the turn goes on`, async (t) => {
    const { store, recipe, parked } = await parkedOnSnapshot(t, style, over);
    const asked = [];
    const second = await openSession(t, recipe, { store, tools: [tool('lookup', () => 'found')], gate: async (call) => (asked.push(call), PARK) });
    await second.session.recover();
    const end = await endOrAsked(second.session, asked);
    assert.deepEqual(asked.map((c) => [c.tool, c.callId]), [], 'no person is asked');
    assert.equal(end?.status, 'completed', end?.error);
    const answered = (await streamRecords(store, 'acp.permission')).filter((r) => r.type === 'answered');
    assert.deepEqual(answered.map((r) => [r.callId, r.answer, r.settled]), [[parked, 'deny', true]], 'the waiting request is answered, settled');
    assert.match(answered[0].words ?? '', /tool "snapshot" isn't granted to this agent/);
    assert.match(notices(second.events).join(' | '), /tool "snapshot" isn't granted to this agent/);
    const told = fakeEvents(recipe).filter((e) => e.type === 'prompt').map((e) => e.text.join('\n')).join('\n');
    assert.match(told, /Refused, with no person asked: tool "snapshot" isn't granted to this agent/, 'the agent\'s recovery note says why');
  });
}

test("(goose) a request for a tool the agent is still given, left waiting in the records by a parked run, is the gate's on the resume, as before", async (t) => {
  const { store, recipe, parked } = await parkedOnSnapshot(t, 'goose', { allowFile: undefined });
  const asked = [];
  const second = await openSession(t, recipe, { store, tools: [tool('snapshot', () => 'the page')], gate: async (call) => (asked.push(call), PARK) });
  void second.session.recover().catch(() => undefined);
  await until(() => asked.length > 0, 'the gate to be asked on the resume');
  assert.deepEqual(asked.map((c) => [c.tool, c.callId]), [['acp_other', parked]], 'the waiting request is the gate\'s');
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(fakeEvents(recipe).filter((e) => e.type === 'prompt').length, 1, 'parked again: the agent is not prompted on the resume');
  assert.deepEqual(notices(second.events), []);
});
