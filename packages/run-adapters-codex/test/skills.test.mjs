// The host's skills through the Codex adapter, on the pinned binary, with a scripted provider behind the session's proxy.
// A session lists to the model exactly the host's skills, never Codex's bundled ones (skill-installer, skill-creator, ...),
// with skills or without; with skills the model reads a skill's SKILL.md and its other files through read_skill_file, since
// it has no shell. The skills are checked when the adapter is made, by the same check the Claude adapter runs. No network.
//
// Without the binary the binary tests skip; with AGENTRUN_CODEX_REQUIRE_BINARY=1 (CI) a missing one fails (tool-off.test).
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createHarnessRunner, READ_SKILL_FILE, skillProblems as sharedSkillProblems } from '@parcha/agentrun-kernel';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { codexAdapter, skillProblems } from '@parcha/agentrun-harness-codex';
import { findCodex } from '../dist/binary.js';
import { verifyCodexBinary } from '../dist/verify.js';

const binary = verifyCodexBinary(findCodex());
const problem = binary instanceof Error ? binary.message : undefined;
const skip = problem && process.env.AGENTRUN_CODEX_REQUIRE_BINARY !== '1' ? problem : false;
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-codex-skills-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const CANARY = 'CANARY-RESEARCH-METHOD';
const SKILL = { name: 'research-method', files: { 'SKILL.md': `---\nname: research-method\ndescription: How this host researches.\n---\n${CANARY}: cite every source you fetched. Read reference/sources.md.\n`, 'reference/sources.md': 'Primary sources first.\n' } };
/** Codex's own bundled skills, as the pinned binary installs them under CODEX_HOME/skills/.system. */
const BUNDLED = ['imagegen', 'openai-docs', 'review-agent', 'skill-creator', 'skill-installer'];

const usage = { input_tokens: 10, input_tokens_details: null, output_tokens: 2, output_tokens_details: null, total_tokens: 12 };
const sse = (n, items) => [
  { type: 'response.created', response: { id: `resp_${n}` } },
  ...items.map((item) => ({ type: 'response.output_item.done', item })),
  { type: 'response.completed', response: { id: `resp_${n}`, usage } },
].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const say = (n) => ({ type: 'message', role: 'assistant', id: `msg_${n}`, content: [{ type: 'output_text', text: 'done' }] });
const submit = { type: 'function_call', name: 'submit', arguments: JSON.stringify({ value: { answer: 'ok' } }), call_id: 'call_submit' };
const readCall = (id, skill, path) => ({ type: 'function_call', name: READ_SKILL_FILE, arguments: JSON.stringify({ skill, path }), call_id: id });

/** One node on the pinned binary whose model answers `first` (then submits, then says done); what it was sent. */
async function node({ skills, first = [submit] }) {
  const dir = mkdtempSync(join(ROOT, 'run-'));
  const seen = [];
  const answers = first.includes(submit) ? [first] : [first, [submit]];
  const fetch = async (_url, init) => {
    seen.push(JSON.parse(init.body));
    const n = seen.length;
    return new Response(sse(n, answers[n - 1] ?? [say(n)]), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const codex = codexAdapter({ model: 'gpt-5.4-mini', provider: { origin: 'https://provider.invalid', credential: () => 'provider-secret' }, sessionsDir: join(dir, 'sessions'), fetch, ...(skills ? { skills } : {}) });
  const runNode = createHarnessRunner(codex, { store: memorySessionStore(), timeoutMs: 90_000 });
  const output = await runNode({ kind: 'agent', label: 'skills', system: ['Answer.'], user: 'Use the skill, then answer ok.', schema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } }, tools: [] });
  // What Codex sent back for each call, from the request after it.
  const outputs = new Map();
  for (const it of seen[1]?.input ?? []) if (it.type === 'function_call_output') outputs.set(it.call_id, Array.isArray(it.output) ? it.output.map((o) => o.text).join('') : it.output);
  const sessions = join(dir, 'sessions');
  const session = join(sessions, readdirSync(sessions)[0]);
  return { output, seen, outputs, session };
}

/** The skills section Codex puts before the model, and the names it lists. */
function listed(body) {
  const text = JSON.stringify(body?.input ?? []);
  const section = /<skills_instructions>.*?<\/skills_instructions>/.exec(text)?.[0];
  return { section, names: section ? [...section.matchAll(/\\n- ([a-z0-9-]+): /g)].map((m) => m[1]) : [] };
}

