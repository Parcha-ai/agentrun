#!/usr/bin/env node
// An agent that learns in its own git repository, end to end in one command, with a scripted model: no key, no network.
//   node examples/agent-learn/demo.mjs [--dir <empty dir to keep>] [--live]
// --live runs the three triage runs on a real model at an OpenAI Responses endpoint (AGENT_MODEL_BASE_URL, AGENT_MODEL,
// AGENT_MODEL_API_KEY, AGENT_THINKING; see README.md). The judge and the secret run stay scripted.
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { agentLearn, guard } from '@parcha/pi-agent-learn';
import { local, openRepo } from '@parcha/pi-git-remote';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { agentHomeFor, curateNow, finishRun, prepareRun, revertLearning } from './host.mjs';

const AGENT_DIR = join(import.meta.dirname, 'agent');
const HOST = 'agent-learn-demo';
const LESSON = 'An issue whose body has a stack trace is a bug report even when its title asks a question: label it bug.';

export const ISSUES = {
  first: {
    values: ['dana-w', '4821'],
    text: 'Issue 4821 from dana-w\nTitle: How do I set a timeout for sync?\n\nRunning sync on a large folder stops with:\nTypeError: Cannot read properties of undefined (reading \'timeout\')\n    at runSync (sync.js:41:17)\n    at main (cli.js:12:3)',
  },
  second: {
    values: ['lee-k', '4907'],
    text: 'Issue 4907 from lee-k\nTitle: Can uploads retry on their own?\n\nUploads over 2 GB fail every time:\nRangeError: Invalid array length\n    at chunk (upload.js:88:9)\n    at upload (upload.js:30:5)',
  },
};

const JUDGE = { general: 0.94, narrowsRules: 0.03, fromContent: 0.03, duplicate: 0.04, supersedes: 0.04, contradicts: 0.03 };
const ASKED = { general: 'general', narrowsRules: 'narrows a rule', fromContent: 'came from content', duplicate: 'a duplicate', supersedes: 'replaces one', contradicts: 'contradicts one' };

export function scriptedJudge(asked = []) {
  return async ({ questions }) => {
    const answers = {};
    for (const key of Object.keys(questions)) {
      answers[key] = { type: 'noul', noul: JUDGE[key] ?? 0.5 };
      asked.push({ question: key, p: answers[key].noul });
    }
    return { answers, model: 'scripted', usage: null, cost_usd: null };
  };
}

// ---- the model -------------------------------------------------------------------------------------------------------------

const textOf = (content) => (typeof content === 'string' ? content : (content ?? []).map((part) => part.text ?? '').join(''));

const systemText = (messages) =>
  messages.filter((m) => m.role === 'system').map((m) => [textOf(m.content), ...Object.values(m.sections ?? {}).filter((s) => typeof s === 'string')].join('\n')).join('\n');

const learnedLines = (system) => {
  const lines = system.split('\n');
  const start = lines.findIndex((line) => line.includes('<learned>'));
  const end = lines.findIndex((line, i) => i >= start && line.includes('</learned>'));
  return start < 0 ? [] : lines.slice(start, end + 1);
};

function scriptedModel({ learn, answer: fixed } = {}) {
  const requests = [];
  const faux = fauxProvider({ models: [{ id: 'scripted' }] });
  const label = (context) => {
    const lesson = /- (L-[0-9a-f]{12}) lesson: An issue whose body has a stack trace/.exec(learnedLines(systemText(context.messages)).join('\n'));
    if (lesson) return `bug: the body is a crash trace, and ${lesson[1]} says a question with a stack trace is a bug report.`;
    const asked = textOf(context.messages.findLast((m) => m.role === 'user')?.content);
    return /^Title: .*\?$/m.test(asked) ? 'question: the title asks how to do something.' : 'bug: something fails.';
  };
  const answer = (context) => {
    requests.push(context);
    return fauxAssistantMessage([fauxText(fixed ?? label(context))], { stopReason: 'stop' });
  };
  faux.setResponses(learn
    ? [(context) => (requests.push(context), fauxAssistantMessage([fauxToolCall('learn', learn, { id: 'call-1' })], { stopReason: 'toolUse' })), answer]
    : [answer]);
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, agent: { model: { provider: 'faux', modelId: 'scripted' } }, requests };
}

