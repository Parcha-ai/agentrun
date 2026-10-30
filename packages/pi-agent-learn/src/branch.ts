// A run's branch on the layout every harness shares (the step 1 checker's SPEC.md): the host-written memo, one note per
// lesson, fact or correction in Pi's learning format, one more use on each note the run used, the index, and a workflow
// draft per workflow the run saved. `runBranchFiles` writes it at propose time and `readRunBranch` reads it back at curate.
import { inspectWorkflow } from "@parcha/agentrun-dsl";
import { type Learning, learningId, parseLearning, renderLearning } from "./entry.js";
import { LearnError } from "./errors.js";
import { CAPS, COMMIT_SHA, LAYOUT, LEARNING_ID, learningPath, memoPath, usesPath, WORKFLOW_NAME } from "./layout.js";
import { repoWorkflowDir } from "./trial.js";
import { type Candidate, ENTRY_TYPES } from "./types.js";

/** A workflow the run hands over: its document when it saved one, and the agent's when-to-use text when it wrote one. */
export type Draft = { readonly name: string; readonly workflow?: unknown; readonly description?: string };

export type RunBranchInput = {
  readonly runId: string;
  /** The commit the branch starts from: the one the run was seeded from, else main when the run proposed. */
  readonly base: string;
  /** False when the run was not seeded, so `base` is only where its branch starts. */
  readonly seeded: boolean;
  readonly candidates: readonly Candidate[];
  readonly untrusted: boolean;
  /** The learnings at `base`: a `used` mark is one more use on an active one. */
  readonly learnings: readonly Learning[];
  readonly drafts?: readonly Draft[];
  /** `uses/<run id>.json`, as the host wrote it. */
  readonly uses?: string;
  readonly outcome?: "completed" | "failed" | "stopped";
  readonly costUsd?: number;
};

const NOTE_TYPES: readonly string[] = ENTRY_TYPES;
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const INDEX_CHARS = 160;

/** `- L-<id>: <the rule in one line>`, the index's line for a learning. */
export function indexEntry(learning: Pick<Learning, "id" | "text">): string {
  const chars = Array.from(oneLine(learning.text));
  return `- ${learning.id}: ${chars.length > INDEX_CHARS ? `${chars.slice(0, INDEX_CHARS - 1).join("")}\u2026` : chars.join("")}`;
}

