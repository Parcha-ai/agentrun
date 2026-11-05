// A run's spend cap (`max_cost_usd`), held in the run's own process, where its model requests are sent. Before each
// request, what the run has spent plus the request's worst case must stay within the cap. The worst case is the request's
// input bound (inputBound: one token per UTF-8 byte of what is sent, plus what the provider adds server-side) at the
// higher of the model's input and cache-write prices, plus the output it is sent with at the output price, plus any fee
// its tokens do not show (pi's own search request's). Each request is limited to the output what is left of the cap can
// buy (thinking included, never more than it asks for), and held at that: the limit is the wire's (pi's options, the
// model proxy's body for claude-agent and codex), so the cap stays exact. Only when what is left cannot buy its least (1,024
// tokens for the answer, and its thinking's least, leastOutput) is it not sent, and the run's turn ends on a model error
// the server reads as `spend_cap_reached`, saying in plain words what was spent and what the request needs. A model serve has
// no price for cannot be kept within a cap, so under one its requests are refused; a model listed at $0 is a known $0. What the run has
// spent is read back from its store when the process starts, so it survives a restart, plus each response since; a
// request in flight holds its worst case until it answers. A request the person stopped before its end counts at its input,
// what it streamed (one token a byte) and STOP_ALLOWANCE_TOKENS of output the provider may have produced after the last
// word read, never more than its worst case: a cut stream's own usage is not what it charged, and its worst case, once
// the request is limited to what is left, is the rest of the cap. One that ended on an error after its response began
// counts at its worst case. The figure is written on the request's end mark (request-start.ts), so a later process
// counts it the same. Nor can a spend no one
// knows (a request a crash cut, a cost that is not a number) or a model whose output is priced and that has no output
// ceiling be kept within a cap: under one, each refuses the request, never passes as $0.
// A request carrying a native web search tool reads pages into its input that its body does not hold: on claude-agent
// its bound is its body's plus a stated allowance (NATIVE_SEARCH_ALLOWANCE_TOKENS, which its adapter adds, adapters.ts),
// and pi's own search request is held at its context plus HOSTED_SEARCH_ALLOWANCE_TOKENS and its most fee; what it
// cost, booked once it answers, stops the next request. A run whose booked spend passes its cap shows by how much on its
// timeline (runs.ts withOverCap).
//
// A paid tool's charge (monid.run's, monid.ts) is the run's spend too: booked in the run's store as a TOOL_COST, which
// the run's cost and spentIn both count, and added to what the run's process counts as spent (useSpend), so the next
// request's check sees it. A charge the call does not say (null: stopped, timed out, failed with no cost) leaves the
// run's cost unknown, and the cap counts the call at what it was held at, the bound it let the call go at, as it counts
// one a crash cut: in the run's process and from its mark in the store. Before each paid call, paidCall holds it as a
// request is held: refused unless what the run has spent plus what the call is held at (its quote, else an allowance)
// fits the cap, and whenever the spend is unknown; paid calls go one at a time, so each check sees the charge before
// it. A call sent holds its figure until its charge joins the spend (paidHolds), so a model request judged meanwhile, on
// pi or on another harness, counts it beside the spend, as a paid call's check counts the model requests in flight.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { providerInputOverhead } from "@parcha/agentrun-kernel/host";
import { bookRequest, type Ended, isConnectCode, isGatewayTimeout, rejectionCode } from "@parcha/agentrun-kernel";
import { type EntryLike, REQUEST_CONTINUED, REQUEST_COST, REQUEST_COST_LATE, REQUEST_ENDED, REQUEST_REFUSED, REQUEST_STARTED, timelineOf, TOOL_COST, TOOL_STARTED } from "@parcha/pi-durable-agent/timeline";
import type { Api, AssistantMessage, AssistantMessageEventStream, Context, Model, Models, Usage } from "@earendil-works/pi-ai";

/** A run's cap in USD, passed to its process. */
export const CAP_ENV = "AGENTRUN_SERVE_MAX_COST_USD";
/** How a request the cap refused begins its error, which the server ends the run with. */
export const SPEND_CAP_REACHED = "spend_cap_reached";
/** How near two dollar figures are the same figure: a sum a float puts a hair past the cap (0.0028 + 0.3072 is
 *  0.31000000000000005) is the cap, and fits it. A raise must be above a run's cap by more (runs.ts). */
export const CAP_TOLERANCE = 1e-9;
/** How far past what is left a sum may read and still fit it: a float's own tail (0.0028 + 0.3072 is 0.31000000000000005
 *  against a 0.31 cap), never a spend that is past the cap, by however little (a 1e-11 hair is past it). CAP_TOLERANCE
 *  is the other question: how near two caps are the same cap. */
export const FIT_TOLERANCE = 1e-12;
/** The option a request's worst case rides on from the cap to its marks (request-start.ts): what the cap held for it. A
 *  symbol, so no provider ever sends it. */
export const HELD_USD = Symbol.for("agentrun.serve.held_usd");
/** pi's messages for requests that ended on an error after their response had begun (an event came in first), as the
 *  marks (request-start.ts) saw them: each left and the provider may have billed what it generated, so it counts at its
 *  hold, as one stopped does. An error before any event (refused at the HTTP level: a 429, a 5xx) counts at its own
 *  usage. Kept by identity, never on the message: pi writes the message to the store as strict JSON, which fails on a
 *  symbol key. */
const responseBegan = new WeakSet<AssistantMessage>();
/** Records that `message` ended on an error after its response began. */
export const markResponseBegan = (message: AssistantMessage): void => void responseBegan.add(message);
/** The field of a request's end mark (REQUEST_ENDED) that says what the cap held for it, when its stream ended aborted
 *  or its summary failed: the request counts at that figure. Optional: an end with none (an older store, a run with no
 *  cap) leaves the request cut, at an unknown cost. */
export const HELD_FIELD = "heldUsd";
/** The field of the start mark (REQUEST_STARTED) written for a request this cap refused: it never left, and pi's error
 *  entry for it answers this mark, never an earlier request's. */
export const CAP_REFUSED_FIELD = "capRefused";
/** The option a request the cap limited rides on to its start mark (request-start.ts, as `clamp`): the output tokens it was
 *  limited to, what was left of the cap for it, and the cap, so a reply cut short there says so. */
export const CLAMP = Symbol.for("agentrun.serve.clamp");
/** The tokens a limited request keeps for its answer (pi-ai's MIN_ANSWER_TOKENS): a request is refused, never sent, when
 *  what is left of its cap cannot buy them (or what it asked for, when it asked for fewer). */
export const ANSWER_TOKENS_LEAST = 1024;
/** The least thinking budget Anthropic takes: a request that thinks on an API whose thinking takes a budget keeps it
 *  beside its answer, the budget squeezed to it at the least. */
export const THINKING_BUDGET_LEAST = 1024;
/** The APIs whose thinking takes a token budget added to the request's own output limit (pi-ai's
 *  adjustMaxTokensForThinking). Elsewhere a model's reasoning shares the output limit and takes no budget, so it is
 *  allowed its thinking level's budget beside the answer, else it comes back incomplete with no answer. */
const BUDGET_APIS: ReadonlySet<string> = new Set(["anthropic-messages", "bedrock-converse-stream"]);
/** The output tokens a request the person stopped counts beyond what it streamed: what the provider may have produced after
 *  the last word read, before it saw the stop. A stopped request counts its input, each byte it streamed as a token, and
 *  these, never more than it was held at (stoppedFigure). A stated bound, as NATIVE_SEARCH_ALLOWANCE_TOKENS is. */
export const STOP_ALLOWANCE_TOKENS = 1024;
/** The option a request's stopped figure rides on to its end mark (request-start.ts): what it counts at, given the answer
 *  it streamed, when it is stopped before its end. A symbol, so no provider ever sends it. */
export const STOPPED_USD = Symbol.for("agentrun.serve.stopped_usd");
/** What a model answer streamed, in bytes: its text, its thinking, and each tool call's name and arguments as JSON. Each
 *  byte counts as a token (a byte-level tokenizer never makes a token of less than one byte), as inputBound counts input. */
export function streamedBytes(message: { content?: unknown } | undefined): number {
  const blocks = Array.isArray(message?.content) ? (message.content as Array<Record<string, unknown> | null>) : [];
  let bytes = 0;
  for (const block of blocks) {
    if (typeof block?.text === "string") bytes += Buffer.byteLength(block.text, "utf8");
    if (typeof block?.thinking === "string") bytes += Buffer.byteLength(block.thinking, "utf8");
    if (block?.type === "toolCall") bytes += Buffer.byteLength(`${typeof block.name === "string" ? block.name : ""}${JSON.stringify(block.arguments ?? {})}`, "utf8");
  }
  return bytes;
}
/** What of a model answer's reasoning streamed, in bytes (streamedBytes' unit): its thinking blocks. */
export function reasoningBytes(message: { content?: unknown } | undefined): number {
  const blocks = Array.isArray(message?.content) ? (message.content as Array<Record<string, unknown> | null>) : [];
  let bytes = 0;
  for (const block of blocks) if (typeof block?.thinking === "string") bytes += Buffer.byteLength(block.thinking, "utf8");
  return bytes;
}
/** A request's figure if it is stopped before its end, given the answer it had streamed. */
export type Stopped = (message: { content?: unknown }) => number;
/** What a request stopped before its end counts at: its input and `streamed` tokens plus STOP_ALLOWANCE_TOKENS of output,
 *  at most the output it was sent with (`limit`), at `cost`'s price; never more than `worst`, what it was held at. */
