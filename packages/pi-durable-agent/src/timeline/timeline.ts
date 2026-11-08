import { BROWSER_OPENERS, BROWSER_STEPS, callFailed, endsTurn, failedWith, inputPreview, labelOf, outcomeOf, savedPaths, type LabelFn, type ToolResultView } from "./labels.js";
import { cut, firstLine, firstSentence, json, obj, scrubUrls, str, utf8Bytes, type Obj } from "./util.js";
import { BESIDE_SUFFIX, NOTE_SUFFIX, originMatcher, type TriggerSource } from "./origin.js";

export type TimelineKind =
  | "thinking" | "text_block" | "tool_use" | "tool_result" | "phase"
  | "subagent_started" | "subagent_progress" | "subagent_completed" | "final_answer" | "error"
  | "user_message" | "waiting" | "usage"
  /** A workflow decision: a judge's answers or a route's branch (serve's decision rows). */
  | "decision"
  /** Where a run's learning ended: proposed, merged or dropped (serve's learning row). */
  | "learning"
  /** A tool call that waited for a person's approval, after its result's row (serve's tool gate). */
  | "tool_approval_requested";

/** Grep's public `TimelineEvent` (its 13 fields) plus the open additions, all optional. */
export type TimelineEvent = {
  id: string;
  timestamp: string;
  created_at: string;
  kind: TimelineKind;
  summary: string | null;
  agent_label: string | null;
  tool_name: string | null;
  tool_use_id: string | null;
  tool_status: "success" | "failed" | null;
  tool_input_preview: string | null;
  tool_result_preview: string | null;
  tool_result_size_bytes: number | null;
  text: string | null;
  /** Log order inside the run; a page sorts by it, never by time. */
  seq?: number;
  conversation_id?: number;
  /** The assistant entry whose calls these are. */
  round?: number;
  /** A nested call's caller, or a subagent's spawning call. */
  parent_tool_use_id?: string;
  /** The browser session a hand-over is about, as a tag; never a URL. */
  session?: string;
  /** The file a "Saved" phase row is about. */
  path?: string;
  /** `server` on the row of a message the server wrote into the run, `trigger` on a trigger's (origin.ts): a `phase` row,
   *  which counts, as a person's `user_message` does, as the message its turn took (`isMessageRow`). */
  origin?: "server" | "trigger";
  /** On a trigger's row (`origin: "trigger"`) alone: its trigger, from the message's origin, so a client labels the row
   *  by its source without reading its summary. */
  trigger?: { id: string; source: TriggerSource; owner: boolean };
  /** `true` on the server's `phase` row of a spend cap's refusal for room (serve), "Paused at the run's cap", origin
   *  server and its id ending NOTE_SUFFIX: the request was not sent and the run paused for a raise; a pause, never a
   *  failure, whether the run waits on its cap now or was raised since. */
  paused?: true;
  /** On the usage row, the run's cost. On a paid tool's charge row (a `phase` naming the tool), that charge alone. On a
   *  browser call's `tool_use` row, every browser charge booked under that call (BROWSER_CHARGE): its session's time
   *  since its last charge, and its release's when it was the session's last call. `requests` is 0 on all but the usage
   *  row. `so_far_usd` and `unpriced` (costsofar/1): while `usd` is null, the sum of every charge whose cost is known, and how
   *  many charges have no known cost (model requests cut, stopped, still pending or with no price, and paid tool calls
   *  charged an unknown amount or cut). Absent when `usd` is known. */
  usage?: { usd: number | null; requests: number; so_far_usd?: number; unpriced?: number; not_metered?: number };
};

/** A pi conversation entry as stored: `pi.assistant`, `pi.tool-result`, a host's own kind. */
export type EntryLike = { kind: string; id?: number; conversationId?: number; model?: readonly Obj[]; data?: unknown };
/** A pi `AgentEvent`, as `watchEvents` yields it and `GET /events` serves it. */
export type AgentEventLike = { type: string; [key: string]: unknown };

/** Grep's caps, so a row is the same on both sides. `thinking` cuts the first sentence of a thinking summary. */
export const CAPS = { summary: 500, preview: 500, text: 2000, thinking: 100 };

/** A host's marks of a model request: as it leaves (written before it does), and as its stream ends aborted. A request
 *  that answered or failed has a `pi.assistant` entry; one aborted before its first content has none; a start with no
 *  end and no entry is in flight when it is the latest, unless the run is settled, and was cut by a crash when a later
 *  one followed it or the run settled without it. A cut request's cost is unknown. */
export const REQUEST_STARTED = "agentrun.request_started";
/** An end with `unsent: true` withdraws its start: the request was refused after its mark, and never left. */
export const REQUEST_ENDED = "agentrun.request_ended";
/** What a request with no `pi.assistant` entry of its own cost (a side request, marked with a `request` label: pi's
 *  compaction summary, `"compaction"`, or a tool's own model request, such as a web search's): `usd`, or null when
 *  unknown. It closes that request, as an entry closes a generation's. `failed`: the request failed, and its counts are
 *  taken as they are, as a failed answer's are. */
export const REQUEST_COST = "agentrun.request_cost";
/** A request the host refused before it left (the run was cancelled): pi answers it with an error entry, which is not a
 *  request and not a failure to show, so the timeline skips the error entry that answers each refusal. */
export const REQUEST_REFUSED = "agentrun.request_refused";
/** Written right after an answer whose cost was not in when it was written (a harness's proxy books a response after
 *  answering it): that answer's cost is still to come, as a REQUEST_COST_LATE. Until it comes the cost is unknown. */
export const REQUEST_COST_PENDING = "agentrun.request_cost_pending";
/** The cost (`usd`, or null when unknown) of an answer written earlier with its cost pending: it closes one pending cost
 *  and adds to the run's cost. It is not a request of its own: the answer already counted that. */
export const REQUEST_COST_LATE = "agentrun.request_cost_late";
/** What a paid tool's call charged, written apart from any request as the tool reports it: `tool` and `charged_by` name
 *  it, `usd` is the charge, or null when the call may have charged and did not say how much. It adds to the run's cost,
 *  which is then unknown on a null, and shows as a row of its own; it is no model request. The usage row counts paid
 *  tool calls by `call`: a call that books several charges (a browser call, and its session's release under it) is one
 *  paid tool call, and one charge not priced when any of them is unknown. A browser charge (BROWSER_CHARGE) shows on its
 *  call's row instead. */
export const TOOL_COST = "agentrun.tool_cost";
/** The `tool` of a browser session's charge (serve's browser-cost.ts: `call`, the call it ran under, or for a release the
 *  session's last call; `tag`, the session; `conversation`, the browser's conversation). It makes no row: it folds into
 *  that call's `tool_use` row, as its `usage`, else into the last browser call charged for its session, else into its
 *  conversation's last browser call; only a charge with none of these (its calls compacted away) keeps a row of its own.
 *  A charge booked after the row was shown (a release after the answer) changes that row, by its id. */
export const BROWSER_CHARGE = "browser";
/** The tool whose charge a row carries, for a host that sums a run's paid tools from its rows: a charge row's tool (a
 *  `phase` with `usage`), `browser` for a browser step's call row (`tool_name` in BROWSER_STEPS) with its folded charges;
 *  undefined for any other row: another tool's call row, whatever it carries, and the usage row. */
export const chargedTool = (row: TimelineEvent): string | undefined =>
  !row.usage ? undefined : row.kind === "phase" ? (row.tool_name ?? undefined) : row.kind === "tool_use" && row.tool_name !== null && BROWSER_STEPS.has(row.tool_name) ? BROWSER_CHARGE : undefined;
/** The spend cap's wrap-up (serve's cap.ts): the run's model was told once, near its cap, to finish (`words`, what it was
 *  told). A row of its own, the server's ("AgentRun: …"); no request, no cost. */
export const CAP_WRAPUP = "agentrun.cap_wrapup";
/** A tool call with no price, run outside the run's cost and its cap (an MCP tool its owner set no price for): `tool`,
 *  `charged_by` and `call` name it. It shows as a row of its own, "not metered", and the usage row counts it
 *  (`not_metered`); it is no charge and never makes the cost unknown. */
export const TOOL_UNMETERED = "agentrun.tool_unmetered";
/** A paid tool's call marked before it is sent (`call`, and `heldUsd`, the most it is held to charge): the TOOL_COST of
 *  the same `call` settles it. Unsettled, it is in flight while the run is; once the run is settled it was cut (a crash),
 *  and the cost is unknown, as for a cut model request: what it charged no one knows, and its held figure is the cap's
 *  bound (serve's cap.ts), never a charge. */
export const TOOL_STARTED = "agentrun.tool_started";
/** Written right before a `pi.assistant` that continues the answer before it: a call that answer asked for, written once
 *  the answer's own entry was already in (a harness reports each call as it runs it, and its host writes an answer at its
 *  first call's end). It shows as that answer's, and is no request: no count, no cost, no tokens. */
export const REQUEST_CONTINUED = "agentrun.request_continued";
/** A host's own step, in its words (`summary`), such as a box waiting for its image: one `phase` row with that summary,
 *  cut at CAPS.summary. No request, no cost; one without a summary shows nothing. */
