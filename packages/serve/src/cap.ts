// A run's spend cap (`max_cost_usd`), held in the run's own process, where its model requests are sent. Before each
// request, what the run has spent, plus what its requests in flight are held at, plus what the request is expected to
// cost at its least output, must stay within the cap. Its input bound is inputBound: one token per UTF-8 byte of what is
// sent, plus what the provider adds server-side. How that input is priced is the cap's mode (`cap_mode`, CapMode):
// "expected", the default, prices it from the previous request in the same conversation (requestPrice, the one rule both
// paths call): the input that request reported read from or written to the cache, at the cache-read price, when it ended
// less than CACHE_WARM_MS ago (Anthropic keeps a cache 5 minutes), and the rest (its input after the cache, and what the
// body grew by since it) at the dearer of the input and cache-write prices; with no such request, every input token at
// that dearer price. "strict" prices every input token so: the worst case, which no request can pass. Each request is
// limited to the output what is left of the cap can buy at that input price (thinking included, never more than it asks
// for), and held at that: the limit is the wire's (pi's options, the model proxy's body for claude-agent and codex), so
// output never passes the cap. Only a cache miss can, by at most the request's bound (its input uncached less its input
// expected, 0 under strict), and its real cost is booked, never clipped; the run's timeline says so (runs.ts
// withOverCap), and the bound of a request in flight is served on the run's cost. Only when what is left cannot buy its
// least (1,024 tokens for the answer, and its thinking's least, leastOutput) is it not sent, and the run's turn ends on a
// model error the server reads as `spend_cap_reached`, saying in plain words what was spent and what the request needs. A
// model serve has no price for cannot be kept within a cap, so under one its requests are refused; a model listed at $0 is
// a known $0. What the run has spent is read back from its store when the process starts, so it survives a restart, plus
// each response since; a request in flight holds what it was admitted at until it answers. A request the person stopped
// before its end counts at its input, what it streamed (one token a byte) and STOP_ALLOWANCE_TOKENS of output the
// provider may have produced after the last word read, never more than its hold. One that ended on an error after its
// response began counts at its hold. The figure is written on the request's end mark (request-start.ts), so a later
// process counts it the same. Nor can a spend no one knows (a request a crash cut, a cost that is not a number) or a model
// whose output is priced and that has no output ceiling be kept within a cap: under one, each refuses the request, never
// passes as $0.
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
import { readRunDbSync } from "./run-db.js";
import { existsSync } from "node:fs";
import { providerInputOverhead } from "@parcha/agentrun-kernel/host";
import { bookRequest, type Ended, isConnectCode, isGatewayTimeout, rejectionCode } from "@parcha/agentrun-kernel";
import { CAP_WRAPUP, type EntryLike, REQUEST_CONTINUED, REQUEST_COST, REQUEST_COST_LATE, REQUEST_ENDED, REQUEST_REFUSED, REQUEST_STARTED, timelineOf, TOOL_COST, TOOL_STARTED } from "@parcha/pi-durable-agent/timeline";
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
/** The option a request's hold rides on from the cap to its marks (request-start.ts): what the cap held for it, its
 *  expected cost (its worst case under strict). A symbol, so no provider ever sends it. */
export const HELD_USD = Symbol.for("agentrun.serve.held_usd");
/** The option a request's bound rides on to its start mark (request-start.ts, as BOUND_FIELD): the most a cache miss can
 *  make it cost beyond its hold (its input uncached less its input expected; 0 under strict). A symbol, as HELD_USD. */
export const BOUND_USD = Symbol.for("agentrun.serve.bound_usd");
/** The field of a request's start mark that keeps its bound (BOUND_USD), on pi and on another harness (harness-app.ts):
 *  the run's cost serves it while the request is in flight, and the over-cap row names it (runs.ts). Absent for 0. */
export const BOUND_FIELD = "boundUsd";

/** How a run's cap prices a request's input (`cap_mode`): "expected" (the default) from the previous request's cache, so
 *  only a cache miss can pass the cap, by at most the request's bound; "strict" every input token uncached, the worst
 *  case, so no request can pass it. */
export const CAP_MODES = ["expected", "strict"] as const;
export type CapMode = (typeof CAP_MODES)[number];
/** A run's cap mode, passed to its process; absent is "expected". */
export const CAP_MODE_ENV = "AGENTRUN_SERVE_CAP_MODE";
/** The run's cap mode from its process's environment. */
export function capModeOf(env: NodeJS.ProcessEnv): CapMode {
  const text = env[CAP_MODE_ENV];
  if (text === undefined || text === "") return "expected";
  if (!(CAP_MODES as readonly string[]).includes(text)) throw new Error(`${CAP_MODE_ENV} is ${text}, not one of ${CAP_MODES.join(", ")}`);
  return text as CapMode;
}

/** How long after a request ended the next one in its conversation is expected to read its cache: 4 minutes, inside
 *  Anthropic's 5 (a cache kept that long from its last use; OpenAI's lasts longer). A request later than that is priced
 *  with nothing cached. */
export const CACHE_WARM_MS = 4 * 60_000;
/** The previous request of a conversation, as the cap reads it: the input tokens its usage reported read from the cache
 *  or written to it (`cachedTokens`: cache_read + cache_creation, or the Responses API's cached_tokens), the rest of its
 *  input (`inputTokens`), its input bound (`boundTokens`, inputBound of what it sent: the unit this request's bound is in),
 *  and when it ended (`endedAt`, ms). */
export type Previous = { cachedTokens: number; inputTokens: number; boundTokens: number; endedAt: number };
/** A request's input as it is priced: `cached` tokens at the cache-read price, `fresh` ones at the dearer of the input
 *  and cache-write prices. */
export type InputParts = { cached: number; fresh: number };
const tokenCount = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);
/** A request's Previous from the usage it reported (pi's shape: `input` without the cache's reads and writes), its input
 *  bound and when it ended; undefined when its usage says no input (a usage not read is zeros, never a count) or a
 *  figure is not a count. */
