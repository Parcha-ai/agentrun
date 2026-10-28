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
import { CLAUDE_AGENT_CLI_SKILL_NAMES, CLAUDE_AGENT_SDK_VERSION, claudeAgentAdapter, skillProblems, verifyClaudeAgent } from '@parcha/agentrun-claude-agent';
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

test("a prompt's bare Skill(\"research-method\") loads the host's skill: the call is rewritten to agentrun:research-method and its SKILL.md reaches the model", { skip, timeout: 120_000 }, async (t) => {
  const { output, last } = await node(t, { skills: [SKILL], call: 'research-method' });
  assert.deepEqual(output, { answer: 'ok' });
  const results = toolResults(last);
  assert.ok(results.some((r) => !r.error && r.text.includes('Launching skill: agentrun:research-method')), JSON.stringify(results));
  assert.ok(JSON.stringify(last).includes(CANARY), "the skill's SKILL.md reached the model");
});

test("a name that is no skill of the session's is refused, and none of it reaches the model", { skip, timeout: 120_000 }, async (t) => {
  const { output, last } = await node(t, { skills: [SKILL], call: 'research-methods' });
  assert.deepEqual(output, { answer: 'ok' });
  const refused = toolResults(last).filter((r) => r.error);
  assert.ok(refused.length === 1 && /Unknown skill|not one of this session's skills/.test(refused[0].text), JSON.stringify(refused));
  assert.ok(!JSON.stringify(last).includes(CANARY), 'nothing was loaded');
});

// The CLI answers Skill("<name>") itself for its own commands and bundled skills, before any hook sees the call, so a host
// skill by one of those names never loads by its bare name. The names, as measured on the pinned CLI: some (help, status,
// memory, ...) are answered by the CLI but not reported at its start, so the list is pinned here, each name called.
const CLI_NAMES_MEASURED = [
  '__remote-workflow', 'add-dir', 'agents', 'auto-mode-setup', 'autocompact', 'batch', 'btw', 'bug', 'claude-api',
  'clear', 'code-review', 'color', 'compact', 'config', 'context', 'copy', 'cost', 'dataviz', 'debug', 'doctor',
  'effort', 'exit', 'export', 'fast', 'feedback', 'fewer-permission-prompts', 'focus', 'goal', 'heapdump', 'help',
  'hooks', 'ide', 'init', 'insights', 'keybindings-help', 'list-agents', 'login', 'logout', 'mcp', 'memory', 'model',
  'output-style', 'permissions', 'plugin', 'plugin-authoring', 'plugin-types', 'plugins', 'quit', 'recap',
  'release-notes', 'reload-plugins', 'reload-skills', 'rename', 'resume', 'review', 'rewind', 'run',
  'run-skill-generator', 'sandbox', 'security-review', 'simplify', 'skills', 'stats', 'status', 'statusline',
  'tasks', 'team-onboarding', 'terminal-setup', 'theme', 'update-config', 'usage', 'verify', 'workflow-launch-exec',
];

test('CLAUDE_AGENT_CLI_SKILL_NAMES is the measured list, name for name', () => {
  assert.deepEqual([...CLAUDE_AGENT_CLI_SKILL_NAMES].sort(), [...CLI_NAMES_MEASURED].sort());
});

test("the CLI's own skill names, pinned: each is the CLI's, and every command and skill it reports at its start is listed", { skip, timeout: 240_000 }, async (t) => {
  const names = [...CLI_NAMES_MEASURED];
  let step = 0;
  const provider = await fakeAnthropic({ reply: (r) => {
    if (r.model !== MODEL) return { text: 'ok' };
    const name = names[step++];
    return name ? { tool: { name: 'Skill', input: { skill: name } } } : { tool: { name: 'mcp__hands__submit', input: { value: { answer: 'ok' } } } };
  } });
  t.after(() => provider.close());
  const real = await import('@anthropic-ai/claude-agent-sdk');
  let init;
  const sdk = { ...real, query: (args) => {
    const q = real.query(args);
    const iterate = q[Symbol.asyncIterator].bind(q);
    return Object.assign(Object.create(q), { [Symbol.asyncIterator]: () => {
      const it = iterate();
      return { next: async () => { const r = await it.next(); if (r.value?.type === 'system' && r.value?.subtype === 'init') init ??= r.value; return r; }, return: (v) => it.return?.(v) ?? { done: true, value: v } };
    } });
  } };
  const adapter = claudeAgentAdapter({ sdk, sdkVersion: CLAUDE_AGENT_SDK_VERSION, model: MODEL, smallModel: SMALL, provider: { origin: provider.url, credential: () => 'provider-secret' }, sessionsDir: join(mkdtempSync(join(ROOT, 'owned-')), 'sessions'), skills: [SKILL] });
  const runNode = createHarnessRunner(adapter, { store: memorySessionStore(), maxTurns: names.length + 10, timeoutMs: 220_000 });
  assert.deepEqual(await runNode({ kind: 'agent', label: 'owned', system: ['Answer.'], user: 'Go.', schema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } }, tools: [] }), { answer: 'ok' });
  const last = provider.messages().filter((r) => r.model === MODEL).at(-1)?.body;
  const asked = new Map();
  const unknown = [];
  for (const m of last?.messages ?? []) for (const b of Array.isArray(m.content) ? m.content : []) {
    if (b?.type === 'tool_use' && b.name === 'Skill') asked.set(b.id, b.input.skill);
    if (b?.type === 'tool_result' && asked.has(b.tool_use_id) && /Unknown skill/.test(JSON.stringify(b.content))) unknown.push(asked.get(b.tool_use_id));
  }
  assert.equal(asked.size, names.length, 'every listed name was asked');
  assert.deepEqual(unknown, [], 'every listed name is one the CLI has');
  const reported = [...(init?.slash_commands ?? []), ...(init?.terminal_slash_commands ?? []), ...(init?.skills ?? [])].filter((n) => !n.startsWith('agentrun:'));
  assert.ok(reported.length > 0, 'the CLI reported its commands');
  assert.deepEqual(reported.filter((n) => !CLAUDE_AGENT_CLI_SKILL_NAMES.has(n)), [], 'each command and skill the CLI reports is listed');
});

