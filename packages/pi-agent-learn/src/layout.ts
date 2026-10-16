import { LearnError } from "./errors.js";

/**
 * The rules tier: the agent's definition and its standing rules. No learning, run, curator or option writes them, at any
 * depth, in any spelling. A frozen array, not a Set: `Object.freeze` does not stop `Set.prototype.add`.
 */
export const RULES_LOCKED: readonly string[] = Object.freeze(["agent.json", "AGENTS.md"]);

/** Where things live in the agent repository, and in a run's working directory. */
export const LAYOUT = Object.freeze({
  /** Rules tier: the agent definition. */
  definition: "agent.json",
  /** Rules tier: the standing rules. */
  rules: "AGENTS.md",
  /** Learned tier: one file per learning, `learnings/<id>.md`. */
  learnings: "learnings",
  /** Learned tier: skills, `.agents/skills/<name>/SKILL.md`. */
  skills: ".agents/skills",
  /** Learned tier: the DSL's saved workflows, in its own project layout. */
  workflows: ".pi/agentrun/workflows",
  /** A run's candidates, `inbox/<run id>.md`, on its own branch only. */
  inbox: "inbox",
  /** A run's workflow uses, `uses/<run id>.json`, on its own branch only. */
  uses: "uses",
  /** Under a run's working directory: the learnings it was seeded with, for reading. Never committed. */
  seeded: ".agent/learnings",
});

/** Byte caps (UTF-8). Over a cap is refused, never truncated. */
export const CAPS = Object.freeze({
  /** One `learn` call's text. */
  text: 1000,
  /** One `learn` call's evidence, all items together. */
  evidence: 1000,
  evidenceItems: 8,
  /** New learnings (lesson, fact, correction) one run may note. */
  perRun: 8,
  /** `used` marks one run may note. */
  usedPerRun: 32,
  inbox: 16_384,
  /** One learning file. */
  learning: 4096,
  /** The `<learned>` section the model sees. */
  section: 4096,
  file: 32_768,
  files: 32,
});

export const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const LEARNING_ID = /^L-[0-9a-f]{12}$/;
/** A commit id: SHA-1 or SHA-256. */
export const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export type Tier = "rules" | "learned" | "run" | "other";

const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;

function spellings(segment: string): string[] {
  const bare = segment.replace(IGNORABLE, "");
  const out = new Set<string>();
  for (const form of [bare, bare.normalize("NFKC")]) {
    for (const cased of [form.toLowerCase(), form.toUpperCase().toLowerCase()]) out.add(cased.split(":")[0]!.replace(/[. ]+$/, ""));
  }
  return [...out];
}

const LOCKED = RULES_LOCKED.map((name) => name.toLowerCase());
const SHORT_NAMES = [/^agent~\d+\.jso$/, /^agents~\d+\.md$/];

/** True when any segment of `path` names a rules-tier file: any case, Unicode compatibility form, ignorable characters,
 *  trailing dots or spaces, an NTFS stream suffix or an 8.3 short name, with `/` or `\` as the separator. */
export function isRulesLocked(path: string): boolean {
  if (typeof path !== "string") return false;
  return path.split(/[\\/]/).some((segment) => spellings(segment).some((name) => LOCKED.includes(name) || SHORT_NAMES.some((short) => short.test(name))));
}

/** Throws `rules_locked` when any of `paths` names a rules-tier file. Every writer calls it before it writes. */
export function assertNotRulesLocked(paths: Iterable<string>): void {
  for (const path of paths) {
    if (isRulesLocked(path)) throw new LearnError("rules_locked", `${JSON.stringify(path)} is in the rules tier (${RULES_LOCKED.join(", ")}): nothing that learns writes it`);
  }
}

/** Which tier a repository path belongs to. */
export function tierOf(path: string): Tier {
  if (isRulesLocked(path)) return "rules";
  if ([LAYOUT.learnings, LAYOUT.skills, LAYOUT.workflows].some((dir) => path.startsWith(`${dir}/`))) return "learned";
  if ([LAYOUT.inbox, LAYOUT.uses].some((dir) => path.startsWith(`${dir}/`))) return "run";
  return "other";
}

function runId(id: string): string {
  if (typeof id !== "string" || !RUN_ID.test(id)) throw new LearnError("invalid", "a run id is 1 to 128 letters, digits, dots, dashes or underscores, starting with a letter or digit");
  return id;
}

export const runBranch = (id: string): string => `runs/${runId(id)}`;
export const inboxPath = (id: string): string => `${LAYOUT.inbox}/${runId(id)}.md`;
export const usesPath = (id: string): string => `${LAYOUT.uses}/${runId(id)}.json`;
export function learningPath(id: string): string {
  if (typeof id !== "string" || !LEARNING_ID.test(id)) throw new LearnError("invalid", "a learning id is L- and 12 lowercase hex digits");
  return `${LAYOUT.learnings}/${id}.md`;
}
