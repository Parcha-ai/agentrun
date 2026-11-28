// A session's model proxy, written for AgentRun: the provider a harness is pointed at, on the loopback interface. The
// harness holds only the session's own key; the provider's credential never reaches it. The proxy is provider-neutral,
// and a `ProviderPolicy` says what one provider's API may carry (its routes, how its client sends a key, the body it may
// forward, where a response reports its usage). The core:
//  - admits a request only with the session's key (compared in constant time), on a route the policy lists, by exact
//    path text, with no query or one the route lists exactly: an absolute URL, `..`, `//` or `%` escapes never match. A
//    route may be answered here with a status alone, with no key (a client's connectivity check), or with a body the
//    policy fixed, with the key (a client's list of models), or be free (a token count, which the runner never pays);
//  - parses the body strictly (one JSON value, no duplicate key at any depth, so a check on one `model` cannot pass while
//    the provider reads another), then has the policy shape it (or refuse it);
//  - asks the runner before every paid request (`beforeRequest`, where a turn cap or the host's budget refuses it) and
//    answers a refusal with a status the client does not retry, adds the provider's credential, forwards to the
//    provider's origin and the route's own path (never text from the request), streams the answer back, and reports the
//    response's usage once it completes (`afterRequest`). Every paid request forwarded is booked exactly once: a response
//    cut short, or one that says no usage, is booked at an unknown cost.
// Model spend is accounted only there, by the runner: the proxy keeps no ledger of its own.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { CONTENT_FILTERED, type CapCut, type NoteRequest } from "../types.js";
import { type Ended, isConnectCode, isGatewayTimeout, rejectionCode } from "../booking.js";
import { SPEND_CAP_REACHED } from "../kernel/cap/words.js";
import type { BilledRequest } from "./overhead.js";
import { onOpenRouter, openRouterAttribution } from "./openrouter-attribution.js";
import { toolCallsIn, toolCallsInBody, type TurnBudget, type TurnSpan } from "../process/turn-budget.js";

/** Whether a request's admission refused it for the run's spend cap, read from the error's fields alone: the cap's own
 *  error (CapRefused, its `code`), or the runner's stop for the cap's verdict (HarnessRunError, its `refusal`: the
 *  verdict's Refusal.code). Never from its words. */
const capRefusal = (error: unknown): boolean => {
  const fields = error as { code?: unknown; refusal?: unknown } | undefined;
  return fields?.code === SPEND_CAP_REACHED || fields?.refusal === SPEND_CAP_REACHED;
};

/** A route a policy admits: its method, its exact path, and the request headers forwarded with it. */
export interface ProxyRoute {
  readonly method: string;
  readonly path: string;
  /** Exact query strings it admits besides none (`beta=true`); forwarded as the table has them. */
  readonly query?: readonly string[];
  readonly headers?: readonly string[];
  /** Answered here with this status and an empty body, never forwarded (a client's connectivity check). */
  readonly local?: number;
  /** With `local`: the JSON text it is answered with in place of an empty body (a client's list of models, answered
   *  with the session's own so the provider's list is never asked for), and then only to the session's key or a side
   *  key. */
  readonly localJson?: string;
  /** Not a paid request (a token count): forwarded without asking the runner, and no usage is reported. */
  readonly free?: boolean;
}

/** Token counts a response reports. */
export interface ProxyUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite?: number;
  /** The reasoning tokens of its output, when the response reports them (Responses' output_tokens_details): what the
   *  run has seen its model reason (ReasoningSeen, `ProviderPolicy.outputLeast`). Never booked: `output` has them. */
  reasoning?: number;
  /** `plan`: the policy's route bills a person's subscription plan, not the tokens (ModelUsage.billing). */
  billing?: "plan";
}

/** A provider credential its host can't give now, for good until a person acts (a sign-in signed out or expired): thrown
 *  by `ModelProxyOptions.credential`, its message (words for a person, never a credential) is the request's refusal. */
export class CredentialUnavailable extends Error {}

/** What one provider-native web search costs, in USD, beside the tokens: $10 per 1,000 searches (Anthropic's "Web search tool"
 *  and OpenAI's "Web search (all models)" list the same price). The one figure every fee reads: the proxy policies of the
 *  Claude and Codex harnesses and the runner's hosted search. */
export const NATIVE_SEARCH_USD = 0.01;

/** What a session's model proxy has seen its model reason in this run: the most reasoning tokens one of its answers
 *  reported (ProxyUsage.reasoning), undefined before any answer reported its own. */
export interface ReasoningSeen {
  readonly most?: number;
}

/** What one provider's API may carry through the proxy. */
export interface ProviderPolicy {
  /** A name for messages. */
  readonly id: string;
  readonly routes: readonly ProxyRoute[];
  /** The key the client sent, from its headers ("" when it sent none). */
  keyOf(headers: IncomingHttpHeaders): string;
  /** The headers that carry the provider's credential. */
  authHeaders(credential: string): Record<string, string>;
  /** A listed request header's value as forwarded, or undefined to drop it; a `ProxyRefusal` refuses the request before
   *  the runner is asked (a beta the policy does not know). Default: as sent. */
  header?(name: string, value: string): string | undefined;
  /** The body the provider gets for a request on `route`: throw a `ProxyRefusal` to refuse it. `context.host`: the
   *  request is the host's own, beside the harness's (ModelProxy.sideKey), whose tools are its own client-side ones, not
   *  the session's. A policy that reads something of the host's first (a tool's permission now) answers with a promise,
   *  which may reject the same way. */
  apply(body: unknown, route: ProxyRoute, context?: ProxyRequestContext): Record<string, unknown> | Promise<Record<string, unknown>>;
  /** The usage a completed response reports, if it reports one: from its whole text, or, for a long one, its first and
   *  last 64 KiB (a provider may report input tokens as a stream starts and output tokens as it ends). `body`: the body
   *  its request was sent with (`apply`'s), so what the request offered (a hosted tool it did not offer never ran) is
   *  read from the request, never guessed from the answer's words. */
  usageOf(text: string, body?: Record<string, unknown>): ProxyUsage | undefined;
  /** Whether the provider stopped a completed answer on its content filter (a refusal), read from its text as `usageOf`
   *  reads it, never by matching its words, and from `lineStarts`, the start of each of its last whole lines (16 KiB of
   *  each, for a line longer than the text kept). Absent: the policy cannot tell, and no answer is read as stopped. */
  filtered?(text: string, lineStarts: readonly string[]): boolean;
  /** Whether the provider cut an answer at its output limit (stopReason "length"), read as `filtered` reads its stop, with
   *  the output tokens the answer reports when it says them. Absent: the policy cannot tell, and no answer is read as cut. */
  cut?(text: string, lineStarts: readonly string[]): { outputTokens?: number } | undefined;
  /** Whether a request is the turn's answer request (the client's own turn, which offers the model the session's tools),
   *  and not a side call its client makes beside the turn (a title, a summary): only an answer request's content-filter
   *  stop ends the turn; a side call's is logged and left to the client. Absent: every request is the turn's. */
  answers?(body: Record<string, unknown>): boolean;
  /** Called once for each request the proxy forwards that the provider answers, as the answer starts. Requests overlap (a
   *  client's background calls run beside its turn), so what it keeps is for the sink to tell apart: each call returns its own
   *  observer. The observer is given each piece of the answer as text, BEFORE that piece is written to the client, so what it
   *  saw of an answer, the client has not yet acted on: the one thing the proxy can say causally about what a client does
   *  next. `end` is called when the answer is over, however it ended. It only reads; one that throws is reported, `failed` is
   *  called (the answer was not watched to its end) and the answer goes on. A `watch` must not throw after it has told its
   *  sink the answer started (its sink counts open answers, and only `end` closes one): do that last. */
  watch?(): { chunk(text: string): void; failed?(): void; end?(): void } | undefined;
  /** Called when `watch` threw: this answer is not watched, so nothing the policy knew of an earlier one may stand for it. */
  unwatched?(): void;
  /** The model the body `apply` returned asks for, once `apply` checked it is one this session may use (its own, or a
   *  smaller one for a client's background calls). The runner is asked about, and the price taken for, that model.
   *  Absent, or undefined for a body: the session's model. */
  modelOf?(body: Record<string, unknown>): string | undefined;
  /** The input tokens the provider bills for the body `apply` returned beyond its bytes: a prompt it adds itself, such as
   *  a tool-use system prompt, and each image at what it is billed as in place of the bytes its data takes in the body
   *  (`providerInputOverhead`), which can make it less than 0. Added to the body's bytes for `inputTokensMax`; the sum
   *  below 0 is no bound (unmeasured). Undefined: the body has no input bound the policy can state (a hosted tool that
   *  reads pages into the input), so `inputTokensMax` is undefined, never 0 or the body's bytes alone. Absent: none. */
  serverInputOverhead?(body: Record<string, unknown>): number | undefined;
  /** What the body `apply` returned may charge beside its tokens at most, in USD: a hosted tool's per-use fees, at the
   *  most uses the body allows it. Held with its tokens (ProxyRequest.feeUsd), so a cap reserves the fees before the
   *  request leaves, not only once its answer reports them. A figure that is not finite (the body allows its tool any
   *  number of uses), or a throw: the request's worst case is unknown, as an unmeasured input's is. Absent: none. */
  feeMaxUsd?(body: Record<string, unknown>): number;
  /** The output tokens the body `apply` returned asks for at most (its own limit, as `apply` shaped it). Absent or
   *  undefined: the body does not say. */
  outputAsked?(body: Record<string, unknown>): number | undefined;
  /** The provider's own count of a request's input tokens (Anthropic's free count_tokens), which the proxy asks before
   *  each of the session's answer requests (`countedInputOf`) when its upstream is exactly `origin`, the provider's own: never
   *  through a gateway or any other base, so the key and the request go nowhere the request itself would not. Its count,
   *  plus `margin`, is that request's input bound when it is below the byte bound. Absent: never counted. */
  countInput?: InputCounter;
  /** A local count of the body `apply` returned, its margin included (`responsesLocalInputTokens`), for a request the
   *  provider did not count: no `countInput`, an upstream that is not its origin (a gateway), a side or host request, or a
   *  count that failed or said none. That request's input bound when it is below the byte bound. Undefined: the body has
   *  no local count (a model whose tokenizer the policy does not have), and keeps its byte bound. Absent: never counted. */
  countInputLocally?(body: Record<string, unknown>): Promise<number | undefined> | number | undefined;
  /** The most input tokens the body `apply` returned can be billed for, from `earlier`, the session's last request on
   *  the same model whose answer reported what its whole input billed (`messagesInputAfter`, `responsesInputAfter`): for a request the provider
   *  did not count, its input bound when it is below its other bounds. Undefined: the earlier request says nothing of this
   *  one (they differ in more than what this one adds). Absent: never used. */
  inputAfter?(earlier: BilledRequest, body: Record<string, unknown>): number | undefined;
  /** The least output the body may be limited to and still answer: 1,024 tokens for the answer, plus the least thinking
   *  its provider takes when it thinks. Absent: 1,024. `seen`: what the session's model has reasoned in this run, given for
   *  a request on it (ReasoningSeen.most). */
  outputLeast?(body: Record<string, unknown>, seen?: ReasoningSeen): number;
  /** The reasoning effort the body asks its model at, as its provider names it (Responses' `reasoning.effort`,
   *  Messages' `output_config.effort`): what `outputLeast` read it at, handed to the host beside it (ProxyRequest.effort).
   *  Absent, or undefined for a body: it names none. */
  effortOf?(body: Record<string, unknown>): string | undefined;
  /** The reasoning tokens the body's request may bill that its response does not stream (a provider that streams only a
   *  summary of its reasoning, or none): its effort's or its thinking's budget, else its output limit when it reasons at
   *  an effort the body does not say. A stopped request counts them beside what streamed. Absent or 0: none. */
  reasoningHidden?(body: Record<string, unknown>): number | undefined;
  /** The bytes of reasoning one whole server-sent event of the response carries (a reasoning summary's or a thinking
   *  delta's text, UTF-8), 0 for any other event. A stopped request subtracts what reached its client from the budget
   *  `reasoningHidden` reads, so reasoning that streamed is not counted twice, and answer text never stands in for it. */
  reasoningBytesOf?(event: string): number;
  /** The bytes of content one whole server-sent event of the response carries: its text, reasoning and tool-call
   *  arguments, UTF-8, never the framing around them (ids, indexes, sequence numbers). A stopped request counts what of
   *  this reached its client, as pi counts the blocks it streamed. Absent: the bytes as sent. */
  contentBytesOf?(event: string): number;
  /** The body `apply` returned with its output limited to `max` tokens, thinking included (what is left of a spend cap
   *  can buy): never more than it asked for, and never longer as sent, since its input bound was measured on it. A host
   *  that limits a request's output needs it: without it such a request is refused, never sent unlimited. */
  limitOutput?(body: Record<string, unknown>, max: number): Record<string, unknown>;
  /** `body` with `text` added as a note the provider reads after everything the client sent (the spend cap's wrap-up),
   *  carrying no cache marker of its own, so the prefix the client built, and cached, stays byte for byte as sent. Absent:
   *  the policy cannot place one, and a note waits for a request whose policy can. */
  addNote?(body: Record<string, unknown>, text: string): Record<string, unknown>;
  /** The status a request the runner refused gets: one the client does not retry. Default 400. */
  readonly refusedStatus?: number;
  /** An error answer of the provider's that no retry can mend (a subscription plan's limit reached), read from its status
   *  and its body: the words and code its client is answered with instead, at `refusedStatus`, so the client never asks
   *  again and its run ends in those words. Undefined: the provider's answer goes through as it came. */
  finalError?(status: number, body: string): { message: string; code: string } | undefined;
}

export interface ModelUsageReport extends ProxyUsage {
  /** The provider's (or its gateway's) own figure when the response gave one (`reportedCostOf`); else the price table's,
   *  `estimated`; null when neither is known. */
  usd: number | null;
  estimated?: boolean;
  /** Beside a reported figure, what the price table makes of the same usage: kept to audit the table. */
  tableUsd?: number | null;
  /** The ids the response's headers gave it (`providerIdsOf`), when they came. */
  providerIds?: Record<string, string>;
  /** A response its client left before its end (a stop), with what of it the client was sent: the content of its events
   *  (text, reasoning, tool arguments, UTF-8 bytes) where the policy reads it (`contentBytesOf`), else the bytes as sent.
   *  Not set for one the provider ended early (an error part way), nor for one the client read whole. */
  stoppedAfterBytes?: number;
  /** A stopped response's reasoning budget, as the policy reads it from the body (`reasoningHidden`): reasoning that
   *  streams only as a summary, or not at all. Set only with `stoppedAfterBytes`, and only when above 0. */
  stoppedHiddenTokens?: number;
  /** The bytes of reasoning the client was sent of a stopped response (its summary or thinking deltas, by the policy's
   *  `reasoningBytesOf`), set with `stoppedHiddenTokens`. The host counts the budget less these, max(0, budget - these),
   *  beside `stoppedAfterBytes`. */
  stoppedReasoningBytes?: number;
}