export const HOST_PHASE = "agentrun.phase";
const COMPACTION = "compaction";
const isCompaction = (entry: EntryLike) => obj(entry.data)?.request === COMPACTION;
/** A side request's mark: its `request` is a label (a generation's, a harness's request number, is not). */
const isSide = (entry: EntryLike) => typeof obj(entry.data)?.request === "string";
const unsent = (entry: EntryLike) => obj(entry.data)?.unsent === true;
/** A tool result an abort wrote (pi-durable's `aborted` diagnostic): the call was cut by a stop or a cancel, which ended
 *  its turn, not failed on its own. */
const abortedCall = (entry: EntryLike) => {
  const diagnostics = obj(entry.data)?.diagnostics;
  return Array.isArray(diagnostics) && diagnostics.some((diagnostic) => obj(diagnostic)?.code === "aborted");
};

/** Written on the root as a run's process opens to go on with a run its last process left unfinished: `after` is `crash`
 *  (that process died holding the run) or `server_stop` (it drained as the server stopped), `generation` the new
 *  process's, `at` when it opened. A phase row of its own, at that time; no request. */
export const RUN_RESUMED = "agentrun.run_resumed";
/** The end of a turn on another harness (claude-agent, codex), written on a run's root by serve as the turn's last entry:
 *  `{ key, status, ... }`. No row. The turn is over, so the next message is the person's next one, never a steer, even
 *  when the turn's last entry was a tool's result (a stop that came after it, before the next model request). */
export const TURN_END = "adapter.turn_end";

export type TimelineOptions = {
  /** For entries and events that carry no conversation id. */
  conversationId?: number;
  agentLabel?: (conversationId: number) => string | null | undefined;
  /** Labels for this call only; `registerLabel` adds them for every call. */
  labels?: Record<string, LabelFn>;
  caps?: Partial<typeof CAPS>;
  /** Nothing is running: a call with no result is interrupted. */
  settled?: boolean;
  /** The clock for retry and poll waits; live only. */
  now?: () => number;
  /** How a row names a file path a call gave (`path`, `file_path`) or saved: a host's name for it, such as one relative
   *  to its workspace. The entries, the call's arguments and its input preview, are not changed. Default: as given. */
  path?: (path: string) => string;
  /** What a row shows, made safe by the host before the row is cut (its secrets taken out): an error row's summary and
   *  text; a tool's whole output and its details before its label, summary and preview are taken from them; each string
   *  of a call's arguments where the call is first seen; a thinking block and a text block whole once settled. So a cut
   *  never falls inside what it takes out. Default: as given. */
  redact?: (text: string) => string;
  /** What a thinking or text block shows while it streams, given all of it that has streamed so far: the host's redacted
   *  prefix of it. A key whose head has streamed but not its tail cannot be found yet, and one a stream wraps is found
   *  only in the whole, so the host redacts the whole stream and holds back a tail as long as a key can take; the
   *  settled row replaces the live one whole when the block ends. Default: `redact` over the whole stream, with its
   *  trailing word held back until whitespace follows it or the block ends. A host that knows its held values should pass
   *  this for the full protection: a key a stream wraps with only part of its tail streamed is covered by a held-back
   *  tail as long as a key, not by the word holdback. */
  redactLive?: (text: string) => string;
};

/** A tool's calls in a run, and how many failed. */
export type ToolMetrics = { calls: number; errors: number };
/** What a run's entries say it used (`runMetricsOf`). Tokens as pi counts them: `input` is the input neither read from
 *  nor written to the cache, so the whole input is `input + cacheRead + cacheWrite`. */
export type RunMetrics = {
  input: number; cacheRead: number; cacheWrite: number; output: number;
  /** Model requests, as the usage row of a run that ended counts them. */
  requests: number;
  /** Of `requests`, those whose tokens are unknown: in no sum. A request cut before its end, a usage with no input or
   *  output count, and one that reports no input at all (a writer's zeros for a request it did not measure). */
  unmetered: number;
  /** Requests by `provider/model`; `model` is the one with the most (the first seen of a tie), absent when none names one. */
  models: Record<string, number>; model?: string;
  /** By tool name. A call with no result was interrupted: it counts as failed. */
  tools: Record<string, ToolMetrics>;
};
/** How runMetricsOf keeps the names a run's entries hold, which a model writes and may make up: each is one the agent
 *  store takes (non-empty, at most `max` UTF-16 units, no lone surrogate), the same name always the same key. A longer
 *  one is cut to its first `max - 1` units and "…". A run keeps its `kept` busiest tools and models (the first seen of a
 *  tie); the rest are summed under `otherTools` or `otherModels`, and a tool result with no name counts under
 *  `unnamedTool`. Those three start with one "…", and no entry's name does: one that starts with "…" gets another. */
export const METRIC_NAMES = Object.freeze({ max: 256, kept: 100, otherTools: "…other tools", otherModels: "…other models", unnamedTool: "…unnamed tool" });
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
/** A name from an entry, non-empty, as runMetricsOf keeps it (METRIC_NAMES). */
function metricName(name: string): string {
  const whole = (name.startsWith("…") ? `…${name}` : name).replace(LONE_SURROGATE, "\uFFFD");
  if (whole.length <= METRIC_NAMES.max) return whole;
  const kept = whole.slice(0, METRIC_NAMES.max - 1);
  return `${/[\uD800-\uDBFF]$/.test(kept) ? kept.slice(0, -1) : kept}…`;
}
/** `counts` as a record of its METRIC_NAMES.kept busiest names (the first seen of a tie), the rest summed under `other`. */
function keepBusiest<T>(counts: Map<string, T>, size: (value: T) => number, sum: (a: T, b: T) => T, other: string): Record<string, T> {
  if (counts.size <= METRIC_NAMES.kept) return Object.fromEntries(counts);
  const ranked = [...counts].sort(([, a], [, b]) => size(b) - size(a));
  return Object.fromEntries([...ranked.slice(0, METRIC_NAMES.kept), [other, ranked.slice(METRIC_NAMES.kept).map(([, value]) => value).reduce(sum)]]);
}
type Tokens = Pick<RunMetrics, "input" | "cacheRead" | "cacheWrite" | "output">;
const tokenCount = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined);
/** A usage's tokens: undefined unless it has an input and an output count (a cache count it omits is 0), and unless it
 *  has some input. A request that reached a model always sent some, so a usage with none is a writer's zeros for a
 *  request it did not measure (an imported transcript's, a harness answer's written with no booking): unknown, never 0.
 *  `failed`: a failed request's counts are taken as they are, as its cost is. */
function tokensOf(usage: unknown, failed = false): Tokens | undefined {
  const u = obj(usage);
  const [input, output, cacheRead, cacheWrite] = [tokenCount(u?.input), tokenCount(u?.output), u?.cacheRead === undefined ? 0 : tokenCount(u.cacheRead), u?.cacheWrite === undefined ? 0 : tokenCount(u.cacheWrite)];
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) return undefined;
  return failed || input + cacheRead + cacheWrite > 0 ? { input, cacheRead, cacheWrite, output } : undefined;
}

/** A run's model requests as its entries mark them: how many, what they cost and the tokens they used. The usage row
 *  and runMetricsOf count through it. `push` says what an entry was: an answer (a `pi.assistant` that is a request), a
 *  continuation of the answer before it (shown with it, not a request), a mark (a request's mark or cost, or pi's answer
 *  to a request that never left: nothing to show), or neither. */
