// A run's trace (GET /runs/{id}/trace): each model request and each tool call as one span, with when it started and
// ended, what it used and what it cost, for a person who debugs a run. Nothing here is measured again: a tool call is its
// two served Timeline rows (run-timeline-served.ts, cut by the run's one cut), joined by the call's id, with the charges
// booked under it; a model request is one answer of pi's as the usage row counts it (timeline answeredRequests), with the
// tokens, the cost and the times that answer carries. What a record does not keep is said, never made up: a CLI harness's
// record keeps no request (`model_requests: "not_recorded"`), a workflow's model nodes' requests carry no cost of their
// own (`"tokens_only"`: the run's cost is its booking's; its decisions' receipts are requests too, each with its own),
// and a computer's time is its provider's to bill, so no span has it.
import type { Context } from "@earendil-works/chord/context";
import { ApiError } from "./errors.js";
import { redacted } from "./key-refusal.js";
import { runCutValues } from "./run-cut.js";
import { type ServedTimelineDeps, servedTimelineRows } from "./run-timeline-served.js";
import { type ApprovalAnswer, answersOf, asksOf, WITHHELD_SIGN_IN } from "./run-view.js";
import { costIsBooked } from "./runner/metrics.js";
import { decisionsOverStore } from "./store-reads/decisions.js";
import { isCliRecord, piShaped, runEntries } from "./store-reads/journal.js";
import type { Store } from "./store/store.js";
import { answeredRequests, type EntryLike, type TimelineEvent } from "./timeline/index.js";

/** The most spans one read serves: the run's first, in the order they started. `dropped` counts the rest. */
export const TRACE_SPANS_MAX = 2_000;

/** `reasoning`: the thinking tokens among `output`, where the provider reports them. */
export type TraceTokens = { input: number; cache_read: number; cache_write: number; output: number; reasoning?: number };

/** How a span ended. `waiting`: a tool call held for its owner's approval, which has not run. `running`: a tool call
 *  with no result yet. `refused`: a call refused before it ran (a deny). `interrupted`: a request or a call cut before
 *  its end, or a call whose approval was withdrawn with its run. A model request is a span once it answered, so it is
 *  never waiting or running. */
export type TraceStatus = "ok" | "failed" | "refused" | "interrupted" | "waiting" | "running";

export type TraceSpan = {
  /** The span's id in this trace: stable across reads of the run. */
  id: string;
  kind: "model" | "tool";
  /** The span this one ran under: a tool call's, the model request that called it, or the call it nested in; a subagent's
   *  model request's, the call that started the subagent. Null at the top. */
  parent_id: string | null;
  /** A model request's model, as its answer names it (a decision's, the model its provider answered with, else the
   *  provider); a tool call's tool. */
  name: string;
  /** The subagent the span ran in, as the Timeline labels it; a workflow decision's node. */
  agent_label: string | null;
  started_at: string;
  /** Null while a tool call runs or waits, and for a span whose end the record does not keep (a request with no
   *  duration, a call cut with no result). */
  ended_at: string | null;
  status: TraceStatus;
  /** A model request's stop reason, as pi names it (`stop`, `toolUse`, `length`, `error`, `aborted`). Null on a tool call. */
  stop_reason: string | null;
  /** A model request's tokens: `input` not read from cache, `cache_read`, `cache_write`, `output`. A decision's receipt
   *  keeps its input whole, so all of it is `input`. Null when the answer reported none (a cut request), and on a tool call. */
  tokens: TraceTokens | null;
  /** A model request's cost; a tool call's, the sum of the charges booked under it. Null when it is not known (a cut
   *  request, a charge of an unknown amount, a request whose run's cost is its booking's: `model_requests`), and on a
   *  call nothing was charged under (`charged`). */
  usd: number | null;
  /** Whether anything was charged under a tool call (a browser session's time, a paid tool's fee): `usd` is their sum.
   *  False on a model request. */
  charged: boolean;
  /** A workflow decision's request (a judge's, a route's, a verify's), which has a cost of its own whatever
   *  `model_requests` says of the run's other requests. False on every other span. */
  decision: boolean;
  /** A tool call whose tool has no price set: it ran outside the run's cost. */
  not_metered: boolean;
  /** The tool call's id, as its Timeline rows carry it. Null on a model request. */
  tool_use_id: string | null;
  input_preview: string | null;
  result_preview: string | null;
  result_size_bytes: number | null;
};

