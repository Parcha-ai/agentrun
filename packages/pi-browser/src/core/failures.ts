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
};

export const browserFailure = (code: FailureCode, message: string, options: { retryable?: boolean; effect?: BrowserFailure["effect"]; detail?: string } = {}): BrowserFailure =>
  ({ ok: false, code, retryable: options.retryable ?? false, effect: options.effect ?? "none", message, ...(options.detail === undefined ? {} : { detail: options.detail }) });

/** `timedOut`: the call ran to the driver's batch deadline, which Stagehand reports as a plain Error. */
/** `action`: what an effectful call ran, named when it threw; "Your browser code" when unset. */
/** `redact` removes the run's registered values from the error text; it runs over the whole text before any cut below, so no fragment of a value survives a cut point. */
export type FailureFacts = { sessionEnded?: boolean; aborted?: boolean; timedOut?: boolean; action?: string; redact?: (text: string) => string };

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
const lostLoopback = (error: unknown): boolean => {
  const cause = (error as any)?.cause;
  return !!cause && typeof cause === "object" && cause.code === JSONRPC_INTERNAL_ERROR && cause.message === STAGEHAND_LOOPBACK_DISCONNECTED;
};

const UNREACHABLE_CAUSES = new Set(["ECONNREFUSED", "ENOTFOUND", "ECONNRESET", "EAI_AGAIN", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);
// A host call the browser left unanswered past its deadline is a dropped connection too.
const UNREACHABLE_NAMES = new Set(["CDPConnectionClosedError", UNANSWERED_CALL]);

export type TransportFact = { status?: number; errorName?: string; causeCode?: string };

/** A throw site's `transport` record, else class name, `code` and `status` down the cause chain; first found wins. */
export function transportFactOf(error: unknown): TransportFact {
  const out: TransportFact = {};
  let current: any = error;
  for (let depth = 0; current && typeof current === "object" && depth < 6; depth += 1, current = current.cause) {
    const attached = current.transport;
    if (attached && typeof attached === "object") {
      for (const [key, value] of Object.entries(attached as TransportFact)) if (value !== undefined && (out as any)[key] === undefined) (out as any)[key] = value;
    }
    if (out.errorName === undefined && typeof current.name === "string" && current.name !== "Error") out.errorName = current.name;
    if (out.causeCode === undefined && typeof current.code === "string" && current.code) out.causeCode = current.code;
    if (out.status === undefined && Number.isInteger(current.status)) out.status = current.status;
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
  const cause = (error as any)?.cause;
  const own = error instanceof Error ? error.message : String(error);
  const message = (facts.redact ?? ((text: string) => text))(withCause(own, cause));
  const fact = transportFactOf(error);
  const status = fact.status ?? Number((error as any)?.statusCode ?? cause?.statusCode ?? NaN);
  const effect = effectful ? "possibly_effected" : "none";
  const detail = message.slice(0, 2_000);
  if (facts.aborted || fact.errorName === "AbortError") return browserFailure("aborted", "The browser call was cancelled by the run.", { effect, detail });
  if (status === 401) return browserFailure("auth", "The browser provider refused the credential (401). The browser plane is unavailable for this run; use fetch (executor tools).", { detail });
  if (status === 403) return browserFailure("auth", "The browser provider refused this session type (403). Retry without `verified`, or use web_fetch.", { detail });
  if (facts.sessionEnded) return browserFailure("session_ended", "The browser session ended (the provider closed it at its timeout, or the browser died). Your next browser call opens a fresh session automatically; the old tabs, page state and cookies are gone — navigate to the page again with run, then continue from there.", { retryable: true, effect, detail });
  if (facts.timedOut || fact.errorName === "TimeoutError") return browserFailure("timeout", "The browser call timed out. Take a fresh snapshot before acting again; split a long `run` into smaller batches; if the page never loads, use web_fetch or another source.", { retryable: true, effect, detail });
  if (isStaleSnapshot(own)) return browserFailure("stale_snapshot", message, { retryable: true, detail });
  if ((fact.causeCode && UNREACHABLE_CAUSES.has(fact.causeCode)) || (fact.errorName && UNREACHABLE_NAMES.has(fact.errorName)) || lostLoopback(error)) return browserFailure("browser_unavailable", "The browser could not be reached on this lane. The browser plane is unavailable for this run; use web_fetch or executor tools.", { effect, detail });
  return browserFailure(effectful ? "code_error" : "command_failed", effectful ? `${facts.action ?? "Your browser code"} threw: ${message.slice(0, 600)}` : `The browser call failed: ${message.slice(0, 600)}`, { retryable: true, effect, detail });
}