export const stoppedFigure = (cost: (output: number) => number, limit: number, worst: number, streamed: number): number =>
  bookRequest({ end: "stopped", streamedTokens: streamed }, { hold: worst, stoppedPrice: stoppedPriceOf(cost, limit) }).usd!;
/** What a stopped request counts at, having streamed `streamed` tokens: those and STOP_ALLOWANCE_TOKENS of output, at
 *  most the output it was sent with (`limit`), at `cost`'s price; bookRequest keeps it within the hold. */
export const stoppedPriceOf = (cost: (output: number) => number, limit: number) => (streamed: number): number => cost(Math.min(limit, streamed + STOP_ALLOWANCE_TOKENS));

/** The option a request's attempts ride on to its marks (request-start.ts): each HTTP attempt pi-ai made for it, as the
 *  fetch the cap gave it saw them. A symbol, so no provider ever sends it. */
export const ATTEMPTS = Symbol.for("agentrun.serve.attempts");
/** One attempt of a request: the status it was answered with, or the code its fetch was refused with, `aborted` when the
 *  request's own signal had fired by then (the run stopped it: no attempt lost to the provider). */
export type Attempt = { status: number } | { code: string | undefined; aborted?: true };
/** The APIs whose requests the cap cannot watch through a fetch, each with why: it gives them no recording fetch, and
 *  a request on one that fails before any event books its hold (piEnded). The one table both read. */
export const UNWATCHED_APIS: Readonly<Record<string, string>> = {
  "openai-codex-responses": "tries a WebSocket first, which a fetch never sees",
  "bedrock-converse-stream": "sends through its own AWS client, never options.fetch",
  "cloudflare-ai-binding": "calls a Workers binding, never options.fetch",
  "cloudflare-workers-ai-system-one": "never reads options.fetch",
  "google-generative-ai": "throws on a custom fetch",
  "google-vertex": "throws on a custom fetch",
  "openai-decisions": "never reads options.fetch",
  "typesafe-system-one": "never reads options.fetch",
};
const unwatched = (api: string): boolean => Object.hasOwn(UNWATCHED_APIS, api);
/** A fetch that does what `inner` does (globalThis.fetch by default) and records each attempt in `attempts`. An attempt
 *  is `aborted` only when the request's own signal (`stop`, the run's) had fired: the SDKs hand fetch a signal of their
 *  own, which they also abort on their own timeout, and an attempt that timed out left, so it is lost, never a stop. */
export function recordingFetch(attempts: Attempt[], inner?: typeof fetch, stop?: AbortSignal): typeof fetch {
  return (async (input, init) => {
    try {
      const response = await (inner ?? globalThis.fetch)(input, init);
      attempts.push({ status: response.status });
      return response;
    } catch (error) {
      attempts.push({ code: rejectionCode(error), ...(stop?.aborted ? { aborted: true as const } : {}) });
      throw error;
    }
  }) as typeof fetch;
}
/** How a pi request ended (booking.ts), from pi's message, whether its response began (an event came in), and its
 *  attempts (undefined on an API the cap cannot watch). The worst over its attempts, in the order lost > answered >
 *  nothing: an attempt is lost when its fetch was refused after it could have left (any code but a connect one), when a
 *  gateway gave up on it (504, 524), or when it was answered 2xx and its request then ended on an error, or was tried
 *  again. An answer after a lost attempt can have been billed twice: lost. No attempt seen on a watched API: it never
 *  left. */
const answeredOk = (a: Attempt) => "status" in a && a.status >= 200 && a.status < 300;
/** Whether one attempt was lost: refused after it could have left (any code but a connect one), a gateway's timeout, or
 *  an answer that was not the request's last attempt (pi-ai tried again after it). That last reading assumes every fetch
 *  through the recorder is a model attempt. pi-ai's Anthropic workload identity federation (anthropic-messages.js,
 *  getAnthropicFederation) exchanges its token through the same fetch, so under it "a 2xx that was not the last" would
 *  read every answer as lost. It arms only when no API key or auth header resolves, and serve always gives pi-ai an API
 *  key, so it never arms here. */
export const attemptLost = (a: Attempt, last: boolean): boolean => ("code" in a ? !isConnectCode(a.code) : isGatewayTimeout(a.status) || (answeredOk(a) && !last));
/** Whether any attempt of a request was lost (attemptLost), its last counted as the last; one the run's own stop cut is
 *  none. A request lost so counts at its hold however it then ended: answered, failed or stopped. */
export const anyAttemptLost = (attempts: readonly Attempt[] | undefined): boolean =>
  attempts?.some((a, at) => !("aborted" in a && a.aborted) && attemptLost(a, at === attempts.length - 1)) ?? false;
export function piEnded(message: Pick<AssistantMessage, "stopReason" | "usage" | "api">, began: boolean, attempts: readonly Attempt[] | undefined): Ended {
  const ok = answeredOk;
  const anyLost = anyAttemptLost(attempts);
  if (message.stopReason !== "error") return anyLost ? { end: "lost", label: "retried" } : { end: "answered", usd: typeof message.usage?.cost?.total === "number" ? message.usage.cost.total : null };
  if (began) return { end: "lost", label: "error_after", began: true };
  // On an API the cap cannot watch (UNWATCHED_APIS), or with no record of its attempts, nothing says it never left.
  if (attempts === undefined || unwatched(message.api)) return { end: "lost", label: "error_before" };
  const last = attempts.at(-1);
  if (last && "status" in last && isGatewayTimeout(last.status)) return { end: "lost", label: "gateway_timeout" };
  if (anyLost || (last !== undefined && ok(last))) return { end: "lost", label: "error_before" };
  return { end: "nothing", label: last === undefined || "code" in last ? "never_left" : "status" };
}
/** How pi's error for a request whose start mark could not be written begins (request-start.ts builds it from this): the
 *  request never left, so the entry answers none, and spentIn leaves it out by this. */
export const MARK_NOT_WRITTEN = "the model request was not sent: its mark could not be written";
/** pi's error for a request that left and whose end mark the store refused (request-start.ts): its cost is not recorded
 *  as booked, so it stays open, read at its start mark's hold, never closed by this entry at its own usage. */
export const END_NOT_WRITTEN = "the model request's end could not be recorded";
const endUnrecorded = (entry: EntryLike): boolean => {
  const message = entry.kind === "pi.assistant" ? (entry.model?.[0] as { stopReason?: unknown; errorMessage?: unknown } | undefined) : undefined;
  return message?.stopReason === "error" && typeof message.errorMessage === "string" && message.errorMessage.startsWith(END_NOT_WRITTEN);
};

/** The input a request carrying claude-agent's native web search may read in beyond its body, added to its input bound
 *  by its adapter (adapters.ts hands it over): Claude's CLI asks for at most 8 searches a request (max_uses 8), and each
 *  search's results are billed as input, about 25,000 tokens a search as a working estimate. */
export const NATIVE_SEARCH_ALLOWANCE_TOKENS = 8 * 25_000;

/** A tool's own request through the run's models (`completeSimple`), by its context: the label its marks carry, the
 *  input its hosted tool may add beyond its context (results billed as input) and the most fee it can run up, which the
 *  cap holds (cap.ts), and the fee its tokens do not show (its searches), read once it ended. */
export type SideRequest = { label: string; extraInputTokens: number; maxFeeUsd: number; feeUsd(): number };
export const sideRequests = new WeakMap<object, SideRequest>();

/** The run's cap from its process's environment; absent for a run without one. */
export function capOf(env: NodeJS.ProcessEnv): number | undefined {
  const text = env[CAP_ENV];
  if (text === undefined || text === "") return undefined;
  const cap = Number(text);
  if (!(Number.isFinite(cap) && cap > 0)) throw new Error(`${CAP_ENV} is ${text}, not a number above 0`);
  return cap;
}

/** The code a cap's refusal begins with: `spend_cap_reached: `, or with a note after it, as a request it limited refuses
 *  in (CAP_REFUSAL_CODE, "spend_cap_reached (out of budget): "). Every reader of a refusal's text (a run's end, its
 *  learning, the spend read back) reads the code through this, never a bare prefix. */
export const CAP_REFUSAL_PREFIX = /^spend_cap_reached(?: \([^)]*\))?: /;

/** Whether `entry` is pi's answer to a request this cap refused (capModels): an error that begins spend_cap_reached. */
const refusedHere = (entry: EntryLike): boolean => {
  const message = entry.kind === "pi.assistant" ? (entry.model?.[0] as { stopReason?: unknown; errorMessage?: unknown } | undefined) : undefined;
  return message?.stopReason === "error" && typeof message.errorMessage === "string" && CAP_REFUSAL_PREFIX.test(message.errorMessage);
};

/** Whether `entry` is pi's error for a request whose start mark could not be written (request-start.ts, MARK_NOT_WRITTEN):
 *  it never left and has no mark of its own, so it answers no request, and read as an answer it would close another's. */
