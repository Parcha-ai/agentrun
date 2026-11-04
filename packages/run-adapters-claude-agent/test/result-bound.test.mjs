// A host tool's result past the host's bound (HOST_RESULT_MAX_CHARS), on the Claude Agent adapter: the kernel's tool
// bridge, which every host tool's result passes on its way to the CLI, cuts it there and says so. A skill file of the
// most a skill holds (1 MiB) and a delegate's 6 MB answer each reach the CLI within the bound, ending with the line that
// says where it was cut, and the host hears the call's end flagged truncated. The CLI's tool server answers a call with
// the bridge's text as it is (harness.ts), and the tool_end the host hears carries that text, so the tests read it there.
// The stand-in SDK and CLI only: no network, no binary.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import * as kernel from '@parcha/agentrun-kernel';
import { fauxAdapter, memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { claudeAgentAdapter } from '@parcha/agentrun-harness-claude';
import { fakeAnthropic, fakeSdk } from '@parcha/agentrun-harness-claude/testing';

const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-claude-bound-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
const BOUND = 120_000;
const SKILL_MD = '---\nname: research\ndescription: Read big.md.\n---\nRead big.md.\n';
/** The skill at the most a skill holds: SKILL.md and big.md, 1 MiB in all. */
const BIG = 'x'.repeat(1024 * 1024 - Buffer.byteLength(SKILL_MD));
const SCHEMA = { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } };

/** The end the host heard of `name`'s one call: the text the CLI got, and whether it was cut. */
async function reached({ tools = [], skills, call }) {
  process.env.AGENTRUN_CLAUDE_AGENT_STANDIN = '1';
  const provider = await fakeAnthropic({ reply: () => ({ text: 'ok' }) });
  try {
    const dir = mkdtempSync(join(ROOT, 'n-'));
    const adapter = claudeAgentAdapter({ model: 'claude-test', provider: { origin: provider.url, credential: () => 'k' }, sessionsDir: join(dir, 's'), standIn: { command: process.execPath }, ...(skills ? { skills } : {}), sdk: fakeSdk({ script: [call, 'call submit {"value":{"answer":"ok"}}'] }) });
    const events = [];
    const store = memorySessionStore();
    const runNode = kernel.createHarnessRunner(adapter, { store, tools, onEvent: (e) => events.push(e) });
    assert.deepEqual(await runNode({ kind: 'agent', label: 'bound', system: [], user: 'Go.', schema: SCHEMA, tools: tools.map((t) => t.name) }), { answer: 'ok' });
    const name = /^call (\S+)/.exec(call)[1];
    const ended = events.filter((e) => e.type === 'tool_end' && e.name === name);
    assert.equal(ended.length, 1, `one end of ${name}`);
    assert.equal(ended[0].isError, false, ended[0].result?.slice(0, 300));
    return ended[0];
  } finally {
    delete process.env.AGENTRUN_CLAUDE_AGENT_STANDIN;
    await provider.close();
  }
}

/** The text a result past the bound reaches the model as: its start, then the line that says where it was cut. */
function cut(text, whole) {
  assert.ok(text.length <= BOUND, `${text.length} characters, past ${BOUND}`);
  const note = /\n\[cut at (\d+) of (\d+) characters\]$/.exec(text);
  assert.ok(note, `ends with the line that says where it was cut: ${JSON.stringify(text.slice(-80))}`);
  assert.deepEqual([Number(note[2]), text.slice(0, note.index)], [whole.length, whole.slice(0, Number(note[1]))]);
}

test("a skill file of the most a skill holds (1 MiB) reaches the CLI cut at the host's bound, saying so, and its end is flagged truncated", async () => {
  const ended = await reached({ skills: [{ name: 'research', files: { 'SKILL.md': SKILL_MD, 'big.md': BIG } }], call: 'call read_skill_file {"skill":"research","path":"big.md"}' });
  cut(ended.result, BIG);
  assert.equal(ended.truncated, true);
  assert.equal(kernel.HOST_RESULT_MAX_CHARS, BOUND, 'the kernel states the bound');
});

test("a delegate's 6 MB answer reaches the CLI cut at the host's bound, saying so, and its end is flagged truncated", async () => {
  // The delegate's fixed shape: the answer, its citations and its gaps.
  const answer = { answer: 'y'.repeat(6_000_000), citations: [], gaps: [] };
  const store = memorySessionStore();
  const delegate = kernel.delegateTool({ agents: { big: { description: 'Answers at length.', system: 'Answer.', tools: [] } }, tools: [], adapter: fauxAdapter({ script: () => [{ submit: answer }] }), store, parentKey: 'lead' });
  const ended = await reached({ tools: [delegate], call: 'call delegate {"agent":"big","task":"Find it all."}' });
  cut(ended.result, JSON.stringify(answer));
  assert.equal(ended.truncated, true);
});