/** The longest a response's text may run with no event boundary before the reasoning count lets it go (a body that is
 *  not a stream of events, read whole as one). */
const EVENT_MAX_CHARS = 1 << 22;

/** What of a response reached its client, event by event: each whole server-sent event (up to a blank line) read by
 *  each of `readers`, its bytes added to that reader's sum; a reader the policy does not have counts none. */
/** What a secret this proxy sent reads as in a provider's error the harness gets. */
export const REDACTED = "[redacted]";

/** The forms a provider may echo `secrets` in: as sent, JSON-escaped, with "/" escaped as "\/" (some JSON encoders do), and
 *  both at once, the longest first, so a form that holds a shorter one is cut whole. */
export function echoForms(secrets: readonly string[]): string[] {
  const slashed = (text: string) => text.replaceAll("/", "\\/");
  const forms = secrets.filter((secret) => secret.length > 0).flatMap((secret) => {
    const escaped = JSON.stringify(secret).slice(1, -1);
    return [secret, escaped, slashed(secret), slashed(escaped)];
  });
  return [...new Set(forms)].sort((a, b) => b.length - a.length);
}

/** The most of an error the cut holds back while the host's redactor may still be reading a value it knows across the
 *  pieces: no secret it holds is longer. */
export const REDACT_WINDOW = 4096;
/** The most of an event the relay holds while it cannot yet tell whether the event is an error's: past it, the event is
 *  told from what came of it, and nothing of it is held whole. */
export const EVENT_HOLD = 64 * 1024;
/** The names, and data types, an error event has: Messages' and Responses' `error`, Responses' `response.failed`. */
const ERROR_TYPES: ReadonlySet<string> = new Set(["error", "response.failed"]);
/** A data line's JSON whose type comes first, as most providers write it: its type, readable before the line ends. */
const TYPE_FIRST = /^\s*\{\s*"type"\s*:\s*"([^"]*)"/;
/** Whether a UTF-16 code unit is the second half of a character written as two. */
const isLowSurrogate = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff;
/** The shortest form a healthy event is cut of: a shorter one (a test's one-letter credential) matches its text by chance,
 *  and cutting it there breaks the answer. An error is cut of every form. */
const MIN_ECHO = 8;
/** What may stand beside a short value inside a token of its own: past one of these, it is part of a longer word. */
const WORD_CHAR = /[A-Za-z0-9_-]/;
/** A line's end in an event stream: LF, CRLF or a bare CR, as the format has them. */
const LINE_END = /\r\n|\r|\n/;
/** The next line end of a piece, searched from `lastIndex`. */
const LINE_BREAK = /\r\n|\r|\n/g;

/**
 * What the harness gets of a provider's answer: as it came, but for the provider's own words in an error, where a secret
 * this proxy sent (`forms`, echoForms) is cut out and then the host's `redact` runs.
 *   - `error` (an answer with an error status): cut as it comes. What goes out is what can no longer change: the end that
 *     could still begin a form is held, and, with a host redactor, the last REDACT_WINDOW characters too, so a value it
 *     knows is never split between two of its readings. An error body the provider never finishes still reaches the
 *     client as it comes, past what is held. The body's end is cut, and a start of a form it ends on is cut too.
 *   - `events` (a successful streamed answer): each event is told from its fields, whatever their order: an `event:` name
 *     of an error, or its data's JSON (a type of `error` or `response.failed`, or an `error`), an `id:`, `retry:` or
 *     comment line read past; a healthy name exempts nothing, its data is still read. An error event is cut as an error
 *     answer is, as it comes; every other event has the credential's forms of MIN_ECHO characters or more cut and passes
 *     otherwise byte for byte, only
 *     the start of a form held back (never past a line end). An event is held only until it can be told (an error's
 *     name, or its data line whole), and at most EVENT_HOLD of it: past that it is told from what came (a data line whose
 *     type comes first), and one that still cannot be is cut as an error's. Nothing a healthy event sent is kept.
 *   - `as-is`: every piece as it came.
 * `tokens` (the forms of values too short to tell from text by chance) are cut in an error alone, and only as a whole
 * token: in an error body anywhere, in an error event only inside a data line's value, never a field's name.
 * A `redact` that throws leaves the cut, and is said.
 */
export function errorCut(mode: "error" | "events" | "as-is", forms: readonly string[], redact: ((text: string) => string) | undefined, say: (message: string) => void, tokens: readonly string[] = []): { push(text: string): string; end(): string } {
  /** `text` with every one of `of` cut out. */
  const cutOf = (of: readonly string[], text: string): string => of.reduce((out, form) => out.split(form).join(REDACTED), text);
  /** `text` with each of `tokens` (short values' forms, longest first) cut where it stands as a whole token: no letter,
   *  digit, "_" or "-" beside it, and, in an event stream, inside a data line's value, never a field's name or another
   *  line. `before` is the character just before `text`, `lineHead` the start of its line that came before it; a token
   *  the text ends on is cut only when `final` (more may follow it), and is otherwise left for the caller to hold. */
  const cutTokens = (text: string, before: string, lineHead: string, final: boolean): string => {
    if (!tokens.some((token) => text.includes(token))) return text;
    let out = "";
    for (let i = 0; i < text.length; ) {
      const hit = tokens.find((token) => {
        if (!text.startsWith(token, i)) return false;
        const end = i + token.length;
        if (end === text.length && !final) return false;
        if (WORD_CHAR.test(i > 0 ? text[i - 1]! : before) || WORD_CHAR.test(text[end] ?? "")) return false;
        if (mode !== "events") return true;
        const lineAt = Math.max(text.lastIndexOf("\n", i - 1), text.lastIndexOf("\r", i - 1));
        return (i > 0 && lineAt >= 0 ? text.slice(lineAt + 1, i) : lineHead + text.slice(0, i)).startsWith("data:");
      });
      if (hit) {
        out += REDACTED;
        i += hit.length;
      } else {
        out += text[i];
        i += 1;
      }
    }
    return out;
  };
  const cut = (text: string): string => cutOf(forms, text);
  /** The forms a healthy event is cut of: those long enough not to match its text by chance. */
  const healthyForms = forms.filter((form) => form.length >= MIN_ECHO);
  const redacted = (text: string): string => {
    if (!text || !redact) return text;
    try {
      return redact(text);
    } catch (error) {
      say(`the host's redactor threw (${String((error as Error)?.message ?? error).slice(0, 200)}): the error is sent with the proxy's own cut only`);
      return text;
    }
  };
  if (mode === "as-is" || !forms.length && !tokens.length && !redact) return { push: (text) => text, end: () => "" };
  /** The length of the longest end of `text` that is a proper start of one of `of` (default every form). */
  const startOfForm = (text: string, of: readonly string[] = forms): number => {
    let longest = 0;
    for (const form of of) for (let n = Math.min(form.length - 1, text.length); n > longest; n--) if (text.endsWith(form.slice(0, n))) longest = n;
    return longest;
  };
  /** An error's text cut as it comes: all that came, cut and redacted again each time (both leave cut text as it is), less
   *  the end that could still change: the start of a form, and with a host redactor the last REDACT_WINDOW characters.
   *  `host` false: a healthy event's, cut of healthyForms alone, holding back only the start of one. */
  const cutter = (host = true) => {
    const of = host ? forms : healthyForms;
    const startOf = (text: string) => startOfForm(text, of);
    /** The longest end of `text` that is a short value's token, or the start of one, not yet told whole (host only). */
    const tokenEnd = (text: string): number => {
      if (!host) return 0;
      let longest = 0;
      for (const token of tokens) for (let n = Math.min(token.length, text.length); n > longest; n--) if (text.endsWith(token.slice(0, n))) longest = n;
      return longest;
    };
    let held = "";
    // What came out before `held`: its last character, and the start of the line it ends on (a data line's "data:").
    let before = "";
    let lineHead = "";
    const sent = (out: string): string => {
      if (!out) return out;
      before = out.at(-1)!;
      const lineAt = Math.max(out.lastIndexOf("\n"), out.lastIndexOf("\r"));
      lineHead = (lineAt >= 0 ? out.slice(lineAt + 1) : lineHead + out).slice(0, 8);
      return out;
    };
    return {
      push(text: string): string {
        const all = host ? redacted(cutTokens(cut(held + text), before, lineHead, false)) : cutOf(of, held + text);
        let at = all.length - Math.min(all.length, Math.max(startOf(all), tokenEnd(all), host && redact ? REDACT_WINDOW : 0));
        // Never between the two UTF-16 halves of a character: each half written alone is two U+FFFD to the client.
        if (at > 0 && at < all.length && isLowSurrogate(all.charCodeAt(at))) at -= 1;
        held = all.slice(at);
        return sent(all.slice(0, at));
      },
      end(): string {
        const rest = host ? cutTokens(held, before, lineHead, true) : held;
        held = "";
        // Text that ends on the start of a form ends on part of a secret: cut too.
        const part = startOf(rest);
        return part ? `${rest.slice(0, rest.length - part)}${REDACTED}` : rest;
      },
    };
  };
  if (mode === "error") return cutter();

  /** An event's field lines, `id:`, `retry:`, comments and unknown fields read past: its name, and its data's lines. */
  const fieldsOf = (lines: readonly string[]): { name?: string; data: string[] } => {
    const out: { name?: string; data: string[] } = { data: [] };
    for (const line of lines) {
      if (!line || line.startsWith(":")) continue;
      const at = line.indexOf(":");
      const field = at === -1 ? line : line.slice(0, at);
      const value = at === -1 ? "" : line.slice(at + 1).replace(/^ /, "");
      if (field === "event") out.name = value.trim();
      else if (field === "data") out.data.push(value);
    }
    return out;
  };
  /** Whether a data payload is an error's: its JSON's type is one, or it carries an `error`. Undefined when it does not
   *  read as JSON (yet). */
  const dataSays = (data: string): "error" | "raw" | undefined => {
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      return undefined;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) return "raw";
    const json = value as Record<string, unknown>;
    return (typeof json.type === "string" && ERROR_TYPES.has(json.type)) || (json.error !== undefined && json.error !== null) ? "error" : "raw";
  };
  /** What an event not yet whole is, from its whole lines (`whole`) and the line still coming (`part`), if it can be told:
   *  an error's name, else its first data line once that reads (a healthy name exempts nothing: its data may still be an
   *  error's); past EVENT_HOLD, from a data line whose type comes first, else an error's (a data line that cannot be told
   *  is cut) or a healthy event's (no data yet). */
  const verdict = (whole: readonly string[], part: string, held: number): "error" | "raw" | undefined => {
    const fields = fieldsOf(whole);
    if (fields.name !== undefined && ERROR_TYPES.has(fields.name)) return "error";
    for (const data of fields.data) {
      const said = dataSays(data);
      if (said) return said;
    }
    if (held <= EVENT_HOLD) return undefined;
    const coming = part;
    if (coming.startsWith("data:")) {
      const type = TYPE_FIRST.exec(coming.slice(5))?.[1];
      return type === undefined ? "error" : ERROR_TYPES.has(type) ? "error" : "raw";
    }
    return fields.data.length ? "error" : "raw";
  };
  /** A whole event that was never told: an error's when its name or its data says so, or it holds a form long enough to
   *  be told from its text. */
  const wholeIsError = (event: string): boolean => {
    const fields = fieldsOf(event.split(LINE_END));
    if (fields.name !== undefined && ERROR_TYPES.has(fields.name)) return true;
    if (fields.data.length && dataSays(fields.data.join("\n")) === "error") return true;
    return healthyForms.some((form) => event.includes(form));
  };

  /** The event's state: `hold` until it can be told (its text so far in `held`, at most EVENT_HOLD and a piece), then
   *  `raw` (passed as it comes with the credential's forms cut, only the start of a form held back) or `error` (cut as it
   *  comes, the host's redactor too). `lineChars`: the characters of the line coming, for telling a blank line, which ends
   *  the event; nothing a raw event sent is kept. */
  let state: "hold" | "raw" | "error" = "hold";
  let held = "";
  let lineChars = 0;
  let eventCutter: ReturnType<typeof cutter> | undefined;
  const decide = (to: "error" | "raw"): string => {
    const text = held;
    held = "";
    state = to;
    eventCutter = cutter(to === "error");
    return eventCutter.push(text);
  };
  const eventEnds = (): string => {
    const out = state === "hold" ? (wholeIsError(held) ? redacted(cutTokens(cut(held), "", "", true)) : cutOf(healthyForms, held)) : eventCutter!.end();
    state = "hold";
    held = "";
    eventCutter = undefined;
    return out;
  };
  /** Whether the last piece ended on a CR: its line ended there, and a LF that begins the next piece is that CR's (a CRLF
   *  split between pieces), not a line of its own. */
  let afterCr = false;
  const feed = (piece: string): string => {
    if (state !== "hold") return eventCutter!.push(piece);
    held += piece;
    return "";
  };
  return {
    push(text) {
      let out = "";
      let at = 0;
      if (afterCr && text.startsWith("\n")) {
        // The rest of a line end that came already: a blank line's goes out with the event it ended; any other's is the
        // event's, as it is now.
        out += state === "hold" && !held ? "\n" : feed("\n");
        at = 1;
      }
      afterCr = false;
      while (at < text.length) {
        // A line ends at LF, CRLF or a bare CR, as the format has them; a CR that ends the piece ends its line now.
        LINE_BREAK.lastIndex = at;
        const found = LINE_BREAK.exec(text);
        let end = -1;
        let content = text.length - at;
        if (found) {
          content = found.index - at;
          end = found.index + found[0].length;
          if (found[0] === "\r" && end === text.length) afterCr = true;
        }
        const piece = end === -1 ? text.slice(at) : text.slice(at, end);
        at += piece.length;
        lineChars += content;
        out += feed(piece);
        if (end !== -1) {
          const blank = lineChars === 0;
          lineChars = 0;
          if (blank) {
            out += eventEnds();
            continue;
          }
        }
        if (state === "hold" && (end !== -1 || held.length > EVENT_HOLD)) {
          const lines = held.split(LINE_END);
          const part = lines.pop() ?? "";
          const told = verdict(lines, part, held.length);
          if (told) out += decide(told);
        }
      }
      return out;
    },
    end() {
      return eventEnds();
    },
  };
}

/** A whole server-sent event, as the format reads one
 *  (https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation): `text`, its lines as they
 *  came joined with a line feed (whatever ended them), and `data`, its `data:` lines' values (the one space after the
 *  colon dropped), which the format joins with a line feed. An event longer than its reader's limit has no text and no
 *  data: it is read past whole, never in part. */
export interface StreamEvent {
  text?: string;
  data: string[];
}

/** Reads a stream's whole events from its pieces as they come: lines end in LF, CRLF or a bare CR (a CRLF split between
 *  two pieces is one line end), and a blank line ends an event, never a line alone, so an event whose data spans several
 *  lines, or several pieces part way through a line, is read once it is whole. `max`: the most of an event kept. */
