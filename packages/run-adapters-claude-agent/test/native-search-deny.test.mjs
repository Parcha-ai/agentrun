// A deny set while a run is live reaches Claude Code's own WebSearch. The run's process is built with WebSearch on (the
// plane resolved web_search to native at launch); later the operator denies web_search. The adapter's one channel that
// hears a permission change mid-run is the host's gate (SessionIO.gate: the runner's RunGate reads the tool settings at
// each call), so the test's gate starts allowing everything and denies everything once the deny is set. The session's
// next WebSearch must be refused, or the CLI must no longer be offered WebSearch. The real harness and its hooks run on
// the scripted Agent SDK (./testing), whose "CLI" asks the PreToolUse hook about each built-in call: no key, no network,
// no Claude Agent CLI, no waits.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { claudeAgentAdapter } from '@parcha/agentrun-harness-claude';
import { fakeAnthropic, fakeSdk } from '@parcha/agentrun-harness-claude/testing';

process.env.AGENTRUN_CLAUDE_AGENT_STANDIN = '1';
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-claude-search-deny-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const DENIED = 'Permission denied: web_search is set to deny.';
/** Whether `options` (one query's) offers the CLI WebSearch. */
const offersSearch = (options) => (options.tools ?? []).includes('WebSearch') && !(options.disallowedTools ?? []).includes('WebSearch');

test("a deny set mid-run reaches Claude Code's WebSearch: the next search is refused, or no longer offered", { timeout: 60_000 }, async (t) => {
  const provider = await fakeAnthropic({ reply: () => ({ text: 'ok' }) });
  t.after(() => provider.close());
  const decided = [];
  const queries = [];
  // Each turn's "model" searches the web once with the CLI's own WebSearch.
  const sdk = fakeSdk({
    mirrorLagMs: 10,
    script: ['builtin WebSearch {"query":"agentrun before"}', 'builtin WebSearch {"query":"agentrun after"}'],
    onDecision: (d) => decided.push(d),
    onQuery: (options) => queries.push({ at: decided.length, options }),
  });
  const adapter = claudeAgentAdapter({
    model: 'claude-test',
    provider: { origin: provider.url, credential: () => 'provider-secret' },
    price: () => 0,
    sessionsDir: join(mkdtempSync(join(ROOT, 's-')), 'sessions'),
    standIn: { command: process.execPath },
    sdk,
    // What serve's claudeOf hands the adapter where the run's plane resolved web_search to native (adapters.ts nativeOptions).
    webSearch: true,
  });
  let denied = false;
  const asked = [];
  const gate = async (call) => {
    asked.push({ tool: call.tool, denied });
    return denied ? { deny: DENIED } : 'allow';
  };
  const store = memorySessionStore();
  const io = { writer: await store.open('s1'), models: { beforeRequest: async () => ({ turn: 0 }), afterRequest: async () => {} }, signal: new AbortController().signal, dir: mkdtempSync(join(ROOT, 'd-')), onEvent: () => {}, gate };
  const session = await adapter.open({ key: 's1', label: 'root', system: [], tools: [], context: 'fresh' }, io);
  try {
    // Turn 1, web_search allowed: the search runs (WebSearch is on for this run).
    await session.send('search');
    assert.equal((await session.turnEnd()).status, 'completed');
    const before = decided.filter((d) => d.name === 'WebSearch');
    assert.deepEqual(before.map((d) => d.decision), ['allow'], `turn 1's search ran: ${JSON.stringify(decided)}`);

    // The operator denies web_search while the run is live: from now on the run's gate refuses it.
    denied = true;
    const seen = decided.length;
    await session.send('search again');
    await session.turnEnd();
    const after = decided.slice(seen).filter((d) => d.name === 'WebSearch');
    // The query options in force when the search was made (the CLI may be relaunched per turn with other options).
    const inForce = queries.filter((q) => q.at <= seen).at(-1)?.options;
    const offered = inForce === undefined || offersSearch(inForce);
    assert.ok(
      after.every((d) => d.decision !== 'allow') || !offered,
      `the search after the deny ran: PreToolUse answered ${JSON.stringify(after.map((d) => d.decision))}, WebSearch still offered (tools ${JSON.stringify(inForce?.tools)}), and the gate was asked about ${JSON.stringify(asked.filter((a) => a.denied).map((a) => a.tool))}`,
    );
  } finally {
    await session.close();
  }
});