test("a session lists the host's skill to the model and none of Codex's bundled skills; with no host skills it lists none at all", { skip, timeout: 180_000 }, async () => {
  const withSkills = await node({ skills: [SKILL] });
  assert.deepEqual(withSkills.output, { answer: 'ok' });
  const shown = listed(withSkills.seen[0]);
  assert.deepEqual(shown.names, ['research-method'], `the host's skill alone: ${shown.section}`);
  assert.ok(shown.section.includes('How this host researches.'), 'with its description');
  assert.ok(!JSON.stringify(withSkills.seen[0]).includes(CANARY), "the skill's body is not sent until the model reads it");
  for (const name of BUNDLED) assert.ok(!JSON.stringify(withSkills.seen).includes(`- ${name}:`), `${name} is not listed`);
  assert.deepEqual(withSkills.seen[0].tools.map((t) => t.name).sort(), [READ_SKILL_FILE, 'submit'], 'read_skill_file is offered with skills');

  const without = await node({});
  assert.deepEqual(without.output, { answer: 'ok' });
  assert.deepEqual(listed(without.seen[0]), { section: undefined, names: [] }, 'no skills section');
  for (const name of BUNDLED) assert.ok(!JSON.stringify(without.seen).includes(name), `${name} is not listed`);
  assert.deepEqual(without.seen[0].tools.map((t) => t.name), ['submit'], 'no read_skill_file without skills');
  assert.deepEqual(readdirSync(join(without.session, 'work')), [], 'nothing in the working directory');
});

test("read_skill_file gives the model a skill's SKILL.md and its reference file, exactly, and refuses a file the skill does not list or a path that climbs out of it", { skip, timeout: 180_000 }, async () => {
  const r = await node({ skills: [SKILL], first: [readCall('call_md', 'research-method', 'SKILL.md'), readCall('call_ref', 'research-method', 'reference/sources.md'), readCall('call_unlisted', 'research-method', 'notes.md'), readCall('call_other', 'research-method', '../../config.toml')] });
  assert.deepEqual(r.output, { answer: 'ok' });
  assert.equal(r.outputs.get('call_md'), SKILL.files['SKILL.md']);
  assert.equal(r.outputs.get('call_ref'), 'Primary sources first.\n');
  assert.match(r.outputs.get('call_unlisted') ?? '', /is not one of the skill research-method's files/);
  assert.match(r.outputs.get('call_other') ?? '', /absolute or climbs/);
  // The skills are the session's own, under its CODEX_HOME (outside every writable root of the model's commands), and
  // nothing is written to the working directory.
  assert.equal(readFileSync(join(r.session, 'codex-home', 'skills', 'research-method', 'reference', 'sources.md'), 'utf8'), 'Primary sources first.\n');
  assert.deepEqual(readdirSync(join(r.session, 'work')), []);
});

test("the skills are checked when the adapter is made, by the check the Claude adapter runs; read_skill_file is the adapter's own name when it has skills", () => {
  assert.equal(skillProblems, sharedSkillProblems, "the Codex adapter's check is @parcha/agentrun-kernel' skillProblems");
  const provider = { origin: 'https://provider.invalid', credential: () => 'k' };
  // Thrown before the binary is looked for: a bad skill is the host's to fix, with or without Codex installed.
  assert.throws(() => codexAdapter({ model: 'm', provider, skills: [{ name: 'a', files: {} }] }), /agentrun-harness-codex: the skill a has no SKILL.md with front matter/);
  assert.throws(() => codexAdapter({ model: 'm', provider, skills: [{ name: 'Bad Name', files: { 'SKILL.md': '---\nname: Bad Name\ndescription: d\n---\n' } }] }), /agentrun-harness-codex: the skill name "Bad Name" is not lowercase letters, digits and dashes/);
  assert.throws(() => codexAdapter({ model: 'm', provider, skills: [{ name: 'a', files: { 'SKILL.md': '---\nname: a\n---\n' } }] }), /agentrun-harness-codex: the skill a's SKILL.md has no description/);
  const host = { name: READ_SKILL_FILE, description: 'mine', inputSchema: { type: 'object', properties: {} }, replay: 'safe', call: async () => ({ text: '' }) };
  const spec = { key: 'k', label: 'l', system: [], tools: [host], context: 'fresh' };
  const stand = { command: process.execPath };
  assert.deepEqual(codexAdapter({ model: 'm', provider, standIn: stand, skills: [SKILL] }).check(spec), [`the tool name ${READ_SKILL_FILE} is the adapter's own when it has skills`]);
  assert.deepEqual(codexAdapter({ model: 'm', provider, standIn: stand }).check(spec), [], 'without skills a host may name its own tool so');
});
