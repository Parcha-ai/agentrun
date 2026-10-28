// A runner's stop: a pause of every node it runs. With drainMs, the session is asked to drain (its calls in flight run on
// until their outcomes are recorded), and while it does, what the runner gives it refuses anything new: a paid request, a
// tool call, a turn. Then the node fails `aborted`, its session resumable from its records; a node started after the stop
// fails at once.
import assert from 'node:assert/strict';
import { test as nodeTest } from 'node:test';
import { createHarnessRunner, HarnessRunError } from '@parcha/agentrun-adapters';
import { memorySessionStore } from '@parcha/agentrun-adapters/testing';

const test = (name, fn) => nodeTest(name, { timeout: 30_000 }, fn);
const SCHEMA = { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } };
const ask = (runNode) => runNode({ kind: 'agent', label: 'task', system: [], user: 'Go.', schema: SCHEMA, tools: ['lookup'] });
const lookup = { name: 'lookup', description: 'Look something up.', inputSchema: { type: 'object' }, replay: 'safe', call: async () => ({ text: 'found' }) };

async function until(ready, what) {
  for (const end = Date.now() + 5_000; !ready(); await new Promise((resolve) => setTimeout(resolve, 5))) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
}

/** An adapter whose turn runs until it is interrupted. Its interrupt says what it was asked, and, as a draining session's
 *  calls would, tries a paid request and a tool call through what the runner gave it. */
function pausable({ cleanupMs = 0 } = {}) {
  const seen = { opened: 0, sends: 0, interrupts: [], duringDrain: undefined };
  let endTurn;
  const adapter = {
    id: 'pausable',
    version: '0.0.0',
    capabilities: () => ({ fork: false }),
    check: () => [],
    async open(spec, io) {
      seen.opened += 1;
      let turn;
      return {
        state: 'new',
        async send() {
          seen.sends += 1;
          turn = new Promise((resolve) => { endTurn = resolve; });
        },
        async recover() {},
        turnEnd: () => turn,
        async interrupt(options) {
          seen.interrupts.push(options ?? {});
          if (!seen.duringDrain) {
            const tool = spec.tools.find((t) => t.name === 'lookup');
            seen.duringDrain = {
              request: await io.models.beforeRequest({ model: 'm' }).then(() => 'sent', (error) => error.message),
              call: await tool.call({}, { callId: 'c1', signal: new AbortController().signal }).then(() => 'ran', (error) => error.message),
            };
          }
          endTurn?.({ status: 'interrupted' });
          // The turn has ended; letting go of its processes takes a moment more.
          if (cleanupMs) await new Promise((resolve) => setTimeout(resolve, cleanupMs));
        },
        async close() {},
      };
    },
  };
  return { adapter, seen, started: () => Boolean(endTurn) };
}

test('stop({ drainMs }) asks the session to drain, refuses anything new meanwhile, then the node fails aborted', async () => {
  const { adapter, seen, started } = pausable();
  const runner = createHarnessRunner(adapter, { store: memorySessionStore(), tools: [lookup] });
  const node = ask(runner);
  const outcome = node.then(() => 'delivered', (error) => error);
  await until(started, 'the turn');
  await runner.stop({ drainMs: 1500 });
  const error = await outcome;
  assert.ok(error instanceof HarnessRunError && error.reason === 'aborted', String(error));
  assert.equal(seen.interrupts[0]?.drainMs, 1500, 'the session was asked to drain, for the time given');
  assert.match(seen.duringDrain.request, /pausing/, 'no new paid request while it drains');
  assert.match(seen.duringDrain.call, /pausing; this call was not run/, 'no new tool call while it drains');
  assert.equal(seen.sends, 1, 'no new turn');
});

test('a node whose turn ends while its session is still letting go sends no new turn', async () => {
  const { adapter, seen, started } = pausable({ cleanupMs: 150 });
  const runner = createHarnessRunner(adapter, { store: memorySessionStore(), tools: [lookup] });
  const node = ask(runner).catch((error) => error);
  await until(started, 'the turn');
  await runner.stop({ drainMs: 1000 });
  assert.equal((await node).reason, 'aborted');
  assert.equal(seen.sends, 1, 'the pause sent nothing after the turn it ended');
});

