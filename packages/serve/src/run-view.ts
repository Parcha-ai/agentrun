// A run's served view, as pure functions over the run's rows (its timeline) and what the store kept, separate from how the
// run is held or read. The server cut feeds these from the one store's readers; before it, runs.ts feeds them from a run's
// in-memory rows. The functions move here unchanged, so the figures and words a person sees do not change: the extraction
// is what the existing view, cost and timeline tests already pin.
//
// The pieces here so far: the cost reads (a run's cost, its paid tools' charges, the cost a view shows, what it has cost so
// far when the total is unknown) and the served row transforms a view applies to the timeline (the over-cap row, the
// paused run's waiting row). All read the same rows the timeline renders.
import { NOTE_SUFFIX, type TimelineEvent, chargedTool, isMessageRow, registerLabel, registerTurnEnding, scrubUrls } from "@parcha/pi-durable-agent/timeline";
import type { RevisionKind } from "@parcha/pi-durable-agent";
import { CAP_TOLERANCE, FIT_TOLERANCE, money, type RefusalFigures, roomRefusal } from "./cap.js";
import { servedOnly } from "./served-only.js";
import type { Turns } from "./turns.js";
import type { PendingAsk } from "./browser-person.js";
import { APPROVAL_ROW, type PendingApproval, previewOf } from "./tool-gate.js";
import { ASK_TOOL } from "./tools.js";
import { LEARNING_LABEL } from "./learning.js";
import { builtinHarness } from "./harness-table.js";
import { cutStrings, redacted, withoutLoopback } from "./key-refusal.js";
import { pointerHash, type signInReads } from "./sign-ins-store.js";
import { MIN_SECRET } from "./learn/secrets.js";

/** The sign-in read surface a run's served view needs: a run's handed-pointer cut reads only `peek` (the agent's saved
 *  pointer) and `forgotten` (its tombstoned ones), over the store (sign-ins-store.ts signInReads). */
export type SignInReader = ReturnType<typeof signInReads>;
import { KINDS } from "./runner/journal-kinds.js";

/** The run's newest usage row, which carries its cost. */
const usageOf = (rows: readonly TimelineEvent[]) => rows.findLast((r) => r.kind === "usage");

/** The run's cost from its usage row: null when a response's cost is unknown, 0 before any request. */
export const costOf = (rows: readonly TimelineEvent[]): number | null => {
  const usage = usageOf(rows);
  return usage ? (usage.usage?.usd ?? null) : 0;
};

/** Whether `row` carries a paid tool's charge counted here: `tool`'s alone when given, every other tool's with `others`
 *  (chargedTool: a charge's own `phase` row, or a browser call's row its charges fold into). */
const chargeOf = (row: TimelineEvent, tool: string | undefined, others: boolean): boolean => {
  const charged = chargedTool(row);
  return charged !== undefined && (tool === undefined || (others ? charged !== tool : charged === tool));
};

/** What a run's paid tools charged (`tool`'s alone, when given; every other tool's with `others`), from the same rows its
 *  cost is read from: each charge's line carries it (`usage` on a `phase` row), and a browser call's row what its charges
 *  came to; null when one is unknown. A call still marked, in flight or cut, is no charge here. */
export const toolCostOf = (rows: readonly TimelineEvent[], tool?: string, others = false): number | null =>
  rows.reduce<number | null>((sum, row) => (!chargeOf(row, tool, others) ? sum : sum === null || row.usage!.usd === null ? null : sum + row.usage!.usd), 0);

/** What a run's paid tools are known to have charged (`tool`'s alone, when given; every other tool's with `others`): each
 *  charge's line that names its cost, a charge of unknown cost adding nothing (a browser call's row, what is known of it). */
export const knownToolCostOf = (rows: readonly TimelineEvent[], tool?: string, others = false): number =>
  rows.reduce((sum, row) => (!chargeOf(row, tool, others) ? sum : sum + (row.usage!.usd ?? row.usage!.so_far_usd ?? 0)), 0);

/** A run's cost for its views: its usage row's, else what the store kept when it carried the run back (0 before any
 *  request). A usage row that says unknown, or says nothing, stays unknown: what the store kept dates from before a
 *  follow-up. */
export function costView(rows: readonly TimelineEvent[], stored: number | null | undefined, decisions?: number | null): number | null {
  const usage = usageOf(rows);
  // A workflow run's decisions, once its end is read: their cost joins its model nodes', and one unknown makes it unknown.
  if (decisions !== undefined) {
    const models = usage ? (usage.usage?.usd ?? null) : 0;
    return models === null || decisions === null ? null : models + decisions;
  }
  if (!usage) return stored === undefined ? 0 : stored;
  return usage.usage?.usd ?? null;
}

/** What a run whose cost is unknown has cost so far (costsofar/1): the sum of its charges whose cost is known, and how many
 *  have none, from its usage row, plus a workflow's decisions (`decisions`: their known sum and how many are not known;
 *  null when they could not be read, which says nothing). Undefined while the cost is known, when the row says neither
 *  (an older run's), or when a workflow's decisions are unreadable. No ceiling is claimed. */
export type SoFar = { so_far_usd: number; unpriced: number };
export function soFarOf(rows: readonly TimelineEvent[], decisions?: { known: number; unpriced: number } | null): SoFar | undefined {
  if (decisions === null) return undefined;
  const usage = usageOf(rows)?.usage;
  const models = !usage ? { known: 0, unpriced: 0 } : usage.usd !== null ? { known: usage.usd, unpriced: 0 } : usage.so_far_usd !== undefined && usage.unpriced !== undefined ? { known: usage.so_far_usd, unpriced: usage.unpriced } : undefined;
  if (!models) return undefined;
  const unpriced = models.unpriced + (decisions?.unpriced ?? 0);
  return unpriced > 0 ? { so_far_usd: Math.round((models.known + (decisions?.known ?? 0)) * 1e6) / 1e6, unpriced } : undefined;
}

/** An amount in an over-cap row's or failure's words, to the cent ($0.38020940000000003 is $0.38; $1 is $1), as money
 *  says it; `centsUp` to the cent above, for what a run went over by and a bound, so neither reads $0 or under. */
export const cents = (usd: number): string => money(Math.round(usd * 100) / 100);
export const centsUp = (usd: number): string => money(Math.ceil(usd * 100 - 1e-9) / 100);
/** Whether a run that spent `usd` passed its `cap` by no more than `bound`, the bounds of the requests that ended since
 *  its cost last fit (bounds.ts): a cache miss an expected-cost cap (cap.ts) admits the risk of, never a cap the run's own
 *  rule broke. */
export const overByMiss = (usd: number, cap: number, bound: number): boolean => bound > 0 && usd - cap <= bound + FIT_TOLERANCE;

/** The row that says a run's booked spend passed its cap, and by how much, after its usage row: a request's cost is
 *  booked once it answers, never clipped, and under an expected-cost cap (cap.ts) a request that missed the cache can cost
 *  up to its bound beyond what it was admitted at; one carrying a native web search is held at an allowance, not a bound,
 *  so a run can pass its cap by its last request. The next request is then refused. `bound`: the requests' that ended since the cost last fit,
 *  bound; when the run passed its cap by no more than it, the row says a cache miss did it, and the most it could have. */
