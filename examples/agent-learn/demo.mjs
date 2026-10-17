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
import { workspaceFiles } from '@parcha/agentrun-dsl/recovery';
import { createWorkflowTool } from '@parcha/agentrun-pi/durable';
import { WorkflowStore } from '@parcha/agentrun-pi/workflows';
import { retireLearning } from '@parcha/pi-agent-learn';
import { local, openRepo } from '@parcha/pi-git-remote';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { agentHomeFor, curateNow, finishRun, learnExtension, prepareRun } from './host.mjs';

const AGENT_DIR = join(import.meta.dirname, 'agent');
const HOST = 'agent-learn-demo';
// A project rule no model can guess from an issue: the maintainer says it once, in run 1.
const CORRECTION = 'Correction from the maintainer: in this project an issue whose body has a stack trace is labeled bug and needs-repro. Remember that for next time.';
const RULE = 'In this project an issue whose body has a stack trace is labeled bug and needs-repro.';
const WORKFLOW = 'triage-crash';
const WORKFLOW_WHEN = 'Use it for an issue whose body holds a stack trace: it labels the issue bug and needs-repro.';

const issue = (number, reporter, title, body) => ({
  input: { title, body },
  values: [reporter, String(number)],
  text: `Issue ${number} from ${reporter}\nTitle: ${title}\n\n${body}`,
});
export const ISSUES = {
  first: issue(4821, 'dana-w', 'How do I set a timeout for sync?',
    'Running sync on a large folder stops with:\nTypeError: Cannot read properties of undefined (reading \'timeout\')\n    at runSync (sync.js:41:17)\n    at main (cli.js:12:3)'),
  second: issue(4907, 'lee-k', 'Can uploads retry on their own?',
    'Uploads over 2 GB fail every time:\nRangeError: Invalid array length\n    at chunk (upload.js:88:9)\n    at upload (upload.js:30:5)'),
};