test('a stop while a node is still opening its session record stops it before its session opens', async () => {
  const { adapter, seen } = pausable();
  const store = memorySessionStore();
  const slow = Object.create(store);
  slow.open = async (key) => { await new Promise((resolve) => setTimeout(resolve, 150)); return store.open(key); };
  const runner = createHarnessRunner(adapter, { store: slow, tools: [lookup] });
  const node = ask(runner).catch((error) => error);
  await runner.stop({ drainMs: 1000 });
  assert.equal((await node).reason, 'aborted');
  assert.equal(seen.opened, 0, 'no session was opened');
});

test('a node started after stop fails aborted at once, and opens no session', async () => {
  const { adapter, seen } = pausable();
  const runner = createHarnessRunner(adapter, { store: memorySessionStore(), tools: [lookup] });
  await runner.stop({ drainMs: 100 });
  await assert.rejects(ask(runner), (error) => error instanceof HarnessRunError && error.reason === 'aborted');
  assert.equal(seen.opened, 0);
});

test('stop with no drainMs stops at once, and a drainMs that is not a non-negative number is refused', async () => {
  const { adapter, seen, started } = pausable();
  const runner = createHarnessRunner(adapter, { store: memorySessionStore(), tools: [lookup] });
  await assert.rejects(runner.stop({ drainMs: -1 }), /drainMs must be a non-negative number/);
  await assert.rejects(runner.stop({ drainMs: Number.NaN }), /drainMs must be a non-negative number/);
  const node = ask(runner).catch((error) => error);
  await until(started, 'the turn');
  await runner.stop();
  assert.equal((await node).reason, 'aborted');
  assert.equal(seen.interrupts[0]?.drainMs, 0);
});

test('a paid request waiting to be admitted when a pause begins is refused inside the admission, and one the host was still checking too: no record, no request_start', async () => {
  let releaseHost;
  const hostHeld = new Promise((resolve) => { releaseHost = resolve; });
  let hostCalls = 0;
  const outcomes = [];
  let endTurn;
  let asked;
  const asking = new Promise((resolve) => { asked = resolve; });
  const adapter = {
    id: 'two-requests', version: '0.0.0', capabilities: () => ({ fork: false }), check: () => [],
    async open(_spec, io) {
      let turn;
      return {
        state: 'new',
        async send() {
          turn = new Promise((resolve) => { endTurn = resolve; });
          // Two paid requests at once: A is held in the host's check, B waits behind it in the admission chain.
          for (const name of ['A', 'B']) outcomes.push(io.models.beforeRequest({ model: 'm' }).then(() => `${name} admitted`, (error) => `${name} refused: ${error.message}`));
          asked();
        },
        async recover() {},
        turnEnd: () => turn,
        async interrupt() {
          // The pause began; now the host's check of A answers. Neither A nor B may be admitted after this point.
          releaseHost();
          await Promise.all(outcomes);
          endTurn?.({ status: 'interrupted' });
        },
        async close() {},
      };
    },
  };
  const store = memorySessionStore();
  const events = [];
  const runner = createHarnessRunner(adapter, {
    store, tools: [lookup], onEvent: (e) => events.push(e),
    beforeRequest: async () => { hostCalls += 1; if (hostCalls === 1) await hostHeld; },
  });
  const node = ask(runner).catch((error) => error);
  await asking;
  await until(() => hostCalls === 1, "the host's check of A");
  await runner.stop({ drainMs: 1000 });
  assert.equal((await node).reason, 'aborted');
  const results = await Promise.all(outcomes);
  assert.deepEqual(results.map((r) => r.replace(/: .*/, '')), ['A refused', 'B refused'], results.join(' | '));
  assert.ok(results.every((r) => /pausing: no new paid request/.test(r)), results.join(' | '));
  const records = await Promise.all(store.keys().map((k) => store.read(k)));
  assert.deepEqual(records.flat().filter((r) => r.kind === 'runner.request'), [], 'no request was recorded');
  assert.deepEqual(events.filter((e) => e.type === 'request_start'), [], 'no request_start');
  assert.equal(hostCalls, 1, 'the host is not asked about a request that waited until after the pause began');
});