function createMeter() {
  let requests = 0;
  // The run's cost: the known sum, the costs no one knows, and the costs written as pending, still to come (each with
  // whether its answer's tokens were unknown: its late cost's usage then stands in for them).
  let known = 0;
  let unknown = 0;
  // Paid tool calls whose charges are in the cost (TOOL_COST), each once however many it booked (paidCallOf), and calls
  // with no price, run outside it (TOOL_UNMETERED).
  const paidCalls = new Set<string>();
  // Of those, the calls with a charge whose cost is unknown: each one charge not priced, however many it booked.
  const unpricedCalls = new Set<string>();
  // The call each browser session was last charged under (BROWSER_CHARGE's `tag`): a charge of it with no call of its
  // own, a release after the run's last call, is that call's.
  const sessionCall = new Map<string, string>();
  let notMetered = 0;
  /** The paid call a TOOL_COST is for: its `call`; a browser charge with none (a release a reopened process made), the
   *  call its session was last charged under; else a call of its own, as an older entry with no `call` is. */
  const paidCallOf = (data: Obj | undefined): string => {
    const [call, tag] = [str(data?.call), data?.tool === BROWSER_CHARGE ? str(data?.tag) : undefined];
    if (call && tag) sessionCall.set(tag, call);
    return call ?? (tag ? sessionCall.get(tag) : undefined) ?? `#${(unplaced += 1)}`;
  };
  // Charges that name no call the run can place: each a call of its own.
  let unplaced = 0;
  // Paid tool calls marked and not yet settled, by call.
  const held = new Map<string, unknown>();
  const pending: boolean[] = [];
  const addCost = (cost: unknown) => (typeof cost === "number" && Number.isFinite(cost) ? (known += cost) : (unknown += 1));
  let marked = 0;
  let inFlight = false;
  let refused = 0;
  // Requests a host's spend cap refused (a start mark of their own, `capRefused`), still to be answered by pi's error
  // entry: never sent, so no request, no cost and no figure. A request started after one means its entry never came.
  let capRefusals = 0;
  // Whether the cap refused one: a run with no request but that refusal says so on its usage line.
  let refusedAny = false;
  // What the cap limited the latest generation request's output to, when it did (its start mark's `clamp`).
  let lastClamp: Clamp | undefined;
  // Continuations of an answer still to come (REQUEST_CONTINUED): each next pi.assistant shows and is not counted.
  let continued = 0;
  // Answers to marked requests: those after the first mark (a request is marked before it leaves, so before its
  // answer). Earlier answers are a run's from before requests were marked.
  let answered = 0;
  // Side requests (compactions, a tool's own requests), apart: one may run beside a generation. Each closes with its
  // cost, or with an end when aborted.
  let compactions = 0;
  let compacting = 0;
  // How many are in flight: two side requests (a turn's parallel searches) may be.
  let sidesOpen = 0;
  const tokens: Tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  // Requests whose tokens are unknown, and whether the latest answer's were.
  let unmetered = 0;
  let lastUnmetered = false;
  const addTokens = (counted: Tokens | undefined) => {
    if (!counted) return void (unmetered += 1);
    for (const key of ["input", "cacheRead", "cacheWrite", "output"] as const) tokens[key] += counted[key];
  };
  const models = new Map<string, number>();

  function push(entry: EntryLike): "answer" | "continued" | "refusal" | "mark" | "charge" | "unmetered" | undefined {
    const message = entry.model?.[0];
    const data = obj(entry.data);
    if (entry.kind === REQUEST_REFUSED) {
      refused += 1;
    } else if (entry.kind === "pi.assistant" && refused > 0 && message?.stopReason === "error") {
      // pi's answer to a request that never left: nothing to count or show.
      refused -= 1;
    } else if (entry.kind === REQUEST_CONTINUED) {
      continued += 1;
    } else if (entry.kind === "pi.assistant" && continued > 0 && message) {
      // The answer before it, continued: shown, never counted again.
      continued -= 1;
      return "continued";
    } else if (entry.kind === REQUEST_STARTED && isSide(entry)) {
      compacting += 1;
      sidesOpen += 1;
    } else if (entry.kind === REQUEST_ENDED && isSide(entry)) {
      if (unsent(entry)) compacting -= 1;
      sidesOpen = Math.max(0, sidesOpen - 1);
    } else if (entry.kind === REQUEST_COST) {
      compactions += 1;
      sidesOpen = Math.max(0, sidesOpen - 1);
      addCost(data?.usd);
      addTokens(tokensOf(data?.usage, data?.failed === true));
    } else if (entry.kind === TOOL_STARTED) {
      held.set(str(data?.call) ?? `#${held.size}`, data?.heldUsd);
    } else if (entry.kind === TOOL_COST) {
      held.delete(str(data?.call) ?? "");
      const call = paidCallOf(data);
      paidCalls.add(call);
      // Its cost joins the run's; an unknown one makes it unknown, counted once for its call.
      const usd = data?.usd;
      if (typeof usd === "number" && Number.isFinite(usd)) known += usd;
      else if (!unpricedCalls.has(call)) (unpricedCalls.add(call), (unknown += 1));
      return "charge";
    } else if (entry.kind === TOOL_UNMETERED) {
      notMetered += 1;
      return "unmetered";
    } else if (entry.kind === REQUEST_COST_PENDING) {
      // The answer just before it was counted as a cost unknown: it is one still to come.
      if (unknown > 0) (unknown -= 1), pending.push(lastUnmetered);
    } else if (entry.kind === REQUEST_COST_LATE) {
      // The answer it prices was written before its usage came in: its usage, when it has one, is that answer's tokens.
      const late = tokensOf(data?.usage);
      if (pending.shift() && late) (unmetered -= 1), addTokens(late);
      addCost(data?.usd);
    } else if (entry.kind === REQUEST_STARTED && data?.capRefused === true) {
      // Its own mark, written before pi's entry for it: a request that never left marks nothing and holds nothing.
      capRefusals += 1;
    } else if (entry.kind === "pi.assistant" && capRefusals > 0 && message?.stopReason === "error") {
      // pi's entry for a request the cap refused: shown as the refusal, never counted.
      capRefusals -= 1;
      refusedAny = true;
      return "refusal";
    } else if (entry.kind === REQUEST_STARTED) {
      capRefusals = 0;
      marked += 1;
      inFlight = true;
      lastClamp = clampOf(data?.clamp);
    } else if (entry.kind === REQUEST_ENDED) {
      if (unsent(entry)) marked -= 1;
      inFlight = false;
    } else if (entry.kind === "pi.assistant" && message) {
      requests += 1;
      if (marked > 0) answered += 1;
      const name = str(message.model);
      if (name) {
        const key = metricName(str(message.provider) ? `${str(message.provider)}/${name}` : name);
        models.set(key, (models.get(key) ?? 0) + 1);
      }
      // A request cut before its end has no final usage: its stream had reported none (the Responses API reports it at
      // the end) or only the start (Anthropic's input and first token), never what the provider charged. Unknown.
      const aborted = message.stopReason === "aborted";
      addCost(aborted ? undefined : obj(obj(message.usage)?.cost)?.total);
      const counted = aborted ? undefined : tokensOf(message.usage, message.stopReason === "error");
      lastUnmetered = !counted;
      addTokens(counted);
      return "answer";
    } else return undefined;
    return "mark";
  }

  /** The usage row's count and cost; undefined while there is nothing to count. `settled`: nothing is running. While the
   *  cost is unknown, `so_far_usd` is the sum of the charges whose cost is known and `unpriced` how many have none: each
   *  cost no one knows (an answer or summary with none, a stopped request's, a paid tool charge), each still pending, each
   *  request cut before any answer, and each paid tool call a settled run never settled. No ceiling is claimed. */
  function usage(settled: boolean): { usd: number | null; requests: number; charges: number; so_far_usd?: number; unpriced?: number; not_metered?: number } | undefined {
    // A request marked as it left with no entry for it, other than one still in flight: counted, at a cost no one knows.
    // One in flight alone makes no row yet, so the row appears where it did before requests were marked.
    // A settled run has nothing in flight: its last request with no entry, or its open compaction, was cut by the
    // process that ended.
    const open = (flying: boolean) => (flying && !settled ? 1 : 0);
    const cut = marked - open(inFlight) > answered || compacting - (settled ? 0 : sidesOpen) > compactions;
    // A paid tool call cut by a crash: its charge is unknown, so the cost is.
    const cutCalls = settled ? held.size : 0;
    const unmetered = notMetered ? { not_metered: notMetered } : {};
    if (!requests && !compactions && !cut && !paidCalls.size && !cutCalls) return refusedAny || notMetered ? { usd: 0, requests: 0, charges: 0, ...unmetered } : undefined;
    const count = requests + Math.max(0, marked - answered) + Math.max(compactions, compacting);
    const usd = unknown > 0 || pending.length > 0 || cut || cutCalls > 0 ? null : Math.round(known * 1e6) / 1e6;
    const unpriced = unknown + pending.length + Math.max(0, marked - open(inFlight) - answered) + Math.max(0, compacting - (settled ? 0 : sidesOpen) - compactions) + cutCalls;
    return { usd, requests: count, charges: paidCalls.size + cutCalls, ...(usd === null && unpriced > 0 ? { so_far_usd: Math.round(known * 1e6) / 1e6, unpriced } : {}), ...unmetered };
  }

  // A workflow's decision requests (Jev, Parallel), from its receipts: requests of their own, beside its entries'.
  let decided = 0;
  function decide(row: DecisionLike): void {
    decided += 1;
    const name = str(row.model);
    if (name) {
      const key = metricName(str(row.provider) ? `${str(row.provider)}/${name}` : name);
      models.set(key, (models.get(key) ?? 0) + 1);
    }
    // A cancelled request's tokens are unknown, as an aborted answer's are; so are those of one whose spend its driver's
    // state keeps, which no record here holds.
    const u = obj(row.usage);
    addTokens(row.status === "cancelled" || row.driver_spend === true || !u ? undefined : tokensOf({ input: u.input_tokens, output: u.output_tokens }, row.status === "failed"));
  }

  /** The counts of a run that ended: a request it cut has unknown tokens. */
  function settled(): Omit<RunMetrics, "tools"> {
    const all = (usage(true)?.requests ?? 0) + decided;
    const cut = Math.max(0, marked - answered) + Math.max(0, compacting - compactions);
    let model: string | undefined;
    for (const [key, n] of models) if (model === undefined || n > models.get(model)!) model = key;
    const kept = keepBusiest(models, (n) => n, (a, b) => a + b, METRIC_NAMES.otherModels);
    return { ...tokens, requests: all, unmetered: Math.min(all, unmetered + cut), models: kept, ...(model !== undefined ? { model } : {}) };
  }

  return { push, decide, usage, clamp: () => lastClamp, settled };
}

type OpenCall = { conv: number; name: string; args: Obj; round?: number; use: TimelineEvent; done: boolean };

const TAG = /^[\w.-]{1,64}$/;
const blocksOf = (message: Obj | undefined): Obj[] => {
  const content = message?.content;
  return Array.isArray(content) ? content.flatMap((block): Obj[] => { const one = obj(block); return one ? [one] : []; }) : typeof content === "string" ? [{ type: "text", text: content }] : [];
};
const textOf = (message: Obj | undefined, type = "text", field = "text") =>
  blocksOf(message).filter((block) => block.type === type).map((block) => str(block[field]) ?? "").join("\n").trim();
