// The host's skills through the adapter, on the pinned CLI and SDK, with a scripted provider on loopback. A node whose
// adapter has skills offers the Skill tool, lists exactly those skills to the model (as `agentrun:<name>`), and loads one
// when the model asks: its SKILL.md reaches the model. A skill that is not the host's (one of the CLI's bundled skills) is
// refused, and an adapter with no skills offers no Skill tool. The skills are checked when the adapter is made.
//
// Without the pinned CLI the CLI tests skip; with AGENTRUN_CLAUDE_AGENT_REQUIRE_BINARY=1 (CI) a missing one fails (tool-off.test).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createHarnessRunner } from '@parcha/agentrun-adapters';
import { memorySessionStore } from '@parcha/agentrun-adapters/testing';
import { claudeAgentAdapter, skillProblems, verifyClaudeAgent } from '@parcha/agentrun-claude-agent';
import { fakeAnthropic } from '@parcha/agentrun-claude-agent/testing';

let problem;
try { verifyClaudeAgent({}); } catch (error) { problem = `${error.name}: ${error.message}`; }
const skip = problem && process.env.AGENTRUN_CLAUDE_AGENT_REQUIRE_BINARY !== '1' ? problem : false;
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-claude-skills-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
const MODEL = 'claude-sonnet-5-5';
const SMALL = 'claude-haiku-4-5';
const CANARY = 'CANARY-RESEARCH-METHOD';
const SKILL = { name: 'research-method', files: { 'SKILL.md': `---\nname: research-method\ndescription: How this host researches.\n---\n${CANARY}: cite every source you fetched.\n`, 'reference/sources.md': 'Primary sources first.\n' } };

/** Every tool_result in a request's messages, with whether it is an error. */
function toolResults(body) {
  const out = [];
  for (const m of body?.messages ?? []) for (const b of Array.isArray(m.content) ? m.content : []) if (b?.type === 'tool_result') out.push({ text: JSON.stringify(b.content), error: b.is_error === true });
  return out;
}

/** One node on the pinned CLI whose model, if `call` is set, asks for that skill once, then submits. */
async function node(t, { skills, call }) {
  const dir = mkdtempSync(join(ROOT, 'node-'));
  let step = 0;
  const provider = await fakeAnthropic({ reply: (r) => {
    if (r.model !== MODEL) return { text: 'ok' };
    step += 1;
    if (step === 1 && call) return { tool: { name: 'Skill', input: { skill: call } } };
    return { tool: { name: 'mcp__hands__submit', input: { value: { answer: 'ok' } } } };
  } });
  t.after(() => provider.close());
  const adapter = claudeAgentAdapter({ model: MODEL, smallModel: SMALL, provider: { origin: provider.url, credential: () => 'provider-secret' }, sessionsDir: join(dir, 'sessions'), ...(skills ? { skills } : {}) });
  const runNode = createHarnessRunner(adapter, { store: memorySessionStore(), maxTurns: 10, timeoutMs: 100_000 });
  const output = await runNode({ kind: 'agent', label: 'skills', system: ['Answer.'], user: 'Use the skill, then answer ok.', schema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } }, tools: [] });
  const main = provider.messages().filter((r) => r.model === MODEL);
  return { output, main, offered: main.map((r) => (r.body?.tools ?? []).map((x) => x.name)), last: main.at(-1)?.body };
}

test("a host's skill: the Skill tool is offered, the model is shown that skill alone, and loading it puts its SKILL.md before the model", { skip, timeout: 120_000 }, async (t) => {
  const { output, offered, last } = await node(t, { skills: [SKILL], call: 'agentrun:research-method' });
  assert.deepEqual(output, { answer: 'ok' });
  assert.ok(offered.every((tools) => tools.includes('Skill')), `the Skill tool is offered: ${JSON.stringify(offered)}`);
  const text = JSON.stringify(last);
  assert.ok(text.includes('agentrun:research-method'), 'the model is shown the skill');
  for (const bundled of ['simplify', 'dataviz', 'deep-research', 'code-review']) assert.ok(!new RegExp(`- ${bundled}:`).test(text), `the CLI's bundled ${bundled} is not listed`);
  assert.ok(text.includes(CANARY), "the skill's SKILL.md reached the model");
  assert.deepEqual(toolResults(last).filter((r) => r.error), [], 'loading it was no error');
});

test("a skill that is not the host's (one the CLI bundles) is refused, and none of it reaches the model", { skip, timeout: 120_000 }, async (t) => {
  const { output, last } = await node(t, { skills: [SKILL], call: 'simplify' });
  assert.deepEqual(output, { answer: 'ok' });
  const results = toolResults(last);
  const refused = results.filter((r) => r.error);
  assert.ok(refused.length === 1 && /not one of this session's skills|not in this session's skills allowlist/.test(refused[0].text), JSON.stringify(results));
  assert.ok(!JSON.stringify(last).includes(CANARY), 'nothing was loaded');
});

