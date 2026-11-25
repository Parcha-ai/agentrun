// A host tool with replay `never` runs only once the transcript line that made its call is in the log (the barrier).
// The SDK's mirror hands the session store a message's lines only once that message ends, while the CLI starts each call
// as its block ends: so the barrier's clock runs from the message's stream, not from the call. On the scripted Agent SDK
// (./testing) and a fake clock for the barrier and the stream: no real waits, no key, no network, no CLI.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test as nodeTest } from 'node:test';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { claudeAgentAdapter } from '@parcha/agentrun-harness-claude';
import { fakeAnthropic, fakeSdk } from '@parcha/agentrun-harness-claude/testing';

process.env.AGENTRUN_CLAUDE_AGENT_STANDIN = '1';
const test = (name, fn) => nodeTest(name, { timeout: 60_000 }, fn);
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-claude-barrier-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let n = 0;
const scratch = () => mkdtempSync(join(ROOT, `t${n++}-`));

/** The barrier's default wait. */
const BARRIER_MS = 10_000;
/** How far the fake clock moves at a time, and how long a turn may take on it. */
const STEP_MS = 50;
const LIMIT_MS = 120_000;
const REFUSED = /the transcript entry for tool call \S+ did not reach the log within 10000 ms/;

/** Let the real work a moment of fake time started (in-memory MCP calls, journal commits) run to rest. */
const settle = async () => {
  for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve));
};

/** A clock the barrier and the scripted stream both wait on: time moves only when `advance` moves it. */
function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  const clock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id) => void timers.delete(id),
    sleep: (ms) => new Promise((resolve) => clock.setTimeout(resolve, ms)),
    /** Fire every timer due within `ms`, in order, each at its own instant, settling after each. */
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        await settle();
        const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
  };
  return clock;
}

/** One turn whose "model" makes one message of `batch` calls to `submit` (replay `never`), on a fake clock. */
async function batchTurn(t, batch) {
  const clock = fakeClock();
  const provider = await fakeAnthropic({ reply: () => ({ text: 'ok' }) });
  t.after(() => provider.close());
  const ended = [];
  const events = [];
  // The fake instant the harness took the message's message_stop. The fake clock moves while real work (the in-memory
  // MCP calls, the journal) is still settling, so on a loaded machine the harness can hear the stop a step or more after
  // the stream yielded it; a refusal is due BARRIER_MS after the harness heard it, never before the message ended.
  let stopTakenAt;
  const adapter = claudeAgentAdapter({
    model: 'claude-test',
    provider: { origin: provider.url, credential: () => 'provider-secret' },
    price: () => 0,
    standIn: { command: process.execPath },
    barrierTimers: clock,
    sdk: fakeSdk({
      script: [`batch ${JSON.stringify({ tool: 'submit', args: { q: 'x' }, ...batch })}`],
      sleep: clock.sleep,
      onCallEnd: (call) => ended.push({ ...call, at: clock.now() }),
      onMessageEnd: () => (stopTakenAt = clock.now()),
    }),
  });
  const ran = [];
  const submit = { name: 'submit', description: 'Submit a job.', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, replay: 'never', call: async (args) => (ran.push(args), { text: 'submitted' }) };
  const store = memorySessionStore();
  const io = { writer: await store.open('s1'), models: { beforeRequest: async () => ({ turn: 0 }), afterRequest: async () => {} }, signal: new AbortController().signal, dir: scratch(), onEvent: (event) => events.push(event) };
  const session = await adapter.open({ key: 's1', label: 'root', system: [], tools: [submit], context: 'fresh' }, io);
  try {
    let end;
    const turn = (async () => {
      await session.send('go');
      end = await session.turnEnd();
    })();
    turn.catch(() => {});
    while (end === undefined && clock.now() < LIMIT_MS) await clock.advance(STEP_MS);
    await turn;
    return { end, ran, events, stopTakenAt, ended: ended.sort((a, b) => a.index - b.index) };
  } finally {
    await session.close();
  }
}

test('a call made more than the barrier before its message ends runs: 12 blocks streamed 1.3 s apart', async (t) => {
  const { end, ran, ended } = await batchTurn(t, { n: 12, gapMs: 1300 });
  assert.equal(end.status, 'completed');
  assert.equal(ended.length, 12);
  for (const call of ended) assert.deepEqual({ index: call.index, isError: call.isError, text: call.text }, { index: call.index, isError: false, text: 'submitted' }, `call ${call.index} ran`);
  assert.equal(ran.length, 12, 'the tool ran for every call');
});

