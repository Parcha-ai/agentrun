// What a person reads of a run's learning: every `detail` of Run.learning, which the run's learning row in its timeline
// shows as its summary too, in one place and in a user's words, a note that waits for the owner's OK included. Never the
// machine's: no "main", "merged into", "end-of-run turn", "grader's verdict" or "proposal". The reason codes (learning.ts
// LEARNING_REASONS) stay as they are for machines; only these sentences are for people.
//
// Text a model wrote (a note's name, the grader's reason) is never shortened where it is said: a value that becomes a
// secret later is found only whole, so a part of it kept would show for good. A run's learning keeps the parts its
// words are made of (`learned`, `verdict`), and each read says them again (wordsOf): every part cut of the host's
// secrets as they are then, and only then the words cut short (DETAIL_MAX for a run, LIST_DETAIL for a list's row).
import { CAPS, learnedPlace, parseVerdict, type Problem, type Verdict } from "./learn/index.js";
import type { LearnedFile, Learning } from "./learning.js";

/** `n` of `one`, said as a person says it: "1 note", "2 notes". */
const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
/** `parts` as a person lists them: "a", "a and b", "a, b and c". */
const listed = (parts: readonly string[]) => (parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`);
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

const SENTENCES = new Intl.Segmenter("en", { granularity: "sentence" });
/** The first sentence of `text`, by Unicode's sentence rules (so "e.g." or a URL's dot does not end it), read as one
 *  line (a model's line break is no sentence's end), whole; empty for an empty text. */
export function firstSentence(text: string): string {
  return (SENTENCES.segment(text.replace(/\s+/g, " ").trim())[Symbol.iterator]().next().value?.segment ?? "").trim();
}

/** A checker's rule, in words. Every rule learn/check.ts' checker has; one it adds later reads as its code. */
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
  skill: "a skill whose header is not in shape",
  skill_outcome: "a skill from a run that didn't finish its job",
  too_many_skills: `more than ${CAPS.skills} skill at once`,
  workflow: "a workflow that can't run here",
  too_many_workflows: `more than ${CAPS.workflows} workflow at once`,
  no_tool_list: "a workflow whose tools couldn't be checked",
  executable_node: "a workflow that runs code or commands",
  skill_front_matter: "a skill or workflow whose header sets more than its name and description",
  skill_status: "a change to a skill or workflow a person retired or hasn't approved yet",
};
/** The rules whose words name a note, said of a skill's or a workflow's file instead. */
const LEARNED_WORDS: Record<string, string> = {
  file_name: "a skill or workflow name that can't be used",
  file_mode: "a link or a folder where a skill or workflow goes",
  deleted: "a deleted skill or workflow",
  too_large: `a skill or workflow over ${CAPS.file / 1024} KB`,
  status: "a skill status that only the server sets",
};
/** Whether a problem is about a skill or a workflow draft, by its path or its rule. */
const isLearned = (problem: Pick<Problem, "rule" | "path">) => (problem.path !== undefined && learnedPlace(problem.path) !== undefined) || /skill|workflow|tool_list|executable/.test(problem.rule);
const wordOf = (problem: Pick<Problem, "rule" | "path">) => (isLearned(problem) ? LEARNED_WORDS[problem.rule] : undefined) ?? RULE_WORDS[problem.rule] ?? problem.rule;
/** What a person must not see stored in a note at all: a secret, or what hides text. */
const MUST_NOT_STORE = new Set(["secret_value", "secret_shape", "invisible_unicode"]);
const rulesIn = (problems: readonly Pick<Problem, "rule" | "path">[]) => [...new Set(problems.map(wordOf))].join("; ");

/** Why learning stopped, said plainly: the cause inside "Not kept: learning stopped (...)". */
export const STOPPED = {
  unreadable: "the agent's notes could not be read, so the run started without them",
  notCopied: "the agent's notes could not be copied into the run, so the run started without them",
  noSeed: "the run started without the agent's notes",
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
  refuseUnread: "what the run must never learn (its agent's browser sign-in, the server's secrets) could not be read back, so nothing it learned is kept",
  noReview: "the review of the new notes gave no answer",
  unread: "the review of the new notes gave an answer that could not be read",
} as const;

/** A run's learning, in words, by where it stands. */
export const said = {
  seeded: (notes: number) => (notes === 0 ? "Started with nothing learned yet." : `Started from ${count(notes, "note")}.`),
  reflecting: "Looking back on this run…",
  /** The end-of-run turn's message, as a person reads it in the timeline: never the prompt the model is sent. */
  asked: "Looking back on this run.",
  proposed: (notes: number, skills = 0, workflows = 0) => `Checking ${listed([...(notes || !(skills || workflows) ? [count(notes, "new note")] : []), ...(skills ? [count(skills, "skill")] : []), ...(workflows ? [count(workflows, "workflow")] : [])])}…`,
  /** What it learned, by name, and how many older notes they replace, and its skill and workflow by name; then what
   *  waits for the owner's OK, by name; then, when the grader dropped an item and kept others (a verdict per item), its
   *  word on the first it dropped. A merge that only holds things for the OK says that alone. */
  merged: (learned: readonly { name: string; supersedes: readonly string[] }[], pending: readonly { name: string }[] = [], files: readonly Pick<LearnedFile, "file" | "name" | "pending">[] = [], left: readonly { why: string }[] = [], checked: readonly Pick<Problem, "rule" | "path">[] = []) => {
    const flat = (name: string) => name.replace(/\s+/g, " ").trim();
    const kind = (file: Pick<LearnedFile, "file" | "name">) => `${file.file.startsWith("skills/") ? "skill" : "workflow"} ${flat(file.name)}`;
    const held = [...pending.map((note) => flat(note.name)), ...files.filter((file) => file.pending).map(kind)];
    const waiting = held.length ? `Waiting for your OK: ${held.join("; ")}.` : "";
    const made = files.filter((file) => !file.pending).map(kind);
    const dropped = [left.length ? said.grader(left[0]!.why) : "", checked.length ? said.checker(checked) : ""].filter(Boolean).join(" ");
    if (!learned.length && !made.length) return [waiting, dropped].filter(Boolean).join(" ");
    const names = learned.map((note) => flat(note.name));
    const replaced = learned.reduce((n, note) => n + note.supersedes.length, 0);
    const notes = names.length ? `${names.length === 1 ? `Learned: ${names[0]}` : `Learned ${names.length} notes: ${names.join("; ")}`}${replaced ? ` (replaces ${count(replaced, "older note")})` : ""}` : "";
    const kept = [notes, made.length ? `${notes ? "Also learned" : "Learned"} ${listed(made.map((made) => `the ${made}`))}` : ""].filter(Boolean).join(". ");
    const base = waiting ? `${kept}. ${waiting}` : kept;
    return dropped ? `${base}${base.endsWith(".") ? "" : "."} ${dropped}` : base;
  },
  empty: "Nothing new to remember from this run.",
  /** A merge whose every item the owner has since retired: nothing it learned is kept now. */
  retiredSince: "What it learned was retired since.",
  /** The run's answer gave its notes, but not in the format asked for, so none was read. */
  unparsed: "Not kept: its notes weren't in the expected format.",
  /** The grader's word on why it kept nothing (a dropped note's why, or its reason), its first sentence. */
  grader: (reason: string) => `Not kept: ${firstSentence(reason) || "it was not judged worth remembering."}`,
  /** The checks refused what the run wrote, at its end: its notes, or what it learned when a skill or a workflow is
   *  among what was refused. */
  checker: (problems: readonly Pick<Problem, "rule" | "path">[]) => problems.some((problem) => MUST_NOT_STORE.has(problem.rule))
    ? `Not kept: it held something that must not be stored (${rulesIn(problems.filter((problem) => MUST_NOT_STORE.has(problem.rule)))}).`
    : `Not kept: it didn't pass the checks on ${problems.some(isLearned) ? "what it learned" : "notes"} (${rulesIn(problems)}).`,
  /** The agent's notes as they are now no longer take what the run wrote (another run's or a person's change since). A
   *  note it would replace that is gone, or that a person changed after the grade read it, is the rule `supersedes`
   *  either way: said in one sentence true of both. */
  stale: (problems: readonly Pick<Problem, "rule">[]) => problems.length && problems.every((problem) => problem.rule === "supersedes")
    ? "Not kept: a note it would replace is gone or was changed since."
    : `Not kept: the agent's notes changed while this run ran (${rulesIn(problems)}).`,
  noBudget: "Skipped: no budget left in this run to look back.",
  unknownCost: "Skipped: this run's spend is unknown, so its budget can't cover looking back.",
  stopped: (cause: string) => `Not kept: learning stopped (${cause}).`,
};