function liveModel(env = process.env) {
  const baseUrl = env.AGENT_MODEL_BASE_URL?.replace(/\/+$/, '');
  const id = env.AGENT_MODEL;
  if (!baseUrl || !id) throw new Error('--live needs AGENT_MODEL_BASE_URL (an OpenAI Responses endpoint) and AGENT_MODEL (its model id)');
  const thinkingLevel = env.AGENT_THINKING || 'medium';
  const models = createModels();
  models.setProvider(createProvider({
    id: 'agent-model',
    baseUrl,
    auth: { apiKey: { name: 'AGENT_MODEL_API_KEY', resolve: async () => ({ auth: { apiKey: env.AGENT_MODEL_API_KEY || 'none' }, source: 'AGENT_MODEL_API_KEY' }) } },
    models: [{
      id, name: id, api: 'openai-responses', provider: 'agent-model', baseUrl, reasoning: true, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 8_000,
      compat: { supportsDeveloperRole: false },
    }],
    api: openAIResponsesApi(),
  }));
  return { models, agent: { model: { provider: 'agent-model', modelId: id }, thinkingLevel }, requests: [] };
}

// ---- one run ---------------------------------------------------------------------------------------------------------------

async function promptOf(run) {
  const skills = await Promise.all(run.definition.skills.map(async (name) =>
    `<skill name="${name}">\n${(await readFile(join(run.workspace, '.agents/skills', name, 'SKILL.md'), 'utf8')).trim()}\n</skill>`));
  return [run.definition.instructions, run.rules.trim(), ...skills].join('\n\n');
}

async function runOnce(run, issue, model, vault) {
  const registry = createRegistry();
  registry.install(agentLearn({ guard, secrets: () => vault }));
  const harness = await Harness.open(await openNodeSqliteStorage(run.storePath), { models: model.models, registry, onReport: () => {} }, ctx);
  try {
    const root = await harness.root(ctx, { agent: { ...model.agent, instructions: await promptOf(run) } });
    await (await root.submit({ type: 'input', content: issue.text }, ctx)).wait(ctx);
    const { messages } = await root.context(ctx);
    const calls = messages.filter((m) => m.role === 'assistant').flatMap((m) => m.content.filter((c) => c.type === 'toolCall'));
    const results = messages.filter((m) => m.role === 'toolResult').map((m) => textOf(m.content));
    const answer = textOf(messages.findLast((m) => m.role === 'assistant')?.content).trim();
    const system = systemText(model.requests[0]?.messages ?? []);
    const sent = learnedLines(system);
    return { answer, calls, results, system, learned: sent.length ? sent : ['<learned>', ...run.seeded.section.split('\n'), '</learned>'], fromRequest: sent.length > 0 };
  } finally {
    await harness.close(ctx);
  }
}

// ---- git, for the transcript ------------------------------------------------------------------------------------------------

const gitEnv = (home) => ({ PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', HOME: home });

export function gitRead(gitDir, args) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { env: { ...gitEnv(gitDir), GIT_DIR: gitDir }, encoding: 'buffer', maxBuffer: 64 << 20 });
}

export function objectsHolding(gitDir, needles) {
  const all = gitRead(gitDir, ['cat-file', '--batch-all-objects', '--batch']);
  let at = 0;
  let count = 0;
  let holding = 0;
  while (at < all.length) {
    const newline = all.indexOf(10, at);
    const size = Number(all.subarray(at, newline).toString('utf8').split(' ')[2]);
    const body = all.subarray(newline + 1, newline + 1 + size);
    count++;
    if (needles.some((needle) => body.includes(needle))) holding++;
    at = newline + 1 + size + 1;
  }
  return { count, holding };
}

const short = (sha) => sha.slice(0, 7);

// ---- the story ---------------------------------------------------------------------------------------------------------------

async function agentFiles() {
  const files = {
    'agent.json': await readFile(join(AGENT_DIR, 'agent.json'), 'utf8'),
    'AGENTS.md': await readFile(join(AGENT_DIR, 'AGENTS.md'), 'utf8'),
  };
  for (const name of await readdir(join(AGENT_DIR, 'skills'))) files[`.agents/skills/${name}/SKILL.md`] = await readFile(join(AGENT_DIR, 'skills', name, 'SKILL.md'), 'utf8');
  return files;
}