/** Every string a row shows goes through here: a URL keeps its origin, path and query keys, then the text is cut. */
const clean = (text: string, max: number) => cut(scrubUrls(text), max);
/** The rows that show words as a person or the agent wrote them: cut, never scrubbed. */
const WHOLE: ReadonlySet<TimelineKind> = new Set(["user_message", "text_block", "final_answer"]);
/** An error's whole text as the host's `redact` makes it, before its first line becomes a summary or either is cut, so
 *  neither keeps part of what the whole text's redaction takes out. */
const redactOf = (options: TimelineOptions) => (text: string): string => (options.redact ? options.redact(text) : text);
const dollars = (usd: number) => (usd === 0 ? "$0" : `$${usd.toFixed(4)}`);

/** What a host's spend cap limited a request's output to (its start mark's `clamp`): the tokens, what was left of the
 *  cap for it, and the cap. */
type Clamp = { tokens: number; leftUsd: number; capUsd: number };
function clampOf(value: unknown): Clamp | undefined {
  const clamp = obj(value);
  const [tokens, leftUsd, capUsd] = [clamp?.tokens, clamp?.leftUsd, clamp?.capUsd];
  const amount = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
  return Number.isSafeInteger(tokens) && (tokens as number) > 0 && amount(leftUsd) && amount(capUsd) ? { tokens: tokens as number, leftUsd, capUsd } : undefined;
}
/** An amount in words: two decimals, or as many as it takes (up to six) to show it. */
function amount(usd: number): string {
  for (let digits = 2; digits < 6; digits++) if (Number(usd.toFixed(digits)) === Number(usd.toFixed(6))) return `$${usd.toFixed(digits)}`;
  return `$${usd.toFixed(6)}`;
}
/** What a reply the cap's clamp cut short says. */
const clampSaid = (clamp: Clamp) => `The reply stopped at ${clamp.tokens.toLocaleString("en-US")} tokens: all that the ${amount(clamp.leftUsd)} left of the run's ${amount(clamp.capUsd)} cap could buy.`;
/** The message of a result that is only the harness's diagnostics block (`<harness>`, then `[error] …` lines), as a
 *  call that threw or named a tool its run does not offer answers: its first error's, else its first line's, without
 *  the severity. Undefined for any other text, whose own first line says what happened. */
function diagnosticOf(text: string): string | undefined {
  const lines = text.trim().split("\n").map((line) => line.trim());
  if (lines[0] !== "<harness>") return undefined;
  const end = lines.indexOf("</harness>");
  const inner = lines.slice(1, end < 0 ? undefined : end).filter(Boolean);
  const said = inner.map((line) => /^\[(\w+)\]\s*(.*)$/.exec(line)).filter((match): match is RegExpExecArray => match !== null);
  const first = said.find((match) => match[1] === "error") ?? said[0];
  return first ? (first[2] ?? "") : (inner[0] ?? "");
}