export function eventReader(max: number): { push(text: string): StreamEvent[] } {
  const breaks = /\r\n|\r|\n/g;
  /** The event's whole lines, and their length with their line ends (past `max`: Infinity, and its lines dropped). */
  let lines: string[] = [];
  let size = 0;
  /** The line coming: what of it is kept, and its length, which tells a blank line. */
  let line = "";
  let lineChars = 0;
  /** That the last piece ended on a CR: a LF the next one begins with is that CR's line end, not a line of its own. */
  let afterCr = false;
  const ended = (): StreamEvent | undefined => {
    const blank = lineChars === 0;
    if (!blank && size !== Infinity) {
      lines.push(line);
      size += line.length + 1;
    }
    line = "";
    lineChars = 0;
    if (!blank) return undefined;
    const event = size === Infinity ? { data: [] } : lines.length ? { text: lines.join("\n"), data: lines.filter((each) => each.startsWith("data:")).map((each) => each.slice(5).replace(/^ /, "")) } : undefined;
    lines = [];
    size = 0;
    return event;
  };
  return {
    push(text) {
      const out: StreamEvent[] = [];
      let at = afterCr && text.startsWith("\n") ? 1 : 0;
      afterCr = false;
      while (at < text.length) {
        breaks.lastIndex = at;
        const found = breaks.exec(text);
        const end = found ? found.index : text.length;
        lineChars += end - at;
        if (size !== Infinity) {
          line += text.slice(at, end);
          if (size + line.length > max) {
            size = Infinity;
            lines = [];
            line = "";
          }
        }
        if (!found) break;
        at = end + found[0].length;
        if (found[0] === "\r" && at === text.length) afterCr = true;
        const event = ended();
        if (event) out.push(event);
      }
      return out;
    },
  };
}

function eventCounter<K extends string>(readers: Record<K, ((event: string) => number) | undefined>): { push(text: string): void; bytes(of: K): number } {
  const keys = (Object.keys(readers) as K[]).filter((key) => readers[key] !== undefined);
  const sums = Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
  const events = eventReader(EVENT_MAX_CHARS);
  return {
    push(text) {
      if (!keys.length) return;
      for (const event of events.push(text)) {
        if (event.text === undefined) continue;
        for (const key of keys) {
          try {
            const n = readers[key]!(event.text);
            if (typeof n === "number" && Number.isFinite(n) && n > 0) sums[key] += n;
          } catch {
            // An event the policy cannot read carries nothing it counts.
          }
        }
      }
    },
    bytes: (of) => sums[of] ?? 0,
  };
}

/** A paid request as the host is asked about it, before it leaves. */
export interface ProxyRequest {
  model: string;
  /** The most input tokens it can be billed for (see `inputTokensMaxOf`), undefined when that could not be measured. */
  inputTokensMax?: number;
  /** The most output tokens it asks for (the policy's `outputAsked`), when the body says. */
  outputTokensAsked?: number;
  /** The least output it may be limited to and still answer (the policy's `outputLeast`). */
  outputTokensLeast?: number;
  /** The reasoning effort its body names (the policy's `effortOf`), when it names one. */
  effort?: string;
  /** What it may charge beside its tokens at most (the policy's `feeMaxUsd`), in USD: held with them. */
  feeUsd?: number;
  /** A side call, never its turn's own: on another model than the session's (a client's small-model call: a title, a
   *  summary), or the host's own request beside the harness's (`host`). */
  side?: true;
  /** On the session's model but no answer of the turn (the policy's `answers` reads it so: a title, a summary, a child's
   *  request). Still the turn's to book, but no answer the host keeps its wrap-up's reserve back for. */
  unanswered?: true;
  /** It carries the host's note (`ModelProxyHooks.note`), placed in its body: the host's to record once it is answered. */
  noted?: true;
  /** The label of the side key it came under (ModelProxy.sideKey): the host's own request, beside the harness's. */
  host?: string;
  /** The conversation its client says it is asked in (CONVERSATION_HEADER), when it names one: its client's own label. */
  conversation?: string;
  /** Aborted when its client goes before it is admitted (ModelRequest.signal): a wait for room ends then. */
  signal?: AbortSignal;
}

export interface ModelProxyHooks {
  /** Before a paid request leaves; a throw refuses it. What it returns (a ticket) is handed back to this request's
   *  `afterRequest`, since requests may be in flight together. A ticket's `outputTokensMax` limits the request's output
   *  (thinking included) to that many tokens, written into its body by the policy's `limitOutput` before it is sent. */
  beforeRequest(request: ProxyRequest): Promise<unknown>;
  /** When a request's response has completed, with its usage, the ticket its `beforeRequest` returned, and how it ended
   *  (booking.ts), which the runner books it by: one rule for every path. */
  afterRequest(usage: ModelUsageReport, ticket?: unknown, ended?: Ended): Promise<void>;
  /** When a paid request's response headers arrive, before its body: the ids they give it (`providerIdsOf`), so a
   *  request a crash cuts off after this point is known to have reached the provider, under those ids. */
  responded?(ids: Record<string, string>, ticket?: unknown): Promise<void>;
  /** A note the host has for the session's next main-model request (the spend cap's wrap-up), taken by this call: the
   *  proxy asks only for a paid request on the session's model whose policy can place one (`addNote`), with that request
   *  as its client sent it (NoteRequest: its input bound and output asks, measured before the note is placed). */
  note?(model: string, request?: NoteRequest): string | undefined;
  /** The note `note` gave back (ModelPort.noteReturned): the request that took it left before `beforeRequest`. */
  noteReturned?(note: string): void;
}

export interface ModelProxyOptions {
  policy: ProviderPolicy;
  hooks: ModelProxyHooks;
  /** The session's turn budget (the harness's ResultBudget.turn): each answer of the turn's (ProviderPolicy.answers, the
   *  harness's own, never the host's) opens it with its facts, the input tokens its request held (the provider's usage,
   *  cached input included, else the request's input bound), its output, and the client tool calls it made, read from its
   *  stream. A tool call waits while an answer is read (TurnBudget.ready), so its result is never bound on the turn before. */
  turn?: TurnBudget;
  /** The session's model, as the runner names it to `beforeRequest`. The policy fixes the body's model. */
  model: string;
  /** This proxy's route among the session's, told to `beforeRequest` with each request (ModelRequest.route) so the host
   *  prices it at this proxy's price: a proxy beside the session's for another tier's model names its tier. Absent: the
   *  session's own. */
  route?: string;
  /** The provider's base: its origin and, for a gateway that serves the API under a path, that path
   *  (`https://api.example.com`, `https://gateway.example/api`). A route's path is appended to it. A base with userinfo, a
   *  query or a fragment is refused, so the key goes only where the base reads. */
  origin: string;
  /** The provider's credential, read for each request. */
  credential: () => string | Promise<string>;
  /** The host's redactor, for a provider's own words in an error (an answer with an error status, or an error event inside
   *  a streamed answer): the harness keeps them, so they pass through it. Before it, and whatever it does, the credential
   *  this proxy sent and the values of the headers it added are cut out of them (a provider echoes a wrong key back):
   *  the harness never holds the provider's credential. */
  redact?: (text: string) => string;
  /** The price of a response, or null when it is unknown. */
  price?: (model: string, usage: ProxyUsage) => number | null;
  log?: (message: string, detail?: Record<string, unknown>) => void;
  /** Told each forwarded request's route and the provider's status once it answers: what a route does on this
   *  provider (a free route it may not serve), as a status code only, never a body or a key. */
  onResponse?: (response: { method: string; path: string; free: boolean; status: number }) => void;
  /** Told the credential a request was sent with when the provider answered 401 to it, so a host whose credential
   *  renews (a sign-in's token) can renew it before the next request. Never logged. */
  credentialRefused?: (credential: string) => void | Promise<void>;
  /** Headers the host adds to every request it forwards (a gateway's spend tags, LiteLLM's `x-litellm-tags`, say):
   *  after the client's, so the client can neither set nor override them, and before the credential's. Checked when the
   *  proxy starts (`hostHeaderProblems`). */
  headers?: Readonly<Record<string, string>>;
  /** The fetch the proxy forwards with: the host's route for a model it translates onto the wire (a test's recorder,
   *  too); absent, the network. Each request's init carries `heard` (ProviderHeard), for a route that holds back what its
   *  provider sends. */
  fetch?: typeof fetch;
  /** Told, with CONTENT_FILTERED, once an answer the provider stopped on its content filter has been passed and booked
   *  (`ProviderPolicy.filtered`): the harness halts the turn with it, before its client asks for the answer again. */
  onFiltered?: (message: string) => void;
  /** Told, once an answer request's answer, once its stop says the provider cut it at its output limit
   *  (`ProviderPolicy.cut`), before its client has the piece that carries the stop: a harness whose client would ask for
   *  the answer again (Codex retries an incomplete stream) ends the turn there, the answer cut ("length"). `capCut`: the
   *  request went with less output than it asked, limited to what the run's cap left (ModelTicket.capCut), so the cut is
   *  the cap's, never a normal answer: the cap, and the least cap that sends it whole. */
  onCut?: (stop: { outputTokens?: number; capCut?: CapCut }) => void;
  /** Told, with its words and code, once the provider's error answer is one no retry mends (`ProviderPolicy.finalError`:
   *  a plan's limit reached), or once the proxy stopped an answer request the provider sent nothing on for `stallMs`
   *  (MODEL_STALLED), as its client is answered those words: the harness ends the turn in them. Given, the turn's next
   *  answer request after a stall is refused until the harness opens its next turn. */
  onFinal?: (message: string, code: string) => void;
  /** How long a forwarded request may go with nothing from the provider, before its answer begins or between two pieces
   *  of it, before this proxy stops it (MODEL_STALLED). Default MODEL_STALL_MS. */
  stallMs?: number;
}

/** How long the provider may send nothing on a request before the proxy stops it: 4 minutes, under the 5 minutes Node's
 *  fetch waits for headers and between body pieces, so the proxy, not the transport, ends a stalled request and names
 *  it. A transport's cut reads as "terminated", which every client retries; a stall the proxy names ends the turn. */
export const MODEL_STALL_MS = 240_000;
/** The stall bound for a model on the host's own machine (an Ollama model), which says nothing while it loads or reads a
 *  long prompt: 30 minutes, as long as the CLIs wait on one (their LOCAL_STREAM_IDLE_MS). Its route's own fetch must not
 *  cut it sooner. */
export const LOCAL_MODEL_STALL_MS = 30 * 60_000;
/** The code of the proxy's answer to a request it stopped because the provider sent nothing for its stall bound. */
export const MODEL_STALLED = "model_stalled";
/** The words of that answer: none of the words a client takes as worth asking again (a status, "timeout", "terminated"),
 *  so the client ends the turn in them, where a transport's cut would have it ask again. */
export const stalledWords = (ms: number): string => `the model sent nothing for ${Math.round(ms / 1000)} s, so the request was stopped`;
/** That answer as the last event of a stream already begun, an error to a client of either API: Messages' `error` event
 *  reads its `error` object, Responses' `error` event its `code` and `message`. */
const stalledEvent = (words: string): string =>
  `event: error\ndata: ${JSON.stringify({ type: "error", code: MODEL_STALLED, message: words, error: { type: "agentrun_proxy", code: MODEL_STALLED, message: words } })}\n\n`;

/** What closes the event a client was left in, from the last characters it was written (`sentEnd`), so an event of the
 *  proxy's own after it is read as one of its own: nothing between two events (or before any), the blank line after an
 *  event's whole lines, and a line end and the blank line inside a line. The relay (errorCut) passes a healthy event's
 *  lines as they come, so a stall can leave the client after a data line, or inside one. */
const eventClose = (sentEnd: string): string =>
  sentEnd === "" || sentEnd.endsWith("\n\n") || sentEnd.endsWith("\r\n\r\n") || sentEnd.endsWith("\r\r") ? "" : /\r?\n$|\r$/.test(sentEnd) ? "\n" : "\n\n";

/** Called by a host's route (ModelProxyOptions.fetch), given it on the request's init as `heard`, each time its provider
 *  sends something the route holds back from the stream it answers (a thinking block it sends whole at its end, a reply
 *  it reads whole): the proxy's stall bound counts the provider's silence, not the route's. A network fetch never calls
 *  it. */
export type ProviderHeard = () => void;

/** A header a host may not set on forwarded requests: the credential's, the transport's, and the provider's protocol. */
const RESERVED_HEADER = /^(?:authorization|proxy-authorization|x-api-key|host|content-length|content-type|transfer-encoding|connection|cookie|anthropic-.*)$/i;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;

/** What is wrong with headers a host would add to forwarded requests: a name that is not a token or is reserved, a value
 *  an HTTP header cannot carry (a line break or other control character, or a character beyond Latin-1, which the fetch
 *  the proxy forwards with refuses) or over 1 KiB. Empty when they are fine. */
export function hostHeaderProblems(headers: Readonly<Record<string, unknown>> | undefined): string[] {
  const problems: string[] = [];
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (!HEADER_NAME.test(name)) problems.push(`the header name ${JSON.stringify(name.slice(0, 80))} is not a token`);
    else if (RESERVED_HEADER.test(name)) problems.push(`the header ${name} is the proxy's own (credential, transport or protocol), not a host's`);
    if (typeof value !== "string" || /[^\t\x20-\x7e\x80-\xff]/.test(value) || value.length > 1024) problems.push(`the header ${name.slice(0, 80)}'s value must be one line of text an HTTP header can carry (Latin-1, no control characters), at most 1024 characters`);
  }
  return problems;
}

export interface ModelProxy {
  /** The proxy's origin, `http://127.0.0.1:<port>`. */
  readonly url: string;
  /** The key the harness sends, which the proxy admits. */
  readonly key: string;
  /** A key of the host's own for the requests it sends beside the harness's on this session's route (a learned
   *  workflow's model node, `label` "learned_workflow"): one per label, random, minted here and never handed to the
   *  harness. A request under it goes through the same policy, origin, credential, price and hooks as the harness's;
   *  its admission names the label (ModelRequest.host), the policy applies it as the host's (`ProxyRequestContext`),
   *  it is never the turn's answer request (a content-filter stop on it never halts the turn) and never watched. It opens
   *  the model routes only. */
  sideKey(label: string): string;
  /** The harness opened its next turn: once the proxy has told it a turn's answer stopped (onCut, onFiltered), it refuses
   *  the session's answer requests, unsent and unbooked, until this is called. */
  openTurn(): void;
  close(): Promise<void>;
}

/** What a policy is told of the request it applies: the label of the side key it came under (ModelProxy.sideKey), when
 *  it is the host's own request. */
export interface ProxyRequestContext {
  readonly host?: string;
}

const UNSAFE_PATH = /[^A-Za-z0-9/_.\-?=&]|\.\.|\/\/|^[^/]|\?.*\?/;
const MAX_BODY = 32 * 1024 * 1024;
/** How much of a response's start and end the proxy keeps to read its usage from. */
const USAGE_WINDOW = 64 * 1024;