test('an adapter with no skills offers no Skill tool', { skip, timeout: 120_000 }, async (t) => {
  const { output, offered } = await node(t, {});
  assert.deepEqual(output, { answer: 'ok' });
  assert.ok(offered.length >= 1 && offered.every((tools) => !tools.includes('Skill')), JSON.stringify(offered));
});

test('the skills are checked when the adapter is made: a plain name, a SKILL.md that names it with a description, plain relative paths, 1 MiB in all', () => {
  const md = (name, extra = 'description: d') => `---\nname: ${name}\n${extra}\n---\nbody\n`;
  assert.deepEqual(skillProblems([SKILL]), []);
  const wrong = (skill) => skillProblems([skill]).join('; ');
  assert.match(wrong({ name: 'Bad Name', files: { 'SKILL.md': md('Bad Name') } }), /not lowercase letters, digits and dashes/);
  assert.match(wrong({ name: 'a', files: {} }), /no SKILL.md with front matter/);
  assert.match(wrong({ name: 'a', files: { 'SKILL.md': md('b') } }), /names it otherwise/);
  assert.match(wrong({ name: 'a', files: { 'SKILL.md': md('a', 'other: x') } }), /no description/);
  for (const path of ['../escape.md', '/abs.md', 'a/../../b.md', 'a//b.md', '.hidden', 'a/./b']) assert.match(wrong({ name: 'a', files: { 'SKILL.md': md('a'), [path]: 'x' } }), /not a plain relative path/, path);
  assert.match(skillProblems([{ name: 'a', files: { 'SKILL.md': md('a') } }, { name: 'a', files: { 'SKILL.md': md('a') } }]).join(';'), /given twice/);
  assert.match(wrong({ name: 'a', files: { 'SKILL.md': md('a'), 'big.md': 'x'.repeat(1024 * 1024) } }), /more than 1048576/);
  assert.throws(() => claudeAgentAdapter({ model: 'm', provider: { origin: 'https://x.invalid', credential: () => 'k' }, skills: [{ name: 'a', files: {} }], sdk: {}, standIn: { command: process.execPath } }), /agentrun-claude-agent: the skill a has no SKILL.md/);
});

test('a loaded skill survives a crash: the next process, in a NEW session directory, recovers from the store and turn 3 still has the skill in its history, nothing re-sent', { skip, timeout: 240_000 }, async (t) => {
  let main = 0;
  // Turn 1 loads the skill, turn 2 asks for a never tool (which the kill cuts off), turn 3 answers.
  const provider = await fakeAnthropic({ reply: (r) => {
    if (r.model !== MODEL) return { text: 'ok' };
    main += 1;
    if (main === 1) return { tool: { name: 'Skill', input: { skill: 'agentrun:research-method' } } };
    if (main === 2) return { tool: { name: 'mcp__hands__charge', input: { amount: 5 } } };
    return { text: 'done' };
  } });
  t.after(() => provider.close());
  let inside;
  const reached = new Promise((resolve) => { inside = resolve; });
  let charged = 0;
  const charge = { name: 'charge', description: 'Charge the card.', inputSchema: { type: 'object', properties: { amount: { type: 'number' } } }, replay: 'never', call: (_args, { signal }) => { charged += 1; inside(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cut')), { once: true })); } };
  const spec = { key: 'step:skill-resume', label: 'pay', system: ['Use the skill, then the tool.'], tools: [charge], context: 'fresh' };
  const { memorySessionStore: stores } = await import('@parcha/agentrun-adapters/testing');
  const store = stores();
  const models = { beforeRequest: async () => {}, afterRequest: async () => {} };
  const adapterIn = (dir) => claudeAgentAdapter({ model: MODEL, smallModel: SMALL, provider: { origin: provider.url, credential: () => 'provider-secret' }, sessionsDir: dir, skills: [SKILL] });

  const died = new AbortController();
  const a = await adapterIn(mkdtempSync(join(ROOT, 'skill-a-'))).open(spec, { store, writer: await store.open(spec.key), models, signal: died.signal, onEvent: () => {} });
  await a.send('Charge the card, following the research method.');
  await reached;
  died.abort(new Error('the process died'));
  assert.equal((await a.turnEnd()).status, 'interrupted');
  await a.close();
  assert.equal(provider.messages().filter((r) => r.model === MODEL).length, 2);

  const b = await adapterIn(mkdtempSync(join(ROOT, 'skill-b-'))).open(spec, { store, writer: await store.open(spec.key), models, signal: new AbortController().signal, onEvent: () => {} });
  assert.equal(b.state, 'open_turn');
  await b.recover();
  assert.equal((await b.turnEnd()).status, 'completed');
  await b.close();
  const sent = provider.messages().filter((r) => r.model === MODEL);
  assert.equal(sent.length, 3, `three main-model requests, none re-sent (got ${sent.length})`);
  assert.equal(charged, 1);
  assert.ok(JSON.stringify(sent[2].body.messages).includes(CANARY), "turn 3's history still holds the skill it loaded");
});
