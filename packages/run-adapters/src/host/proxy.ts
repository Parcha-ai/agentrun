// A session's model proxy, written for AgentRun: the provider a harness is pointed at, on the loopback interface. The
// harness holds only the session's own key; the provider's credential never reaches it. The proxy is provider-neutral,
// and a `ProviderPolicy` says what one provider's API may carry (its routes, how its client sends a key, the body it may
// forward, where a response reports its usage). The core:
//  - admits a request only with the session's key (compared in constant time), on a route the policy lists, by exact
//    path text, with no query or one the route lists exactly: an absolute URL, `..`, `//` or `%` escapes never match. A
//    route may be answered here with a status alone, with no key (a client's connectivity check), or be free (a token
//    count, which the runner never pays);
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
import { type McpHandler, mcpRoute } from "./mcp-route.js";
import { CONTENT_FILTERED, type McpClient, type NoteRequest, type SessionMcp } from "../types.js";
import { type Ended, isConnectCode, isGatewayTimeout, rejectionCode } from "../booking.js";

/** A route a policy admits: its method, its exact path, and the request headers forwarded with it. */
export interface ProxyRoute {
  readonly method: string;
  readonly path: string;
  /** Exact query strings it admits besides none (`beta=true`); forwarded as the table has them. */
  readonly query?: readonly string[];
  readonly headers?: readonly string[];
  /** Answered here with this status and an empty body, never forwarded (a client's connectivity check). */
  readonly local?: number;
  /** Not a paid request (a token count): forwarded without asking the runner, and no usage is reported. */
  readonly free?: boolean;
}

/** Token counts a response reports. */
export interface ProxyUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite?: number;
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
   *  the session's. */
  apply(body: unknown, route: ProxyRoute, context?: ProxyRequestContext): Record<string, unknown>;
  /** The usage a completed response reports, if it reports one: from its whole text, or, for a long one, its first and
   *  last 64 KiB (a provider may report input tokens as a stream starts and output tokens as it ends). */
  usageOf(text: string): ProxyUsage | undefined;
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
  /** The input tokens the provider bills for the body `apply` returned that the body does not carry: a prompt it adds
   *  itself, such as a tool-use system prompt. Added to the body's bytes for `inputTokensMax`. Undefined: the body has
   *  no input bound the policy can state (a hosted tool that reads pages into the input), so `inputTokensMax` is
   *  undefined, never 0 or the body's bytes alone. Absent: none. */
  serverInputOverhead?(body: Record<string, unknown>): number | undefined;
  /** The output tokens the body `apply` returned asks for at most (its own limit, as `apply` shaped it). Absent or
   *  undefined: the body does not say. */
  outputAsked?(body: Record<string, unknown>): number | undefined;
  /** The least output the body may be limited to and still answer: 1,024 tokens for the answer, plus the least thinking
   *  its provider takes when it thinks. Absent: 1,024. */
  outputLeast?(body: Record<string, unknown>): number;
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
 * A `redact` that throws leaves the cut, and is said.
 */
