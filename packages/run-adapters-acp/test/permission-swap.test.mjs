// Named case 2 of the slice (design TDD §5, S2): a parked permission survives a runner swap. The agent asks permission for
// a tool of its own (a shell); the host's gate parks the run on a person, and the runner lets the session go. Another
// runner opens it from the records, the agent asks again, the request maps to the same call, the person's approval
// answers it, and the tool runs once.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test as nodeTest } from 'node:test';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { fakeEvents, fakeRecipe, openSession, scratch, streamRecords, until } from './helpers.mjs';

const test = (name, fn) => nodeTest(name, { timeout: 60_000 }, fn);
const lines = (file) => {
  try {
    return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
};

for (const load of [true, false]) {
  test(`a parked permission survives a runner swap (${load ? 'with' : 'without'} session/load)`, async (t) => {
    const dir = scratch();
    const nativeLog = join(dir, 'native.log');
    const store = memorySessionStore();
    const recipe = fakeRecipe(dir, { script: [{ native: 'execute', title: 'Run make deploy', input: { command: 'make deploy' } }, { sayLastResult: true }], style: 'cursor', load, http: load, nativeLog });
    const asked = [];
    const first = await openSession(t, recipe, { store, gate: async (call) => (asked.push(call), { park: true }) });
    await first.session.send('deploy it');
    await until(() => asked.length === 1, 'the gate to be asked');
    assert.equal(asked[0].tool, 'acp_execute');
    assert.deepEqual(lines(nativeLog), [], 'parked: nothing ran');
    // The run parks on the person: the runner lets the session go.
    first.stop(new Error('the run parked'));
    await first.session.turnEnd().catch(() => undefined);
    const parked = asked[0].callId;
    const journaled = await streamRecords(store, 'acp.permission');
    assert.deepEqual(journaled.map((r) => [r.type, r.callId]), [['asked', parked]], 'the request is in the records, unanswered');

    // The person approves; another runner picks the run up.
    const second = await openSession(t, recipe, { store, gate: async (call) => (asked.push(call), call.callId === parked ? 'allow' : { deny: `not ${call.callId}` }) });
    assert.equal(second.session.state, 'open_turn');
    await second.session.recover();
    const end = await second.session.turnEnd();
    assert.equal(end.status, 'completed', end.error);
    assert.deepEqual(asked.map((c) => c.callId), [parked, parked], 'the second request maps to the same call');
    assert.deepEqual(lines(nativeLog), ['Run make deploy'], 'approved, it ran once');
    const permissions = fakeEvents(recipe).filter((e) => e.type === 'permission');
    assert.deepEqual(permissions.map((e) => e.kind), ['allow_once'], 'allowed once at the protocol, never always');
    const answered = (await streamRecords(store, 'acp.permission')).filter((r) => r.type === 'answered');
    assert.deepEqual(answered.map((r) => [r.callId, r.answer]), [[parked, 'allow']]);
    const said = second.events.filter((e) => e.type === 'text').map((e) => e.delta).join('');
    assert.equal(said, 'ran Run make deploy');
  });
}