const notSentHere = (entry: EntryLike): boolean => {
  const message = entry.kind === "pi.assistant" ? (entry.model?.[0] as { stopReason?: unknown; errorMessage?: unknown } | undefined) : undefined;
  return message?.stopReason === "error" && typeof message.errorMessage === "string" && message.errorMessage.startsWith(MARK_NOT_WRITTEN);
};

/** The cost an entry adds to what a run spent, as the timeline counts it: a pi answer's total (none for one stopped
 *  before its end), and the usd of a cost written apart from an answer, a paid tool's charge among them; 0 for anything
 *  else, or for a cost that is not a number (which makes the whole spend unknown, by the timeline's verdict). */
const costOf = (entry: EntryLike): number => {
  const message = entry.kind === "pi.assistant" ? (entry.model?.[0] as { stopReason?: unknown; usage?: { cost?: { total?: unknown } } } | undefined) : undefined;
  const cost = message ? (message.stopReason === "aborted" ? undefined : message.usage?.cost?.total)
    : entry.kind === REQUEST_COST || entry.kind === REQUEST_COST_LATE || entry.kind === TOOL_COST ? (entry.data as { usd?: unknown } | undefined)?.usd : undefined;
  return typeof cost === "number" && Number.isFinite(cost) ? cost : 0;
};

/** A held figure as a mark carries it: a finite number, else none. */
const figureOf = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** What the cap held for a request, as its start mark says; undefined when it says none (an older store). */
type Figure = number | undefined;

/** Takes one figure out of `open`: `figure` itself when it is there, else the smallest, a figure that is not there reading
 *  as the largest (a start with none stays while any other could go). */
const close = (open: Figure[], figure?: number) => {
  if (!open.length) return;
  let at = figure === undefined ? -1 : open.indexOf(figure);
  if (at < 0) at = open.reduce<number>((low, f, i) => (f !== undefined && (open[low] === undefined || f < open[low]!) ? i : low), 0);
  open.splice(at, 1);
};

/** The figures of the requests of each kind that `entries` leave open, marked as sent with no answer, cost or end, read in
 *  order, as the run's timeline counts them (pi-durable-agent's meter), so the two agree on how many were cut. A start adds
 *  its figure. An end mark closes its own start: a stopped request's at the figure it names, a withdrawn one's (`unsent`,
 *  which names none) the smallest. An end that names none for a request that left (an older store) closes nothing, so
 *  that request stays cut. An answer, or a summary's cost, closes the smallest figure still open, since when requests
 *  overlap the marks do not say which one it answered. What stays open is then never less than the requests truly open,
 *  figure for figure: taking the smallest, or the very figure an end names, never leaves a smaller figure open than any
 *  other way of reading the same marks. It is exactly them when requests do not overlap. pi's answer to a request that
 *  never left (REQUEST_REFUSED's error entry) and a harness answer's continuation close nothing. */
function openFigures(entries: readonly EntryLike[]): { generation: Figure[]; compaction: Figure[] } {
  const open = { generation: [] as Figure[], compaction: [] as Figure[] };
  let [refused, continued] = [0, 0];
  for (const entry of entries) {
    const message = entry.model?.[0] as { stopReason?: unknown } | undefined;
    const data = (entry.data ?? {}) as Record<string, unknown>;
    // A side request (a compaction's summary, a tool's own request): marked with a label, as the timeline reads it.
    const kind = typeof data.request === "string" ? "compaction" : "generation";
    if (entry.kind === REQUEST_REFUSED) refused += 1;
    else if (entry.kind === "pi.assistant" && refused > 0 && message?.stopReason === "error") refused -= 1;
    else if (entry.kind === REQUEST_CONTINUED) continued += 1;
    else if (entry.kind === "pi.assistant" && continued > 0 && message) continued -= 1;
    else if (entry.kind === REQUEST_STARTED) open[kind].push(figureOf(data[HELD_FIELD]));
    else if (entry.kind === REQUEST_ENDED) {
      if (data.unsent === true) close(open[kind]);
      else if (figureOf(data[HELD_FIELD]) !== undefined) close(open[kind], figureOf(data[HELD_FIELD]));
    } else if (entry.kind === REQUEST_COST) close(open.compaction);
    else if (entry.kind === "pi.assistant" && message) close(open.generation);
  }
  return open;
}

/** What the run's store says its model requests cost, across every conversation in it: known or not as the run's own
 *  timeline says (pi-durable-agent's timelineOf), read as a settled run, since the process that wrote it is gone, and
 *  then the full amount, never the timeline's total rounded for display. Every response, and each cost written apart
 *  from one (a compaction summary's; a harness request's that came in after its answer). A cost that is not a number, or
 *  one still pending, leaves it unknown, as the timeline says. These readings are the cap's own, on its copy of the
 *  entries (the run's shown cost is the timeline's, unchanged): a request stopped before its end counts at the figure its
 *  end mark holds (HELD_FIELD), and one a crash cut (marked as sent, no answer, no end) at the figure its start mark
 *  holds (openFigures), each the worst case the cap held for it; without that figure either stays cut, at an unknown
 *  cost. A paid call settled at a charge it did not say, like one a crash cut, counts at the figure its mark holds. And
 *  this cap's refusals are left out, as none left. Unknown is null, which a cap never reads as $0. */
