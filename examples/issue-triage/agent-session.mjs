#!/usr/bin/env node
// The issue-triage demo as an interactive session: an agent in a pi-durable-agent home drafts, inspects, dry-runs, saves and runs the workflow with the agentrun tool
// (createWorkflowTool), tells the learn tool when to use it, and after the run the host proposes what it learned and curates it; a second run is then seeded with the saved workflow.
//   node examples/issue-triage/agent-session.mjs [--dir <empty dir to keep>]
// Everything is scripted ($0, no key, no network): the author model's turns, the GitHub tools (the synthetic fixtures), the research node and Jev's judge. The host loop is
// examples/agent-learn/host.mjs's; the only addition is that a saved workflow rides along with the proposal (collectWorkflows) and the curator admits it (workflowAdmitter).
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, createSession, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { compileTransform } from '@parcha/agentrun-dsl';
import { workspaceFiles } from '@parcha/agentrun-dsl/recovery';
import { createWorkflowTool } from '@parcha/agentrun-pi/durable';
import { agentLearn, collectWorkflows, curate, guard, proposeLearning, schemaWhen, seedWorkflows, workflowAdmitter, workflowsToTry } from '@parcha/pi-agent-learn';
import { carryBack } from '@parcha/pi-durable-agent';
import { local, openRepo } from '@parcha/pi-git-remote';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { agentHomeFor, prepareRun } from '../agent-learn/host.mjs';
import { fakes, job } from './job.ts';

const HERE = import.meta.dirname;
const HOST = 'issue-triage-session';
const WORKFLOW = JSON.parse(await readFile(join(HERE, 'workflow.json'), 'utf8'));
const FIXTURES = JSON.parse(await readFile(join(HERE, 'fixtures.json'), 'utf8'));
const NAME = 'issue-triage';
const INPUT = { ...job.input };
export const WHEN = 'Use when asked to triage a batch of a repository\'s open issues: it takes a repository, issue numbers and the maintainers\' type labels, researches each issue, gives it a type (bug, feature, docs, question), judges good first issue and actionable, and returns a table with how often the type matched the maintainers\'.';

// The text a user says to the agent: the quoted prompt of AUTHOR-PROMPT.md, as one message.
export async function authorPrompt() {
  const text = await readFile(join(HERE, 'AUTHOR-PROMPT.md'), 'utf8');
  return text.split('\n').filter((line) => line.startsWith('>')).map((line) => line.replace(/^> ?/, '')).join('\n').trim();
}

// ---- the scripted parts -------------------------------------------------------------------------------------------------------------

const TOOLS = [
  ...['github_issue', 'github_linked_prs', 'github_code', 'github_labels'].map((name) => ({
    name, description: `Read-only GitHub: ${name.replace('github_', '').replace('_', ' ')} of an issue.`,
    parameters: { type: 'object', additionalProperties: false, required: ['repo', 'number'], properties: { repo: { type: 'string' }, number: { type: 'integer' } } },
  })),
  // The research node's own read-only tools: an agent node's tools are registered by the host too.
  ...['read', 'grep', 'find', 'ls'].map((name) => ({ name, description: `Read-only: ${name} in the run's workspace.`, parameters: { type: 'object', additionalProperties: true, properties: { path: { type: 'string' } } } })),
];
const call = (name, args) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });

/** The author model's turns: describe, inspect the draft, dry-run it, save it, learn when to use it, run it, and say what happened. */
const authorTurns = (say) => [
  call('agentrun', { action: 'describe' }),
  call('agentrun', { action: 'inspect', workflow: WORKFLOW }),
  call('agentrun', { action: 'dry-run' }),
  call('agentrun', { action: 'save', name: NAME }),
  call('learn', { type: 'workflow', id: NAME, text: WHEN }),
  call('agentrun', { action: 'run', input: INPUT }),
  fauxAssistantMessage([fauxText(say)], { stopReason: 'stop' }),
];
/** A later run opens with the saved workflow already in its store: load it, run it. */
const reuseTurns = (say) => [
  call('agentrun', { action: 'load', name: NAME }),
  call('agentrun', { action: 'run', input: INPUT }),
  fauxAssistantMessage([fauxText(say)], { stopReason: 'stop' }),
];

const issueOf = (user) => job.input.numbers.includes(Number(/"number"\s*:\s*(\d+)/.exec(user)?.[1])) ? Number(/"number"\s*:\s*(\d+)/.exec(user)[1]) : undefined;

