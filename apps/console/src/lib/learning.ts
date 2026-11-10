// What an agent learns, as the server's learning routes give it (GET /v2/agents/{id}/learning, a run's `learning`), and
// the words the console says it in. The notes are Claude Code's auto-memory files: front matter (`name`, `description`,
// `type`) and a markdown body. A run's learning names what it started with, opened and kept (`given`, `read`, `learned`),
// each absent when there is none; the agent's view adds its before and after (`impact`), each note's run counts (`runs`)
// and a plain sentence for each outcome (`detail`).

import { cost } from "./format";
import { elapsed } from "./runGraph";
import { rowDetail, rowFailed } from "./timeline";
import type { AgentLearningView, Run, RunLearningDiff, RunSummary, TimelineRow } from "./v2";

export type LearningState = NonNullable<RunSummary["learning"]>["state"];
export type NoteType = LearningNote["type"];
/** `pending`: a note that changes what the agent trusts or skips (a site it trusts, an approval it skips, where money or
 *  data goes). No run reads it until the owner approves it. */
export type NoteStatus = LearningNote["status"];

/** A note a run started with (`given`), opened (`read`) or kept (`learned`, with the older notes it replaces), by its file
 *  and its name. */
export type NoteRef = NonNullable<NonNullable<RunSummary["learning"]>["given"]>[number];
export type LearnedRef = NonNullable<NonNullable<RunSummary["learning"]>["learned"]>[number];

/** A run's learning as a run or a list gives it (a list's has no `at`); null for a run that does not learn. `given`, the
 *  notes it started with; `read`, the note files it opened once it settled; `learned`, `pending`, `skills` and
 *  `workflows`, what it kept; each absent when there is none. */
export type RunLearning = (NonNullable<RunSummary["learning"]> & Partial<Pick<NonNullable<Run["learning"]>, "at">>) | null;
/** A skill or a workflow a run kept: its file (a SKILL.md, a workflow.json), its name, and whether it waits. */
export type LearnedFileRef = NonNullable<NonNullable<RunSummary["learning"]>["skills"]>[number];
/** A skill or a workflow the agent learned, as GET .../learning lists it (a newer server's): its name, its file (a
 *  workflow's README, `readme`, is the file an approval or a retire names), what it is for, whether it waits for the
 *  owner's OK or a person retired it (no later run is given it), the run that kept it, its size, and the version an
 *  approval or a retire names (`etag`). */
export type LearnedItem = (NonNullable<AgentLearningView["skills"]>[number] & { readme?: never }) | NonNullable<AgentLearningView["workflows"]>[number];
/** When a retired one was retired, and by whom (absent on one not retired): its retire commit, kept across later
 *  changes. */
export type Retired = NonNullable<LearningNote["retired"]>;
/** The newest change to an item's file, as the server names it (absent when it names none). */
export type LastChange = NonNullable<LearningNote["last_change"]>;
const VERBS: Record<LastChange["kind"], string> = { approved: "Approved", edited: "Edited", created: "Created", retired: "Retired", restored: "Restored", learned: "Learned", superseded: "Replaced" };
/** A change in words: "Approved by you", "Retired by a run". */
export const changeWords = (kind: LastChange["kind"], by: LastChange["by"]) => `${VERBS[kind]} by ${by === "person" ? "you" : "a run"}`;
/** The file that says whether a skill or a workflow is in use, which an approval and a retire name: a skill's SKILL.md, a
 *  workflow's README.md (never its workflow.json). */
export const statusFile = (item: Pick<LearnedItem, "file" | "readme">) => item.readme ?? item.file;

/** `etag`: the note's version, the same value as the file read's ETag, so an edit or a retire is made on the version a
 *  card showed without reading it again (absent from an older server's). */
/** `runs`: how many runs it was given to, and read in, as the server counts them. */
export type LearningNote = AgentLearningView["notes"]["items"][number];
/** One change to what the agent learned, newest first: a run's (`by.run`; `reason`, why it was kept) or a person's. */
export type LearningChange = AgentLearningView["log"]["items"][number];
export type LearningCounts = AgentLearningView["counts"];
/** One side of the before and after: how many runs, the median time to the answer, the median cost of the run's own work
 *  (null when no run's cost is known), and from a newer server how many runs that cost is of (`cost_runs`) and the median
 *  cost of learning itself (`median_learning_usd`). */