test("a call whose line never reaches the log is still refused, the barrier's wait after its message ended", async (t) => {
  // Block 1's line is lost; the message's last block ends at 12 x 1.3 s.
  const { end, ran, ended, stopTakenAt } = await batchTurn(t, { n: 12, gapMs: 1300, lost: [1] });
  assert.equal(end.status, 'completed');
  const first = ended.find((call) => call.index === 1);
  assert.equal(first.isError, true);
  assert.match(first.text, REFUSED);
  const messageEnd = 12 * 1300;
  assert.ok(first.at >= messageEnd + BARRIER_MS, `refused at ${first.at} ms, before its message ended plus the barrier (${messageEnd + BARRIER_MS} ms)`);
  assert.ok(first.at <= stopTakenAt + BARRIER_MS + STEP_MS, `refused at ${first.at} ms, more than the barrier after the harness heard the message end (${stopTakenAt} ms)`);
  assert.deepEqual(ended.filter((call) => call.index !== 1).map((call) => call.isError), Array(11).fill(false), 'the other calls ran');
  assert.equal(ran.length, 11);
});

test('a short message of one call behaves as before: it runs, and a lost line is refused the barrier after the call', async (t) => {
  const ok = await batchTurn(t, { n: 1, gapMs: 200 });
  assert.equal(ok.end.status, 'completed');
  assert.deepEqual(ok.ended.map((call) => [call.isError, call.text]), [[false, 'submitted']]);
  const lost = await batchTurn(t, { n: 1, gapMs: 200, lost: [1] });
  assert.equal(lost.ended[0].isError, true);
  assert.match(lost.ended[0].text, REFUSED);
  assert.ok(lost.ended[0].at >= 200 + BARRIER_MS && lost.ended[0].at <= lost.stopTakenAt + BARRIER_MS + STEP_MS, `refused at ${lost.ended[0].at} ms, the stop heard at ${lost.stopTakenAt} ms`);
  assert.equal(lost.ran.length, 0);
});

test("a call the CLI refuses itself early in a long message is still shown to the host once its answer is in the log", async (t) => {
  // The CLI answers block 1 itself (a tool the session doesn't have) at 1.3 s; its answer is mirrored with the message, at 15.6 s.
  const { end, events, ended } = await batchTurn(t, { n: 12, gapMs: 1300, refused: [1] });
  assert.equal(end.status, 'completed');
  assert.equal(ended.length, 11, 'the other calls ran');
  const shown = events.filter((event) => event.type === 'tool_end' && event.isError && !ended.some((call) => call.id === event.callId));
  assert.equal(shown.length, 1, 'the refused call is shown to the host as a call that failed');
  assert.equal(shown[0].name, 'submit');
});

/** The store alone, on a journal that keeps nothing. */
async function storeOn(clock) {
  const { JournalSessionStore } = await import('../dist/store.js');
  const journal = { append: () => {}, message: () => {}, flush: async () => {} };
  return new JournalSessionStore(journal, { records: [], timers: clock });
}
const assistantCall = (id, parent = null) => ({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'tool_use', id, name: 'mcp__hands__submit', input: {} }] } });
const streamEvent = (parent = null) => ({ type: 'stream_event', parent_tool_use_id: parent, event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{}' } } });
/** When a barrier on `id` settled, on the fake clock. */
const settledAt = (clock, promise) => promise.then(() => ({ ok: true, at: clock.now() }), (error) => ({ ok: false, at: clock.now(), error: String(error.message) }));

test("the barrier's clock restarts only on its own message's stream: a subagent's events don't hold a main-thread call", async () => {
  const clock = fakeClock();
  const store = await storeOn(clock);
  store.heard(assistantCall('toolu_main'));
  const main = settledAt(clock, store.barrier('toolu_main', BARRIER_MS));
  // A subagent streams the whole time; its events are not the main message's.
  for (let at = 0; at < 3 * BARRIER_MS; at += 500) {
    store.heard(streamEvent('toolu_task'));
    await clock.advance(500);
  }
  const outcome = await main;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.at, BARRIER_MS, 'refused the barrier after its own message last streamed');
});

test("the barrier's clock runs from the call when no stream names it, and its own stream's events restart it", async () => {
  const clock = fakeClock();
  const store = await storeOn(clock);
  const unnamed = settledAt(clock, store.barrier('toolu_unnamed', BARRIER_MS));
  store.heard(assistantCall('toolu_named'));
  const named = settledAt(clock, store.barrier('toolu_named', BARRIER_MS));
  for (let at = 0; at < 2 * BARRIER_MS; at += 1000) {
    store.heard(streamEvent());
    await clock.advance(1000);
  }
  assert.deepEqual(await unnamed, { ok: false, at: BARRIER_MS, error: `the transcript entry for tool call toolu_unnamed did not reach the log within ${BARRIER_MS} ms` });
  // Its line lands: the wait ends at once.
  await store.append({ projectKey: 'p', sessionId: 's' }, [{ type: 'assistant', uuid: 'u1', ...assistantCall('toolu_named') }]);
  assert.deepEqual(await named, { ok: true, at: 2 * BARRIER_MS });
});
