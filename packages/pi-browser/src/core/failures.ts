// A code comes from typed facts only (status, class names, cause-chain codes, refusal constants by identity), never
// from an error's message.

import { UNANSWERED_CALL } from "./unanswered.js";

export const FAILURE_CODES = Object.freeze([
  "browser_unavailable", "auth", "timeout", "aborted", "refused", "stale_snapshot", "session_ended",
  "session_replaced", "effect_unknown", "code_error", "command_failed", "not_content", "blocked", "rate_limited", "waiting_for_human",
] as const);
export type FailureCode = (typeof FAILURE_CODES)[number];

export type BrowserFailure = {
  ok: false;
  code: FailureCode;
  retryable: boolean;
  effect: "none" | "possibly_effected";
  message: string;
  /** Provider or page text, at most 2,000 characters; redacted before it reaches the model. */
  detail?: string;
  /** The one step that gets past this failure, when there is one. */
  next?: Next;
  /** The receipt filed for the page that failed (a wall a browser page showed), or null when none was filed. */
  evidence?: string | null;
};

export type Next = { action: "drive_page" | "other_source" | "browser_relaunch"; note: string };

export const browserFailure = (code: FailureCode, message: string, options: { retryable?: boolean; effect?: BrowserFailure["effect"]; detail?: string } = {}): BrowserFailure =>
  ({ ok: false, code, retryable: options.retryable ?? false, effect: options.effect ?? "none", message, ...(options.detail === undefined ? {} : { detail: options.detail }) });

export type FailureFacts = {
  sessionEnded?: boolean;
  aborted?: boolean;
  /** The call ran to the driver's batch deadline, which Stagehand reports as a plain Error. */
  timedOut?: boolean;
  /** What an effectful call ran, named when it threw; "Your browser code" when unset. */
  action?: string;
  /** Removes the run's registered values from the error text; it runs over the whole text before any cut below, so no fragment of a value survives a cut point. */
  redact?: (text: string) => string;
};

/** The vendored facade's refusal texts (vendor/stagehand-facade/contract.ts), copied so the root entry does not load the facade; a test pins
 *  them to the facade's own. */
export const NO_HYDRATED_SNAPSHOT_ERROR = "No hydrated snapshot exists for the active page; call snapshot first.";
export const NAVIGATED_SNAPSHOT_ERROR = "The active page navigated after its snapshot; call snapshot again.";
export const STALE_SNAPSHOT_ID_ERROR = 'Snapshot ID "${id}" is stale or not actionable; call snapshot again.';

const [STALE_ID_HEAD, STALE_ID_TAIL] = STALE_SNAPSHOT_ID_ERROR.split("${id}");
const isStaleSnapshot = (message: string): boolean => message === NO_HYDRATED_SNAPSHOT_ERROR || message === NAVIGATED_SNAPSHOT_ERROR
  || (message.startsWith(STALE_ID_HEAD) && message.endsWith(STALE_ID_TAIL) && message.length > STALE_ID_HEAD.length + STALE_ID_TAIL.length);

/** Stagehand's extension lost its own CDP connection to the browser (a refusal constant of Stagehand's, matched by identity): its
 *  host rethrows it with the extension's JSON-RPC internal error (-32603) as the cause. The driver is gone, not the session. */
export const STAGEHAND_LOOPBACK_DISCONNECTED = "Stagehand loopback CDP is disconnected";
const JSONRPC_INTERNAL_ERROR = -32603;
/** A property of a thrown value when it is an object: errors carry facts (a cause, a code, a status) no type declares. */
const field = (value: unknown, key: string): unknown => (value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined);

const lostLoopback = (error: unknown): boolean => {
  const cause = field(error, "cause");
  return field(cause, "code") === JSONRPC_INTERNAL_ERROR && field(cause, "message") === STAGEHAND_LOOPBACK_DISCONNECTED;
};

