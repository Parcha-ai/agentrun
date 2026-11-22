// What an agent learns, as the server's learning routes give it (GET /v2/agents/{id}/learning, a run's `learning`), and
// the words the console says it in. An agent learns two things: its owner's corrections, one line each in corrections.md
// (every later run is given the file whole under `# Learned`), and a learned workflow, a draft its runs compile from the
// job they do again. A run's learning names the workflow draft it kept (`workflows`); the agent's view adds the file, the
// drafts, its before and after (`impact`) and the changes on its learning folder's main (`log`).

import { usd } from "./costPerRun";
import { elapsed } from "./runGraph";
import { rowDetail, rowFailed } from "./timeline";
import type { TimelineRow } from "./v2";

export type LearningState = "seeded" | "reflecting" | "merged" | "dropped";
export type Page<T> = { items: T[]; total: number; next_cursor: string | null };

/** A workflow draft a run kept: its file (`workflows/<name>/workflow.json`), its name, and whether it waits. */
export type LearnedFileRef = { file: string; name: string; pending?: true };
/** A run's learning as a run or a list gives it; null for a run that does not learn. A list carries no `at`; `workflows`
 *  is absent when it kept none. */
export type RunLearning = {
  state: LearningState;
  reason: string | null;
  detail: string | null;
  at?: string;
  workflows?: LearnedFileRef[];
} | null;
/** Why the checks refused something a run or a person wrote: each problem, printable. */
export type LearningProblem = { rule: string; path?: string; detail: string };
/** GET /v2/runs/{id}/learning: the run's learning whole, with what its merge kept (`workflows`, `corrections`), what the
 *  checks refused (`problems`, `draft_errors`) and its commits. Null means the run has no recorded learning. */
export type RunLearningResultData = NonNullable<RunLearning> & {
  run: string;
  seed: string | null;
  merged: string | null;
  workflows: LearnedFileRef[];
  /** How many lines of its owner's words its merge added to corrections.md. */
  corrections: number;
  problems: LearningProblem[];
  draft_errors?: readonly string[];
};
/** A workflow draft the agent learned, as GET .../learning lists it: its name, its workflow.json (`file`), its README
 *  (`readme`, the file an approval, a retire or a restore names), what it is for, whether it waits for the owner's OK or
 *  a person retired it (no later run is given it), the run that kept it, its size, and the README's version (`etag`).
 *  `status` is one word: `pending` or `retired` as its README says, else where it stands as the promotions read says it
 *  (`serving`, `checking`, `held`, `stopped`). */
export type LearnedItem = { name: string; file: string; readme: string; description: string; status: "serving" | "checking" | "held" | "stopped" | "pending" | "retired"; run: string | null; bytes: number; etag: string; retired?: Retired; last_change?: LastChange };
/** A workflow later runs are given: neither waiting for the owner's OK nor retired (whether it serves first is its status:
 *  `serving`, else the agent takes the runs it fits). */
export const givenToRuns = (status: string): boolean => status !== "pending" && status !== "retired";
/** When and by whom a draft was retired, and `from`, the status its restore gives back: `active`, or `pending` (it goes
 *  back to waiting for your OK); or, for a draft whose README can't be read (its front matter reads no way), that no one
 *  did: the host could not read it (`by: "host"`, `why: "unreadable"`, no `from`). */
export type Retired = { at: string; by: "person" | "run" | "host"; from?: "active" | "pending"; why?: "unreadable" };
/** What a draft's card says when it reads retired only because its README can't be read: never who retired it, since no
 *  one did, and what the owner does about it. */
export const UNREADABLE_RETIRED = "Not read: its front matter can't be read; fix the file to use it";
/** The newest change to a draft's README, as the server names it (absent when it names none). */
export type LastChange = { kind: "approved" | "edited" | "created" | "retired" | "restored" | "learned"; by: "person" | "run"; at: string };
const VERBS: Record<LastChange["kind"], string> = { approved: "Approved", edited: "Edited", created: "Created", retired: "Retired", restored: "Restored", learned: "Learned" };
/** A change in words: "Approved by you", "Retired by a run". */
export const changeWords = (kind: LastChange["kind"], by: LastChange["by"]) => `${VERBS[kind]} by ${by === "person" ? "you" : "a run"}`;

/** One change to what the agent learned, newest first: a run's (`by.run`; `reason`, why it was kept) or a person's. */
export type LearningChange = { by: { run: string } | { user: true }; commit: string; at: string; reason: string; files: string[] };
export type LearningCounts = { merged: number; dropped: Record<string, number>; in_progress: number };
/** One side of the before and after: how many runs and the median time to the answer. What a run costs is the cost
 *  card's all-in before and after, learning included, and what learning itself costs a run the bill's (learningBill.ts
 *  learningPerRun): never a second cost here. */