export function withOverCap(rows: TimelineEvent[], cap: number | undefined, bound = 0): TimelineEvent[] {
  const at = rows.findLastIndex((row) => row.kind === "usage");
  const usd = rows[at]?.usage?.usd;
  if (cap === undefined || typeof usd !== "number" || usd <= cap + FIT_TOLERANCE) return rows;
  const { usage: _, ...usage } = rows[at]!;
  // In cents: what it went over by and the bound rounded up, so "at most" holds.
  const summary = overByMiss(usd, cap, bound) ? `Went ${centsUp(usd - cap)} over its cap on a cache miss (at most ${centsUp(bound)}).` : `Spent ${cents(usd)}, ${centsUp(usd - cap)} over the run's cap of ${cents(cap)}`;
  const over: TimelineEvent = { ...usage, id: `${usage.id}:over_cap`, kind: "phase", summary, text: null };
  return [...rows.slice(0, at + 1), over, ...rows.slice(at + 1)];
}

/** The row of a refusal for room a run paused at (servedError): the server's `phase` row in these words (origin server,
 *  its id the refusal's with NOTE_SUFFIX, so it is no message: isMessageRow), marked `paused`, never an error row. The
 *  refusal's sentence is the pause's (pending.said), which a client shows once, as its banner. */
export const BUDGET_PAUSED = "Paused at the run's cap";
/** The waiting row of a run paused at its cap, after the refusal's row: "Waiting for you to raise the cap", and no
 *  more: the refusal's words are the pause's (pending.said), which a client shows once, as its banner. */
export const BUDGET_WAITING = "Waiting for you to raise the cap";
export function withPaused(rows: readonly TimelineEvent[]): TimelineEvent[] {
  const at = rows.findLastIndex((row) => row.paused === true);
  if (at < 0) return [...rows];
  // The refusal's own marker (`paused`, servedError) and the server's origin stay on the refusal's row: the waiting row
  // is no refusal and no row of the server's, and keeps the id it had, the refusal's own with ":paused".
  const { paused: _marker, origin: _origin, ...refusal } = rows[at]!;
  const own = refusal.id.endsWith(NOTE_SUFFIX) ? refusal.id.slice(0, -NOTE_SUFFIX.length) : refusal.id;
  // Only the served view makes it (servedOnly): once the run is raised, show() stops making it and it goes, even while a
  // live process feeds the timeline (keepCommitted).
  const paused: TimelineEvent = servedOnly({ ...refusal, id: `${own}:paused`, kind: "waiting", summary: BUDGET_WAITING, text: BUDGET_WAITING, tool_name: null, tool_use_id: null, tool_status: null, tool_input_preview: null, tool_result_preview: null, tool_result_size_bytes: null });
  return [...rows.slice(0, at + 1), paused, ...rows.slice(at + 1)];
}

/** A text clipped to `max` characters, with an ellipsis where it is cut (runs.ts' clip). */
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const ASKED = "Asked you: ";
// ask_person's label and that it ends its turn: a person's reply is their next message, never a steer (runs.ts). Registered
// here so both the file path and the store-backed view render the call the same, whichever module loads first.
registerLabel(ASK_TOOL, (args) => `${ASKED}${typeof args.question === "string" ? args.question : ""}`, undefined, { name: "Ask you a question" });
registerTurnEnding(ASK_TOOL);

/** The waiting row after each answered `ask_person` call, which the timeline module does not know. The question comes from
 *  the call's row, whose label this module registers. The server fed its rows through this; the store-backed view feeds the
 *  same rows through it, so a run waiting on a question reads the same pending. */
export function withAsks(rows: readonly TimelineEvent[]): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  const questions = new Map<string, string>();
  for (const row of rows) {
    out.push(row);
    if (row.kind === "tool_use" && row.tool_name === ASK_TOOL && row.tool_use_id && row.summary?.startsWith(ASKED)) questions.set(row.tool_use_id, row.summary.slice(ASKED.length));
    if (row.kind === "tool_result" && row.tool_name === ASK_TOOL && row.tool_status === "success") {
      const question = questions.get(row.tool_use_id ?? "") || "the agent asked you a question";
      out.push({ ...row, id: `${row.id}:waiting`, kind: "waiting", summary: `Waiting for you: ${clip(question, 480)}`, text: clip(question, 2000), tool_name: null, tool_use_id: null, tool_status: null, tool_input_preview: null, tool_result_preview: null, tool_result_size_bytes: null });
    }
  }
  return out;
}

// --- A run's status and what it waits on, as pure functions over the run's rows, its turns and its store entries (its
// approvals and cap marks), with the file-backed facts (a workflow's pause, the browser ask) passed in. The server feeds
// these from its live Run; the store-backed view (viewOverStore) feeds the same functions from a row and the journal, so
// the status and the pending card a person or a model sees stay byte-identical. The functions move here unchanged: the
// extraction is what the existing status, stop-position and view tests already pin. ---

export type Status = "queued" | "working" | "paused" | "input_required" | "completed" | "failed" | "cancelled";
export type State = "working" | "waiting" | "idle";

/** A tool call that waited for a person's approval, as the run's store has it (tool-gate.ts): `resolved` once the run's
 *  process acted on the answer. */
export type Approval = { id: string; tool: string; call_id: string; args_json: string; requested_at: string; price?: number | "not metered"; resolved?: true };
/** `args_shown`: the call's arguments as the server shows them (shownArgs), which the gate's resume message names. */
/** `by`: "message", a deny a person's message gave while the call waited (Runs.message). */
/** `superseded`: the answer a stop or a cancel overrode before the run's process acted on it, kept as it was given. */
/** `ended`: a withdrawal by a run that ended (completed or failed) with the call waiting, which nobody stopped. */
export type ApprovalAnswer = { decision: "allow" | "deny" | "canceled" | "withdrawn"; note?: string; answered_at: string; args_shown?: string; by?: "message"; superseded?: { decision: string; answered_at: string; note?: string; by?: "message" }; ended?: true };
/** A call withdrawn with its run (a cancel, or a stop while it waited): never run, and an answer after is 409. */
export const withdrawn = (answer: ApprovalAnswer | undefined) => answer?.decision === "canceled" || answer?.decision === "withdrawn";

// --- The approvals a store-backed run waits (or waited) on, read from its journal, where the file-backed path read them
// from the run's own store entries (runs.ts noteApprovals). The runner writes an `agentrun.ask` entry for each tool call
// the gate parked the run on, and an `agentrun.answer` entry for the person's answer, taken by the commit that takes the
// approve or deny row. These build the Approval map and the answers the status, pending and moment views read, so the
// card and the answered state a person sees stay the same. An approval is keyed by the call's id throughout (the answer
// command names the call), so the card's id is the call's id. ---

/** An `agentrun.ask` entry's data: the tool call the gate parked for a person, as the runner wrote it. */
type AskEntry = { callId: string; tool: string; args: unknown; requestedAt: string; price?: number | "not metered" | null };
/** An `agentrun.answer` entry's data: the person's answer the runner wrote, or a withdrawal when the run was stopped or
 *  cancelled while the call waited. */