/** One place turns entries into rows, whether they come from a released store or from live events. */
function createProjector(options: TimelineOptions) {
  const redactedWhy = redactOf(options);
  const caps = { ...CAPS, ...options.caps };
  /** A call's arguments as its rows name them: its file path as the host names it (`options.path`). */
  const shown = (args: Obj): Obj => {
    if (!options.path) return args;
    const named = (value: unknown) => (typeof value === "string" && value ? options.path!(value) : value);
    return "path" in args || "file_path" in args ? { ...args, ...("path" in args ? { path: named(args.path) } : {}), ...("file_path" in args ? { file_path: named(args.file_path) } : {}) } : args;
  };
  const label = (tool: string, args: Obj, result?: ToolResultView) => labelOf(tool, shown(args), result, options.labels);
  const seen = new Set<string>();
  const calls = new Map<string, OpenCall>();
  // Results stored before their call (a harness bridge once wrote a result before the answer holding its call), by
  // `conversation:id`: the call, when it comes, takes its result and is done.
  const early = new Map<string, { row: TimelineEvent; view: ToolResultView; shown: ToolResultView }>();
  const previous = new Map<number, string>();
  // Whether every tool of the conversation's latest round ends the turn, or a turn's end (TURN_END) came after it: then
  // the turn is over, and what comes next is the person's next message, not a steer.
  const ended = new Map<number, boolean>();
  // Conversations whose turn an abort cut since their latest tool round (a stop, a cancel): an aborted tool, or a model
  // request that had left and was aborted. That turn is over too, so the next message comes in a new turn, never a steer.
  const cutTurns = new Set<number>();
  const systems = new Set<number>();
  const browsers = new Set<number>();
  // Browser charges (BROWSER_CHARGE), folded into their call's row: what each row's charges sum to, the call each session
  // was last charged under, and each conversation's latest browser call.
  const folded = new Map<TimelineEvent, { known: number; unpriced: boolean }>();
  const sessionCalls = new Map<string, OpenCall>();
  const browserCalls = new Map<number, OpenCall>();
  const children = new Map<number, string>();
  const rows: TimelineEvent[] = [];
  let seq = 0;
  let stamp = 0;
  let root: number | undefined;
  let current = options.conversationId ?? 0;
  const meter = createMeter();
  // Each conversation's latest answer, by entry id: a continuation's calls show under it.
  const answers = new Map<number, number | undefined>();
  // Per conversation, the text answer that ended its request, until its turn shows whether it was the last thing said: a
  // later answer, or a continuation, with text or a call makes it a text_block (a harness's commentary before a tool of
  // its own, which its host never sees as a call); a person's message settles it. A later answer of the same turn, an
  // empty one too, takes its place, so the earlier one is a text_block then.
  const provisional = new Map<number, TimelineEvent>();
  /** Which user entries the server wrote (origin.ts): each shows as the server's, never as the person's. */
  const origins = originMatcher();

  function make(kind: TimelineKind, conv: number, id: string, fields: Partial<TimelineEvent> = {}): TimelineEvent {
    const timestamp = new Date(stamp).toISOString();
    const next = seq++;
    const row: TimelineEvent = {
      id, timestamp, created_at: timestamp, kind, summary: null, agent_label: options.agentLabel?.(conv) ?? null,
      tool_name: null, tool_use_id: null, tool_status: null, tool_input_preview: null, tool_result_preview: null,
      tool_result_size_bytes: null, text: null, conversation_id: conv, ...fields, seq: fields.seq ?? next,
    };
    const parent = fields.parent_tool_use_id ?? children.get(conv);
    if (parent !== undefined) row.parent_tool_use_id = parent;
    if (kind === "error" && options.redact) {
      if (row.summary !== null) row.summary = options.redact(row.summary);
      if (row.text !== null) row.text = options.redact(row.text);
    }
    // A person's own message and the agent's own words (its text, its answer) show as written, their held keys redacted
    // (readMessage): a URL in them keeps its fragment and query values. scrubUrls is for the URLs of what the model read
    // (a tool's result, a page's title, a call's arguments) and for its thinking.
    const whole = WHOLE.has(kind);
    if (row.summary !== null) row.summary = whole ? cut(row.summary, caps.summary) : clean(row.summary, caps.summary);
    if (row.tool_input_preview !== null) row.tool_input_preview = clean(row.tool_input_preview, caps.preview);
    if (row.tool_result_preview !== null) row.tool_result_preview = clean(row.tool_result_preview, caps.preview);
    if (row.text !== null) row.text = whole ? cut(row.text, caps.text) : clean(row.text, caps.text);
    for (const key of ["round", "parent_tool_use_id", "session", "path", "usage", "origin"] as const) if (row[key] === undefined) delete row[key];
    return row;
  }

  const viewOf = (message: Obj): ToolResultView => ({ text: textOf(message), details: message.details, isError: message.isError === true });
  /** Text as the host's `redact` makes it (as given without one). */
  const redactText = (text: string): string => (options.redact && text ? options.redact(text) : text);
  /** A value (a call's arguments, a result's details) with each of its strings as the host's `redact` makes it, so a
   *  label, a preview or an answer taken from it holds none of what redaction takes out. */
  const redactValue = (value: unknown): unknown => {
    if (!options.redact) return value;
    if (typeof value === "string") return redactText(value);
    if (Array.isArray(value)) return value.map(redactValue);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item)]));
    return value;
  };
  /** A call's arguments as its rows may show them: redacted once, where the call is first seen (redactValue). */
  const argsOf = (args: Obj): Obj => (options.redact ? (redactValue(args) as Obj) : args);
  /** An outcome's words as the summary shows them: its verdict (`failed:`, `refused:`) as read, and only what follows it
   *  redacted, so a redaction that takes the whole detail still leaves the verdict, as the row's status says. */
  const saidOf = (text: string): string => {
    const verdict = /^(\w+): /.exec(text);
    return verdict ? `${verdict[1]}: ${scrubUrls(firstLine(redactText(text.slice(verdict[0].length))))}` : scrubUrls(firstLine(redactText(text)));
  };
  /** A result as its rows show it: its whole output redacted once, which its label, summary and preview are all taken
   *  from (resultRow); its details and error flag as they came. */
  const shownOf = (view: ToolResultView): ToolResultView =>
    options.redact ? { ...view, text: view.text ? options.redact(view.text) : view.text, details: redactValue(view.details) } : view;
  const failure = (text: string) => scrubUrls(firstLine(str(json(text)?.message) ?? diagnosticOf(text) ?? text)) || "no detail";
  /** The `tool_use` row of a call; `fields` is what differs between a stored call and a nested one. */
  const useRow = (conv: number, rowId: string, callId: string, name: string, args: Obj, fields: Partial<TimelineEvent>) =>
    make("tool_use", conv, rowId, { summary: label(name, args), tool_name: name, tool_use_id: callId, tool_input_preview: inputPreview(args, caps.preview), ...fields });
  /** The `tool_result` row of a finished call, named `named`; `parent` is a nested call's caller. */
  /** A call that returned but whose result says it did not do its work (a refused fetch) reads as that, failed. Its
   *  outcome is read once, for the summary and the status both. */
  /** A tool's output, like an error, can carry a key its provider echoed. What its rows show of it (the call's label, the
   *  result's summary and preview) comes from `shown`, its whole text as the host's `redact` makes it (shownOf, once per
   *  result), before any of it is taken or cut, so none keeps a piece of a key. Whether it failed, and why, is read from
   *  the output as it came (`view`), as its status is; only the words the summary shows of that are redacted. */
  const resultRow = (conv: number, rowId: string, tool: { name: string; callId: string | null; round?: number }, named: string, view: { text: string; isError: boolean }, shown: { text: string }, parent?: string) => {
    const outcome = outcomeOf(tool.name, view);
    return make("tool_result", conv, rowId, {
      summary: view.isError ? `${named} failed: ${failure(shown.text)}` : outcome ? `${named}: ${saidOf(outcome.text)}` : `${named}: ok`, tool_name: tool.name, tool_use_id: tool.callId,
      tool_status: failedWith(view, outcome) ? "failed" : "success", tool_result_preview: shown.text ? cut(scrubUrls(shown.text), caps.preview) : null,
      tool_result_size_bytes: utf8Bytes(view.text), round: tool.round, parent_tool_use_id: parent,
    });
  };

  /** The call a browser charge belongs to (BROWSER_CHARGE): the one it names, else its session's last charged call, else
   *  its conversation's latest browser call. Only a browser step's call (BROWSER_STEPS), so every row a charge folds into
   *  is one chargedTool names the browser's. Undefined when none is in these rows. */
  function browserCallOf(data: Obj | undefined): OpenCall | undefined {
    const [id, tag] = [str(data?.call), str(data?.tag)];
    const conv = typeof data?.conversation === "number" ? data.conversation : undefined;
    const found = id ? ((conv === undefined ? undefined : calls.get(`${conv}:${id}`)) ?? [...calls.values()].find((call) => call.use.tool_use_id === id)) : undefined;
    const named = found && BROWSER_STEPS.has(found.name) ? found : undefined;
    const call = named ?? (tag ? sessionCalls.get(tag) : undefined) ?? (conv === undefined ? undefined : browserCalls.get(conv));
    if (call && tag) sessionCalls.set(tag, call);
    return call;
  }

  /** Adds a browser charge (`usd`, null when unknown) to the `usage` of its call's row, which is returned. The row is one
   *  call, so a charge with no price makes it one not priced (`unpriced: 1`) however many it booked, as the usage row
   *  counts a paid call once. */
  function foldCharge(row: TimelineEvent, usd: number | null): TimelineEvent {
    const sum = folded.get(row) ?? { known: 0, unpriced: false };
    if (usd === null) sum.unpriced = true;
    else sum.known += usd;
    folded.set(row, sum);
    const known = Math.round(sum.known * 1e12) / 1e12;
    row.usage = sum.unpriced ? { usd: null, requests: 0, so_far_usd: known, unpriced: 1 } : { usd: known, requests: 0 };
    return row;
  }

  /** A call that spawned a conversation: its rows, and the child's, now name it as their parent. */
  function adopt(conv: number, child: number, callId: string, args: Obj, fallback: string): TimelineEvent[] {
    if (children.has(child) || child === conv) return [];
    children.set(child, callId);
    const patched = rows.filter((row) => row.conversation_id === child);
    for (const row of patched) row.parent_tool_use_id ??= callId;
    const task = str(args.task) ?? str(args.prompt) ?? str(args.description) ?? fallback;
    const started = make("subagent_started", conv, `${conv}:sub:${callId}`, { summary: `Subagent: ${firstLine(task)}`, tool_use_id: callId });
    rows.push(started);
    return [...patched, started];
  }

  function push(entry: EntryLike): TimelineEvent[] {
    const conv = entry.conversationId ?? options.conversationId ?? 0;
    if (entry.id !== undefined) {
      const key = `${conv}:${entry.id}`;
      if (seen.has(key)) return [];
      seen.add(key);
    }
    root ??= conv;
    current = conv;
    const message = entry.model?.[0];
    const origin = origins({ ...entry, conversationId: conv });
    const at = message?.timestamp;
    if (typeof at === "number" && Math.abs(at) <= 8.64e15) stamp = at;
    const base = `${conv}:${entry.id ?? seq}`;
    const out: TimelineEvent[] = [];
    const add = (row: TimelineEvent) => { rows.push(row); out.push(row); };
    const touch = (row: TimelineEvent) => { if (!out.includes(row)) out.push(row); };

    if (entry.kind === CAP_WRAPUP) {
      // What the run's model was told near its cap: the server's row (`origin: "server"`, in the words of its other rows),
      // no request, no cost, and no message any turn took (its id ends in NOTE_SUFFIX, which isMessageRow passes over).
      const words = str(obj(entry.data)?.words);
      if (words) add(make("phase", conv, `${base}${NOTE_SUFFIX}`, { summary: `AgentRun: ${words}`, text: words, origin: "server" }));
      return out;
    }
    const metered = meter.push(entry);
    if (metered === "mark") {
      // A request's mark or cost, or pi's answer to a request that never left: counted, nothing to show.
    } else if (metered === "refusal" && message) {
      // A request the run's cap refused, never sent: no request. Its text is the error as written (a host reads its code
      // from it), its summary the cap's own words, after the code ("Not sent: ...").
      const why = redactedWhy(str(message.errorMessage) ?? "spend_cap_reached: Not sent: the run's spend cap refused the request.");
      const words = why.replace(/^spend_cap_reached(?: \([^)]*\))?: /, "");
      add(make("error", conv, base, { summary: firstLine(words.startsWith("Not sent:") ? words : `Not sent: ${words}`), text: why }));
    } else if (metered === "charge") {
      // A paid tool's charge: counted in the cost, and shown on a line of its own, or a browser's on its call's row.
      const data = obj(entry.data);
      const [tool, by, usd] = [str(data?.tool) ?? "a tool", str(data?.charged_by) ?? "its provider", data?.usd];
      const amount = typeof usd === "number" && Number.isFinite(usd) ? dollars(usd) : "an unknown amount";
      // Its `usage` is the charge alone (no request): a host sums a run's paid tools from the same rows as its cost.
      const charge = typeof usd === "number" && Number.isFinite(usd) ? usd : null;
      const call = tool === BROWSER_CHARGE ? browserCallOf(data) : undefined;
      if (call) touch(foldCharge(call.use, charge));
      else add(make("phase", conv, base, { summary: `Tool cost: ${by} charged ${amount} for ${tool}`, tool_name: tool, tool_use_id: str(data?.call) ?? null, usage: { usd: charge, requests: 0 } }));
    } else if (metered === "unmetered") {
      // A call with no price: shown, never counted in the cost.
      const data = obj(entry.data);
      const tool = str(data?.tool) ?? "a tool";
      add(make("phase", conv, base, { summary: `Not metered: ${tool} has no price set, so it is outside the run's cost`, tool_name: tool, tool_use_id: str(data?.call) ?? null }));
    } else if ((metered === "answer" || metered === "continued") && message) {
      const round = metered === "continued" && answers.has(conv) ? answers.get(conv) : entry.id;
      if (metered === "answer") answers.set(conv, entry.id);
      if (message.stopReason === "error") {
        const why = redactedWhy(str(message.errorMessage) ?? "unknown error");
        add(make("error", conv, base, { summary: `Model request failed: ${firstLine(why)}`, text: why }));
      } else if (message.stopReason !== "aborted") {
        const blocks = blocksOf(message);
        const settled = provisional.get(conv);
        if (settled && (textOf(message) || blocks.some((block) => block.type === "toolCall"))) {
          settled.kind = "text_block";
          touch(settled);
          provisional.delete(conv);
        }
        const first = (type: string) => blocks.findIndex((block) => block.type === type);
        const thinking = scrubUrls(redactText(textOf(message, "thinking", "thinking")));
        if (thinking) add(make("thinking", conv, `${base}:${first("thinking")}`, { summary: `Thinking: ${cut(firstSentence(thinking), caps.thinking)}`, text: thinking }));
        const text = redactText(textOf(message));
        const final = message.stopReason === "stop" && !blocks.some((block) => block.type === "toolCall");
        // A final stop's text block is its answer even when empty: the model ended its turn on purpose, with nothing to
        // say. A message with no text block (a request the adapter bridge writes without content) shows none.
        // An answer its turn goes on from is a text_block (provisional, below), an empty one too.
        if (text || (final && first("text") >= 0)) {
          const row = make(final ? "final_answer" : "text_block", conv, `${base}:${first("text")}`, { summary: firstLine(text), text });
          add(row);
          if (final) {
            const earlier = provisional.get(conv);
            if (earlier) {
              earlier.kind = "text_block";
              touch(earlier);
            }
            provisional.set(conv, row);
          }
        }
        // A reply that stopped at the output its request's cap limited it to says so, with the numbers.
        const clamp = metered === "answer" && message.stopReason === "length" ? meter.clamp() : undefined;
        if (clamp) add(make("phase", conv, `${base}:clamp`, { summary: clampSaid(clamp) }));
        blocks.forEach((block, index) => {
          const [id, name] = [str(block.id), str(block.name)];
          if (block.type !== "toolCall" || !id || !name) return;
          const args = argsOf(obj(block.arguments) ?? {});
          if (BROWSER_OPENERS.has(name) && !browsers.has(conv)) {
            browsers.add(conv);
            add(make("phase", conv, `${base}:${index}:session`, { summary: "A live browser session started" }));
          }
          const use = useRow(conv, `${base}:${index}`, id, name, args, { round });
          const before = early.get(`${conv}:${id}`);
          const opened: OpenCall = { conv, name, args, round, use, done: before !== undefined };
          calls.set(`${conv}:${id}`, opened);
          if (BROWSER_STEPS.has(name)) browserCalls.set(conv, opened);
          add(use);
          // Its result came first: it is this call's, so it reads with the call's label and sits right after it.
          if (before) {
            early.delete(`${conv}:${id}`);
            const named = label(name, args, before.shown);
            use.summary = clean(named, caps.summary);
            const fresh = resultRow(conv, before.row.id, { name, callId: id, round }, named, before.view, before.shown);
            Object.assign(before.row, { summary: fresh.summary, tool_name: fresh.tool_name, tool_status: fresh.tool_status, seq: (use.seq ?? 0) + 0.5, ...(round === undefined ? {} : { round }) });
            rows.splice(rows.indexOf(before.row), 1);
            rows.splice(rows.indexOf(use) + 1, 0, before.row);
            touch(before.row);
          }
        });
      }
    } else if (entry.kind === "pi.tool-result" && message) {
      const id = str(message.toolCallId) ?? "";
      const call = calls.get(`${conv}:${id}`);
      const name = call?.name ?? str(message.toolName) ?? "tool";
      const view = viewOf(message);
      const shown = shownOf(view);
      // A call that failed ended nothing: the agent goes on after it, so a message then is still a steer.
      ended.set(conv, (previous.get(conv) !== "pi.tool-result" || ended.get(conv) === true) && endsTurn(name) && !view.isError);
      // One an abort cut did end the turn. A round's results come in as its calls end, so one that ended before the abort
      // comes first and never clears it.
      if (abortedCall(entry)) cutTurns.add(conv);
      else cutTurns.delete(conv);
      const args = call?.args ?? {};
      const named = label(name, args, shown);
      if (call) {
        call.done = true;
        call.use.summary = clean(named, caps.summary);
        touch(call.use);
      }
      const row = resultRow(conv, base, { name, callId: id || null, round: call?.round }, named, view, shown);
      if (!call && id) early.set(`${conv}:${id}`, { row, view, shown });
      add(row);
      if (!view.isError) {
        const answer = str(args.answer);
        if (name === "submit" && answer !== undefined) add(make("final_answer", conv, `${base}:answer`, { summary: firstLine(answer), text: answer }));
        if (name === "request_sign_in") {
          const reason = str(args.reason);
          add(make("waiting", conv, `${base}:waiting`, { summary: `Waiting for you: ${reason ? firstLine(reason) : "sign in on the live browser"}` }));
        }
        if (name === "browser_release") {
          browsers.delete(conv);
          add(make("phase", conv, `${base}:phase`, { summary: "Released the browser session" }));
        }
        savedPaths(name, args, view).map((file) => (options.path ? options.path(file) : file)).forEach((file, index) => add(make("phase", conv, `${base}:saved:${index}`, { summary: `Saved ${file}`, path: file })));
        const child = obj(message.details)?.conversationId;
        if (typeof child === "number") {
          for (const row of adopt(conv, child, id, args, named)) touch(row);
          add(make("subagent_completed", conv, `${conv}:done:${id}`, { summary: `Subagent done: ${scrubUrls(firstLine(shown.text))}`, tool_use_id: id }));
        }
      }
    } else if (entry.kind === "pi.system") {
      if (systems.has(conv)) add(make("phase", conv, base, { summary: "Tools changed" }));
      systems.add(conv);
    } else if (entry.kind === "pi.reset") {
      add(make("phase", conv, base, { summary: "Context reset", text: textOf(message) || null }));
    } else if (entry.kind === "pi.compaction") {
      add(make("phase", conv, base, { summary: "Summarized older context", text: textOf(message) || null }));
    } else if (entry.kind === HOST_PHASE) {
      const summary = str(obj(entry.data)?.summary);
      if (summary) add(make("phase", conv, base, { summary: firstLine(summary) }));
    } else if (entry.kind === RUN_RESUMED) {
      const data = obj(entry.data);
      if (typeof data?.at === "number" && Math.abs(data.at) <= 8.64e15) stamp = data.at;
      add(make("phase", conv, base, { summary: data?.after === "crash" ? "Resumed after a crash" : "Resumed after the server stopped" }));
    } else if (entry.kind === "agent.handover") {
      const data = obj(entry.data);
      const [state, reason, tag] = [str(data?.state), str(data?.reason), str(data?.session)];
      const session = tag && TAG.test(tag) ? tag : undefined;
      if (state === "waiting") add(make("waiting", conv, base, { summary: `Waiting for you: ${reason ? firstLine(reason) : "sign in on the live browser"}`, session }));
      else if (state === "done") add(make("user_message", conv, base, { summary: "You signed in", session }));
      else if (state === "declined") add(make("user_message", conv, base, { summary: "You declined to sign in", session }));
    } else if (origin) {
      // A message the server wrote (a raised cap's follow-up, an approval's resume): the model reads it as it reads any,
      // and the row says it is the server's. Its whole text is redacted as a person's is (a resume's later lines hold the
      // call's result, where a held key can be), then its first line is taken, scrubbed and cut as a phase's. No `path`:
      // a phase row with one folds into the tool row before it.
      const text = redactText(textOf(message));
      // A person's message that declined the call: their words are the message the turn took, a row of theirs under a
      // person's rules, with the entry's own id; the server's resume beside it is the server's (`origin: "server"`) but
      // not a message (an id of its own, BESIDE_SUFFIX, which isMessageRow passes over). Any other: the server's row is
      // that message, with the entry's id and `origin: "server"`. A trigger's message: "Trigger <its id>: …", `origin:
      // "trigger"`, never the person's.
      if (origin.kind === "trigger") add(make("phase", conv, base, { summary: `Trigger ${origin.trigger_id}: ${firstLine(text)}`, text, origin: "trigger", trigger: { id: origin.trigger_id, source: origin.source, owner: origin.owner } }));
      else if (origin.reason === "approval_declined") {
        const said = redactText(origin.said.trim());
        add(make("phase", conv, `${base}${BESIDE_SUFFIX}`, { summary: `AgentRun: ${firstLine(text)}`, text, origin: "server" }));
        add(make("user_message", conv, base, { summary: `You: ${firstLine(said)}`, text: said }));
      } else add(make("phase", conv, base, { summary: `AgentRun: ${firstLine(text)}`, text, origin: "server" }));
      provisional.delete(conv);
    } else if (message?.role === "user" && (entry.kind === "pi.user" || !entry.kind.startsWith("pi."))) {
      const author = str(obj(entry.data)?.author);
      const steer = previous.get(conv) === "pi.tool-result" && !ended.get(conv) && !cutTurns.has(conv);
      // A person can paste a held key: their row shows it redacted, as the host's `redact` makes it. The entry, which the
      // model reads, keeps what they typed.
      const text = redactText(textOf(message));
      add(make("user_message", conv, base, { summary: `${author ?? "You"}${steer ? " (steer)" : ""}: ${firstLine(text)}`, text }));
      provisional.delete(conv);
    }
    if (["pi.user", "pi.assistant", "pi.tool-result"].includes(entry.kind)) previous.set(conv, entry.kind);
    // A model request an abort cut after the round: its end mark is written only for an aborted request (not a withdrawn
    // one, nor a compaction's). The turn it would have gone on with is over.
    else if (entry.kind === REQUEST_ENDED && !unsent(entry) && !isCompaction(entry)) cutTurns.add(conv);
    else if (entry.kind === TURN_END) ended.set(conv, true);
    return out;
  }

  /** A nested call: seen live only, since pi drops its result when the caller settles. */
  function nested(conv: number, id: string, parent: string, name: string, raw: Obj): TimelineEvent {
    const args = argsOf(raw);
    const round = calls.get(`${conv}:${parent}`)?.round;
    const use = useRow(conv, `${conv}:n:${id}`, id, name, args, { round, parent_tool_use_id: parent });
    calls.set(`${conv}:${id}`, { conv, name, args, round, use, done: false });
    rows.push(use);
    return use;
  }

  function nestedEnd(conv: number, id: string, parent: string | undefined, result: Obj): TimelineEvent[] {
    const call = calls.get(`${conv}:${id}`);
    if (!call) return [];
    const output = result.structuredOutput;
    const diagnostic = Array.isArray(result.diagnostics) ? str(obj(result.diagnostics[0])?.message) : undefined;
    const text = typeof output === "string" ? output : output !== undefined ? JSON.stringify(output) : (diagnostic ?? "");
    const failed = result.isError === true;
    const view: ToolResultView = { text, details: result.details, isError: failed };
    const shown = shownOf(view);
    const named = label(call.name, call.args, shown);
    call.done = true;
    call.use.summary = clean(named, caps.summary);
    const row = resultRow(conv, `${conv}:n:${id}:result`, { name: call.name, callId: id, round: call.round }, named, view, shown, parent);
    rows.push(row);
    return [call.use, row];
  }

  /** A call with no result that will never get one. Its row takes the call's place, right after it, whenever the
   *  interruption is found: at this turn's end, or at a later process's (a call a stop or a crash cut off, which the next
   *  process resumes past) or a settled read. What came after the call, such as that process's answer, stays after it. */
  function interrupt(call: OpenCall, id: string): TimelineEvent {
    call.done = true;
    const row = make("tool_result", call.conv, `${call.conv}:interrupted:${id}`, {
      summary: `${label(call.name, call.args)} interrupted`, tool_name: call.name, tool_use_id: id, tool_status: "failed", round: call.round,
      parent_tool_use_id: call.use.parent_tool_use_id, seq: call.use.seq,
    });
    const at = rows.indexOf(call.use);
    rows.splice(at < 0 ? rows.length : at + 1, 0, row);
    return row;
  }

  function open(conv?: number): Array<[string, OpenCall]> {
    return [...calls].filter(([, call]) => (conv === undefined || call.conv === conv) && !call.done).map(([key, call]) => [key.slice(key.indexOf(":") + 1), call]);
  }

  /** The usage row. `nothingInFlight`: read as a settled run is, a request marked with no answer being cut, for a host that
   *  knows its turn is over while its process lives on (a stopped turn). */
  function usage(nothingInFlight = false): TimelineEvent | undefined {
    const counted = meter.usage(options.settled === true || nothingInFlight);
    if (!counted || root === undefined) return undefined;
    const { usd, requests, charges, so_far_usd, unpriced, not_metered } = counted;
    const paid = `${charges ? ` and ${charges} paid tool call${charges === 1 ? "" : "s"}` : ""}${not_metered ? `; ${not_metered} tool call${not_metered === 1 ? "" : "s"} not metered` : ""}`;
    const spent = usd !== null ? dollars(usd) : so_far_usd !== undefined && unpriced !== undefined ? `${dollars(so_far_usd)} known, ${unpriced} not priced,` : "unknown";
    return make("usage", root, `${root}:usage`, {
      // A run whose only request its cap refused sent none, and says so; otherwise what is known so far (costsofar/1).
      summary: requests === 0 && !charges ? "no model request sent" : `Cost so far: ${spent} over ${requests} model request${requests === 1 ? "" : "s"}${paid}`,
      // The contract's TimelineUsage and its costsofar/1 fields, while the cost is unknown: no other of the meter's reaches it.
      usage: { usd, requests, ...(so_far_usd !== undefined && unpriced !== undefined ? { so_far_usd, unpriced } : {}), ...(not_metered ? { not_metered } : {}) },
    });
  }

  return {
    push, nested, nestedEnd, interrupt, open, usage,
    call: (conv: number, id: string) => calls.get(`${conv}:${id}`),
    adoptLive: (conv: number, id: string, child: number) => {
      const call = calls.get(`${conv}:${id}`);
      return call ? adopt(conv, child, id, call.args, call.use.summary ?? "") : [];
    },
    live: (kind: TimelineKind, id: string, fields: Partial<TimelineEvent>) => make(kind, current, id, fields),
    rows: () => rows,
    conv: () => current,
  };
}

