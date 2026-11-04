import { BROWSER_OPENERS, callFailed, endsTurn, failedWith, inputPreview, labelOf, outcomeOf, savedPaths, type LabelFn, type ToolResultView } from "./labels.js";
import { cut, firstLine, firstSentence, json, obj, scrubUrls, str, utf8Bytes, type Obj } from "./util.js";

export type TimelineKind =
  | "thinking" | "text_block" | "tool_use" | "tool_result" | "phase"
  | "subagent_started" | "subagent_progress" | "subagent_completed" | "final_answer" | "error"
  | "user_message" | "waiting" | "usage"
  /** A workflow decision: a judge's answers or a route's branch (serve's decision rows). */
  | "decision"
  /** Where a run's learning ended: proposed, merged or dropped (serve's learning row). */
  | "learning";

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
  usage?: { usd: number | null; requests: number };
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
 *  which is then unknown on a null, and shows as a row of its own; it is no model request. */
export const TOOL_COST = "agentrun.tool_cost";
/** A paid tool's call marked before it is sent (`call`, and `heldUsd`, the most it is held to charge): the TOOL_COST of
 *  the same `call` settles it. Unsettled, it is in flight while the run is; once the run is settled it was cut (a crash),
 *  and the cost is unknown, as for a cut model request: what it charged no one knows, and its held figure is the cap's
 *  bound (serve's cap.ts), never a charge. */
export const TOOL_STARTED = "agentrun.tool_started";
/** Written right before a `pi.assistant` that continues the answer before it: a call that answer asked for, written once
 *  the answer's own entry was already in (a harness reports each call as it runs it, and its host writes an answer at its
 *  first call's end). It shows as that answer's, and is no request: no count, no cost, no tokens. */
