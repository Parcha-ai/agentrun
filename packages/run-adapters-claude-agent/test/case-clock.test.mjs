// A run on a set clock (a template eval case's `now:`, which serve passes as the adapter's `now`) is told that clock's
// day by the pinned CLI too. The CLI dates its session from its own system clock, in its session context
// (`Today's date is <date>.`) and its `date` attachment: on a case clock that was not today, the model was told two days,
// the case's and the machine's, and went by the CLI's. A run with no `now` (every production run) is told the machine's.
//
// Without the pinned CLI this skips; with AGENTRUN_CLAUDE_AGENT_REQUIRE_BINARY=1 (CI) a missing one fails (tool-off.test).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createHarnessRunner } from '@parcha/agentrun-kernel';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { claudeAgentAdapter, verifyClaudeAgent } from '@parcha/agentrun-harness-claude';
import { fakeAnthropic } from '@parcha/agentrun-harness-claude/testing';

let problem;
try { verifyClaudeAgent({}); } catch (error) { problem = `${error.name}: ${error.message}`; }
const skip = problem && process.env.AGENTRUN_CLAUDE_AGENT_REQUIRE_BINARY !== '1' ? problem : false;
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-claude-clock-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
const MODEL = 'claude-sonnet-5-5';

/** One node on the pinned CLI, on `now` in `zone` when given: the model answers at once. Every date (YYYY-MM-DD) the
 *  session's model requests told it, in order of first sight. */
async function datesTold(t, { now, zone } = {}) {
  const dir = mkdtempSync(join(ROOT, 'node-'));
  const provider = await fakeAnthropic({ reply: () => ({ tool: { name: 'mcp__hands__submit', input: { value: { answer: 'ok' } } } }) });
  t.after(() => provider.close());
  const adapter = claudeAgentAdapter({ model: MODEL, provider: { origin: provider.url, credential: () => 'provider-secret' }, sessionsDir: join(dir, 'sessions'), ...(now ? { now: () => now } : {}), ...(zone ? { zone } : {}) });
  const runNode = createHarnessRunner(adapter, { store: memorySessionStore(), maxTurns: 5, timeoutMs: 100_000 });
  const output = await runNode({ kind: 'agent', label: 'clock', system: ['Answer.'], user: 'Answer ok.', schema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } }, tools: [] });
  assert.deepEqual(output, { answer: 'ok' }, 'the node answered');
  const main = provider.messages().filter((r) => r.model === MODEL);
  assert.ok(main.length > 0, 'the model was asked');
  const told = new Set();
  for (const r of main) for (const m of JSON.stringify(r.body).matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)) told.add(m[0]);
  return [...told];
}

test("on a set clock, the CLI tells the model the clock's day and no other", { skip, timeout: 120_000 }, async (t) => {
  const told = await datesTold(t, { now: new Date('2026-03-02T09:00:00Z') });
  assert.deepEqual(told, ['2026-03-02'], `the dates the model was told: ${JSON.stringify(told)}`);
});

test("on a set clock in a zone, the day is the zone's: 05:00Z on 3 March is still 2 March in Los Angeles", { skip, timeout: 120_000 }, async (t) => {
  const told = await datesTold(t, { now: new Date('2026-03-03T05:00:00Z'), zone: 'America/Los_Angeles' });
  assert.deepEqual(told, ['2026-03-02'], `the dates the model was told: ${JSON.stringify(told)}`);
});

test("with no clock set, the CLI tells the model the machine's day", { skip, timeout: 120_000 }, async (t) => {
  const before = new Date().toISOString().slice(0, 10);
  const told = await datesTold(t);
  const later = new Date().toISOString().slice(0, 10);
  assert.ok(told.length > 0 && told.every((d) => d === before || d === later), `the dates the model was told: ${JSON.stringify(told)}, the machine's ${before}`);
});

// The rewrite itself, at the policy (no CLI): which text it changes, and which it leaves.
const { anthropicPolicy } = await import('@parcha/agentrun-harness-claude');
const { applyAnthropic, isoDay } = await import('../dist/host/policy.js');
const MESSAGES = anthropicPolicy({ model: MODEL, tools: [] }).routes.find((r) => r.path === '/v1/messages');
const CLOCKED = { model: MODEL, tools: ['lookup'], day: () => '2026-03-02' };
const LINE = "Today's date is 2026-01-15.";
const LATER = "The date has changed. Today's date is now 2026-01-16. No need to announce the new date.";
const turn = (content) => ({ model: MODEL, max_tokens: 1000, messages: [{ role: 'user', content }] });

test("isoDay reads the day in the zone", () => {
  assert.equal(isoDay(new Date('2026-03-03T05:00:00Z'), 'America/Los_Angeles'), '2026-03-02');
  assert.equal(isoDay(new Date('2026-03-03T05:00:00Z')), '2026-03-03', 'UTC by default');
});

test("on a set clock, both of the CLI's date lines say its day, in a string, a text block and the system prompt", () => {
  const body = { ...turn([{ type: 'text', text: `<total_tokens>left</total_tokens>\n\n${LINE}` }, { type: 'text', text: LATER }]), system: [{ type: 'text', text: `You are Claude Code. ${LINE}` }] };
  const sent = applyAnthropic(body, MESSAGES, CLOCKED);
  assert.deepEqual(sent.messages[0].content.map((b) => b.text), ["<total_tokens>left</total_tokens>\n\nToday's date is 2026-03-02.", "The date has changed. Today's date is now 2026-03-02. No need to announce the new date."]);
  assert.equal(sent.system[0].text, "You are Claude Code. Today's date is 2026-03-02.");
  assert.equal(applyAnthropic(turn(`hi\n\n${LINE}`), MESSAGES, CLOCKED).messages[0].content, "hi\n\nToday's date is 2026-03-02.", 'a string content too');
});

test("a tool's result keeps its text: a file or page that says a date reaches the model as it was", () => {
  const result = { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: `notes.md: ${LINE}` }] };
  const body = { model: MODEL, max_tokens: 1000, messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'mcp__hands__lookup', input: {} }] }, { role: 'user', content: [result, { type: 'text', text: LINE }] }] };
  const sent = applyAnthropic(body, MESSAGES, CLOCKED);
  assert.deepEqual(sent.messages[2].content[0], result, 'the tool result is as it was');
  assert.equal(sent.messages[2].content[1].text, "Today's date is 2026-03-02.", "the CLI's own line beside it says the clock's day");
});

test("with no clock, and on the host's own side request, the lines pass as the CLI wrote them", () => {
  const body = { ...turn(LINE), system: LINE };
  assert.deepEqual(applyAnthropic(body, MESSAGES, { model: MODEL, tools: [] }).messages[0].content, LINE, 'no clock');
  const side = applyAnthropic(body, MESSAGES, CLOCKED, { host: 'node:learned' });
  assert.equal(side.messages[0].content, LINE, "the host's side request");
  assert.equal(side.system, LINE);
});