/** Rows of a stored conversation, in log order. Pure: the same entries give the same rows. */
export function timelineOf(entries: readonly EntryLike[], options: TimelineOptions = {}): TimelineEvent[] {
  const projector = createProjector(options);
  for (const entry of entries) projector.push(entry);
  if (options.settled) for (const [id, call] of projector.open()) projector.interrupt(call, id);
  const usage = projector.usage();
  return usage ? [...projector.rows(), usage] : [...projector.rows()];
}

/** A workflow's decision receipt as its run's store keeps it (`@parcha/agentrun-pi/durable`'s DecisionRow): the fields
 *  runMetricsOf reads. */
export type DecisionLike = { usage?: unknown; model?: unknown; provider?: unknown; status?: unknown; driver_spend?: unknown };

/** What a run that ended used, from the entries of every conversation of its store, in log order (`SELECT record FROM
 *  entries ORDER BY id`): its model requests and their tokens, counted as its usage row counts them (a cut request's
 *  tokens are unknown), and its tool calls. One parameter, so `.map(runMetricsOf)` is safe. Pure, like timelineOf. */
export function runMetricsOf(records: readonly EntryLike[]): RunMetrics {
  return runMetricsWithDecisions(records, []);
}

/** runMetricsOf, with a workflow run's decision receipts beside its entries: each a request, its `usage`
 *  (`input_tokens`, `output_tokens`) in the token sums, and one with none, or cancelled, unmetered. */