export type ImpactSide = { runs: number; median_duration_s: number };
/** The agent's runs before its first learned item against its runs that started from one; null until each side has two. */
export type Impact = { before: ImpactSide; after: ImpactSide } | null;
/** Configuration readiness only: the server does not make a paid model request to report this. */
export type LearningModelAccess = { location: "server" | "native"; ready: boolean; model: string | null; needs: "key" | "model" | null; reason: string | null };
/** GET /v2/agents/{id}/learning. `main` is null until the agent first learns; `corrections` is corrections.md's text on
 *  main, empty when there is none. `learning_model` is absent on older servers. */
export type AgentLearning = { agent: string; main: string | null; corrections: string; workflows: LearnedItem[]; log: Page<LearningChange>; counts: LearningCounts; impact: Impact; learning_model?: LearningModelAccess };
/** GET and PUT /v2/agents/{id}/learning/corrections: the file's whole text, its version (the If-Match of a PUT) and the
 *  most bytes it holds. */
export type Corrections = { text: string; etag: string; cap_bytes: number };
/** A learning file as GET .../learning/files/{file} answers it: its whole text and its version (its ETag). */
export type LearningFile = { text: string; etag: string | null };
/** Said when the file changed since a card showed it. */
export const CHANGED = "It changed since you opened it.";
/** What a restore says before it is made: what it changes, by the status it goes back to. Only a draft that was active
 *  before its retire becomes active; one that waited for your OK waits again. */
export const restores = (from: Retired["from"] | undefined): string => (from === "active" ? "It becomes active again for the next run." : "It goes back to waiting for your OK: no run uses it until you approve it.");
/** A restore made by a token, not the owner's password sign-in: the server refuses it (403). */
export const RESTORE_SIGN_IN = "Restoring takes your password sign-in in the console.";

/** corrections.md's lines that say something: one a correction. */
export const correctionLines = (text: string): string[] => text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
/** How many bytes a text is as the server counts it (UTF-8), for corrections.md's cap. */
export const bytesOf = (text: string) => new TextEncoder().encode(text).length;
/** "1 correction", "3 corrections". */
export const corrections = (n: number) => `${n} ${n === 1 ? "correction" : "corrections"}`;

const UNDER_WAY: readonly string[] = ["seeded", "reflecting"];
/** Whether a run's learning is still going (it may still keep something). */
export const underWay = (l: RunLearning | undefined) => !!l && UNDER_WAY.includes(l.state);

/** The workflow drafts a run kept, in the list the server sent: empty from a server that does not say. */
export const workflowsBy = (l: RunLearning | undefined): LearnedFileRef[] =>
  l?.state === "merged" && Array.isArray(l.workflows) ? l.workflows.filter((x) => !!x && typeof x.file === "string" && typeof x.name === "string") : [];
/** "1 workflow", "2 workflows". */
export const counted = (n: number, one: "workflow") => `${n} ${one}${n === 1 ? "" : "s"}`;

/** How many of an agent's learned workflow drafts wait for its owner's OK: its `learning.pending` (GET /v2/agents and
 *  /v2/agents/{id}). 0 when the server leaves it out (an agent that doesn't learn, learning off, a learning folder it
 *  could not read), which shows nothing. */
export const waitingOf = (agent: { learning?: { pending: number } } | null | undefined): number => agent?.learning?.pending ?? 0;
/** The count's words, for its label: "2 learned workflows wait for your OK", "1 learned workflow waits for your OK". */
export const waitingWords = (n: number) => `${n} learned ${n === 1 ? "workflow waits" : "workflows wait"} for your OK`;
/** Whether this caller approves a waiting draft from the console, by the server's capabilities: `yes` when
 *  `learning.approve` is true (the owner's password session); else `password`, what the server says approving needs
 *  (`learning.approve_needs`, always sent with `approve: false`). Capabilities that can't be read offer no Approve
 *  either. Only `yes` offers Approve. */
export type Approval = "yes" | "password";
export function approval(caps: unknown): Approval {
  const l = !!caps && typeof caps === "object" ? (caps as { learning?: { approve?: unknown } }).learning : undefined;
  return !!l && typeof l === "object" && l.approve === true ? "yes" : "password";
}
/** Said on a waiting draft to a caller who is not signed in with the owner's password, where the server approves. */
export const APPROVE_SIGN_IN = "Approving needs your password sign-in. Until then it stays out of every run.";

