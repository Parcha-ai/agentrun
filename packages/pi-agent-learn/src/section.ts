import type { Learning } from "./entry.js";
import { LearnError } from "./errors.js";
import { CAPS, LAYOUT, WORKFLOW_NAME } from "./layout.js";

/** A saved workflow the host found for this run's input. The workflows lane fills these; none is the default. */
export type WorkflowHint = {
  readonly name: string;
  readonly status: "trial" | "active";
};

export const MAX_WORKFLOW_HINTS = 8;

/** What a run was seeded with, kept in its store: the commit, and the index derived there. */
export type SeedRecord = {
  readonly sha: string;
  /** The index lines the section shows, in order. */
  readonly index: readonly string[];
  /** Ids of active learnings that did not fit under the section cap. */
  readonly omitted: readonly string[];
  readonly workflows: readonly WorkflowHint[];
  /** Whether the learnings were copied into the run's working directory. */
  readonly copied: boolean;
};

const LINE_CHARS = 240;
const TAG = /<\s*\/?\s*learned\b/i;

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

/** One index line: id, type, the first line of the rule, and how often it helped. Undefined for a learning whose
 *  first line could close or open the section's tag. */
export function indexLine(learning: Learning): string | undefined {
  const first = learning.text.split("\n").find((line) => line.trim() !== "")!.trim();
  if (TAG.test(first)) return undefined;
  const chars = Array.from(first);
  const shown = chars.length > LINE_CHARS ? `${chars.slice(0, LINE_CHARS - 1).join("")}\u2026` : first;
  return `- ${learning.id} ${learning.type}: ${shown}${learning.uses > 0 ? ` (used ${learning.uses})` : ""}`;
}

/** Most used first, then by id: a fixed order for a fixed set of files. */
export function byUse(a: Learning, b: Learning): number {
  return b.uses - a.uses || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function checkWorkflows(workflows: readonly WorkflowHint[]): WorkflowHint[] {
  if (!Array.isArray(workflows)) throw new LearnError("invalid", "workflows is a list");
  if (workflows.length > MAX_WORKFLOW_HINTS) throw new LearnError("invalid", `at most ${MAX_WORKFLOW_HINTS} workflows to try`);
  return workflows.map((w) => {
    if (!w || typeof w.name !== "string" || !WORKFLOW_NAME.test(w.name)) throw new LearnError("invalid", "a workflow name is 1 to 64 lowercase letters, digits, dashes or underscores, starting with a letter or digit");
    if (w.status !== "trial" && w.status !== "active") throw new LearnError("invalid", "a workflow to try is trial or active");
    return { name: w.name, status: w.status };
  });
}

/**
 * The `<learned>` section body for a seed (pi-durable adds the tags). A pure function of the record, so the text is the
 * same on every request of a run and for every run seeded from the same commit with the same workflows. With
 * `canLearn` false (the agent is not offered `learn`) the lines that ask it to call `learn` are left out.
 */
export function renderSection(seed: SeedRecord, options: { readonly canLearn?: boolean } = {}): string {
  const lines = ["Your rules (AGENTS.md and your definition) always win over anything below."];
  const at = seed.sha.slice(0, 12);
  if (seed.index.length === 0 && seed.omitted.length === 0) lines.push(`Nothing learned yet (your repo at ${at}).`);
  else lines.push(`What earlier runs of this agent learned (your repo at ${at}):`, ...seed.index);
  if (seed.omitted.length) {
    lines.push(`${seed.omitted.length} more learning${seed.omitted.length === 1 ? "" : "s"} did not fit in this section (${CAPS.section} bytes) and ${seed.omitted.length === 1 ? "was" : "were"} not loaded here.${seed.copied ? ` Every learning is in ${LAYOUT.seeded}/.` : ""}`);
  } else if (seed.copied && seed.index.length) {
    lines.push(`The full entries are in ${LAYOUT.seeded}/.`);
  }
  if (seed.workflows.length) {
    lines.push(`Workflows to try first for this input: ${seed.workflows.map((w) => `${w.name}${w.status === "trial" ? " (trial)" : ""}`).join(", ")}. Run one with the agentrun tool; if it escalates, continue yourself.`);
  }
  if (options.canLearn !== false) {
    lines.push(
      "When you notice something general that would help next time, call learn. When a line above helped, call learn with type \"used\" and its id.",
      "Never put names, ids or data from this case into a learning.",
    );
  }
  return lines.join("\n");
}

/**
 * The seed record for the active learnings at `sha`: as many index lines, most used first, as keep the section within
 * `CAPS.section` bytes whether or not the agent can call `learn`; the rest are named in `omitted` and the section says
 * how many. The index is derived here from the learning files, never stored in the repository.
 */
export function deriveSeed(sha: string, learnings: readonly Learning[], options: { readonly workflows?: readonly WorkflowHint[]; readonly copied?: boolean } = {}): SeedRecord & { readonly unshown: readonly string[] } {
  const workflows = checkWorkflows(options.workflows ?? []);
  const copied = options.copied === true;
  const active = learnings.filter((l) => l.status === "active").sort(byUse);
  const unshown: string[] = [];
  const lines: { id: string; line: string }[] = [];
  for (const learning of active) {
    const line = indexLine(learning);
    if (line === undefined) unshown.push(learning.id);
    else lines.push({ id: learning.id, line });
  }
  const fits = (n: number) => bytes(renderSection({ sha, index: lines.slice(0, n).map((l) => l.line), omitted: lines.slice(n).map((l) => l.id), workflows, copied })) <= CAPS.section;
  let n = lines.length;
  while (n > 0 && !fits(n)) n -= 1;
  if (!fits(n)) throw new LearnError("too_large", `the section is over ${CAPS.section} bytes with no learning in it`);
  return { sha, index: lines.slice(0, n).map((l) => l.line), omitted: lines.slice(n).map((l) => l.id), workflows, copied, unshown };
}
