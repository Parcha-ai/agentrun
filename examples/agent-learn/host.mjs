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

/** The agent at one commit of its repository: `agent.json`, the text of `AGENTS.md`, and the skill files a run gets
 *  (path under `.agents/skills/` to text). A learned workflow skill whose `trial.json` says demoted is left out. */
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

/** The agent home in `dir`: opened when it is there, else made from the repository's main, owner-only (its stores hold
 *  the agent's sign-ins). */
export async function agentHomeFor({ dir, repo }) {
  if (existsSync(join(dir, AGENT_STORE_FILE))) return openAgentHome(dir);
  await repo.fetch();
  const sha = await repo.resolve('main');
  if (!sha) throw new Error('the agent repository has no main');
  const { definition, skills } = await readAgentAt(repo, sha);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return createAgentHome(dir, { definition, skills, sha });
}

/** A run's pi-durable store, opened as a session for one host step and closed after it. */
async function inRunStore(run, step) {
  const session = createSession(await openNodeSqliteStorage(run.storePath));
  try {
    return await step(session);
  } finally {
    await session.close(ctx);
  }
}

/**
 * Before a run: fetch `ref`, read the definition and skill set at its sha, move the home's cache there, start the run
 * at that sha, and seed the run's `<learned>` section from the same sha. The refresh is a compare-and-swap from the sha
 * the home holds, and a home already past `ref` (another host refreshed it to a newer main) is kept, never moved back.
 * Returns the started run (`runId`, `storePath`, `workspace`, `sha`), its definition, the rules text and the seed.
 */
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

/**
 * After a run's Harness has closed: carry the run back into the home, then propose what it noted on `runs/<run id>`,
 * guarded against the host's secrets and the run's input values, committed by plumbing and pushed by sha. Any guard hit
 * refuses the whole proposal. Main does not move: only curation writes main.
 */
export async function finishRun({ home, repo, run, secrets = [], caseValues = [], outcome = 'completed' }) {
  const carried = await carryBack(home, run, { outcome });
  const proposal = await inRunStore(run, (target) => proposeLearning({ repo, runId: run.runId, target, secrets, caseValues }));
  return { carried, proposal };
}

/** Curation, the single writer of main: every uncurated `runs/<id>` branch is guarded again, judged, and merged as one
 *  commit per run, with no human step. `judge` is the DSL's `runJudge` port; `createJevRunner()` of
 *  @parcha/agentrun-jev is one. */
export function curateNow({ repo, judge, secrets = [], now }) {
  return curate({ repo, judge, secrets, ...(now ? { now } : {}) });
}

/** Undo a learning: revert, on main, the curate commit that added it, and push. History keeps it, and curation never
 *  brings it back, because its run is already named on main. */
export async function revertLearning({ repo, id }) {
  await repo.fetch();
  const added = (await repo.log({ ref: 'main', trailer: { key: 'Learning-Id', value: id } })).at(-1);
  if (!added) throw new Error(`no commit on main carries Learning-Id: ${id}`);
  const reverted = await repo.revert(added.sha, 'main', { trailers: { 'Reverts-Learning': id } });
  if (reverted.changed) await repo.push(reverted.sha, 'main');
  return { reverted: added.sha, sha: reverted.sha, changed: reverted.changed };
}