type AnswerEntry = { callId: string; approved?: boolean; decision?: "allow" | "deny" | "withdrawn"; answeredAt?: string; note?: string; by?: "message"; superseded?: { decision: string; answeredAt?: string } };
/** The least a journal entry a reader here reads is: its kind and its data. */
type JournalEntry = { kind?: string; data?: unknown };
const dataOf = <T>(entry: JournalEntry): T => entry.data as T;

/** The tool calls a run waits (or waited) for a person's approval on, from its journal's `agentrun.ask` entries, by the
 *  call's id: a re-ask of the same call keeps the first request, as the gate's park did; one with an answer is resolved,
 *  so the run waits on it no more (the file path's `resolved` once its process acted). The card's id and call id are both
 *  the call's id, and its arguments are kept as JSON (shown cut and redacted by the view), as the file path kept them. */
export function asksOf(entries: readonly JournalEntry[]): Map<string, Approval> {
  const answered = new Set<string>();
  for (const entry of entries) if (entry.kind === KINDS.answer) { const d = dataOf<AnswerEntry>(entry); if (typeof d?.callId === "string") answered.add(d.callId); }
  const map = new Map<string, Approval>();
  for (const entry of entries) {
    if (entry.kind !== KINDS.ask) continue;
    const d = dataOf<AskEntry>(entry);
    if (typeof d?.callId !== "string" || map.has(d.callId)) continue;
    map.set(d.callId, {
      id: d.callId,
      tool: d.tool,
      call_id: d.callId,
      args_json: JSON.stringify(d.args ?? {}) ?? "{}",
      requested_at: d.requestedAt,
      ...(typeof d.price === "number" || d.price === "not metered" ? { price: d.price } : {}),
      ...(answered.has(d.callId) ? { resolved: true as const } : {}),
    });
  }
  return map;
}

/** The answers a run got to its asks, from its journal's `agentrun.answer` entries, by the call's id (the key the moment
 *  and the pending views read as run.meta.approvals): a person's allow or deny with any note, or a withdrawal taken when
 *  the run was stopped or cancelled while the call waited. The first answer for a call stands, but for a stop's
 *  withdrawal over an allow the call had not finished on (its `superseded`, as main's stop superseded it): that is the
 *  call's answer, keeping the one it overrode. A call asked about with no answer that the run's journal ENDED after (an
 *  agentrun.end follows its ask) reads withdrawn, whatever the run's state is now: a run that ended never waits on that
 *  call (its end wrote no withdrawal only when its journal would not take it), a reopen of it included; in the words of
 *  the first end after it (a stop's end: stopped; a completed or failed one: `ended`). So does every unanswered call of
 *  a run `final` as stopped or failed (states no reopen leaves), whose end its journal may not hold (written on the run's
 *  row alone). A call asked in the turn going now (no end after it, the run not final) waits. */
export function answersOf(entries: readonly JournalEntry[], { final }: { final?: "stopped" | "failed" } = {}): Record<string, ApprovalAnswer> {
  const out: Record<string, ApprovalAnswer> = {};
  for (const entry of entries) {
    if (entry.kind !== KINDS.answer) continue;
    const d = dataOf<AnswerEntry>(entry);
    if (typeof d?.callId !== "string") continue;
    // The runner writes { callId, approved, note? } (journal-kinds.ts AnswerData): its decision is read from `approved`.
    const decision = d.decision ?? (d.approved === true ? "allow" : d.approved === false ? "deny" : undefined);
    if (decision === undefined) continue;
    const given = out[d.callId];
    if (given && !(decision === "withdrawn" && d.superseded)) continue;
    const superseded = given ? { superseded: { decision: given.decision, answered_at: given.answered_at, ...(given.note !== undefined ? { note: given.note } : {}), ...(given.by ? { by: given.by } : {}) } } : {};
    // A deny a person's message gave keeps that it was (`by`): its row reads "Declined by your message".
    out[d.callId] = { decision, ...(d.note !== undefined ? { note: d.note } : {}), answered_at: d.answeredAt ?? "", ...(decision === "deny" && d.by === "message" ? { by: "message" as const } : {}), ...superseded };
  }
  // How the run ended after each entry: the state of the first agentrun.end at or after it, else the final row's.
  let endedAs: string | undefined = final;
  const endsAfter: (string | undefined)[] = [];
  for (let at = entries.length - 1; at >= 0; at--) {
    if (entries[at]!.kind === KINDS.end) endedAs = dataOf<{ state?: string }>(entries[at]!)?.state ?? "ended";
    endsAfter[at] = endedAs;
  }
  entries.forEach((entry, at) => {
    const state = endsAfter[at];
    if (entry.kind !== KINDS.ask || state === undefined) return;
    const { callId } = dataOf<AskEntry>(entry);
    if (typeof callId === "string" && !(callId in out)) out[callId] = { decision: "withdrawn", answered_at: "", ...(state === "stopped" ? {} : { ended: true as const }) };
  });
  return out;
}

/** An `agentrun.budget` entry's data: the pending budget the kernel cap parked the run with (parkOf), and the cap's words
 *  as the run row's summary says them. */
type BudgetEntry = { pending: { kind: "budget"; cap_usd: number; spent_usd?: number; needs_usd?: number; least_cap_usd?: number; suggested_cap_usd?: number }; words: string };

/** The run's active cap park, from its journal: the last agentrun.budget entry the cap wrote when it parked the run for
 *  room, unless an agentrun.raise after it cleared the pause (the run goes on at the raised cap then). A re-park writes a
 *  fresh budget entry, which a raise before it does not clear, so the last of the two in log order decides. */
function activeBudget(entries: readonly JournalEntry[]): BudgetEntry | undefined {
  let mark: BudgetEntry | undefined;
  for (const entry of entries) {
    if (entry.kind === KINDS.budget) mark = dataOf<BudgetEntry>(entry);
    else if (entry.kind === KINDS.raise) mark = undefined;
  }
  return mark;
}

/** Whether the run stands parked at its cap now (an active agentrun.budget park, no raise since): the store-backed fact the
 *  status table reads (RunFacts.budgetWaiting), as the file-backed view read a workflow's pause file and an agentic run's
 *  turn refusal. */
export const budgetWaitingOf = (entries: readonly JournalEntry[]): boolean => activeBudget(entries) !== undefined;

/** The budget card a run parked at its cap shows (pending, kind budget), from its agentrun.budget entry, the same way the
 *  file-backed view built it from the run's pause mark (runs.ts workflowBudgetPending): its cap (the run's launch cap, else
 *  the park's), what the cap counted as taken and the least the refused step needs, the raise offered (recomputed from
 *  those by the view's one formula), and the cap's words at the run's last meaningful row. The overshoot bound reads 0: the
 *  kernel cap's parkOf keeps no cache-miss bound. Undefined when no park is active. */
export function budgetOf(entries: readonly JournalEntry[], run: Pick<RunView, "meta" | "rows" | "updatedAt">): Pending | undefined {
  const mark = activeBudget(entries);
  if (!mark) return undefined;
  const p = mark.pending;
  const cap = run.meta.max_cost_usd ?? p.cap_usd;
  const figures = p.spent_usd !== undefined && p.needs_usd !== undefined
    ? { spent_usd: micro(p.spent_usd), needs_usd: micro(p.needs_usd), ...(p.least_cap_usd !== undefined ? { least_cap_usd: p.least_cap_usd } : {}), suggested_cap_usd: suggestedCap(cap, p.spent_usd, p.needs_usd), overshoot_bound_usd: microUp(0) }
    : {};
  return { kind: "budget", cap_usd: cap, ...figures, said: mark.words, at: meaningful(run.rows)?.timestamp ?? run.updatedAt };
}

