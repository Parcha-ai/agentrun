// The web example's agent home: made once from this directory's agent.json and skills/<name>/SKILL.md, then opened as it
// is. The home's directory is created owner-only first, since its stores hold the agent's sign-ins.
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AGENT_STORE_FILE, createAgentHome, openAgentHome } from '@parcha/pi-durable-agent';

/** The definition and skill files the home is made from: `agent.json`, and each named skill's `skills/<name>/SKILL.md`. */
export async function agentFiles(agentDir = import.meta.dirname) {
  const definition = JSON.parse(await readFile(join(agentDir, 'agent.json'), 'utf8'));
  const skills = {};
  for (const name of definition.skills ?? []) skills[`${name}/SKILL.md`] = await readFile(join(agentDir, 'skills', name, 'SKILL.md'), 'utf8');
  return { definition, skills };
}

/** The agent home in `dir`, made from `agentDir` when there is none yet. */
export async function ensureAgentHome(dir, agentDir = import.meta.dirname) {
  const at = resolve(dir);
  if (existsSync(join(at, AGENT_STORE_FILE))) return openAgentHome(at);
  await mkdir(at, { recursive: true, mode: 0o700 });
  return createAgentHome(at, await agentFiles(agentDir));
}