/** What a file name the server cut of a secret reads: shown, never linked. */
export const REDACTED = "[redacted]";

export const runsWord = (n: number) => `${n} ${n === 1 ? "run" : "runs"}`;

/** What kind of outcome a dropped run's learning had: a draft the checks refused, nothing to keep, a skip with a fix, or
 *  a stop. The tab lists the first kind and counts the others. */
export type DropKind = "refused" | "nothing" | "skipped" | "stopped";
const KIND: Record<string, DropKind> = { checker: "refused", empty: "nothing", use: "nothing", no_budget: "skipped", unknown_cost: "skipped" };
export const dropKind = (reason: string | null): DropKind => KIND[reason ?? ""] ?? "stopped";

/** Why a run kept nothing, in plain words: the server's own sentence when it sends one, else the console's for the
 *  reason. A reason the console does not know reads as a stop, never as a code. */
const WORDS: Record<string, string> = {
  empty: "Nothing new to keep from this run.",
  use: "It used what its agent learned and kept nothing.",
  checker: "Not kept: the checks refused it.",
  no_budget: "Skipped: no budget left in this run to write what it learned.",
  unknown_cost: "Skipped: this run's spend is unknown, so its budget can't cover writing what it learned.",
  seed_failed: "Started without what it learned: it couldn't be read.",
  cancelled: "Not kept: learning stopped (the run was cancelled).",
  crashed: "Not kept: learning stopped (the run ended unexpectedly).",
  reflect_failed: "Not kept: learning stopped (an error).",
};
export function dropWords(l: NonNullable<RunLearning>): string {
  if (l.detail && l.detail.trim()) return l.detail.trim();
  return WORDS[l.reason ?? ""] ?? "Not kept: learning stopped.";
}

/** A run's learning while it goes, in a few words. */
export const goingWords = (state: LearningState) => (state === "seeded" ? "Learns after the run" : "Looking back");

/** A median time as shown: to a tenth of a second under 10 s (1.4 s and 1.5 s are not both "1s"), else to the second. */
const shownSeconds = (seconds: number) => (seconds < 9.95 ? Math.round(seconds * 10) / 10 : Math.round(seconds));
/** A median time, as the console writes how long a run took ("12s", "1m 05s"), to a tenth under 10 s ("1.4s"): never
 *  so coarse that the change beside it reads against it. */
export const took = (seconds: number) => {
  const shown = shownSeconds(seconds);
  return shown < 10 ? `${shown.toFixed(1)}s` : elapsed(shown * 1000);
};
/** The change from `a` to `b` as a whole percent: -33 is a third less. Null when `a` is not above zero. */
export const change = (a: number, b: number) => (a > 0 ? Math.round(((b - a) / a) * 100) : null);
/** The change between two median times as shown (took), so the percent and the times beside it say one thing. */
export const tookChange = (a: number, b: number) => change(shownSeconds(a), shownSeconds(b));
/** What learning booked a run, in words: "$0.0193 a run, booked" (the bill's figure, learningBill.ts learningPerRun). */
export const learningWords = (learning: number) => `${usd(learning)} a run, booked`;
/** The before and after in one line, as the card says it and a screen reader reads it, whichever way the numbers went,
 *  with what learning itself booked a run (`learning`, the bill's: its compile turns, audit shadows and replays over its
 *  runs; null before the bill has a run): "Since it learned (medians of 4 runs started from what it learned): answers in
 *  12s instead of 18s · learning itself $0.0193 a run, booked". No cost of a run: that is the cost card's all-in. */
export function impactWords(i: NonNullable<Impact>, learning: number | null = null): string {
  const parts = [`answers in ${took(i.after.median_duration_s)} instead of ${took(i.before.median_duration_s)}`];
  if (learning !== null) parts.push(`learning itself ${learningWords(learning)}`);
  return `Since it learned (${impactBase(i)}): ${parts.join(" · ")}`;
}

/** The tile's base said plainly: medians over the runs that started from anything learned, a correction included, which
 *  is another set than the cost card's served runs (a learned workflow ran them). */
export function impactBase(i: NonNullable<Impact>): string {
  return `medians of ${runsWord(i.after.runs)} started from what it learned`;
}
/** Whether an impact the server sent is whole enough to show: both sides, two runs each, a duration each. */
export const shownImpact = (i: unknown): i is NonNullable<Impact> => {
  const side = (s: unknown) => !!s && typeof s === "object" && typeof (s as ImpactSide).runs === "number" && (s as ImpactSide).runs >= 2 && typeof (s as ImpactSide).median_duration_s === "number";
  return !!i && typeof i === "object" && side((i as { before?: unknown }).before) && side((i as { after?: unknown }).after);
};