/** The run's meta the status and pending views read: a structural subset of RunMeta, so the server passes its live
 *  run.meta and the store-backed view a value built from the run's row. */
export type RunViewMeta = {
  max_cost_usd?: number;
  cap_raised?: { from: number; to: number; at: string; pause?: string }[];
  cap_continue?: { pause: string; message_id: string; sent: boolean; tries: number; error?: string; paused?: string };
  approvals?: Record<string, ApprovalAnswer>;
  stopped_at?: string;
  stopped_after?: number;
};

/** The run fields the status, pending and moment views read (statusOf, the predicates, momentOf): a structural subset of
 *  Run, so the server passes its live Run and the store-backed view a value built from a row and the journal. */
export interface RunView {
  id: string;
  agentId: string;
  /** The harness its revision names, for whether a message steers it mid-turn (momentOf). */
  harness: string;
  /** Imported history (`agentrun-serve import`): the source it ran in; absent for a run started here. */
  imported?: { source: string; session: string };
  kind: RevisionKind;
  outcome?: Status;
  finishing?: Status;
  /** A raised workflow run waiting for a place to open again (only its truthiness is read). */
  placeWait?: unknown;
  cancel: boolean;
  working: boolean;
  submitted: number;
  updatedAt: string;
  rows: readonly TimelineEvent[];
  turns: Pick<Turns, "end" | "open">;
  approvals?: ReadonlyMap<string, Approval>;
  capMark?: number;
  capRefusal?: RefusalFigures;
  /** The words of the cap pause the run stands at, when the view knows them apart from a turn's refusal (the store-backed
   *  view, from the cap park entry): the moment reads them when `pausedAt` finds no turn refusal, so a run parked at its cap
   *  reads paused either way. The file-backed view leaves this unset and the moment reads `pausedAt`. */
  pausedWords?: string;
  meta: RunViewMeta;
}

/** The facts statusOf reads from a run's files (its directory): a workflow paused at its cap, a workflow paused in its
 *  process, and the browser ask it waits on. The server computes them from the run's files as before; the store-backed
 *  view builds them from the run's row and journal. They are thunks so each is read only where statusOf reaches it, so
 *  the hot path (an ended or stopped run) touches no file, exactly as it did when the reads lived inside statusOf. */
export interface RunFacts {
  /** A workflow run paused at its cap, as its process wrote it (budgetWaiting). */
  budgetWaiting(): boolean;
  /** A workflow run paused in its process (pausedIn(run.dir)). */
  paused(): boolean;
  /** The ask its agent made for the person in its browser the run waits on (askShown(run.dir, run.rows)). */
  browserAsk(): PendingAsk | undefined;
  /** The ask its agent made for the person on its desktop or phone the run waits on (computer-commands.ts computerAsk). */
  computerAsk?(): ComputerAsk | undefined;
}

/** The agent's open ask on its desktop or phone, as the run read shows it. */
export type ComputerAsk = { readonly computer?: "desktop" | "phone"; readonly instruction: string; readonly completion_condition: string; readonly asked_at: string; readonly expires_at: string };

/** Read only on a run's `rows`, which hold no QUIET row (take). */
const shows = (r: TimelineEvent) => r.kind !== "usage" && r.kind !== "phase";
export const meaningful = (rows: readonly TimelineEvent[]) => rows.findLast((r) => shows(r) && r.agent_label !== LEARNING_LABEL);

// A run's messages are its message rows (isMessageRow): a person's, and those the server wrote, the message its turn took.
export const usersOf = (rows: readonly TimelineEvent[]) => rows.filter(isMessageRow).length;
// A row's place in the store: its entry's id. The store mints conversation and entry ids from one counter, so entry ids
// order rows across conversations and the conversation is no part of the order.
const placeOf = (id: string) => Number(id.slice(id.lastIndexOf(":") + 1));
/** Whether the turn a stop ended is still where the run stands: no message shown is newer than the stop's. By order,
 *  never by a count or by the stopped message itself, which a compaction can take off the rows. */
export const stoppedAt = (meta: { stopped_at?: string; stopped_after?: number }, rows: readonly TimelineEvent[]): boolean => {
  if (meta.stopped_at === undefined) return meta.stopped_after !== undefined && meta.stopped_after === usersOf(rows);
  const at = placeOf(meta.stopped_at);
  return !rows.some((r) => isMessageRow(r) && placeOf(r.id) > at);
};
export const stopped = (run: Pick<RunView, "meta" | "rows">) => stoppedAt(run.meta, run.rows);

/** The tool call that waits for a person's answer: requested in the run's store, not resolved there, not answered. */
export const waitingApproval = (run: Pick<RunView, "approvals" | "meta">): Approval | undefined => [...(run.approvals?.values() ?? [])].find((a) => !a.resolved && !run.meta.approvals?.[a.id]);
/** One answered (allow or deny) whose answer the run's process has not acted on yet. */
export const actingOn = (run: Pick<RunView, "approvals" | "meta">) => [...(run.approvals?.values() ?? [])].some((a) => !a.resolved && run.meta.approvals?.[a.id] && !withdrawn(run.meta.approvals[a.id]));
/** What is shown of a call's arguments: the whole of them redacted with the run's redactor, then cut (previewOf), so
 *  no cut leaves the head of a held key. */
export const shownArgs = (approval: Pick<Approval, "args_json">, redact: (text: string) => string): string => previewOf(redact(approval.args_json));

/** A dollar figure to a millionth, as the timeline's cost.usd is. */
export const micro = (usd: number): number => Math.round(usd * 1e6) / 1e6;
/** A bound to a millionth, rounded up, so "at most" holds. No bound is 0, never -0: the ceiling of a hair under 0 is -0,
 *  which the budget card would print as "-0". */
export const microUp = (usd: number): number => Math.ceil(usd * 1e6 - 1e-9) / 1e6 + 0;
/** How many of the refused request's least a run paused at its cap is offered on top of what was taken (suggestedCap). */
export const SUGGESTED_RAISE_FACTOR = 10;
/** The raise a run paused at its cap is offered: what the cap counted as taken plus SUGGESTED_RAISE_FACTOR times the
 *  refused request's least, rounded up to a whole dollar, and always above the cap (the next dollar above it, if not),
 *  so a PATCH with it is a raise. */
export const suggestedCap = (cap: number, spentUsd: number, needsUsd: number): number => {
  // A hair under, so a sum a float puts just past a whole dollar (3.0000000000000004) stays that dollar.
  const up = Math.ceil(spentUsd + SUGGESTED_RAISE_FACTOR * needsUsd - 1e-9);
  // Above the cap as a raise must be (by more than CAP_TOLERANCE, takeRaise), so a PATCH with it is always taken.
  return up > cap + CAP_TOLERANCE ? up : Math.floor(cap + CAP_TOLERANCE) + 1;
};