export function spentIn(storeFile: string): number | null {
  if (!existsSync(storeFile)) return 0;
  const db = new DatabaseSync(storeFile, { readOnly: true });
  const entries: EntryLike[] = [];
  // The store's own entries, as read (without the answers written below for a stopped request): openFigures reads them.
  const read: EntryLike[] = [];
  let marked = false;
  const rows: EntryLike[] = [];
  try {
    for (const row of db.prepare("SELECT record FROM entries ORDER BY rowid").iterate()) rows.push(JSON.parse(String((row as { record: string }).record)) as EntryLike);
  } finally {
    db.close();
  }
  // pi's error entry for a request that ended on an error after its response began is left out, as an aborted one is: its
  // end mark (`error`) counts it at its hold. pi writes the entry as the mark is written, before it or after, so each such
  // mark takes the nearest error entry not yet taken among those after the earliest start holding its figure (a request's
  // start and end marks hold the same, request-start.ts). Its own entry comes after its own start, so it is always among
  // them. An error before every such start answered an earlier request (a 429, before any event): taken when a crash came
  // between the mark and pi's entry, it would leave that request open at its hold. The marks with the fewest entries to
  // choose from take first, so as many are taken as the marks' own entries in the store and no more errors are read as
  // answers than are, one of which could close a start a crash cut; which one a mark takes, when errors overlap, moves no
  // figure below what can have been spent, as an answer's choice of start does not (openFigures). An earlier start holding
  // the very same figure (a 429's retry, with the same context) leaves its 429 takeable, so the spend then reads high,
  // never low: telling the two apart needs to know which request each entry answers, and the marks do not say. An error
  // with no such mark (before any event: a 429, a 5xx) is its request's answer.
  // A cancel's refusal (REQUEST_REFUSED) answers the next error entry, as openFigures and the timeline read them: those are
  // no request's, and no end mark takes one.
  const stopOf = (entry: EntryLike) => (entry.model?.[0] as { stopReason?: unknown } | undefined)?.stopReason;
  const errorsAt: number[] = [];
  // pi's answers: a `lost` end mark (written before a retry, request-start.ts) takes pi's entry for its own request, an
  // answer or an error, the first after the mark: it is counted at the mark's hold, never at its usage too.
  const answersAt: number[] = [];
  let refusals = 0;
  rows.forEach((entry, at) => {
    if (entry.kind === REQUEST_REFUSED) refusals += 1;
    else if (entry.kind === "pi.assistant" && stopOf(entry) === "error" && !refusedHere(entry) && !notSentHere(entry) && !endUnrecorded(entry)) {
      if (refusals > 0) refusals -= 1;
      else errorsAt.push(at);
    } else if (entry.kind === "pi.assistant" && stopOf(entry) !== "error" && stopOf(entry) !== "aborted") answersAt.push(at);
  });
  const taken = new Set<number>();
  const fieldsOf = (entry: EntryLike) => (entry.data ?? {}) as Record<string, unknown>;
  const generationStart = (entry: EntryLike) => entry.kind === REQUEST_STARTED && typeof fieldsOf(entry).request !== "string" && fieldsOf(entry)[CAP_REFUSED_FIELD] !== true;
  // Each such end mark, with the earliest start holding its figure (-1 for none: any error entry then).
  const endsOf = (field: "error" | "lost" | "unpriced") => rows.flatMap((entry, at) => entry.kind === REQUEST_ENDED && fieldsOf(entry)[field] === true
    ? [{ at, from: rows.findIndex((start, i) => i < at && generationStart(start) && figureOf(fieldsOf(start)[HELD_FIELD]) === figureOf(fieldsOf(entry)[HELD_FIELD])) }]
    : []);
  // A `lost` mark is written before its request's retry is sent (request-start.ts watchingLost) and is in the store before
  // pi has the request's result, so its request's entry is the first after it, before the next generation request's start
  // (one sent after it): never an earlier request's answer, however near. None there (its entry was the loud failure of a
  // mark the store took late, END_NOT_WRITTEN, or a crash came first) and it takes none. These go first, so an error mark
  // never takes a lost request's own entry.
  const afterMark = [...errorsAt, ...answersAt].sort((a, b) => a - b);
  // An `unpriced` mark (an answer whose cost cannot be read, at its hold) is written the same way, before pi has the answer.
  for (const { at } of [...endsOf("lost"), ...endsOf("unpriced")]) {
    const next = rows.findIndex((entry, i) => i > at && generationStart(entry));
    const own = afterMark.find((entry) => entry > at && (next < 0 || entry < next) && !taken.has(entry));
    if (own !== undefined) taken.add(own);
  }
  for (const { at, from } of endsOf("error").sort((a, b) => b.from - a.from)) {
    let nearest = -1;
    for (const entry of errorsAt) if (entry > from && !taken.has(entry) && (nearest < 0 || Math.abs(entry - at) < Math.abs(nearest - at))) nearest = entry;
    if (nearest >= 0) taken.add(nearest);
  }
  // Each paid tool call marked and not settled, by call: what it was held at.
  const calls = new Map<unknown, unknown>();
  for (const [at, entry] of rows.entries()) {
    const data = (entry.data ?? {}) as Record<string, unknown>;
    // A request this cap refused never left, and costs nothing: its mark and pi's error entry for it (an older store
    // has the entry alone, which the timeline would count as answering an earlier request a crash cut). Nor did one
    // whose start mark could not be written, whose error entry has no mark at all. A cancel's refusal is its mark
    // (REQUEST_REFUSED) and pi's error for it, which close nothing together (openFigures, and the timeline).
    if (refusedHere(entry) || notSentHere(entry) || (entry.kind === REQUEST_STARTED && data[CAP_REFUSED_FIELD] === true)) continue;
    // A paid call settled at a charge it did not say: at the figure its mark holds, the cap's bound for it.
    const bound = entry.kind === TOOL_COST && figureOf(data.usd) === undefined ? figureOf(calls.get(data.call)) : undefined;
    if (entry.kind === TOOL_STARTED) calls.set(data.call, data[HELD_FIELD]);
    if (entry.kind === TOOL_COST) calls.delete(data.call);
    if (entry.kind === REQUEST_STARTED) marked = true;
    // pi's entry for a marked request stopped before its end (what had streamed of it): the request is counted by its
    // marks instead, at the figure its end holds, or cut. Before the first mark (an older run) it stays unknown.
    if (marked && entry.kind === "pi.assistant" && (entry.model?.[0] as { stopReason?: unknown } | undefined)?.stopReason === "aborted") continue;
    // pi's entry for a request whose end mark the store refused: the request stays open, at its start's hold.
    if (marked && endUnrecorded(entry)) continue;
    if (taken.has(at)) continue;
    entries.push(bound === undefined ? entry : { ...entry, data: { ...data, usd: bound } });
    read.push(entry);
    const held = data[HELD_FIELD];
    // A summary that ended on an error after its response began (its cost mark says `failed`) counts at its hold.
    // So does one whose cost could not be read (`unpriced`): the booking rule's figure for an answer with no cost.
    if (entry.kind === REQUEST_COST && (data.failed === true || data.unpriced === true) && figureOf(held) !== undefined) entries[entries.length - 1] = { ...entry, data: { ...data, usd: held } };
    if (entry.kind !== REQUEST_ENDED || data.unsent === true || typeof held !== "number" || !Number.isFinite(held)) continue;
    // The stopped request closed at what the cap held for it: a summary by its cost, a generation by an answer.
    entries.push(typeof data.request === "string"
      ? { kind: REQUEST_COST, data: { request: data.request, usd: held } }
      : { kind: "pi.assistant", ...(entry.conversationId !== undefined ? { conversationId: entry.conversationId } : {}), model: [{ role: "assistant", content: [], stopReason: "stop", usage: { cost: { total: held } }, timestamp: 0 }] });
  }
  // A paid tool call a crash cut (marked, never settled) counts at its held figure, settled by it here, as a cut request.
  for (const [call, figure] of calls) entries.push({ kind: TOOL_COST, data: { call, usd: figureOf(figure) ?? null } });
  // A request still open is one a crash cut, with no answer and no end: it counts at what the cap held for it, as its start
  // mark says: its own figure when requests do not overlap, else one never less (openFigures). One still open with no
  // figure (an older store) leaves them all cut, unknown.
  const open = openFigures(read);
  for (const kind of ["generation", "compaction"] as const) {
    const figures = open[kind];
    if (figures.some((figure) => figure === undefined)) continue;
    for (const figure of figures as number[]) {
      entries.push(kind === "compaction"
        ? { kind: REQUEST_COST, data: { request: "compaction", usd: figure } }
        : { kind: "pi.assistant", model: [{ role: "assistant", content: [], stopReason: "stop", usage: { cost: { total: figure } }, timestamp: 0 }] });
    }
  }
  // The timeline says whether the spend is known; the amount is summed here, as it is, since the timeline rounds its total
  // for display (to the millionth of a dollar), and a cap must not lose what that drops.
  const usage = timelineOf(entries, { settled: true }).find((row) => row.kind === "usage")?.usage;
  if (usage === undefined) return 0;
  if (typeof usage.usd !== "number" || !Number.isFinite(usage.usd)) return null;
  return entries.reduce((sum, entry) => sum + costOf(entry), 0);
}

/** /usage's meters for a run that ended, from its store: `tools`, each TOOL_COST's `usd`, unknown (null) when one is,
 *  or when a call was cut (marked, never settled: what it charged no one knows); and `tokens`, the rest of its root
 *  conversation as its settled timeline prices it; `browser`, the part of `tools` that is browser session time
 *  (browser-cost.ts), with its seconds; and `others`, the rest of `tools`, each unknown (null) apart. A mark is never a charge here (the cap's alone). Never for a live run: its process
 *  holds the store exclusively. */
export function metersIn(storeFile: string): { tools: number | null; tokens: number | null; browser: { usd: number | null; seconds: number }; others: number | null } {
  if (!existsSync(storeFile)) return { tools: 0, tokens: null, browser: { usd: 0, seconds: 0 }, others: 0 };
  const db = new DatabaseSync(storeFile, { readOnly: true, timeout: 2_000 });
  try {
    const rows = db.prepare("SELECT conversation_id AS conversation, record FROM entries ORDER BY rowid").all().map((row) => ({ conversation: Number(row.conversation), entry: JSON.parse(String(row.record)) as EntryLike }));
    const root = rows.reduce((min, row) => Math.min(min, row.conversation), Infinity);
    const marks = new Set<unknown>();
    const charges: (number | undefined)[] = [];
    const browser = { usd: 0 as number | null, seconds: 0 };
    const others: (number | undefined)[] = [];
    for (const { entry } of rows) {
      const data = (entry.data ?? {}) as Record<string, unknown>;
      if (entry.kind === TOOL_STARTED) marks.add(data.call);
      else if (entry.kind === TOOL_COST) marks.delete(data.call), charges.push(figureOf(data.usd));
      if (entry.kind === TOOL_COST && data.tool !== "browser") others.push(figureOf(data.usd));
      if (entry.kind !== TOOL_COST || data.tool !== "browser") continue;
      const usd = figureOf(data.usd);
      browser.usd = browser.usd === null || usd === undefined ? null : browser.usd + usd;
      browser.seconds += figureOf(data.seconds) ?? 0;
    }
    const tools = marks.size || charges.some((usd) => usd === undefined) ? null : (charges as number[]).reduce((sum, usd) => sum + usd, 0);
    const rest = rows.filter(({ conversation, entry }) => conversation === root && entry.kind !== TOOL_STARTED && entry.kind !== TOOL_COST).map(({ entry }) => entry);
    const usage = timelineOf(rest, { settled: true }).find((row) => row.kind === "usage");
    const otherTools = marks.size || others.some((usd) => usd === undefined) ? null : (others as number[]).reduce((sum, usd) => sum + usd, 0);
    return { tools, tokens: usage ? (usage.usage?.usd ?? null) : 0, browser, others: otherTools };
  } finally {
    db.close();
  }
}

/** What the paid tools of `entries` (TOOL_STARTED and TOOL_COST) spent, as the cap counts it: each charge, and a call
 *  settled at a charge it did not say, or a crash cut (marked, never settled), at its held figure, as spentIn counts it;
 *  null when one has no figure. The run's reported cost reads such a call unknown instead (the timeline). */
export function capToolSpend(entries: readonly EntryLike[]): number | null {
  const open = new Map<unknown, unknown>();
  const figures: unknown[] = [];
  for (const { kind, data } of entries) {
    const at = (data ?? {}) as Record<string, unknown>;
    if (kind === TOOL_STARTED) open.set(at.call, at[HELD_FIELD]);
    else if (kind === TOOL_COST) figures.push(figureOf(at.usd) ?? open.get(at.call)), open.delete(at.call);
  }
  const all = [...figures, ...open.values()].map(figureOf);
  return all.every((figure) => figure !== undefined) ? (all as number[]).reduce((sum, figure) => sum + figure, 0) : null;
}

/** The worst case of each model request a cap admitted and whose cost is not booked yet, by its turn, for a paid tool's
 *  check on a harness whose booking counts a request only once its cost is in (harness-app.ts): `admitted` takes what
 *  the guard held, `started` gives it the turn that request leaves as (admissions run one at a time), `ended` drops it. */