export function errorCut(mode: "error" | "events" | "as-is", forms: readonly string[], redact: ((text: string) => string) | undefined, say: (message: string) => void): { push(text: string): string; end(): string } {
  /** `text` with every one of `of` cut out. */
  const cutOf = (of: readonly string[], text: string): string => of.reduce((out, form) => out.split(form).join(REDACTED), text);
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
  if (mode === "as-is" || !forms.length && !redact) return { push: (text) => text, end: () => "" };
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
    let held = "";
    return {
      push(text: string): string {
        const all = host ? redacted(cut(held + text)) : cutOf(of, held + text);
        let at = all.length - Math.min(all.length, Math.max(startOf(all), host && redact ? REDACT_WINDOW : 0));
        // Never between the two UTF-16 halves of a character: each half written alone is two U+FFFD to the client.
        if (at > 0 && at < all.length && isLowSurrogate(all.charCodeAt(at))) at -= 1;
        held = all.slice(at);
        return all.slice(0, at);
      },
      end(): string {
        const rest = held;
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
    const out = state === "hold" ? (wholeIsError(held) ? redacted(cut(held)) : cutOf(healthyForms, held)) : eventCutter!.end();
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

function eventCounter<K extends string>(readers: Record<K, ((event: string) => number) | undefined>): { push(text: string): void; bytes(of: K): number } {
  const keys = (Object.keys(readers) as K[]).filter((key) => readers[key] !== undefined);
  const sums = Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
  let pending = "";
  /** A "\r" the last piece ended on: the first half of a "\r\n" the next piece ends. */
  let cr = "";
  return {
    push(text) {
      if (!keys.length) return;
      // A line end split between pieces ("\r" here, "\n" in the next) is joined before "\r\n" becomes "\n", or the two
      // events around a split blank line would read as one, which no policy can parse.
      let piece = cr + text;
      cr = piece.endsWith("\r") ? "\r" : "";
      if (cr) piece = piece.slice(0, -1);
      pending += piece.replace(/\r\n/g, "\n");
      for (let at = pending.indexOf("\n\n"); at >= 0; at = pending.indexOf("\n\n")) {
        const event = pending.slice(0, at);
        pending = pending.slice(at + 2);
        for (const key of keys) {
          try {
            const n = readers[key]!(event);
            if (typeof n === "number" && Number.isFinite(n) && n > 0) sums[key] += n;
          } catch {
            // An event the policy cannot read carries nothing it counts.
          }
        }
      }
      if (pending.length > EVENT_MAX_CHARS) pending = "";
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
  /** A side call, never its turn's own: on another model than the session's (a client's small-model call: a title, a
   *  summary), or the host's own request beside the harness's (`host`). */
  side?: true;
  /** It carries the host's note (`ModelProxyHooks.note`), placed in its body: the host's to record once it is admitted. */
  noted?: true;
  /** The label of the side key it came under (ModelProxy.sideKey): the host's own request, beside the harness's. */
  host?: string;
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
}

export interface ModelProxyOptions {
  policy: ProviderPolicy;
  hooks: ModelProxyHooks;
  /** The session's model, as the runner names it to `beforeRequest`. The policy fixes the body's model. */
  model: string;
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
  /** Headers the host adds to every request it forwards (a gateway's spend tags, LiteLLM's `x-litellm-tags`, say):
   *  after the client's, so the client can neither set nor override them, and before the credential's. Checked when the
   *  proxy starts (`hostHeaderProblems`). */
  headers?: Readonly<Record<string, string>>;
  /** The session's remote MCP servers, each mounted here at `/mcp/<server>` behind the session's key (mcp-route.ts),
   *  for the harness's own MCP client as its adapter declares it (`client`, AdapterCapabilities.mcpClient). One mount for
   *  every harness: an adapter hands the session's MCP, never a route of its own. */
  mcp?: { session: SessionMcp; client: McpClient; keepaliveMs?: number };
  /** For tests: the fetch the proxy forwards with. */
  fetch?: typeof fetch;
  /** Told, with CONTENT_FILTERED, once an answer the provider stopped on its content filter has been passed and booked
   *  (`ProviderPolicy.filtered`): the harness halts the turn with it, before its client asks for the answer again. */
  onFiltered?: (message: string) => void;
  /** Told, once an answer request's answer, once its stop says the provider cut it at its output limit
   *  (`ProviderPolicy.cut`), before its client has the piece that carries the stop: a harness whose client would ask for
   *  the answer again (Codex retries an incomplete stream) ends the turn there, the answer cut ("length"). */
  onCut?: (stop: { outputTokens?: number }) => void;
}

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
   *  the model routes only: the session's MCP door stays behind the session's key. */
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

/** A server's endpoint, `/mcp/<server>`, with no query. */
const MCP_PATH = /^\/mcp\/([a-z][a-z0-9-]{0,31})$/;
/** Where an MCP client looks for OAuth after a 401: never served here, so it never starts a sign-in against the proxy. */
const OAUTH_PATH = /^\/(?:\.well-known\/|register(?:$|[/?]))/;
const UNSAFE_PATH = /[^A-Za-z0-9/_.\-?=&]|\.\.|\/\/|^[^/]|\?.*\?/;
const MAX_BODY = 32 * 1024 * 1024;
/** How much of a response's start and end the proxy keeps to read its usage from. */
const USAGE_WINDOW = 64 * 1024;
/** How long an answer the provider stopped on its content filter is still read after its client left, or the proxy began
 *  to close, so the request is booked at the usage its end reports; past it, it is cut off as any other. */
const FILTERED_DRAIN_MS = 5_000;
/** How much of the start of each line of an answer the proxy keeps, for its last LINE_STARTS whole lines: an event's name
 *  and the first fields of its data, which a stop can be read from when the event's line is longer than either window. */
const LINE_START = 16 * 1024;
const LINE_STARTS = 4;

/** A response header that names the request: the provider's `request-id` (`x-request-id`), or a gateway's own call id
 *  (LiteLLM's `x-litellm-call-id`, the id its spend log records; `llm_provider-request-id`, the provider's passed on). */
const ID_HEADER = /^(?:[a-z0-9]+[-_])*(?:request|call)[-_]id$/;
/** What an id looks like: nothing else (a cookie, a token, prose) is ever kept. */
const ID_VALUE = /^[A-Za-z0-9_.:-]{1,200}$/;

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
    if (typeof overhead !== "number" || !Number.isSafeInteger(overhead) || overhead < 0) throw new Error(`not a token count: ${String(overhead).slice(0, 40)}`);
    return Buffer.byteLength(sent, "utf8") + overhead;
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
  const refusedStatus = policy.refusedStatus ?? 400;
  /** Why the turn's answer stopped, once the harness was told (onCut, onFiltered): the session's answer requests are
   *  refused, unsent and unbooked, until it opens its next turn (openTurn). A client that asks again (Codex retries an
   *  incomplete stream) is never paid for, whether or not the harness's own stop beat it. */
  let stopTold: string | undefined;
  const inflight = new Set<AbortController>();
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
  const refuse = (res: ServerResponse, status: number, message: string, req?: IncomingMessage) => {
    // Every refusal is reported, so a client that calls something the table does not hold is seen, not silently refused.
    // The client's user-agent names who called: the session's own harness, or another local process that found the port.
    const agent = req?.headers["user-agent"];
    say(`model proxy (${policy.id}): refused`, {
      status, method: String(req?.method ?? "").slice(0, 16), path: String(req?.url ?? "").slice(0, 200), reason: message.slice(0, 200),
      ...(typeof agent === "string" && agent ? { userAgent: agent.slice(0, 120) } : {}),
    });
    res.writeHead(status, { "content-type": "application/json", connection: "close" });
    res.end(JSON.stringify({ error: { message, type: "agentrun_proxy" } }));
  };

  // The session's MCP door, mounted once here for whichever harness's client calls it (the call id from its fact).
  const mcpDoor: McpHandler | undefined = options.mcp && mcpRoute(options.mcp.session, { callIdMeta: options.mcp.client.callIdMeta, ...(options.mcp.keepaliveMs !== undefined ? { keepaliveMs: options.mcp.keepaliveMs } : {}) });

  const serve = async (req: IncomingMessage, res: ServerResponse) => {
    // A request refused before its body is read is drained, so its client gets the answer instead of a reset.
    res.once("finish", () => { if (!req.complete) req.resume(); });
    const path = req.url ?? "";
    if (options.mcp && OAUTH_PATH.test(path)) {
      res.writeHead(404, { "content-length": "0" });
      return res.end();
    }
    const mcp = mcpDoor ? MCP_PATH.exec(path) : null;
    if (mcp) {
      if (!sameKey(policy.keyOf(req.headers), key)) return refuse(res, 401, "this session's key is required", req);
      if (closing) return refuse(res, 503, "the model proxy is closing", req);
      return mcpDoor!(mcp[1]!, req, res);
    }
    let route: ProxyRoute;
    let query: string;
    try { ({ route, query } = matchRoute(policy.routes, req.method ?? "", req.url ?? "")); } catch (error) {
      // Without the key every request that is not a local route gets the same answer, so the table can't be mapped.
      if (!sameKey(policy.keyOf(req.headers), key)) return refuse(res, 401, "this session's key is required", req);
      const e = error as ProxyRefusal;
      return refuse(res, e.status ?? 403, e.message, req);
    }
    // A local route forwards nothing and answers only a status, so it needs no key: a client's connectivity check
    // (the Claude Agent CLI's `HEAD /api/hello`) is sent without one.
    if (route.local !== undefined) {
      res.writeHead(route.local, { "content-length": "0" });
      return res.end();
    }
    // The session's key (the harness's requests), or a side key the host holds (its own, labelled).
    const sentKey = policy.keyOf(req.headers);
    const host = sameKey(sentKey, key) ? undefined : sideOf(sentKey);
    if (host === undefined && !sameKey(sentKey, key)) return refuse(res, 401, "this session's key is required", req);
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
      body = policy.apply(parseStrict(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))), route, host === undefined ? {} : { host });
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
    // A note the host has for the session's next main-model request (the spend cap's wrap-up): a paid request on the
    // session's model whose policy can place it takes it, once, before the body is measured, so the cap admits its bytes.
    // Only the turn's own request (ProviderPolicy.answers): a side call on the session's model (a title, a summary, when
    // the client has no small model) takes none. One the policy fails to place is dropped, said once; the request goes as
    // the client sent it. The body as the client sent it is kept (`plain`): a request the cap admits only without the
    // note's bytes goes as that (ModelTicket.noteDropped).
    let noted = false;
    let plain: Record<string, unknown> | undefined;
    // Never on the host's own request (`host`): the note is for the harness's model, in its own conversation, so a host
    // request is neither measured for it nor noted.
    if (!route.free && asked === model && host === undefined && (policy.answers ? policy.answers(body) : true) && policy.addNote && hooks.note) {
      // The request as its client sent it, measured first, so the host prices it as its admission will (the wrap-up's least).
      let request: NoteRequest = {};
      try {
        const measured = inputTokensMaxOf(policy, body, JSON.stringify(body), say);
        const askedOut = policy.outputAsked?.(body);
        const leastOut = policy.outputLeast?.(body);
        const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);
        request = { ...(count(measured) === undefined ? {} : { inputTokensMax: measured as number }), ...(count(askedOut) === undefined ? {} : { outputTokensAsked: askedOut as number }), ...(count(leastOut) === undefined ? {} : { outputTokensLeast: leastOut as number }) };
      } catch {
        request = {};
      }
      const note = hooks.note(asked, request);
      if (note) {
        try {
          const without = body;
          body = policy.addNote(body, note);
          plain = without;
          noted = true;
        } catch (error) {
          say(`model proxy (${policy.id}): the host's note could not be placed; the request goes without it`, { error: String((error as Error)?.message ?? error).slice(0, 200) });
        }
      }
    }
    // The body as it is sent, and the most input tokens it can be billed for, measured before the runner is asked.
    let sent: string;
    try {
      sent = JSON.stringify(body);
    } catch (error) {
      say(`model proxy (${policy.id}): the body could not be serialized`, { error: String((error as Error)?.message ?? error).slice(0, 200) });
      return refuse(res, 500, "the body could not be serialized", req);
    }
    let inputTokensMax = inputTokensMaxOf(policy, body, sent, say);
    // The same, of the body as the client sent it, when a note was placed: the cap checks the request without the note.
    let plainSent: string | undefined;
    let inputTokensMaxWithoutNote: number | undefined;
    if (plain) {
      try {
        plainSent = JSON.stringify(plain);
        inputTokensMaxWithoutNote = inputTokensMaxOf(policy, plain, plainSent, say);
      } catch {
        plainSent = undefined;
      }
    }
    // What the body asks for at most, and the least it may be limited to, as the policy reads them. One the policy cannot
    // read leaves the request's worst case unknown: its input is unmeasured.
    const figure = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);
    let outputTokensAsked: number | undefined;
    let outputTokensLeast: number | undefined;
    /** The reasoning a stop of this request leaves unseen (the policy's `reasoningHidden`), in tokens. */
    let hiddenTokens = 0;
    /** The content and the reasoning the client was sent, by the policy's reading of each event (content: text,
     *  reasoning and tool arguments; reasoning: what of its reasoning streamed). */
    const sentOf = eventCounter({ content: policy.contentBytesOf?.bind(policy), reasoning: policy.reasoningBytesOf?.bind(policy) });
    try {
      outputTokensAsked = figure(policy.outputAsked?.(body));
      outputTokensLeast = figure(policy.outputLeast?.(body));
      hiddenTokens = figure(policy.reasoningHidden?.(body)) ?? 0;
    } catch (error) {
      say(`model proxy (${policy.id}): the policy could not read the body's output; its worst case is unmeasured`, { error: String((error as Error)?.message ?? error).slice(0, 200) });
      inputTokensMax = undefined;
    }
    // The provider's credential and its headers come before the runner is asked: a request that could not be sent is
    // refused without being admitted, so it is never booked and spends no turn.
    let credential = "";
    try {
      credential = await options.credential();
    } catch (error) {
      say(`model proxy (${policy.id}): the provider credential could not be read`, { error: String((error as Error)?.message ?? error).slice(0, 200) });
    }
    if (!credential) return refuse(res, 500, "the session has no provider credential", req);
    try {
      // The host's own headers, over any the client sent by those names; then the credential's, over everything. A name
      // replaces any other spelling of it, so no two headers of one name reach the provider combined.
      const set = (name: string, value: string) => {
        for (const sent of Object.keys(headers)) if (sent.toLowerCase() === name.toLowerCase()) delete headers[sent];
        headers[name] = value;
      };
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
    // This request's own admission, handed back to its booking (requests may be in flight together).
    let ticket: unknown;
    try {
      if (!route.free) ticket = await hooks.beforeRequest({
        // A side call: on another model than the session's, or the host's own (it counts toward no typical request).
        model: asked, inputTokensMax, ...(asked !== model || host !== undefined ? { side: true as const } : {}),
        ...(noted ? { noted: true as const, ...(inputTokensMaxWithoutNote === undefined ? {} : { inputTokensMaxWithoutNote }) } : {}),
        ...(outputTokensAsked === undefined ? {} : { outputTokensAsked }),
        ...(outputTokensLeast === undefined ? {} : { outputTokensLeast }),
        ...(host === undefined ? {} : { host }),
      });
    } catch (error) {
      // Not 429: clients retry that, and the runner already refused this request (a turn cap, the host's budget).
      return refuse(res, refusedStatus, `refused before it was sent: ${String((error as Error)?.message ?? error).slice(0, 300)}`, req);
    }
    /** An admitted request that is not sent after all: refused to its client, and released, booked at nothing, so the
     *  runner's count agrees. */
    const release = async (status: number, message: string) => {
      refuse(res, status, message, req);
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
    let tail = "";
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
    const settled = (): void => {
      if (!drained) return;
      draining.delete(controller);
      drained();
    };
    /** The start of the line being read (LINE_START) and of the last whole lines (LINE_STARTS). */
    let lineStart = "";
    let lineLength = 0;
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
      let stop: { outputTokens?: number } | undefined;
      try {
        stop = policy.cut(text, starts);
      } catch (error) {
        say(`model proxy (${policy.id}): whether the provider cut the answer at its output limit could not be read`, { error: String((error as Error)?.message ?? error).slice(0, 200) });
      }
      if (!stop) return;
      cutTold = true;
      say(`model proxy (${policy.id}): the provider cut the answer at its output limit`);
      // The harness ends the turn: until it opens its next, the session's answer requests are refused.
      stopTold = "cut at the model's output limit";
      try {
        options.onCut(stop);
      } catch (error) {
        say(`model proxy (${policy.id}): onCut threw`, { error: String((error as Error)?.message ?? error).slice(0, 200) });
      }
    };
    /** The answer's stops, read from what has come of it so far: its content-filter stop, and its cut. */
    const tellStops = (text: string): void => {
      tellFiltered(text);
      tellCut(text);
    };
    try {
      // From here a paid request may be paid, so every way out below books it exactly once.
      const upstream = await forward(`${origin}${route.path}${query ? `?${query}` : ""}`, { method: route.method, headers, body: sent, signal: controller.signal });
      // The provider answered (and a paid request was paid): a host callback that throws must not lose the answer or
      // its booking.
      try {
        options.onResponse?.({ method: route.method, path: route.path, free: route.free === true, status: upstream.status });
      } catch (error) {
        say(`model proxy (${policy.id}): onResponse threw`, { error: String((error as Error)?.message ?? error).slice(0, 200) });
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
      res.writeHead(upstream.status, { "content-type": contentType });
      const decoder = new TextDecoder();
      // The provider's own words in an error reach the harness with the credential this proxy sent, and the values of the
      // headers it added, cut out, then the host's redactor (errorCut): an error answer, or an error event in a stream.
      const relay = errorCut(
        !upstream.ok ? "error" : /^text\/event-stream\b/i.test(contentType) ? "events" : "as-is",
        echoForms([credential, ...Object.values(hostHeaders).filter((value) => value.length >= 8)]),
        options.redact,
        (message) => say(`model proxy (${policy.id}): ${message}`),
      );
      const write = async (out: string): Promise<void> => {
        if (!out || res.destroyed) return;
        const bytes = Buffer.from(out, "utf8");
        sentBytes += bytes.byteLength;
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
          // A line longer than the window is read as it ends, from its start, while the lines just before it (an event's
          // name) are still the last starts kept: a piece may carry the lines after it too.
          const window = (tail + text).slice(-USAGE_WINDOW);
          const lines = text.split("\n");
          for (let at = 0; at < lines.length; at++) {
            if (lineStart.length < LINE_START) lineStart += lines[at]!.slice(0, LINE_START - lineStart.length);
            lineLength += lines[at]!.length;
            if (at < lines.length - 1) {
              starts.push(lineStart);
              if (starts.length > LINE_STARTS) starts.shift();
              if (upstream.ok && lineLength > USAGE_WINDOW) tellStops(window);
              lineStart = "";
              lineLength = 0;
            }
          }
          if (upstream.ok && lines.length > 1) tellStops(window);
          // A client gone after the stop was told is written nothing more: the answer is read on for its usage alone.
          const out = relay.push(text);
          await write(out);
          // The usage is at the start, the end, or both: keep those, not the whole answer.
          length += text.length;
          sentOf.push(out);
          if (head.length < USAGE_WINDOW) head += text.slice(0, USAGE_WINDOW - head.length);
          tail = (tail + text).slice(-USAGE_WINDOW);
        }
        // What the relay held at the answer's end: an error event's or an error body's rest, cut.
        const rest = relay.end();
        await write(rest);
        sentOf.push(rest);
      }
      res.end();
      answered = { ok: upstream.ok };
    } catch (error) {
      // Its client had left before this (a stop): read now, as the proxy's own end below closes the response too.
      // Before any header too: the request left, and the provider may have begun it, as a stop part way. Only this proxy's
      // abort ends a stop: an answer read on after its client left (its content-filter stop) that the provider ends with
      // an error is no stop.
      stoppedByClient = clientLeft && (began === undefined || began.ok) && controller.signal.aborted;
      if (!began) failedCode = rejectionCode(error);
      say(`model proxy (${policy.id}): the request did not complete`, { error: String((error as Error)?.message ?? error).slice(0, 200) });
      if (!res.headersSent) refuse(res, 502, "the provider did not answer", req);
      else res.destroy();
    } finally {
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
      try {
        usage = policy.usageOf(length <= USAGE_WINDOW ? tail : `${head}\n${tail}`);
      } catch (error) {
        say(`model proxy (${policy.id}): the usage could not be read; the request is booked at an unknown cost`, { error: String((error as Error)?.message ?? error).slice(0, 200) });
        usage = { input: 0, output: 0, cacheRead: 0 };
        unread = true;
      }
      if (!usage) {
        usage = { input: 0, output: 0, cacheRead: 0 };
        unread = true;
      }
      try {
        usd = unread ? null : options.price?.(asked, usage) ?? null;
      } catch (error) {
        say(`model proxy (${policy.id}): the price could not be computed; the request is booked at an unknown cost`, { error: String((error as Error)?.message ?? error).slice(0, 200) });
        usd = null;
      }
      // What the gateway says it cost is what was paid; the table's figure stays beside it, to audit the table.
      if (reported !== undefined) {
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
      const ended: Ended = stoppedByClient && usd === null ? { end: "stopped", streamedTokens: streamed + Math.max(0, hiddenTokens - sentOf.bytes("reasoning")) }
        : !seen ? (isConnectCode(failedCode) ? { end: "nothing", label: "never_left" } : { end: "lost", label: "error_before" })
        : !seen.ok ? (isGatewayTimeout(began?.status ?? 0) ? { end: "lost", label: "gateway_timeout" } : { end: "nothing", label: "status" })
        : !answered && usd === null ? { end: "lost", label: "error_after", began: true }
        : { end: "answered", usd, ...(filteredTold ? { label: "filtered" as const } : {}) };
      await hooks.afterRequest({ ...usage, usd, ...(own ? {} : { estimated: true }), ...(tableUsd === undefined ? {} : { tableUsd }), ...(ids ? { providerIds: ids } : {}), ...stopped }, ticket, ended);
    } catch (error) {
      say(`model proxy (${policy.id}): afterRequest threw; the request was answered and not booked`, { error: String((error as Error)?.message ?? error).slice(0, 200) });
    }
    // An answer whose stop no piece showed before it ended (a whole JSON body): read whole once it is booked.
    if (seen?.ok) tellStops(length <= USAGE_WINDOW ? tail : `${head}\n${tail}`);
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
