import { BROWSER_OPENERS, callFailed, endsTurn, failedWith, inputPreview, labelOf, outcomeOf, savedPaths, type LabelFn, type ToolResultView } from "./labels.js";
import { cut, firstLine, firstSentence, json, obj, scrubUrls, str, utf8Bytes, type Obj } from "./util.js";

export type TimelineKind =
  | "thinking" | "text_block" | "tool_use" | "tool_result" | "phase"
  | "subagent_started" | "subagent_progress" | "subagent_completed" | "final_answer" | "error"
  | "user_message" | "waiting" | "usage"
  /** A workflow decision: a judge's answers or a route's branch (serve's decision rows). */
  | "decision";

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
  /** A tool_use row's state, one row per call: `running` until the call ends, then `success`, `failed`, `missing` (a
   *  read of a path the run never wrote found nothing: a probe) or `interrupted` (no result ever came). Null otherwise;
   *  an older timeline's tool_result rows say `success` or `failed`. */
  tool_status: "running" | "success" | "failed" | "missing" | "interrupted" | null;
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
  /** The file a write's row is about (or, in an older timeline, its "Saved" phase row). */
  path?: string;
  /** A tool_use row's end: when the call's outcome came (an interrupted call's, when its run ended), at or after its
   *  `timestamp`; null while it runs. Absent on other rows. */
  ended_at?: string | null;
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
 *  which is then unknown on a null, and shows on its call's own row (a row of its own when its call never shows); it is no
 *  model request. */
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

export type TimelineOptions = {
  /** For entries and events that carry no conversation id. */
  conversationId?: number;
  agentLabel?: (conversationId: number) => string | null | undefined;
  /** Labels for this call only; `registerLabel` adds them for every call. */
  labels?: Record<string, LabelFn>;
  caps?: Partial<typeof CAPS>;
  /** Nothing is running: a call with no result is interrupted. */
  settled?: boolean;
  /** The run's workspace: a path under it shows relative to it, in labels, previews and results. A list when the
   *  workspace goes by more than one path (a link and its target). */
  workDir?: string | readonly string[];
  /** When the run started and ended: a settled run's usage row says how long it took. */
  run?: { startedAt?: string; endedAt?: string };
  /** The clock for retry and poll waits; live only. */
  now?: () => number;
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

  function push(entry: EntryLike): "answer" | "continued" | "mark" | "charge" | undefined {
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
    } else if (entry.kind === REQUEST_STARTED) {
      marked += 1;
      inFlight = true;
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
    if (!requests && !compactions && !cut && !charges && !cutCalls) return undefined;
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

  return { push, decide, usage, settled };
}

/** `charge`: what a paid tool's call charged (TOOL_COST), shown on its row. */
type OpenCall = { conv: number; name: string; args: Obj; round?: number; use: TimelineEvent; done: boolean; charge?: Charge };
type Charge = { text: string; usd: number | null };

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
/** A host tool's wire name (`mcp__hands__write`, as Claude Code names the host's tools) is the tool's own name here. */
const WIRE = "mcp__hands__";
export const toolNameOf = (name: string): string => (name.startsWith(WIRE) ? name.slice(WIRE.length) : name);
/** A result's text, readable: a JSON object one field per line, its strings with their own line breaks, an array one item
 *  per line; anything else as it is. */
export function readable(text: string): string {
  const t = text.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return text;
  let value: unknown;
  try {
    value = JSON.parse(t);
  } catch {
    return text;
  }
  const line = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
  if (Array.isArray(value)) return value.map(line).join("\n");
  if (value && typeof value === "object") return Object.entries(value as Record<string, unknown>).map(([k, v]) => `${k}: ${line(v)}`).join("\n");
  return text;
}
const duration = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
};
/** A read that found nothing. One of a path the run never wrote is a probe (`missing`), not a failure. */
const NOT_FOUND = /ENOENT|no such file or directory/i;
const PROBES = new Set(["read", "ls"]);
/** Whether a finished call is a probe that found nothing: a read of a path nothing in this run wrote. */
export const missingOf = (tool: string, args: Obj, result: { text: string; isError: boolean }, written: ReadonlySet<string>): boolean => {
  const file = str(args.path) ?? str(args.file_path);
  return result.isError && PROBES.has(tool) && NOT_FOUND.test(result.text) && !(file !== undefined && written.has(file));
};

