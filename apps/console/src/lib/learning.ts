// What an agent learns, as the server's learning routes give it (GET /v2/agents/{id}/learning, a run's `learning`), and
// the words the console says it in. The notes are Claude Code's auto-memory files: front matter (`name`, `description`,
// `type`) and a markdown body. A newer server adds what a run read and what it kept (`used`, `learned`), the agent's
// before and after (`impact`) and a plain sentence for each outcome (`detail`); each is read only when it is there, so an
// older server's answer shows less and never breaks.

import type { TimelineRow } from "./v2";

export type LearningState = "seeded" | "reflecting" | "proposed" | "merged" | "dropped";
export type NoteType = "user" | "feedback" | "project" | "reference";
export type NoteStatus = "active" | "superseded" | "retired";
export type Page<T> = { items: T[]; total: number; next_cursor: string | null };

/** A note a run read (`used`) or kept (`learned`, with the older notes it replaces), by its file and its name. */
export type NoteRef = { file: string; name: string };
export type LearnedRef = NoteRef & { supersedes?: string[] };

/** A run's learning as a run or a list gives it; null for a run that does not learn. A list from an older server
 *  carries only `state` and `reason`. */
export type RunLearning = {
  state: LearningState;
  reason: string | null;
  detail?: string | null;
  at?: string;
  used?: NoteRef[];
  learned?: LearnedRef[];
} | null;

export type LearningNote = { file: string; name: string; description: string; type: NoteType; status: NoteStatus; superseded_by: string | null; text: string };
/** One change to what the agent learned, newest first: a run's (`by.run`; `reason`, why it was kept) or a person's. */
export type LearningChange = { by: { run: string } | { user: true }; commit: string; at: string; reason: string; files: string[] };
export type LearningCounts = { merged: number; dropped: Record<string, number>; in_progress: number };
/** One side of the before and after: how many runs, the median time to the answer, the median cost of the run's own work
 *  (null when no run's cost is known), and from a newer server how many runs that cost is of (`cost_runs`) and the median
 *  cost of learning itself (`median_learning_usd`). */
export type ImpactSide = { runs: number; median_duration_s: number; median_cost_usd: number | null; cost_runs?: number; median_learning_usd?: number | null };
/** The agent's runs before its first kept note against its runs that started from one; null until each side has two. */
export type Impact = { before: ImpactSide; after: ImpactSide } | null;
/** GET /v2/agents/{id}/learning. `main` is null until the agent first learns. */
export type AgentLearning = { agent: string; main: string | null; index: string; notes: Page<LearningNote>; log: Page<LearningChange>; counts: LearningCounts; impact?: Impact };
/** A note as GET .../learning/files/{file} answers it, and as a write answers it: its whole text and its version. */
export type NoteText = { text: string; etag: string | null };
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
/** The notes a run read, and the notes it kept: empty from a server that does not say. */
export const usedBy = (l: RunLearning | undefined): NoteRef[] => refs(l?.used);
export const learnedBy = (l: RunLearning | undefined): LearnedRef[] => (l?.state === "merged" ? refs<LearnedRef>(l.learned) : []);

/** What a file name the server cut of a secret reads: shown, never linked. */
export const REDACTED = "[redacted]";

/** "1 note", "3 notes". */
export const notes = (n: number) => `${n} ${n === 1 ? "note" : "notes"}`;
export const runsWord = (n: number) => `${n} ${n === 1 ? "run" : "runs"}`;

/** What kind of outcome a dropped run's learning had: a note it wrote and that was not kept, nothing to keep, a skip
 *  with a fix, or a stop. The tab lists the first kind and counts the others. */
export type DropKind = "refused" | "nothing" | "skipped" | "stopped";
const KIND: Record<string, DropKind> = {
  grader: "refused", checker: "refused", screen: "refused", screen_down: "refused",
  empty: "nothing",
  no_budget: "skipped", unknown_cost: "skipped", no_write_tool: "skipped", tool_denied: "skipped",
};
export const dropKind = (reason: string | null): DropKind => KIND[reason ?? ""] ?? "stopped";

/** Why a run kept nothing, in plain words: the server's own sentence when it sends one in a list (a newer server's),
 *  else the console's for the reason. A reason the console does not know reads as a stop, never as a code. */