export const REQUEST_CONTINUED = "agentrun.request_continued";
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
  // Paid tool calls whose charge is in the cost (TOOL_COST).
  let charges = 0;
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

  function push(entry: EntryLike): "answer" | "continued" | "refusal" | "mark" | "charge" | undefined {
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
      charges += 1;
      addCost(data?.usd);
      return "charge";
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

  /** The usage row's count and cost; undefined while there is nothing to count. `settled`: nothing is running. */
  function usage(settled: boolean): { usd: number | null; requests: number; charges: number } | undefined {
    // A request marked as it left with no entry for it, other than one still in flight: counted, at a cost no one knows.
    // One in flight alone makes no row yet, so the row appears where it did before requests were marked.
    // A settled run has nothing in flight: its last request with no entry, or its open compaction, was cut by the
    // process that ended.
    const open = (flying: boolean) => (flying && !settled ? 1 : 0);
    const cut = marked - open(inFlight) > answered || compacting - (settled ? 0 : sidesOpen) > compactions;
    // A paid tool call cut by a crash: its charge is unknown, so the cost is.
    const cutCalls = settled ? held.size : 0;
    if (!requests && !compactions && !cut && !charges && !cutCalls) return refusedAny ? { usd: 0, requests: 0, charges: 0 } : undefined;
    const count = requests + Math.max(0, marked - answered) + Math.max(compactions, compacting);
    return { usd: unknown > 0 || pending.length > 0 || cut || cutCalls > 0 ? null : Math.round(known * 1e6) / 1e6, requests: count, charges: charges + cutCalls };
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
  const early = new Map<string, { row: TimelineEvent; view: ToolResultView }>();
  const previous = new Map<number, string>();
  // Whether every tool of the conversation's latest round ends the turn: then the turn is over, and what comes next is
  // the person's next message, not a steer.
  const ended = new Map<number, boolean>();
  // Conversations whose turn an abort cut since their latest tool round (a stop, a cancel): an aborted tool, or a model
  // request that had left and was aborted. That turn is over too, so the next message comes in a new turn, never a steer.
  const cutTurns = new Set<number>();
  const systems = new Set<number>();
  const browsers = new Set<number>();
  const children = new Map<number, string>();
  const rows: TimelineEvent[] = [];
  let seq = 0;
  let stamp = 0;
  let root: number | undefined;
  let current = options.conversationId ?? 0;
  const meter = createMeter();
  // Each conversation's latest answer, by entry id: a continuation's calls show under it.
  const answers = new Map<number, number | undefined>();

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
    if (row.summary !== null) row.summary = clean(row.summary, caps.summary);
    if (row.tool_input_preview !== null) row.tool_input_preview = clean(row.tool_input_preview, caps.preview);
    if (row.tool_result_preview !== null) row.tool_result_preview = clean(row.tool_result_preview, caps.preview);
    if (row.text !== null) row.text = kind === "user_message" ? cut(row.text, caps.text) : clean(row.text, caps.text);
    for (const key of ["round", "parent_tool_use_id", "session", "path", "usage"] as const) if (row[key] === undefined) delete row[key];
    return row;
  }

  const viewOf = (message: Obj): ToolResultView => ({ text: textOf(message), details: message.details, isError: message.isError === true });
  const failure = (text: string) => scrubUrls(firstLine(str(json(text)?.message) ?? diagnosticOf(text) ?? text)) || "no detail";
  /** The `tool_use` row of a call; `fields` is what differs between a stored call and a nested one. */
  const useRow = (conv: number, rowId: string, callId: string, name: string, args: Obj, fields: Partial<TimelineEvent>) =>
    make("tool_use", conv, rowId, { summary: label(name, args), tool_name: name, tool_use_id: callId, tool_input_preview: inputPreview(args, caps.preview), ...fields });
  /** The `tool_result` row of a finished call, named `named`; `parent` is a nested call's caller. */
  /** A call that returned but whose result says it did not do its work (a refused fetch) reads as that, failed. Its
   *  outcome is read once, for the summary and the status both. */
  const resultRow = (conv: number, rowId: string, tool: { name: string; callId: string | null; round?: number }, named: string, view: { text: string; isError: boolean }, parent?: string) => {
    const outcome = outcomeOf(tool.name, view);
    return make("tool_result", conv, rowId, {
      summary: view.isError ? `${named} failed: ${failure(view.text)}` : outcome ? `${named}: ${scrubUrls(firstLine(outcome.text))}` : `${named}: ok`, tool_name: tool.name, tool_use_id: tool.callId,
      tool_status: failedWith(view, outcome) ? "failed" : "success", tool_result_preview: view.text ? cut(scrubUrls(view.text), caps.preview) : null,
      tool_result_size_bytes: utf8Bytes(view.text), round: tool.round, parent_tool_use_id: parent,
    });
  };

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
    const at = message?.timestamp;
    if (typeof at === "number" && Math.abs(at) <= 8.64e15) stamp = at;
    const base = `${conv}:${entry.id ?? seq}`;
    const out: TimelineEvent[] = [];
    const add = (row: TimelineEvent) => { rows.push(row); out.push(row); };
    const touch = (row: TimelineEvent) => { if (!out.includes(row)) out.push(row); };

    const metered = meter.push(entry);
    if (metered === "mark") {
      // A request's mark or cost, or pi's answer to a request that never left: counted, nothing to show.
    } else if (metered === "refusal" && message) {
      // A request the run's cap refused, never sent: no request. Its text is the error as written (a host reads its code
      // from it), its summary the cap's own words, after the code ("Not sent: ...").
      const why = str(message.errorMessage) ?? "spend_cap_reached: Not sent: the run's spend cap refused the request.";
      const words = why.replace(/^spend_cap_reached(?: \([^)]*\))?: /, "");
      add(make("error", conv, base, { summary: firstLine(words.startsWith("Not sent:") ? words : `Not sent: ${words}`), text: why }));
    } else if (metered === "charge") {
      // A paid tool's charge: counted in the cost, and shown on a line of its own.
      const data = obj(entry.data);
      const [tool, by, usd] = [str(data?.tool) ?? "a tool", str(data?.charged_by) ?? "its provider", data?.usd];
      const amount = typeof usd === "number" && Number.isFinite(usd) ? dollars(usd) : "an unknown amount";
      // Its `usage` is the charge alone (no request): a host sums a run's paid tools from the same rows as its cost.
      const charge = typeof usd === "number" && Number.isFinite(usd) ? usd : null;
      add(make("phase", conv, base, { summary: `Tool cost: ${by} charged ${amount} for ${tool}`, tool_name: tool, tool_use_id: str(data?.call) ?? null, usage: { usd: charge, requests: 0 } }));
    } else if ((metered === "answer" || metered === "continued") && message) {
      const round = metered === "continued" && answers.has(conv) ? answers.get(conv) : entry.id;
      if (metered === "answer") answers.set(conv, entry.id);
      if (message.stopReason === "error") {
        const why = str(message.errorMessage) ?? "unknown error";
        add(make("error", conv, base, { summary: `Model request failed: ${firstLine(why)}`, text: why }));
      } else if (message.stopReason !== "aborted") {
        const blocks = blocksOf(message);
        const first = (type: string) => blocks.findIndex((block) => block.type === type);
        const thinking = scrubUrls(textOf(message, "thinking", "thinking"));
        if (thinking) add(make("thinking", conv, `${base}:${first("thinking")}`, { summary: `Thinking: ${cut(firstSentence(thinking), caps.thinking)}`, text: thinking }));
        const text = textOf(message);
        const final = message.stopReason === "stop" && !blocks.some((block) => block.type === "toolCall");
        // A final stop's text block is its answer even when empty: the model ended its turn on purpose, with nothing to
        // say. A message with no text block (a request the adapter bridge writes without content) shows none.
        if (text || (final && first("text") >= 0)) add(make(final ? "final_answer" : "text_block", conv, `${base}:${first("text")}`, { summary: firstLine(text), text }));
        // A reply that stopped at the output its request's cap limited it to says so, with the numbers.
        const clamp = metered === "answer" && message.stopReason === "length" ? meter.clamp() : undefined;
        if (clamp) add(make("phase", conv, `${base}:clamp`, { summary: clampSaid(clamp) }));
        blocks.forEach((block, index) => {
          const [id, name] = [str(block.id), str(block.name)];
          if (block.type !== "toolCall" || !id || !name) return;
          const args = obj(block.arguments) ?? {};
          if (BROWSER_OPENERS.has(name) && !browsers.has(conv)) {
            browsers.add(conv);
            add(make("phase", conv, `${base}:${index}:session`, { summary: "Opened a live browser session" }));
          }
          const use = useRow(conv, `${base}:${index}`, id, name, args, { round });
          const before = early.get(`${conv}:${id}`);
          calls.set(`${conv}:${id}`, { conv, name, args, round, use, done: before !== undefined });
          add(use);
          // Its result came first: it is this call's, so it reads with the call's label and sits right after it.
          if (before) {
            early.delete(`${conv}:${id}`);
            const named = label(name, args, before.view);
            use.summary = clean(named, caps.summary);
            const fresh = resultRow(conv, before.row.id, { name, callId: id, round }, named, before.view);
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
      // A call that failed ended nothing: the agent goes on after it, so a message then is still a steer.
      ended.set(conv, (previous.get(conv) !== "pi.tool-result" || ended.get(conv) === true) && endsTurn(name) && !view.isError);
      // One an abort cut did end the turn. A round's results come in as its calls end, so one that ended before the abort
      // comes first and never clears it.
      if (abortedCall(entry)) cutTurns.add(conv);
      else cutTurns.delete(conv);
      const args = call?.args ?? {};
      const named = label(name, args, view);
      if (call) {
        call.done = true;
        call.use.summary = clean(named, caps.summary);
        touch(call.use);
      }
      const row = resultRow(conv, base, { name, callId: id || null, round: call?.round }, named, view);
      if (!call && id) early.set(`${conv}:${id}`, { row, view });
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
          add(make("subagent_completed", conv, `${conv}:done:${id}`, { summary: `Subagent done: ${scrubUrls(firstLine(view.text))}`, tool_use_id: id }));
        }
      }
    } else if (entry.kind === "pi.system") {
      if (systems.has(conv)) add(make("phase", conv, base, { summary: "Tools changed" }));
      systems.add(conv);
    } else if (entry.kind === "pi.reset") {
      add(make("phase", conv, base, { summary: "Context reset", text: textOf(message) || null }));
    } else if (entry.kind === "pi.compaction") {
      add(make("phase", conv, base, { summary: "Summarized older context", text: textOf(message) || null }));
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
    } else if (message?.role === "user" && (entry.kind === "pi.user" || !entry.kind.startsWith("pi."))) {
      const author = str(obj(entry.data)?.author);
      const steer = previous.get(conv) === "pi.tool-result" && !ended.get(conv) && !cutTurns.has(conv);
      const text = textOf(message);
      add(make("user_message", conv, base, { summary: `${author ?? "You"}${steer ? " (steer)" : ""}: ${firstLine(text)}`, text }));
    }
    if (["pi.user", "pi.assistant", "pi.tool-result"].includes(entry.kind)) previous.set(conv, entry.kind);
    // A model request an abort cut after the round: its end mark is written only for an aborted request (not a withdrawn
    // one, nor a compaction's). The turn it would have gone on with is over.
    else if (entry.kind === REQUEST_ENDED && !unsent(entry) && !isCompaction(entry)) cutTurns.add(conv);
    return out;
  }

  /** A nested call: seen live only, since pi drops its result when the caller settles. */
  function nested(conv: number, id: string, parent: string, name: string, args: Obj): TimelineEvent {
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
    const named = label(call.name, call.args, { text, details: result.details, isError: failed });
    call.done = true;
    call.use.summary = clean(named, caps.summary);
    const row = resultRow(conv, `${conv}:n:${id}:result`, { name: call.name, callId: id, round: call.round }, named, { text, isError: failed }, parent);
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

  function usage(): TimelineEvent | undefined {
    const counted = meter.usage(options.settled === true);
    if (!counted || root === undefined) return undefined;
    const { usd, requests, charges } = counted;
    const paid = charges ? ` and ${charges} paid tool call${charges === 1 ? "" : "s"}` : "";
    return make("usage", root, `${root}:usage`, {
      // A run whose only request its cap refused sent none, and says so.
      summary: requests === 0 && !charges ? "no model request sent" : `Cost so far: ${usd === null ? "unknown" : dollars(usd)} over ${requests} model request${requests === 1 ? "" : "s"}${paid}`,
      usage: { usd, requests },
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
      const result = { text: textOf(message), isError: message.isError === true };
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
        const text = scrubUrls([...streams[kind].values()].join("").trim());
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
          live("error", `${conv()}:task:${String(event.taskId)}`, `Task failed: ${firstLine(str(event.message) ?? "")}`, { text: str(event.message) ?? null });
          break;
        case "compaction_start":
          live("phase", `${conv()}:compaction:${String(event.taskId)}`, "Summarizing older context");
          break;
        case "compaction_end": {
          del(`${conv()}:compaction:${String(event.taskId)}`);
          const failed = str(event.error);
          if (failed) live("error", `${conv()}:compaction:${String(event.taskId)}:error`, `Compaction failed: ${firstLine(failed)}`, { text: failed });
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
    /** Whether `id` is a live row (one the events made: a stream, a wait, a phase), not one a committed entry made.
     *  A live row ends when it is gone; a committed one was shown and stays, though a snapshot of a compacted
     *  conversation no longer holds it. */
    isLive: (id: string) => liveIds.has(id),
  };
}
