// The reference host loop for an agent that learns in its own git repository. The host owns git and the run's store; the
// model gets `learn` and the DSL's `agentrun` tool, never git. Three steps: prepareRun before a run, finishRun after it,
// curateNow when the host decides. Everything here is a public export of @parcha/pi-git-remote, @parcha/pi-agent-learn,
// @parcha/pi-durable-agent or pi-durable.
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createSession } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import {
  collectUses, collectWorkflows, currentRevision, curate, LAYOUT, LearnError, proposeLearning, readTrial, seedLearning, seedWorkflows,
  usesSettler, workflowAdmitter, workflowsToTry,
} from '@parcha/pi-agent-learn';
import {
  AGENT_STORE_FILE, AgentHomeError, carryBack, createAgentHome, openAgentHome, readAgentHome, refreshAgentHome, startRun,
} from '@parcha/pi-durable-agent';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const SKILLS = `${LAYOUT.skills}/`;

// A learned workflow skill reaches a run only while its trial.json has a live revision (trial or active).
export async function readAgentAt(repo, sha) {
  const json = await repo.read(LAYOUT.definition, sha);
  if (json === undefined) throw new Error(`the agent repository has no ${LAYOUT.definition} at ${sha}`);
  const definition = JSON.parse(json);
  const rules = (await repo.read(LAYOUT.rules, sha)) ?? '';
  const byName = new Map();
  for (const entry of await repo.list(LAYOUT.skills, sha)) {
    if (entry.type !== 'blob' || !entry.path.startsWith(SKILLS)) continue;
    const file = entry.path.slice(SKILLS.length);
    const name = file.split('/')[0];
    byName.set(name, [...(byName.get(name) ?? []), file]);
  }
  const skills = {};
  for (const [name, files] of byName) {
    const trial = `${name}/trial.json`;
    if (files.includes(trial) && !(await isLive(repo, name, sha))) continue;
    for (const file of files) if (file !== trial) skills[file] = await repo.read(`${SKILLS}${file}`, sha);
  }
  return { definition, rules, skills };
}

async function isLive(repo, name, sha) {
  try {
    const trial = await readTrial(repo, name, sha);
    return Boolean(trial && currentRevision(trial));
  } catch (error) {
    if (error instanceof LearnError) return false;
    throw error;
  }
}

// Owner-only: the home's stores hold the agent's sign-ins.
export async function agentHomeFor({ dir, repo }) {
  if (existsSync(join(dir, AGENT_STORE_FILE))) return openAgentHome(dir);
  await repo.fetch();
  const sha = await repo.resolve('main');
  if (!sha) throw new Error('the agent repository has no main');
  const { definition, skills } = await readAgentAt(repo, sha);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return createAgentHome(dir, { definition, skills, sha });
}

async function inRunStore(run, step) {
  const session = createSession(await openNodeSqliteStorage(run.storePath));
  try {
    return await step(session);
  } finally {
    await session.close(ctx);
  }
}

// The home's cache, the run, its <learned> section and the workflows it tries all come from one sha. The refresh is a
// compare-and-swap from the sha the home holds, and a home already past `ref` is kept: the cache never moves back.
export async function prepareRun({ home, repo, host, runId, input, ref = 'main' }) {
  for (let attempt = 0; ; attempt++) {
    await repo.fetch();
    const fetched = await repo.resolve(ref);
    if (!fetched) throw new Error(`the agent repository has no ${ref}`);
    const cached = (await readAgentHome(home)).source?.sha ?? null;
    const ahead = cached !== null && cached !== fetched && (await repo.log({ ref: cached })).some((commit) => commit.sha === fetched);
    const sha = ahead ? cached : fetched;
    const { definition, rules, skills } = await readAgentAt(repo, sha);
    let run;
    try {
      await refreshAgentHome(home, { sha, from: cached, definition, skills });
      // Another host can move the home between the refresh and the start; startRun refuses before it creates anything.
      run = await startRun(home, { runId, host, sha });
    } catch (error) {
      if (error instanceof AgentHomeError && error.code === 'stale' && attempt < 2) continue;
      throw error;
    }
    const workflows = await workflowsToTry({ repo, sha }, input);
    const seeded = await inRunStore(run, (target) => seedLearning({ repo, ref: sha, target, into: run.workspace, workflows }));
    const tried = await seedWorkflows({ repo, sha, into: run.workspace, workflows });
    return { ...run, definition, rules, seeded, workflows: tried };
  }
}

// Call after the run's Harness has closed. The workflows the run saved and the trials it used go with its notes; any
// guard hit refuses the whole proposal, and main never moves here.
export async function finishRun({ home, repo, run, secrets = [], caseValues = [], outcome = 'completed' }) {
  const carried = await carryBack(home, run, { outcome });
  const saved = await collectWorkflows({ repo, workDir: run.workspace, seedSha: run.sha });
  const uses = await collectUses({ store: run.storePath, workDir: run.workspace, run: run.runId });
  const proposal = await inRunStore(run, (target) => proposeLearning({
    repo, runId: run.runId, target, secrets, caseValues, workflows: saved.records, ...(uses ? { uses: () => uses } : {}),
  }));
  return { carried, proposal, saved };
}

// The single writer of main. `judge` is the DSL's runJudge port; workflows are admitted as trials and their uses settled
// by the package's own ports.
export function curateNow({ repo, judge, secrets = [], tmpRoot, now }) {
  return curate({
    repo, judge, secrets, admitWorkflow: workflowAdmitter({ ...(tmpRoot ? { tmpRoot } : {}) }), settleUses: usesSettler({ ...(tmpRoot ? { tmpRoot } : {}) }),
    ...(now ? { now } : {}),
  });
}

// One curate commit per run: reverting it takes out everything that run added. Curation never brings it back, because
// its run is already named on main. retireLearning takes out one learning, also after a later run used it.
export async function revertLearning({ repo, id }) {
  await repo.fetch();
  const added = (await repo.log({ ref: 'main', trailer: { key: 'Learning-Id', value: id } })).at(-1);
  if (!added) throw new Error(`no commit on main carries Learning-Id: ${id}`);
  const reverted = await repo.revert(added.sha, 'main', { trailers: { 'Reverts-Learning': id } });
  if (reverted.changed) await repo.push(reverted.sha, 'main');
  return { reverted: added.sha, sha: reverted.sha, changed: reverted.changed };
}