/** The reasons learn/grade.ts' parseVerdict gives of its own, never the grader's: an answer it could not read, and one
 *  it refused (an item for a file it was not asked about, a file judged twice, a new note with no item, a merge that
 *  did not keep every note). Found by asking it, so they follow it. */
const OWN_REASONS = new Set(["", "[]", '{"merge":true,"reason":"r","items":[{"file":"a.md","keep":false,"why":"w"}]}', '{"merge":false,"reason":"r","items":[]}', '{"merge":false,"reason":"r","items":[{"file":"b.md","keep":false,"why":"w"}]}', '{"merge":false,"reason":"r","items":[{"file":"a.md","keep":false,"why":"w"},{"file":"a.md","keep":false,"why":"w"}]}'].map((answer) => parseVerdict(answer, ["a.md"]).reason));
/** The skill or the workflow draft at `file` as a person names it ("the skill X", "the workflow Y"), or undefined for a
 *  note's file or a draft's README.md. */
const learnedWords = (file: string): string | undefined => {
  const place = /^(skills)\/([^/]+)\/SKILL\.md$|^(workflows)\/([^/]+)\/workflow\.json$/.exec(file);
  return place ? (place[1] ? `the skill ${place[2]}` : `the workflow ${place[4]}`) : undefined;
};
/** Why a verdict kept nothing, in a person's words: the grader's word on the first note it did not keep, since its
 *  reason may open on a note it kept; when it dropped none, or gave one no word, its own reason, unless that is
 *  parseVerdict's own; an answer that held neither is said as such. Nothing merged, so the skill and the workflow draft
 *  the run proposed (`lost`, from its proposal: a verdict the host refused has no items) are lost with it: named before
 *  the why, so a long why cut short never cuts them off; the one the why speaks of as its subject ("Not kept, the
 *  skill X: …"), any other as lost with it ("Not kept, with the skill X: …"). The caller cuts the line of the host's
 *  secrets: a name is the run's to choose. */