/** The last `"<key>": {...}` object in `text`, parsed: how a policy reads a field of an answer's terminal event when the
 *  event's line was longer than USAGE_WINDOW, so the proxy kept only its end. JSON may put whitespace on either side of
 *  the colon (a Python gateway's `json.dumps` writes `"usage": {`), and the client parses the event whatever its spacing,
 *  so this reads it too: a usage the harness counted is never booked at an unknown cost for its spacing. A key's quoted
 *  name inside a JSON string is escaped (`\"usage\"`), so it never reads as one. Undefined when there is none, or the
 *  last one does not close in `text` or does not parse. */
export function lastObjectOf(text: string, key: string): unknown {
  const marks = new RegExp(`"${key.replace(/[^A-Za-z0-9_]/g, "")}"\\s*:\\s*\\{`, "g");
  let open = -1;
  for (let found = marks.exec(text); found; found = marks.exec(text)) open = found.index + found[0].length - 1;
  if (open < 0) return undefined;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "\"") {
      for (i++; i < text.length && text[i] !== "\""; i++) if (text[i] === "\\") i++;
    } else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        return JSON.parse(text.slice(open, i + 1)) as unknown;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}
/** How long an answer the provider stopped on its content filter is still read after its client left, or the proxy began
 *  to close, so the request is booked at the usage its end reports; past it, it is cut off as any other. */
const FILTERED_DRAIN_MS = 5_000;
/** How much of the start of each line of an answer the proxy keeps, for its last LINE_STARTS whole lines: an event's name
 *  and the first fields of its data, which a stop can be read from when the event's line is longer than either window. */
const LINE_START = 16 * 1024;
const LINE_STARTS = 4;
/** The provider's word on asking again that an error answer passes on to the client (pi-ai's provider retry reads them,
 *  as the OpenAI and Anthropic SDKs do): how long to wait, and whether to retry at all. */
const RETRY_HEADERS = ["retry-after", "retry-after-ms", "x-should-retry"] as const;

/** A response header that names the request: the provider's `request-id` (`x-request-id`), or a gateway's own call id
 *  (LiteLLM's `x-litellm-call-id`, the id its spend log records; `llm_provider-request-id`, the provider's passed on). */
const ID_HEADER = /^(?:[a-z0-9]+[-_])*(?:request|call)[-_]id$/;
/** What an id looks like: nothing else (a cookie, a token, prose) is ever kept. */
const ID_VALUE = /^[A-Za-z0-9_.:-]{1,200}$/;

/** The request header by which a session's client names the conversation a request is asked in: its own label for it,
 *  opaque here. The host is told it with the request (ProxyRequest.conversation), so it knows which of several
 *  conversations asking at once a booking is; it is never forwarded to the provider. */
export const CONVERSATION_HEADER = "x-agentrun-conversation";
/** A conversation's label as CONVERSATION_HEADER carries it: id-shaped (ID_VALUE), else undefined (never sent, never told). */
export function conversationLabel(value: unknown): string | undefined {
  return typeof value === "string" && ID_VALUE.test(value) ? value : undefined;
}

/** The ids a response's headers give its request, by header name, so a run's books can be joined to the provider's (or
 *  a gateway's) request by request; undefined when there are none. Only id-named headers with id-shaped values. */
export function providerIdsOf(headers: Headers): Record<string, string> | undefined {
  const ids: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (ID_HEADER.test(name) && ID_VALUE.test(value)) ids[name] = value;
  });
  return Object.keys(ids).length ? ids : undefined;
}

/** LiteLLM's figures for what a response cost: its own (`x-litellm-response-cost`), and the figure before its discount
 *  and margin (`-original`), which is the same only when both are reported 0. */
const COST_HEADER = "x-litellm-response-cost";
const COST_PARTS = ["x-litellm-response-cost-discount-amount", "x-litellm-response-cost-margin-amount"] as const;
/** A cost as a gateway writes it: a decimal number, an exponent allowed (`3.7e-06`); nothing else is read as one. */
const COST_VALUE = /^\d{1,9}(?:\.\d{1,30})?(?:[eE][-+]?\d{1,3})?$/;
/** No one request costs this much: a figure above it is not believed. */
const MAX_REQUEST_USD = 1000;

const costOf = (value: string | null): number | undefined => {
  if (value === null || !COST_VALUE.test(value.trim())) return undefined;
  const usd = Number(value.trim());
  return Number.isFinite(usd) && usd > 0 && usd <= MAX_REQUEST_USD ? usd : undefined;
};

/** What a response's headers say it cost, when they say so: LiteLLM's `x-litellm-response-cost`, or its `-original` when
 *  the discount and margin it reports are both exactly 0. Only a positive number counts. A missing, malformed or zero
 *  figure is unknown, never $0: a streamed answer's headers leave before it is priced, and LiteLLM writes 0.0 there. */
export function reportedCostOf(headers: Headers): number | undefined {
  const own = costOf(headers.get(COST_HEADER));
  if (own !== undefined) return own;
  if (!COST_PARTS.every((name) => /^0(?:\.0+)?$/.test(headers.get(name)?.trim() ?? ""))) return undefined;
  return costOf(headers.get(`${COST_HEADER}-original`));
}

/** A cost a provider states in its answer's usage: a number, finite, above 0 and below MAX_REQUEST_USD. */
const usageFigure = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_REQUEST_USD ? value : undefined);

/** The origin a route with its own fetch names (serve's translation to a model that speaks neither API): nothing is ever
 *  sent there, its fetch answers every request, and it writes an answer's cost in its usage only where the provider
 *  stated one (OpenRouter's). */
export const ROUTE_ORIGIN = "https://model-route.invalid";

/** Whether every answer from `origin` states what it cost in its usage's `cost`, in USD (`usageCostOf`): OpenRouter's
 *  (https://openrouter.ai/docs/use-cases/usage-accounting, on every API it serves), and a translation route's
 *  (`ROUTE_ORIGIN`), which passes OpenRouter's figure on. No other origin's usage is read for a cost. */
export function statesUsageCost(origin: string): boolean {
  if (!URL.canParse(origin)) return false;
  const url = new URL(origin);
  return url.hostname === "openrouter.ai" || url.origin === ROUTE_ORIGIN;
}

/** What an answer says it cost in its own usage, when it says so (OpenRouter's usage accounting, on every answer of every
 *  API it serves: https://openrouter.ai/docs/use-cases/usage-accounting): the answer's last `usage` object (a stream's
 *  terminal event, a whole body's own), its `cost` in USD. With the person's own provider key (`is_byok`), `cost` is
 *  OpenRouter's fee alone and the provider's charge is `cost_details.upstream_inference_cost` (or its prompt and
 *  completion parts): the two together, else unknown. Only a positive figure counts, as for a gateway's header
 *  (reportedCostOf): a missing, malformed or zero one is unknown, never $0. */
export function usageCostOf(text: string): number | undefined {
  const usage = lastObjectOf(text, "usage") as { cost?: unknown; is_byok?: unknown; cost_details?: Record<string, unknown> | null } | undefined;
  if (typeof usage !== "object" || usage === null) return undefined;
  const cost = usageFigure(usage.cost);
  if (cost === undefined || usage.is_byok !== true) return cost;
  const details = usage.cost_details;
  if (typeof details !== "object" || details === null) return undefined;
  const part = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);
  const prompt = part(details.upstream_inference_prompt_cost);
  const completion = part(details.upstream_inference_completions_cost);
  const upstream = part(details.upstream_inference_cost) ?? (prompt !== undefined && completion !== undefined ? prompt + completion : undefined);
  return upstream === undefined ? undefined : usageFigure(cost + upstream);
}

/** A provider's error inside a stream it began with a 200: its words, and whether it is a rate limit. */
export type StreamError = { words: string; rateLimit: boolean };

/** A parsed event's error, read from its fields alone, never its words, as each API writes one inside a stream and as
 *  OpenRouter writes one on each API it serves (https://openrouter.ai/docs/api-reference/errors, "Mid-stream errors" and
 *  "Skin-specific error formats"): Messages' `error` event (`error.type` `overloaded_error`, `api_error`,
 *  `rate_limit_error`, ...), Chat Completions' chunk with an `error` object (`code` 429 for a rate limit, its
 *  `metadata.error_type` "rate_limit_exceeded"), Responses' `response.failed` (its `response.error`) or `error` event (its
 *  `code`). A rate limit is told by its fields too. Undefined for an event that is no error. */
function streamErrorIn(event: Record<string, unknown>): StreamError | undefined {
  const response = event.response as { error?: unknown; error_type?: unknown } | undefined;
  const error = (typeof response === "object" && response !== null && typeof response.error === "object" && response.error !== null ? response.error : typeof event.error === "object" && event.error !== null ? event.error : event.type === "error" ? event : undefined) as Record<string, unknown> | undefined;
  if (!error) return undefined;
  const metadata = error.metadata as { error_type?: unknown } | undefined;
  const rateLimit = error.code === 429 || error.code === "rate_limit_exceeded" || error.type === "rate_limit_error" || error.error_type === "rate_limit_exceeded"
    || metadata?.error_type === "rate_limit_exceeded" || event.error_type === "rate_limit_exceeded" || response?.error_type === "rate_limit_exceeded";
  const words = typeof error.message === "string" && error.message ? error.message : rateLimit ? "rate limited" : "the provider ended its answer in an error";
  return { words, rateLimit };
}

/** The provider's error its answer, a stream it began with a 200, ends in: a provider answers 200 once it takes the
 *  request, before the model's first token (OpenRouter; Anthropic's stream too), so an overload, a rate limit or a failure
 *  met after that comes inside the stream, and the status could not say so. Read from the stream's last event that carries
 *  data (`[DONE]` read past), and only that one, parsed: an event whose data is not JSON (words a translation wrote) is
 *  none. Undefined for any other answer, a whole JSON body's included. */
export function streamErrorOf(text: string): StreamError | undefined {
  const events = text.replace(/\r\n|\r/g, "\n").split("\n\n");
  for (let at = events.length - 1; at >= 0; at--) {
    const data = events[at]!.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
    if (!data.trim() || data.trim() === "[DONE]") continue;
    try {
      const event = JSON.parse(data) as unknown;
      return typeof event === "object" && event !== null && !Array.isArray(event) ? streamErrorIn(event as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** The words of a stream's last event that carries data when it is an error event (`event: error`) whose data is words,
 *  not JSON: how a translation sends a failure it cannot read for the provider's error event (serve's model-route
 *  messagesFetch: a provider's error status, a transport error), for its client to throw as the request's error. Never
 *  read for a refusal: what such a failure cost is unknown. Undefined for any other stream. */
export function wordsErrorOf(text: string): string | undefined {
  const events = text.replace(/\r\n|\r/g, "\n").split("\n\n");
  for (let at = events.length - 1; at >= 0; at--) {
    const lines = events[at]!.split("\n");
    const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n").trim();
    if (!data || data === "[DONE]") continue;
    if (!lines.some((line) => /^event:\s*error\s*$/.test(line))) return undefined;
    try {
      JSON.parse(data);
      return undefined;
    } catch {
      return data;
    }
  }
  return undefined;
}

/** Whether a stream shows the model began its output, read from each event's data by its fields, never its words: a
 *  Messages block it opened (`content_block_start`), a Responses output item (`response.output_item.added`) or a
 *  Responses delta with something in it, a Chat Completions chunk whose delta holds content, reasoning, a refusal or a
 *  tool call. Its content need not have streamed: a model's hidden reasoning (a Responses reasoning item) shows none, and
 *  neither does a block a translation held until its end. An empty delta (a first chunk's `content: ""`, the one a
 *  mid-stream error comes in) is no output. */
export function outputBeganIn(text: string): boolean {
  const filled = (value: unknown) => (typeof value === "string" && value.length > 0) || (Array.isArray(value) && value.length > 0);
  for (const raw of text.replace(/\r\n|\r/g, "\n").split("\n\n")) {
    const data = raw.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n").trim();
    if (!data.startsWith("{")) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = event.type;
    if (type === "content_block_start" || type === "response.output_item.added") return true;
    if (typeof type === "string" && type.startsWith("response.") && type.endsWith(".delta") && filled(event.delta)) return true;
    const choices = Array.isArray(event.choices) ? (event.choices as { delta?: Record<string, unknown> }[]) : [];
    if (choices.some((choice) => ["content", "reasoning", "reasoning_content", "reasoning_text", "refusal", "tool_calls"].some((field) => filled(choice?.delta?.[field])))) return true;
  }
  return false;
}

export class ProxyRefusal extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = "ProxyRefusal"; }
}

/** Match a request's method and path text against the routes, never parsing the path as a URL: the route, and the
 *  query it carried, which is one the route lists exactly, or none. */
export function matchRoute(routes: readonly ProxyRoute[], method: string, path: string): { route: ProxyRoute; query: string } {
  if (typeof path !== "string" || path.length === 0 || path.length > 2048 || UNSAFE_PATH.test(path)) throw new ProxyRefusal(403, "the path is not one the table can match");
  const at = path.indexOf("?");
  const pathname = at < 0 ? path : path.slice(0, at);
  const query = at < 0 ? "" : path.slice(at + 1);
  const route = routes.find((r) => r.method === method && r.path === pathname);
  if (!route) throw new ProxyRefusal(403, `${method.slice(0, 16)} ${pathname.slice(0, 128)} is not in the table`);
  if (at >= 0 && !route.query?.includes(query)) throw new ProxyRefusal(403, `the query on ${pathname.slice(0, 128)} is not in the table`);
  return { route, query };
}

/** Parse one JSON value, refusing a duplicate key at any depth and nesting past 64 levels. */
export function parseStrict(text: string): unknown {
  let i = 0;
  const fail = (why: string): never => { throw new ProxyRefusal(400, `the body is not strict JSON: ${why}`); };
  const ws = () => { while (i < text.length && /[ \t\n\r]/.test(text[i]!)) i++; };
  const str = (): string => {
    const start = i;
    i++;
    while (i < text.length && text[i] !== '"') { if (text[i] === "\\") i++; i++; }
    if (text[i] !== '"') fail("an unterminated string");
    i++;
    return JSON.parse(text.slice(start, i)) as string;
  };
  const value = (depth: number): unknown => {
    if (depth > 64) fail("nested too deep");
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      const out: Record<string, unknown> = {};
      const seen = new Set<string>();
      ws();
      if (text[i] === "}") { i++; return out; }
      for (;;) {
        ws();
        if (text[i] !== '"') fail("an object key");
        const key = str();
        if (seen.has(key)) fail(`the key ${JSON.stringify(key).slice(0, 40)} appears twice`);
        seen.add(key);
        ws();
        if (text[i] !== ":") fail("a colon");
        i++;
        // Defined, never assigned: a "__proto__" key is an own field like any other, and the prototype stays put.
        Object.defineProperty(out, key, { value: value(depth + 1), enumerable: true, writable: true, configurable: true });
        ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "}") { i++; return out; }
        fail("an object");
      }
    }
    if (c === "[") {
      i++;
      const out: unknown[] = [];
      ws();
      if (text[i] === "]") { i++; return out; }
      for (;;) {
        out.push(value(depth + 1));
        ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "]") { i++; return out; }
        fail("an array");
      }
    }
    if (c === '"') return str();
    const m = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i));
    if (!m) fail("a value");
    i += m![0].length;
    return JSON.parse(m![0]);
  };
  const out = value(0);
  ws();
  if (i !== text.length) fail("more than one value");
  return out;
}