export type RunTrace = {
  run_id: string;
  /** What the run's record keeps of its model requests. `priced`: each is a span with its tokens and its cost.
   *  `tokens_only`: a workflow run. Each model node's request is a span with its tokens and no cost (the run's cost is
   *  its booking's); each decision is a span with its own cost. `not_recorded`: the harness's record keeps no request,
   *  so the spans are its tool calls alone. */
  model_requests: "priced" | "tokens_only" | "not_recorded";
  spans: TraceSpan[];
  /** Spans left out past TRACE_SPANS_MAX. */
  dropped: number;
};

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj | undefined => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Obj) : undefined);
const finite = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const count = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);
/** A time as the rows write theirs; undefined for one no Date holds. */
const iso = (ms: number): string | undefined => (Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : undefined);
/** An amount with a sum's floating-point noise off (0.1 + 0.2 is 0.3, not 0.30000000000000004), to a millionth of a
 *  millionth of a dollar: far below any price, so no cost is rounded away. Every span's cost is written through it. */
const noiseOff = (usd: number): number => Math.round(usd * 1e12) / 1e12;
const STOP_REASONS = new Set(["stop", "length", "toolUse", "error", "aborted", "deferred", "pending"]);

/** An answer's tokens, by the usage row's rule (timeline tokensOf): all four known, and some input unless it failed. */
function tokensOf(usage: unknown, failed: boolean): TraceTokens | null {
  const u = obj(usage);
  const [input, output] = [count(u?.input), count(u?.output)];
  const cacheRead = u?.cacheRead === undefined ? 0 : count(u.cacheRead);
  const cacheWrite = u?.cacheWrite === undefined ? 0 : count(u.cacheWrite);
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) return null;
  if (!(failed || input + cacheRead + cacheWrite > 0)) return null;
  const reasoning = count(u?.reasoning);
  return { input, cache_read: cacheRead, cache_write: cacheWrite, output, ...(reasoning !== undefined && reasoning <= output ? { reasoning } : {}) };
}

const keyOf = (conv: number | undefined, id: string | number) => `${conv ?? 0}:${id}`;

/** What came of a call's approval, by the call's id: `decision` absent while it still waits; `answered_at`, when it was
 *  answered or withdrawn, where the journal says. */
export type TraceApprovals = ReadonlyMap<string, { decision?: ApprovalAnswer["decision"]; answered_at?: string }>;

/** The approvals of a run's calls, from its journal's asks and answers (run-view.ts asksOf, answersOf), as its served
 *  Timeline reads them. `final`: the run's state where it is stopped or failed, whose end its journal may not hold. */
export function traceApprovals(entries: readonly { kind?: string; data?: unknown }[], final?: "stopped" | "failed"): TraceApprovals {
  const answers = answersOf(entries, final ? { final } : {});
  return new Map([...asksOf(entries).values()].map((ask) => {
    const answer = answers[ask.id];
    return [ask.call_id, answer ? { decision: answer.decision, ...(answer.answered_at ? { answered_at: answer.answered_at } : {}) } : {}];
  }));
}

/** The spans of a run whose served Timeline rows are `rows` and whose journal entries are `entries` (as the store keeps
 *  them: runEntries). `redact`: the run's cut, for the one text taken from an entry (a model's name); every other word is
 *  a row's, cut already. `approvals`: what came of each call that asked for one (traceApprovals): how such a call ended
 *  is read from there, never from its rows, which the Timeline rewords while it waits. `decisions`: a workflow run's
 *  decision receipts (store-reads/decisions.ts), each a model request of its own: a judge's, a route's, a verify's. */