/** `learnings/INDEX.md` for `active`, most used first, or undefined when it would be over its cap. */
export function renderIndex(active: readonly Learning[]): string | undefined {
  const sorted = [...active].sort((a, b) => b.uses - a.uses || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const text = `# Learnings\n\n${sorted.map(indexEntry).join("\n")}${sorted.length ? "\n" : ""}`;
  return Buffer.byteLength(text, "utf8") > CAPS.index ? undefined : text;
}

/** The record the DSL's store writes for `workflow` under `name`, and its `latest`. */
export function recordsOf(name: string, workflow: unknown, createdAt: string): Record<string, string> {
  const digest = inspectWorkflow(workflow).sha256;
  return { [`${digest}.json`]: `${JSON.stringify({ version: 1, name, digest, createdAt, workflow }, null, 2)}\n`, latest: `${digest}\n` };
}

/** Every file of a run's branch, by path. The memo's front matter is the host's facts; its sections name what the run
 *  proposed and hold no text of the model's, which is in the notes and drafts. */
export function runBranchFiles(input: RunBranchInput): Record<string, string> {
  const { runId, base } = input;
  if (!COMMIT_SHA.test(base)) throw new LearnError("invalid", "the branch's base is not a commit id");
  const files: Record<string, string> = {};
  const learned: string[] = [];
  const active = new Map(input.learnings.filter((l) => l.status === "active").map((l) => [l.id, l]));
  const fresh: Learning[] = [];
  for (const c of input.candidates) {
    if (!NOTE_TYPES.includes(c.type)) continue;
    const id = learningId(runId, c.text);
    if (files[learningPath(id)] !== undefined) continue;
    const replaces = c.id !== undefined && LEARNING_ID.test(c.id) && c.id !== id ? [c.id] : [];
    const note: Learning = {
      id, type: c.type as Learning["type"], scope: "all", status: "active",
      provenance: { runs: [runId], sha: base, untrusted: input.untrusted, ...(input.seeded ? {} : { shaFrom: "branch-base" as const }) },
      uses: 0, supersedes: replaces, text: c.text,
    };
    files[learningPath(id)] = renderLearning(note);
    fresh.push(note);
    learned.push(`- ${learningPath(id)}: a new ${c.type}`);
  }
  const used = new Set<string>();
  for (const c of input.candidates) {
    if (c.type !== "used" || c.id === undefined || used.has(c.id) || !active.has(c.id)) continue;
    used.add(c.id);
    const note = { ...active.get(c.id)!, uses: active.get(c.id)!.uses + 1 };
    files[learningPath(c.id)] = renderLearning(note);
    active.set(c.id, note);
    learned.push(`- ${learningPath(c.id)}: used again`);
  }
  for (const draft of input.drafts ?? []) {
    if (!WORKFLOW_NAME.test(draft.name)) throw new LearnError("invalid", "a workflow name is not valid");
    const dir = repoWorkflowDir(draft.name);
    if (draft.workflow !== undefined) files[`${dir}/workflow.json`] = `${JSON.stringify(draft.workflow, null, 2)}\n`;
    const description = draft.description?.trim();
    files[`${dir}/README.md`] = `# ${draft.name}\n${description ? `\n${description}\n` : ""}`;
    learned.push(`- ${dir}/: ${draft.workflow === undefined ? "when to use a workflow on main" : "a workflow draft"}`);
  }
  if (fresh.length || used.size) {
    const index = renderIndex([...active.values(), ...fresh]);
    if (index !== undefined) files[LAYOUT.index] = index;
  }
  if (input.uses !== undefined) files[usesPath(runId)] = input.uses;
  const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const memo = [
    "---",
    `run: ${runId}`,
    `base: ${base}`,
    "harness: pi",
    `outcome: ${input.outcome ?? "completed"}`,
    `untrusted: ${input.untrusted}`,
    ...(input.costUsd === undefined ? [] : [`cost_usd: ${input.costUsd}`]),
    "---",
    "## What happened",
    `The run proposed ${count(fresh.length, "note")}, used ${count(used.size, "note")} again and handed over ${count(input.drafts?.length ?? 0, "workflow")}.`,
    "",
    "## What I learned",
    ...(learned.length ? learned : ["- Nothing new."]),
    "",
    "## What could be better",
    "- The run recorded nothing here.",
    "",
    "## Proposed changes",
    ...Object.keys(files).sort().map((path) => `- ${path}`),
    "",
  ].join("\n");
  files[memoPath(runId)] = memo;
  return files;
}

/** A candidate as curate reads it off a run's branch. */
export type BranchCandidate = Candidate & { readonly untrusted: boolean };

export type RunBranch = {
  readonly candidates: readonly BranchCandidate[];
  /** The commit the memo says the run started from. */
  readonly base?: string;
  /** False when a note says the run was not seeded, so `base` is only where its branch starts. */
  readonly seeded: boolean;
  readonly untrusted: boolean;
  /** Per workflow name: the draft's records as the DSL's store would write them, empty when the run only described it. */
  readonly records: ReadonlyMap<string, Record<string, string>>;
  readonly uses?: string;
};

const FRONT = /^---\n([\s\S]*?)\n---\n/;

/** Reads a run's branch back from the files it changed (`after`) and what they were where it started (`before`); a string
 *  is why it cannot be read. */
export function readRunBranch(runId: string, after: Readonly<Record<string, string | null>>, before: (path: string) => string | undefined, createdAt: string): RunBranch | string {
  const memo = after[memoPath(runId)];
  if (typeof memo !== "string") return "the run's branch carries no memo";
  const front = new Map((FRONT.exec(memo)?.[1] ?? "").split("\n").map((line) => /^([a-z_]+): (.*)$/.exec(line.replace(/\s+#.*$/, ""))).filter((m) => m !== null).map((m) => [m![1]!, m![2]!.trim()]));
  const untrusted = front.get("untrusted") === "true";
  const base = front.get("base");
  const candidates: BranchCandidate[] = [];
  let seeded = true;
  const records = new Map<string, Record<string, string>>();
  const descriptions = new Map<string, string>();
  const workflows = new Map<string, unknown>();
  for (const [path, text] of Object.entries(after).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (text === null) continue;
    const note = /^learnings\/(L-[0-9a-f]{12})\.md$/.exec(path);
    if (note) {
      let made: Learning;
      try {
        made = parseLearning(text);
      } catch {
        return `the note ${note[1]} does not parse`;
      }
      const old = before(path);
      if (old === undefined) {
        if (made.provenance.shaFrom === "branch-base") seeded = false;
        candidates.push({ callId: `note-${made.id}`, type: made.type, text: made.text, evidence: [], ...(made.supersedes[0] ? { id: made.supersedes[0] } : {}), untrusted: untrusted || made.provenance.untrusted });
        continue;
      }
      let was: Learning;
      try {
        was = parseLearning(old);
      } catch {
        return `the note ${note[1]} on main does not parse`;
      }
      if (renderLearning({ ...was, uses: was.uses + 1 }) !== text) return `the run changed the note ${note[1]} beyond one more use`;
      candidates.push({ callId: `used-${made.id}`, type: "used", text: "", evidence: [], id: made.id, untrusted });
      continue;
    }
    const draft = /^workflows\/([^/]+)\/(workflow\.json|README\.md)$/.exec(path);
    if (draft) {
      if (draft[2] === "README.md") descriptions.set(draft[1]!, text.replace(/^# [^\n]*\n+/, "").trim());
      else {
        try {
          workflows.set(draft[1]!, JSON.parse(text));
        } catch {
          return `the draft ${draft[1]} does not parse`;
        }
      }
    }
  }
  for (const name of [...new Set([...descriptions.keys(), ...workflows.keys()])].sort()) {
    const description = descriptions.get(name);
    candidates.push({ callId: `workflow-${name}`, type: "workflow", text: description ?? "", evidence: [], id: name, untrusted });
    records.set(name, workflows.has(name) ? recordsOf(name, workflows.get(name), createdAt) : {});
  }
  // In the order the memo names them, which is the order the run noted them in.
  const at = (c: BranchCandidate) => {
    const path = c.type === "workflow" ? `${repoWorkflowDir(c.id!)}/` : learningPath(c.type === "used" ? c.id! : learningId(runId, c.text));
    const found = memo.indexOf(`- ${path}`);
    return found < 0 ? Number.MAX_SAFE_INTEGER : found;
  };
  candidates.sort((a, b) => at(a) - at(b));
  const uses = after[usesPath(runId)];
  return { candidates, ...(base !== undefined && COMMIT_SHA.test(base) ? { base } : {}), seeded, untrusted, records, ...(typeof uses === "string" ? { uses } : {}) };
}
