// What a person reads of a run's learning: every `detail` of Run.learning, which the run's learning row in its timeline
// shows as its summary too, in one place and in a user's words, a workflow that waits for the owner's OK included. Never
// the machine's: no "main", "merged into" or "end-of-run turn". The reason codes (learning.ts LEARNING_REASONS) stay as
// they are for machines; only these sentences are for people.
//
// Text a model wrote (a workflow's name) is never shortened where it is said: a value that becomes a secret later is
// found only whole, so a part of it kept would show for good. A run's learning keeps the parts its words are made of
// (`workflows`, `corrections`, `problems`), and each read says them again (wordsOf): every part cut of the host's secrets
// as they are then, and only then the words cut short (DETAIL_MAX for a run, LIST_DETAIL for a list's row).
import { CAPS, CORRECTIONS_FILE, type Problem } from "./learn/index.js";
import type { LearnedFile, Learning } from "./learning.js";

/** `n` of `one`, said as a person says it: "1 correction", "2 corrections". */
const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
/** `parts` as a person lists them: "a", "a and b", "a, b and c". */
export const listed = (parts: readonly string[]) => (parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`);
/** `text` on one line, at most `max` characters, cut at a word with an ellipsis when it is longer. */
export function short(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const word = cut.lastIndexOf(" ");
  return `${(word > max / 2 ? cut.slice(0, word) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

/** The most a run's view, its whole learning and its timeline row say of its learning (its detail, cut short once it is
 *  cut of the host's secrets), and the most a run list's row says. */
export const DETAIL_MAX = 300;
export const LIST_DETAIL = 140;

/** A checker's rule, in words. Every rule learn/check.ts' checker has; one it adds later reads as its code. */
const RULE_WORDS: Record<string, string> = {
  secret_value: "one of this server's secrets",
  secret_shape: "text that looks like a key or a password",
  invisible_unicode: "a character a reader can't see",
  outside: "a file that is not a workflow's",
  file_name: "a workflow name that can't be used",
  file_mode: "a link or a folder where a workflow goes",
  encoding: "text that is not UTF-8",
  deleted: "a deleted workflow",
  too_large: `a workflow over ${CAPS.file / 1024} KB`,
  workflow: "a workflow that can't run here",
  no_tool_list: "a workflow whose tools couldn't be checked",
  executable_node: "a workflow that runs code or commands",
  front_matter: "a workflow whose header sets more than its name and description",
  kept: "a change to a workflow a person retired or hasn't approved yet",
};
const wordOf = (problem: Pick<Problem, "rule">) => RULE_WORDS[problem.rule] ?? problem.rule;
/** What a person must not see stored at all: a secret, or what hides text. */
const MUST_NOT_STORE = new Set(["secret_value", "secret_shape", "invisible_unicode"]);
const rulesIn = (problems: readonly Pick<Problem, "rule">[]) => [...new Set(problems.map(wordOf))].join("; ");
/** The problem that says corrections.md had no room for the owner's correction (learn/corrections.ts' cap), if any: the
 *  one `too_large` that is not a workflow's. */
export const correctionsCapOf = <P extends Pick<Problem, "rule" | "path" | "detail">>(problems: readonly P[]): P | undefined =>
  problems.find((problem) => problem.rule === "too_large" && problem.path === CORRECTIONS_FILE && typeof problem.detail === "string");

/** Why learning stopped, said plainly: the cause inside "Not kept: learning stopped (...)". */
export const STOPPED = {
  unreadable: "what the agent learned could not be read, so the run started without it",
  notCopied: "what the agent learned could not be handed to the run, so the run started without it",
  noSeed: "the run started without what the agent learned",
  cancelled: "the run was cancelled",
  cancelledLooking: "the run was cancelled while it wrote what it learned",
  crashed: "the run's process ended before it could keep what it learned",
  failed: "writing what it learned ended on an error",
  unanswered: "the turn that writes its workflow ended before it answered",
  notChecked: "what it learned could not be checked",
  refuseUnread: "what the run must never learn (its agent's browser sign-in, the server's secrets) could not be read back, so nothing it learned is kept",
  otherDisk: "the run is on a disk its start named, and a run there learns nothing yet: it started without what the agent learned, and what it does is not learned",
} as const;

/** Why a run whose start has no seed started with nothing learned (run-launch.ts SeedFailed), in words. */
export const seedStopped = (failed: string | undefined): string =>
  failed === "unreadable" ? STOPPED.unreadable : failed === "not_copied" ? STOPPED.notCopied : failed === "other_disk" ? STOPPED.otherDisk : STOPPED.noSeed;

/** A run's learning, in words, by where it stands. */
export const said = {
  seeded: (corrections: number, workflows = 0) => {
    const items = [...(corrections ? [count(corrections, "correction")] : []), ...(workflows ? [count(workflows, "workflow")] : [])];
    return items.length ? `Started from ${listed(items)}.` : "Started with nothing learned yet.";
  },
  reflecting: "Keeping what this run learned…",
  /** A message of the end-of-run turn, as a person reads it in the timeline: never the prompt the model is sent. */
  asked: "Learning from this run.",
  /** The compile turn's ask (learn/compile.ts askedForCompile): the job written as a workflow, or a revision of one, or
   *  an attempt the checks sent back. */
  askedCompile: "Writing this job as a learned workflow.",
  askedCompileAgain: "Writing the workflow again: the checks sent back what they refused.",
  /** What it learned: its workflow by name and the corrections it added; then what waits for the owner's OK, by name;
   *  then what the checks refused beside it. A merge that only holds things for the OK says that alone. */
  merged: (files: readonly Pick<LearnedFile, "name" | "pending">[] = [], corrections = 0, checked: readonly Pick<Problem, "rule" | "path" | "detail">[] = []) => {
    const flat = (name: string) => name.replace(/\s+/g, " ").trim();
    const held = files.filter((file) => file.pending).map((file) => `workflow ${flat(file.name)}`);
    const waiting = held.length ? `Waiting for your OK: ${held.join("; ")}.` : "";
    const made = files.filter((file) => !file.pending).map((file) => `the workflow ${flat(file.name)}`);
    const added = corrections ? (corrections === 1 ? "your correction" : `${corrections} of your corrections`) : "";
    const kept = [made.length ? `Learned ${listed(made)}` : "", added ? `Kept ${added}` : ""].filter(Boolean).join(". ");
    // A correction corrections.md had no room for is said in the cap's words, never as a workflow over its cap.
    const cap = correctionsCapOf(checked);
    const rest = checked.filter((problem) => problem !== cap);
    const refused = [cap ? said.correctionsFull(cap.detail) : "", rest.length ? said.checker(rest) : ""].filter(Boolean).join(" ");
    const base = [kept ? `${kept}.` : "", waiting].filter(Boolean).join(" ");
    return [base, refused].filter(Boolean).join(" ");
  },
  empty: "Nothing new to keep from this run.",
  /** A run whose only work was its learned workflows, each answering, with nothing said after its first message: nothing
   *  to compile (runner/learning-end.ts onlyLearnedWorkflows). */
  onlyWorkflow: "Nothing new: the run only ran a learned workflow.",
  /** A run started with `learning: "use"`: it read what its agent learned and kept nothing, as asked. */
  use: "Used what its agent learned; this run keeps nothing.",
  /** A merge whose every item the owner has since retired: nothing it learned is kept now. */
  retiredSince: "What it learned was retired since.",
  /** The checks refused what the run wrote, at its end. */
  checker: (problems: readonly Pick<Problem, "rule">[]) => problems.some((problem) => MUST_NOT_STORE.has(problem.rule))
    ? `Not kept: it held something that must not be stored (${rulesIn(problems.filter((problem) => MUST_NOT_STORE.has(problem.rule)))}).`
    : `Not kept: it didn't pass the checks (${rulesIn(problems)}).`,
  /** The owner's correction would take corrections.md past its cap (learn/corrections.ts): `why`, the cap's words. */
  correctionsFull: (why: string) => `Not kept: ${why.replace(/\.$/, "")}.`,
  noBudget: "Skipped: no budget left in this run to write what it learned.",
  unknownCost: "Skipped: this run's spend is unknown, so its budget can't cover writing what it learned.",
  stopped: (cause: string) => `Not kept: learning stopped (${cause}).`,
  /** A run whose learning seed predates a reset of its agent's learning (runner/learning-end.ts, reason `reset`). */
  reset: "Dropped: its learning seed predates a reset of the agent's learning.",
};

/** A run's learning in words as a read says them, whole: what it learned and what waits for the owner's OK, said again
 *  from its parts (`workflows`, `corrections`, `problems`), each name cut by `cut` first (the host's secrets as they are
 *  now), and the whole line cut again; any other detail, the server's own sentence, cut as well. The caller cuts the
 *  words short after. */
export function wordsOf(learning: Pick<Learning, "state" | "detail" | "workflows" | "corrections" | "problems">, cut: (text: string) => string): string | null {
  if (learning.state === "merged") {
    const files = (Array.isArray(learning.workflows) ? learning.workflows : []).filter((file) => typeof file?.file === "string" && typeof file.name === "string");
    const corrections = typeof learning.corrections === "number" && learning.corrections > 0 ? learning.corrections : 0;
    if (files.length || corrections) return cut(said.merged(files.map((file) => ({ name: cut(file.name), ...(file.pending ? { pending: true as const } : {}) })), corrections, Array.isArray(learning.problems) ? learning.problems : []));
  }
  return learning.detail === null ? null : cut(learning.detail);
}