export function runMetricsWithDecisions(records: readonly EntryLike[], decisions: readonly DecisionLike[]): RunMetrics {
  const meter = createMeter();
  const seen = new Set<string>();
  // Each call by `conversation:id`, its tool's name as kept and as called, and whether a result closed it, as the timeline
  // pairs them.
  const calls = new Map<string, { name: string; called: string; done: boolean }>();
  // Results stored before their call, by `conversation:id`: each counts once its call comes, under its name and rule.
  const early = new Map<string, { named: string | undefined; result: { text: string; isError: boolean }; place: number }>();
  const tools = new Map<string, ToolMetrics>();
  // Each tool's place by its first call, or its first result with no call: a tie for the last kept place goes by it.
  const order = new Map<string, [number, number]>();
  // Each record's place: a tool's place is the record that first named it, though it counts later.
  let at = 0;
  const see = (name: string, place = at) => void (order.has(name) || order.set(name, [place, order.size]));
  const tally = (name: string, failed: boolean) => {
    see(name);
    const tool = tools.get(name) ?? { calls: 0, errors: 0 };
    tool.calls += 1;
    if (failed) tool.errors += 1;
    tools.set(name, tool);
  };
  for (const entry of records) {
    at += 1;
    const conv = entry.conversationId ?? 0;
    if (entry.id !== undefined) {
      if (seen.has(`${conv}:${entry.id}`)) continue;
      seen.add(`${conv}:${entry.id}`);
    }
    const message = entry.model?.[0];
    const metered = meter.push(entry);
    if ((metered === "answer" || metered === "continued") && message && message.stopReason !== "error" && message.stopReason !== "aborted") {
      for (const block of blocksOf(message)) {
        const [id, name] = [str(block.id), str(block.name)];
        if (block.type !== "toolCall" || !id || !name) continue;
        const key = metricName(name);
        // Its result came first: it counts now, once, under this call's name and by this call's tool's rule.
        const before = early.get(`${conv}:${id}`);
        early.delete(`${conv}:${id}`);
        calls.set(`${conv}:${id}`, { name: key, called: name, done: before !== undefined });
        see(key);
        if (before) tally(key, callFailed(name, before.result));
      }
    } else if (entry.kind === "pi.tool-result" && message) {
      const id = str(message.toolCallId);
      const call = calls.get(`${conv}:${id ?? ""}`);
      const named = str(message.toolName);
      // The text is read only by a tool that tells its outcome (most tell none; a fetch's is its whole page).
      const result = { get text() { return textOf(message); }, isError: message.isError === true };
      // A result before its call waits for it, to count under its name and by its rule.
      if (!call && id) {
        early.set(`${conv}:${id}`, { named, result, place: at });
        continue;
      }
      if (call) call.done = true;
      // Failed as the call's row reads it (callFailed): an error, or a result its tool reads as failed (a refused fetch).
      const called = call?.called ?? named ?? "";
      tally(call?.name ?? (named ? metricName(named) : METRIC_NAMES.unnamedTool), callFailed(called, result));
    }
  }
  for (const call of calls.values()) if (!call.done) tally(call.name, true);
  // A result whose call never came counts by its own name, as any result without a call does.
  for (const { named, result, place } of early.values()) {
    const name = named ? metricName(named) : METRIC_NAMES.unnamedTool;
    see(name, place);
    tally(name, callFailed(named ?? "", result));
  }
  for (const row of decisions) meter.decide(row);
  const ordered = new Map([...tools].sort(([a], [b]) => order.get(a)![0] - order.get(b)![0] || order.get(a)![1] - order.get(b)![1]));
  return { ...meter.settled(), tools: keepBusiest(ordered, (t) => t.calls, (a, b) => ({ calls: a.calls + b.calls, errors: a.errors + b.errors }), METRIC_NAMES.otherTools) };
}

const roleOf = (entry: unknown): unknown => {
  const model = obj(entry)?.model;
  return Array.isArray(model) ? obj(model[0])?.role : undefined;
};
const modelName = (agent: unknown): string | undefined => {
  const model = obj(obj(agent)?.model);
  return model && str(model.modelId) ? `${str(model.provider) ?? "model"}/${str(model.modelId)}` : undefined;
};