export type ImpactSide = NonNullable<Impact>["before"];
/** The agent's runs before its first kept note against its runs that started from one; null until each side has two. */
export type Impact = AgentLearningView["impact"];
/** GET /v2/agents/{id}/learning. `main` is null until the agent first learns. */
export type AgentLearning = AgentLearningView;
/** A note as GET .../learning/files/{file} answers it, and as a write answers it: its whole text and its version, as
 *  getAgent gives an agent and its ETag. */
export type NoteText = { note: string; etag: string | null };
/** The version of a note a person saw, which an edit or a retire of it is made on: the card's own `etag`, which every
 *  note the server lists carries, with no read. Only for a note with none (an older server's) is it read now, and is
 *  that version only if its text is still the text the card showed: `changed` when it is not (someone, or a run,
 *  changed it since), `unknown` when the server named no version. The one place this is decided. */
export type Seen = { kind: "same"; etag: string; text: string } | { kind: "changed"; now: NoteText } | { kind: "unknown" };
export async function seenVersion(note: Pick<LearningNote, "text"> & Partial<Pick<LearningNote, "etag">>, read: () => Promise<NoteText>): Promise<Seen> {
  if (typeof note.etag === "string" && note.etag) return { kind: "same", etag: note.etag, text: note.text };
  const now = await read();
  if (now.note !== note.text) return { kind: "changed", now };
  return now.etag ? { kind: "same", etag: now.etag, text: now.note } : { kind: "unknown" };
}
/** Said when the server named no version of a note: a write never goes without one (no empty If-Match). */
export const NO_VERSION = "Can't tell which version this is: reload.";
/** Said when the note changed since a card showed it. */
export const CHANGED = "It changed since you opened it.";
/** What a restore says before it is made: what it changes. */
export const RESTORES = "It becomes active again for the next run.";
/** A restore made by a token, not the owner's password sign-in: the server refuses it (403). */
export const RESTORE_SIGN_IN = "Restoring takes your password sign-in in the console.";

/** Why the server's checks refused a note a person wrote: each problem, printable. */
export type NoteProblem = { rule: string; path?: string; detail: string };

/** A note's file name, as the server takes one: at the folder's top, a letter or digit first, then letters, digits, dots,
 *  dashes and underscores, ending .md; never MEMORY.md, which the server builds. */
export const NOTE_FILE = /^(?!MEMORY\.md$)[A-Za-z0-9][A-Za-z0-9._-]{0,95}\.md$/;
export const NOTE_TYPES: readonly NoteType[] = ["feedback", "project", "reference", "user"];
/** Each type in plain words, as a card and the editor's picker show it (the API's value is in its tooltip). */
export const TYPE_LABEL: Record<NoteType, string> = { user: "About you", feedback: "How to work", project: "About the work", reference: "Where to look" };
export const typeLabel = (type: string) => TYPE_LABEL[type as NoteType] ?? type;
/** What each type is for, in Claude Code's own sense, for the editor's picker. */
export const TYPE_HINT: Record<NoteType, string> = {
  feedback: "How to work: a rule or a correction",
  project: "Facts about the work itself",
  reference: "Where to find things",
  user: "About the person it works for",
};

const UNDER_WAY: readonly string[] = ["seeded", "reflecting", "proposed"];
/** Whether a run's learning is still going (it may still keep a note). */
export const underWay = (l: RunLearning | undefined) => !!l && UNDER_WAY.includes(l.state);

