// What a person reads of a run's learning: every `detail` of Run.learning, which the run's learning row in its timeline
// shows as its summary too, in one place and in a user's words. Never the machine's: no "main", "merged into", "end-of-run
// turn", "grader's verdict" or "proposal". The reason codes (learning.ts LEARNING_REASONS) stay as they are for machines;
// only these sentences are for people. Text a model wrote (a note's name, the grader's reason) is shortened here and cut
// of the host's secrets by the caller.
import { CAPS, type Problem } from "@parcha/agentrun-learn";

/** `n` of `one`, said as a person says it: "1 note", "2 notes". */
const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
/** `text` on one line, at most `max` characters, cut at a word with an ellipsis when it is longer. */
export function short(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const word = cut.lastIndexOf(" ");
  return `${(word > max / 2 ? cut.slice(0, word) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

/** The most a run list's row says of a run's learning: its detail, cut short (learning.ts shortLearning). */
export const LIST_DETAIL = 140;

const SENTENCES = new Intl.Segmenter("en", { granularity: "sentence" });
/** The first sentence of `text`, by Unicode's sentence rules (so "e.g." or a URL's dot does not end it), read as one
 *  line (a model's line break is no sentence's end), at most 200 characters; empty for an empty text. */
export function firstSentence(text: string): string {
  const first = SENTENCES.segment(text.replace(/\s+/g, " ").trim())[Symbol.iterator]().next().value?.segment ?? "";
  return short(first, 200);
}

/** A checker's rule, in words. Every rule packages/learn's checker has; one it adds later reads as its code. */
const RULE_WORDS: Record<string, string> = {
  secret_value: "one of this server's secrets",
  secret_shape: "text that looks like a key or a password",
  invisible_unicode: "a character a reader can't see",
  too_many_files: "too many files changed at once",
  outside: "a file that is not a note",
  file_name: "a file name a note can't have",
  file_mode: "a link or a folder where a note goes",
  encoding: "text that is not UTF-8",
  edited: "a change to a note it had (a new note replaces an old one instead)",
  deleted: "a deleted note",
  exists: "a note under a name already taken",
  too_large: `a note over ${CAPS.note / 1024} KB`,
  too_many_notes: `more than ${CAPS.newNotes} new notes`,
  note: "a note whose header is not in shape",
  status: "a note status that only the server sets",
  supersedes: "a replaced note that isn't there to replace",
  index_full: "too many notes (retire one first)",
};
/** What a person must not see stored in a note at all: a secret, or what hides text. */
const MUST_NOT_STORE = new Set(["secret_value", "secret_shape", "invisible_unicode"]);
const rulesIn = (problems: readonly Pick<Problem, "rule">[]) => [...new Set(problems.map((problem) => RULE_WORDS[problem.rule] ?? problem.rule))].join("; ");

/** Why learning stopped, said plainly: the cause inside "Not kept: learning stopped (...)". */
export const STOPPED = {
  noGit: "this server has no git that learning can use, so the run started without its notes",
  unreadable: "the agent's notes could not be read, so the run started without them",
  notCopied: "the agent's notes could not be copied into the run, so the run started without them",
  serverStopped: "the server stopped while it set up the run's notes, so the run started without them",
  cancelled: "the run was cancelled",
  cancelledLooking: "the run was cancelled while it looked back",
  crashed: "the run's process ended before it could look back",
  crashedLooking: "the run's process ended while it looked back",
  timedOut: "looking back took too long",
  notAsked: "looking back could not start",
  failed: "looking back ended on an error",
  notSetAside: "the new notes could not be set aside to be checked",
  notChecked: "the new notes could not be checked",
  screenDown: "the safety check on new notes could not run",
  noReview: "the review of the new notes gave no answer",
  unread: "the review of the new notes gave an answer that could not be read",
  notReviewed: "the new notes could not be reviewed or saved",
} as const;

/** A run's learning, in words, by where it stands. */
export const said = {
  seeded: (notes: number) => (notes === 0 ? "Started with nothing learned yet." : `Started from ${count(notes, "note")}.`),
  reflecting: "Looking back on this run…",
  proposed: (notes: number) => `Checking ${count(notes, "new note")}…`,
  /** What it learned, by name (each at most 100 characters), and how many older notes they replace. */
  merged: (learned: readonly { name: string; supersedes: readonly string[] }[]) => {
    const names = learned.map((note) => short(note.name, 100));
    const replaced = learned.reduce((n, note) => n + note.supersedes.length, 0);
    return `${names.length === 1 ? `Learned: ${names[0]}` : `Learned ${names.length} notes: ${names.join("; ")}`}${replaced ? ` (replaces ${count(replaced, "older note")})` : ""}`;
  },
  empty: "Nothing new to remember from this run.",
  /** The grader's reason, its first sentence. */
  grader: (reason: string) => `Not kept: ${firstSentence(reason) || "it was not judged worth remembering."}`,
  /** The checks refused what the run wrote, at its end. */
  checker: (problems: readonly Pick<Problem, "rule">[]) => problems.some((problem) => MUST_NOT_STORE.has(problem.rule))
    ? `Not kept: it held something that must not be stored (${rulesIn(problems.filter((problem) => MUST_NOT_STORE.has(problem.rule)))}).`
    : `Not kept: it didn't pass the checks on notes (${rulesIn(problems)}).`,
  /** The agent's notes as they are now no longer take what the run wrote (another run's or a person's change since). */
  stale: (problems: readonly Pick<Problem, "rule">[]) => `Not kept: the agent's notes changed while this run ran (${rulesIn(problems)}).`,
  noWriteTool: "Not kept: this agent can't write notes (give it the write tool).",
  noBudget: "Skipped: no budget left in this run to look back.",
  unknownCost: "Skipped: this run's spend is unknown, so its budget can't cover looking back.",
  screen: "Not kept: a new note read like instructions planted in a page, not a lesson.",
  stopped: (cause: string) => `Not kept: learning stopped (${cause}).`,
};