const UNREACHABLE_CAUSES = new Set(["ECONNREFUSED", "ENOTFOUND", "ECONNRESET", "EAI_AGAIN", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);
// A host call the browser left unanswered past its deadline is a dropped connection too.
const UNREACHABLE_NAMES = new Set(["CDPConnectionClosedError", UNANSWERED_CALL]);

export type TransportFact = { status?: number; errorName?: string; causeCode?: string };

/** A throw site's `transport` record, else class name, `code` and `status` down the cause chain; first found wins. */
export function transportFactOf(error: unknown): TransportFact {
  const out: TransportFact = {};
  const found = out as Record<string, unknown>;
  for (let depth = 0, current = error; current && typeof current === "object" && depth < 6; depth += 1, current = field(current, "cause")) {
    const attached = field(current, "transport");
    if (attached && typeof attached === "object") {
      for (const [key, value] of Object.entries(attached)) if (value !== undefined && found[key] === undefined) found[key] = value;
    }
    const name = field(current, "name"), code = field(current, "code"), status = field(current, "status");
    if (out.errorName === undefined && typeof name === "string" && name !== "Error") out.errorName = name;
    if (out.causeCode === undefined && typeof code === "string" && code) out.causeCode = code;
    if (out.status === undefined && typeof status === "number" && Number.isInteger(status)) out.status = status;
  }
  return out;
}

/** An error's text with its cause's: a JSON-RPC error object (Stagehand's extension answers with one) gives its own text
 *  and code, never "[object Object]". */
function withCause(own: string, cause: unknown): string {
  if (cause instanceof Error) return [own, cause.message].filter(Boolean).join(": ");
  if (!cause) return own;
  if (typeof cause !== "object") return [own, String(cause)].filter(Boolean).join(": ");
  const { code, message } = cause as { code?: unknown; message?: unknown };
  const text = typeof message === "string" && message && message !== own ? `: ${message}` : "";
  const tag = typeof code === "number" || (typeof code === "string" && code) ? ` (code ${code})` : "";
  return `${own}${text}${tag}`;
}

export function classifyBrowserError(error: unknown, effectful: boolean, facts: FailureFacts = {}): BrowserFailure {
  // Stagehand wraps SDK failures with { cause }: the HTTP status and the real message live on the cause.
  const cause = field(error, "cause");
  const own = error instanceof Error ? error.message : String(error);
  const message = (facts.redact ?? ((text: string) => text))(withCause(own, cause));
  const fact = transportFactOf(error);
  const status = fact.status ?? Number(field(error, "statusCode") ?? field(cause, "statusCode") ?? NaN);
  const effect = effectful ? "possibly_effected" : "none";
  const detail = message.slice(0, 2_000);
  if (facts.aborted || fact.errorName === "AbortError") return browserFailure("aborted", "The browser call was cancelled by the run.", { effect, detail });
  if (status === 401) return browserFailure("auth", "The browser provider refused the credential (401). The browser plane is unavailable for this run; use fetch (executor tools).", { detail });
  if (status === 403) return browserFailure("auth", "The browser provider refused this session type (403). Retry without `verified`, or use web_fetch.", { detail });
  if (status === 429) return browserFailure("rate_limited", `The browser provider is rate limiting this run (429). ${effectful ? "Your call may have acted: take a snapshot before you act again." : "Wait a moment, then try again."}`, { retryable: !effectful, effect, detail });
  if (facts.sessionEnded) return browserFailure("session_ended", "The browser session ended (the provider closed it at its timeout, or the browser died). Your next browser call opens a fresh session automatically; the old tabs, page state and cookies are gone — navigate to the page again with run, then continue from there.", { retryable: true, effect, detail });
  if (facts.timedOut || fact.errorName === "TimeoutError") return browserFailure("timeout", "The browser call timed out. Take a fresh snapshot before acting again; split a long `run` into smaller batches; if the page never loads, use web_fetch or another source.", { retryable: true, effect, detail });
  if (isStaleSnapshot(own)) return browserFailure("stale_snapshot", message, { retryable: true, detail });
  if ((fact.causeCode && UNREACHABLE_CAUSES.has(fact.causeCode)) || (fact.errorName && UNREACHABLE_NAMES.has(fact.errorName)) || lostLoopback(error)) return browserFailure("browser_unavailable", "The browser could not be reached on this lane. The browser plane is unavailable for this run; use web_fetch or executor tools.", { effect, detail });
  return browserFailure(effectful ? "code_error" : "command_failed", effectful ? `${facts.action ?? "Your browser code"} threw: ${message.slice(0, 600)}` : `The browser call failed: ${message.slice(0, 600)}`, { retryable: true, effect, detail });
}