/** The notes in a list the server sent, each a file and a name; anything else in it is skipped. */
const refs = <T extends NoteRef>(raw: unknown): T[] => (Array.isArray(raw) ? raw.filter((x): x is T => !!x && typeof x === "object" && typeof (x as NoteRef).file === "string" && typeof (x as NoteRef).name === "string") : []);
/** The notes a run started with, the notes it opened, and the notes it kept: empty when the server names none. */
export const givenBy = (l: RunLearning | undefined): NoteRef[] => refs(l?.given);
export const readBy = (l: RunLearning | undefined): NoteRef[] => refs(l?.read);
export const learnedBy = (l: RunLearning | undefined): LearnedRef[] => (l?.state === "merged" ? refs<LearnedRef>(l.learned) : []);
/** The notes a run kept that wait for the owner's OK; a run waiting with none named says so by its state alone. */
export const pendingBy = (l: RunLearning | undefined): NoteRef[] => refs(l?.pending);
/** The skills and the workflows a run kept, each in a list the server sent: empty from a server that does not say. */
const fileRefs = (raw: unknown): LearnedFileRef[] => refs<LearnedFileRef>(raw);
export const skillsBy = (l: RunLearning | undefined): LearnedFileRef[] => (l?.state === "merged" ? fileRefs(l.skills) : []);
export const workflowsBy = (l: RunLearning | undefined): LearnedFileRef[] => (l?.state === "merged" ? fileRefs(l.workflows) : []);
export const waitsForOk = (l: RunLearning | undefined) => pendingBy(l).length > 0;
/** The skills and workflows an agent learned, as a list the server sent: whole items only, none from an older server. */
export const learnedItems = (raw: unknown): LearnedItem[] => (Array.isArray(raw) ? raw.filter((x): x is LearnedItem => !!x && typeof x === "object" && typeof (x as LearnedItem).name === "string" && typeof (x as LearnedItem).file === "string" && typeof (x as LearnedItem).etag === "string") : []);
/** "1 skill", "2 workflows". */
export const counted = (n: number, one: "skill" | "workflow") => `${n} ${one}${n === 1 ? "" : "s"}`;

/** Whether a note waits for the owner's OK before any run reads it. */
export const isPending = (n: Pick<LearningNote, "status">) => n.status === "pending";
/** How many of an agent's learned items wait for its owner's OK: its `learning.pending` (GET /v2/agents and
 *  /v2/agents/{id}), counted on the server over its notes, skills and workflow drafts. 0 when the server leaves it out (an
 *  agent that doesn't learn, learning off, a learning folder it could not read), which shows nothing. */
export const waitingOf = (agent: { learning?: { pending: number } } | null | undefined): number => agent?.learning?.pending ?? 0;
/** The count's words, for its label: "2 learned items wait for your OK", "1 learned item waits for your OK". */
export const waitingWords = (n: number) => `${n} learned ${n === 1 ? "item waits" : "items wait"} for your OK`;
/** Who a note is from: the server's `origin` when it sends one, else its front matter's `origin:` line. A note from the
 *  person themselves reads "From you". */
