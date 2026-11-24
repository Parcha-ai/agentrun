// A run on a set clock (a template eval case's `now:`, which serve passes as the adapter's `now`) is told that clock's
// day by the pinned CLI too. The CLI dates its session from its own system clock, in the environment note it sends as a
// `system` message (`Today's date is <date>.` at its end): on a case clock that was not today, the model was told two
// days, the case's and the machine's, and went by the CLI's. Only the CLI's own line changes: a date the person or the
// app wrote reaches the model as written. A run with no `now` (every production run) is told the machine's day.
//
// Without the pinned CLI this skips; with AGENTRUN_CLAUDE_AGENT_REQUIRE_BINARY=1 (CI) a missing one fails (tool-off.test).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createHarnessRunner } from '@parcha/agentrun-kernel';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { anthropicPolicy, claudeAgentAdapter, verifyClaudeAgent } from '@parcha/agentrun-harness-claude';
import { fakeAnthropic } from '@parcha/agentrun-harness-claude/testing';
import { applyAnthropic, isoDay } from '../dist/host/policy.js';

let problem;
try { verifyClaudeAgent({}); } catch (error) { problem = `${error.name}: ${error.message}`; }
const skip = problem && process.env.AGENTRUN_CLAUDE_AGENT_REQUIRE_BINARY !== '1' ? problem : false;
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-claude-clock-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
const MODEL = 'claude-sonnet-5-5';
/** Dates the app's instructions and the person's prompt quote: they reach the model as written, on any clock. */
const APP = "Answer. The app's launch note says: Today's date is 2020-01-01.";
const PROMPT = "Repeat exactly: Today's date is 2020-02-02.";
const DAYS = /\b\d{4}-\d{2}-\d{2}\b/g;

/** One node on the pinned CLI, on `now` in `zone` when given: the model answers at once. The dates its model's requests
 *  carried: in the CLI's own `system` messages, and anywhere in the body. */
async function datesTold(t, { now, zone } = {}) {
  const dir = mkdtempSync(join(ROOT, 'node-'));
  const provider = await fakeAnthropic({ reply: () => ({ tool: { name: 'mcp__hands__submit', input: { value: { answer: 'ok' } } } }) });
  t.after(() => provider.close());
  const adapter = claudeAgentAdapter({ model: MODEL, provider: { origin: provider.url, credential: () => 'provider-secret' }, sessionsDir: join(dir, 'sessions'), ...(now ? { now: () => now } : {}), ...(zone ? { zone } : {}) });
  const runNode = createHarnessRunner(adapter, { store: memorySessionStore(), maxTurns: 5, timeoutMs: 100_000 });
  const output = await runNode({ kind: 'agent', label: 'clock', system: [APP], user: PROMPT, schema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } }, tools: [] });
  assert.deepEqual(output, { answer: 'ok' }, 'the node answered');
  const main = provider.messages().filter((r) => r.model === MODEL);
  assert.ok(main.length > 0, 'the model was asked');
  const cli = new Set();
  const all = new Set();
  for (const r of main) {
    for (const m of r.body.messages.filter((x) => x.role === 'system')) for (const d of JSON.stringify(m.content).matchAll(DAYS)) cli.add(d[0]);
    for (const d of JSON.stringify(r.body).matchAll(DAYS)) all.add(d[0]);
  }
  const sent = JSON.stringify(main.map((r) => r.body));
  return { cli: [...cli], all: [...all].sort(), quoted: sent.includes(APP) && sent.includes(PROMPT) };
}

test("on a set clock, the CLI tells the model the clock's day and no other; the app's and the person's quoted dates stay", { skip, timeout: 120_000 }, async (t) => {
  const told = await datesTold(t, { now: new Date('2026-03-02T09:00:00Z') });
  assert.deepEqual(told.cli, ['2026-03-02'], `the dates in the CLI's own system messages: ${JSON.stringify(told.cli)}`);
  assert.deepEqual(told.all, ['2020-01-01', '2020-02-02', '2026-03-02'], `every date the requests carried: ${JSON.stringify(told.all)}`);
  assert.ok(told.quoted, "the app's instructions and the person's prompt reached the model as written");
});

test("on a set clock in a zone, the day is the zone's: 05:00Z on 3 March is still 2 March in Los Angeles", { skip, timeout: 120_000 }, async (t) => {
  const told = await datesTold(t, { now: new Date('2026-03-03T05:00:00Z'), zone: 'America/Los_Angeles' });
  assert.deepEqual(told.cli, ['2026-03-02'], `the dates in the CLI's own system messages: ${JSON.stringify(told.cli)}`);
});