export async function runDemo({ dir, live = false, env = process.env, log = () => {} } = {}) {
  const root = dir ? resolve(dir) : await mkdtemp(join(tmpdir(), 'agent-learn-demo-'));
  await mkdir(root, { recursive: true });
  await chmod(root, 0o755);
  const say = (line = '') => log(line);
  const bare = join(root, 'agent.git');
  execFileSync('git', ['init', '-q', '--bare', '--template=', '-b', 'main', bare], { env: gitEnv(root) });
  const repo = await openRepo({ dir: join(root, 'host-repo'), remote: local(bare) });
  const vault = [`demo-vault-${randomBytes(16).toString('hex')}`];
  const asked = [];
  const judge = scriptedJudge(asked);
  const modelFor = (script) => (live ? liveModel(env) : scriptedModel(script));
  const out = { root, bare, vault };

  say(`agent-learn demo: an agent that learns in its own git repository`);
  say(`model: ${live ? `${env.AGENT_MODEL} at an OpenAI Responses endpoint` : 'scripted (no key, no network)'}; judge: scripted`);
  say();

  const seed = await repo.commitTo('main', { files: await agentFiles(), message: 'the agent: definition, rules and the triage skill' });
  await repo.push(seed.sha, 'main');
  const home = await agentHomeFor({ dir: join(root, 'home'), repo });
  say('1. The agent repository: a bare repo holding agent.json, AGENTS.md and .agents/skills/triage/SKILL.md');
  say(`   main ${short(seed.sha)}`);
  say();

  // Run 1 learns.
  const run1 = await prepareRun({ home, repo, host: HOST, runId: 'run-1' });
  const r1 = await runOnce(run1, ISSUES.first, modelFor({
    learn: { type: 'lesson', text: LESSON, evidence: ['the body holds a TypeError trace'] },
    answer: 'bug: the title asks a question, but the body is a crash trace.',
  }), vault);
  const f1 = await finishRun({ home, repo, run: run1, secrets: vault, caseValues: ISSUES.first.values });
  out.run1 = { run: run1, ...r1, ...f1 };
  say(`2. Run 1 starts at main ${short(run1.sha)}: ${run1.seeded.index.length ? `${run1.seeded.index.length} learnings` : 'nothing learned yet'}`);
  say(`   issue: "${/^Title: (.*)$/m.exec(ISSUES.first.text)[1]}" (its body is a stack trace)`);
  for (const [i, call] of r1.calls.entries()) say(`   learn(${call.arguments.type}) -> ${r1.results[i] ?? '(no result)'}\n     "${call.arguments.text}"`);
  say(`   answer: ${r1.answer}`);
  say(f1.proposal.status === 'proposed' ? `   proposed on runs/run-1 at ${short(f1.proposal.sha)}; main has not moved` : `   proposed nothing (${f1.proposal.status})`);
  say();

  // Curation merges it.
  const c1 = await curateNow({ repo, judge, secrets: vault });
  const accepted = c1.runs.flatMap((r) => r.accepted);
  out.curate1 = c1;
  out.lessonId = accepted[0]?.id;
  say(`3. Curate asks the judge: ${[...new Map(asked.map((a) => [a.question, a.p])).entries()].map(([q, p]) => `${ASKED[q] ?? q}? ${p}`).join('; ')}`);
  for (const r of c1.runs) say(`   ${r.run}: ${r.accepted.length} accepted, ${r.refused.length} refused, ${r.held.length} held`);
  say(`   main ${short(c1.main)} adds ${accepted.map((a) => `learnings/${a.id}.md`).join(', ') || 'nothing'}`);
  say();

  // Run 2 sees it.
  const run2 = await prepareRun({ home, repo, host: HOST, runId: 'run-2' });
  const r2 = await runOnce(run2, ISSUES.second, modelFor(), vault);
  const f2 = await finishRun({ home, repo, run: run2, secrets: vault, caseValues: ISSUES.second.values });
  out.run2 = { run: run2, ...r2, ...f2 };
  say(`4. Run 2 starts at main ${short(run2.sha)}. ${r2.fromRequest ? 'Its first model request carries' : 'Its <learned> section'}:`);
  for (const line of r2.learned) say(`     ${line}`);
  say(`   issue: "${/^Title: (.*)$/m.exec(ISSUES.second.text)[1]}" (its body is a stack trace)`);
  say(`   answer: ${r2.answer}`);
  say();

  // A revert on main removes it.
  const reverted = out.lessonId ? await revertLearning({ repo, id: out.lessonId }) : undefined;
  const c2 = await curateNow({ repo, judge, secrets: vault });
  out.revert = reverted;
  out.curate2 = c2;
  say(`5. Revert the lesson on main (git revert of the commit that added ${out.lessonId ?? 'it'})`);
  if (reverted) say(`   main ${short(reverted.sha)} reverts ${short(reverted.reverted)}`);
  say(`   curate again: ${c2.runs.length ? `${c2.runs.length} run(s) curated` : 'nothing to curate, the lesson does not come back'}; main stays ${short(c2.main)}`);
  say();

  // Run 3 does not see it.
  const run3 = await prepareRun({ home, repo, host: HOST, runId: 'run-3' });
  const r3 = await runOnce(run3, ISSUES.second, modelFor(), vault);
  const f3 = await finishRun({ home, repo, run: run3, secrets: vault, caseValues: ISSUES.second.values });
  out.run3 = { run: run3, ...r3, ...f3 };
  say(`6. Run 3 starts at main ${short(run3.sha)}. ${r3.fromRequest ? 'Its first model request carries' : 'Its <learned> section'}:`);
  for (const line of r3.learned) say(`     ${line}`);
  say(`   same issue as run 2; answer: ${r3.answer}`);
  say();

  // A run that tries to learn a secret proposes nothing. Always scripted: it plants the value on purpose.
  const run4 = await prepareRun({ home, repo, host: HOST, runId: 'run-4' });
  const r4 = await runOnce(run4, ISSUES.first, scriptedModel({ learn: { type: 'fact', text: `The tracker's deploy token is ${vault[0]}; use it to post labels.` } }), vault);
  const f4 = await finishRun({ home, repo, run: run4, secrets: vault, caseValues: ISSUES.first.values });
  const needles = [vault[0], Buffer.from(vault[0]).toString('base64'), Buffer.from(vault[0]).toString('hex')].map((s) => Buffer.from(s));
  const gitDir = existsSync(join(repo.dir, '.git')) ? join(repo.dir, '.git') : repo.dir;
  const scan = [objectsHolding(bare, needles), objectsHolding(gitDir, needles)];
  out.run4 = { run: run4, ...r4, ...f4, scan };
  say('7. Run 4 tries to learn a value the host holds as a secret');
  for (const [i, call] of r4.calls.entries()) say(`   learn(${call.arguments.type}) -> ${r4.results[i] ?? '(no result)'}`);
  say(`   proposed ${f4.proposal.status === 'empty' ? 'nothing' : f4.proposal.status}; the secret (raw, base64 or hex) is in ${scan[0].holding + scan[1].holding} of ${scan[0].count + scan[1].count} git objects (remote and host repository)`);
  say();

  out.log = gitRead(bare, ['log', '--oneline', 'main']).toString('utf8').trimEnd();
  say('git log --oneline main');
  for (const line of out.log.split('\n')) say(`  ${line}`);
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--dir');
  const dir = at >= 0 ? args[at + 1] : undefined;
  const unknown = args.filter((arg, i) => !['--live', '--dir'].includes(arg) && !(at >= 0 && i === at + 1));
  if (unknown.length || (at >= 0 && !dir)) {
    console.error('usage: node examples/agent-learn/demo.mjs [--dir <empty dir to keep>] [--live]');
    process.exit(2);
  }
  try {
    const out = await runDemo({ dir, live: args.includes('--live'), log: (line) => console.log(line) });
    if (dir) console.log(`\nkept in ${out.root}: git --git-dir ${out.bare} log main`);
    else await rm(out.root, { recursive: true, force: true });
  } catch (error) {
    console.error(`demo failed: ${error.stack ?? error}`);
    process.exit(1);
  }
}