export function originOf(n: Pick<LearningNote, "text"> & Partial<Pick<LearningNote, "origin">>): "you" | "run" | undefined {
  if (n.origin === "you" || n.origin === "run") return n.origin;
  for (const line of noteParts(n.text).rest) {
    const m = /^origin:\s*["']?(you|run)["']?\s*$/.exec(line);
    if (m) return m[1] as "you" | "run";
  }
  return undefined;
}
/** Whether this caller approves a waiting note from the console, by the server's capabilities: `yes` when
 *  `learning.approve` is true (the owner's password session); `password` when the server says approving needs the
 *  owner's password sign-in (`learning.approve_needs`); `later` from a server that says neither (it holds notes for the
 *  OK without the approve route). Only `yes` offers Approve. */
export type Approval = "yes" | "password" | "later";
export function approval(caps: unknown): Approval {
  const l = !!caps && typeof caps === "object" ? (caps as { learning?: { approve?: unknown; approve_needs?: unknown } }).learning : undefined;
  if (!l || typeof l !== "object") return "later";
  return l.approve === true ? "yes" : l.approve_needs === "password" ? "password" : "later";
}
/** Said on a waiting note while the server has no approve route. */
export const APPROVE_LATER = "Approving here comes in the next update; until then it stays out of every run.";
/** Said on a waiting note to a caller who is not signed in with the owner's password, where the server approves. */
export const APPROVE_SIGN_IN = "Approving needs your password sign-in. Until then it stays out of every run.";
/** Why a note waits, in one line. */
export const WAITS_WHY = "It changes what this agent trusts or skips, so it waits for you.";
/** Beside the notes that wait: what a run on the host can reach, and where an untrusted task runs instead. */
export const HOST_RUNS = "Runs that use bash on the host run as you. For untrusted tasks, use the sandbox.";

/** What a file name the server cut of a secret reads: shown, never linked. */
export const REDACTED = "[redacted]";

/** "1 note waits for your OK", "2 notes wait for your OK". */
export const waitWords = (n: number) => (n === 1 ? "1 note waits for your OK" : n > 1 ? `${n} notes wait for your OK` : "A note waits for your OK");

/** "1 note", "3 notes". */
export const notes = (n: number) => `${n} ${n === 1 ? "note" : "notes"}`;
export const runsWord = (n: number) => `${n} ${n === 1 ? "run" : "runs"}`;

/** What kind of outcome a dropped run's learning had: a note it wrote and that was not kept, nothing to keep, a skip
 *  with a fix, or a stop. The tab lists the first kind and counts the others. */
export type DropKind = "refused" | "nothing" | "skipped" | "stopped";
const KIND: Record<string, DropKind> = {
  grader: "refused", checker: "refused", screen: "refused", screen_down: "refused", unparsed: "refused",
  empty: "nothing",
  no_budget: "skipped", unknown_cost: "skipped", no_write_tool: "skipped", tool_denied: "skipped",
};
export const dropKind = (reason: string | null): DropKind => KIND[reason ?? ""] ?? "stopped";

/** Why a run kept nothing, in plain words: the server's own sentence when it sends one in a list (a newer server's),
 *  else the console's for the reason. A reason the console does not know reads as a stop, never as a code. */
const WORDS: Record<string, string> = {
  empty: "Nothing new to remember from this run.",
  unparsed: "Not kept: its notes weren't in the expected format.",
  grader: "Not kept: it wouldn't help later runs enough.",
  checker: "Not kept: it held something that must not be stored.",
  screen: "Not kept: it held something that must not be stored.",
  screen_down: "Not kept: it couldn't be checked for safety.",
  no_write_tool: "Not kept: this agent can't write notes (give it the write tool).",
  tool_denied: "Not kept: this agent isn't allowed to write notes.",
  no_budget: "Skipped: no budget left in this run to look back.",
  unknown_cost: "Skipped: no budget left in this run to look back.",
  seed_failed: "Started without its notes: they couldn't be read.",
  cancelled: "Not kept: learning stopped (the run was cancelled).",
  crashed: "Not kept: learning stopped (the run ended unexpectedly).",
  reflect_timeout: "Not kept: learning stopped (it ran out of time).",
  reflect_failed: "Not kept: learning stopped (an error).",
  propose_failed: "Not kept: learning stopped (an error).",
  grade_failed: "Not kept: learning stopped (the check couldn't run).",
};
export function dropWords(l: NonNullable<RunLearning>): string {
  if (l.detail && l.detail.trim()) return l.detail.trim();
  return WORDS[l.reason ?? ""] ?? "Not kept: learning stopped.";
}

/** A run's learning while it goes, in a few words. */
export const goingWords = (state: LearningState) => (state === "seeded" ? "Learns after the run" : "Looking back");

/** A median time, as the console writes how long a run took ("12s", "1m 05s"), to the nearest second (elapsed() alone
 *  cuts 3.8 s to 3s, which reads against the change beside it). */
export const took = (seconds: number) => elapsed(Math.round(seconds) * 1000);
/** A median cost, as the console writes a run's: the medians are of estimates, so each says so. */
export const money = (usd: number) => cost({ usd, basis: "estimate", charge_state: null, cap_usd: null });
/** The change from `a` to `b` as a whole percent: -33 is a third less. Null when `a` is not above zero. */
export const change = (a: number, b: number) => (a > 0 ? Math.round(((b - a) / a) * 100) : null);
/** Whether both sides' costs are known, so they can be set side by side. */
export const costsShown = (i: NonNullable<Impact>) => typeof i.before.median_cost_usd === "number" && typeof i.after.median_cost_usd === "number";
/** The median cost of learning itself on the after side, when the server says. */
export const learningCost = (i: NonNullable<Impact>) => (typeof i.after.median_learning_usd === "number" ? i.after.median_learning_usd : null);
/** The before and after in one line, as the card says it and a screen reader reads it, whichever way the numbers went:
 *  "Since it learned (on 4 runs): answers in 12s instead of 18s · $0.03 est. instead of $0.11 est. a run · learning
 *  itself $0.0080 est. a run". */
export function impactWords(i: NonNullable<Impact>): string {
  const parts = [`answers in ${took(i.after.median_duration_s)} instead of ${took(i.before.median_duration_s)}`];
  if (costsShown(i)) parts.push(`${money(i.after.median_cost_usd!)} instead of ${money(i.before.median_cost_usd!)} a run`);
  const learning = learningCost(i);
  if (learning !== null) parts.push(`learning itself ${money(learning)} a run`);
  return `Since it learned (on ${runsWord(i.after.runs)}): ${parts.join(" · ")}`;
}
/** Whether an impact the server sent is whole enough to show: both sides, two runs each, a duration each. */
export const shownImpact = (i: unknown): i is NonNullable<Impact> => {
  const side = (s: unknown) => !!s && typeof s === "object" && typeof (s as ImpactSide).runs === "number" && (s as ImpactSide).runs >= 2 && typeof (s as ImpactSide).median_duration_s === "number";
  return !!i && typeof i === "object" && side((i as { before?: unknown }).before) && side((i as { after?: unknown }).after);
};

// A note's front matter: `key: value` lines between two `---` lines, then the body. The editor shows the name, the
// description and the type as fields and the body as text, and keeps every other line (`supersedes`, a status) as it was.
const FRONT = /^---\n([\s\S]*?)\n?^---$\n?/m;
export type NoteParts = { name: string; description: string; type: NoteType; body: string; rest: string[] };
const unquote = (v: string) => (/^"[^"]*"$|^'[^']*'$/.test(v) ? v.slice(1, -1) : v);
/** A note's text in parts; one whose front matter does not read keeps it all in the body, for the server to refuse. */
export function noteParts(text: string): NoteParts {
  const lf = text.replace(/\r\n/g, "\n");
  const head = lf.startsWith("---\n") ? FRONT.exec(lf) : null;
  if (!head || head.index !== 0) return { name: "", description: "", type: "project", body: lf, rest: [] };
  const fields: Record<string, string> = {};
  const rest: string[] = [];
  for (const line of head[1]!.split("\n")) {
    const m = /^(name|description|type):(?:\s+(.*))?$/.exec(line);
    if (m && !(m[1]! in fields)) fields[m[1]!] = unquote((m[2] ?? "").trim());
    else if (line.trim()) rest.push(line);
  }
  const type = (NOTE_TYPES as readonly string[]).includes(fields.type ?? "") ? (fields.type as NoteType) : "project";
  return { name: fields.name ?? "", description: fields.description ?? "", type, body: lf.slice(head[0].length), rest };
}
/** One line of front matter's value: no line break, and in quotes when bare it would lose its own. */
const value = (v: string) => {
  const one = v.replace(/\s*\n\s*/g, " ").trim();
  if (!/^["'].*["']$/.test(one)) return one;
  return one.includes('"') ? `'${one}'` : `"${one}"`;
};
/** The parts as a note's whole text, the one a write sends. */
export const noteText = (p: NoteParts) => `---\nname: ${value(p.name)}\ndescription: ${value(p.description)}\ntype: ${p.type}\n${p.rest.map((l) => `${l}\n`).join("")}---\n${p.body.replace(/^\n*/, "\n")}`;
/** A note's body alone: its text past the front matter. */
export const bodyOf = (text: string) => noteParts(text).body.replace(/^\n+/, "");

/** A new note's file name from its name: lower case, words joined by dashes, `.md`. */
export function fileFor(name: string, taken: readonly string[] = []): string {
  const slug = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "note";
  let file = `${slug}.md`;
  for (let i = 2; taken.includes(file); i++) file = `${slug}-${i}.md`;
  return file;
}

/** Where a note is in the agent's Learning tab: one or more files to point at. */
export const learningHash = (agentId: string, files: readonly string[] = []) => {
  const named = files.filter((f) => f !== REDACTED);
  const q = new URLSearchParams(named.map((f) => ["note", f]));
  return `#/agents/${encodeURIComponent(agentId)}/learning${named.length ? `?${q}` : ""}`;
};

/** A timeline row as the console labels a run's learning: the row that says how it ended, and the message that starts
 *  the look back ("Looking back on this run.", the server's own words; it is not the person's), each read "Learning",
 *  without the chip that would say it again. An older server's look-back row, which carried the prompt, loses its
 *  "Learning: " prefix. Every other row is as it was. learningSteps calls it on each row it leaves as a row, and on each
 *  line of the look-back it folds. */
export function learningLabel(row: TimelineRow): TimelineRow {
  if (row.kind === LEARNING) return { ...row, agent_label: null };
  if (row.kind === "user_message" && row.agent_label === LEARNING) return { ...row, kind: LEARNING, agent_label: null, summary: (row.summary ?? "").replace(/^Learning:\s*/, "") };
  return row;
}
/** The label the server puts on every row of a run's learning, and the kind of the row that says how it ended. */
const LEARNING = "learning" as const;

/** How far a run's learning has got: it only moves forward, so of two reads the further one is the newer. */
const STAGE: Record<string, number> = { seeded: 0, reflecting: 1, proposed: 2, merged: 3, dropped: 3 };
const stage = (l: RunLearning | undefined) => (l ? STAGE[l.state] ?? 0 : -1);
/** The learning a timeline row of kind `learning` carries (`learning`: its state, reason and words), when it does. */
const rowLearning = (row: TimelineRow | undefined): RunLearning | undefined => {
  const l = (row as { learning?: unknown } | undefined)?.learning;
  return l && typeof l === "object" && typeof (l as { state?: unknown }).state === "string" ? (l as NonNullable<RunLearning>) : undefined;
};
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** The look-back's one step, in words, from where the run's learning stands: under way, what it kept by name, what
 *  waits for the OK (a merge that holds notes for it names them too), nothing new, or why nothing was kept. Never a
 *  file path. */
export function lookedBack(l: RunLearning | undefined): string {
  if (!l || stage(l) < 2) return "Looking back on this run…";
  if (l.state === "proposed") return `Looking back: ${lowerFirst(l.detail?.trim() || "Checking its new notes…")}`;
  const names = (refs: NoteRef[]) => refs.map((x) => x.name.replace(/\s+/g, " ").trim()).join(", ");
  if (l.state === "merged") {
    const kept = learnedBy(l);
    const waits = pendingBy(l);
    const said = [...(kept.length ? [`kept ${notes(kept.length)} (${names(kept)})`] : []), ...(waits.length ? [`${lowerFirst(waitWords(waits.length))} (${names(waits)})`] : [])];
    return said.length ? `Looked back: ${said.join("; ")}` : `Looked back. ${l.detail?.trim() || "It kept what it learned."}`;
  }
  if (dropKind(l.reason) === "nothing") return "Looked back: nothing new to keep";
  // The server's sentence as it is (its own words say what was not kept, a skill or a draft with it): never trimmed.
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
 *  `learning` (the look-back's message, whatever it did, its notes written as files or given as text, and the row that
 *  says how its learning ended) folds into one row, where the look-back began: "Looked back: kept 2 notes (Refund
 *  limit, Answer shape)", said from the run's learning (`learning`, the same the header's chips read, so the two agree)
 *  or from the timeline's own row when that one is further on. The rows it stands for open under it, each on its line,
 *  with "(failed)" when it failed, and under that, indented, what the row would open to on its own (a message's whole
 *  text, a call's input, a result's output) when that says more than its line. A run that did not look back (a skip)
 *  keeps its one learning row, labelled. Every other row is as it was. */
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

/** What a run's learning changed in its agent's notes, as GET /v2/runs/{id}/learning/diff answers: each file with its
 *  `patch` (git's hunks, no header), or why the server withholds it (`too_large`, or a value of its secrets in it). */
export type LearningDiff = RunLearningDiff;
export type LearningDiffFile = LearningDiff["files"][number];
/** A line of a note's text before or after: unchanged (`same`), taken out (`removed`), new (`added`), or a `gap` where
 *  unchanged lines are left out. */
export type DiffLine = { text: string; mark: "same" | "removed" | "added" | "gap" };
/** One note a run's learning changed, in words ("Added: Refund limit"), with its text before and after: null where
 *  there was none, or where the server withholds it (`withheld`, why, in words). */
export type NoteChange = { file: string; said: string; before: DiffLine[] | null; after: DiffLine[] | null; withheld?: string };

const WITHHELD: Record<string, string> = { too_large: "It's too large to show here.", secret: "Not shown: it holds one of this server's secrets." };
const SAID_ORDER = ["Added", "Replaced", "Retired", "Removed", "Changed"];

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

/** What a run's learning changed, note by note, in a person's words: each note it added, replaced (with the note that
 *  replaces it), retired or removed, by its name (as the run's `learned`, `given` and `read` name it, else its own `name:` line,
 *  else its file), added first. The index (MEMORY.md) is not a note, and is left out. */
export function noteChanges(diff: LearningDiff, learning: RunLearning | undefined): NoteChange[] {
  const files = diff.files.filter((f) => f.path !== "MEMORY.md");
  const parts = new Map(files.map((f) => [f.path, f.patch === undefined ? null : sides(f.patch)]));
  const known = new Map([...givenBy(learning), ...readBy(learning), ...learnedBy(learning)].map((r) => [r.file, r.name]));
  const nameOf = (file: string) => {
    const p = parts.get(file);
    const line = [...(p?.after ?? []), ...(p?.before ?? [])].find((l) => l.mark !== "gap" && /^name:\s*\S/.test(l.text));
    return known.get(file) ?? line?.text.replace(/^name:\s*/, "").trim() ?? file.replace(/\.md$/, "");
  };
  const out = files.map((f): NoteChange => {
    const p = parts.get(f.path);
    const name = nameOf(f.path);
    const added = (p?.after ?? []).filter((l) => l.mark === "added").map((l) => l.text.trim());
    const by = added.find((l) => l.startsWith("superseded_by:"))?.replace(/^superseded_by:\s*/, "") ?? learnedBy(learning).find((r) => r.supersedes?.includes(f.path))?.file;
    const said = f.status === "added" ? `Added: ${name}`
      : f.status === "deleted" ? `Removed: ${name}`
      : added.includes("status: superseded") || (!p && by) ? `Replaced: ${name}${by ? ` → ${nameOf(by)}` : ""}`
      : added.includes("status: retired") ? `Retired: ${name}` : `Changed: ${name}`;
    if (!p) return { file: f.path, said, before: null, after: null, withheld: WITHHELD[f.withheld ?? ""] ?? "Not shown." };
    return { file: f.path, said, before: f.status === "added" ? null : p.before, after: f.status === "deleted" ? null : p.after };
  });
  return out.sort((a, b) => SAID_ORDER.indexOf(a.said.split(":")[0]!) - SAID_ORDER.indexOf(b.said.split(":")[0]!));
}

/** The run that first kept each note, and the last time a person changed it, from the changes on the page read. */
export function provenance(log: readonly LearningChange[]): Map<string, { run?: { id: string; at: string; reason: string } }> {
  const out = new Map<string, { run?: { id: string; at: string; reason: string } }>();
  // Newest first: the last run seen for a file is its first. Every file a change names is in the map (its source read),
  // a person's too; who changed it since is the server's to name (last_change), never read from here.
  for (const c of log) {
    for (const f of c.files) {
      const at = out.get(f) ?? {};
      if ("run" in c.by) at.run = { id: c.by.run, at: c.at, reason: c.reason };
      out.set(f, at);
    }
  }
  return out;
}