/** The agent's Learning tab. */
export const learningHash = (agentId: string) => `#/agents/${encodeURIComponent(agentId)}/learning`;

/** A timeline row as the console labels a run's learning: the row that says how it ended, and the message that starts
 *  the look back ("Looking back on this run.", the server's own words; it is not the person's), each read "Learning",
 *  without the chip that would say it again. Every other row is as it was. learningSteps calls it on each row it leaves as a row, and on each
 *  line of the look-back it folds. */
export function learningLabel(row: TimelineRow): TimelineRow {
  if (row.kind === LEARNING) return { ...row, agent_label: null };
  if (row.kind === "user_message" && row.agent_label === LEARNING) return { ...row, kind: LEARNING, agent_label: null };
  return row;
}
/** The label the server puts on every row of a run's learning, and the kind of the row that says how it ended. */
const LEARNING = "learning" as const;

/** How far a run's learning has got: it only moves forward, so of two reads the further one is the newer. */
const STAGE: Record<string, number> = { seeded: 0, reflecting: 1, merged: 2, dropped: 2 };
const stage = (l: RunLearning | undefined) => (l ? STAGE[l.state] ?? 0 : -1);
/** The learning a timeline row of kind `learning` carries (`learning`: its state, reason and words), when it does. */
const rowLearning = (row: TimelineRow | undefined): RunLearning | undefined => {
  const l = (row as { learning?: unknown } | undefined)?.learning;
  return l && typeof l === "object" && typeof (l as { state?: unknown }).state === "string" ? (l as NonNullable<RunLearning>) : undefined;
};

/** The look-back's one step, in words, from where the run's learning stands: under way, the workflow it kept by name
 *  (one that waits for the OK says so), nothing new, or why nothing was kept. Never a file path. */
export function lookedBack(l: RunLearning | undefined): string {
  if (!l || stage(l) < 2) return "Looking back on this run…";
  if (l.state === "merged") {
    const kept = workflowsBy(l);
    const names = (refs: LearnedFileRef[]) => refs.map((x) => x.name.replace(/\s+/g, " ").trim()).join(", ");
    const ready = kept.filter((x) => !x.pending), waits = kept.filter((x) => x.pending);
    const said = [...(ready.length ? [`kept ${counted(ready.length, "workflow")} (${names(ready)})`] : []), ...(waits.length ? [`${counted(waits.length, "workflow")} ${waits.length === 1 ? "waits" : "wait"} for your OK (${names(waits)})`] : [])];
    return said.length ? `Looked back: ${said.join("; ")}` : `Looked back. ${l.detail?.trim() || "It kept what it learned."}`;
  }
  if (dropKind(l.reason) === "nothing") return "Looked back: nothing new to keep";
  // The server's sentence as it is: never trimmed.
  return `Looked back: ${dropWords(l)}`;
}

/** One row of the look-back as the step's lines: its line, marked when it failed, then what it opens to, indented,
 *  unless that is the line again. */
function foldedRow(row: TimelineRow): string {
  const r = learningLabel(row);
  const summary = r.summary ?? "";
  const line = rowFailed(r) ? `${summary} (failed)` : summary;
  const detail = rowDetail(r)?.trimEnd();
  return detail && detail.trim() !== summary.trim() ? `${line}\n${detail.replace(/^(?=.)/gm, "  ")}` : line;
}

/** A run's timeline rows as its page shows them, with its end-of-run look-back as ONE step. Every row labelled
 *  `learning` (the look-back's message, whatever it did, and the row that says how its learning ended) folds into one
 *  row, where the look-back began: "Looked back: kept 1 workflow (invoice-totals)", said from the run's learning
 *  (`learning`, the same the header's chips read, so the two agree) or from the timeline's own row when that one is
 *  further on. The rows it stands for open under it, each on its line, with "(failed)" when it failed, and under that,
 *  indented, what the row would open to on its own (a message's whole text, a call's input, a result's output) when that
 *  says more than its line. A run that did not look back (a skip) keeps its one learning row, labelled. Every other row
 *  is as it was. */
