// The pinned Claude Agent CLI, through the adapter and the real Agent SDK, with the spend cap's wrap-up note due before a
// turn: the CLI ends each turn's first request with a system message of its own ([..., user, system]), and the provider
// takes a system message only before an assistant message or at the end. So the note goes as the last block of the last
// user message and the system message stays last; a user message of its own after it is refused (400) and fails the
// turn. Both the first turn and a follow-up turn start so. With no small model set, every main-model request the CLI
// makes is a turn's own. No network: the provider is a scripted Anthropic API on the loopback interface, which refuses
// what the real API refuses here.
//
// Without the pinned CLI this skips; with AGENTRUN_CLAUDE_AGENT_REQUIRE_BINARY=1 (CI) a missing or different one fails.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { claudeAgentAdapter, verifyClaudeAgent } from '@parcha/agentrun-harness-claude';
import { fakeAnthropic } from '@parcha/agentrun-harness-claude/testing';

const required = process.env.AGENTRUN_CLAUDE_AGENT_REQUIRE_BINARY === '1';
let problem;
try { verifyClaudeAgent({}); } catch (error) { problem = `${error.name}: ${error.message}`; }
const skip = problem && !required ? problem : false;
const MODEL = 'claude-sonnet-5-5';
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-claude-turns-'));
const NOTE = 'About $0.07 left of this run\'s budget: finish now with your answer.';
/** Each message's role and its content's block types: what a failure shows. */
const shapeOf = (body) => (body?.messages ?? []).map((m) => `${m.role}:${typeof m.content === 'string' ? 'str' : (m.content ?? []).map((b) => b.type).join('+')}`);

for (const withTools of [false, true]) {
  for (const dueOn of [1, 2]) {
    test(`the real CLI, ${withTools ? 'a session with a tool' : 'a session with no tools'}, the note due on turn ${dueOn}'s first request: it goes as the last block of the last user message, the CLI's system message stays last, and the turn completes`, { skip, timeout: 180_000 }, async (t) => {
      const provider = await fakeAnthropic({ reply: () => ({ text: 'done' }) });
      t.after(() => provider.close());
      const lookup = { name: 'lookup', description: 'Look a thing up.', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, replay: 'safe', call: async () => ({ text: 'found' }) };
      const spec = { key: `step:turns-${withTools}-${dueOn}`, label: 'turns', system: ['Answer briefly.'], tools: withTools ? [lookup] : [], context: 'fresh' };
      const store = memorySessionStore();
      // The host has the note for the dueOn-th main-model request it is asked about, once.
      let takes = 0;
      const models = { beforeRequest: async () => {}, afterRequest: async () => {}, note: () => ((takes += 1) === dueOn ? NOTE : undefined) };
      const adapter = claudeAgentAdapter({ model: MODEL, provider: { origin: provider.url, credential: () => 'provider-secret' }, sessionsDir: mkdtempSync(join(ROOT, 's-')) });
      const session = await adapter.open(spec, { store, writer: await store.open(spec.key), models, signal: new AbortController().signal, onEvent: () => {} });
      for (const text of ['Fix the login bug in auth.ts.', 'And the logout one.']) {
        await session.send(text);
        const end = await session.turnEnd();
        assert.equal(end.status, 'completed', `${JSON.stringify(end).slice(0, 300)}; sent: ${JSON.stringify(provider.messages().map((request) => ({ status: request.status, shape: shapeOf(request.body) })))}`);
      }
      // Time for a background call the CLI would make after a turn (a title) to reach the provider.
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      await session.close();
      const main = provider.messages().filter((request) => request.model === MODEL).map((request) => request.body ?? {});
      t.diagnostic(`main-model requests: ${JSON.stringify(main.map(shapeOf))}`);
      assert.equal(main.length, 2, 'one main-model request per turn, and no other: no title or summary call on the session model');
      assert.deepEqual(main.map((body) => body.messages?.at(-1)?.role), ['system', 'system'], 'each turn\'s first request ends with the CLI\'s system message, the first turn\'s and the follow-up\'s');
      const carries = (body) => JSON.stringify(body.messages?.findLast((message) => message.role === 'user')?.content?.at?.(-1) ?? '').includes(NOTE);
      assert.deepEqual(main.map(carries), [dueOn === 1, dueOn === 2], `the note is the last block of turn ${dueOn}'s last user message, once`);
    });
  }
}
