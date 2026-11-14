import assert from 'node:assert/strict';
import { test } from 'node:test';
import { serve, follow } from './support.mjs';
import { nativeFixture } from './native-fixtures/setup.mjs';
import { openSqliteStore } from '../dist/store/index.js';
import { createDispatchLoop } from '../dist/runner/dispatch.js';
import { createNativeLoop } from '../dist/runner/native-loop.js';
import { startRunner } from '../dist/runner/runner.js';
import { END_PATCH_MS } from '../dist/runner/loop.js';

const timing = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const within = async (promise, what) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${what}`)), 10_000); })]); }
  finally { clearTimeout(timer); }
};

for (const cancel of [false, true]) {
  test(`a native ${cancel ? 'cancel' : 'stop'} during the final metrics read owns the end and retains reported usage`, { timeout: 30_000 }, async t => {
    let runner, store, release;
    t.after(async () => { release?.(); await runner?.close(); await store?.close(); });
    const fixture = await nativeFixture(t);
    const names = ['PATH', 'HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'NATIVE_TEST_LOG'];
    const before = Object.fromEntries(names.map(name => [name, process.env[name]]));
    for (const name of names) process.env[name] = fixture.env[name];
    t.after(() => { for (const name of names) { if (before[name] === undefined) delete process.env[name]; else process.env[name] = before[name]; } });
    const { api, data } = await serve(t, { runner: false });
    const connected = await api('POST', '/native/connect', { project: fixture.project, runtime: 'codex' });
    assert.equal(connected.status, 200, JSON.stringify(connected.body));
    const id = connected.body.agent.agent_id;
    assert.equal((await api('PUT', `/agents/${id}/definition`, { definition: { instructions: '', learning: false } })).status, 200);
    store = await openSqliteStore({ dataDir: data, role: 'runner' });
    let readStarted, stopSeen, paused = false;
    const reading = new Promise(resolve => { readStarted = resolve; });
    const stopped = new Promise(resolve => { stopSeen = resolve; });
    const continueRead = new Promise(resolve => { release = resolve; });
    const dispatch = createDispatchLoop({
      launchOf: runId => store.runs.launch(runId),
      resolve: (_harness, launch) => deps => {
        const native = createNativeLoop(launch, { store, data, sealKey: Buffer.alloc(32) })({
          ...deps,
          journal: claim => {
            const journal = deps.journal(claim);
            return new Proxy(journal, { get(target, property) {
              const value = Reflect.get(target, property, target);
              if (property === 'scanEntries') return async (...args) => {
                const page = await value.apply(target, args);
                if (!paused && page.items.some(entry => entry.kind === 'agentrun.native.usage' && entry.data?.phase === 'task')) {
                  paused = true; readStarted(); await continueRead;
                }
                return page;
              };
              return typeof value === 'function' ? value.bind(target) : value;
            } });
          },
        });
        return { ...native, stop: reason => { const ending = native.stop(reason); stopSeen(); return ending; } };
      },
    });
    runner = startRunner({ store, createLoop: dispatch, name: 'native-end-control', ...timing });
    const start = await api('POST', `/agents/${id}/runs`, { input: { content: 'Answer once.' } });
    assert.equal(start.status, 202, JSON.stringify(start.body));
    await within(reading, 'the native end metrics read');
    assert.equal((await api('POST', `/runs/${start.body.run_id}/${cancel ? 'cancel' : 'stop'}`, {})).status, cancel ? 202 : 200);
    await within(stopped, 'the native loop to receive the stop');
    release();
    let row;
    const deadline = Date.now() + 5_000;
    for (;;) {
      row = await store.runs.get(start.body.run_id);
      if (row.runner === null && ['ended', 'stopped', 'failed'].includes(row.state)) break;
      assert.ok(Date.now() < deadline, 'the native run releases its final end');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(row.state, 'stopped', 'the person owns the end, never a completed native answer');
    assert.equal(row.outcome, cancel ? 'cancelled' : 'stopped');
    // A resumable person's stop is input_required/idle in the shared run view; a cancel is final.
    await follow(api, start.body.run_id, [cancel ? 'cancelled' : 'input_required'], { deadlineMs: 5_000 });
    assert.equal(row.costUsd, null, 'the native runtime reported no dollar cost');
    assert.equal(row.metrics.output, 4, 'usage reported before the stop stays with its end');
    const command = (await store.commands(start.body.run_id, 0)).find(command => ['stop', 'cancel'].includes(command.kind));
    assert.ok(command); assert.notEqual(command.takenAt, null); assert.equal(command.refused, null, 'the end takes the command rather than refusing it as a leftover');
    assert.equal((await fixture.calls()).filter(call => call.args[0] === 'exec').length, 1, 'no second dispatch');
  });
}

for (const mode of ['reject', 'stall', 'stall-stop']) {
  test(`a native terminal metrics ${mode} preserves the task end and releases its source lock`, { timeout: END_PATCH_MS + 25_000 }, async t => {
    let runner, store, release;
    t.after(async () => { release?.(); await runner?.close(); await store?.close(); });
    const fixture = await nativeFixture(t);
    const names = ['PATH', 'HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'NATIVE_TEST_LOG'];
    const before = Object.fromEntries(names.map(name => [name, process.env[name]]));
    for (const name of names) process.env[name] = fixture.env[name];
    t.after(() => { for (const name of names) { if (before[name] === undefined) delete process.env[name]; else process.env[name] = before[name]; } });
    const { api, data } = await serve(t, { runner: false });
    const connected = await api('POST', '/native/connect', { project: fixture.project, runtime: 'codex' });
    assert.equal(connected.status, 200, JSON.stringify(connected.body));
    const id = connected.body.agent.agent_id;
    assert.equal((await api('PUT', `/agents/${id}/definition`, { definition: { instructions: '', learning: false } })).status, 200);
    store = await openSqliteStore({ dataDir: data, role: 'runner' });
    let readStarted, stopSeen, injected = false;
    const reading = new Promise(resolve => { readStarted = resolve; });
    const stopped = new Promise(resolve => { stopSeen = resolve; });
    const continueRead = new Promise(resolve => { release = resolve; });
    const dispatch = createDispatchLoop({
      launchOf: runId => store.runs.launch(runId),
      resolve: (_harness, launch) => deps => {
        const native = createNativeLoop(launch, { store, data, sealKey: Buffer.alloc(32) })({
          ...deps,
          journal: claim => {
            const journal = deps.journal(claim);
            return new Proxy(journal, { get(target, property) {
              const value = Reflect.get(target, property, target);
              if (property === 'scanEntries') return async (...args) => {
                const page = await value.apply(target, args);
                if (!injected && page.items.some(entry => entry.kind === 'agentrun.native.usage' && entry.data?.phase === 'task')) {
                  injected = true; readStarted();
                  if (mode === 'reject') throw new Error('Injected terminal metrics scan rejection');
                  await continueRead;
                }
                return page;
              };
              return typeof value === 'function' ? value.bind(target) : value;
            } });
          },
        });
        return { ...native, stop: reason => { const ending = native.stop(reason); stopSeen(); return ending; } };
      },
    });
    runner = startRunner({ store, createLoop: dispatch, name: 'native-end-bound', ...timing });
    const start = await api('POST', `/agents/${id}/runs`, { input: { content: 'Answer once.' } });
    assert.equal(start.status, 202, JSON.stringify(start.body));
    await within(reading, 'the native end metrics read');
    if (mode === 'stall-stop') {
      assert.equal((await api('POST', `/runs/${start.body.run_id}/stop`, {})).status, 200);
      await within(stopped, 'the native loop to receive the stop');
    }
    let row;
    const deadline = Date.now() + (mode === 'reject' ? 5_000 : END_PATCH_MS + 5_000);
    for (;;) {
      row = await store.runs.get(start.body.run_id);
      if (row.runner === null && ['ended', 'stopped', 'failed'].includes(row.state)) break;
      assert.ok(Date.now() < deadline, 'the native end must settle even while its metrics read is stalled');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(row.state, mode === 'stall-stop' ? 'stopped' : 'ended');
    assert.equal(row.outcome, mode === 'stall-stop' ? 'stopped' : 'completed');
    assert.equal(row.costUsd, null);
    assert.equal(row.metrics, null, 'a failed or late end read leaves all usage and path unknown');
    if (mode === 'stall-stop') {
      const command = (await store.commands(start.body.run_id, 0)).find(command => command.kind === 'stop');
      assert.ok(command); assert.notEqual(command.takenAt, null); assert.equal(command.refused, null);
    }
    const next = await api('POST', `/agents/${id}/runs`, { input: { content: 'A separate task after the end.' } });
    assert.equal(next.status, 202, JSON.stringify(next.body));
    await follow(api, next.body.run_id, ['completed'], { deadlineMs: 5_000 });
    assert.equal((await fixture.calls()).filter(call => call.args[0] === 'exec').length, 2, 'one dispatch per task, and the stalled read cannot hold the source lock');
    release();
    await new Promise(resolve => setTimeout(resolve, 50));
    const after = await store.runs.get(start.body.run_id);
    assert.equal(after.state, row.state); assert.equal(after.outcome, row.outcome);
    assert.equal(after.costUsd, null); assert.equal(after.metrics, null, 'a late read never rewrites the end');
  });
}