export function holdsInFlight() {
  const holds = new Map<number, number>();
  // One slot between admitted() and started(): the runner admits one model request at a time per session.
  let next: number | undefined;
  return {
    admitted: (usd: number | undefined) => void (next = usd),
    started: (turn: number) => void (next !== undefined && holds.set(turn, next), (next = undefined)),
    ended: (turn: number) => void holds.delete(turn),
    total: () => [...holds.values()].reduce((sum, usd) => sum + usd, 0),
  };
}

/** The run's spend as its process counts it, for a paid tool: what it has spent (`spent`; null when unknown), what its
 *  model requests in flight are held at, at their worst case (`held`, read once `spent` is in; absent: none apart from
 *  `spent`), and the charge a call adds (`add`). Set by the run's cap, on pi (capModels) and on another harness
 *  (harness-app.ts); none without a cap. A run is one process, so one is set per process. */
export type RunSpend = { cap: number; spent(): number | null | Promise<number | null>; held?(): number; add(usd: number | null): void };
let runSpend: RunSpend | undefined;
let paying: Promise<unknown> = Promise.resolve();
export const useSpend = (spend: RunSpend | undefined): void => {
  runSpend = spend;
  // A paid call's refusal is its own spend's (its run's): another spend starts with none.
  paidRoomRefusal = undefined;
};

/** Each paid call sent under the cap and not settled, at what it is held at. */
const paidOpen = new Set<{ usd: number }>();
/** What the paid calls under way are held at, together (0 when none is): the one figure every check of the run's cap
 *  adds to what the run has spent, a model request's (capModels, capBefore) and a paid call's (paidCall). */
export const paidHolds = (): number => [...paidOpen].reduce((sum, { usd }) => sum + usd, 0);

/** A paid hold that outlives the paidCall that took it (a browser session's, browser-cost.ts), counted in paidHolds as a
 *  call's is until `drop`: its figure is `usd`, which its owner moves as charges use it. */
export const keepHold = (usd: number): { usd: number; drop(): void } => {
  const open = { usd, drop: () => void paidOpen.delete(open) };
  paidOpen.add(open);
  return open;
};
/** A charge booked outside any paidCall (a browser session's, booked in the commit that bills it) joins what the run's
 *  process counts as spent, as a paid call's does; with no cap, nothing counts it. */
export const addSpend = (usd: number | null): void => runSpend?.add(usd);
/** The run's cap, when it has one. */
export const runCap = (): number | undefined => runSpend?.cap;

/** `call`, a paid tool's (`name`), under the run's cap, by the rule a model request keeps: refused, in words that name
 *  its price and the cap and never calling it, unless what the run has spent plus what the call is held at (`hold`: its
 *  quote, else an allowance, `basis` saying which) fits the cap, and whenever the spend is unknown; else run, one paid
 *  call at a time, so each check sees the charge before it, and held at that figure (paidHolds) until the charge it
 *  reports (`charge` of its result, undefined for none) joins the spend. A charge it does not say (null), or a call that
 *  fails, counts at its held figure, as its mark does from the store (spentIn), since it may have charged that much.
 *  With no cap it just runs. */
/** A paid call this run's cap refused for room (paidCall): its words, after the code, and its figures as a model
 *  request's refusal keeps them (what was taken, and the call's hold as what it needs). The model's next request is
 *  refused in these words and with these figures (takePaidRefusal), so the turn ends on the refusal, as a refused model
 *  request's does, and the run waits on a raise (runs.ts pausedAt), its model never given a turn to route around it. */
let paidRoomRefusal: { owner: RunSpend; words: string; figures: RefusalFigures } | undefined;
/** The paid call's refusal the next model request of the run whose spend is `owner` is refused with, once: undefined
 *  when there is none, or it is another spend's. Only a run's own guard asks (capModels for pi, harness-app.ts for the
 *  others), never a guard a caller builds apart. */
export function takePaidRefusal(owner: RunSpend | undefined): { words: string; figures: RefusalFigures } | undefined {
  const refusal = paidRoomRefusal;
  if (!refusal || !owner || refusal.owner !== owner) return undefined;
  paidRoomRefusal = undefined;
  return { words: refusal.words, figures: refusal.figures };
}

export async function paidCall<T>(name: string, call: () => Promise<T>, charge: (result: T) => number | null | undefined, hold: { usd: number; basis: string }): Promise<{ refused: string; leastCapUsd?: number } | { result: T }> {
  const spend = runSpend;
  if (!spend) return { result: await call() };
  const turn = paying.then(async () => {
    const read = await spend.spent();
    if (read === null) return { refused: `${SPEND_CAP_REACHED}: ${name} was not sent. What the run has spent is unknown, so its cap of ${money(spend.cap)} cannot be kept: the run is out of budget.` };
    // What is held for requests and calls still answering, apart from what was spent, as a model request's refusal says it.
    const holding = (spend.held?.() ?? 0) + paidHolds();
    // Written so that a figure that is not a number refuses.
    if (!(read + holding + hold.usd <= spend.cap + FIT_TOLERANCE)) {
      // Refused for room: a raise would send it, so the run pauses at the model's next request (takePaidRefusal). Its
      // words and the least cap that sends it (leastCapUsd) are one figure, which the pause carries to its mark and serves.
      const refusal = paidRefusal(spend.cap, read, holding, name, hold);
      paidRoomRefusal = { owner: spend, words: refusal.text.slice(`${SPEND_CAP_REACHED}: `.length), figures: { spentUsd: read + holding, needsUsd: hold.usd, leastCapUsd: refusal.leastCapUsd } };
      return { refused: refusal.text, leastCapUsd: refusal.leastCapUsd };
    }
    // Held from here; settled into the spend in the same step that lets the hold go, so no check between sees neither.
    const open = { usd: hold.usd };
    paidOpen.add(open);
    try {
      const result = await call();
      const usd = charge(result);
      if (usd !== undefined) spend.add(usd ?? hold.usd);
      return { result };
    } catch (error) {
      spend.add(hold.usd);
      throw error;
    } finally {
      paidOpen.delete(open);
    }
  });
  paying = turn.catch(() => undefined);
  return turn;
}

/** The most output tokens one request may take: the model's ceiling, else its context window. A thinking budget can
 *  raise a request's ceiling up to the model's, whatever maxTokens it asked for. */
export const ceilingTokens = (model: Pick<Model<Api>, "maxTokens" | "contextWindow">) => (model.maxTokens > 0 ? model.maxTokens : model.contextWindow);

/** The output tokens a request's worst case is priced at: the model's ceiling; none when the model names no ceiling and
 *  its output costs nothing at every price tier, so any number of output tokens is $0; undefined when its output is
 *  priced and it names no ceiling, so nothing bounds what a request may cost. */
function outputBound(model: Pick<Model<Api>, "maxTokens" | "contextWindow" | "cost">): number | undefined {
  const ceiling = ceilingTokens(model);
  if (Number.isFinite(ceiling) && ceiling > 0) return ceiling;
  return [model.cost, ...(model.cost?.tiers ?? [])].every((rates) => rates?.output === 0) ? 0 : undefined;
}

/** A request's input tokens, bounded above: one per UTF-8 byte of what is sent (a byte-level tokenizer never takes
 *  fewer than one byte a token, and an image's base64 is far more bytes than its tokens), plus `overhead`, what the
 *  provider adds server-side that the body does not hold. The same bound on every harness. */
export const inputBound = (sent: string, overhead = 0): number => Buffer.byteLength(sent, "utf8") + overhead;

/** What pi's provider adds server-side to a request of `context`, the same table the model proxy uses, by the model's API
 *  kind: undefined for a kind whose additions are not known. The context does not say how the request chooses a tool,
 *  so the dearer choice is taken. */
export function piOverhead(model: Pick<Model<Api>, "api">, context: Context): number | undefined {
  const parts = (context.messages ?? []).flatMap((message) => (Array.isArray((message as { content?: unknown }).content) ? ((message as { content: { type?: unknown }[] }).content) : []));
  return providerInputOverhead(model.api, { tools: (context.tools?.length ?? 0) > 0, toolChoice: "any", images: parts.filter((part) => part?.type === "image").length });
}

const unmeasured = (cap: number) => `${SPEND_CAP_REACHED}: Not sent: the size of the next model request's input is unknown, so the run's cap of ${money(cap)} cannot be kept: the run is out of budget.`;

const noPrice = (cap: number) => `${SPEND_CAP_REACHED}: Not sent: the next model request's model has no price here, so the run's cap of ${money(cap)} cannot be kept: the run is out of budget.`;

const noCeiling = (cap: number) => `${SPEND_CAP_REACHED}: Not sent: the next model request's model has no output ceiling here and its output is priced, so what a request may cost has no bound and the run's cap of ${money(cap)} cannot be kept: the run is out of budget.`;

const unknownSpend = (cap: number) => `${SPEND_CAP_REACHED}: Not sent: what the run has spent is unknown, so its cap of ${money(cap)} cannot be kept: the run is out of budget.`;

/** A request's worst case at `model`'s price: `input` tokens at the dearer of its input and cache-write prices, and
 *  `output` tokens at its output price. */
function worstOf(calculateCost: typeof import("@earendil-works/pi-ai").calculateCost, model: Model<Api>): (input: number, output: number) => number {
  const priced = (tokens: Partial<Usage>) => calculateCost(model, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, ...tokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }).total;
  return (input, output) => Math.max(priced({ input, output }), priced({ cacheWrite: input, output }));
}