/** Live rows from `watchEvents` batches. Committed entries go through the same projector `timelineOf` uses. */
export function timelineReducer(options: TimelineOptions = {}) {
  const redactedWhy = redactOf(options);
  // Ids of live rows: events made them, and they go when they end (timelineReducer's isLive).
  const liveIds = new Set<string>();
  const now = options.now ?? Date.now;
  const thinkingCap = options.caps?.thinking ?? CAPS.thinking;
  let projector = createProjector(options);
  const store = new Map<string, TimelineEvent>();
  const streams = { thinking: new Map<number, string>(), text_block: new Map<number, string>() };
  let model: string | undefined;

  function apply(events: readonly AgentEventLike[]): { rows: TimelineEvent[]; drop: string[] } {
    const changed = new Map<string, TimelineEvent>();
    const dropped = new Set<string>();
    const put = (row: TimelineEvent) => { store.set(row.id, row); changed.set(row.id, row); dropped.delete(row.id); };
    const del = (id: string) => { if (store.delete(id)) { changed.delete(id); dropped.add(id); } };
    const live = (kind: TimelineKind, id: string, summary: string | undefined, fields: Partial<TimelineEvent> = {}) => {
      liveIds.add(id);
      const old = store.get(id);
      if (summary === undefined) return del(id);
      if (old && old.summary === summary && old.text === (fields.text ?? null)) return;
      put(projector.live(kind, id, { summary, ...fields, seq: old?.seq }));
    };
    let committed = false;
    const entry = (value: unknown) => {
      const e = obj(value);
      if (!e || typeof e.kind !== "string") return;
      for (const row of projector.push(e as EntryLike)) put(row);
      committed = true;
    };
    const conv = () => projector.conv();

    const showStreams = () => {
      for (const kind of ["thinking", "text_block"] as const) {
        // All that has streamed so far, as the host shows a streaming block (redactLive: redacted whole, a tail held back),
        // before a summary or a cut is taken. With only `redact`: redacted whole, then its trailing word held back until
        // whitespace follows it or the block ends, since it may be the head of a key whose tail has not streamed yet.
        const joined = [...streams[kind].values()].join("");
        const raw = joined.trim();
        const fallback = () => {
          const red = redactedWhy(raw);
          return options.redact && /\S$/.test(joined) ? red.replace(/\S+$/, "").trimEnd() : red;
        };
        const shown = options.redactLive ? options.redactLive(raw) : fallback();
        // The agent's text streams as it will settle, its URLs whole; its thinking is scrubbed, as when it settles.
        const text = kind === "thinking" ? scrubUrls(shown) : shown;
        const summary = kind === "thinking" ? `Thinking: ${cut(firstSentence(text), thinkingCap)}` : firstLine(text);
        live(kind, `${conv()}:live:${kind}`, text ? summary : undefined, { text });
      }
    };
    const endStreams = () => {
      streams.thinking.clear();
      streams.text_block.clear();
      showStreams();
      wait("poll", undefined);
    };
    const readMessage = (message: Obj | undefined) => {
      streams.thinking.clear();
      streams.text_block.clear();
      blocksOf(message).forEach((block, index) => {
        if (block.type === "thinking") streams.thinking.set(index, str(block.thinking) ?? "");
        else if (block.type === "text") streams.text_block.set(index, str(block.text) ?? "");
      });
    };
    const change = (c: Obj) => {
      const index = typeof c.contentIndex === "number" ? c.contentIndex : 0;
      const block = obj(c.block);
      const append = (map: Map<number, string>) => map.set(index, (map.get(index) ?? "") + (str(c.delta) ?? ""));
      if (c.type === "text_delta") append(streams.text_block);
      else if (c.type === "thinking_delta") append(streams.thinking);
      else if (c.type === "text_start" || (c.type === "block" && block?.type === "text")) streams.text_block.set(index, str(block?.text) ?? "");
      else if (c.type === "thinking_start" || (c.type === "block" && block?.type === "thinking")) streams.thinking.set(index, str(block?.thinking) ?? "");
      else if (c.type === "message") readMessage(obj(c.message));
    };
    const wait = (slot: string, summary: string | undefined) => live("waiting", `${conv()}:waiting:${slot}`, summary);
    const seconds = (at: unknown) => Math.max(0, Math.round(((typeof at === "number" ? at : now()) - now()) / 1000));
    const nestedStart = (id: string, parent: string, name: string, args: Obj) => {
      if (!projector.call(conv(), id)) put(projector.nested(conv(), id, parent, name, args));
    };
    for (const event of events) {
      switch (event.type) {
        case "snapshot": {
          for (const id of store.keys()) dropped.add(id);
          store.clear();
          changed.clear();
          projector = createProjector(options);
          streams.thinking.clear();
          streams.text_block.clear();
          model = modelName(event.agent);
          for (const value of Array.isArray(event.entries) ? event.entries : []) entry(value);
          const generation = obj(event.generation);
          const retry = obj(generation?.retry);
          if (generation?.message) { readMessage(obj(generation.message)); showStreams(); }
          if (retry) wait("retry", `Retrying in ${seconds(retry.at)} s: ${firstLine(str(retry.error) ?? "")}`);
          if (obj(generation?.deferred)) wait("poll", "Waiting for the model provider");
          if (Array.isArray(event.inbox) && event.inbox.length) wait("queue", `${event.inbox.length} message${event.inbox.length === 1 ? "" : "s"} queued`);
          for (const slot of Array.isArray(event.nestedTools) ? event.nestedTools : []) {
            const s = obj(slot);
            const [callId, parentCallId, name] = [str(s?.callId), str(s?.parentCallId), str(s?.name)];
            if (s && callId && parentCallId && name) nestedStart(callId, parentCallId, name, obj(s.arguments) ?? {});
          }
          break;
        }
        case "message_start":
          if (obj(event.message)?.role === "assistant") endStreams();
          break;
        case "message_update":
          for (const c of Array.isArray(event.changes) ? event.changes : []) change(obj(c) ?? {});
          showStreams();
          break;
        case "message_end": {
          entry(event.entry);
          if (roleOf(event.entry) === "assistant") endStreams();
          break;
        }
        case "entry_appended":
          entry(event.entry);
          break;
        case "tool_execution_start": {
          const [parent, callId] = [str(event.parentToolCallId), str(event.toolCallId)];
          if (parent && callId) nestedStart(callId, parent, str(event.toolName) ?? "tool", obj(event.args) ?? {});
          break;
        }
        case "tool_execution_end": {
          const id = str(event.toolCallId) ?? "";
          if (event.entry) entry(event.entry);
          else if (obj(event.result)) for (const row of projector.nestedEnd(conv(), id, str(event.parentToolCallId), obj(event.result)!)) put(row);
          else {
            const call = projector.call(conv(), id);
            if (call && !call.done) put(projector.interrupt(call, id));
          }
          break;
        }
        case "run_start":
          live("phase", `${conv()}:run:start`, "Run started");
          break;
        case "run_end":
          for (const [id, call] of projector.open(conv())) put(projector.interrupt(call, id));
          wait("poll", undefined);
          wait("retry", undefined);
          live("phase", `${conv()}:run:end`, "Run finished");
          break;
        case "inbox_update": {
          const n = Array.isArray(event.items) ? event.items.length : 0;
          wait("queue", n ? `${n} message${n === 1 ? "" : "s"} queued` : undefined);
          break;
        }
        case "auto_retry_start":
          wait("poll", undefined);
          wait("retry", `Retrying in ${seconds(event.at)} s (attempt ${String(event.attempt)}): ${firstLine(str(event.errorMessage) ?? "")}`);
          break;
        case "auto_retry_end":
          wait("retry", undefined);
          break;
        case "deferred_poll":
          wait("poll", `Waiting for the model provider (next check in ${seconds(event.pollAt)} s)`);
          break;
        case "agent_changed": {
          const next = modelName(event.agent);
          if (next && model && next !== model) live("phase", `${conv()}:model:${next}`, `Model changed to ${next}`);
          model = next ?? model;
          break;
        }
        case "task_failed":
          wait("poll", undefined);
          { const why = str(event.message) === undefined ? undefined : redactedWhy(str(event.message)!); live("error", `${conv()}:task:${String(event.taskId)}`, `Task failed: ${firstLine(why ?? "")}`, { text: why ?? null }); }
          break;
        case "compaction_start":
          live("phase", `${conv()}:compaction:${String(event.taskId)}`, "Summarizing older context");
          break;
        case "compaction_end": {
          del(`${conv()}:compaction:${String(event.taskId)}`);
          const failed = str(event.error);
          if (failed) { const why = redactedWhy(failed); live("error", `${conv()}:compaction:${String(event.taskId)}:error`, `Compaction failed: ${firstLine(why)}`, { text: why }); }
          break;
        }
        case "tool_execution_update": {
          const child = obj(event.details)?.conversationId;
          const id = str(event.toolCallId);
          if (typeof child === "number" && id) for (const row of projector.adoptLive(conv(), id, child)) put(row);
          break;
        }
        default:
          break;
      }
    }
    const usage = committed ? projector.usage() : undefined;
    if (usage) put(usage);
    return { rows: [...changed.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)), drop: [...dropped] };
  }

  return {
    apply,
    /** Every row now, in log order. */
    rows: () => [...store.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)),
    /** The usage row read with nothing in flight, put in place of the live one: for a host whose turn was stopped and is
     *  over, so a request it cut counts as a charge with no price, as a settled read counts it. Undefined with no row. */
    idle: () => {
      const usage = projector.usage(true);
      if (usage) store.set(usage.id, usage);
      return usage;
    },
    /** Whether `id` is a live row (one the events made: a stream, a wait, a phase), not one a committed entry made.
     *  A live row ends when it is gone; a committed one was shown and stays, though a snapshot of a compacted
     *  conversation no longer holds it. */
    isLive: (id: string) => liveIds.has(id),
  };
}