// Ask set mid-run: the next WebSearch waits on the person. The gate parks it (the runner parks the run and stops its
// signal); nothing of the search runs. The resume puts the held call to the gate again under the id the model gave it:
// a deny answers it in the gate's words, an allow lets the model's next search with the same query run, once, with no
// second card.
const SEARCH = 'builtin WebSearch {"query":"agentrun"}';
/** The Claude transcript's lines on the log (each journal batch's `claude` stream), as a resume loads them. */
const claudeLines = (records) =>
  records.flatMap((record) => (record.kind === 'kernel.start' && record.data?.name === 'journal' ? (record.data.input?.streams?.claude?.entries ?? []).map((entry) => entry.data) : []));
/** The transcript lines that answer `callId`. */
const answers = (records, callId) =>
  claudeLines(records).filter((line) => line?.type === 'user' && Array.isArray(line.message?.content) && line.message.content.some((c) => c?.tool_use_id === callId));

/** A WebSearch-on session over `store` whose "model" searches the same query at every message. */
async function searchOn(t, store, { gate, signal, decided }) {
  const provider = await fakeAnthropic({ reply: () => ({ text: 'ok' }) });
  t.after(() => provider.close());
  const adapter = claudeAgentAdapter({
    model: 'claude-test',
    provider: { origin: provider.url, credential: () => 'provider-secret' },
    price: () => 0,
    standIn: { command: process.execPath },
    sdk: fakeSdk({ mirrorLagMs: 10, script: () => SEARCH, onDecision: (d) => decided.push(d) }),
    webSearch: true,
  });
  const io = { writer: await store.open('s1'), models: { beforeRequest: async () => ({ turn: 0 }), afterRequest: async () => {} }, signal, dir: mkdtempSync(join(ROOT, 'd-')), onEvent: () => {}, gate };
  return adapter.open({ key: 's1', label: 'root', system: [], tools: [], context: 'fresh' }, io);
}

/** Opens a session, has it search, and parks the search on the gate as the runner does under ask. */
async function parkedSearch(t, store) {
  const decided = [];
  const asked = [];
  const parking = new AbortController();
  const first = await searchOn(t, store, {
    decided,
    signal: parking.signal,
    gate: async (call) => {
      asked.push({ callId: call.callId, tool: call.tool });
      setImmediate(() => parking.abort(new Error('parked')));
      return { park: true };
    },
  });
  await first.send('go');
  await first.turnEnd().catch(() => undefined);
  await first.close();
  assert.deepEqual(asked.map((a) => a.tool), ['WebSearch'], 'the search was put to the gate');
  assert.deepEqual(decided.filter((d) => d.name === 'WebSearch' && d.decision === 'allow'), [], 'no search ran while the person had not answered');
  return asked[0].callId;
}

test('ask set mid-run holds the next WebSearch until the person answers; an allow lets that search run once, with no second card', { timeout: 60_000 }, async (t) => {
  const store = memorySessionStore();
  const held = await parkedSearch(t, store);
  const decided = [];
  const asked = [];
  const second = await searchOn(t, store, { decided, signal: new AbortController().signal, gate: async (call) => (asked.push(call.callId), 'allow') });
  try {
    await second.recover();
    await second.turnEnd();
  } finally {
    await second.close();
  }
  assert.equal(asked[0], held, 'the held search is put to the gate again under the id the model gave it');
  assert.equal(asked.length, 1, `one card for it: the search it released runs on that answer (${JSON.stringify(asked)})`);
  assert.deepEqual(decided.filter((d) => d.name === 'WebSearch').map((d) => d.decision), ['allow'], 'the search ran once, after the answer');
  const lines = answers(await store.read('s1'), held);
  assert.equal(lines.length, 1, 'one answer for the held call');
  assert.match(JSON.stringify(lines[0]), /Search again with the same query/);
});

test('ask set mid-run, then the person denies: the held WebSearch is answered in the gate words and no search runs', { timeout: 60_000 }, async (t) => {
  const store = memorySessionStore();
  const held = await parkedSearch(t, store);
  const decided = [];
  const asked = [];
  const second = await searchOn(t, store, { decided, signal: new AbortController().signal, gate: async (call) => (asked.push(call.callId), { deny: DENIED }) });
  try {
    await second.recover();
    await second.turnEnd();
  } finally {
    await second.close();
  }
  assert.equal(asked[0], held, 'the held search is put to the gate again under its id');
  assert.deepEqual(decided.filter((d) => d.name === 'WebSearch' && d.decision === 'allow'), [], 'no search ran');
  assert.match(JSON.stringify(answers(await store.read('s1'), held)), /Permission denied: web_search is set to deny/);
});