/** An amount in words: two decimals, or as many as it takes (up to eight) to show it whole ($0.50, $0.105, $0.0005). */
export function money(usd: number): string {
  // A whole number of dollars as given ($1), else two decimals or as many as it takes (up to eight) to show it whole.
  if (Number.isInteger(usd)) return `$${usd}`;
  for (let digits = 2; digits < 8; digits++) if (Number(usd.toFixed(digits)) === Number(usd.toFixed(8))) return `$${usd.toFixed(digits)}`;
  return `$${usd.toFixed(8)}`;
}

/** The code a cap's refusal begins with: `spend_cap_reached`, which the server ends the run with, and "out of budget",
 *  which pi-ai's retry (isRetryableAssistantError, which reads only an error's text) takes as final whatever digits the
 *  words after it hold. The words after it are the ones a person reads. */
export const CAP_REFUSAL_CODE = `${SPEND_CAP_REACHED} (out of budget): `;
/** A refusal for room's figures, beside its words: what the cap counted as taken (spent, and held for requests still
 *  answering), the least the refused request needs, and the least cap that sends it (`leastCapUsd`: the very figure its
 *  words name, "Raise the cap to at least $X", from the one call that wrote them). Kept on the refusal's own start mark
 *  (`spentUsd`, `needsUsd`, `leastCapUsd`), so a run paused at its cap says them (runs.ts pending), and its cap's raise is
 *  checked against them. */
export type RefusalFigures = { spentUsd: number; needsUsd: number; leastCapUsd: number };
/** The words of a refusal for room (CAP_REFUSAL_CODE: what is left of the cap cannot buy the request's least), which a
 *  higher cap would send; undefined for any other text, a refusal no cap could fix included (an unknown spend, no price,
 *  no output ceiling, an input not measured: the bare `spend_cap_reached: ` code). The one reader of that difference. */
export const roomRefusal = (text: string | undefined): string | undefined => (text?.startsWith(CAP_REFUSAL_CODE) ? text.slice(CAP_REFUSAL_CODE.length) : undefined);

/** A model's name as the words say it: the catalog's, without a vendor's prefix ("Anthropic: Claude Sonnet 5.5" reads
 *  "Claude Sonnet 5.5"), else its id. */
export const nameOf = (model: Pick<Model<Api>, "name" | "id">): string => (model.name || model.id).replace(/^[^:]{1,40}:\s+(?=\S)/, "");

/** A least in words: rounded up to the cent, so that it is enough ($0.1024 is $0.11). */
// Cents rounded up within the tail the fit check allows (FIT_TOLERANCE), no wider: a total past a cent by more than a
// float's own tail rounds to the cent above, so the cap a refusal names admits what it refused.
export const leastMoney = (usd: number): string => `$${(Math.ceil(usd * 100 - FIT_TOLERANCE * 100) / 100).toFixed(2)}`;
/** The cap to raise to for a request past `cap` that needs `total` in all: a cent at least, and above the cap, never
 *  the cap itself, so a raise to it is one PATCH /runs/{id} takes. */
export const raiseTo = (cap: number, total: number): string => `$${raiseFigure(cap, total).toFixed(2)}`;
/** raiseTo's cap as a number, whole cents in dollars: the figure a refusal carries beside its words (leastCapUsd). */
export const raiseFigure = (cap: number, total: number): number => {
  const cents = Math.ceil(total * 100 - FIT_TOLERANCE * 100);
  return (cents / 100 > cap + CAP_TOLERANCE ? cents : Math.floor((cap + CAP_TOLERANCE) * 100) + 1) / 100;
};


/** The cap's refusal of a request what is left of it cannot buy the least of, in plain words with the numbers: what
 *  the run spent (and holds for requests still answering) of its cap, what the request needs at the least, and the cap
 *  that would run it (spent, held and that least, rounded up to the cent, so that it is enough). After its code
 *  (CAP_REFUSAL_CODE), which keeps it final to pi-ai's retry. */
function capRefusal(cap: number, spent: number, held: number, name: string, least: number): { text: string; figures: RefusalFigures } {
  // The raise its words name and the figure it carries are one number (leastCapUsd), so the two never drift.
  const leastCapUsd = raiseFigure(cap, spent + held + least);
  const figures = { spentUsd: spent + held, needsUsd: least, leastCapUsd };
  const [need, raise] = [leastMoney(least), `$${leastCapUsd.toFixed(2)}`];
  if (spent === 0 && held === 0) return { text: `${CAP_REFUSAL_CODE}Not sent: this run's cap of ${money(cap)} can't cover one ${name} request (at least ${need}). Raise the cap to at least ${raise} to run it.`, figures };
  const owes = held > 0 ? `spent ${money(spent)} and holds ${money(held)} for requests still answering, of its ${money(cap)} cap` : `spent ${money(spent)} of its ${money(cap)} cap`;
  return { text: `${CAP_REFUSAL_CODE}Not sent: the run has ${owes}, and its next ${name} request needs at least ${need}. Raise the cap to at least ${raise} to run it.`, figures };
}
/** A guard's answer for a refusal for room: its words, and its figures beside them (harness-app.ts keeps them on its mark). */
const refuseFor = ({ text, figures }: ReturnType<typeof capRefusal>) => ({ refuse: text, ...figures });
/** capModels' judgement for a refusal for room: its words, and its figures for its start mark (request-start.ts). */
const whyOf = ({ text, figures }: ReturnType<typeof capRefusal>) => ({ why: text, figures });

/** The cap's refusal of a paid call (paidCall) what is left of it cannot hold, in one sentence, as capRefusal says a model
 *  request's: what the run spent (and holds for requests and calls still answering) of its cap, what the call could cost
 *  and why, and the cap that would run it: spent, held and the call's figure, rounded up to the cent, and a cent above the
 *  cap at the least, since a figure past the cap by less than a cent still needs more than the cap. Every amount by money,
 *  the raise by leastMoney. */
function paidRefusal(cap: number, spent: number, held: number, name: string, hold: { usd: number; basis: string }): { text: string; leastCapUsd: number } {
  const holds = held > 0 ? ` and holds ${money(held)} for calls still answering` : "";
  // The model refusal's rule (raiseFigure): a cent at least, and above the cap, never the cap itself; one number, which its
  // words name and its refusal carries.
  const leastCapUsd = raiseFigure(cap, spent + held + hold.usd);
  return { text: `${SPEND_CAP_REACHED}: Not sent: the run has spent ${money(spent)}${holds} of its ${money(cap)} cap, and ${name} could cost up to ${money(hold.usd)} (${hold.basis}). Raise the cap to at least $${leastCapUsd.toFixed(2)} to run it.`, leastCapUsd };
}

/** The most output tokens from `least` to `asked` whose request costs no more than `left` (`cost`, its price at that
 *  many, rising with them); undefined when even `least` costs more. A search, so that a price with tiers is exact. */
function mostOutput(cost: (output: number) => number, least: number, asked: number, left: number): number | undefined {
  // Written so that a cost that is not a number refuses; within a float's tail of what is left fits (FIT_TOLERANCE).
  const fits = (tokens: number) => cost(tokens) <= left + FIT_TOLERANCE;
  if (!fits(least)) return undefined;
  if (fits(asked)) return asked;
  let [low, high] = [least, asked];
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (fits(mid)) low = mid;
    else high = mid;
  }
  return low;
}

/** The least output a pi request may be limited to and still answer: the answer's 1,024 tokens, and when it thinks,
 *  the least budget on an API whose thinking takes one (squeezed to it), else its thinking level's budget, since its
 *  reasoning then shares the limit. */
export function leastOutput(model: Pick<Model<Api>, "api" | "reasoning">, thinking: string | undefined, budgetOf: (level: string) => number): number {
  if (!model.reasoning || !thinking || thinking === "off") return ANSWER_TOKENS_LEAST;
  return ANSWER_TOKENS_LEAST + (BUDGET_APIS.has(model.api) ? THINKING_BUDGET_LEAST : budgetOf(thinking));
}

/** The cap of a run on another harness, before each of its requests: the runner's booking says what the run has spent
 *  (its session, across processes) and which of its requests are still in flight, each with the output limit it was
 *  admitted with, and the model proxy each request's input bound (`inputTokensMax`, inputBound of its body; undefined
 *  when the body could not be measured), the output it asks for, and the least it may be limited to. */
export interface CapGuard {
  beforeRequest(request: GuardRequest): undefined | ({ refuse: string } & Partial<RefusalFigures>) | { outputTokensMax: number };
  /** The worst case a request this guard admitted is held at (its input bound, and the output limit it was admitted with
   *  or else its output ceiling, at the model's price): what the runner records for it, and counts it at when its own cost
   *  never comes in (cut short, or by a crash). */
  worstOf?(request: { inputTokensMax?: number; outputTokensMax?: number }): number | undefined;
  /** What a request this guard admitted counts at if its client stops it part way, having streamed `streamed` tokens (one
   *  a byte): its input bound and those tokens plus STOP_ALLOWANCE_TOKENS of output, at most its output limit, at the
   *  model's price. The runner counts it at no more than its hold. Undefined when its input was not measured. */
  stoppedOf?(request: { inputTokensMax?: number; outputTokensMax?: number }, streamed: number): number | undefined;
}
export type GuardRequest = {
  spentUsd: number | null;
  inFlight: readonly { inputTokensMax?: number; outputTokensMax?: number }[];
  inputTokensMax?: number; outputTokensAsked?: number; outputTokensLeast?: number;
};

