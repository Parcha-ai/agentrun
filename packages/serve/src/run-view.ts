// A run's served view, as pure functions over the run's rows (its timeline) and what the store kept, separate from how the
// run is held or read. The server cut feeds these from the one store's readers; before it, runs.ts feeds them from a run's
// in-memory rows. The functions move here unchanged, so the figures and words a person sees do not change: the extraction
// is what the existing view, cost and timeline tests already pin.
//
// The pieces here so far: the cost reads (a run's cost, its paid tools' charges, the cost a view shows, what it has cost so
// far when the total is unknown) and the served row transforms a view applies to the timeline (the over-cap row, the
// paused run's waiting row). All read the same rows the timeline renders.
import { NOTE_SUFFIX, type TimelineEvent, chargedTool, isMessageRow } from "@parcha/pi-durable-agent/timeline";
import type { RevisionKind } from "@parcha/pi-durable-agent";
import { CAP_TOLERANCE, FIT_TOLERANCE, money, type RefusalFigures, roomRefusal } from "./cap.js";
import { servedOnly } from "./served-only.js";
import type { Turns } from "./turns.js";
import type { PendingAsk } from "./browser-person.js";
import { type PendingApproval, previewOf } from "./tool-gate.js";
import { LEARNING_LABEL } from "./learning.js";
import { builtinHarness } from "./harness-table.js";
import { cutStrings, redacted, withoutLoopback } from "./key-refusal.js";
import { pointerHash, type SignIns } from "./sign-ins.js";
import { MIN_SECRET } from "./learn/secrets.js";

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
export type ApprovalAnswer = { decision: "allow" | "deny" | "canceled" | "withdrawn"; note?: string; answered_at: string; args_shown?: string; by?: "message"; superseded?: { decision: string; answered_at: string; note?: string; by?: "message" } };
/** A call withdrawn with its run (a cancel, or a stop while it waited): never run, and an answer after is 409. */
export const withdrawn = (answer: ApprovalAnswer | undefined) => answer?.decision === "canceled" || answer?.decision === "withdrawn";

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
}

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
/** A bound to a millionth, rounded up, so "at most" holds. */
export const microUp = (usd: number): number => Math.ceil(usd * 1e6 - 1e-9) / 1e6;
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
export type Pending = { kind: "question"; question: string; asked_at: string } | PendingApproval | { kind: "budget"; cap_usd: number; spent_usd?: number; needs_usd?: number; least_cap_usd?: number; suggested_cap_usd?: number; overshoot_bound_usd?: number; said: string; at: string; node?: string | null } | { kind: "browser"; instruction: string; completion_condition: string; asked_at: string; expires_at: string } | null;
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
  /** The run has a live process now (a runner holds its claim): a raise's cap holds from its next process, not this one. */
  readonly live: boolean;
  /** A message that may not answer a person (a trigger's) is refused while the run waits on one, before anything else. */
  readonly waitsOnPerson: boolean;
  /** The tool call that waits for approval now, if any (waitingApproval): a person's message declines it. */
  readonly waitingApprovalId?: string;
  /** The tool calls this run has or had waiting for approval, by id (for the not-found refusal). */
  readonly approvalIds?: ReadonlySet<string>;
  /** The approvals already answered, by call id, as the run view folds them (for the first-wins refusal and its words). */
  readonly answeredApprovals?: Readonly<Record<string, { readonly decision: ApprovalDecision }>>;
}

/** A run's live moment (RunMoment), computed from the same status table and predicates a person's view reads, plus whether
 *  a runner holds its claim now (`live`). The server passes its live Run with `live = this.live(run)`; the store-backed
 *  view passes a value built from the run's row and journal, so an act's acceptance is decided the same way either path. */
export function momentOf(run: RunView, facts: RunFacts, live: boolean): RunMoment {
  const { status, state } = statusOf(run, facts);
  const terminal = TERMINAL.has(status);
  const waiting = waitingApproval(run);
  const pausedWords = pausedAt(run);
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
    working: status === "queued" || (status === "working" && state === "working") || facts.browserAsk() !== undefined,
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
    ...(answered ? { answeredApprovals: Object.fromEntries(Object.entries(answered).map(([id, a]) => [id, { decision: a.decision }])) } : {}),
  };
}

// --- What a run serves of its error, its review and its handed sign-in: the redaction choke point, as pure functions over
// the run's refused values and (for a run read from its row alone) the sign-in reads injected as `signIns`. The server
// passes its own serverSecrets and signIns; the store-backed view passes the same. summaryOfRow is the ONE summary choke
// point: a run whose summary holds a handed pointer serves it cut, and an unreadable handed hash withholds it (rowShown). ---

/** An ended run's words, withheld while this server can't read the sign-in it was handed (load). */
export const WITHHELD_SIGN_IN = "This server can't read the run's browser sign-in (its seal key changed or is missing, or the sign-in is damaged), so nothing the run said is shown.";

/** What a `sign_in_handed` the server did not write (anything but a non-empty array of SHA-256 hashes: a `true` or one
 *  hash an older build wrote, or a damaged value) reads as: some pointer was handed, which one is not known, so the run is
 *  hidden or withheld, never served uncut, and forget waits for it while it goes. */
export const MALFORMED = "malformed";
export type Handed = string[] | typeof MALFORMED;

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

/** The pointers a run was handed, read back to cut them (sign-ins.ts peek and forgotten), by its `sign_in_handed`: none
 *  for a run with no mark (it was never handed one); else, for each hash it names, the live or forgotten pointer whose
 *  SHA-256 it is. `unreadable` when what it was handed can't be read back here: a MALFORMED mark, no vendor browser kept
 *  beside the mark, the sign-ins file can't be read, or any of its hashes matches no pointer that opens (one under another
 *  seal key or none, one forgotten and dropped past MAX_FORGOTTEN, the sign-ins file gone). Fails closed: a marked run is
 *  cut of every pointer it was handed, or withheld, never served uncut. Read anew at each call: nothing caches this
 *  verdict, so a run withheld while its key was missing is shown once it opens. */
export async function handedPointers(signIns: SignIns | undefined, agentId: string, browser: string | undefined, handed: Handed | undefined): Promise<{ refs: string[] } | "unreadable"> {
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
export async function rowShown(deps: { serverSecrets: () => string[]; signIns: SignIns | undefined }, agentId: string, browser: string | undefined, handed: Handed | undefined, damaged = false): Promise<((text: string) => string) | "withheld"> {
  if (damaged) return "withheld";
  const pointers = await handedPointers(deps.signIns, agentId, browser, handed);
  if (pointers === "unreadable") return "withheld";
  const values = [...deps.serverSecrets(), ...pointers.refs.filter((ref) => ref.length >= MIN_SECRET)];
  return (text) => withoutLoopback(redacted(text, values));
}
