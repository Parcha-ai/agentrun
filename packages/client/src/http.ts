// What the client and its live calls (live.ts) share: the request they hand to the client's `send`, timers, backoff, and
// the check of a path argument.
import { AgentRunUsage } from "./errors.js";

/** What the client's `send` takes: a request already checked, its path under the base URL. */
export interface Exchange {
  method: string;
  path: string;
  route: string;
  headers?: Record<string, string>;
  body?: BodyInit;
  retryable: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** When the whole call must end (a wait's timeout): past it, `send` throws LATE. */
  deadline?: number;
  /** The body carried a secret: a refusal keeps only its code. */
  secret?: boolean;
  /** The success's body is left to the caller, unread (a stream, a download asked for as a Response); else it is read
   *  whole inside the exchange, so a body cut midway is tried again or refused as any dropped connection is. */
  streamed?: boolean;
}

/** Thrown by `send` once an exchange's deadline passed. */
export const LATE = Symbol("late");

// A header value fetch takes: no line break or other control character, nothing outside Latin-1.
export const BAD_HEADER = /[\0-\x08\x0a-\x1f\x7f]|[^\0-\xff]/;
const BACKOFF_MS = 500;
/** The longest Retry-After waited out: past it a GET is not tried again (the call fails rather than hang), and a
 *  stream's reconnect waits this long. */
export const MAX_RETRY_AFTER_MS = 60_000;
const MAX_BACKOFF_MS = 30_000;

/** A count of milliseconds as timers take it: a whole number, at least 1 (AbortSignal.timeout throws on a fraction). */
export const wholeMs = (ms: number) => Math.max(1, Math.ceil(ms));
/** The wait before try `tries + 1`: doubling up to its cap, and never under the server's own (`floor`). */
export const backoff = (tries: number, floor = 0) => Math.max(floor, Math.min(MAX_BACKOFF_MS, BACKOFF_MS * 2 ** (tries - 1)));
/** Waits `ms`, or rejects with the signal's reason once it aborts. */
export function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => (signal?.removeEventListener("abort", stop), resolve()), wholeMs(ms));
    const stop = () => (clearTimeout(timer), reject(signal!.reason));
    signal?.addEventListener("abort", stop, { once: true });
  });
}

/** A path argument checked and encoded: whole, or, for a file path, segment by segment. One that fetch or the server
 *  would read as another route (empty, `.`, `..`, plain or encoded, or an encoded slash in a file path) is refused. */
export function segmentOf(value: unknown, name: string, multiSegment: boolean): string {
  if (typeof value !== "string" || value === "") throw new AgentRunUsage(`${name} must be a string that is not empty.`);
  const segments = value.split("/");
  if (segments.some((segment) => [".", ".."].includes(segment.replace(/%2e/gi, ".")))) throw new AgentRunUsage(`${name} may not hold a . or .. path segment, plain or encoded.`);
  if (!multiSegment) return encodeURIComponent(value);
  if (segments.some((segment) => segment === "" || /%2f/i.test(segment))) throw new AgentRunUsage(`${name} may not hold an empty segment or an encoded slash.`);
  return segments.map(encodeURIComponent).join("/");
}