/** Whether `given` is `key`, in time that does not depend on where they differ. */
export const sameKey = (given: string, key: string): boolean => {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(key).digest();
  return timingSafeEqual(a, b);
};

/** `base` as the proxy joins a route's path to it: its origin and its path, without a trailing slash. */
function baseOf(base: string): string {
  const url = new URL(base);
  // A backslash is a path separator to the URL parser, so it could move the base to a path the text does not read as.
  if (url.username || url.password || url.search || url.hash || base.includes("\\")) throw new Error("agentrun-kernel: a model proxy's base is an origin and a path, with no userinfo, query, fragment or backslash");
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** A provider's endpoint that counts a request's input tokens (ProviderPolicy.countInput). */
export interface InputCounter {
  /** The provider's own base (`https://api.anthropic.com`): counted only when the session's upstream is exactly it. */
  readonly origin: string;
  /** The counting endpoint's path under it (`/v1/messages/count_tokens`). */
  readonly path: string;
  /** The body to count, from the request's (the fields the endpoint takes). */
  body(body: Record<string, unknown>): Record<string, unknown>;
  /** The headers to send it, from the request's as the proxy sends them (its credential and version headers among them). */
  headers(sent: Record<string, string>): Record<string, string>;
  /** The input tokens its answer says, or undefined when it says none. */
  tokensOf(answer: unknown): number | undefined;
  /** What the provider bills beside the count, which the count may leave out (a tool-use system prompt): added to it. */
  margin?(body: Record<string, unknown>): number;
}

/** How long a count may take before the request goes on its byte bound: a count never holds a request up for long. */
export const COUNT_TIMEOUT_MS = 3_000;

/**
 * The exact input tokens of a request with body `body`, by its provider's own count (`policy.countInput`), plus its
 * margin; undefined (the request keeps its byte bound) when the policy has no counter, the upstream `origin` is not
 * the counter's own, or the count fails, times out or says no count. Never throws: a count is only ever a tighter bound.
 */
export async function countedInputOf(policy: ProviderPolicy, origin: string, body: Record<string, unknown>, headers: Record<string, string>, fetch: typeof globalThis.fetch, say: (message: string, detail?: Record<string, unknown>) => void = () => {}, timeoutMs = COUNT_TIMEOUT_MS, signal?: AbortSignal): Promise<number | undefined> {
  const counter = policy.countInput;
  if (!counter) return undefined;
  try {
    if (baseOf(counter.origin) !== origin) return undefined;
    // Cut at its timeout, or when `signal` aborts (its client went).
    const cut = signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs);
    const response = await fetch(`${origin}${counter.path}`, { method: "POST", headers: { ...counter.headers(headers), "content-type": "application/json" }, body: JSON.stringify(counter.body(body)), signal: cut });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      say(`model proxy (${policy.id}): the provider's token count answered ${response.status}; the request keeps its byte bound or its local count`);
      return undefined;
    }
    const tokens = counter.tokensOf(await response.json());
    const margin = counter.margin ? counter.margin(body) : 0;
    if (!Number.isSafeInteger(tokens) || tokens! < 0 || !Number.isSafeInteger(margin) || margin < 0) {
      say(`model proxy (${policy.id}): the provider's token count said no count; the request keeps its byte bound or its local count`);
      return undefined;
    }
    return tokens! + margin;
  } catch (error) {
    say(`model proxy (${policy.id}): the provider's token count failed; the request keeps its byte bound or its local count`, { error: String((error as Error)?.message ?? error).slice(0, 200) });
    return undefined;
  }
}

/**
 * The local count of a request with body `body`, its margin included (`policy.countInputLocally`); undefined (the request
 * keeps its byte bound) when the policy has none, says none for this body, or its count throws or is not a whole number
 * of tokens. Never throws.
 */
export async function localInputOf(policy: ProviderPolicy, body: Record<string, unknown>, say: (message: string, detail?: Record<string, unknown>) => void = () => {}): Promise<number | undefined> {
  if (!policy.countInputLocally) return undefined;
  try {
    const tokens = await policy.countInputLocally(body);
    if (tokens === undefined) return undefined;
    if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error(`not a token count: ${String(tokens).slice(0, 40)}`);
    return tokens;
  } catch (error) {
    say(`model proxy (${policy.id}): the local token count failed; the request keeps its byte bound`, { error: String((error as Error)?.message ?? error).slice(0, 200) });
    return undefined;
  }
}

/** A ticket's `capCut` (ModelTicket.capCut) when it is one: two money figures of 0 or more. */
function capCutOf(value: unknown): CapCut | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { capUsd, raiseToUsd } = value as { capUsd?: unknown; raiseToUsd?: unknown };
  const money = (usd: unknown): usd is number => typeof usd === "number" && Number.isFinite(usd) && usd >= 0;
  return money(capUsd) && money(raiseToUsd) ? { capUsd, raiseToUsd } : undefined;
}

/** Start a session's model proxy on the loopback interface, admitting `key`. */
/**
 * The most input tokens a request with body `sent` (the body `apply` returned, as it is sent) can be billed for: its UTF-8
 * byte count, plus the input the policy says the provider adds that the body does not carry. A provider's tokenizer is a
 * byte-level BPE, whose every token covers at least one byte of what it encodes, so the text the body carries can never
 * be more tokens than bytes, however dense (CJK, emoji, base64). It is not an average of characters per token, which
 * undercounts dense text. Undefined, never 0, when the policy says the body has no bound (its undefined) or its figure
 * cannot be read (a throw, or no count, which is reported): the input is then unmeasured.
 */
export function inputTokensMaxOf(policy: ProviderPolicy, body: Record<string, unknown>, sent: string, say: (message: string, detail?: Record<string, unknown>) => void = () => {}): number | undefined {
  try {
    // Only a policy with no hook adds nothing. A hook's undefined is its word that the body has no bound: unmeasured,
    // never 0, and no failure to report. Anything else that is not a count (null, a throw) is reported, and unmeasured too.
    const overhead: unknown = policy.serverInputOverhead ? policy.serverInputOverhead(body) : 0;
    if (overhead === undefined) return undefined;
    if (typeof overhead !== "number" || !Number.isSafeInteger(overhead)) throw new Error(`not a token count: ${String(overhead).slice(0, 40)}`);
    // Below 0 only by images' data the body carries (counted at what they are billed as instead): never past the bytes.
    const bound = Buffer.byteLength(sent, "utf8") + overhead;
    if (bound < 0) throw new Error(`the policy counted ${-overhead} more bytes as billed apart than the body's ${Buffer.byteLength(sent, "utf8")}`);
    return bound;
  } catch (error) {
    say(`model proxy (${policy.id}): the policy could not say what the provider adds to the body's input; its input is unmeasured`, { error: String((error as Error)?.message ?? error).slice(0, 200) });
    return undefined;
  }
}