/** The words of the cap's refusal for room an agentic run stands paused at: its newest message's turn ended on it (cap.ts
 *  roomRefusal: what is left of its cap cannot buy the next request's least, which a higher cap would send), and nothing
 *  came since. The run then waits for its cap to be raised (input_required, `pending.kind` budget), never failed; a
 *  refusal no cap fixes (an unknown spend, no price) still fails it (decide). Undefined for any other run. */
const refusedAt = (run: RunView, { inFlight = true }: { inFlight?: boolean } = {}): string | undefined => {
  // `inFlight: false`: a message counted but not yet shown does not move the run past its refusal (one that may not
  // answer its person reads the pause through it).
  if (run.kind !== "agentic" || run.cancel || (inFlight && run.submitted > 0) || run.turns.open > 0 || stopped(run)) return undefined;
  const end = run.turns.end();
  return end?.status === "failed" ? roomRefusal(end.error) : undefined;
};
/** The pause a run stands at, by its refusal's own start mark (its entry), so no row shown after it moves it; a store
 *  with no such mark keys it to the refusal's row. Undefined when it stands at no refusal for room. */
export const pauseOf = (run: RunView, read: { inFlight?: boolean } = {}): string | undefined => {
  if (refusedAt(run, read) === undefined) return undefined;
  if (run.capMark !== undefined) return `mark:${run.capMark}`;
  const row = meaningful(run.rows)?.id;
  return row === undefined ? undefined : `row:${row}`;
};
/** Its cap was raised since the refusal it stands at (a raise names that pause): it waits for its follow-up then, not
 *  for a raise (input_required, idle). */
const raisedSince = (run: RunView, read: { inFlight?: boolean } = {}): boolean => {
  const pause = pauseOf(run, read);
  return pause !== undefined && run.meta.cap_raised?.some((raise) => raise.pause === pause) === true;
};
/** The follow-up a raise of the pause it stands at asked for and that has not gone yet: one per pause. */
export const continuationOf = (run: RunView): NonNullable<RunViewMeta["cap_continue"]> | undefined => {
  // A run that has ended, or is ending (its follow-up's tries spent: failRaised, a cancel), sends none any more.
  if (run.outcome || run.finishing || run.cancel) return undefined;
  const pause = pauseOf(run);
  const next = run.meta.cap_continue;
  return pause !== undefined && next?.pause === pause && !next.sent ? next : undefined;
};
export const pausedAt = (run: RunView, read: { inFlight?: boolean } = {}): string | undefined => (raisedSince(run, read) ? undefined : refusedAt(run, read));
/** Raised at the pause it stands at, and that raise's follow-up still to go (continuationOf): the run goes on without a
 *  person, once the follow-up opens its next process (resumeRaised). */
export const raisedToGo = (run: RunView): boolean => raisedSince(run) && continuationOf(run) !== undefined;

/** What a run waits on, as `pending` says it (one field for every kind; a tool call waiting on approval is another):
 *  the question a waiting run asked, read from its last meaningful row (withAsks' waiting row), the same row its
 *  status reads, never from a scan of its timeline. */
export type Pending = { kind: "question"; question: string; asked_at: string } | PendingApproval | { kind: "budget"; cap_usd: number; spent_usd?: number; needs_usd?: number; least_cap_usd?: number; suggested_cap_usd?: number; overshoot_bound_usd?: number; said: string; at: string; node?: string | null } | { kind: "browser"; instruction: string; completion_condition: string; asked_at: string; expires_at: string } | { kind: "computer"; computer: "desktop" | "phone"; instruction: string; completion_condition: string; asked_at: string; expires_at: string } | null;
export const pendingOf = (rows: readonly TimelineEvent[]): Pending => {
  const last = meaningful(rows);
  return last?.kind === "waiting" ? { kind: "question", question: last.text ?? last.summary ?? "", asked_at: last.timestamp } : null;
};
/** The run's pending approval (`pending`, kind approval): the call that waits; else undefined. */
export const approvalOf = (run: Pick<RunView, "approvals" | "meta">, redact: (text: string) => string): PendingApproval | undefined => {
  const waiting = waitingApproval(run);
  return waiting ? { kind: "approval", id: waiting.id, tool: waiting.tool, call_id: waiting.call_id, args_preview: shownArgs(waiting, redact), requested_at: waiting.requested_at, ...(waiting.price !== undefined ? { price: waiting.price } : {}) } : undefined;
};
/** A run paused at its cap waits on a raise: its cap, what the cap counted as taken and the least the refused request
 *  needs (its refusal's mark; none from a store written before it kept them), the raise it is offered (suggestedCap),
 *  the refusal's words, and when it came (its error row's time). The figures are as the cap counts them, never rounded.
 *  What was taken is the store's spend once its process is gone (`spentNow`), when that is lower: the refusal counted
 *  requests still answering at what it held for them, and they have settled. */
export const budgetPending = (run: RunView, spentNow?: number): Pending | undefined => {
  const said = pausedAt(run);
  const cap = run.meta.max_cost_usd;
  if (said === undefined || cap === undefined) return undefined;
  const r = run.capRefusal;
  const spent = r && spentNow !== undefined ? Math.min(r.spentUsd, spentNow) : r?.spentUsd;
  // Shown as cost.usd is (to a millionth of a dollar), the suggestion from the figures as the cap counts them. The least cap
  // that sends the refused request is the one its words name (`said`), carried from the refusal that wrote them, never
  // worked out again here from figures that may have moved since. With them, the most a cache miss could make the refused
  // request cost beyond what it needs (cap.ts), 0 for none.
  const figures = r && spent !== undefined ? { spent_usd: micro(spent), needs_usd: micro(r.needsUsd), least_cap_usd: r.leastCapUsd, suggested_cap_usd: suggestedCap(cap, spent, r.needsUsd), overshoot_bound_usd: microUp(r.boundUsd ?? 0) } : {};
  return { kind: "budget", cap_usd: cap, ...figures, said, at: meaningful(run.rows)?.timestamp ?? run.updatedAt };
};
/** A run whose agent asked for the person in its browser waits on their hand-back: what it asked them to do, when it is
 *  done, and when the ask expires. Never the session's tag or the live view's link. The two texts are the model's, so
 *  redacted with the run's redactor (`redact`), as a tool call's arguments are: a held value it echoes never shows. */
export const browserPending = (ask: PendingAsk | undefined, redact: (text: string) => string): Pending | undefined =>
  ask && { kind: "browser", instruction: redact(ask.instruction), completion_condition: redact(ask.completion_condition), asked_at: ask.asked_at, expires_at: ask.expires_at };
/** A run whose agent asked for the person on its desktop or phone waits on their hand-back, the same way: the two texts
 *  are the model's, so redacted. */
export const computerPending = (ask: ComputerAsk | undefined, redact: (text: string) => string): Pending | undefined =>
  ask && { kind: "computer", computer: ask.computer ?? "desktop", instruction: redact(ask.instruction), completion_condition: redact(ask.completion_condition), asked_at: ask.asked_at, expires_at: ask.expires_at };

/** A run's status and state, by the contract's table. `facts` carries the run's file-backed reads (a workflow's pause,
 *  the browser ask); every other read is over the run's rows, its turns and its store entries. */
