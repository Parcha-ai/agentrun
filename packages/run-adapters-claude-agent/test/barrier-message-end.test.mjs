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
    }),
  });
  const ran = [];
  const submit = { name: 'submit', description: 'Submit a job.', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, replay: 'never', call: async (args) => (ran.push(args), { text: 'submitted' }) };
  const store = memorySessionStore();
  const io = { writer: await store.open('s1'), models: { beforeRequest: async () => ({ turn: 0 }), afterRequest: async () => {} }, signal: new AbortController().signal, dir: scratch(), onEvent: () => {} };
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
    return { end, ran, ended: ended.sort((a, b) => a.index - b.index) };
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
  const { end, ran, ended } = await batchTurn(t, { n: 12, gapMs: 1300, lost: [1] });
  assert.equal(end.status, 'completed');
  const first = ended.find((call) => call.index === 1);
  assert.equal(first.isError, true);
  assert.match(first.text, REFUSED);
  const messageEnd = 12 * 1300;
  assert.ok(first.at >= messageEnd + BARRIER_MS && first.at <= messageEnd + BARRIER_MS + STEP_MS, `refused at ${first.at} ms, ${messageEnd + BARRIER_MS} ms expected`);
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
  assert.ok(lost.ended[0].at >= 200 + BARRIER_MS && lost.ended[0].at <= 200 + BARRIER_MS + STEP_MS, `refused at ${lost.ended[0].at} ms`);
  assert.equal(lost.ran.length, 0);
});
