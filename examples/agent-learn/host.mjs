// The reference host loop for an agent that learns in its own git repository. The host owns git and the run's store;
// the model only ever gets the `learn` tool. Three steps: prepareRun before a run, finishRun after it, curateNow when the
// host decides (after each run, or on a schedule). Everything here is a public export of @parcha/pi-git-remote,
// @parcha/pi-agent-learn, @parcha/pi-durable-agent or pi-durable.
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createSession } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { curate, LAYOUT, proposeLearning, seedLearning } from '@parcha/pi-agent-learn';
import {
  AGENT_STORE_FILE, AgentHomeError, carryBack, createAgentHome, openAgentHome, readAgentHome, refreshAgentHome, startRun,
} from '@parcha/pi-durable-agent';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const SKILLS = `${LAYOUT.skills}/`;

// A learned skill whose trial.json says demoted (or does not parse) never reaches a run.
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
    if (files.includes(trial) && (await trialStatus(repo, `${SKILLS}${trial}`, sha)) === 'demoted') continue;
    for (const file of files) if (file !== trial) skills[file] = await repo.read(`${SKILLS}${file}`, sha);
  }
  return { definition, rules, skills };
}

async function trialStatus(repo, path, sha) {
  try {
    return JSON.parse((await repo.read(path, sha)) ?? '{}').status;
  } catch {
    return 'demoted';
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

// The home's cache, the run and its <learned> section all come from one sha. The refresh is a compare-and-swap from the
// sha the home holds, and a home already past `ref` is kept: the cache never moves back to an older main.
export async function prepareRun({ home, repo, host, runId, ref = 'main', workflows }) {
  for (let attempt = 0; ; attempt++) {
    await repo.fetch();
    const fetched = await repo.resolve(ref);
    if (!fetched) throw new Error(`the agent repository has no ${ref}`);
    const cached = (await readAgentHome(home)).source?.sha ?? null;
    const ahead = cached !== null && cached !== fetched && (await repo.log({ ref: cached })).some((commit) => commit.sha === fetched);
    const sha = ahead ? cached : fetched;
    const { definition, rules, skills } = await readAgentAt(repo, sha);
    try {
      await refreshAgentHome(home, { sha, from: cached, definition, skills });
    } catch (error) {
      if (error instanceof AgentHomeError && error.code === 'stale' && attempt < 2) continue;
      throw error;
    }
    const run = await startRun(home, { runId, host, sha });
    const seeded = await inRunStore(run, (target) => seedLearning({ repo, ref: sha, target, into: run.workspace, ...(workflows ? { workflows } : {}) }));
    return { ...run, definition, rules, seeded };
  }
}

// Call after the run's Harness has closed. Any guard hit refuses the whole proposal; main never moves here.
export async function finishRun({ home, repo, run, secrets = [], caseValues = [], outcome = 'completed' }) {
  const carried = await carryBack(home, run, { outcome });
  const proposal = await inRunStore(run, (target) => proposeLearning({ repo, runId: run.runId, target, secrets, caseValues }));
  return { carried, proposal };
}

// The single writer of main. `judge` is the DSL's runJudge port.
export function curateNow({ repo, judge, secrets = [], now }) {
  return curate({ repo, judge, secrets, ...(now ? { now } : {}) });
}

// Curation never brings a reverted learning back: its run is already named on main.
export async function revertLearning({ repo, id }) {
  await repo.fetch();
  const added = (await repo.log({ ref: 'main', trailer: { key: 'Learning-Id', value: id } })).at(-1);
  if (!added) throw new Error(`no commit on main carries Learning-Id: ${id}`);
  const reverted = await repo.revert(added.sha, 'main', { trailers: { 'Reverts-Learning': id } });
  if (reverted.changed) await repo.push(reverted.sha, 'main');
  return { reverted: added.sha, sha: reverted.sha, changed: reverted.changed };
}
