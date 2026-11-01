// code-mode.ts (written for AgentRun) and the copied harness.ts import each other: the harness takes code mode's hooks, and code mode's
// repair answers a dangling call with the harness's repairOutput. That holds only while code mode reads repairOutput inside its functions,
// never at module top level. Each order a module graph can be entered in runs in a cold process, so no cached module hides the order.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const CODE_MODE = new URL('../dist/code-mode.js', import.meta.url).href;
const HARNESS = new URL('../dist/harness.js', import.meta.url).href;

/** Import `first`, then the other module, then run the no-note repair on a rollout with one unanswered call; print what it injects. */
const script = (first) => `
await import(${JSON.stringify(first)});
const { codeMode } = await import(${JSON.stringify(CODE_MODE)});
await import(${JSON.stringify(HARNESS)});
const injected = [];
const code = codeMode({
  ctx: { state: () => ({ effects: new Map(), submissions: [], effectOrder: [] }), isMemoized: () => false },
  machine: {},
  journal: { append() {}, flush: async () => {}, read: async () => [] },
  logged: new Set(),
  synced: async () => {},
  bridge: { get: () => undefined },
  log() {},
  lines: [],
  rpc: () => ({ request: async (_method, params) => { injected.push(...params.items); } }),
  guard: (promise) => promise,
  threadId: () => 'thread-1',
  tries: 1,
  declined: 'declined',
});
const line = JSON.stringify({ timestamp: '2026-10-30T00:00:00.000Z', type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{}', call_id: 'c1' } });
await code.repairUnnoted([line]);
process.stdout.write(JSON.stringify(injected));
`;

for (const [order, first] of [['code-mode.js first', CODE_MODE], ['harness.js first, the order a host takes', HARNESS]]) {
  test(`code mode and the harness load in either order and the repair reads repairOutput: ${order}`, () => {
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script(first)], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(run.status, 0, run.stderr);
    const injected = JSON.parse(run.stdout);
    assert.equal(injected.length, 1);
    assert.deepEqual({ type: injected[0].type, call_id: injected[0].call_id }, { type: 'function_call_output', call_id: 'c1' });
    assert.match(injected[0].output, /^Not executed: the session stopped before this call started/);
  });
}