// The tools a saved workflow may call here; the demo never runs one.
const WORKFLOW_TOOLS = [{
  name: 'issues.label', description: 'Set the labels of an issue, comma separated.',
  parameters: { type: 'object', required: ['title', 'labels'], properties: { title: { type: 'string' }, labels: { type: 'string' } } },
}];
export const TRIAGE_WORKFLOW = {
  v: 2, name: WORKFLOW,
  schemas: {
    Issue: { type: 'object', additionalProperties: false, required: ['title', 'body'], properties: { title: { type: 'string' }, body: { type: 'string' } } },
    Labeled: { type: 'object', required: ['labels'], properties: { labels: { type: 'string' } } },
  },
  input: { schemaId: 'Issue' },
  output: { schemaId: 'Labeled', path: 'labeled' },
  root: {
    node: 'chain',
    steps: [{ node: 'call', label: 'label it bug and needs-repro', via: 'tool', tool: 'issues.label', args: { title: '{title}', labels: 'bug,needs-repro' }, out: 'Labeled', as: 'labeled', deadline_s: 20 }],
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

const ruleIn = (context) =>
  /- (L-[0-9a-f]{12}) correction: In this project an issue whose body has a stack trace is labeled bug and needs-repro/.exec(learnedLines(systemText(context.messages)).join('\n'))?.[1];

// `steps` are the model's responses in order, across every turn of the run: a tool call, or an answer (text, or the
// label its <learned> section leads to).
function scriptedModel(steps) {
  const requests = [];
  const faux = fauxProvider({ models: [{ id: 'scripted' }] });
  const label = (context) => {
    const rule = ruleIn(context);
    return rule ? `bug, needs-repro: the body is a crash trace, and ${rule} says this project labels those needs-repro too.` : 'bug: the body is a crash trace.';
  };
  let call = 0;
  faux.setResponses(steps.map((step) => (context) => {
    requests.push(context);
    if (step.call) return fauxAssistantMessage([fauxToolCall(step.call, typeof step.args === 'function' ? step.args(context) : step.args, { id: `call-${++call}` })], { stopReason: 'toolUse' });
    return fauxAssistantMessage([fauxText(step.say ?? label(context))], { stopReason: 'stop' });
  }));
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

async function runOnce(run, inputs, model, vault, caseValues) {
  const learn = learnExtension({ secrets: vault, caseValues });
  // The workflow tool keeps the run's saved workflows in the run's own workspace, where finishRun collects them.
  const workflowTool = createWorkflowTool({
    projectDir: run.workspace,
    tools: WORKFLOW_TOOLS,
    task: {
      options: () => ({ files: workspaceFiles(run.workspace) }),
      run: () => ({ adapters: { runEffect: async () => { throw new Error('this demo runs no workflow'); } } }),
    },
  });
  const registry = createRegistry();
  registry.install(learn);
  registry.install(workflowTool.extension);
  const harness = await Harness.open(await openNodeSqliteStorage(run.storePath), { models: model.models, registry, onReport: () => {} }, ctx);
  try {
    const root = await harness.root(ctx, { agent: { ...model.agent, extensions: [learn, workflowTool.extension], instructions: await promptOf(run) } });
    const turns = [];
    let seen = 0;
    for (const content of inputs) {
      await (await root.submit({ type: 'input', content }, ctx)).wait(ctx);
      const { messages } = await root.context(ctx);
      const fresh = messages.slice(seen);
      seen = messages.length;
      turns.push({
        input: content,
        calls: fresh.filter((m) => m.role === 'assistant').flatMap((m) => m.content.filter((c) => c.type === 'toolCall')),
        results: fresh.filter((m) => m.role === 'toolResult').map((m) => textOf(m.content)),
        answer: textOf(fresh.findLast((m) => m.role === 'assistant')?.content).trim(),
      });
    }
    const system = systemText(model.requests[0]?.messages ?? []);
    const sent = learnedLines(system);
    return {
      turns, answer: turns.at(-1).answer, calls: turns.flatMap((t) => t.calls), results: turns.flatMap((t) => t.results), system,
      learned: sent.length ? sent : ['<learned>', ...run.seeded.section.split('\n'), '</learned>'], fromRequest: sent.length > 0,
    };
  } finally {
    await harness.close(ctx);
  }
}

/** One line per tool call, as the transcript shows it. */
function callLines(r) {
  return r.calls.map((call, i) => {
    const result = r.results[i] ?? '(no result)';
    const args = call.arguments;
    if (call.name === 'learn') return `learn(${args.type}${args.id ? ` ${args.id}` : ''}) -> ${result}${args.type === 'used' ? '' : `\n     "${args.text}"`}`;
    let shown = result.split('\n')[0].slice(0, 120);
    try {
      const value = JSON.parse(result);
      if (args.action === 'inspect') shown = 'valid; kept as this conversation\'s draft';
      if (args.action === 'save') shown = `saved ${value.name} as ${value.digest.slice(0, 12)}`;
    } catch {}
    return `agentrun(${args.action}${args.name ? ` ${args.name}` : ''}) -> ${shown}`;
  });
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

/** Why a proposal made no commit: its status, and for a refusal each reason with the field or path it hit, never a value. */
export function proposalStatus(proposal) {
  if (proposal.status !== 'refused') return proposal.status;
  return `refused: ${proposal.refusals.map((r) => `${r.reason}${r.field ? ` in ${r.field}` : ''}${r.path ? ` in ${r.path}` : ''}`).join('; ')}`;
}
const runLine = (r) => {
  const done = [...r.used.map((u) => `${u.id} used (${u.reason})`), ...r.accepted.map((a) => (a.workflow ? `workflow ${a.workflow} admitted as a trial` : `${a.id} accepted (${a.reason})`))];
  const rest = [...(r.held.length ? [`held: ${r.held.map((h) => h.reason).join('; ')}`] : []), ...(r.refused.length ? [`refused: ${r.refused.map((h) => h.reason).join('; ')}`] : [])];
  return `${r.run}: ${[...done, ...rest].join('; ') || 'nothing'}`;
};
const shortPaths = (paths) => paths.map((path) => path.replace(/\b([0-9a-f]{12})[0-9a-f]{52}\b/, '$1...')).join(', ');

// ---- the story ---------------------------------------------------------------------------------------------------------------

async function agentFiles() {
  const files = {
    'agent.json': await readFile(join(AGENT_DIR, 'agent.json'), 'utf8'),
    'AGENTS.md': await readFile(join(AGENT_DIR, 'AGENTS.md'), 'utf8'),
  };
  for (const name of await readdir(join(AGENT_DIR, 'skills'))) files[`.agents/skills/${name}/SKILL.md`] = await readFile(join(AGENT_DIR, 'skills', name, 'SKILL.md'), 'utf8');
  return files;
}

// `run1` and `run2` replace those scripted runs' steps, for tests of what the transcript says on other paths.
export async function runDemo({ dir, live = false, env = process.env, log = () => {}, run1: run1Steps, run2: run2Steps } = {}) {
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
  const proposed = (sha, runId) => {
    const files = gitRead(bare, ['ls-tree', '-r', '--name-only', sha, '--', `inbox/${runId}.md`, `inbox/${runId}/workflows`, `uses/${runId}.json`])
      .toString('utf8').trim().split('\n').filter(Boolean);
    const names = [...new Set(files.map((file) => file.split('/')[3]).filter((name) => name && files.some((f) => f.startsWith(`inbox/${runId}/workflows/${name}/`))))];
    const parts = [
      ...(files.includes(`inbox/${runId}.md`) ? ['its notes'] : []),
      ...(names.length ? [`${names.join(' and ')}'s DSL records`] : []),
      ...(files.includes(`uses/${runId}.json`) ? ['its workflow uses'] : []),
    ];
    return parts.length ? parts.join(' and ') : 'nothing of its own';
  };
  const changed = (from, to) => {
    const rows = gitRead(bare, ['diff', '--name-status', '--no-renames', from, to]).toString('utf8').trim().split('\n').filter(Boolean).map((row) => row.split('\t'));
    const of = (status, verb) => (rows.some(([s]) => s === status) ? `${verb} ${shortPaths(rows.filter(([s]) => s === status).map(([, path]) => path))}` : '');
    return [of('A', 'adds'), of('M', 'changes'), of('D', 'removes')].filter(Boolean).join('; ') || 'changes nothing';
  };
  const out = { root, bare, vault };

  say('agent-learn demo: an agent that learns in its own git repository');
  say(`model: ${live ? `${env.AGENT_MODEL} at an OpenAI Responses endpoint` : 'scripted (no key, no network)'}; judge: scripted`);
  say();

  const seed = await repo.commitTo('main', { files: await agentFiles(), message: 'the agent: definition, rules and the triage skill' });
  await repo.push(seed.sha, 'main');
  const home = await agentHomeFor({ dir: join(root, 'home'), repo });
  say('1. The agent repository: a bare repo holding agent.json, AGENTS.md and .agents/skills/triage/SKILL.md');
  say(`   main ${short(seed.sha)}`);
  say();

  // Run 1 is corrected by the maintainer, and learns the project's rule as its AGENTS.md says to.
  const run1 = await prepareRun({ home, repo, host: HOST, runId: 'run-1', input: ISSUES.first.input });
  const r1 = await runOnce(run1, [ISSUES.first.text, CORRECTION], modelFor(run1Steps ?? [
    {},
    { call: 'learn', args: { type: 'correction', text: RULE, evidence: ['the maintainer corrected the labels'] } },
    { say: 'bug, needs-repro: the body is a crash trace, and this project labels those needs-repro too.' },
  ]), vault, ISSUES.first.values);
  const f1 = await finishRun({ home, repo, run: run1, secrets: vault, caseValues: ISSUES.first.values });
  out.run1 = { run: run1, ...r1, ...f1 };
  say(`2. Run 1 starts at main ${short(run1.sha)}: ${run1.seeded.index.length ? `${run1.seeded.index.length} learnings` : 'nothing learned yet'}`);
  say(`   issue: "${ISSUES.first.input.title}" (its body is a stack trace)`);
  for (const [i, turn] of r1.turns.entries()) {
    if (i > 0) say(`   maintainer: "${turn.input}"`);
    for (const line of callLines(turn)) say(`   ${line}`);
    say(`   answer: ${turn.answer}`);
  }
  say(f1.proposal.sha ? `   proposed on runs/run-1 at ${short(f1.proposal.sha)}; main has not moved` : `   proposed nothing (${proposalStatus(f1.proposal)})`);
  say();

  const c1 = await curateNow({ repo, judge, secrets: vault });
  out.curate1 = c1;
  out.ruleId = c1.runs.flatMap((r) => r.accepted)[0]?.id;
  say(`3. Curate asks the judge: ${[...new Map(asked.map((a) => [a.question, a.p])).entries()].map(([q, p]) => `${ASKED[q] ?? q}? ${p}`).join('; ')}`);
  for (const r of c1.runs) say(`   ${runLine(r)}`);
  say(`   main ${short(c1.main)} ${changed(seed.sha, c1.main)}`);
  say();

  // Run 2 applies the rule, and saves a workflow for the next runs to try.
  const run2 = await prepareRun({ home, repo, host: HOST, runId: 'run-2', input: ISSUES.second.input });
  const r2 = await runOnce(run2, [ISSUES.second.text], modelFor(run2Steps ?? [
    { call: 'learn', args: (context) => ({ type: 'used', id: ruleIn(context), text: 'It gave this issue its labels.' }) },
    { call: 'agentrun', args: { action: 'inspect', workflow: TRIAGE_WORKFLOW, input: ISSUES.second.input } },
    { call: 'agentrun', args: { action: 'save', name: WORKFLOW } },
    { call: 'learn', args: { type: 'workflow', id: WORKFLOW, text: WORKFLOW_WHEN } },
    {},
  ]), vault, ISSUES.second.values);
  const f2 = await finishRun({ home, repo, run: run2, secrets: vault, caseValues: ISSUES.second.values });
  out.run2 = { run: run2, ...r2, ...f2 };
  say(`4. Run 2 starts at main ${short(run2.sha)}. ${r2.fromRequest ? 'Its first model request carries' : 'Its <learned> section'}:`);
  for (const line of r2.learned) say(`     ${line}`);
  say(`   issue: "${ISSUES.second.input.title}" (its body is a stack trace)`);
  for (const line of callLines(r2)) say(`   ${line}`);
  say(`   answer: ${r2.answer}`);
  say(f2.proposal.sha ? `   proposed on runs/run-2 at ${short(f2.proposal.sha)}: ${proposed(f2.proposal.sha, 'run-2')}` : `   proposed nothing (${proposalStatus(f2.proposal)})`);
  say();

  const c2 = await curateNow({ repo, judge, secrets: vault });
  out.curate2 = c2;
  const items = c2.runs.flatMap((r) => r.accepted.concat(r.used, r.held, r.refused, r.duplicates));
  const admitted = c2.runs.flatMap((r) => r.accepted.filter((a) => a.workflow).map((a) => a.workflow));
  const did = [
    ...(c2.runs.some((r) => r.used.length) ? ['counts the use'] : []),
    ...(c2.runs.some((r) => r.accepted.some((a) => !a.workflow)) ? ['accepts a learning'] : []),
    ...(admitted.length ? [`admits the workflow${admitted.length > 1 ? 's' : ''} as a trial skill`] : []),
  ];
  say(`5. Curate ${did.length ? did.join(' and ') : 'changes nothing for run 2'}`);
  for (const r of c2.runs) say(`   ${runLine(r)}`);
  const saved = [...new Set((await new WorkflowStore(run2.workspace).list()).map((w) => w.name))];
  out.run2.savedWorkflows = saved;
  if (!saved.length) say('   run 2 saved no workflow, so there is no trial to admit');
  for (const name of saved.filter((n) => !admitted.includes(n))) {
    const why = items.find((item) => item.workflow === name)?.reason
      ?? (f2.proposal.status === 'proposed' ? 'curation made no decision on it' : `the run proposed nothing (${proposalStatus(f2.proposal)})`);
    say(`   ${name} was not admitted: ${why}`);
  }
  for (const name of admitted) {
    if ((await repo.read(`.agents/skills/${name}/SKILL.md`, c2.main)) === undefined) say(`   ${name} has no skill: no learn(workflow) said when to use it, so later runs are not offered it`);
  }
  say(`   main ${short(c2.main)} ${changed(c1.main, c2.main)}`);
  say();

  // The maintainer withdraws the rule. A git revert of the commit that added it conflicts once a run used it, so the
  // general way out is retireLearning: one commit that marks it retired and keeps its file.
  say(`6. The maintainer withdraws the rule: retire ${out.ruleId ?? 'it'}`);
  if (out.ruleId) {
    const touched = await repo.log({ ref: 'main', path: `learnings/${out.ruleId}.md` });
    if (touched.length > 1) say(`   a git revert of ${short(touched.at(-1).sha)}, the commit that added it, would conflict: ${short(touched[0].sha)} changed the entry since (its uses)`);
    out.retire = await retireLearning({ repo, id: out.ruleId, reason: 'the maintainer withdrew the rule', secrets: vault });
    say(`   main ${short(out.retire.main)} retires it: learnings/${out.ruleId}.md stays on main with status retired, and history keeps every version`);
  }
  const c3 = await curateNow({ repo, judge, secrets: vault });
  out.curate3 = c3;
  say(`   curate again: ${c3.runs.length ? `${c3.runs.length} run(s) curated` : 'nothing to curate, the rule does not come back'}; main stays ${short(c3.main)}`);
  say();

  const run3 = await prepareRun({ home, repo, host: HOST, runId: 'run-3', input: ISSUES.second.input });
  const r3 = await runOnce(run3, [ISSUES.second.text], modelFor([{}]), vault, ISSUES.second.values);
  const f3 = await finishRun({ home, repo, run: run3, secrets: vault, caseValues: ISSUES.second.values });
  out.run3 = { run: run3, ...r3, ...f3 };
  say(`7. Run 3 starts at main ${short(run3.sha)}. ${r3.fromRequest ? 'Its first model request carries' : 'Its <learned> section'}:`);
  for (const line of r3.learned) say(`     ${line}`);
  say(`   ${run3.workflows.loaded.map((w) => `${w.name} ${w.sha256.slice(0, 12)}`).join(', ') || 'no workflow'} is in the run's own workflow store for the agentrun tool to load`);
  say(`   same issue as run 2${live ? '' : '; this scripted run does not try the workflow'}; answer: ${r3.answer}`);
  say();

  // A run that tries to learn a secret proposes nothing. Always scripted: it plants the value on purpose.
  const run4 = await prepareRun({ home, repo, host: HOST, runId: 'run-4', input: ISSUES.first.input });
  const r4 = await runOnce(run4, [ISSUES.first.text], scriptedModel([
    { call: 'learn', args: { type: 'fact', text: `The tracker's deploy token is ${vault[0]}; use it to post labels.` } },
    {},
  ]), vault, ISSUES.first.values);
  const f4 = await finishRun({ home, repo, run: run4, secrets: vault, caseValues: ISSUES.first.values });
  const needles = [vault[0], Buffer.from(vault[0]).toString('base64'), Buffer.from(vault[0]).toString('hex')].map((s) => Buffer.from(s));
  const gitDir = existsSync(join(repo.dir, '.git')) ? join(repo.dir, '.git') : repo.dir;
  const scan = [objectsHolding(bare, needles), objectsHolding(gitDir, needles)];
  out.run4 = { run: run4, ...r4, ...f4, scan };
  say('8. Run 4 tries to learn a value the host holds as a secret');
  for (const [i, call] of r4.calls.entries()) say(`   learn(${call.arguments.type}) -> ${r4.results[i] ?? '(no result)'}`);
  say(`   proposed ${f4.proposal.status === 'empty' ? 'nothing' : proposalStatus(f4.proposal)}; the secret (raw, base64 or hex) is in ${scan[0].holding + scan[1].holding} of ${scan[0].count + scan[1].count} git objects (remote and host repository)`);
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
    if (dir) console.log(`\nkept in ${out.root}: git --git-dir ${out.bare} log --all`);
    else await rm(out.root, { recursive: true, force: true });
  } catch (error) {
    console.error(`demo failed: ${error.stack ?? error}`);
    process.exit(1);
  }
}