export function previousOf(usage: { input?: unknown; cacheRead?: unknown; cacheWrite?: unknown } | undefined, boundTokens: number | undefined, endedAt: number): Previous | undefined {
  const [input, read, write, bound] = [tokenCount(usage?.input), tokenCount(usage?.cacheRead ?? 0), tokenCount(usage?.cacheWrite ?? 0), tokenCount(boundTokens)];
  if (input === undefined || read === undefined || write === undefined || bound === undefined || !(input + read + write > 0) || !Number.isFinite(endedAt)) return undefined;
  return { cachedTokens: read + write, inputTokens: input, boundTokens: bound, endedAt };
}
/** The input of a request of `bound` tokens (inputBound) expected after `previous`, at `now`: the previous request's
 *  cached input read from the cache, and its input after the cache plus what the body grew by since it (in the bound's
 *  own unit, bytes, which a token never is fewer of) at full price. Undefined, the whole input uncached, with no previous
 *  request, one that ended CACHE_WARM_MS or more ago, or a clock that reads before its end. On a cache hit of a
 *  conversation that grew, what the request is billed for is within this; a miss costs at most its input uncached. */
export function expectedInput(bound: number, previous: Previous | undefined, now: number): InputParts | undefined {
  if (!previous) return undefined;
  const gap = now - previous.endedAt;
  if (!(gap >= 0 && gap < CACHE_WARM_MS)) return undefined;
  return { cached: previous.cachedTokens, fresh: previous.inputTokens + Math.max(0, bound - previous.boundTokens) };
}
/** The wrap-up's trigger (wrapUpDue): what is left of a cap under this many times a priced request's typical cost. */
export const WRAP_UP_FACTOR = 3;
/** A priced request's typical cost, for the wrap-up's trigger: the median of `costs` (the run's own model's requests, a
 *  cost known and above 0) after the first, which writes the cache and costs several warm ones; with one priced request,
 *  that one; with none, `nextExpected`, the next request's expected cost (what admission holds it at). No wait for a
 *  count of requests: a small cap may never reach one, and that run needs the wrap-up most. */
export function typicalCost(costs: readonly unknown[], nextExpected: number): number {
  const priced = costs.filter((usd): usd is number => typeof usd === "number" && Number.isFinite(usd) && usd > 0);
  if (priced.length === 0) return nextExpected;
  if (priced.length === 1) return priced[0]!;
  const warm = priced.slice(1).sort((a, b) => a - b);
  const mid = Math.floor(warm.length / 2);
  return warm.length % 2 ? warm[mid]! : (warm[mid - 1]! + warm[mid]!) / 2;
}
/** Whether a run near its cap is due its wrap-up: what is left (`cap` less `spent` and `held`, as admission counts it)
 *  is under WRAP_UP_FACTOR times `typical`. The same rule under strict. */
export function wrapUpDue(cap: number, spent: number, held: number, typical: number): { leftUsd: number } | undefined {
  const leftUsd = cap - spent - held;
  return Number.isFinite(leftUsd) && Number.isFinite(typical) && leftUsd < WRAP_UP_FACTOR * typical ? { leftUsd } : undefined;
}
/** The wrap-up's words, what is left to the cent. `nonePriced`: the run's own model has no priced request yet, so its
 *  typical cost is the next request's expected cost and the note can come before the run has done anything (step 0):
 *  the words say the budget and ask for a short answer, not a finish. Read from the same priced costs live and in a
 *  process opened again (costsIn, ownCosts), so a restart picks the same words. */
export const wrapUpWords = (leftUsd: number, nonePriced = false): string => {
  const left = centsMoney(Math.max(0, leftUsd));
  return nonePriced ? `This run's budget is about ${left}, enough for little work: answer as soon as you can.` : `About ${left} left of this run's budget: finish now with your answer.`;
};

/** A request priced at `price` under `mode`, its input `bound` tokens after `previous` at `now`, plus `feeUsd`: `cost`, what
 *  it is held at given its output tokens (its expected input, never more than uncached), and `worst`, its input uncached.
 *  The one rule pi's guard (capModels) and another harness's (capBefore) call. */