const WORDS: Record<string, string> = {
  empty: "Nothing new to remember from this run.",
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

/** "18s", "1m 05s": a duration in seconds as the console writes run times. */
export function seconds(s: number): string {
  // Under ten seconds a tenth still tells two runs apart: 1.2s, 9.8s.
  if (s < 9.95) return `${Math.max(0, Math.round(s * 10) / 10)}s`;
  const t = Math.max(0, Math.round(s));
  const m = Math.floor(t / 60);
  return m ? `${m}m ${String(t % 60).padStart(2, "0")}s` : `${t}s`;
}
/** A median cost, to two significant figures: $0.11, $0.031, $1.20. */
export function dollars(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd <= 0) return "$0";
  if (usd < 0.000001) return "<$0.000001";
  // Two significant figures, at least two decimals: $0.03, not $0.030; $0.10, not $0.1.
  const v = Number(usd.toPrecision(2));
  const decimals = (String(v).split(".")[1] ?? "").length;
  return `$${decimals < 2 ? v.toFixed(2) : v.toFixed(Math.min(6, decimals))}`;
}
/** The change from `a` to `b` as a whole percent: -33 is a third less. Null when `a` is not above zero. */
export const change = (a: number, b: number) => (a > 0 ? Math.round(((b - a) / a) * 100) : null);
/** Whether both sides' costs are known, so they can be set side by side. */
export const costsShown = (i: NonNullable<Impact>) => typeof i.before.median_cost_usd === "number" && typeof i.after.median_cost_usd === "number";
/** The median cost of learning itself on the after side, when the server says. */
export const learningCost = (i: NonNullable<Impact>) => (typeof i.after.median_learning_usd === "number" ? i.after.median_learning_usd : null);
/** The before and after in one line, as the card says it and a screen reader reads it, whichever way the numbers went:
 *  "Since it learned (on 4 runs): answers in 12s instead of 18s · $0.03 instead of $0.11 a run · learning itself ≈
 *  $0.008 a run". */
export function impactWords(i: NonNullable<Impact>): string {
  const parts = [`answers in ${seconds(i.after.median_duration_s)} instead of ${seconds(i.before.median_duration_s)}`];
  if (costsShown(i)) parts.push(`${dollars(i.after.median_cost_usd!)} instead of ${dollars(i.before.median_cost_usd!)} a run`);
  const learning = learningCost(i);
  if (learning !== null) parts.push(`learning itself ≈ ${dollars(learning)} a run`);
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

/** A run's title cut to about `max` characters for a line that names it, its start and its end kept (a run's title is
 *  its first message, whose end often says what it was about): "Find this shop's…brooklinen.com". */
export function shortTitle(title: string, max = 40): string {
  const t = title.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const tail = Math.floor((max - 1) * 0.45);
  // Each side cut at a word's edge: the head back to its last space, the tail on past a cut word's rest.
  let head = t.slice(0, max - 1 - tail);
  const space = head.lastIndexOf(" ");
  if (space > head.length / 2) head = head.slice(0, space);
  let end = t.slice(t.length - tail);
  const edge = /\W/.exec(end);
  if (/\w/.test(t[t.length - tail - 1] ?? "") && edge && edge.index < end.length / 2) end = end.slice(edge.index + 1);
  return `${head.trimEnd()}…${end.trimStart()}`;
}

/** A timeline row as the console labels a run's learning: the row that says how it ended reads "Learning", and the
 *  message the server sends to start the look back reads "Looking back" (it is not the person's), each without the chip
 *  that would say it again. Every other row is as it was. The timeline calls it once a row. */
export function learningLabel(row: TimelineRow): TimelineRow {
  if (row.kind === "learning") return { ...row, kind: "Learning", agent_label: null };
  if (row.kind === "user_message" && row.agent_label === "learning") return { ...row, kind: "Looking back", agent_label: null, summary: row.summary.replace(/^Learning:\s*/, "") };
  return row;
}

/** The run that first kept each note, and the last time a person changed it, from the changes on the page read. */
export function provenance(log: readonly LearningChange[]): Map<string, { run?: { id: string; at: string; reason: string }; edited?: string }> {
  const out = new Map<string, { run?: { id: string; at: string; reason: string }; edited?: string }>();
  // Newest first: the last run seen for a file is its first, and the first person's change seen is the latest.
  for (const c of log) {
    for (const f of c.files) {
      const at = out.get(f) ?? {};
      if ("run" in c.by) at.run = { id: c.by.run, at: c.at, reason: c.reason };
      else if (!at.edited) at.edited = c.at;
      out.set(f, at);
    }
  }
  return out;
}