/** What the run's task is made of: the synthetic GitHub tools through the fakes, Jev's scripted judge, and a scripted research node (a quotation from the issue). */
function taskAdapters(place, counts) {
  const byNumber = new Map(FIXTURES.issues.map((issue) => [issue.number, issue]));
  return {
    runEffect: async ({ node, input }) => { counts.tools[node.tool] = (counts.tools[node.tool] ?? 0) + 1; return fakes.tools[node.tool](input, { place }); },
    runJudge: async (request) => { counts.judge += 1; return fakes.judge(request); },
    runNode: async ({ user }) => {
      counts.research += 1;
      const issue = byNumber.get(issueOf(user));
      const quote = (text) => text.replace(/\s+/g, ' ').trim().slice(0, 200);
      return { summary: `${issue.title}. ${quote(issue.body).slice(0, 160)}`, reproduces: 'not stated', code_paths: [], evidence: [{ source: 'issue', quote: quote(issue.body) }] };
    },
  };
}

// ---- one session ---------------------------------------------------------------------------------------------------------------------

async function runSession({ run, turns, prompt, vault, counts }) {
  const faux = fauxProvider();
  const requests = [];
  faux.setResponses(turns.map((turn) => async (context) => { requests.push(context); return turn; }));
  const models = createModels();
  models.setProvider(faux.provider);
  const place = { root: run.workspace, work: run.workspace };
  const tool = createWorkflowTool({
    projectDir: run.workspace, tools: TOOLS,
    task: { options: () => ({ files: workspaceFiles(run.workspace) }), run: () => ({ adapters: taskAdapters(place, counts) }) },
    runCode: async (node, state, at) => compileTransform(node.code)(state, { sop: at.sop }),
  });
  const registry = createRegistry();
  registry.install(tool.extension);
  const learn = agentLearn({ guard, secrets: () => vault });
  registry.install(learn);
  const harness = await Harness.open(await openNodeSqliteStorage(run.storePath), { models, registry, onReport: () => {} }, ctx);
  try {
    const root = await harness.root(ctx, { agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id }, instructions: `${run.definition.instructions}\n\n${run.rules.trim()}`, extensions: [tool.extension, learn] } });
    await (await root.submit({ type: 'input', content: prompt }, ctx)).wait(ctx);
    const { messages } = await root.context(ctx);
    const text = (content) => (typeof content === 'string' ? content : (content ?? []).map((part) => part.text ?? '').join(''));
    const calls = messages.filter((m) => m.role === 'assistant').flatMap((m) => m.content.filter((c) => c.type === 'toolCall')).map((c) => ({ name: c.name, action: c.arguments.action, type: c.arguments.type }));
    const results = messages.filter((m) => m.role === 'toolResult').map((m) => ({ tool: m.toolName, isError: m.isError === true, text: text(m.content) }));
    return { calls, results, answer: text(messages.findLast((m) => m.role === 'assistant')?.content).trim(), requests };
  } finally { await harness.close(ctx); }
}

/** The host's step after a run (host.mjs's finishRun, plus the workflows the run saved): carry the run back to the home, collect what it saved, propose. */
async function finishRun({ home, repo, run, secrets, outcome = 'completed' }) {
  const carried = await carryBack(home, run, { outcome });
  const session = createSession(await openNodeSqliteStorage(run.storePath));
  try {
    const collected = await collectWorkflows({ repo, workDir: run.workspace, target: session });
    const proposal = await proposeLearning({ repo, runId: run.runId, target: session, secrets, caseValues: [], workflows: collected.records });
    return { carried, collected, proposal };
  } finally { await session.close(ctx); }
}

// ---- the story -------------------------------------------------------------------------------------------------------------------------