test('a user\'s skill named like one of the CLI\'s own ("review"): the run starts, Skill("agentrun:review") loads it, and the bare Skill("review") never reaches it', { skip, timeout: 240_000 }, async (t) => {
  const REVIEW = 'CANARY-USER-REVIEW';
  const review = { name: 'review', files: { 'SKILL.md': `---\nname: review\ndescription: How this team reviews.\n---\n${REVIEW}: read the diff twice.\n` } };
  const qualified = await node(t, { skills: [SKILL, review], call: 'agentrun:review' });
  assert.deepEqual(qualified.output, { answer: 'ok' });
  assert.ok(JSON.stringify(qualified.last).includes(REVIEW), 'the qualified name loads the user\'s skill');
  const bare = await node(t, { skills: [SKILL, review], call: 'review' });
  assert.deepEqual(bare.output, { answer: 'ok' });
  assert.ok(!JSON.stringify(bare.last).includes(REVIEW), 'the bare name never loads the user\'s skill');
  t.diagnostic(`bare Skill("review") was told: ${toolResults(bare.last).map((r) => r.text.slice(0, 120)).join(' | ')}`);
});

test("a skill that is not the host's (one the CLI bundles) is refused, and none of it reaches the model", { skip, timeout: 120_000 }, async (t) => {
  const { output, last } = await node(t, { skills: [SKILL], call: 'simplify' });
  assert.deepEqual(output, { answer: 'ok' });
  const results = toolResults(last);
  const refused = results.filter((r) => r.error);
  assert.ok(refused.length === 1 && /not one of this session's skills|not in this session's skills allowlist/.test(refused[0].text), JSON.stringify(results));
  assert.ok(!JSON.stringify(last).includes(CANARY), 'nothing was loaded');
});

test('an adapter with no skills offers no Skill tool and no read_skill_file', { skip, timeout: 120_000 }, async (t) => {
  const { output, offered } = await node(t, {});
  assert.deepEqual(output, { answer: 'ok' });
  assert.ok(offered.length >= 1 && offered.every((tools) => !tools.includes('Skill') && !tools.includes('mcp__hands__read_skill_file')), JSON.stringify(offered));
});