export function traceSpans(rows: readonly TimelineEvent[], entries: readonly EntryLike[], options: { redact?: (text: string) => string; approvals?: TraceApprovals; decisions?: readonly Record<string, unknown>[] } = {}): Pick<RunTrace, "model_requests" | "spans" | "dropped"> {
  const said = (text: string) => (options.redact ? options.redact(text) : text);
  const cli = isCliRecord(entries);
  const booked = costIsBooked(entries, cli);
  // A CLI harness's messages are no requests (its booking counts those, with no time): none is a span.
  const requests = cli ? [] : answeredRequests(piShaped(entries));

  // Each call's rows are its own conversation's (two conversations may each make a call of one id), so a call is known
  // by both. The conversations that made a call of an id, in the order they did: a call named from another conversation
  // (a subagent's rows name the call that started it) is the first of them that is not the namer's own.
  const uses = rows.filter((row) => row.kind === "tool_use" && row.tool_use_id);
  const convsOf = new Map<string, number[]>();
  for (const row of uses) {
    const convs = convsOf.get(row.tool_use_id!) ?? [];
    if (!convs.includes(row.conversation_id ?? 0)) convsOf.set(row.tool_use_id!, [...convs, row.conversation_id ?? 0]);
  }
  /** The span id of call `callId` as conversation `conv`'s rows name it: its own call of that id where `own`, else another's. */
  const toolId = (callId: string, conv: number, own: boolean): string | null => {
    const convs = convsOf.get(callId) ?? [];
    const of = own && convs.includes(conv) ? conv : convs.find((other) => other !== conv);
    return of === undefined ? null : `t:${keyOf(of, callId)}`;
  };
  // The call that started each subagent conversation, and the label each conversation's rows carry. Every row of a
  // subagent's conversation names the call that started it, its first row too; a conversation whose first row names
  // none was started by no call (a call nested in one of its own names that call on its own rows alone).
  const startedBy = new Map<number, string>();
  const labels = new Map<number, string>();
  const first = new Set<number>();
  for (const row of rows) {
    const conv = row.conversation_id ?? 0;
    if (row.agent_label && !labels.has(conv)) labels.set(conv, row.agent_label);
    if (first.has(conv)) continue;
    first.add(conv);
    const started = row.parent_tool_use_id === undefined ? null : toolId(row.parent_tool_use_id, conv, false);
    if (started) startedBy.set(conv, started);
  }

  type Timed = TraceSpan & { at: number };
  const spans: Timed[] = [];
  const modelEnds = new Map<string, number | undefined>();
  for (const entry of requests) {
    const message = obj(entry.model?.[0]);
    const at = finite(message?.timestamp);
    const started = at === undefined ? undefined : iso(at);
    if (!message || at === undefined || started === undefined || entry.id === undefined) continue;
    const conv = entry.conversationId ?? 0;
    const took = count(message.durationMs);
    const ended = took === undefined ? undefined : iso(at + took);
    const failed = message.stopReason === "error";
    const aborted = message.stopReason === "aborted";
    const total = finite(obj(obj(message.usage)?.cost)?.total);
    modelEnds.set(keyOf(conv, entry.id), ended === undefined ? undefined : at + took!);
    spans.push({
      at, id: `m:${keyOf(conv, entry.id)}`, kind: "model", parent_id: startedBy.get(conv) ?? null,
      name: said(typeof message.model === "string" && message.model ? message.model : "model"), agent_label: labels.get(conv) ?? null,
      started_at: started, ended_at: ended ?? null, status: failed ? "failed" : aborted ? "interrupted" : "ok",
      stop_reason: typeof message.stopReason === "string" && STOP_REASONS.has(message.stopReason) ? message.stopReason : null,
      // A request cut before its end reported no final usage and no cost (the usage row counts it unknown).
      tokens: aborted ? null : tokensOf(message.usage, failed),
      usd: booked || aborted || total === undefined || total < 0 ? null : noiseOff(total), decision: false,
      charged: false, not_metered: false, tool_use_id: null, input_preview: null, result_preview: null, result_size_bytes: null,
    });
  }

  // A workflow's decisions: each receipt is one request to its decision model, written when it answered (`at`), with
  // how long it took, its tokens and its own cost. Its node is its label, as its Timeline row's is.
  (options.decisions ?? []).forEach((receipt, place) => {
    const ended = typeof receipt.at === "string" ? Date.parse(receipt.at) : Number.NaN;
    if (!Number.isFinite(ended)) return;
    const took = count(receipt.latency_ms);
    const at = took === undefined ? ended : ended - took;
    const usage = obj(receipt.usage);
    const [input, output] = [count(usage?.input_tokens), count(usage?.output_tokens)];
    const cost = finite(receipt.cost_usd);
    const named = typeof receipt.model === "string" && receipt.model ? receipt.model : typeof receipt.provider === "string" && receipt.provider ? receipt.provider : "decision";
    spans.push({
      at, id: `d:${String(receipt.id ?? place)}:${String(obj(receipt.request)?.index ?? 0)}`, kind: "model", parent_id: null,
      name: said(named), agent_label: typeof receipt.node === "string" && receipt.node ? said(receipt.node) : null,
      started_at: iso(at) ?? String(receipt.at), ended_at: took === undefined ? null : iso(ended) ?? null,
      status: receipt.status === "failed" || (receipt.status === undefined && typeof receipt.error === "string" && receipt.error !== "") ? "failed" : receipt.status === "cancelled" ? "interrupted" : "ok",
      stop_reason: null,
      // A receipt keeps its input whole, with no split by cache.
      tokens: input !== undefined && output !== undefined ? { input, cache_read: 0, cache_write: 0, output } : null,
      usd: cost !== undefined && cost >= 0 ? noiseOff(cost) : null, decision: true,
      charged: false, not_metered: false, tool_use_id: null, input_preview: null, result_preview: null, result_size_bytes: null,
    });
  });

  // How long each tool ran, where its result says (pi's monotonic clock): a pi call's row is dated by its request's start,
  // so the row alone would count the model's writing as the tool's time. In order, one for each result of a call's id.
  const ran = new Map<string, (number | undefined)[]>();
  for (const entry of entries) {
    const message = entry.kind === "pi.tool-result" ? obj(entry.model?.[0]) : undefined;
    if (!message || typeof message.toolCallId !== "string") continue;
    const key = keyOf(entry.conversationId, message.toolCallId);
    ran.set(key, [...(ran.get(key) ?? []), count(message.durationMs)]);
  }
  // Each call's result rows, in order (a conversation that made two calls of one id has two), and what was charged under
  // each: a charge is the call's it follows, so the second call of an id has its own.
  const results = new Map<string, TimelineEvent[]>();
  const charges = new Map<string, { known: number; unknown: boolean; charged: boolean; notMetered: boolean }>();
  const chargeOf = (key: string) => {
    let charge = charges.get(key);
    if (!charge) charges.set(key, (charge = { known: 0, unknown: false, charged: false, notMetered: false }));
    return charge;
  };
  const called = new Set(uses.map((row) => keyOf(row.conversation_id, row.tool_use_id!)));
  /** How many calls of each id its conversation has made so far, as the rows are read in order. */
  const sofar = new Map<string, number>();
  const occurrence = (key: string) => `${key}#${Math.max(0, (sofar.get(key) ?? 1) - 1)}`;
  for (const row of rows) {
    if (!row.tool_use_id) continue;
    // A row is its own conversation's call's; a charge written with no conversation of its own is the call's by its id.
    const own = keyOf(row.conversation_id, row.tool_use_id);
    const key = called.has(own) ? own : keyOf(convsOf.get(row.tool_use_id)?.[0] ?? row.conversation_id, row.tool_use_id);
    if (row.kind === "tool_use") sofar.set(key, (sofar.get(key) ?? 0) + 1);
    if (row.kind === "tool_result") results.set(key, [...(results.get(key) ?? []), row]);
    // A browser call's session time is folded into its own row; a paid tool's fee is a row of its own after the result.
    else if ((row.kind === "tool_use" || row.kind === "phase") && row.usage) {
      const charge = chargeOf(occurrence(key));
      charge.charged = true;
      if (row.usage.usd === null) charge.unknown = true;
      else charge.known += row.usage.usd;
    } else if (row.kind === "phase" && row.tool_name && !row.path && (row.summary ?? "").startsWith("Not metered:")) chargeOf(occurrence(key)).notMetered = true;
  }
  const made = new Map<string, number>();
  for (const use of uses) {
    const conv = use.conversation_id ?? 0;
    const key = keyOf(conv, use.tool_use_id!);
    // The nth call of an id in its conversation takes that conversation's nth result of it, and is a span of its own.
    const nth = made.get(key) ?? 0;
    made.set(key, nth + 1);
    const result = results.get(key)?.[nth];
    const shown = Date.parse(use.timestamp);
    const approval = nth === 0 ? options.approvals?.get(use.tool_use_id!) : undefined;
    // A result the renderer wrote for a call that never got one (timeline interrupt): the call was cut, and neither that
    // row's status nor its time is the call's. One the run's end closed (no status) was cut too, at its own time.
    const cutShort = result !== undefined && result.id.includes(":interrupted:");
    const answered = approval?.answered_at ? Date.parse(approval.answered_at) : Number.NaN;
    // How it ended, and when, where the record says: a call that asked for approval by what came of that (it waits, it
    // was withdrawn with its run and never ran, it was denied), any other by its result.
    const [status, done]: [TraceStatus, number | undefined] =
      approval && approval.decision === undefined ? ["waiting", undefined]
        : approval && (approval.decision === "canceled" || approval.decision === "withdrawn") ? ["interrupted", answered]
        : approval?.decision === "deny" ? ["refused", Number.isFinite(answered) ? answered : result ? Date.parse(result.timestamp) : undefined]
        : !result ? ["running", undefined]
        : cutShort ? ["interrupted", undefined]
        : result.refused ? ["refused", Date.parse(result.timestamp)]
        : result.tool_status === "failed" ? ["failed", Date.parse(result.timestamp)]
        : result.tool_status === "success" ? ["ok", Date.parse(result.timestamp)]
        : ["interrupted", Date.parse(result.timestamp)];
    const over = done !== undefined && Number.isFinite(done);
    const model = use.round === undefined ? undefined : keyOf(conv, use.round);
    const asked = model !== undefined && modelEnds.has(model);
    // How long it ran is its result's to say, for a call that ran to a result of its own.
    const took = status === "ok" || status === "failed" ? ran.get(key)?.[nth] : undefined;
    const after = asked ? modelEnds.get(model!) : undefined;
    // Where the result keeps how long the tool ran, it started that long before it ended; else when its request ended,
    // where that is known; else when its row says. Never after its own end.
    const from = over && took !== undefined ? done! - took : after !== undefined ? Math.max(shown, after) : shown;
    const at = over ? Math.min(from, done!) : from;
    const charge = charges.get(`${key}#${nth}`);
    const parent = asked ? `m:${model}` : use.parent_tool_use_id !== undefined ? toolId(use.parent_tool_use_id, conv, true) : null;
    spans.push({
      at, id: nth === 0 ? `t:${key}` : `t:${key}#${nth + 1}`, kind: "tool", parent_id: parent, name: use.tool_name ?? "tool", agent_label: use.agent_label ?? null,
      started_at: iso(at) ?? use.timestamp, ended_at: over ? iso(done!) ?? null : null, status,
      stop_reason: null, tokens: null,
      usd: charge?.charged ? (charge.unknown ? null : noiseOff(charge.known)) : null,
      decision: false, charged: charge?.charged ?? false, not_metered: charge?.notMetered ?? false,
      tool_use_id: use.tool_use_id, input_preview: use.tool_input_preview ?? null,
      // A call that never ran has no result of its own: what its rows say of it is the Timeline's words, not its output.
      result_preview: status === "waiting" || cutShort || (approval && status === "interrupted") ? null : result?.tool_result_preview ?? null,
      result_size_bytes: status === "waiting" || cutShort || (approval && status === "interrupted") ? null : result?.tool_result_size_bytes ?? null,
    });
  }
  // In the order they started; a request before the calls it made at the same instant.
  spans.sort((a, b) => a.at - b.at || (a.kind === b.kind ? 0 : a.kind === "model" ? -1 : 1) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const kept = spans.slice(0, TRACE_SPANS_MAX).map(({ at: _at, ...span }) => span);
  return { model_requests: cli ? "not_recorded" : booked ? "tokens_only" : "priced", spans: kept, dropped: spans.length - kept.length };
}

/** Run `runId`'s trace as served: its spans over its served Timeline rows and its journal, the model's name through the
 *  run's cut. A run withheld (its sign-in can't be read back here) is refused (403), as its graph and its files are:
 *  none of its words is served, and an empty trace would read as a run that did nothing. */
export async function servedRunTrace(deps: ServedTimelineDeps, store: Store, runId: string, context: Context): Promise<RunTrace> {
  if ((await runCutValues(deps, store, runId)) === "unreadable") throw new ApiError("forbidden", WITHHELD_SIGN_IN);
  const rows = await servedTimelineRows(deps, store, runId, context);
  // The cut after the rows: it only grows, so it holds every value the rows were cut of.
  const cut = await runCutValues(deps, store, runId);
  if (cut === "unreadable") throw new ApiError("forbidden", WITHHELD_SIGN_IN);
  const run = await store.runs.get(runId);
  const entries = await runEntries(store, runId, context);
  const approvals = traceApprovals(entries as never, run?.state === "stopped" || run?.state === "failed" ? run.state : undefined);
  // A workflow's decision receipts; a run that made none has none. Receipts that can't be read leave their spans out
  // (the run's usage row says its cost is unknown then: decision-rows.ts withDecisions).
  const decisions = await decisionsOverStore(store, runId, context).catch(() => []);
  return { run_id: runId, ...traceSpans(rows, entries, { redact: (text) => redacted(text, cut.values), approvals, decisions }) };
}