export function statusOf(run: RunView, facts: RunFacts): { status: Status; state: State } {
  if (run.outcome) return { status: run.outcome, state: "idle" };
  if (run.finishing) return { status: run.finishing, state: "idle" };
  // A paused workflow run finishes what it has in flight and starts nothing new until it is resumed (pause.ts). A held run
  // read without its directory (a view built for a count) has no mark to read.
  // One paused at its cap waits for a raise (budget.ts): input_required and waiting, with or without its process.
  // Raised, it waits for a place to open again in (finishRaise): queued, as a run not yet started is.
  if (run.kind === "workflow" && run.placeWait && !run.cancel) return { status: "queued", state: "working" };
  if (run.kind === "workflow") return facts.budgetWaiting() ? { status: "input_required", state: "waiting" } : facts.paused() ? { status: "paused", state: "idle" } : { status: run.working ? "working" : "queued", state: "working" };
  const users = usersOf(run.rows);
  if (run.submitted > 0) return { status: users ? "working" : "queued", state: "working" };
  // No rows is a run not shown yet (adopted, before its first snapshot), whatever an old stop says. Rows with no
  // message of the person's are a compaction's (it shows its summary), which can summarize every message of a stop.
  if (!run.rows.length) return { status: "queued", state: "working" };
  if (stopped(run)) return { status: "input_required", state: "idle" };
  if (!users) return { status: "queued", state: "working" };
  // A tool call parked for approval (tool-gate.ts) waits for the person; once answered, its process acts on it.
  if (run.kind === "agentic" && run.submitted === 0 && !run.working) {
    if (waitingApproval(run)) return { status: "input_required", state: "waiting" };
    if (actingOn(run)) return { status: "working", state: "working" };
  }
  // Parked at its cap, as the store-backed view's fact says it (an active agentrun.budget park, no raise since): it waits
  // for the cap to be raised. The file-backed view reads an agentic run's pause from the turn's refusal (refusedAt, below),
  // where this fact is always false, so this is a no-op there; a workflow run reads it through the facts above.
  if (facts.budgetWaiting()) return { status: "input_required", state: "waiting" };
  // Every message's turn is over and the newest one's ended interrupted, with no stop of the person's saying so (the
  // harness ended it on its own): the run waits for the person, as after a stop, never working for good.
  if (run.kind === "agentic" && run.submitted === 0 && run.turns.end()?.status === "interrupted") return { status: "input_required", state: "idle" };
  // Paused at its cap: it waits for the cap to be raised. Raised, it is queued while the raise's follow-up is still to go
  // (raisedToGo: from the moment the raise is taken, through its paused process's let-go and the follow-up's tries), since
  // nothing waits on a person; for a message only if that follow-up will not go.
  if (refusedAt(run) !== undefined) return pausedAt(run) !== undefined ? { status: "input_required", state: "waiting" } : raisedToGo(run) ? { status: "queued", state: "working" } : { status: "input_required", state: "idle" };
  // Its agent asked for the person in its browser (browser-person.ts): its turn is still open, the tool call waiting for
  // the hand-back, and the run waits on the person until they answer or the ask expires.
  if (facts.browserAsk()) return { status: "input_required", state: "waiting" };
  // So does one whose agent asked for them on its desktop or phone (computer_request_handoff).
  if (facts.computerAsk?.()) return { status: "input_required", state: "waiting" };
  if (run.working) return { status: "working", state: "working" };
  if (meaningful(run.rows)?.kind === "waiting") return { status: "input_required", state: "waiting" };
  return { status: "working", state: "idle" };
}

/** A run has reached a last state. */
const TERMINAL = new Set<Status>(["completed", "failed", "cancelled"]);

/** How a tool call's approval was answered, as the run view folds the journal and the command rows: a person's allow or
 *  deny, a withdrawal when the run was stopped, or a cancel with the run. */
export type ApprovalDecision = "allow" | "deny" | "withdrawn" | "canceled";

/** A run's live moment, as the run view computes it (statusOf and the predicates above), for the one acceptance decision
 *  each act a run takes (message, stop, raise, approve) makes. The write half (runs-over-store.ts) reads nothing else of
 *  the run's live state; the coarse facts a row holds (its state, its launch cap) it reads from the store itself. The
 *  server builds this from its live Run; the store-backed view builds it from the run's row and journal (momentOverStore),
 *  so the acceptance and words an act answers with stay the same. */
export interface RunMoment {
  readonly id: string;
  readonly agentId: string;
  readonly kind: "agentic" | "workflow";
  /** Where an imported run came from (run.imported?.source); absent for a run started here. An imported run takes no act. */
  readonly importedSource?: string;
  /** A cancel is in flight (run.cancel), whether or not its end is written yet. */
  readonly cancelled: boolean;
  /** The run has reached a last state (statusOf: completed, failed or cancelled). */
  readonly terminal: boolean;
  /** Which last state, for the refusal's words (completed, failed or cancelled). */
  readonly terminalKind?: "completed" | "failed" | "cancelled";
  /** The message "working" predicate: the run's turn is in flight (queued, working-working, or its agent waits on the
   *  person in its browser), so a message steers it or follows it, never answers. */
  readonly working: boolean;
  /** The run waits on a person's answer to a question it asked (input_required and waiting on ask_person): a message
   *  answers it. */
  readonly awaitingAnswer: boolean;
  /** The run's harness takes a message mid-turn (pi and every workflow run): else a message to a working run follows the
   *  turn as a new one (follow_up), never a steer it cannot do. */
  readonly steers: boolean;
  /** The run's cap as it stands now (its launch cap folded with any raise rows), or undefined when it is uncapped. */
  readonly maxCostUsd?: number;
  /** The run is paused at its cap: a message is refused for the same room (raise the cap first). The pause's words, which
   *  the refusal carries, or undefined when it is not paused. */
  readonly pausedWords?: string;
  /** The run is paused at its cap (pausedAt): raising the cap resumes it. */
  readonly paused: boolean;
  /** The run has a live process now (a runner holds its claim): a raise's cap holds from its next step, not the one under
   *  way. */
  readonly live: boolean;
  /** A message that may not answer a person (a trigger's) is refused while the run waits on one, before anything else. */
  readonly waitsOnPerson: boolean;
  /** The tool call that waits for approval now, if any (waitingApproval): a person's message declines it. */
  readonly waitingApprovalId?: string;
  /** The tool calls this run has or had waiting for approval, by id (for the not-found refusal). */
  readonly approvalIds?: ReadonlySet<string>;
  /** The approvals already answered, by call id, as the run view folds them (for the first-wins refusal and its words). */
  readonly answeredApprovals?: Readonly<Record<string, { readonly decision: ApprovalDecision; readonly ended?: true }>>;
}

/** A run's live moment (RunMoment), computed from the same status table and predicates a person's view reads, plus whether
 *  a runner holds its claim now (`live`). The server passes its live Run with `live = this.live(run)`; the store-backed
 *  view passes a value built from the run's row and journal, so an act's acceptance is decided the same way either path. */