export function learningSteps(rows: readonly TimelineRow[], learning?: RunLearning): TimelineRow[] {
  const looked = rows.filter((r) => r.agent_label === LEARNING && r.kind !== LEARNING);
  if (!looked.length) return rows.map(learningLabel);
  const end = rows.findLast((r) => r.kind === LEARNING);
  const fromRow = rowLearning(end);
  const said = stage(fromRow) > stage(learning ?? undefined) ? fromRow : learning && { ...learning, detail: learning.detail ?? fromRow?.detail ?? end?.summary ?? null };
  const first = looked[0]!;
  const step: TimelineRow = {
    id: first.id, seq: first.seq, timestamp: first.timestamp, created_at: first.created_at,
    kind: LEARNING, agent_label: null, tool_name: null, tool_use_id: null, tool_status: null, tool_input_preview: null, tool_result_preview: null, tool_result_size_bytes: null,
    summary: lookedBack(said ?? undefined),
    text: [...looked, ...(end ? [end] : [])].map(foldedRow).join("\n"),
  };
  return rows.flatMap((r) => (r === first ? [step] : r.agent_label === LEARNING || r.kind === LEARNING ? [] : [r]));
}

/** What a run's learning changed in its agent's learning folder, as GET /v2/runs/{id}/learning/diff answers: each file
 *  with its `patch` (git's hunks, no header), or why the server withholds it (`too_large`, or a value of its secrets in
 *  it). */
export type LearningDiffFile = { path: string; status: "added" | "deleted" | "modified"; patch?: string; withheld?: "too_large" | "secret" };
export type LearningDiff = { base: string | null; head: string | null; files: LearningDiffFile[] };
/** A line of a file's text before or after: unchanged (`same`), taken out (`removed`), new (`added`), or a `gap` where
 *  unchanged lines are left out. */
export type DiffLine = { text: string; mark: "same" | "removed" | "added" | "gap" };
/** One file a run's learning changed, in words ("Added: workflow invoice-totals", "Changed: corrections"), with its text
 *  before and after: null where there was none, or where the server withholds it (`withheld`, why, in words). */
export type FileChange = { file: string; said: string; before: DiffLine[] | null; after: DiffLine[] | null; withheld?: string };

const WITHHELD: Record<string, string> = { too_large: "It's too large to show here.", secret: "Not shown: it holds one of this server's secrets." };
const SAID_ORDER = ["Added", "Changed", "Removed"];

/** A patch's text before and after, its hunks one after another, a gap where unchanged lines are left out. */
function sides(patch: string): { before: DiffLine[]; after: DiffLine[] } {
  const before: DiffLine[] = [], after: DiffLine[] = [];
  let hunks = 0;
  for (const line of patch.split("\n")) {
    const at = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (at) {
      if (hunks || Number(at[1]) > 1) before.push({ text: "…", mark: "gap" });
      if (hunks || Number(at[2]) > 1) after.push({ text: "…", mark: "gap" });
      hunks++;
    } else if (hunks && line.startsWith(" ")) { before.push({ text: line.slice(1), mark: "same" }); after.push({ text: line.slice(1), mark: "same" }); }
    else if (hunks && line.startsWith("-")) before.push({ text: line.slice(1), mark: "removed" });
    else if (hunks && line.startsWith("+")) after.push({ text: line.slice(1), mark: "added" });
  }
  return { before, after };
}

/** A learning file by what it is: "corrections" for corrections.md, "workflow <name>" for a draft's workflow.json,
 *  "workflow <name> (README)" for its README, else its path. */
export function fileWords(path: string): string {
  if (path === "corrections.md") return "corrections";
  const m = /^workflows\/([^/]+)\/(workflow\.json|README\.md)$/.exec(path);
  return m ? `workflow ${m[1]}${m[2] === "README.md" ? " (README)" : ""}` : path;
}

/** What a run's learning changed, file by file, in a person's words: each file it added, changed or removed, by what it
 *  is (fileWords), added first. */
export function fileChanges(diff: LearningDiff): FileChange[] {
  const out = diff.files.map((f): FileChange => {
    const p = f.patch === undefined ? null : sides(f.patch);
    const said = `${f.status === "added" ? "Added" : f.status === "deleted" ? "Removed" : "Changed"}: ${fileWords(f.path)}`;
    if (!p) return { file: f.path, said, before: null, after: null, withheld: WITHHELD[f.withheld ?? ""] ?? "Not shown." };
    return { file: f.path, said, before: f.status === "added" ? null : p.before, after: f.status === "deleted" ? null : p.after };
  });
  return out.sort((a, b) => SAID_ORDER.indexOf(a.said.split(":")[0]!) - SAID_ORDER.indexOf(b.said.split(":")[0]!));
}