export function notKept(verdict: Pick<Verdict, "reason" | "items">, lost: readonly Pick<LearnedFile, "file">[] = []): string {
  const dropped = verdict.items.find((item) => !item.keep);
  const said_ = dropped?.why ? said.grader(dropped.why) : OWN_REASONS.has(verdict.reason) ? said.stopped(STOPPED.unread) : said.grader(verdict.reason);
  const subject = dropped?.why ? learnedWords(dropped.file) : undefined;
  const others = [...new Set(lost.flatMap(({ file }) => learnedWords(file) ?? []))].filter((words) => words !== subject);
  if (!subject && !others.length) return said_;
  const named = [subject, others.length ? `with ${listed(others)}` : ""].filter(Boolean).join(" ");
  return said_.replace(/^Not kept: /, `Not kept, ${named}: `);
}

/** A run's learning in words as a read says them, whole: what it learned and what waits for the owner's OK, or why the
 *  grader kept nothing, said again from its parts (`learned`, `pending`, `verdict`) each cut by `cut` first (the host's
 *  secrets as they are now); any other detail, the server's own sentence, cut as well. The caller cuts the words short
 *  after. */
export function wordsOf(learning: Pick<Learning, "state" | "reason" | "detail" | "learned" | "pending" | "verdict" | "skills" | "workflows" | "problems" | "lost">, cut: (text: string) => string): string | null {
  const { learned, pending, verdict } = learning;
  if (learning.state === "merged") {
    const kept = Array.isArray(learned) ? learned : [];
    const waiting = Array.isArray(pending) ? pending.filter((note) => typeof note?.name === "string") : [];
    const files = [...(Array.isArray(learning.skills) ? learning.skills : []), ...(Array.isArray(learning.workflows) ? learning.workflows : [])].filter((file) => typeof file?.file === "string" && typeof file.name === "string");
    if (kept.length || waiting.length || files.length) return said.merged(kept.map((note) => ({ name: cut(note.name), supersedes: note.supersedes })), waiting.map((note) => ({ name: cut(note.name) })), files.map((file) => ({ file: file.file, name: cut(file.name), ...(file.pending ? { pending: true as const } : {}) })), (verdict?.items ?? []).filter((item) => !item.keep && typeof item.why === "string").map((item) => ({ why: cut(item.why) })), Array.isArray(learning.problems) ? learning.problems : []);
  }
  if (learning.state === "dropped" && learning.reason === "grader" && verdict) {
    // serve.json's `lost` is read as untrusted: an entry out of shape is left out. The whole line is cut again, the names
    // in it included.
    const lost = Array.isArray(learning.lost) ? learning.lost.filter((file) => typeof file?.file === "string") : [];
    return cut(notKept({ reason: cut(verdict.reason), items: (verdict.items ?? []).map((item) => ({ ...item, why: cut(item.why) })) }, lost));
  }
  return learning.detail === null ? null : cut(learning.detail);
}
