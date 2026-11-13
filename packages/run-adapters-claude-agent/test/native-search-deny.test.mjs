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