export async function startModelProxy(options: ModelProxyOptions, key: string): Promise<ModelProxy> {
  const { policy, hooks, model } = options;
  if (!key) throw new Error("agentrun-kernel: a model proxy needs the session's key");
  const wrongHeaders = hostHeaderProblems(options.headers);
  if (wrongHeaders.length) throw new Error(`agentrun-kernel: ${wrongHeaders.join("; ")}`);
  const hostHeaders = { ...options.headers };
  const forward = options.fetch ?? fetch;
  const origin = baseOf(options.origin);
  /** AgentRun's app attribution, on a proxy whose upstream is OpenRouter's and on no other (openrouter-attribution.ts).
   *  Not the host's headers: no error is cut for echoing its public values. */
  const attribution = onOpenRouter(origin) ? openRouterAttribution() : {};
  /** Whether each answer states what it cost in its usage (`statesUsageCost`): read as the request's reported figure when
   *  no header gave one, the price's figure kept beside it. */
  const costStated = statesUsageCost(origin);
  const refusedStatus = policy.refusedStatus ?? 400;
  const stallMs = options.stallMs ?? MODEL_STALL_MS;
  /** Why the turn's answer stopped, once the harness was told (onCut, onFiltered, onFinal): the session's answer requests are
   *  refused, unsent and unbooked, until it opens its next turn (openTurn). A client that asks again (Codex retries an
   *  incomplete stream) is never paid for, whether or not the harness's own stop beat it. */
  let stopTold: string | undefined;
  const inflight = new Set<AbortController>();
  /** By model, the last request whose answer reported what its whole input billed: the body it was sent with and that
   *  count (`policy.inputAfter` bounds a later request by it). */
  const billed = new Map<string, BilledRequest>();
  /** The most reasoning tokens one answer of the session's model reported in this run (ProxyUsage.reasoning): a later
   *  request's least output is read from it (`policy.outputLeast`). Only the session's own answers, never a side call's or
   *  the host's. */
  let reasoningMost: number | undefined;
  /** The requests whose answer the provider stopped on its content filter, read on for their usage, each until booked. */
  const draining = new Map<AbortController, Promise<void>>();
  /** Set by close(): nothing is admitted or sent after it. */
  let closing = false;
  /** The side keys minted (sideKey), each with its label. */
  const sideKeys = new Map<string, string>();
  /** The label of the side key `sent`, compared in constant time against each minted one; undefined for any other. */
  const sideOf = (sent: string): string | undefined => {
    let found: string | undefined;
    for (const [label, minted] of sideKeys) if (sameKey(sent, minted)) found = label;
    return found;
  };

  /** The host's log, which must never break a request (a throw from it is dropped). */
  const say = (message: string, detail?: Record<string, unknown>) => {
    try { options.log?.(message, detail); } catch { /* the host's log failed; the request goes on */ }
  };
  /** `code`: the refusal's own code, when it has one (the run's spend cap: `spend_cap_reached`), in the body beside the
   *  message, so a reader tells the proxy's refusal by its fields, never by its words. */
  const refuse = (res: ServerResponse, status: number, message: string, req?: IncomingMessage, code?: string) => {
    // Every refusal is reported, so a client that calls something the table does not hold is seen, not silently refused.
    // The client's user-agent names who called: the session's own harness, or another local process that found the port.
    const agent = req?.headers["user-agent"];
    say(`model proxy (${policy.id}): refused`, {
      status, method: String(req?.method ?? "").slice(0, 16), path: String(req?.url ?? "").slice(0, 200), reason: message.slice(0, 200),
      ...(typeof agent === "string" && agent ? { userAgent: agent.slice(0, 120) } : {}),
    });
    res.writeHead(status, { "content-type": "application/json", connection: "close" });
    res.end(JSON.stringify({ error: { message, type: "agentrun_proxy", ...(code ? { code } : {}) } }));
  };

  /** Serves one request. A note it took and did not bring to its admission (it left before `beforeRequest`: a body with
   *  the note that could not be serialized, an error) is given back to the host then, however it left, so the next
   *  request can take it at once. A request is counted before it takes one, so a client that goes while its request is
   *  counted never holds the note. From its admission on the note is the admission's: given back by its refusal, else held by the
   *  request until its end (afterRequest), which tells it if answered and gives it back if not. */
  const serve = async (req: IncomingMessage, res: ServerResponse) => {
    const taken: { note?: string } = {};
    try {
      await serveRequest(req, res, taken);
    } finally {
      if (taken.note !== undefined) {
        const note = taken.note;
        taken.note = undefined;
        try {
          hooks.noteReturned?.(note);
        } catch (error) {
          say(`model proxy (${policy.id}): the host's note could not be given back`, { error: String((error as Error)?.message ?? error).slice(0, 200) });
        }
      }
    }
  };
  const serveRequest = async (req: IncomingMessage, res: ServerResponse, taken: { note?: string }) => {
    // A request refused before its body is read is drained, so its client gets the answer instead of a reset.
    res.once("finish", () => { if (!req.complete) req.resume(); });
    let route: ProxyRoute;
    let query: string;
    try { ({ route, query } = matchRoute(policy.routes, req.method ?? "", req.url ?? "")); } catch (error) {
      // Without the key every request that is not a local route gets the same answer, so the table can't be mapped.
      if (!sameKey(policy.keyOf(req.headers), key)) return refuse(res, 401, "this session's key is required", req);
      const e = error as ProxyRefusal;
      return refuse(res, e.status ?? 403, e.message, req);
    }
    // A local route forwards nothing. One that answers only a status needs no key: a client's connectivity check (the
    // Claude Agent CLI's `HEAD /api/hello`) is sent without one. One that answers a body says something of the session
    // (its model, to Goose's `GET /v1/models`), so it takes a key as every other route does.
    if (route.local !== undefined) {
      if (route.localJson === undefined) {
        res.writeHead(route.local, { "content-length": "0" });
        return res.end();
      }
      const sent = policy.keyOf(req.headers);
      if (!sameKey(sent, key) && sideOf(sent) === undefined) return refuse(res, 401, "this session's key is required", req);
      res.writeHead(route.local, { "content-type": "application/json", "content-length": String(Buffer.byteLength(route.localJson)) });
      return res.end(route.localJson);
    }
    // The session's key (the harness's requests), or a side key the host holds (its own, labelled).
    const sentKey = policy.keyOf(req.headers);
    const host = sameKey(sentKey, key) ? undefined : sideOf(sentKey);
    if (host === undefined && !sameKey(sentKey, key)) return refuse(res, 401, "this session's key is required", req);
    // The conversation its client names for it, told to the host with its admission; no header sent on carries it.
    const conversation = conversationLabel(req.headers[CONVERSATION_HEADER]);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) return refuse(res, 413, "the body is too large", req);
      chunks.push(chunk as Buffer);
    }
    let body: Record<string, unknown>;
    const headers: Record<string, string> = { "content-type": "application/json" };
    try {
      body = await policy.apply(parseStrict(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))), route, host === undefined ? {} : { host });
      // The listed headers, as the policy keeps them (or refuses them), before the runner is asked.
      for (const name of route.headers ?? []) {
        const value = req.headers[name.toLowerCase()];
        const kept = typeof value === "string" ? (policy.header ? policy.header(name, value) : value) : undefined;
        if (kept !== undefined) headers[name] = kept;
      }
    } catch (error) {
      const e = error as ProxyRefusal;
      return refuse(res, e instanceof ProxyRefusal ? e.status : 400, e instanceof ProxyRefusal ? e.message : "the body was refused", req);
    }
    // The model this request is for, as the policy read it from the body it checked: the runner is asked about it, and
    // it is priced at its rate.
    let asked = model;
    try {
      const named = policy.modelOf?.(body);
      if (typeof named === "string" && named) asked = named;
    } catch (error) {
      say(`model proxy (${policy.id}): the policy could not name the request's model; it is booked as the session's`, { error: String((error as Error)?.message ?? error).slice(0, 200) });
    }
    // The body as its client sent it, and the most input tokens it can be billed for, measured before the runner is asked:
    // its bytes here, then the provider's count or the policy's local count below, and only then a note (the wrap-up's),
    // which is decided on that same figure.
    let sent: string;
    try {
      sent = JSON.stringify(body);
    } catch (error) {
      say(`model proxy (${policy.id}): the body could not be serialized`, { error: String((error as Error)?.message ?? error).slice(0, 200) });
      return refuse(res, 500, "the body could not be serialized", req);
    }
    let inputTokensMax = inputTokensMaxOf(policy, body, sent, say);
    /** Its byte bound, kept: a note adds to the bound what it adds to this. */
    const byteBound = inputTokensMax;
    // What the body asks for at most, and the least it may be limited to, as the policy reads them. One the policy cannot
    // read leaves the request's worst case unknown: its input is unmeasured.
    const figure = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);
    let outputTokensAsked: number | undefined;
    let outputTokensLeast: number | undefined;
    /** The effort the body names (the policy's `effortOf`): words only, never a figure, so one it cannot read is none. */
    let effort: string | undefined;
    try {
      const named = policy.effortOf?.(body);
      effort = typeof named === "string" && named.length > 0 && named.length <= 32 ? named : undefined;
    } catch {
      effort = undefined;
    }
    /** The reasoning a stop of this request leaves unseen (the policy's `reasoningHidden`), in tokens. */
    let hiddenTokens = 0;
    /** The content and the reasoning the client was sent, by the policy's reading of each event (content: text,
     *  reasoning and tool arguments; reasoning: what of its reasoning streamed). */
    const sentOf = eventCounter({ content: policy.contentBytesOf?.bind(policy), reasoning: policy.reasoningBytesOf?.bind(policy) });
    /** Whether this request is on the session's model, its own (not the host's): what the run has seen its model reason
     *  is read for it (ReasoningSeen), and its answer's reasoning counts toward it. */
    const ownModel = asked === model && host === undefined;
    try {
      outputTokensAsked = figure(policy.outputAsked?.(body));
      outputTokensLeast = figure(ownModel ? policy.outputLeast?.(body, { most: reasoningMost }) : policy.outputLeast?.(body));
      hiddenTokens = figure(policy.reasoningHidden?.(body)) ?? 0;
    } catch (error) {
      say(`model proxy (${policy.id}): the policy could not read the body's output; its worst case is unmeasured`, { error: String((error as Error)?.message ?? error).slice(0, 200) });
      inputTokensMax = undefined;
    }
    // What it may charge beside its tokens (a hosted tool's per-use fees), held with them. One the policy cannot bound
    // leaves its worst case unknown, as an unmeasured input does.
    let feeUsd = 0;
    try {
      const fee = policy.feeMaxUsd ? policy.feeMaxUsd(body) : 0;
      if (figure(fee) === undefined) throw new Error(`no bound on its fees (${String(fee)})`);
      feeUsd = fee;
    } catch (error) {
      say(`model proxy (${policy.id}): the request's fees have no bound; its worst case is unmeasured`, { error: String((error as Error)?.message ?? error).slice(0, 200) });
      inputTokensMax = undefined;
    }
    // The provider's credential and its headers come before the runner is asked: a request that could not be sent is
    // refused without being admitted, so it is never booked and spends no turn.
    let credential = "";
    try {
      credential = await options.credential();
    } catch (error) {
      say(`model proxy (${policy.id}): the provider credential could not be read`, { error: String((error as Error)?.message ?? error).slice(0, 200) });
      // A credential its host says is gone (signed out, expired) is refused in the host's words, which the client does
      // not try again.
      if (error instanceof CredentialUnavailable) return refuse(res, refusedStatus, error.message, req, "credential_unavailable");
    }
    if (!credential) return refuse(res, 500, "the session has no provider credential", req);
    try {
      // OpenRouter's attribution, then the host's own headers, over any the client sent by those names; then the
      // credential's, over everything. A name replaces any other spelling of it, so no two headers of one name reach the
      // provider combined.
      const set = (name: string, value: string) => {
        for (const sent of Object.keys(headers)) if (sent.toLowerCase() === name.toLowerCase()) delete headers[sent];
        headers[name] = value;
      };
      for (const [name, value] of Object.entries(attribution)) set(name, value);
      for (const [name, value] of Object.entries(hostHeaders)) set(name, value);
      for (const [name, value] of Object.entries(policy.authHeaders(credential))) set(name, value);
    } catch (error) {
      say(`model proxy (${policy.id}): the policy could not build the provider's credential headers`, { error: String((error as Error)?.message ?? error).slice(0, 200) });
      return refuse(res, 500, "the provider's credential headers could not be built", req);
    }
    if (closing) return refuse(res, 503, "the model proxy is closing", req);
    /** Whether this request is the turn's answer request (`ProviderPolicy.answers`): a side call's stop ends nothing, and
     *  a side call is never refused for the turn's. */
    let answering = host === undefined;
    try {
      if (host === undefined) answering = policy.answers ? policy.answers(body) : true;
    } catch (error) {
      say(`model proxy (${policy.id}): whether the request is the turn's could not be read; taken as the turn's`, { error: String((error as Error)?.message ?? error).slice(0, 200) });
    }
    // The turn's answer stopped and the harness was told: its client asking again is refused (no retry), never sent, never
    // admitted or booked, until the harness opens its next turn.
    if (answering && !route.free && stopTold !== undefined) return refuse(res, refusedStatus, `refused: the turn's answer was ${stopTold}, and the turn ends there`, req);
    // An answer request on an upstream that is its provider's own (policy.countInput): its input bound is the provider's
    // exact count when that is below its bytes, so a small cap admits a turn its bytes would not: the cap holds each
    // request at its whole input uncached, and the count is that input to the token. A count that fails or times out
    // leaves the byte bound, and never holds the request up for long. The body is counted as its client sent it, before
    // any note (below).
    // Only a bound that is a number is lowered: an unmeasured one (a fee with no bound, a hosted tool's reads) stays so.
    /** The provider's count, when it gave one: then no local count is taken, even when the provider's is the higher. */
    let counted: number | undefined;
    if (answering && !route.free && host === undefined && inputTokensMax !== undefined && policy.countInput) {
      // A client that goes while its request is counted is gone before anything is admitted: the count is cut, and the
      // request is neither admitted nor sent (nothing is booked, and no paid answer starts for no one).
      const gone = new AbortController();
      const onGone = () => gone.abort(new Error("the client went while its request was counted"));
      res.once("close", onGone);
      try {
        counted = await countedInputOf(policy, origin, body, headers, forward, say, COUNT_TIMEOUT_MS, gone.signal);
      } finally {
        res.off("close", onGone);
      }
      if (gone.signal.aborted || res.destroyed) return;
      if (counted !== undefined && inputTokensMax !== undefined && counted < inputTokensMax) inputTokensMax = counted;
    }
    // A request its provider did not count (no counter, a gateway, a side or host request, a count that failed): its input
    // bound is the policy's local count (countInputLocally, its margin included) when that is below its bytes.
    if (counted === undefined && !route.free && inputTokensMax !== undefined && policy.countInputLocally) {
      const local = await localInputOf(policy, body, say);
      if (res.destroyed) return;
      if (local !== undefined && inputTokensMax !== undefined && local < inputTokensMax) inputTokensMax = local;
    }
    // A request its provider did not count that carries an earlier one the provider billed (a session's next step, on a
    // model no local count reads: Claude through a gateway): its input bound is that bill and the bytes it adds
    // (policy.inputAfter), when that is below its bound so far.
    const earlier = billed.get(asked);
    if (counted === undefined && !route.free && inputTokensMax !== undefined && earlier && policy.inputAfter) {
      try {
        const after = policy.inputAfter(earlier, body);
        if (after !== undefined && (!Number.isSafeInteger(after) || after < 0)) throw new Error(`not a token count: ${String(after).slice(0, 40)}`);
        if (after !== undefined && after < inputTokensMax) inputTokensMax = after;
      } catch (error) {
        say(`model proxy (${policy.id}): the bound from the earlier billed request failed; the request keeps its bound`, { error: String((error as Error)?.message ?? error).slice(0, 200) });
      }
    }
    // A note the host has for the session's next main-model request (the spend cap's wrap-up): a paid request on the
    // session's model whose policy can place it takes it, once, now that it is measured as its admission reads it
    // (NoteRequest: the input bound above, a count where there is one, and the output it asks for and needs), so the note
    // comes due on the figures the cap admits it by, never on its bytes where it was counted. Only the turn's own request
    // (ProviderPolicy.answers): a side call on the session's model (a title, a summary, when the client has no small model)
    // takes none, nor does the host's own (`host`): the note is for the harness's model, in its own conversation. One the
    // policy fails to place, or whose body it cannot measure, is given back, said once; the request goes as the client sent
    // it. The noted request's bound is that figure and the note's own bytes (what the body grows by, with what its policy
    // says the provider adds for it): a token covers at least a byte, so it is never under what the noted request bills.
    // The body as the client sent it is kept (`plain`): a request the cap admits only without the note's bytes goes as
    // that (ModelTicket.noteDropped).
    let noted = false;
    let plain: Record<string, unknown> | undefined;
    let plainSent: string | undefined;
    let inputTokensMaxWithoutNote: number | undefined;
    if (!route.free && asked === model && host === undefined && answering && policy.addNote && hooks.note) {
      const note = hooks.note(asked, { ...(inputTokensMax === undefined ? {} : { inputTokensMax }), ...(outputTokensAsked === undefined ? {} : { outputTokensAsked }), ...(outputTokensLeast === undefined ? {} : { outputTokensLeast }) });
      if (note) {
        // Taken: given back (serve) unless this request brings it to its admission, below.
        taken.note = note;
        try {
          const withNote = policy.addNote(body, note);
          const withNoteSent = JSON.stringify(withNote);
          const grown = inputTokensMaxOf(policy, withNote, withNoteSent, say);
          if (grown === undefined || byteBound === undefined || grown < byteBound) throw new Error("the body with the note could not be measured");
          if (inputTokensMax !== undefined) {
            inputTokensMaxWithoutNote = inputTokensMax;
            inputTokensMax += grown - byteBound;
          }
          plain = body;
          plainSent = sent;
          body = withNote;
          sent = withNoteSent;
          noted = true;
        } catch (error) {
          say(`model proxy (${policy.id}): the host's note could not be placed; the request goes without it`, { error: String((error as Error)?.message ?? error).slice(0, 200) });
          taken.note = undefined;
          try { hooks.noteReturned?.(note); } catch { /* the host's to say */ }
        }
      }
    }
    // This request's own admission, handed back to its booking (requests may be in flight together).
    let ticket: unknown;
    // The note, if this request carries it, is its admission's from here: given back by a refusal, else told if it is answered.
    if (noted) taken.note = undefined;
    // A client that goes while its request waits for room under the run's cap (runBooking) takes it out of the line: it
    // is never admitted, nothing is held or booked for it.
    const left = new AbortController();
    const onLeft = () => left.abort(new Error("the client went while its request waited for room under the run's cap"));
    res.once("close", onLeft);
    if (res.destroyed) onLeft();
    try {
      if (!route.free) ticket = await hooks.beforeRequest({
        signal: left.signal,
        // A side call: on another model than the session's, or the host's own (it counts toward no typical request). One on
        // the session's model that is no answer of the turn (a title, a summary, a child's: `answering`, the policy's
        // answers) is `unanswered`: booked as any request, but no answer the host keeps its reserve back for.
        model: asked, inputTokensMax, ...(asked !== model || host !== undefined ? { side: true as const } : {}), ...(!answering && host === undefined ? { unanswered: true as const } : {}),
        ...(noted ? { noted: true as const, ...(inputTokensMaxWithoutNote === undefined ? {} : { inputTokensMaxWithoutNote }) } : {}),
        ...(outputTokensAsked === undefined ? {} : { outputTokensAsked }),
        ...(outputTokensLeast === undefined ? {} : { outputTokensLeast }),
        ...(effort === undefined ? {} : { effort }),
        ...(feeUsd > 0 ? { feeUsd } : {}),
        ...(host === undefined ? {} : { host }),
        ...(conversation === undefined ? {} : { conversation }),
        ...(options.route === undefined ? {} : { route: options.route }),
      });
    } catch (error) {
      // Not 429: clients retry that, and the runner already refused this request (a turn cap, the host's budget).
      return refuse(res, refusedStatus, `refused before it was sent: ${String((error as Error)?.message ?? error).slice(0, 300)}`, req, capRefusal(error) ? SPEND_CAP_REACHED : undefined);
    } finally {
      res.off("close", onLeft);
    }
    /** An admitted request that is not sent after all: refused to its client, and released, booked at nothing, so the
     *  runner's count agrees. */
    const release = async (status: number, message: string) => {
      if (!res.destroyed) refuse(res, status, message, req);
      if (!route.free) {
        try {
          await hooks.afterRequest({ input: 0, output: 0, cacheRead: 0, usd: 0 }, ticket, { end: "nothing", label: "never_left" });
        } catch (error) {
          say(`model proxy (${policy.id}): afterRequest threw; the request was not sent and not booked`, { error: String((error as Error)?.message ?? error).slice(0, 200) });
        }
      }
    };
    // Admitted while the proxy was closing, and never sent.
    if (closing) return release(503, "the model proxy is closing");
    // Admitted after its client left (a stop or a cancel while its hold was made durable): never sent, booked at nothing.
    // Sent anyway it would be a paid answer for no one, and one never stopped (its client's close came before the proxy
    // listened for it, below), booked only once the provider ended it: past the run's end, which then read the request as
    // cut at an unknown cost. Nothing from here to that listener waits, so a client that leaves later is heard there.
    if (res.destroyed || req.socket.destroyed) return release(499, "the client left before its request was sent");
    // Admitted only without the note (its bytes did not fit what is left of the cap): the body as the client sent it.
    if (typeof ticket === "object" && ticket !== null && (ticket as { noteDropped?: unknown }).noteDropped === true) {
      if (!plain || plainSent === undefined) return release(500, "the request was admitted without its note, which this proxy cannot take back out");
      body = plain;
      sent = plainSent;
    }
    // Admitted with an output limit (what is left of a spend cap can buy): written into the body, which is never sent
    // unlimited, nor longer than the body its input bound was measured on.
    const limit = typeof ticket === "object" && ticket !== null ? (ticket as { outputTokensMax?: unknown }).outputTokensMax : undefined;
    if (limit !== undefined) {
      if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || !policy.limitOutput) return release(500, "the request's output could not be limited to what its spend cap leaves");
      let limited: string;
      try {
        limited = JSON.stringify(policy.limitOutput(body, limit));
      } catch (error) {
        say(`model proxy (${policy.id}): the policy could not limit the body's output`, { error: String((error as Error)?.message ?? error).slice(0, 200) });
        return release(500, "the request's output could not be limited to what its spend cap leaves");
      }
      if (Buffer.byteLength(limited, "utf8") > Buffer.byteLength(sent, "utf8")) return release(500, "the request's limited body is longer than the one its input was measured on");
      sent = limited;
    }
    const controller = new AbortController();
    inflight.add(controller);
    /** Set once the provider sent nothing for `stallMs` and this proxy stopped the request (MODEL_STALLED). */
    let stalled = false;
    let stallTimer: NodeJS.Timeout | undefined;
    /** Set once the client was sent the provider's event stream (a 200 one): a stall after is told as its last event. */
    let eventStream = false;
    /** Whether the bound runs: from the request's leaving to its answer's end, but for each wait on its client. */
    let stallRuns = false;
    /** Starts the stall bound again: as the request leaves, as its answer's headers come, and after each piece of the
     *  answer the client has taken. A wait on a client that reads slowly is the client's, never counted. */
    const waitProvider = (): void => {
      clearTimeout(stallTimer);
      stallRuns = true;
      stallTimer = setTimeout(() => {
        stalled = true;
        controller.abort(new Error(stalledWords(stallMs)));
      }, stallMs);
    };
    /** Stops the bound while the client is written a piece (its wait is its own), or at the answer's end. */
    const holdStall = (): void => {
      clearTimeout(stallTimer);
      stallRuns = false;
    };
    /** A host route's word that its provider sent something the route holds back (a translation that sends a thinking
     *  block whole at its end, or a reply it reads whole): the provider is not silent, so the bound starts again, unless
     *  it is held for the client. ProviderHeard. */
    const heard: ProviderHeard = () => {
      if (stallRuns && !stalled) waitProvider();
    };
    /** The last characters the client was written: whether it stands between two events, for the stall's own event. */
    let sentEnd = "";
    /** Set once the provider's content-filter stop was told: the answer is read on to its end for its usage, though the
     *  client (whose turn the harness ends) goes away. */
    let keepReading = false;
    /** That the client left before the answer reached it whole (the harness stopped the request). */
    let clientLeft = false;
    /** The bytes of the answer the client was sent (and, for one read on after its content-filter stop, read after its
     *  client left: what the provider streamed). */
    let sentBytes = 0;
    /** That the answer ended because its client left part way, not because the provider or this proxy ended it. */
    let stoppedByClient = false;
    res.on("close", () => {
      if (!answered) clientLeft = true;
      if (!keepReading) controller.abort();
    });
    let head = "";
    /** At least the answer's last USAGE_WINDOW characters, at most twice that: cut back only once it doubles, so keeping
     *  it costs each piece its own length, never a copy of the window (`lastOf` reads the window from it). */
    let tail = "";
    const lastOf = (text: string): string => (text.length > USAGE_WINDOW ? text.slice(-USAGE_WINDOW) : text);
    let length = 0;
    /** The provider's answer, once it reached the client whole. */
    let answered: { ok: boolean } | undefined;
    /** That the provider's answer began, with its status: what a client that left before the end had of it. */
    let began: { ok: boolean; status: number } | undefined;
    /** The code of the provider's fetch failing before any response (rejectionCode): a connect-phase one never left. */
    let failedCode: string | undefined;
    let watchEnd: (() => void) | undefined;
    /** The ids its headers gave it. */
    let ids: Record<string, string> | undefined;
    let reported: number | undefined;
    /** Whether the provider's content-filter stop was read (once an answer). */
    let filteredTold = false;
    /** Called once the request is booked, when its answer was read on after its stop (the proxy's close waits for it). */
    let drained: (() => void) | undefined;
    /** The turn this answer opens (ModelProxyOptions.turn), while it is read; and the client tool calls its stream started. */
    let turnSpan: TurnSpan | undefined;
    let toolCalls = 0;
    const settled = (): void => {
      turnSpan?.end();
      if (!drained) return;
      draining.delete(controller);
      drained();
    };
    /** The start of the line being read (LINE_START) and of the last whole lines (LINE_STARTS). */
    let lineStart = "";
    let lineLength = 0;
    /** The line being read, whole while it is no longer than the window (a longer one is read from the window as it ends). */
    let line = "";
    /** Whether the answer is a whole JSON body rather than an event stream, once its first character says so. */
    let wholeBody: boolean | undefined;
    const starts: string[] = [];
    /** Tells the harness the provider stopped this answer on its content filter, when `text` (the answer so far, or the
     *  kept window of it) says so: once, and never failing the answer. */
    const tellFiltered = (text: string): void => {
      if (filteredTold || !policy.filtered) return;
      let stopped = false;
      try {
        stopped = policy.filtered(text, starts);
      } catch (error) {
        say(`model proxy (${policy.id}): whether the provider's content filter stopped the answer could not be read`, { error: String((error as Error)?.message ?? error).slice(0, 200) });
      }
      if (!stopped) return;
      filteredTold = true;
      if (!answering) {
        say(`model proxy (${policy.id}): the provider stopped a side call on its content filter; left to the client`);
        return;
      }
      say(`model proxy (${policy.id}): the provider stopped the answer on its content filter`);
      // The harness ends the turn: until it opens its next, the session's answer requests are refused.
      if (options.onFiltered) stopTold = "stopped on the provider's content filter";
      // Read on to the answer's end for its usage, though the client goes; the proxy's close waits for it, bounded.
      keepReading = true;
      draining.set(controller, new Promise<void>((resolve) => (drained = resolve)));
      try {
        options.onFiltered?.(CONTENT_FILTERED);
      } catch (error) {
        say(`model proxy (${policy.id}): onFiltered threw`, { error: String((error as Error)?.message ?? error).slice(0, 200) });
      }
    };
    /** Whether the provider's cut at its output limit was read (once an answer). */
    let cutTold = false;
    /** Tells the harness the provider cut this answer at its output limit, when `text` says so: once, an answer request's
     *  only, and never failing the answer (it is passed and booked as any answer). */
    const tellCut = (text: string): void => {
      if (cutTold || !answering || !policy.cut || !options.onCut) return;
      let stop: { outputTokens?: number; capCut?: CapCut } | undefined;
      try {
        stop = policy.cut(text, starts);
      } catch (error) {
        say(`model proxy (${policy.id}): whether the provider cut the answer at its output limit could not be read`, { error: String((error as Error)?.message ?? error).slice(0, 200) });
      }
      if (!stop) return;
      cutTold = true;
      // Sent with less output than it asked, limited to what the run's cap left: the cut is the cap's.
      const capCut = limit !== undefined && typeof ticket === "object" && ticket !== null ? capCutOf((ticket as { capCut?: unknown }).capCut) : undefined;
      if (capCut) stop = { ...stop, capCut };
      say(`model proxy (${policy.id}): the provider cut the answer at its output limit${capCut ? " the run's cap limited it to" : ""}`);
      // The harness ends the turn: until it opens its next, the session's answer requests are refused.
      stopTold = "cut at the model's output limit";
      try {
        options.onCut(stop);
      } catch (error) {
        say(`model proxy (${policy.id}): onCut threw`, { error: String((error as Error)?.message ?? error).slice(0, 200) });
      }
    };
    /** Whether this proxy had aborted the request when the answer's first error event was read (undefined: none read
     *  yet). Each event is read here whole (eventReader) before its client is written the blank line that ends it, and a
     *  client acts on an event only once that line ends it, so an error read before the abort is the provider's own (a
     *  refusal, an overload) that its client then read and left on: no stop. One read after the abort may be the
     *  abort's own end of the stream (a route's "aborted" event), or a refusal raced by the hang-up: a stop. */
    let errorReadAborted: boolean | undefined;
    /** The answer's stops, read from what has come of it so far: its content-filter stop, and its cut. */
    const tellStops = (text: string): void => {
      tellFiltered(text);
      tellCut(text);
    };
    /** The answer's events, whole, at most a window of each: what tellEvent reads. */
    const events = eventReader(USAGE_WINDOW);
    /** One whole event of a successful answer: whether it is the provider's error, read by streamErrorOf as the booking
     *  reads the answer's end, so the two never disagree on an event, and whether this proxy had aborted then. And when its
     *  data came on several lines, its stops, from its data on one `data:` line (a space where the format joins with a
     *  line feed: JSON reads both alike): a policy reads each `data:` line on its own, and no one line of such an event
     *  holds it. */
    const tellEvent = (event: StreamEvent): void => {
      if (event.text === undefined) return;
      if (errorReadAborted === undefined && event.text.includes("error") && streamErrorOf(event.text) !== undefined) errorReadAborted = controller.signal.aborted;
      if (event.data.length > 1) tellStops([...event.text.split("\n").filter((each) => !each.startsWith("data:")), `data: ${event.data.join(" ")}`].join("\n"));
    };
    try {
      // From here a paid request may be paid, so every way out below books it exactly once.
      // The turn's answer is read from here: a tool call the client makes on it waits for its facts.
      if (answering && host === undefined && !route.free && options.turn) turnSpan = options.turn.begin();
      waitProvider();
      let upstream = await forward(`${origin}${route.path}${query ? `?${query}` : ""}`, { method: route.method, headers, body: sent, signal: controller.signal, heard } as RequestInit);
      waitProvider();
      // The provider answered (and a paid request was paid): a host callback that throws must not lose the answer or
      // its booking.
      try {
        options.onResponse?.({ method: route.method, path: route.path, free: route.free === true, status: upstream.status });
      } catch (error) {
        say(`model proxy (${policy.id}): onResponse threw`, { error: String((error as Error)?.message ?? error).slice(0, 200) });
      }
      if (upstream.status === 401 && options.credentialRefused) {
        try {
          await options.credentialRefused(credential);
        } catch {
          say(`model proxy (${policy.id}): the host could not renew a refused credential`);
        }
      }
      // An error no retry mends (ProviderPolicy.finalError, a plan's limit reached): its client is answered the policy's
      // words at refusedStatus, a status it never asks again on, in place of the provider's. It was not paid: booked as
      // the provider's error answer is, at nothing.
      if (!upstream.ok && policy.finalError) {
        const text = await upstream.text();
        let final: { message: string; code: string } | undefined;
        try {
          final = policy.finalError(upstream.status, text);
        } catch (error) {
          say(`model proxy (${policy.id}): whether an error answer is final could not be read`, { error: String((error as Error)?.message ?? error).slice(0, 200) });
        }
        if (final) say(`model proxy (${policy.id}): the provider's error answer ends the run`, { status: upstream.status, code: final.code });
        // The body read is decoded: passed on, it carries no encoding or length of the provider's.
        const headers = new Headers(upstream.headers);
        headers.delete("content-encoding");
        headers.delete("content-length");
        // The policy's answer keeps the provider's request ids (providerIdsOf reads them below), so the request's records
        // still name it at the provider.
        upstream = final
          ? new Response(JSON.stringify({ error: { message: final.message, type: "agentrun_proxy", code: final.code } }), { status: refusedStatus, headers: { ...providerIdsOf(upstream.headers), "content-type": "application/json" } })
          : new Response(text, { status: upstream.status, headers });
        // The harness ends the turn in the policy's words, whatever its client makes of the answer.
        if (final) {
          try {
            options.onFinal?.(final.message, final.code);
          } catch (error) {
            say(`model proxy (${policy.id}): onFinal threw`, { error: String((error as Error)?.message ?? error).slice(0, 200) });
          }
        }
      }
      // Its ids are kept before its body is read: from here the provider has seen it, whatever cuts it off.
      ids = route.free ? undefined : providerIdsOf(upstream.headers);
      reported = route.free ? undefined : reportedCostOf(upstream.headers);
      if (ids && hooks.responded) {
        try {
          await hooks.responded(ids, ticket);
        } catch (error) {
          say(`model proxy (${policy.id}): responded threw; the request's ids are kept with its booking only`, { error: String((error as Error)?.message ?? error).slice(0, 200) });
        }
      }
      began = { ok: upstream.ok, status: upstream.status };
      const contentType = upstream.headers.get("content-type") ?? "application/json";
      const sentHeaders: Record<string, string> = { "content-type": contentType };
      // An error answer keeps the provider's word on asking again (RETRY_HEADERS): the client's own retry of a 429 or a
      // 5xx waits as long as the provider asked, not its own guess.
      if (!upstream.ok) {
        for (const name of RETRY_HEADERS) {
          const value = upstream.headers.get(name);
          if (value !== null) sentHeaders[name] = value;
        }
      }
      res.writeHead(upstream.status, sentHeaders);
      const decoder = new TextDecoder();
      // The provider's own words in an error reach the harness with the credential this proxy sent, and the values of the
      // headers it added, cut out, then the host's redactor (errorCut): an error answer, or an error event in a stream. The
      // credential and a header value of MIN_ECHO or more are cut wherever they stand; a shorter header value only in an
      // error's payload, and only as a whole token, so "1" never cuts "401" and "data" never cuts a data: field.
      const hostValues = Object.values(hostHeaders);
      eventStream = upstream.ok && /^text\/event-stream\b/i.test(contentType);
      const relay = errorCut(
        !upstream.ok ? "error" : eventStream ? "events" : "as-is",
        echoForms([credential, ...hostValues.filter((value) => value.length >= MIN_ECHO)]),
        options.redact,
        (message) => say(`model proxy (${policy.id}): ${message}`),
        echoForms(hostValues.filter((value) => value.length < MIN_ECHO)),
      );
      const write = async (out: string): Promise<void> => {
        if (!out || res.destroyed) return;
        const bytes = Buffer.from(out, "utf8");
        sentBytes += bytes.byteLength;
        sentEnd = (sentEnd + out).slice(-4);
        // A client that reads slowly holds the provider back: nothing more is read until what was written drains.
        if (!res.write(bytes)) {
          // One wait, and nothing left behind: whichever comes first takes both listeners off.
          await new Promise<void>((resolve) => {
            const done = () => { res.off("drain", done); res.off("close", done); resolve(); };
            res.on("drain", done);
            res.on("close", done);
          });
        }
      };
      let watcher: { chunk(text: string): void; failed?(): void; end?(): void } | undefined;
      try {
        // The host's own side requests are never the harness's to watch.
        watcher = host === undefined ? policy.watch?.() : undefined;
        watchEnd = watcher?.end?.bind(watcher);
      } catch (error) {
        say(`model proxy (${policy.id}): the response watcher could not start`, { error: String((error as Error)?.message ?? error).slice(0, 200) });
        try { policy.unwatched?.(); } catch {}
      }
      if (upstream.body) {
        for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
          // A route's own fetch may end its answer on the stall's abort with an event of its own ("aborted"): never
          // passed on, the stall's answer below is the client's.
          if (stalled) throw controller.signal.reason;
          holdStall();
          // What the watcher reads of a piece, it reads before the client has the piece.
          const text = decoder.decode(chunk, { stream: true });
          if (watcher) {
            try {
              watcher.chunk(text);
            } catch (error) {
              say(`model proxy (${policy.id}): the response watcher failed`, { error: String((error as Error)?.message ?? error).slice(0, 200) });
              try { watcher.failed?.(); } catch {}
              watcher = undefined;
            }
          }
          // The provider's content-filter stop, and its cut at the output limit, read before the client has the piece that
          // carries it: the harness ends the turn before its client acts on the stop (asks for the answer again, or ends
          // the turn its own way).
          // Each line is read once, as it ends, never the window again for every piece: a long answer comes in tens of
          // thousands of pieces, and reading the window for each held the runner's one thread for most of a minute.
          // A line longer than the window is read as it ends, from the window, its start among the last starts kept
          // while the lines just before it (an event's name) still are: a piece may carry the lines after it too.
          const lines = text.split("\n");
          for (let at = 0; at < lines.length; at++) {
            const part = lines[at]!;
            if (lineStart.length < LINE_START) lineStart += part.slice(0, LINE_START - lineStart.length);
            lineLength += part.length;
            line = lineLength <= USAGE_WINDOW ? line + part : "";
            if (at < lines.length - 1) {
              if (turnSpan && upstream.ok && lineLength <= USAGE_WINDOW) toolCalls += toolCallsIn(line);
              starts.push(lineStart);
              if (starts.length > LINE_STARTS) starts.shift();
              if (upstream.ok && lineLength > 0) tellStops(lineLength > USAGE_WINDOW ? lastOf(tail + text) : line);
              lineStart = "";
              lineLength = 0;
              line = "";
            }
          }
          // Then each event this piece ends, whole: an error event, and a stop whose data spans several lines.
          if (upstream.ok) for (const event of events.push(text)) tellEvent(event);
          // A whole JSON body (no event stream) may be printed across lines, so no one line holds its stop: while it fits the
          // window, it is read whole at each piece that may close it (ends in "}"), which is a few pieces, never one each.
          if (wholeBody === undefined && text.trimStart() !== "") wholeBody = (tail + text).trimStart().startsWith("{");
          if (upstream.ok && wholeBody && length + text.length <= USAGE_WINDOW && text.trimEnd().endsWith("}")) tellStops(tail + text);
          // A client gone after the stop was told is written nothing more: the answer is read on for its usage alone.
          const out = relay.push(text);
          await write(out);
          waitProvider();
          // The usage is at the start, the end, or both: keep those, not the whole answer.
          length += text.length;
          sentOf.push(out);
          if (head.length < USAGE_WINDOW) head += text.slice(0, USAGE_WINDOW - head.length);
          tail += text;
          if (tail.length > 2 * USAGE_WINDOW) tail = tail.slice(-USAGE_WINDOW);
        }
        if (stalled) throw controller.signal.reason;
        holdStall();
        // What the relay held at the answer's end: an error event's or an error body's rest, cut.
        const rest = relay.end();
        await write(rest);
        sentOf.push(rest);
      }
      res.end();
      answered = { ok: upstream.ok };
      // An upstream that ends its answer on this proxy's abort without throwing (a route's own fetch: pi-ai's stream ends
      // in its "aborted" error event, and the route closes it) is a stop all the same: its client left, and this proxy's
      // abort, not the provider, ended it. Never one read on past its client (keepReading: the signal was never aborted),
      // nor one whose error event was read before the abort (errorReadAborted false): the provider ended it, and its
      // client left after reading that.
      stoppedByClient = clientLeft && upstream.ok && controller.signal.aborted && errorReadAborted !== false;
    } catch (error) {
      // Its client had left before this (a stop): read now, as the proxy's own end below closes the response too.
      // Before any header too: the request left, and the provider may have begun it, as a stop part way. Only this proxy's
      // abort ends a stop: an answer read on after its client left (its content-filter stop) that the provider ends with
      // an error is no stop, nor is one whose error event was read before the abort (errorReadAborted false).
      stoppedByClient = clientLeft && (began === undefined || began.ok) && controller.signal.aborted && errorReadAborted !== false;
      if (!began) failedCode = rejectionCode(error);
      say(`model proxy (${policy.id}): the request did not complete`, { error: String((error as Error)?.message ?? error).slice(0, 200) });
      if (stalled && !clientLeft) {
        // The provider sent nothing for the stall bound: the client is told in words it does not ask again on, at
        // refusedStatus before the answer began, or as the stream's last event after (both APIs' error shapes in one), and
        // a host that ends turns (onFinal) ends this one, its client's next answer request refused until its next turn.
        const words = stalledWords(stallMs);
        if (!res.headersSent) refuse(res, refusedStatus, words, req, MODEL_STALLED);
        else if (eventStream) res.end(`${eventClose(sentEnd)}${stalledEvent(words)}`);
        else res.destroy();
        if (answering && options.onFinal) {
          stopTold = `stopped after ${Math.round(stallMs / 1000)} s with nothing from the model`;
          try {
            options.onFinal(words, MODEL_STALLED);
          } catch (error) {
            say(`model proxy (${policy.id}): onFinal threw`, { error: String((error as Error)?.message ?? error).slice(0, 200) });
          }
        }
      } else if (!res.headersSent) refuse(res, 502, "the provider did not answer", req);
      else res.destroy();
    } finally {
      holdStall();
      inflight.delete(controller);
      try { watchEnd?.(); } catch {}
    }
    // Every paid request the proxy forwarded is booked exactly once, after the client has its answer (or lost it):
    // nothing here can turn an answer into an error the client sees and might pay again for. Its usage and price
    // when the answer is whole and says them; nothing for a provider's error answer; an unknown cost for an answer
    // cut short, one that said no usage, or a usage or a price that could not be read. A booking that fails is
    // reported (the runner stops the node on it).
    if (route.free) return settled();
    let usage: ProxyUsage | undefined;
    let usd: number | null = null;
    // Whether `usd` is a figure the provider gave (an error answer's nothing included), not one this proxy made up.
    let own = false;
    let tableUsd: number | null | undefined;
    /** The provider's words when it refused the request inside a successful answer (streamErrorOf, no tokens reported):
     *  booked at nothing. */
    let refusedIn: string | undefined;
    /** The provider's words when its successful answer ended in its error after it reported tokens (or a cost, or after
     *  the model's content streamed): booked at what it reported, as an answer. */
    let erredIn: string | undefined;
    // A client may leave once it has read the response's usage (Codex does, at the completion event) while the provider
    // still holds the stream open: what was read of a successful answer is read for its usage as a whole one is. With none
    // in it, the cost is unknown, as for any answer cut short.
    // An error answer cut part way is still an error answer: its status says it was not paid.
    const seen = answered ?? began;
    if (!seen) {
      usage = { input: 0, output: 0, cacheRead: 0 };
      // A request refused at connect never left: it costs nothing. Anything else may have reached the provider.
      if (isConnectCode(failedCode)) {
        usd = 0;
        own = true;
      }
    } else if (!seen.ok) {
      // A provider's error answer was not a paid response: it costs nothing. But a gateway's 504 or 524 says only that
      // the gateway gave up: the provider was still at work, and bills it.
      usage = { input: 0, output: 0, cacheRead: 0 };
      if (!isGatewayTimeout(began?.status ?? 0)) {
        usd = 0;
        own = true;
      }
    } else {
      let unread = false;
      const kept = length <= USAGE_WINDOW ? tail : `${head}\n${lastOf(tail)}`;
      try {
        usage = policy.usageOf(kept, body);
      } catch (error) {
        say(`model proxy (${policy.id}): the usage could not be read; the request is booked at an unknown cost`, { error: String((error as Error)?.message ?? error).slice(0, 200) });
        usage = { input: 0, output: 0, cacheRead: 0 };
        unread = true;
      }
      // A stream the provider ended in its error event (an overload, a rate limit, a failure, at any point): what it reported
      // before the error is booked at the table's price (or at the cost it stated), a known figure, never the hold. Usage
      // whose every count is 0 (a translation's start, written before the provider said any) reports no tokens.
      const failed = streamErrorOf(kept);
      if (failed !== undefined && usage && usage.input + usage.output + usage.cacheRead + (usage.cacheWrite ?? 0) === 0) usage = undefined;
      // What the answer's own usage says it cost (OpenRouter's), when no header said: what was paid, as a gateway's header.
      if (reported === undefined && costStated) reported = usageCostOf(kept);
      // In the provider's words, the credential and the host's header values cut, then the host's redactor, as its client
      // was sent them.
      const wordsOf = (said: string) => {
        const words = errorCut("error", echoForms([credential, ...Object.values(hostHeaders)]), options.redact, (message) => say(`model proxy (${policy.id}): ${message}`));
        return `${words.push(said)}${words.end()}`.slice(0, 300);
      };
      if (!usage) {
        usage = { input: 0, output: 0, cacheRead: 0 };
        unread = true;
        // A stream that ends in the provider's error with no tokens and no cost reported (a 200 the provider sent before
        // the model's first token, then a rate limit or an overload as an error event): refused, never run, so it cost
        // nothing. Never once the model's content streamed with no usage said, nor once the stream shows it began its
        // output with none of it streamed (outputBeganIn: hidden reasoning, a block a translation held): that was run,
        // and is booked at an unknown cost as any answer cut short. Missing content is no proof of a refusal, and the error
        // a stop's abort ends a stream in (stoppedByClient) is ours, never the provider's refusal: the stop counts it.
        if (!stoppedByClient && failed !== undefined && reported === undefined && !(policy.contentBytesOf && sentOf.bytes("content") > 0) && !outputBeganIn(kept)) {
          refusedIn = wordsOf(failed.words);
          say(`model proxy (${policy.id}): the provider refused the request inside its answer (${failed.rateLimit ? "a rate limit" : "an error"}); booked at nothing`);
        }
      }
      if (failed !== undefined && refusedIn === undefined) {
        erredIn = wordsOf(failed.words);
        say(`model proxy (${policy.id}): the provider ended its answer in an error; booked at what it reported${unread && reported === undefined ? " (none: an unknown cost)" : ""}`);
      }
      // A translation's failure in words (wordsErrorOf): an answer that ended in an error all the same, its client asking
      // again. Booked as before, as any answer cut short; only its end says the error.
      const translated = failed === undefined ? wordsErrorOf(kept) : undefined;
      if (translated !== undefined) erredIn = wordsOf(translated);
      // An answer of the client's own that reached it whole and reported its usage: what its whole input billed, kept
      // with the body it was sent with, for the session's next request on its model (policy.inputAfter).
      const billedInput = usage.input + usage.cacheRead + (usage.cacheWrite ?? 0);
      // The turn's facts, from an answer that reached its client whole: its input as billed (else the request's bound, the
      // provider's or the local count), its output, and its calls (a whole JSON body's read from it whole).
      if (turnSpan && answered?.ok && failed === undefined && translated === undefined && refusedIn === undefined) {
        const calls = wholeBody ? (length <= USAGE_WINDOW ? toolCallsInBody(tail) : undefined) : toolCalls;
        const read = !unread && Number.isSafeInteger(billedInput) && billedInput > 0;
        turnSpan.open({ ...(read ? { inputTokens: billedInput, outputTokens: usage.output } : inputTokensMax === undefined ? {} : { inputTokens: inputTokensMax }), ...(calls === undefined ? {} : { calls }) });
      }
      if (answered?.ok && !stoppedByClient && !unread && failed === undefined && translated === undefined && refusedIn === undefined && host === undefined && Number.isSafeInteger(billedInput) && billedInput > 0) billed.set(asked, { body, inputTokens: billedInput });
      // The reasoning an answer of the session's model reported: the most one answer reasoned is what a later request's
      // least output is read from.
      const reasoned = usage.reasoning;
      if (ownModel && !unread && typeof reasoned === "number" && Number.isSafeInteger(reasoned) && reasoned >= 0) reasoningMost = Math.max(reasoningMost ?? 0, reasoned);
      try {
        usd = refusedIn !== undefined ? 0 : unread ? null : options.price?.(asked, usage) ?? null;
        if (refusedIn !== undefined) own = true;
      } catch (error) {
        say(`model proxy (${policy.id}): the price could not be computed; the request is booked at an unknown cost`, { error: String((error as Error)?.message ?? error).slice(0, 200) });
        usd = null;
      }
      // What the gateway says it cost is what was paid; the table's figure stays beside it, to audit the table.
      if (reported !== undefined && refusedIn === undefined) {
        tableUsd = usd;
        usd = reported;
        own = true;
      }
    }
    try {
      // A response its client stopped and whose cost is unknown says what streamed of it, for the host to count it by.
      // With the reasoning it never streamed, which the provider can have billed too.
      // What it streamed: its content where the policy reads it, never the provider's framing; else the bytes as sent.
      const streamed = policy.contentBytesOf ? sentOf.bytes("content") : sentBytes;
      const stopped = stoppedByClient && usd === null ? { stoppedAfterBytes: streamed, ...(hiddenTokens > 0 ? { stoppedHiddenTokens: hiddenTokens, stoppedReasoningBytes: sentOf.bytes("reasoning") } : {}) } : {};
      // How it ended, for the runner to book it by (booking.ts). A stop counts what the stop fields above say of it: its
      // content, and the part of its hidden reasoning budget that did not stream, max(0, budget - the reasoning sent).
      const ended: Ended = refusedIn !== undefined ? { end: "nothing", label: "refused", reason: refusedIn }
        : stoppedByClient && usd === null ? { end: "stopped", streamedTokens: streamed + Math.max(0, hiddenTokens - sentOf.bytes("reasoning")) }
        : !seen ? (isConnectCode(failedCode) ? { end: "nothing", label: "never_left" } : { end: "lost", label: "error_before" })
        : !seen.ok ? (isGatewayTimeout(began?.status ?? 0) ? { end: "lost", label: "gateway_timeout" } : { end: "nothing", label: "status" })
        : !answered && usd === null ? { end: "lost", label: "error_after", began: true }
        : { end: "answered", usd, ...(erredIn !== undefined ? { label: "error" as const, reason: erredIn } : filteredTold ? { label: "filtered" as const } : {}), ...(tableUsd === undefined ? {} : { tableUsd }) };
      // The reasoning it reported is the proxy's own reading (reasoningMost), never a booked figure: its output has it.
      const { reasoning: _reasoning, ...tokens } = usage;
      await hooks.afterRequest({ ...tokens, usd, ...(own ? {} : { estimated: true }), ...(tableUsd === undefined ? {} : { tableUsd }), ...(ids ? { providerIds: ids } : {}), ...stopped }, ticket, ended);
    } catch (error) {
      say(`model proxy (${policy.id}): afterRequest threw; the request was answered and not booked`, { error: String((error as Error)?.message ?? error).slice(0, 200) });
    }
    // An answer whose stop no piece showed before it ended (a whole JSON body): read whole once it is booked.
    if (seen?.ok) tellStops(length <= USAGE_WINDOW ? tail : `${head}\n${lastOf(tail)}`);
    settled();
  };

  const server = createServer((req, res) => { void serve(req, res).catch(() => { if (!res.headersSent) refuse(res, 500, "the proxy failed", req); else res.destroy(); }); });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("agentrun-kernel: the model proxy has no port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    key,
    sideKey: (label: string) => {
      if (!label) throw new Error("agentrun-kernel: a side key needs a label");
      let minted = sideKeys.get(label);
      if (!minted) sideKeys.set(label, (minted = randomBytes(32).toString("base64url")));
      return minted;
    },
    openTurn: () => {
      stopTold = undefined;
    },
    close: async () => {
      closing = true;
      for (const c of inflight) if (!draining.has(c)) c.abort();
      // An answer the provider stopped on its content filter is read on to its end and booked first, for FILTERED_DRAIN_MS.
      if (draining.size) {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([Promise.all(draining.values()), new Promise<void>((resolve) => (timer = setTimeout(resolve, FILTERED_DRAIN_MS)))]);
        clearTimeout(timer);
        for (const c of inflight) c.abort();
      }
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