export function momentOf(run: RunView, facts: RunFacts, live: boolean): RunMoment {
  const { status, state } = statusOf(run, facts);
  const terminal = TERMINAL.has(status);
  const waiting = waitingApproval(run);
  // The pause words from the turn's refusal (the file-backed view), else the cap park the store-backed view carries, so a
  // run parked at its cap reads paused and raiseCap resumes it either way.
  const pausedWords = pausedAt(run) ?? run.pausedWords;
  const answered = run.meta.approvals;
  return {
    id: run.id,
    agentId: run.agentId,
    kind: run.kind,
    ...(run.imported ? { importedSource: run.imported.source } : {}),
    cancelled: run.cancel,
    terminal,
    ...(terminal ? { terminalKind: status as "completed" | "failed" | "cancelled" } : {}),
    // The message "working" predicate (runs.ts message): queued, working-working, or its agent waits on the person in its
    // browser (mid-turn, the tool call waiting inside the turn).
    working: status === "queued" || (status === "working" && state === "working") || facts.browserAsk() !== undefined || facts.computerAsk?.() !== undefined,
    awaitingAnswer: status === "input_required" && state === "waiting",
    // Whether its harness takes a message mid-turn (runs.ts steers): every workflow run, and an agentic run whose harness
    // steers (pi).
    steers: run.kind !== "agentic" || (builtinHarness(run.harness)?.steer ?? false),
    ...(run.meta.max_cost_usd !== undefined ? { maxCostUsd: run.meta.max_cost_usd } : {}),
    ...(pausedWords !== undefined ? { pausedWords } : {}),
    paused: pausedWords !== undefined,
    live,
    // Whether it waits on a person (runs.ts waitsOnPerson): a parked approval, a pause at its cap (read through a message
    // counted but not shown), or a question its turn ended on.
    waitsOnPerson: run.kind === "agentic" && (waiting !== undefined || pausedAt(run, { inFlight: false }) !== undefined || (status === "input_required" && state === "waiting")),
    ...(waiting ? { waitingApprovalId: waiting.id } : {}),
    ...(run.approvals ? { approvalIds: new Set(run.approvals.keys()) } : {}),
    ...(answered ? { answeredApprovals: Object.fromEntries(Object.entries(answered).map(([id, a]) => [id, { decision: a.decision, ...(a.ended ? { ended: true as const } : {}) }])) } : {}),
  };
}

// --- What a run serves of its error, its review and its handed sign-in: the redaction choke point, as pure functions over
// the run's refused values and (for a run read from its row alone) the sign-in reads injected as `signIns`. The server
// passes its own serverSecrets and signIns; the store-backed view passes the same. summaryOfRow is the ONE summary choke
// point: a run whose summary holds a handed pointer serves it cut, and an unreadable handed hash withholds it (rowShown). ---

/** An ended run's words, withheld while this server can't read the sign-in it was handed (load). */
export const WITHHELD_SIGN_IN = "This server can't read the run's browser sign-in (its seal key changed or is missing, or the sign-in is damaged), so nothing the run said is shown.";

/** A withheld run's title: a short line that fits the title's length and holds nothing the run said, so a title that
 *  repeats the handed sign-in is never served when this server can't cut it. The full sentence stays in the run's error
 *  and review. */
export const WITHHELD_TITLE = "Withheld: a sign-in this run used can't be read";

/** What a `sign_in_handed` the server did not write (anything but a non-empty array of SHA-256 hashes: a `true` or one
 *  hash an older build wrote, or a damaged value) reads as: some pointer was handed, which one is not known, so the run is
 *  hidden or withheld, never served uncut, and forget waits for it while it goes. */
export const MALFORMED = "malformed";
export type Handed = string[] | typeof MALFORMED;

/** A run's `sign_in_handed` as read from its serve.json: undefined when absent (never handed one); the hashes it names;
 *  MALFORMED for any other value. */
export function handedMark(value: unknown): Handed | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value) && value.length && value.every((hash) => typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash))) return [...new Set(value as string[])];
  return MALFORMED;
}

/** Every secret value a run's errors never show, as learning's checker holds them: every one this server never shows
 *  (serverSecrets, read now, so one rotated is cut at once) and what each launch handed the run. */
export const refusedValuesOf = (serverSecrets: () => string[], handed: ReadonlySet<string> | undefined): string[] => [...serverSecrets(), ...(handed ?? [])];
/** A run's redactor (decision-rows.ts, tool previews): redacted over its refused values. */
export const redactorOf = (values: string[]) => (text: string) => redacted(text, values);
/** What serve shows of a run's error text, for every run kind: no held secret (redacted, key-refusal.ts' one rule) and
 *  no loopback address. */
export const shownOf = (values: string[]) => (text: string) => withoutLoopback(redacted(text, values));
/** A run's error as its view and the run lists serve it: its message, and its detail strings, in `shown`'s terms. */
export const servedRunErrorWith = <E extends { message: string; details?: unknown }>(shown: (text: string) => string, error: E): E => ({ ...error, message: shown(error.message), ...(error.details !== undefined ? { details: cutStrings(error.details, shown) } : {}) });
/** A run's review as its view serves it: its reason (an escalation's own words) in `shown`'s terms, or withheld as its
 *  other words are while the run is hidden (`unshown`), as a list row read from disk withholds it. */
export const servedReviewWith = <R extends { reason: string }>(shown: (text: string) => string, unshown: boolean | undefined, review: R | null): R | null => (review && { ...review, reason: unshown ? WITHHELD_SIGN_IN : shown(review.reason) });

/** The pointers a run was handed, read back to cut them (sign-ins-store.ts peek and forgotten), by its `sign_in_handed`: none
 *  for a run with no mark (it was never handed one); else, for each hash it names, the live or forgotten pointer whose
 *  SHA-256 it is. `unreadable` when what it was handed can't be read back here: a MALFORMED mark, no vendor browser kept
 *  beside the mark, the sign-ins file can't be read, or any of its hashes matches no pointer that opens (one under another
 *  seal key or none, one forgotten and dropped past MAX_FORGOTTEN, the sign-ins file gone). Fails closed: a marked run is
 *  cut of every pointer it was handed, or withheld, never served uncut. Read anew at each call: nothing caches this
 *  verdict, so a run withheld while its key was missing is shown once it opens. */
export async function handedPointers(signIns: SignInReader | undefined, agentId: string, browser: string | undefined, handed: Handed | undefined): Promise<{ refs: string[] } | "unreadable"> {
  if (handed === undefined) return { refs: [] };
  if (handed === MALFORMED || !signIns || !browser) return "unreadable";
  const live = await signIns.peek(agentId, browser).catch(() => "unreadable" as const);
  const gone = await signIns.forgotten(agentId, browser).catch(() => "unreadable" as const);
  if (gone === "unreadable") return "unreadable";
  const kept = [...(typeof live === "object" ? [live.ref] : []), ...gone.refs];
  const refs = handed.map((hash) => kept.find((ref) => pointerHash(ref) === hash));
  return refs.every((ref) => ref !== undefined) ? { refs: refs as string[] } : "unreadable";
}

/** shown() for a run this server holds no Run for (an ended one a list reads from its row and serve.json alone): cut of
 *  every secret this server never shows (serverSecrets) and of what the run was handed of its agent's sign-in
 *  (handedPointers); `withheld` when that can't be read back here, as a load would hide the run. `browser` and `handed`
 *  come from the run's record (its plane's vendor browser and its `sign_in_handed` mark); `damaged` when the record was
 *  there but unreadable, so what it was handed went with it. This is the summary choke point. */
