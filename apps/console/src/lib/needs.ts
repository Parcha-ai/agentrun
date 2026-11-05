import type { Run } from "./v2";

// What Mission Control's "Needs you" strip reads from the runs lists: the choices a question offers, the failures
// grouped by their error, and whether the owner has run anything of their own yet.

/** A question's sentence that asks rather than offers: "Which…?", "Should I…?". Its "or" joins words, not answers. */
const ASKS = /^(which|what|who|whom|whose|where|when|why|how|should|shall|do|does|did|is|are|was|were|can|could|would|will|may|might)\b/i;
const MAX_CHOICE = 40;

/** The answers a question plainly offers, as one-tap choices: the options after its last colon ("…applies: the $5,000
 *  standard or the $25,000 preferred tier?"), or an either-or request ("Approve an exception, or offer store credit
 *  instead?"). An open or yes-or-no question offers none, and neither does one whose options are too long for a button. */
export function choicesOf(question: string): string[] {
  const text = question.trim().replace(/\?+$/, "");
  const colon = text.lastIndexOf(":");
  const sentence = (colon >= 0 ? text.slice(colon + 1) : text.split(/(?<=[.!?])\s+/).at(-1) ?? "").trim();
  if (colon < 0 && ASKS.test(sentence)) return [];
  const parts = sentence.split(/,?\s+or\s+|,\s+/i).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2 || parts.length > 4 || !/\bor\b/i.test(sentence)) return [];
  const choices = parts.map((p) => p.replace(/^(the|a|an)\s+/i, "").replace(/\s+instead$/i, ""));
  if (choices.some((c) => !c || c.length > MAX_CHOICE)) return [];
  // A phrase reads as a button label, capitalized; a bare token (us-east) is kept as written.
  return choices.map((c) => (/\s/.test(c) ? c[0]!.toUpperCase() + c.slice(1) : c));
}

/** Failures that need a person, grouped by what stopped them: the same error once, with every run it stopped, the most
 *  recent group first. Imported history is never here: it can't be run again. */
export function failureGroups(failed: readonly Run[]): { message: string; runs: Run[] }[] {
  const groups = new Map<string, Run[]>();
  for (const r of failed) {
    if (r.imported_from) continue;
    const message = r.error?.message?.trim() || "The run failed.";
    groups.set(message, [...(groups.get(message) ?? []), r]);
  }
  const at = (r: Run) => Date.parse(r.ended_at ?? r.created_at);
  return [...groups].map(([message, runs]) => ({ message, runs: runs.sort((a, b) => at(b) - at(a)) }))
    .sort((a, b) => at(b.runs[0]!) - at(a.runs[0]!));
}

/** Whether the owner has run anything here yet: a recent run not imported, or the analytics' runs started here
 *  (`by_source` "live"). Until then Mission Control shows its start-here panel. */
export function hasOwnRun(recent: readonly Run[], bySource: readonly { source: string; runs: number }[]): boolean {
  return recent.some((r) => !r.imported_from) || bySource.some((g) => g.source === "live" && g.runs > 0);
}

/** How long ago `iso` was, as a person says it: "30 s", "9 min", "3 h", "2 days". */
export function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86_400)} days`;
}

/** The longest text a timeline row keeps: a longer one keeps its start and ends in "..." (the run timeline's text cap). */
const TIMELINE_TEXT_CAP = 2000;

/** The start of "Run again": the run's whole first message, with its effort and its spend cap, or why it can't be
 *  started again from here. A workflow run takes typed input, and a first message the timeline cut would start a
 *  shortened task: both are refused. */
export function rerunBody(run: Run, firstMessage: string | null | undefined): { body: { input: { content: string }; effort?: string; max_cost_usd?: number } } | { refusal: string } {
  if (run.kind === "workflow") return { refusal: `"${run.title}" is a workflow run: start it again from its agent's page` };
  if (!firstMessage) return { refusal: `"${run.title}": its first message could not be read` };
  if (firstMessage.length >= TIMELINE_TEXT_CAP && firstMessage.endsWith("...")) return { refusal: `"${run.title}": its first message is longer than the timeline keeps; start it again from its agent's page` };
  // A run given files has a line after its first message naming them (serve's run manifest). A run started again takes
  // only a message, and the run's read doesn't carry its files' ids, so it would start without them: refused instead.
  if (/\n\nFiles for this run: [^\n]*$/.test(firstMessage)) return { refusal: `"${run.title}" was given files, which a run started again can't take along: start it again from its agent's page with them` };
  const cap = run.cost?.cap_usd;
  return { body: { input: { content: firstMessage }, ...(run.effort ? { effort: run.effort } : {}), ...(typeof cap === "number" ? { max_cost_usd: cap } : {}) } };
}

/** Calls `read` now, and again `every` ms after each read has settled (landed or failed), never two at once: an older
 *  read can't land after a newer one. The answer stops it; a read in flight then lands into nothing more. */
export function pollSettled(read: () => Promise<unknown>, every: number): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const next = () => { if (!stopped) void read().catch(() => {}).finally(() => { if (!stopped) timer = setTimeout(next, every); }); };
  next();
  return () => { stopped = true; clearTimeout(timer); };
}

export type Needs = { asking: Run[]; failed: Run[]; live: Run[] };
/** Whether a run asks a person for something: its served `pending` names what it waits on (a question today; any kind
 *  the server sends counts, none is named here). Needs you lists exactly these, and the Needs input tile counts them,
 *  so the two never disagree. A run the person stopped (input_required, idle) has none: it asks nothing. */
export const asksPerson = (run: Pick<Run, "pending">) => run.pending != null;
/** A run the person stopped: input_required and idle (the server's "stopped"), with nothing pending. It waits for a
 *  message, never for an answer. */
export const stoppedRun = (run: Pick<Run, "status" | "state" | "pending">) => run.status === "input_required" && run.state !== "waiting" && !asksPerson(run);
const SECTIONS = [["asking", "The runs asking a question"], ["failed", "The failed runs"], ["live", "The running runs"]] as const;

/** The strip's three reads, landed apart: each that landed is taken, one that failed keeps the section's last answer,
 *  and `problem` names what could not be read (null when all landed). */
export function mergeNeeds(prev: Needs | null, reads: readonly PromiseSettledResult<Run[]>[]): { needs: Needs; problem: string | null } {
  const needs = { asking: prev?.asking ?? [], failed: prev?.failed ?? [], live: prev?.live ?? [] };
  const problems: string[] = [];
  SECTIONS.forEach(([key, name], i) => {
    const read = reads[i];
    if (read?.status === "fulfilled") needs[key] = read.value;
    else if (read) problems.push(`${name} could not be read: ${read.reason instanceof Error ? read.reason.message : String(read.reason)}`);
  });
  return { needs, problem: problems.length ? problems.join(" · ") : null };
}
