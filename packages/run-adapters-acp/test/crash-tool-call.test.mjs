// Named case 1 of the slice (design TDD §5, S2): a crash between an ACP tool_call and its tool_call_update reports the
// call once. The agent announces the call (tool_call), calls our MCP server, and the runner dies while the call runs: no
// update ever comes. Another runner opens the session from the records: the call is never run again, never shown twice,
// and the agent reads that it was interrupted.
import assert from 'node:assert/strict';
import { test as nodeTest } from 'node:test';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { fakeEvents, fakeRecipe, openSession, scratch, tool, toolEffects, until } from './helpers.mjs';

const test = (name, fn) => nodeTest(name, { timeout: 60_000 }, fn);

for (const load of [true, false]) {
  test(`a crash between tool_call and its tool_call_update reports the call once (${load ? 'with' : 'without'} session/load)`, async (t) => {
    const store = memorySessionStore();
    const recipe = fakeRecipe(scratch(), { script: [{ call: 'effect' }, { sayLastResult: true }], load, http: load });
    let ran = 0;
    let started = false;
    // The effect starts, and the runner dies before it answers: its process holds the turn, then is gone.
    const hung = tool('effect', () => {
      ran += 1;
      started = true;
      return new Promise(() => {});
    });
    const first = await openSession(t, recipe, { store, tools: [hung] });
    await first.session.send('go');
    await until(() => started, 'the effect to start');
    const announced = fakeEvents(recipe).filter((e) => e.type === 'mcp');
    assert.equal(announced.length, 1, 'the agent announced the call and called our server');
    first.stop(new Error('the runner died'));
    await first.session.turnEnd().catch(() => undefined);

    // Another runner, its own sessions folder, the same records.
    const second = await openSession(t, recipe, { store, tools: [tool('effect', () => ((ran += 1), 'effect done'))] });
    assert.equal(second.session.state, 'open_turn', 'the turn the crash cut is open');
    await second.session.recover();
    const end = await second.session.turnEnd();
    assert.equal(end.status, 'completed', end.error);
    assert.equal(ran, 1, 'the effect ran once, never again after the crash');
    const starts = [...first.events, ...second.events].filter((e) => e.type === 'tool_start');
    assert.deepEqual(starts.map((e) => e.callId), ['call_0'], 'the call is reported once, under its own id');
    assert.equal(second.events.some((e) => e.type === 'tool_end'), false, 'no result is made up for it');
    assert.equal((await toolEffects(store, 'effect')).length, 1, 'one intent');
    const said = second.events.filter((e) => e.type === 'text').map((e) => e.delta).join('');
    assert.match(said, /interrupted|may have taken effect/i, `the agent read that the call was cut: ${said}`);
    const prompts = fakeEvents(recipe).filter((e) => e.type === 'prompt');
    assert.match(prompts.at(-1).text.join('\n'), /\[Recovery\][\s\S]*call call_0:/, 'the recovery note names the call');
  });
}
