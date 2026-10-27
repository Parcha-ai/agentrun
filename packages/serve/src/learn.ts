// Learning. An agentic revision that lists `learn` gives its runs @parcha/pi-agent-learn's tool, which notes each lesson
// in the run's own store. Once a run has completed and its process has let go of that store, `POST /agents/{id}/learn`
// reads the lessons from it, guards them, and commits the agent's next revision: the current one with each lesson as a
// skill, `learned-<12 hex>/SKILL.md`, or with `dry_run` shows that revision's new files and commits nothing. A run is not
// seeded: what earlier runs learned reaches it as those skills.
import { join } from "node:path";
import type { Extension } from "@earendil-works/pi-durable";
import { type AgentEntry, type Agents, definitionOf } from "./agents.js";
import { ApiError, invalid } from "./errors.js";
import { readJson, RUN_META } from "./files.js";
import type { Run, Runs } from "./runs.js";
import { isObject } from "./validate.js";

export const LEARN_TOOL = "learn";
/** The prefix of the skills that hold what an agent's runs learned: `learned-<12 hex>/SKILL.md`. */
export const LEARNED = "learned";
/** The variables whose values are this host's secrets, which no learning may hold. */
const SECRET_NAME = /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD)$/i;
/** A value under 8 characters is not checked: it is a placeholder or no secret (a gateway's `AGENT_MODEL_API_KEY=none`),
 *  checking it would refuse ordinary words such as "none", and the guard refuses every write while it is given one. 8 is
 *  pi-browser's redaction floor too. */
const MIN_SECRET = 8;

/** The values of `env`'s keys, tokens, secrets and passwords, and `more`. */
export const secretsOf = (env: NodeJS.ProcessEnv, more: readonly string[] = []): string[] =>
  [...new Set([...Object.entries(env).filter(([name]) => SECRET_NAME.test(name)).map(([, value]) => value ?? ""), ...more])].filter((value) => value.replace(/\s+/g, "").length >= MIN_SECRET);

/** The run's input values: a learning states the rule, and never repeats the case. */
const caseValuesOf = (input: unknown): string[] => (isObject(input) ? Object.values(input).filter((value): value is string => typeof value === "string") : []);

/** The learn extension for the run in `root`: each call is guarded with the secrets of the run's environment `env` and
 *  the run's input, so a refused note is refused where the model can restate it. */
export async function learnExtension(root: string, env: NodeJS.ProcessEnv): Promise<Extension> {
  const [{ agentLearn, guard }, meta] = await Promise.all([import("@parcha/pi-agent-learn"), readJson(join(root, RUN_META))]);
  const caseValues = caseValuesOf(meta?.input);
  return agentLearn({ guard, secrets: () => secretsOf(env), caseValues: () => caseValues }) as unknown as Extension;
}

const notLearnable = (message: string) => new ApiError("not_learnable", message);

/** What Learn answers: a dry run's preview (the files a commit would add, whole, and the revision it would build on), or
 *  the committed revision. */
export type Learned = { preview: { learned: { path: string; text: string }[]; base: string } } | { entry: AgentEntry; note: string; learned: string[] };

/** What `run` learned, as the next revision of `entry`'s agent: its current revision plus a skill per lesson it has not
 *  got yet, made current. `secrets` are the server's: the guard refuses a lesson that holds one. A dry run checks it all
 *  and commits nothing; `base`, the revision a preview built on, must still be current, so a commit is what was shown. */
export async function learnFrom(agents: Agents, runs: Runs, entry: AgentEntry, run: Run, secrets: readonly string[], { dryRun = false, base }: { dryRun?: boolean; base?: string } = {}): Promise<Learned> {
  const { agent, revision: current } = entry;
  if (run.agentId !== agent.id) throw notLearnable(`the run ${run.id} is a run of the agent ${run.agentId}, not of ${agent.id}`);
  const ran = agents.store.readRevision(run.revision);
  if (ran.kind !== "agentic" || !ran.body.tools.includes(LEARN_TOOL)) throw notLearnable(`the run ${run.id} ran a revision that does not list the learn tool`);
  const { status, final } = runs.ended(run);
  if (!final) throw notLearnable(`the run ${run.id} is not final: it is ${status}`);
  if (status !== "completed") throw notLearnable(`the run ${run.id} is ${status}: only a completed run is learned from`);
  if (base !== undefined && current?.id !== base) throw new ApiError("precondition_failed", `the agent's current revision moved since the preview at ${base}: preview again`);
  const { ENTRY_TYPES, guard, learningId, readCandidates } = await import("@parcha/pi-agent-learn");
  // A `used` mark needs a seed and a `workflow` note a saved workflow, and a run here has neither.
  const lessons = readCandidates(runs.storeFile(run)).filter((candidate) => (ENTRY_TYPES as readonly string[]).includes(candidate.type) && candidate.text.trim() !== "");
  if (!lessons.length) throw notLearnable("the run learned nothing");
  const refusals = guard({ role: "run", runId: run.id, candidates: lessons, secrets, caseValues: caseValuesOf(run.meta.input) });
  if (refusals.length) {
    throw invalid(refusals.map((r) => ({ field: r.field ?? "run_id", reason: r.reason, message: r.detail })), `the guard refused what the run ${run.id} learned: ${[...new Set(refusals.map((r) => r.reason))].join(", ")}`);
  }
  if (current?.kind !== "agentic") throw notLearnable(`the agent ${agent.id} has no agentic revision current to learn into`);
  const held = agents.skillFiles(current);
  const files: Record<string, string> = {};
  for (const lesson of lessons) {
    // pi's skill-name rule (lowercase words and hyphens), so a home exported to pi keeps the name.
    const path = `${LEARNED}-${learningId(run.id, lesson.text).slice("L-".length)}/SKILL.md`;
    if (!(path in held)) files[path] = `A ${lesson.type} learned in run ${run.id}:\n\n${lesson.text.trim()}\n`;
  }
  const learned = Object.keys(files).sort();
  if (!learned.length) throw notLearnable(`the agent's current revision holds what the run ${run.id} learned already`);
  if (dryRun) return { preview: { learned: learned.map((path) => ({ path, text: files[path]! })), base: current.id } };
  const { version: _, ...definition } = definitionOf(agent, current, entry.version);
  const note = `learned from run ${run.id}`;
  const skills = { ...held, ...files };
  const committed = await agents.commit(entry, { definition: { ...definition, skills: [...(definition.skills as string[]), ...learned.map((path) => path.slice(0, -"/SKILL.md".length))] }, skills, note }, { ifCurrent: current.id });
  return { entry: committed, note, learned };
}