/** `at`'s calendar day in this process's local time (the CLI reads its own local day). */
const localDay = (at) => `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;

test("with no clock set, the CLI tells the model the machine's day", { skip, timeout: 120_000 }, async (t) => {
  const before = new Date();
  const told = await datesTold(t);
  const later = new Date();
  // The machine's day, in UTC or in local time (the CLI's zone is its own), read before and after the run.
  const machine = new Set([before, later].flatMap((at) => [isoDay(at), localDay(at)]));
  assert.ok(told.cli.length > 0 && told.cli.every((d) => machine.has(d)), `the dates in the CLI's own system messages: ${JSON.stringify(told.cli)}, the machine's ${JSON.stringify([...machine])}`);
  assert.ok(told.quoted, "the app's instructions and the person's prompt reached the model as written");
});

// The rewrite itself, at the policy (no CLI): which text it changes, and which it leaves.
const MESSAGES = anthropicPolicy({ model: MODEL, tools: [] }).routes.find((r) => r.path === '/v1/messages');
const CLOCKED = { model: MODEL, tools: ['lookup'], day: () => '2026-03-02' };
const LINE = "Today's date is 2026-01-15.";
const LATER = "The date has changed. Today's date is now 2026-01-16. No need to announce the new date.";
const NOTE = `# Environment\n<total_tokens>left</total_tokens>\n\n${LINE}`;
const body = (messages, system) => ({ model: MODEL, max_tokens: 1000, messages, ...(system ? { system } : {}) });

test("isoDay reads the day in the zone", () => {
  assert.equal(isoDay(new Date('2026-03-03T05:00:00Z'), 'America/Los_Angeles'), '2026-03-02');
  assert.equal(isoDay(new Date('2026-03-03T05:00:00Z')), '2026-03-03', 'UTC by default');
});

test("on a set clock, both of the CLI's date lines in its system message say the clock's day, as a string or as text blocks", () => {
  const blocks = applyAnthropic(body([{ role: 'user', content: 'go' }, { role: 'system', content: [{ type: 'text', text: NOTE }, { type: 'text', text: LATER }] }]), MESSAGES, CLOCKED);
  assert.deepEqual(blocks.messages[1].content.map((b) => b.text), ["# Environment\n<total_tokens>left</total_tokens>\n\nToday's date is 2026-03-02.", "The date has changed. Today's date is now 2026-03-02. No need to announce the new date."]);
  const string = applyAnthropic(body([{ role: 'user', content: 'go' }, { role: 'system', content: NOTE }]), MESSAGES, CLOCKED);
  assert.equal(string.messages[1].content, "# Environment\n<total_tokens>left</total_tokens>\n\nToday's date is 2026-03-02.");
});

test("every text that is not the CLI's own keeps its date: the person's words, a tool's result, the model's reply, the app's instructions", () => {
  const result = { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: `notes.md: ${LINE}` }] };
  const messages = [
    { role: 'user', content: `Repeat exactly: ${LINE}` },
    { role: 'system', content: NOTE },
    { role: 'assistant', content: [{ type: 'text', text: LINE }, { type: 'tool_use', id: 'toolu_1', name: 'mcp__hands__lookup', input: {} }] },
    { role: 'user', content: [result, { type: 'text', text: `Quote: ${LINE}` }] },
  ];
  const system = [{ type: 'text', text: `The app says: ${LINE}` }];
  const sent = applyAnthropic(body(structuredClone(messages), structuredClone(system)), MESSAGES, CLOCKED);
  assert.deepEqual(sent.messages[0], messages[0], "the person's prompt is as it was");
  assert.deepEqual(sent.messages[2], messages[2], "the model's reply is as it was");
  assert.deepEqual(sent.messages[3], messages[3], "the tool's result and the text beside it are as they were");
  assert.deepEqual(sent.system, system, "the app's instructions are as they were");
  assert.equal(sent.messages[1].content, "# Environment\n<total_tokens>left</total_tokens>\n\nToday's date is 2026-03-02.", "the CLI's own line says the clock's day");
});

test("with no clock, and on the host's own side request, the CLI's line passes as it wrote it", () => {
  const sent = () => body([{ role: 'user', content: 'go' }, { role: 'system', content: NOTE }]);
  assert.equal(applyAnthropic(sent(), MESSAGES, { model: MODEL, tools: [] }).messages[1].content, NOTE, 'no clock');
  assert.equal(applyAnthropic(sent(), MESSAGES, CLOCKED, { host: 'node:learned' }).messages[1].content, NOTE, "the host's side request");
});