/** A run's workspace (one path, or the paths it goes by): `rel` drops it from a text's paths, and `relArgs` makes a call's
 *  path arguments relative to it, so a row, and a run's metrics, name each file one way. */
function workspace(workDir: string | readonly string[] | undefined) {
  const works = [workDir ?? []].flat().map((dir) => dir.replace(/\/+$/, "")).filter(Boolean).sort((a, b) => b.length - a.length);
  const rel = (text: string) => works.reduce((out, work) => out.split(`${work}/`).join(""), text);
  const relArgs = (args: Obj): Obj => {
    if (works.length === 0) return args;
    const out = { ...args };
    for (const key of ["path", "file_path", "filePath", "cwd"]) {
      const value = str(out[key]);
      const work = value === undefined ? undefined : works.find((dir) => value === dir || value.startsWith(`${dir}/`));
      if (value !== undefined && work !== undefined) out[key] = value === work ? "." : value.slice(work.length + 1);
    }
    return out;
  };
  return { rel, relArgs };
}

/** One place turns entries into rows, whether they come from a released store or from live events. */
function createProjector(options: TimelineOptions) {
  const caps = { ...CAPS, ...options.caps };
  const label = (tool: string, args: Obj, result?: ToolResultView) => labelOf(tool, args, result, options.labels);
  // The run's workspace: its paths show relative to it.
  const { rel, relArgs } = workspace(options.workDir);
  const seen = new Set<string>();
  const calls = new Map<string, OpenCall>();
  // Paid tools' charges written before their call (a harness bridge books a charge as the call runs), by
  // `conversation:id`: the call takes it when it comes; one whose call never comes keeps a line of its own.
  const charges = new Map<string, { charge: Charge; conv: number; base: string; tool: string; by: string; id: string }>();
  /** A charge on its call's row: said after its outcome, and its usage, the charge alone (no request), so a host sums a
   *  run's paid tools from the same rows as its cost. */
  const chargeOn = (call: OpenCall, charge: Charge) => {
    call.charge = charge;
    call.use.usage = { usd: charge.usd, requests: 0 };
    if (call.done) call.use.summary = clean(`${call.use.summary} · charged ${charge.text}`, caps.summary);
  };
  const chargeRow = (held: { charge: Charge; conv: number; base: string; tool: string; by: string; id: string }) =>
    make("phase", held.conv, held.base, { summary: `Tool cost: ${held.by} charged ${held.charge.text} for ${held.tool}`, tool_name: held.tool, tool_use_id: held.id || null, usage: { usd: held.charge.usd, requests: 0 } });
  // Results stored before their call (a harness bridge once wrote one before the answer that held its call), by
  // `conversation:id`: the call takes it when it comes; one whose call never comes is an action of its own.
  const early = new Map<string, { conv: number; id: string; name: string; view: ToolResultView; base: string; at: number }>();
  // Paths this run wrote: a later read that finds nothing there failed; one of any other path only probed.
  const written = new Set<string>();
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
  // A tool's error as words: its JSON's `message` or `error` (monid's), else its text.
  const failure = (text: string) => scrubUrls(firstLine(str(json(text)?.message) ?? str(json(text)?.error) ?? text)) || "no detail";
  /** The `tool_use` row of a call; `fields` is what differs between a stored call and a nested one. */
  const useRow = (conv: number, rowId: string, callId: string, name: string, args: Obj, fields: Partial<TimelineEvent>) =>
    make("tool_use", conv, rowId, { summary: label(name, args), tool_name: name, tool_use_id: callId, tool_status: "running", tool_input_preview: inputPreview(args, caps.preview), ended_at: null, ...fields });
  /** When a call ended: `at` (the entry being read, else its own time), never before the call's row. */
  const endOf = (call: OpenCall, at = stamp) => new Date(Math.max(at, Date.parse(call.use.timestamp))).toISOString();
  /** A call's outcome, on its own row: its status, the action and a one-line result as its summary, the result readable
   *  as its preview, and a write's path. A call that returned but whose result says it did not do its work (a refused
   *  fetch) reads as that, failed; a read that found nothing of a path the run never wrote is a quiet "not found". */
  /** `at`: when the result came (its entry's time), else the entry being read. */
  function finish(call: OpenCall, view: ToolResultView, at = stamp): void {
    call.done = true;
    const named = label(call.name, call.args, view);
    const outcome = outcomeOf(call.name, view);
    // A probe that found nothing (a read of a path the run never wrote, a search with no results) is quiet: missing.
    const probed = missingOf(call.name, call.args, view, written);
    const status = probed || (outcome?.missing === true && !view.isError) ? "missing" : failedWith(view, outcome) ? "failed" : "success";
    const said = outcome?.text === undefined ? undefined : `${named}${outcome.sep ?? ": "}${scrubUrls(firstLine(rel(outcome.text)))}`;
    const ended = probed ? `${named}: not found` : (outcome?.line ?? said ?? (view.isError ? `${named} failed: ${failure(rel(view.text))}` : `${named}: ok`));
    const line = call.charge ? `${ended} · charged ${call.charge.text}` : ended;
    const preview = outcome?.preview ?? (view.text ? readable(view.text) : undefined);
    Object.assign(call.use, {
      summary: clean(line, caps.summary), tool_status: status, ended_at: endOf(call, at),
      tool_result_preview: preview ? clean(rel(preview), caps.preview) : null, tool_result_size_bytes: utf8Bytes(view.text),
    });
    if (status !== "success") return;
    for (const file of savedPaths(call.name, call.args, view)) {
      written.add(file);
      call.use.path ??= rel(file);
    }
  }
  /** A result whose call never came: an action of its own, at its place; with no call id, its `tool_use_id` is null. */
  function callless(conv: number, base: string, id: string, name: string, view: ToolResultView): TimelineEvent {
    const call: OpenCall = { conv, name, args: {}, use: useRow(conv, base, id, name, {}, { tool_use_id: id || null }), done: false };
    finish(call, view);
    return call.use;
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
    const at = message?.timestamp;
    if (typeof at === "number" && Math.abs(at) <= 8.64e15) stamp = at;
    const base = `${conv}:${entry.id ?? seq}`;
    const out: TimelineEvent[] = [];
    const add = (row: TimelineEvent) => { rows.push(row); out.push(row); };
    const touch = (row: TimelineEvent) => { if (!out.includes(row)) out.push(row); };

    const metered = meter.push(entry);
    if (metered === "mark") {
      // A request's mark or cost, or pi's answer to a request that never left: counted, nothing to show.
    } else if (metered === "charge") {
      // A paid tool's charge: counted in the cost, and shown on its call's own row, whenever the call shows.
      const data = obj(entry.data);
      const [tool, by, usd, id] = [str(data?.tool) ?? "a tool", str(data?.charged_by) ?? "its provider", data?.usd, str(data?.call) ?? ""];
      const known = typeof usd === "number" && Number.isFinite(usd) ? usd : null;
      const charge = { text: known === null ? "an unknown amount" : dollars(known), usd: known };
      const call = id ? calls.get(`${conv}:${id}`) : undefined;
      if (call) {
        chargeOn(call, charge);
        touch(call.use);
      } else if (id) charges.set(`${conv}:${id}`, { charge, conv, base, tool, by, id });
      else add(chargeRow({ charge, conv, base, tool, by, id }));
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
        // A result held for a call this answer does not hold never gets one: it is an action of its own, before this answer.
        const asked = new Set(blocks.flatMap((block) => (block.type === "toolCall" && str(block.id) ? [str(block.id)!] : [])));
        for (const held of [...early.values()]) if (held.conv === conv && !asked.has(held.id)) add(release(held));
        if (text || (final && first("text") >= 0)) add(make(final ? "final_answer" : "text_block", conv, `${base}:${first("text")}`, { summary: firstLine(text), text }));
        blocks.forEach((block, index) => {
          const [id, wire] = [str(block.id), str(block.name)];
          if (block.type !== "toolCall" || !id || !wire) return;
          const name = toolNameOf(wire);
          const args = relArgs(obj(block.arguments) ?? {});
          if (BROWSER_OPENERS.has(name) && !browsers.has(conv)) {
            browsers.add(conv);
            add(make("phase", conv, `${base}:${index}:session`, { summary: "Opened a live browser session" }));
          }
          const use = useRow(conv, `${base}:${index}`, id, name, args, { round });
          const call: OpenCall = { conv, name, args, round, use, done: false };
          calls.set(`${conv}:${id}`, call);
          add(use);
          // Its charge came first: it is this call's.
          const paid = charges.get(`${conv}:${id}`);
          if (paid) {
            charges.delete(`${conv}:${id}`);
            chargeOn(call, paid.charge);
          }
          // Its result came first: it is this call's.
          const before = early.get(`${conv}:${id}`);
          if (before) {
            early.delete(`${conv}:${id}`);
            finish(call, before.view, before.at);
          }
        });
      }
    } else if (entry.kind === "pi.tool-result" && message) {
      const id = str(message.toolCallId) ?? "";
      const call = calls.get(`${conv}:${id}`);
      const name = call?.name ?? toolNameOf(str(message.toolName) ?? "tool");
      const view = viewOf(message);
      // A call that failed ended nothing: the agent goes on after it, so a message then is still a steer.
      ended.set(conv, (previous.get(conv) !== "pi.tool-result" || ended.get(conv) === true) && endsTurn(name) && !view.isError);
      // One an abort cut did end the turn. A round's results come in as its calls end, so one that ended before the abort
      // comes first and never clears it.
      if (abortedCall(entry)) cutTurns.add(conv);
      else cutTurns.delete(conv);
      const args = call?.args ?? {};
      const named = label(name, args, view);
      // The call's own row takes the outcome; a result with no call yet waits for it, and one with no id is an action.
      if (call) {
        finish(call, view);
        touch(call.use);
      } else if (id) early.set(`${conv}:${id}`, { conv, id, name, view, base, at: stamp });
      else add(callless(conv, base, "", name, view));
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
    const tool = toolNameOf(name);
    const given = relArgs(args);
    const use = useRow(conv, `${conv}:n:${id}`, id, tool, given, { round, parent_tool_use_id: parent });
    calls.set(`${conv}:${id}`, { conv, name: tool, args: given, round, use, done: false });
    rows.push(use);
    return use;
  }

  function nestedEnd(conv: number, id: string, parent: string | undefined, result: Obj): TimelineEvent[] {
    const call = calls.get(`${conv}:${id}`);
    if (!call) return [];
    const output = result.structuredOutput;
    const diagnostic = Array.isArray(result.diagnostics) ? str(obj(result.diagnostics[0])?.message) : undefined;
    const text = typeof output === "string" ? output : output !== undefined ? JSON.stringify(output) : (diagnostic ?? "");
    finish(call, { text, details: result.details, isError: result.isError === true });
    return [call.use];
  }

  /** A call with no result that will never get one: its own row says so, at the call; no row is added. */
  function interrupt(call: OpenCall, _id: string): TimelineEvent {
    call.done = true;
    // Labelled as a call that ended (it did, with nothing): "Searched the web for …: interrupted", not "Searching".
    // It ended when the run did, when a settled read is told; else at the latest entry read.
    const runEnd = options.settled && options.run?.endedAt ? Date.parse(options.run.endedAt) : Number.NaN;
    const charged = call.charge ? ` · charged ${call.charge.text}` : "";
    Object.assign(call.use, {
      summary: clean(`${label(call.name, call.args, { text: "", details: undefined, isError: true })}: interrupted${charged}`, caps.summary), tool_status: "interrupted",
      ended_at: endOf(call, Number.isFinite(runEnd) ? Math.max(runEnd, stamp) : stamp),
    });
    return call.use;
  }

  /** Each result still waiting for a call that never came, as the action of its own it is (at the end of a read, or of a
   *  turn). */
  function release(held: { conv: number; id: string; name: string; view: ToolResultView; base: string }): TimelineEvent {
    early.delete(`${held.conv}:${held.id}`);
    return callless(held.conv, held.base, held.id, held.name, held.view);
  }
  /** Each result and each charge still waiting for a call that never came, as the row of its own it is. */
  const releaseAll = () => [
    ...[...early.values()].map(release),
    ...[...charges.values()].map((held) => (charges.delete(`${held.conv}:${held.id}`), chargeRow(held))),
  ].map((row) => {
    rows.push(row);
    return row;
  });

  function open(conv?: number): Array<[string, OpenCall]> {
    return [...calls].filter(([, call]) => (conv === undefined || call.conv === conv) && !call.done).map(([key, call]) => [key.slice(key.indexOf(":") + 1), call]);
  }

  function usage(): TimelineEvent | undefined {
    const counted = meter.usage(options.settled === true);
    if (!counted || root === undefined) return undefined;
    const { usd, requests, charges } = counted;
    const cost = usd === null ? "unknown" : dollars(usd);
    const count = `${requests} model request${requests === 1 ? "" : "s"}`;
    const paid = charges ? `${charges} paid tool call${charges === 1 ? "" : "s"}` : "";
    // A settled run's total: its cost, its requests and paid tool calls, and the time from its start to its end, when the
    // host gives them.
    const span = options.run?.startedAt && options.run?.endedAt ? Date.parse(options.run.endedAt) - Date.parse(options.run.startedAt) : Number.NaN;
    const summary = options.settled
      ? `Total: ${cost} · ${count}${paid ? ` · ${paid}` : ""}${Number.isFinite(span) ? ` · ${duration(span)}` : ""}`
      : `Cost so far: ${cost} over ${count}${paid ? ` and ${paid}` : ""}`;
    return make("usage", root, `${root}:usage`, { summary, usage: { usd, requests } });
  }

  return {
    push, nested, nestedEnd, interrupt, open, usage, releaseAll,
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
  projector.releaseAll();
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
 *  (`input_tokens`, `output_tokens`) in the token sums, and one with none, or cancelled, unmetered. `workDir`: the run's
 *  workspace, as timelineOf takes it, so a file is the same file whether a call named it absolute or relative. */
export function runMetricsWithDecisions(records: readonly EntryLike[], decisions: readonly DecisionLike[], options: { workDir?: string | readonly string[] } = {}): RunMetrics {
  const { relArgs } = workspace(options.workDir);
  const meter = createMeter();
  const seen = new Set<string>();
  // Each call by `conversation:id`, its tool's name as kept and as called, and whether a result closed it, as the timeline
  // pairs them.
  const calls = new Map<string, { name: string; called: string; args: Obj; done: boolean }>();
  // Results counted before their call came (stored first): that call is done, and counts once.
  const early = new Set<string>();
  // Paths the run wrote: a read that finds nothing at one of them failed; at any other it only probed.
  const written = new Set<string>();
  const tools = new Map<string, ToolMetrics>();
  // Each tool's place by its first call, or its first result with no call: a tie for the last kept place goes by it.
  const order = new Map<string, number>();
  const see = (name: string) => void (order.has(name) || order.set(name, order.size));
  const tally = (name: string, failed: boolean) => {
    see(name);
    const tool = tools.get(name) ?? { calls: 0, errors: 0 };
    tool.calls += 1;
    if (failed) tool.errors += 1;
    tools.set(name, tool);
  };
  for (const entry of records) {
    const conv = entry.conversationId ?? 0;
    if (entry.id !== undefined) {
      if (seen.has(`${conv}:${entry.id}`)) continue;
      seen.add(`${conv}:${entry.id}`);
    }
    const message = entry.model?.[0];
    const metered = meter.push(entry);
    if ((metered === "answer" || metered === "continued") && message && message.stopReason !== "error" && message.stopReason !== "aborted") {
      for (const block of blocksOf(message)) {
        const [id, wire] = [str(block.id), str(block.name)];
        if (block.type !== "toolCall" || !id || !wire) continue;
        const name = toolNameOf(wire);
        const key = metricName(name);
        calls.set(`${conv}:${id}`, { name: key, called: name, args: relArgs(obj(block.arguments) ?? {}), done: early.delete(`${conv}:${id}`) });
        see(key);
      }
    } else if (entry.kind === "pi.tool-result" && message) {
      const id = str(message.toolCallId);
      const call = calls.get(`${conv}:${id ?? ""}`);
      if (call) call.done = true;
      else if (id) early.add(`${conv}:${id}`);
      const named = str(message.toolName) === undefined ? undefined : toolNameOf(str(message.toolName)!);
      // Failed as the call's row reads it (callFailed): an error, or a result its tool reads as failed (a refused fetch);
      // a read that found nothing of a path the run never wrote only probed.
      const called = call?.called ?? named ?? "";
      const result = { text: textOf(message), details: message.details, isError: message.isError === true };
      const args = call?.args ?? {};
      tally(call?.name ?? (named ? metricName(named) : METRIC_NAMES.unnamedTool), !missingOf(called, args, result, written) && callFailed(called, result));
      if (!result.isError) for (const file of savedPaths(called, args, result)) written.add(file);
    }
  }
  for (const call of calls.values()) if (!call.done) tally(call.name, true);
  for (const row of decisions) meter.decide(row);
  const ordered = new Map([...tools].sort(([a], [b]) => order.get(a)! - order.get(b)!));
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
          for (const row of projector.releaseAll()) put(row);
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