/** A run on another harness: before each request, what the run has spent, plus the worst case of each request still in
 *  flight (at the output limit it was admitted with), must leave room for this request at its least output (1,024 tokens,
 *  or what its body says it needs to think and answer; what it asks for when that is fewer), else the request is refused
 *  with spend_cap_reached. Admitted, it is limited to the most output what is left buys (`outputTokensMax`, at most what
 *  it asks for and its model's ceiling), which the model proxy writes into its body: what it is held at is then what the
 *  provider can bill for it. A request's worst case is at the run model's
 *  price, as on pi (a request on a cheaper model is held at that price too, which only refuses sooner). What cannot be
 *  kept within a cap is refused under one: a spend that is unknown (a request a crash cut), an input that could not be
 *  measured, a model serve has no price for (`listed: false`, or none at all), and a model whose output is priced and
 *  that has no output ceiling. With no cap, nothing is refused. */
export async function capBefore(cap: number | undefined, model: Model<Api> | undefined, { listed = true }: { listed?: boolean } = {}): Promise<CapGuard | undefined> {
  if (cap === undefined) return undefined;
  if (model === undefined || !listed) return { beforeRequest: () => ({ refuse: noPrice(cap) }) };
  const output = outputBound(model);
  if (output === undefined) return { beforeRequest: () => ({ refuse: noCeiling(cap) }) };
  const price = worstOf((await import("@earendil-works/pi-ai")).calculateCost, model);
  const name = nameOf(model);
  const held = (request: { inputTokensMax?: number; outputTokensMax?: number }) => price(request.inputTokensMax!, request.outputTokensMax ?? output);
  return {
    beforeRequest({ spentUsd, inFlight, inputTokensMax, outputTokensAsked, outputTokensLeast }) {
      if (spentUsd === null) return { refuse: unknownSpend(cap) };
      const inputs = [inputTokensMax, ...inFlight.map((request) => request.inputTokensMax)];
      if (inputs.some((input) => typeof input !== "number" || !Number.isFinite(input))) return { refuse: unmeasured(cap) };
      // Its requests in flight at the limit each was admitted with, and its paid calls under way at what they are held at.
      const holding = inFlight.reduce((sum, request) => sum + held(request), paidHolds());
      const left = cap - spentUsd - holding;
      const cost = (tokens: number) => price(inputTokensMax!, tokens);
      // A model whose output costs nothing and names no ceiling: nothing to limit, only its input to fit.
      if (output === 0) return cost(0) <= left + FIT_TOLERANCE ? undefined : refuseFor(capRefusal(cap, spentUsd, holding, name, cost(0)));
      const asked = Math.min(outputTokensAsked ?? output, output);
      const least = Math.min(outputTokensLeast ?? ANSWER_TOKENS_LEAST, asked);
      const most = mostOutput(cost, least, asked, left);
      return most === undefined ? refuseFor(capRefusal(cap, spentUsd, holding, name, cost(least))) : { outputTokensMax: most };
    },
    worstOf: (request) => (typeof request.inputTokensMax === "number" && Number.isFinite(request.inputTokensMax) ? held(request) : undefined),
    stoppedOf: (request, streamed) => (typeof request.inputTokensMax === "number" && Number.isFinite(request.inputTokensMax) && Number.isFinite(streamed) && streamed >= 0
      ? stoppedPriceOf((tokens) => price(request.inputTokensMax!, tokens), request.outputTokensMax ?? output)(streamed) : undefined),
  };
}

/** A request's input bound (inputBound of its context, plus `overhead(model, context)`, what its provider adds
 *  server-side) and the most fee it can run up: a tool's own request adds what its hosted tool may read
 *  (hosted-search.ts), and its most fee. Undefined when its input cannot be measured. */
export function requestParts(overhead: (model: Model<Api>, context: Context) => number | undefined = piOverhead) {
  return (model: Model<Api>, context: Context): { input: number; feeUsd: number } | undefined => {
    const added = overhead(model, context);
    if (added === undefined) return undefined;
    const side = sideRequests.get(context);
    return { input: inputBound(JSON.stringify(context), added + (side?.extraInputTokens ?? 0)), feeUsd: side?.maxFeeUsd ?? 0 };
  };
}

/** `models`, each request limited to the output tokens what is left of `cap` after `spent` USD (and what requests in flight
 *  hold) can buy, at most what it asks for, thinking included (CLAMP on its marks when that is less), and refused when that
 *  cannot buy its least (`leastOutput`: 1,024 tokens for the answer, and its thinking's least), saying so in plain words;
 *  and, under the cap,
 *  each request to a model in `unpriced` (one serve has no price for) or whose output is priced and that has no output
 *  ceiling, each whose input cannot be bounded, and every request once what the run has spent is unknown: `spent` null
 *  (spentIn), or an answer since whose cost is unknown. A request's input is inputBound of its context, plus
 *  `overhead(model, context)` (piOverhead), what its provider adds server-side; undefined is unmeasured, never 0. Each
 *  request sent carries its worst case (HELD_USD) to the marks below, and one stopped before its end counts at it.
 *  `refused` (markRequests') writes the start mark of a refused model request before pi writes its error entry. */