const gitEnv = (home) => ({ PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', HOME: home });
const short = (sha) => sha.slice(0, 7);

export async function runSessionDemo({ dir, log = () => {} } = {}) {
  const root = dir ? resolve(dir) : await mkdtemp(join(tmpdir(), 'issue-triage-session-'));
  await mkdir(root, { recursive: true });
  await chmod(root, 0o755);
  const bare = join(root, 'agent.git');
  execFileSync('git', ['init', '-q', '--bare', '--template=', '-b', 'main', bare], { env: gitEnv(root) });
  const repo = await openRepo({ dir: join(root, 'host-repo'), remote: local(bare) });
  const vault = [`session-vault-${randomBytes(16).toString('hex')}`];
  const out = { root, bare, vault };
  const prompt = await authorPrompt();

  const seed = await repo.commitTo('main', { files: { 'agent.json': await readFile(join(HERE, 'agent/agent.json'), 'utf8'), 'AGENTS.md': await readFile(join(HERE, 'agent/AGENTS.md'), 'utf8') }, message: 'the agent: definition and rules' });
  await repo.push(seed.sha, 'main');
  const home = await agentHomeFor({ dir: join(root, 'home'), repo });
  log(`1. The agent home follows its repository at main ${short(seed.sha)}`);

  // Run 1: the user's prompt goes in; the agent authors, saves, learns and runs.
  const counts1 = { tools: {}, judge: 0, research: 0 };
  const run1 = await prepareRun({ home, repo, host: HOST, runId: 'run-1' });
  const s1 = await runSession({ run: run1, turns: authorTurns('The workflow ran: the table and the type agreement are in its result.'), prompt, vault, counts: counts1 });
  const f1 = await finishRun({ home, repo, run: run1, secrets: vault });
  out.run1 = { run: run1, counts: counts1, ...s1, ...f1 };
  log(`2. Run 1 (${run1.runId}): the agent called ${s1.calls.map((c) => c.action ? `${c.name} ${c.action}` : `${c.name}${c.type ? ` ${c.type}` : ''}`).join(', ')}`);
  log(`   the run: ${counts1.research} research nodes, ${counts1.judge} Jev requests, ${Object.values(counts1.tools).reduce((a, b) => a + b, 0)} GitHub tool calls`);
  log(`   the host collected ${f1.collected.found.map((w) => `${w.name}@${short(w.sha256)}`).join(', ') || 'no workflow'}; proposal: ${f1.proposal.status}${f1.proposal.sha ? ` at ${short(f1.proposal.sha)}` : ''}; main has not moved`);

  // Curation: the single writer of main, with the workflow lane (it admits the saved workflow as a trial).
  const asked = [];
  const judge = async ({ questions }) => ({ answers: Object.fromEntries(Object.keys(questions).map((key) => { asked.push(key); return [key, { type: 'noul', noul: key === 'general' ? 0.94 : 0.03 }]; })), model: 'scripted', usage: null, cost_usd: null });
  // host.mjs's curateNow takes no workflow lane (it forwards repo, judge, secrets and now only), so the host calls curate itself.
  const curated = await curate({ repo, judge, secrets: vault, admitWorkflow: workflowAdmitter({ when: schemaWhen, allowExecutableCode: true }) });
  out.curated = curated;
  out.asked = asked;
  log(`3. Curate: ${curated.runs.map((r) => `${r.run}: ${r.accepted.length} accepted, ${r.refused.length} refused, ${r.held.length} held`).join('; ')}; main ${short(curated.main)}`);

  // Run 2: seeded with the saved workflow, which the agent loads by name.
  await repo.fetch();
  const sha = await repo.resolve('main');
  const hints = await workflowsToTry({ repo, sha }, INPUT);
  const counts2 = { tools: {}, judge: 0, research: 0 };
  const run2 = await prepareRun({ home, repo, host: HOST, runId: 'run-2', workflows: hints });
  const seeded = await seedWorkflows({ repo, sha: run2.sha, into: run2.workspace, workflows: hints });
  const s2 = await runSession({ run: run2, turns: reuseTurns('Loaded the saved workflow and ran it.'), prompt: 'Triage the same repository again.', vault, counts: counts2 });
  const f2 = await finishRun({ home, repo, run: run2, secrets: vault });
  out.run2 = { run: run2, counts: counts2, hints, seeded, ...s2, ...f2 };
  log(`4. Run 2 (${run2.runId}) starts at main ${short(run2.sha)} with ${hints.length ? hints.map((h) => `${h.name} (${h.status})`).join(', ') : 'no workflow'} in its store; the agent called ${s2.calls.map((c) => `${c.name} ${c.action ?? ''}`.trim()).join(', ')}`);
  log(`   the run: ${counts2.research} research nodes, ${counts2.judge} Jev requests; proposed ${f2.proposal.status}`);
  out.log = execFileSync('git', ['--git-dir', bare, 'log', '--oneline', 'main'], { env: gitEnv(root), encoding: 'utf8' }).trimEnd();
  log('git log --oneline main'); for (const line of out.log.split('\n')) log(`  ${line}`);
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--dir');
  const dir = at >= 0 ? args[at + 1] : undefined;
  if (args.some((arg, i) => !(arg === '--dir' || (at >= 0 && i === at + 1))) || (at >= 0 && !dir)) { console.error('usage: node examples/issue-triage/agent-session.mjs [--dir <empty dir to keep>]'); process.exit(2); }
  try {
    const out = await runSessionDemo({ dir, log: (line) => console.log(line) });
    if (dir) console.log(`\nkept in ${out.root}`); else await rm(out.root, { recursive: true, force: true });
  } catch (error) { console.error(`session failed: ${error.stack ?? error}`); process.exit(1); }
}