export function requestPrice(price: (input: InputParts, output: number) => number, bound: number, previous: Previous | undefined, now: number, mode: CapMode, feeUsd = 0): { cost(output: number): number; worst(output: number): number } {
  const worst = (output: number) => price({ cached: 0, fresh: bound }, output) + feeUsd;
  const parts = mode === "strict" ? undefined : expectedInput(bound, previous, now);
  if (!parts) return { cost: worst, worst };
  return { cost: (output) => Math.min(price(parts, output) + feeUsd, worst(output)), worst };
}
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
export const costOf = (entry: EntryLike): number => {
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
 *  this cap's refusals are left out, as none left. Unknown is null, which a cap never reads as $0. `sides`: only the
 *  run's side requests (each marked with a label: a learned workflow's, a hosted search's), what a run on another
 *  harness spent beside its harness's own requests and its paid tools, which that harness's booking does not hold. */
export function spentIn(storeFile: string, { sides = false }: { sides?: boolean } = {}): number | null {
  if (!existsSync(storeFile)) return 0;
  // Fresh, read-only and lock-free (run-db.ts): its process may hold it.
  const entries: EntryLike[] = [];
  // The store's own entries, as read (without the answers written below for a stopped request): openFigures reads them.
  const read: EntryLike[] = [];
  let marked = false;
  const rows: EntryLike[] = [];
  readRunDbSync(storeFile, false, (db) => {
    // A read made again (its file changed during it) starts from none.
    rows.length = 0;
    for (const row of db.prepare("SELECT record FROM entries ORDER BY rowid").iterate()) {
      const entry = JSON.parse(String((row as { record: string }).record)) as EntryLike;
      if (!sides || ([REQUEST_STARTED, REQUEST_ENDED, REQUEST_COST, REQUEST_COST_LATE].includes(entry.kind) && typeof (entry.data as { request?: unknown } | undefined)?.request === "string")) rows.push(entry);
    }
  });
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

/** The entries of the run's store, in order (none when it has no store yet). */
function entriesIn(storeFile: string): EntryLike[] {
  if (!existsSync(storeFile)) return [];
  // Fresh, read-only and lock-free (run-db.ts), as spentIn reads it.
  const rows: EntryLike[] = [];
  readRunDbSync(storeFile, false, (db) => {
    rows.length = 0;
    for (const row of db.prepare("SELECT record FROM entries ORDER BY rowid").iterate()) rows.push(JSON.parse(String((row as { record: string }).record)) as EntryLike);
  });
  return rows;
}
/** The priced answers of `model` (its id) in the run's store, in order: what the wrap-up's typical cost reads from earlier
 *  processes (capModels' `wrapUp`). An answer whose cost is unknown or $0, or that was stopped or failed, is none. */
export function costsIn(storeFile: string, model: string): number[] {
  return entriesIn(storeFile).flatMap((entry) => {
    const message = entry.kind === "pi.assistant" ? (entry.model?.[0] as { model?: unknown; stopReason?: unknown; usage?: { cost?: { total?: unknown } } } | undefined) : undefined;
    const total = message?.usage?.cost?.total;
    return message?.model === model && message.stopReason !== "error" && message.stopReason !== "aborted" && typeof total === "number" && Number.isFinite(total) && total > 0 ? [total] : [];
  });
}
/** Whether the run was told its wrap-up under `cap` already (a CAP_WRAPUP entry of that cap): once per cap, across its
 *  processes; a raise's new cap re-arms it. */
export function wrapUpSentIn(storeFile: string, cap: number): boolean {
  return entriesIn(storeFile).some((entry) => entry.kind === CAP_WRAPUP && typeof (entry.data as { capUsd?: unknown } | undefined)?.capUsd === "number" && Math.abs((entry.data as { capUsd: number }).capUsd - cap) <= CAP_TOLERANCE);
}

/** /usage's meters for a run that ended, from its store: `tools`, each TOOL_COST's `usd`, unknown (null) when one is,
 *  or when a call was cut (marked, never settled: what it charged no one knows); and `tokens`, the rest of its root
 *  conversation as its settled timeline prices it; `browser`, the part of `tools` that is browser session time
 *  (browser-cost.ts), with its seconds; and `others`, the rest of `tools`, each unknown (null) apart; and `notMetered`, the tool calls it ran with no price (TOOL_UNMETERED, an MCP tool its owner set none for), outside every figure here (absent when none). A mark is never a charge here (the cap's alone). Never for a live run: its process
 *  holds the store exclusively. */
export type Meters = { tools: number | null; tokens: number | null; browser: { usd: number | null; seconds: number }; others: number | null; notMetered?: number };
export function metersIn(storeFile: string): Meters {
  const { known: _, ...meters } = meterFiguresIn(storeFile);
  return meters;
}

/** metersIn's meters, and beside them each meter's known dollars: its settled charges' figures, whether or not another of
 *  its charges is unknown (a hold, a call cut or never settled, is no charge here: it adds nothing). What a run of
 *  unknown cost is known to have spent on each (server.ts /usage). */
export function meterFiguresIn(storeFile: string): Meters & { known: { tokens: number; browser: number; others: number } } {
  if (!existsSync(storeFile)) return { tools: 0, tokens: null, browser: { usd: 0, seconds: 0 }, others: 0, known: { tokens: 0, browser: 0, others: 0 } };
  return readRunDbSync(storeFile, false, (db) => {
    const rows = db.prepare("SELECT conversation_id AS conversation, record FROM entries ORDER BY rowid").all().map((row) => ({ conversation: Number(row.conversation), entry: JSON.parse(String(row.record)) as EntryLike }));
    const root = rows.reduce((min, row) => Math.min(min, row.conversation), Infinity);
    const marks = new Set<unknown>();
    const charges: (number | undefined)[] = [];
    const browser = { usd: 0 as number | null, seconds: 0 };
    const others: (number | undefined)[] = [];
    // Each meter's known dollars, whether or not one of its charges is unknown: what a run of unknown cost is known to
    // have spent on it (server.ts /usage).
    const known = { tokens: 0, browser: 0, others: 0 };
    for (const { entry } of rows) {
      const data = (entry.data ?? {}) as Record<string, unknown>;
      if (entry.kind === TOOL_STARTED) marks.add(data.call);
      else if (entry.kind === TOOL_COST) marks.delete(data.call), charges.push(figureOf(data.usd));
      if (entry.kind === TOOL_COST && data.tool !== "browser") others.push(figureOf(data.usd)), (known.others += figureOf(data.usd) ?? 0);
      if (entry.kind !== TOOL_COST || data.tool !== "browser") continue;
      const usd = figureOf(data.usd);
      known.browser += usd ?? 0;
      browser.usd = browser.usd === null || usd === undefined ? null : browser.usd + usd;
      browser.seconds += figureOf(data.seconds) ?? 0;
    }
    const tools = marks.size || charges.some((usd) => usd === undefined) ? null : (charges as number[]).reduce((sum, usd) => sum + usd, 0);
    const rest = rows.filter(({ conversation, entry }) => conversation === root && entry.kind !== TOOL_STARTED && entry.kind !== TOOL_COST).map(({ entry }) => entry);
    const usage = timelineOf(rest, { settled: true }).find((row) => row.kind === "usage");
    const otherTools = marks.size || others.some((usd) => usd === undefined) ? null : (others as number[]).reduce((sum, usd) => sum + usd, 0);
    known.tokens = usage ? (usage.usage?.usd ?? usage.usage?.so_far_usd ?? 0) : 0;
    const notMetered = usage?.usage?.not_metered;
    return { tools, tokens: usage ? (usage.usage?.usd ?? null) : 0, browser, others: otherTools, known, ...(notMetered ? { notMetered } : {}) };
  });
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
 *  (harness-app.ts); none without a cap. A run is one process, so one is set per process. `now`: the whole figure read at
 *  once, held requests included, with no wait for a cost still coming in; another harness sets it, for the run's own
 *  model requests beside the harness's (capModels' `joined`). */
export type RunSpend = { cap: number; spent(): number | null | Promise<number | null>; held?(): number; add(usd: number | null): void; now?(): number | null };
let runSpend: RunSpend | undefined;
let paying: Promise<unknown> = Promise.resolve();
export const useSpend = (spend: RunSpend | undefined): void => {
  runSpend = spend;
  // A paid call's refusal is its own spend's (its run's): another spend starts with none.
  paidRoomRefusal = undefined;
};

/** Each paid call sent under the cap and not settled, at what it is held at; on another harness, each of the run's own
 *  model requests in flight too (capModels' `joined`). */
const paidOpen = new Set<{ usd: number }>();
/** What the paid calls under way are held at, together (0 when none is): the one figure every check of the run's cap
 *  adds to what the run has spent, a model request's (capModels, capBefore) and a paid call's (paidCall). On another
 *  harness the run's own model requests in flight (a learned workflow's, a hosted search's) are held here too, so the
 *  harness's check sees them. */
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
/** On another harness, what the run's own model requests (capModels' `joined`) have cost: those of earlier processes
 *  (spentIn's `sides`) and this one's; null once one is unknown. 0 on pi, where the run's one capModels counts them. */
let sidesSpent: number | null = 0;
/** What sidesSpent says: the harness's check adds it to what its booking says the run spent (harness-app.ts). */
export const sideSpend = (): number | null => sidesSpent;

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

export async function paidCall<T>(name: string, call: () => Promise<T>, charge: (result: T) => number | null | undefined, hold: { usd: number; basis: string }, options: { pauses?: boolean } = {}): Promise<{ refused: string; leastCapUsd?: number } | { result: T }> {
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
      // `pauses: false`: no step of the run's own (a person's take-over of its browser), so the run goes on unpaused.
      if (options.pauses !== false) paidRoomRefusal = { owner: spend, words: refusal.text.slice(`${SPEND_CAP_REACHED}: `.length), figures: { spentUsd: read + holding, needsUsd: hold.usd, leastCapUsd: refusal.leastCapUsd } };
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

/** A request's price at `model`'s rates: its input's cached tokens at the cache-read price and its fresh ones at the
 *  dearer of the input and cache-write prices, and `output` tokens at the output price. */
function priceOf(calculateCost: typeof import("@earendil-works/pi-ai").calculateCost, model: Model<Api>): (input: InputParts, output: number) => number {
  const priced = (tokens: Partial<Usage>) => calculateCost(model, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, ...tokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }).total;
  return ({ cached, fresh }, output) => Math.max(priced({ input: fresh, cacheRead: cached, output }), priced({ cacheWrite: fresh, cacheRead: cached, output }));
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
 *  words name, "Raise the cap to at least $X", from the one call that wrote them: the request's figure there is what
 *  admission prices it at, its expected cost, or its worst case under strict, so a cap at it admits the request). Kept on
 *  the refusal's own start mark (`spentUsd`, `needsUsd`, `leastCapUsd`), so a run paused at its cap says them (runs.ts
 *  pending), and its cap's raise is checked against them. `boundUsd`: the most a cache miss could make the refused
 *  request cost beyond what it needs (BOUND_USD; absent for 0). */
export type RefusalFigures = { spentUsd: number; needsUsd: number; leastCapUsd: number; boundUsd?: number };
/** A refusal's figures as its start mark keeps them (`spentUsd`, `needsUsd`, `leastCapUsd`, and `boundUsd` when above 0);
 *  none without. */
export const refusalFields = (figures: RefusalFigures | undefined): Record<string, number> =>
  figures ? { spentUsd: figures.spentUsd, needsUsd: figures.needsUsd, leastCapUsd: figures.leastCapUsd, ...(typeof figures.boundUsd === "number" && figures.boundUsd > 0 ? { boundUsd: figures.boundUsd } : {}) } : {};
/** The words of a refusal for room (CAP_REFUSAL_CODE: what is left of the cap cannot buy the request's least), which a
 *  higher cap would send; undefined for any other text, a refusal no cap could fix included (an unknown spend, no price,
 *  no output ceiling, an input not measured: the bare `spend_cap_reached: ` code). The one reader of that difference. */
export const roomRefusal = (text: string | undefined): string | undefined => (text?.startsWith(CAP_REFUSAL_CODE) ? text.slice(CAP_REFUSAL_CODE.length) : undefined);

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


/** The cap's refusal of a request what is left of it cannot buy the least of, in plain words with the numbers, as a
 *  person who has never seen a model request reads them: what the run spent (and holds for steps still running) of its
 *  cap, what the next step needs at the least, and the cap that lets it continue (spent, held and that least, rounded
 *  up to the cent, so that it is enough). No model's name: a run is many requests, and "the next step" is the one that
 *  waits. After its code (CAP_REFUSAL_CODE), which keeps it final to pi-ai's retry. Its figures beside the words. */
function capRefusal(cap: number, spent: number, held: number, least: number): { text: string; figures: RefusalFigures } {
  // The raise its words name and the figure it carries are one number (leastCapUsd), so the two never drift.
  const leastCapUsd = raiseFigure(cap, spent + held + least);
  const figures = { spentUsd: spent + held, needsUsd: least, leastCapUsd };
  const [need, raise] = [leastMoney(least), `$${leastCapUsd.toFixed(2)}`];
  if (spent === 0 && held === 0) return { text: `${CAP_REFUSAL_CODE}Not sent: the next step needs at least ${need}, and this run's cap is ${money(cap)}. Raise the cap to at least ${raise} to continue.`, figures };
  return { text: `${CAP_REFUSAL_CODE}Not sent: this run has ${spentOf(spent, held, cap)}, and the next step needs at least ${need}. Raise the cap to at least ${raise} to continue.`, figures };
}
/** A guard's answer for a refusal for room: its words, and its figures beside them (harness-app.ts keeps them on its mark). */
const refuseFor = ({ text, figures }: ReturnType<typeof capRefusal>) => ({ refuse: text, ...figures });
/** capModels' judgement for a refusal for room: its words, and its figures for its start mark (request-start.ts). */
const whyOf = ({ text, figures }: ReturnType<typeof capRefusal>) => ({ why: text, figures });
/** What a run has spent of its cap, in a refusal's words: and what it holds for steps still running, when that is a cent
 *  or more. Each in cents (centsMoney), as the figures after it are; the exact amounts are the refusal's figures
 *  (RefusalFigures, the pause's spent_usd). */
const spentOf = (spent: number, held: number, cap: number): string => {
  const holds = centsMoney(held);
  return holds !== "$0" ? `spent ${centsMoney(spent)} and holds ${holds} for steps still running, of its ${money(cap)} cap` : `spent ${centsMoney(spent)} of its ${money(cap)} cap`;
};
/** An amount in words, to the nearest cent ($0.0237416 is $0.02), as money says it ($1, $0.20, $0). */
export const centsMoney = (usd: number): string => money(Math.round(usd * 100) / 100);

/** The cap's refusal of a paid call (paidCall) what is left of it cannot hold, in one sentence, as capRefusal says a model
 *  request's: what the run spent (and holds for requests and calls still answering) of its cap, what the call could cost
 *  and why, and the cap that would run it: spent, held and the call's figure, rounded up to the cent, and a cent above the
 *  cap at the least, since a figure past the cap by less than a cent still needs more than the cap. What was spent and held
 *  in cents (spentOf), the call's figure and the cap by money, the raise by raiseFigure. */
function paidRefusal(cap: number, spent: number, held: number, name: string, hold: { usd: number; basis: string }): { text: string; leastCapUsd: number } {
  // The model refusal's rule (raiseFigure): a cent at least, and above the cap, never the cap itself; one number, which its
  // words name and its refusal carries. The same words: the call is the next step, named as the tool.
  const leastCapUsd = raiseFigure(cap, spent + held + hold.usd);
  return { text: `${SPEND_CAP_REACHED}: Not sent: this run has ${spentOf(spent, held, cap)}, and the next step, ${name}, could cost up to ${money(hold.usd)} (${hold.basis}). Raise the cap to at least $${leastCapUsd.toFixed(2)} to continue.`, leastCapUsd };
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
 *  (its session, across processes) and which of its requests are still in flight, each with what it was admitted at;
 *  the model proxy says each request's input bound (`inputTokensMax`, inputBound of its body; undefined when the body
 *  could not be measured), the output it asks for, and the least it may be limited to; and the host the session's
 *  previous request on the same model, as its usage reported it (`previous`, harness-app.ts). */
export interface CapGuard {
  beforeRequest(request: GuardRequest): ({ refuse: string } & Partial<RefusalFigures>) | Admitted;
}
/** A request this guard admitted: the most output it may be sent with (none for a model whose output is free and has no
 *  ceiling), what it is held at (`holdUsd`: its expected cost at that output, its worst case under strict), which the
 *  runner records for it and counts it at when its own cost never comes in (cut short, or by a crash), its bound
 *  (`boundUsd`, BOUND_USD), and what it counts at if its client stops it part way having streamed that many tokens (one a
 *  byte): its input and those tokens plus STOP_ALLOWANCE_TOKENS of output, at most its output limit, never more than its
 *  hold. */
export type Admitted = { outputTokensMax?: number; holdUsd: number; boundUsd: number; stoppedUsd(streamed: number): number };
export type GuardRequest = {
  spentUsd: number | null;
  /** The requests in flight, each held at what it was admitted at (`holdUsd`), else at its worst case at the output limit
   *  it was admitted with. */
  inFlight: readonly { inputTokensMax?: number; outputTokensMax?: number; holdUsd?: number }[];
  inputTokensMax?: number; outputTokensAsked?: number; outputTokensLeast?: number;
  /** The session's previous request on this model (Previous); none, the whole input uncached. */
  previous?: Previous;
};

/** A run on another harness: before each request, what the run has spent, plus what each request still in flight was
 *  admitted at, must leave room for this request at its least output (1,024 tokens, or what its body says it needs to
 *  think and answer; what it asks for when that is fewer), its input priced by requestPrice under `mode`, else the request
 *  is refused with spend_cap_reached. Admitted, it is limited to the most output what is left buys (`outputTokensMax`, at
 *  most what it asks for and its model's ceiling), which the model proxy writes into its body: output never passes the
 *  cap. A request is priced at the run model's price, as on pi (a request on a cheaper model is held at that price too,
 *  which only refuses sooner). What cannot be kept within a cap is refused under one: a spend that is unknown (a request a
 *  crash cut), an input that could not be measured, a model serve has no price for (`listed: false`, or none at all),
 *  and a model whose output is priced and that has no output ceiling. With no cap, nothing is refused. `now`: the clock a
 *  previous request's end is read against. */
export async function capBefore(cap: number | undefined, model: Model<Api> | undefined, { listed = true, mode = "expected", now = Date.now }: { listed?: boolean; mode?: CapMode; now?: () => number } = {}): Promise<CapGuard | undefined> {
  if (cap === undefined) return undefined;
  if (model === undefined || !listed) return { beforeRequest: () => ({ refuse: noPrice(cap) }) };
  const output = outputBound(model);
  if (output === undefined) return { beforeRequest: () => ({ refuse: noCeiling(cap) }) };
  const price = priceOf((await import("@earendil-works/pi-ai")).calculateCost, model);
  const held = (request: GuardRequest["inFlight"][number]) => request.holdUsd ?? price({ cached: 0, fresh: request.inputTokensMax! }, request.outputTokensMax ?? output);
  return {
    beforeRequest({ spentUsd, inFlight, inputTokensMax, outputTokensAsked, outputTokensLeast, previous }) {
      if (spentUsd === null) return { refuse: unknownSpend(cap) };
      const inputs = [inputTokensMax, ...inFlight.map((request) => request.inputTokensMax)];
      if (inputs.some((input) => typeof input !== "number" || !Number.isFinite(input))) return { refuse: unmeasured(cap) };
      // Its requests in flight at what each was admitted at, and its paid calls under way at what they are held at.
      const holding = inFlight.reduce((sum, request) => sum + held(request), paidHolds());
      const left = cap - spentUsd - holding;
      const priced = requestPrice(price, inputTokensMax!, previous, now(), mode);
      const cost = priced.cost;
      const bound = (tokens: number) => Math.max(0, priced.worst(tokens) - cost(tokens));
      const boundOf = (tokens: number) => (bound(tokens) > 0 ? { boundUsd: bound(tokens) } : {});
      const admitted = (limit: number): Admitted => ({ ...(output === 0 ? {} : { outputTokensMax: limit }), holdUsd: cost(limit), boundUsd: bound(limit), stoppedUsd: stoppedPriceOf(cost, limit) });
      // A model whose output costs nothing and names no ceiling: nothing to limit, only its input to fit.
      if (output === 0) return cost(0) <= left + FIT_TOLERANCE ? admitted(0) : { ...refuseFor(capRefusal(cap, spentUsd, holding, cost(0))), ...boundOf(0) };
      const asked = Math.min(outputTokensAsked ?? output, output);
      const least = Math.min(outputTokensLeast ?? ANSWER_TOKENS_LEAST, asked);
      const most = mostOutput(cost, least, asked, left);
      return most === undefined ? { ...refuseFor(capRefusal(cap, spentUsd, holding, cost(least))), ...boundOf(least) } : admitted(most);
    },
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

/** The wrap-up on pi (capModels' `wrapUp`): the run's own model (`model`, its id), that model's priced requests so far
 *  (`costs`, earlier processes' from the store, costsIn; capModels adds each one it books), whether it was told under this
 *  cap already (`sent`, wrapUpSentIn), and `record`, which writes its row (request-start.ts, CAP_WRAPUP). */
export type WrapUp = { model: string; costs: number[]; sent: boolean; record(data: { capUsd: number; leftUsd: number; words: string }): void };

/** `models`, each request limited to the output tokens what is left of `cap` after `spent` USD (and what requests in flight
 *  hold) can buy, at most what it asks for, thinking included (CLAMP on its marks when that is less), and refused when that
 *  cannot buy its least (`leastOutput`: 1,024 tokens for the answer, and its thinking's least), saying so in plain words;
 *  and, under the cap,
 *  each request to a model in `unpriced` (one serve has no price for) or whose output is priced and that has no output
 *  ceiling, each whose input cannot be bounded, and every request once what the run has spent is unknown: `spent` null
 *  (spentIn), or an answer since whose cost is unknown. A request's input is inputBound of its context, plus
 *  `overhead(model, context)` (piOverhead), what its provider adds server-side; undefined is unmeasured, never 0. It is
 *  priced by requestPrice under `mode`, after the previous request of its conversation (the context's last answer, read
 *  by previousIn; its end as `now` read it when it settled here, else its own timestamp, which is when it began). Each
 *  request sent carries what it is held at (HELD_USD) and its bound (BOUND_USD) to the marks below, and one stopped
 *  before its end counts at most its hold.
 *  `refused` (markRequests') writes the start mark of a refused model request before pi writes its error entry.
 *  `joined`: the run is on another harness, whose spend is the run's one total, and these are the run's own requests
 *  beside the harness's (a learned workflow's, a hosted search's). Each is judged against that total as the harness
 *  sets it when its run opens (RunSpend.now: its booked requests, its paid tools' charges and its requests in flight,
 *  with sideSpend), unknown until then; held where the harness's check sees it (paidHolds); and its cost added to
 *  sideSpend, which starts at `spent` (what these cost in earlier processes: spentIn's `sides`). */
export async function capModels<M extends Models>(models: M, cap: number, spent: number | null, { unpriced = new Set<string>(), overhead = piOverhead, refused: markRefused, joined = false, mode = "expected", now = Date.now, wrapUp }: { unpriced?: ReadonlySet<string>; overhead?: (model: Model<Api>, context: Context) => number | undefined; refused?: (figures?: RefusalFigures) => Promise<void>; joined?: boolean; mode?: CapMode; now?: () => number; wrapUp?: WrapUp } = {}): Promise<M> {
  const [{ calculateCost, createAssistantMessageEventStream }, simple] = await Promise.all([import("@earendil-works/pi-ai"), import("@earendil-works/pi-ai/api/simple-options")]);
  const partsOf = requestParts(overhead);
  /** When each answer settled here, by its timestamp (an answer keeps it when the run's store gives it back), the newest
   *  ENDED_KEPT of them: its end, for the next request's previous. */
  const ended = new Map<number, number>();
  const ENDED_KEPT = 64;
  const endedNow = (message: AssistantMessage) => {
    if (typeof message.timestamp !== "number") return;
    ended.delete(message.timestamp);
    ended.set(message.timestamp, now());
    if (ended.size > ENDED_KEPT) ended.delete(ended.keys().next().value!);
  };
  /** The previous request of `context`'s conversation on `model`: its last answer, if one on this model whose usage says
   *  its input, with the bound of what it was sent (the context before it, measured as this request is). An answer on
   *  another model, or that failed or was stopped, leaves none: nothing cached to count on. */
  const previousIn = (model: Model<Api>, context: Context): Previous | undefined => {
    const at = context.messages.findLastIndex((message) => message.role === "assistant");
    const answer = context.messages[at] as AssistantMessage | undefined;
    if (!answer || answer.model !== model.id || answer.provider !== model.provider || answer.stopReason === "error" || answer.stopReason === "aborted") return undefined;
    const before = partsOf(model, { ...context, messages: context.messages.slice(0, at) });
    return previousOf(answer.usage, before?.input, ended.get(answer.timestamp) ?? answer.timestamp);
  };
  let held = 0;
  if (joined) sidesSpent = spent;
  /** What the run has spent, as this request's check reads it: on another harness the run's one total (`joined`). */
  const spentNow = (): number | null => (joined ? (runSpend?.now?.() ?? null) : spent);
  // The run's spend as a paid tool's check reads it (installed below, useSpend): the requests in flight held at their
  // worst case apart from it (it adds the paid holds itself), and its charge joins the spend.
  const own: RunSpend = { cap, spent: () => spent, held: () => held, add: (usd) => void (spent = spent !== null && typeof usd === "number" && Number.isFinite(usd) ? spent + usd : null) };
  type Options = { maxTokens?: number; reasoning?: string; thinkingBudgets?: Record<string, number> } & Record<PropertyKey, unknown>;
  /** What a request is held at (its expected cost, its worst case under strict), its bound, and the options it goes with
   *  (limited to what is left of the cap, when that is less than it asks for), or why the cap refuses it. `simpleCall`:
   *  through streamSimple or completeSimple, whose thinking pi-ai turns into a budget or an effort; a direct call sends
   *  its maxTokens as is. */
  type Judged = { hold: number; bound: number; stopped: Stopped; options?: Options; context?: Context };
  /** `judgeOne`, and near the cap the wrap-up (wrapUpDue), once: a turn's request on the run's own model is sent with the
   *  words after everything its context holds (`context`), its bytes admitted with it. Only in this one request: pi's
   *  transcript never holds the note, and no input is queued, so the run spends nothing after the model answers. */
  const judge = (model: Model<Api>, context: Context, options: Options | undefined, simpleCall: boolean, turn: boolean): Judged | { why: string; figures?: RefusalFigures } => {
    const judged = judgeOne(model, context, options, simpleCall, turn);
    if (!("hold" in judged) || !wrapUp || wrapUp.sent || joined || !turn || model.id !== wrapUp.model) return judged;
    const spentUsd = spentNow();
    // What is left as admission counted it: what was spent, and what requests and paid calls in flight are held at.
    const due = spentUsd === null ? undefined : wrapUpDue(cap, spentUsd, held + paidHolds(), typicalCost(wrapUp.costs, judged.hold));
    if (!due) return judged;
    const words = wrapUpWords(due.leftUsd, wrapUp.costs.length === 0);
    const noted = { ...context, messages: [...context.messages, { role: "user", content: `<system-reminder>${words}</system-reminder>`, timestamp: now() }] } as Context;
    const again = judgeOne(model, noted, options, simpleCall, turn);
    // The note's own bytes do not fit: the request goes as it came, and the note waits for one they do.
    if (!("hold" in again)) return judged;
    wrapUp.sent = true;
    wrapUp.record({ capUsd: cap, leftUsd: due.leftUsd, words });
    return { ...again, context: noted };
  };
  const judgeOne = (model: Model<Api>, context: Context, options: Options | undefined, simpleCall: boolean, turn: boolean): Judged | { why: string; figures?: RefusalFigures } => {
    if (unpriced.has(model.id)) return { why: noPrice(cap) };
    const ceiling = outputBound(model);
    if (ceiling === undefined) return { why: noCeiling(cap) };
    const spentUsd = spentNow();
    if (spentUsd === null) return { why: unknownSpend(cap) };
    // A paid call the cap just refused for room: the turn's next request, the one after its result, is refused in its
    // words, and the run pauses there. A request after a message of the person's instead (a stop came first, and the
    // person moved on) is a new turn's: the refusal is let go, and this request is judged as any other. Only the turn's
    // own requests (stream, streamSimple) take it: a side request through the run's models (completeSimple: a
    // compaction's summary, native web_search's own, request-start.ts) is judged as any other and leaves it for them.
    const paid = turn ? takePaidRefusal(own) : undefined;
    if (paid && context.messages.at(-1)?.role === "toolResult") return { why: `${CAP_REFUSAL_CODE}${paid.words}`, figures: paid.figures };
    const parts = partsOf(model, context);
    if (parts === undefined) return { why: unmeasured(cap) };
    // Its price by the one rule (requestPrice): its input expected after the previous request, else uncached.
    const priced = requestPrice(priceOf(calculateCost, model), parts.input, mode === "strict" ? undefined : previousIn(model, context), now(), mode, parts.feeUsd);
    const cost = priced.cost;
    const bound = (tokens: number) => Math.max(0, priced.worst(tokens) - cost(tokens));
    // A refusal for room at `tokens` of output: its words and figures (capRefusal, at what admission prices the request
    // at), and the bound it would have been sent with.
    const refusedAt = (holding: number, tokens: number) => {
      const { why, figures } = whyOf(capRefusal(cap, spentUsd, holding, cost(tokens)));
      return { why, figures: { ...figures, ...(bound(tokens) > 0 ? { boundUsd: bound(tokens) } : {}) } };
    };
    // What the run holds beside what it spent, as a paid call's check counts it: each request in flight at its figure, and
    // each paid call under way at what it is held at.
    const holding = held + paidHolds();
    const left = cap - spentUsd - holding;
    // A model whose output costs nothing and names no ceiling: nothing to limit, only its input and fee to fit.
    if (ceiling === 0) return cost(0) <= left + FIT_TOLERANCE ? { hold: cost(0), bound: bound(0), stopped: () => cost(0) } : refusedAt(holding, 0);
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
    if (most === undefined) return refusedAt(holding, least);
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
    if (most === asked) return { hold: cost(asked), bound: bound(asked), stopped: stoppedAt(asked) };
    // Limited: sent with `most` tokens at most, thinking included. On a budget API the budget is squeezed first, keeping
    // the answer's 1,024, and maxTokens is what is left of `most` beside it, so pi-ai's sum is `most`.
    const clamp = { tokens: most, leftUsd: Math.round(left * 1e6) / 1e6, capUsd: cap };
    if (!budgeted) return { hold: cost(most), bound: bound(most), stopped: stoppedAt(most), options: { ...options, maxTokens: most, [CLAMP]: clamp } };
    const level = simple.clampReasoning(thinking)!;
    const budget = Math.min(simple.thinkingBudgetForLevel(thinking, options?.thinkingBudgets), most - ANSWER_TOKENS_LEAST);
    return { hold: cost(most), bound: bound(most), stopped: stoppedAt(most), options: { ...options, maxTokens: most - budget, thinkingBudgets: { ...options?.thinkingBudgets, [level]: budget }, [CLAMP]: clamp } };
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
  const count = (answer: Promise<AssistantMessage>, turn: boolean, worst?: number, stopped?: Stopped, attempts?: readonly Attempt[]) => {
    const plus = (sum: number | null, cost: unknown) => (sum !== null && typeof cost === "number" && Number.isFinite(cost) ? sum + cost : null);
    const add = (cost: unknown) => void (joined ? (sidesSpent = plus(sidesSpent, cost)) : (spent = plus(spent, cost)));
    // One rule (bookRequest), from how the request ended (piEnded) as its marks read it too.
    const at = (message: AssistantMessage) => message.stopReason === "aborted" ? (stopped && !anyAttemptLost(attempts) ? stopped(message) : worst)
      : bookRequest(piEnded(message, responseBegan.has(message), attempts), worst === undefined ? {} : { hold: worst }).usd;
    // A priced turn answer of the run's own model: the wrap-up's typical cost counts it, as costsIn reads it again (its
    // pi.assistant entries). Never a compaction summary's or a native search's request on the same model (completeSimple
    // calls, `turn` false): no pi.assistant entry keeps them, so a process opened again would count without them.
    const priced = (message: AssistantMessage) => {
      const total = message.usage?.cost?.total;
      if (wrapUp && turn && message.model === wrapUp.model && message.stopReason !== "error" && message.stopReason !== "aborted" && typeof total === "number" && Number.isFinite(total) && total > 0) wrapUp.costs.push(total);
    };
    return answer.then((message) => (endedNow(message), priced(message), add(at(message))), () => add(worst));
  };
  /** Sends a request judged to fit at `worst` (its hold), holding that until `answer` settles: here, or on another harness
   *  where its check sees it (`joined`: paidHolds). */
  const admit = (turn: boolean, worst: number, stopped: Stopped, answer: () => Promise<AssistantMessage>, attempts?: readonly Attempt[]): Promise<AssistantMessage> => {
    const hold = { usd: worst };
    if (joined) paidOpen.add(hold);
    else held += worst;
    const release = () => void (joined ? paidOpen.delete(hold) : (held -= worst));
    let answered: Promise<AssistantMessage>;
    try {
      answered = answer();
    } catch (error) {
      release();
      throw error;
    }
    void count(answered, turn, worst, stopped, attempts).finally(release);
    return answered;
  };
  // A paid tool's check reads the spend, and the requests in flight held at their worst case apart from it (it adds the
  // paid holds itself), and its charge joins the spend. On another harness, the harness sets it as its run opens
  // (harness-app.ts).
  if (!joined) useSpend(own);
  /** `options` with what the request is held at, its bound, its figure if it is stopped, and its attempts' record, for
   *  its marks: on an API the cap can watch, a fetch that records each attempt (`attempts`, undefined on one it cannot). */
  const carrying = <O>(options: O, { hold, bound, stopped }: Judged, attempts: Attempt[] | undefined): O => ({
    ...options, [HELD_USD]: hold, [BOUND_USD]: bound, [STOPPED_USD]: stopped,
    // null on an API the cap cannot watch: its marks read a failure before any event as lost.
    ...(attempts ? { [ATTEMPTS]: attempts, fetch: recordingFetch(attempts, (options as { fetch?: typeof fetch } | undefined)?.fetch, (options as { signal?: AbortSignal } | undefined)?.signal) } : { [ATTEMPTS]: null }),
  }) as O;
  const attemptsFor = (model: Model<Api>): Attempt[] | undefined => (unwatched(model.api) ? undefined : []);
  const stream = (send: (model: Model<Api>, context: Context, options?: Options) => AssistantMessageEventStream, simpleCall: boolean) =>
    (model: Model<Api>, context: Context, options?: Options): AssistantMessageEventStream => {
      const judged = judge(model, context, options, simpleCall, true);
      if ("hold" in judged) {
        let events: AssistantMessageEventStream | undefined;
        const attempts = attemptsFor(model);
        admit(true, judged.hold, judged.stopped, () => (events = send(model, judged.context ?? context, carrying(judged.options ?? options, judged, attempts))).result(), attempts);
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
      if (!("hold" in judged)) return Promise.resolve(refusal(model, judged.why));
      const attempts = attemptsFor(model);
      return admit(false, judged.hold, judged.stopped, () => send(model, judged.context ?? context, carrying(judged.options ?? options, judged, attempts)), attempts);
    };
  const guarded: Record<PropertyKey, unknown> = {
    stream: stream(models.stream.bind(models) as never, false),
    streamSimple: stream(models.streamSimple.bind(models) as never, true),
    complete: complete(models.complete.bind(models) as never, false),
    completeSimple: complete(models.completeSimple.bind(models) as never, true),
    // A deferred response was admitted when it was sent; what it cost is counted when it is fetched.
    streamDeferred: (...args: Parameters<Models["streamDeferred"]>) => {
      const events = models.streamDeferred(...args);
      void count(events.result(), true);
      return events;
    },
    fetchDeferred: (...args: Parameters<Models["fetchDeferred"]>) => {
      const answer = models.fetchDeferred(...args);
      void count(answer, true);
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