export async function capModels<M extends Models>(models: M, cap: number, spent: number | null, { unpriced = new Set<string>(), overhead = piOverhead, refused: markRefused }: { unpriced?: ReadonlySet<string>; overhead?: (model: Model<Api>, context: Context) => number | undefined; refused?: (figures?: RefusalFigures) => Promise<void> } = {}): Promise<M> {
  const [{ calculateCost, createAssistantMessageEventStream }, simple] = await Promise.all([import("@earendil-works/pi-ai"), import("@earendil-works/pi-ai/api/simple-options")]);
  const partsOf = requestParts(overhead);
  let held = 0;
  // The run's spend as a paid tool's check reads it (installed below, useSpend): the requests in flight held at their
  // worst case apart from it (it adds the paid holds itself), and its charge joins the spend.
  const own: RunSpend = { cap, spent: () => spent, held: () => held, add: (usd) => void (spent = spent !== null && typeof usd === "number" && Number.isFinite(usd) ? spent + usd : null) };
  type Options = { maxTokens?: number; reasoning?: string; thinkingBudgets?: Record<string, number> } & Record<PropertyKey, unknown>;
  /** A request's worst case and the options it goes with (limited to what is left of the cap, when that is less than
   *  it asks for), or why the cap refuses it. `simpleCall`: through streamSimple or completeSimple, whose thinking pi-ai
   *  turns into a budget or an effort; a direct call sends its maxTokens as is. */
  type Judged = { worst: number; stopped: Stopped; options?: Options };
  const judge = (model: Model<Api>, context: Context, options: Options | undefined, simpleCall: boolean, turn: boolean): Judged | { why: string; figures?: RefusalFigures } => {
    if (unpriced.has(model.id)) return { why: noPrice(cap) };
    const ceiling = outputBound(model);
    if (ceiling === undefined) return { why: noCeiling(cap) };
    if (spent === null) return { why: unknownSpend(cap) };
    // A paid call the cap just refused for room: the turn's next request, the one after its result, is refused in its
    // words, and the run pauses there. A request after a message of the person's instead (a stop came first, and the
    // person moved on) is a new turn's: the refusal is let go, and this request is judged as any other. Only the turn's
    // own requests (stream, streamSimple) take it: a side request through the run's models (completeSimple: a
    // compaction's summary, native web_search's own, request-start.ts) is judged as any other and leaves it for them.
    const paid = turn ? takePaidRefusal(own) : undefined;
    if (paid && context.messages.at(-1)?.role === "toolResult") return { why: `${CAP_REFUSAL_CODE}${paid.words}`, figures: paid.figures };
    const parts = partsOf(model, context);
    if (parts === undefined) return { why: unmeasured(cap) };
    const price = worstOf(calculateCost, model);
    const cost = (tokens: number) => price(parts.input, tokens) + parts.feeUsd;
    // What the run holds beside what it spent, as a paid call's check counts it: each request in flight at its figure, and
    // each paid call under way at what it is held at.
    const holding = held + paidHolds();
    const left = cap - spent - holding;
    const name = nameOf(model);
    // A model whose output costs nothing and names no ceiling: nothing to limit, only its input and fee to fit.
    if (ceiling === 0) return cost(0) <= left + FIT_TOLERANCE ? { worst: cost(0), stopped: () => cost(0) } : whyOf(capRefusal(cap, spent, holding, name, cost(0)));
    // What the request would send as it stands, thinking included: pi-ai clamps its maxTokens (or the model's) to what its
    // context leaves, and on an API whose thinking takes a budget adds the budget to it.
    const transcript = context as unknown as Parameters<typeof simple.clampMaxTokensToContext>[1];
    const thinking = simpleCall && model.reasoning && options?.reasoning ? (options.reasoning as Parameters<typeof simple.thinkingBudgetForLevel>[0]) : undefined;
    // Adaptive thinking (pi-ai's current Claude models on Anthropic's API) takes no budget: pi-ai sends the request's
    // maxTokens as is, and the model thinks within them as it sees fit: at any level, none included, on a model with
    // mid-conversation effort, else when given a level.
    const compat = model.api === "anthropic-messages" && model.reasoning ? model.compat as { forceAdaptiveThinking?: boolean; supportsMidConvoEffort?: boolean } | undefined : undefined;
    const adaptive = compat?.supportsMidConvoEffort === true || (compat?.forceAdaptiveThinking === true && thinking !== undefined);
    const budgeted = thinking !== undefined && BUDGET_APIS.has(model.api) && !adaptive;
    const base = simple.clampMaxTokensToContext(model, transcript, options?.maxTokens ?? ceilingTokens(model));
    const asked = Math.min(ceiling, budgeted ? simple.clampMaxTokensToContext(model, transcript, simple.adjustMaxTokensForThinking(base, ceilingTokens(model), thinking, options?.thinkingBudgets).maxTokens) : base);
    const least = Math.min(leastOutput(model, thinking, (level) => simple.thinkingBudgetForLevel(level as never, options?.thinkingBudgets)), asked);
    const most = mostOutput(cost, least, asked, left);
    if (most === undefined) return whyOf(capRefusal(cap, spent, holding, name, cost(least)));
    // The reasoning a stop leaves unseen: a model's reasoning streams as a summary or not at all (the Responses API; Claude
    // 4-class thinking), so a request that reasons counts its level's budget (the budget it was sent with, on a budget
    // API), or its whole limit when it gives no level and its API reasons by default; none on a budget API with thinking
    // off, or on a model that does not reason. Adaptive thinking is bounded only by the limit, so it counts the limit
    // less the answer's 1,024 tokens. An estimate, as levels are not limits the provider keeps: within the hold.
    const hiddenOf = (limit: number): number => {
      if (adaptive) return Math.max(0, limit - ANSWER_TOKENS_LEAST);
      if (!model.reasoning || (thinking as string | undefined) === "off") return 0;
      if (thinking === undefined) return BUDGET_APIS.has(model.api) ? 0 : limit;
      const budget = simple.thinkingBudgetForLevel(thinking, options?.thinkingBudgets);
      return budgeted ? Math.max(0, Math.min(budget, limit - ANSWER_TOKENS_LEAST)) : budget;
    };
    // Stopped before its end, at most the output it was sent with: what it streamed, the part of its reasoning budget that
    // did not stream (max(0, budget - the reasoning streamed), so thinking that streamed is not counted twice), and the
    // allowance, within its worst case.
    const stoppedAt = (limit: number): Stopped => (message) => stoppedFigure(cost, limit, cost(limit), streamedBytes(message) + Math.max(0, hiddenOf(limit) - reasoningBytes(message)));
    if (most === asked) return { worst: cost(asked), stopped: stoppedAt(asked) };
    // Limited: sent with `most` tokens at most, thinking included. On a budget API the budget is squeezed first, keeping
    // the answer's 1,024, and maxTokens is what is left of `most` beside it, so pi-ai's sum is `most`.
    const clamp = { tokens: most, leftUsd: Math.round(left * 1e6) / 1e6, capUsd: cap };
    if (!budgeted) return { worst: cost(most), stopped: stoppedAt(most), options: { ...options, maxTokens: most, [CLAMP]: clamp } };
    const level = simple.clampReasoning(thinking)!;
    const budget = Math.min(simple.thinkingBudgetForLevel(thinking, options?.thinkingBudgets), most - ANSWER_TOKENS_LEAST);
    return { worst: cost(most), stopped: stoppedAt(most), options: { ...options, maxTokens: most - budget, thinkingBudgets: { ...options?.thinkingBudgets, [level]: budget }, [CLAMP]: clamp } };
  };
  const refusal = (model: Model<Api>, why: string): AssistantMessage => ({
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, stopReason: "error", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    // "out of budget" is final to pi-ai's retry policy, whatever digits the amounts hold.
    errorMessage: why,
  });
  /** Adds what `answer` cost to what the run has spent once it settles. One stopped before its end counts at `stopped`
   *  of what it streamed (stoppedFigure, at most `worst`), unless an attempt before the stop was lost: then at `worst`, as
   *  its lost mark reads in a later process; one that ended on an error after its response began
   *  (markResponseBegan: its usage is what had streamed, not what the provider can have billed), or that failed with no
   *  answer, at `worst`, what the cap held for it; each as spentIn reads its end mark. Without a figure (a deferred
   *  response) it is unknown, as is a cost that is not a number, from then on. */
  const count = (answer: Promise<AssistantMessage>, worst?: number, stopped?: Stopped, attempts?: readonly Attempt[]) => {
    const add = (cost: unknown) => void (spent = spent !== null && typeof cost === "number" && Number.isFinite(cost) ? spent + cost : null);
    // One rule (bookRequest), from how the request ended (piEnded) as its marks read it too.
    const at = (message: AssistantMessage) => message.stopReason === "aborted" ? (stopped && !anyAttemptLost(attempts) ? stopped(message) : worst)
      : bookRequest(piEnded(message, responseBegan.has(message), attempts), worst === undefined ? {} : { hold: worst }).usd;
    return answer.then((message) => add(at(message)), () => add(worst));
  };
  /** Sends a request judged to fit at `worst`, holding that until `answer` settles. */
  const admit = (worst: number, stopped: Stopped, answer: () => Promise<AssistantMessage>, attempts?: readonly Attempt[]): Promise<AssistantMessage> => {
    held += worst;
    let answered: Promise<AssistantMessage>;
    try {
      answered = answer();
    } catch (error) {
      held -= worst;
      throw error;
    }
    void count(answered, worst, stopped, attempts).finally(() => void (held -= worst));
    return answered;
  };
  // A paid tool's check reads the spend, and the requests in flight held at their worst case apart from it (it adds the
  // paid holds itself), and its charge joins the spend.
  useSpend(own);
  /** `options` with the request's worst case, and its figure if it is stopped, for its marks. */
  /** `options` with the request's worst case, its figure if it is stopped, and its attempts' record, for its marks: on an
   *  API the cap can watch, a fetch that records each attempt (`attempts`, undefined on one it cannot). */
  const carrying = <O>(options: O, { worst, stopped }: Judged, attempts: Attempt[] | undefined): O => ({
    ...options, [HELD_USD]: worst, [STOPPED_USD]: stopped,
    // null on an API the cap cannot watch: its marks read a failure before any event as lost.
    ...(attempts ? { [ATTEMPTS]: attempts, fetch: recordingFetch(attempts, (options as { fetch?: typeof fetch } | undefined)?.fetch, (options as { signal?: AbortSignal } | undefined)?.signal) } : { [ATTEMPTS]: null }),
  }) as O;
  const attemptsFor = (model: Model<Api>): Attempt[] | undefined => (unwatched(model.api) ? undefined : []);
  const stream = (send: (model: Model<Api>, context: Context, options?: Options) => AssistantMessageEventStream, simpleCall: boolean) =>
    (model: Model<Api>, context: Context, options?: Options): AssistantMessageEventStream => {
      const judged = judge(model, context, options, simpleCall, true);
      if ("worst" in judged) {
        let events: AssistantMessageEventStream | undefined;
        const attempts = attemptsFor(model);
        admit(judged.worst, judged.stopped, () => (events = send(model, context, carrying(judged.options ?? options, judged, attempts))).result(), attempts);
        return events!;
      }
      const refused = createAssistantMessageEventStream();
      const message = refusal(model, judged.why);
      // Its own start mark first, so pi's error entry for it answers that mark, never an earlier request a stop or a crash
      // cut. A mark that cannot be written still ends the request: spentIn leaves refusals out either way.
      void Promise.resolve()
        .then(() => markRefused?.(judged.figures))
        .catch(() => undefined)
        .then(() => {
          refused.push({ type: "error", reason: "error", error: message });
          refused.end(message);
        });
      return refused;
    };
  const complete = (send: (model: Model<Api>, context: Context, options?: Options) => Promise<AssistantMessage>, simpleCall: boolean) =>
    (model: Model<Api>, context: Context, options?: Options): Promise<AssistantMessage> => {
      const judged = judge(model, context, options, simpleCall, false);
      if (!("worst" in judged)) return Promise.resolve(refusal(model, judged.why));
      const attempts = attemptsFor(model);
      return admit(judged.worst, judged.stopped, () => send(model, context, carrying(judged.options ?? options, judged, attempts)), attempts);
    };
  const guarded: Record<PropertyKey, unknown> = {
    stream: stream(models.stream.bind(models) as never, false),
    streamSimple: stream(models.streamSimple.bind(models) as never, true),
    complete: complete(models.complete.bind(models) as never, false),
    completeSimple: complete(models.completeSimple.bind(models) as never, true),
    // A deferred response was admitted when it was sent; what it cost is counted when it is fetched.
    streamDeferred: (...args: Parameters<Models["streamDeferred"]>) => {
      const events = models.streamDeferred(...args);
      void count(events.result());
      return events;
    },
    fetchDeferred: (...args: Parameters<Models["fetchDeferred"]>) => {
      const answer = models.fetchDeferred(...args);
      void count(answer);
      return answer;
    },
  };
  return new Proxy(models, {
    get: (target, key) => {
      if (key in guarded) return guarded[key];
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