test("after loading a skill, the model reads one of its files with read_skill_file, and the file's text reaches it", { skip, timeout: 120_000 }, async (t) => {
  const dir = mkdtempSync(join(ROOT, 'read-'));
  let step = 0;
  const provider = await fakeAnthropic({ reply: (r) => {
    if (r.model !== MODEL) return { text: 'ok' };
    step += 1;
    if (step === 1) return { tool: { name: 'Skill', input: { skill: 'agentrun:research-method' } } };
    if (step === 2) return { tool: { name: 'mcp__hands__read_skill_file', input: { skill: 'research-method', path: 'reference/sources.md' } } };
    return { tool: { name: 'mcp__hands__submit', input: { value: { answer: 'ok' } } } };
  } });
  t.after(() => provider.close());
  const adapter = claudeAgentAdapter({ model: MODEL, smallModel: SMALL, provider: { origin: provider.url, credential: () => 'provider-secret' }, sessionsDir: join(dir, 'sessions'), skills: [SKILL] });
  const runNode = createHarnessRunner(adapter, { store: memorySessionStore(), maxTurns: 10, timeoutMs: 100_000 });
  assert.deepEqual(await runNode({ kind: 'agent', label: 'skills', system: ['Answer.'], user: 'Use the skill and its reference, then answer ok.', schema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } }, tools: [] }), { answer: 'ok' });
  const main = provider.messages().filter((r) => r.model === MODEL);
  assert.ok(main.every((r) => (r.body?.tools ?? []).some((x) => x.name === 'mcp__hands__read_skill_file')), 'read_skill_file is offered with skills');
  const last = main.at(-1)?.body;
  assert.ok(JSON.stringify(last).includes('Primary sources first.'), 'the reference file reached the model');
  assert.deepEqual(toolResults(last).filter((r) => r.error), [], 'no call failed');
});

test('the skills are checked when the adapter is made: a plain name, a SKILL.md that names it with a description, plain relative paths, 1 MiB in all', () => {
  const md = (name, extra = 'description: d') => `---\nname: ${name}\n${extra}\n---\nbody\n`;
  assert.deepEqual(skillProblems([SKILL]), []);
  const wrong = (skill) => skillProblems([skill]).join('; ');
  assert.match(wrong({ name: 'Bad Name', files: { 'SKILL.md': md('Bad Name') } }), /not lowercase letters, digits and dashes/);
  assert.match(wrong({ name: 'a', files: {} }), /no SKILL.md with front matter/);
  assert.match(wrong({ name: 'a', files: { 'SKILL.md': md('b') } }), /names it otherwise/);
  // A SKILL.md saved with Windows line endings is the same skill.
  assert.deepEqual(skillProblems([{ name: 'a', files: { 'SKILL.md': '---\r\nname: a\r\ndescription: d\r\n---\r\nbody\r\n' } }]), [], 'CRLF front matter');
  // One path both a file and a folder can't be written: refused here, not when the session starts.
  for (const files of [{ reference: 'x', 'reference/sources.md': 'y' }, { 'reference/sources.md': 'y', reference: 'x' }]) {
    assert.match(wrong({ name: 'a', files: { 'SKILL.md': md('a'), ...files } }), /reference is both a file and a folder/, JSON.stringify(Object.keys(files)));
  }
  // At any depth: a 2-deep folder that is also a file.
  assert.match(wrong({ name: 'a', files: { 'SKILL.md': md('a'), 'ref/sub': 'x', 'ref/sub/x.md': 'y' } }), /ref\/sub is both a file and a folder/);
  // YAML may quote the name, either way, as a generator writes it.
  for (const quoted of ["'a'", '"a"']) assert.deepEqual(skillProblems([{ name: 'a', files: { 'SKILL.md': md(quoted) } }]), [], quoted);
  for (const odd of ["'a\"", "'b'"]) assert.match(wrong({ name: 'a', files: { 'SKILL.md': md(odd) } }), /names it otherwise/, odd);
  assert.match(wrong({ name: 'a', files: { 'SKILL.md': md('a', 'other: x') } }), /no description/);
  for (const path of ['../escape.md', '/abs.md', 'a/../../b.md', 'a//b.md', '.hidden', 'a/./b']) assert.match(wrong({ name: 'a', files: { 'SKILL.md': md('a'), [path]: 'x' } }), /not a plain relative path/, path);
  assert.match(skillProblems([{ name: 'a', files: { 'SKILL.md': md('a') } }, { name: 'a', files: { 'SKILL.md': md('a') } }]).join(';'), /given twice/);
  // A name the CLI keeps for itself is no problem: that skill is served by its qualified name alone.
  for (const name of ['simplify', 'help', 'review']) assert.deepEqual(skillProblems([{ name, files: { 'SKILL.md': md(name) } }]), [], name);
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