export async function rowShown(deps: { serverSecrets: () => string[]; signIns: SignInReader | undefined }, agentId: string, browser: string | undefined, handed: Handed | undefined, damaged = false): Promise<((text: string) => string) | "withheld"> {
  if (damaged) return "withheld";
  const pointers = await handedPointers(deps.signIns, agentId, browser, handed);
  if (pointers === "unreadable") return "withheld";
  const values = [...deps.serverSecrets(), ...pointers.refs.filter((ref) => ref.length >= MIN_SECRET)];
  return (text) => withoutLoopback(redacted(text, values));
}

/** A call that waited for approval, once its outcome shows below its approval: its own rows (the call's, its result's) say
 *  only that it was held. A client folds them into the call's step, at the call's place above the approval row. */
export const HELD = "Held for your approval";
/** At most this many code points of a person's note on a row's summary; the record keeps it whole. */
export const NOTE_CHARS = 200;
/** `text` cut to `max` code points, an ellipsis last when cut: a pair of surrogates is never halved. */
export const clipPoints = (text: string, max: number): string => {
  const points = Array.from(text);
  return points.length > max ? `${points.slice(0, max - 1).join("")}…` : text;
};
/** A person's note as a row's summary shows it: redacted whole with the run's redactor (`redact`), its links' query values
 *  elided (scrubUrls), its first non-empty line, cut to NOTE_CHARS code points. None for an empty note. */
export function noteShown(note: string | undefined, redact: (text: string) => string): string | undefined {
  if (!note?.trim()) return undefined;
  const line = scrubUrls(redact(note)).split(/\r?\n/).map((part) => part.trim()).find(Boolean);
  return line ? clipPoints(line, NOTE_CHARS) : undefined;
}
/** What came of an approval, as its outcome row's summary says it. A deny: "You declined <tool>: <note>" (one colon), or
 *  "You declined <tool>." with none; a declining message adds nothing (it shows as the person's own row). An allow: that it
 *  ran and where its result went, or that it failed; a note sent with an allow is shown nowhere, as on main. */
export function outcomeSays(tool: string, answer: { decision: string; by?: string; note?: string }, failed: boolean, redact: (text: string) => string): string {
  if (answer.decision === "deny") {
    if (answer.by === "message") return `AgentRun: Your message declined ${tool}.`;
    const note = noteShown(answer.note, redact);
    return note ? `AgentRun: You declined ${tool}: ${note}` : `AgentRun: You declined ${tool}.`;
  }
  return `AgentRun: ${tool} ran once you allowed it${failed ? ", and failed" : "; its result went to the agent"}`;
}
/** What a person reads when they open the outcome row: the outcome, then the call's result (`rest`), or the refusal's words.
 *  An empty result says so: "Its result: (no output)", never "Its result:" and nothing. */
export function outcomeShows(tool: string, answer: { decision: string; by?: string }, rest: string, failed: boolean): string {
  if (answer.decision === "deny") return `${answer.by === "message" ? `Your message declined ${tool}.` : `You declined ${tool}.`}${rest.trim() ? `\n${rest.trim()}` : ""}`;
  const head = `${tool} ran once you allowed it${failed ? ", and failed" : ""}.`;
  return rest.trim() ? `${head} Its result:\n${rest}` : `${head} Its result: (no output)`;
}

/** A call's own rows (its call's, its result's) before its outcome shows: what came of the approval so far. */
function callSays(answer: ApprovalAnswer | undefined): string {
  if (!answer) return "Not run yet: it waits for your approval";
  if (answer.decision === "canceled") return "Not run: the run was cancelled while it waited";
  if (answer.decision === "withdrawn") return answer.ended ? "Not run: the run ended while it waited" : "Not run: the run was stopped while it waited";
  return "Allowed: it runs now";
}
/** A synthesized row's id: the approval's own, so a pass over rows this function gave drops and remakes it. */
const approvalRowId = (callId: string) => `approval:${callId}`;

/** The rows of a run whose calls waited for approval, as the runner writes it (store-view.ts): the gate's ask
 *  (agentrun.ask, `asks`) and the person's answer (agentrun.answer, `answers`) are journal entries, and an allowed call runs
 *  in place, so its result row is its real result; a denied one's is the refusal. Each such call reads in order: its own
 *  rows, then the approval row, then, once there is one, the outcome row; its own rows say only that it was held once the
 *  outcome shows below, and before that what came of the approval so far. Arguments and notes go through `redact`, the
 *  run's redactor, before any cut. The rows this function makes are dropped first, so a pass over its own output gives the
 *  same rows. */
export function withApprovalRows(rows: readonly TimelineEvent[], asks: ReadonlyMap<string, Approval>, answers: Readonly<Record<string, ApprovalAnswer>>, redact: (text: string) => string): TimelineEvent[] {
  if (!asks.size) return [...rows];
  const given = rows.filter((row) => !row.id.startsWith("approval:"));
  const byCall = new Map([...asks.values()].map((approval) => [approval.call_id, approval]));
  const owns = (row: TimelineEvent) => (row.kind === "tool_use" || row.kind === "tool_result") && !!row.tool_use_id && byCall.has(row.tool_use_id);
  const lastOf = new Map<string, string>();
  for (const row of given) if (owns(row)) lastOf.set(row.tool_use_id!, row.id);
  return given.flatMap((row) => {
    if (!owns(row)) return [row];
    const approval = byCall.get(row.tool_use_id!)!;
    const answer = answers[approval.id];
    const result = given.find((other) => other.kind === "tool_result" && other.tool_use_id === approval.call_id);
    // The outcome shows once there is one: a deny's at once, an allow's when its call's result is in.
    const outcome = answer?.decision === "deny" || (answer?.decision === "allow" && result !== undefined);
    const own: TimelineEvent = { ...row, summary: outcome ? HELD : callSays(answer), tool_status: null };
    if (lastOf.get(approval.call_id) !== row.id) return [own];
    const args = shownArgs(approval, redact);
    const head = !answer ? "Waiting for your approval" : answer.decision === "canceled" ? "Withdrawn when the run was cancelled" : answer.decision === "withdrawn" ? (answer.ended ? "Withdrawn when the run ended" : "Withdrawn when the run was stopped") : answer.by === "message" ? "Declined by your message" : "Asked your approval";
    const asked: TimelineEvent = { ...row, id: approvalRowId(approval.call_id), kind: APPROVAL_ROW as TimelineEvent["kind"], summary: `${head}: ${approval.tool} ${clip(args, 400)}`, text: args, tool_name: approval.tool, tool_status: null, tool_input_preview: clip(args, 500), tool_result_preview: null, tool_result_size_bytes: null };
    if (!outcome) return [own, asked];
    const failed = answer!.decision === "allow" && result?.tool_status === "failed";
    // The result's words: a tool_result row keeps them as its preview (the renderer's, redacted and cut), its text empty.
    const told: TimelineEvent = { ...(result ?? row), id: `${approvalRowId(approval.call_id)}:outcome`, kind: "phase", origin: "server", summary: outcomeSays(approval.tool, answer!, failed, redact), text: outcomeShows(approval.tool, answer!, redact(result?.text || result?.tool_result_preview || ""), failed), tool_name: null, tool_use_id: null, tool_status: null, tool_input_preview: null, tool_result_preview: null, tool_result_size_bytes: null } as TimelineEvent;
    return [own, asked, told];
  });
}
