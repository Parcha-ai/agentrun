// A code comes from typed facts only (status, class names, cause-chain codes, refusal constants by identity), never
// from an error's message.

export const FAILURE_CODES = Object.freeze([
  "browser_unavailable", "auth", "timeout", "aborted", "refused", "stale_snapshot", "session_ended",
  "session_replaced", "effect_unknown", "code_error", "command_failed", "not_content", "blocked", "rate_limited",
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

/** `timedOut`: the call ran to the driver's batch deadline, which Stagehand reports as a plain Error. */
export type FailureFacts = { sessionEnded?: boolean; aborted?: boolean; timedOut?: boolean };

export const NO_HYDRATED_SNAPSHOT_ERROR = "No hydrated snapshot exists for the active page; call snapshot first.";
export const NAVIGATED_SNAPSHOT_ERROR = "The active page navigated after its snapshot; call snapshot again.";
export const STALE_SNAPSHOT_ID_ERROR = 'Snapshot ID "${id}" is stale or not actionable; call snapshot again.';

const [STALE_ID_HEAD, STALE_ID_TAIL] = STALE_SNAPSHOT_ID_ERROR.split("${id}");
const isStaleSnapshot = (message: string): boolean => message === NO_HYDRATED_SNAPSHOT_ERROR || message === NAVIGATED_SNAPSHOT_ERROR
  || (message.startsWith(STALE_ID_HEAD) && message.endsWith(STALE_ID_TAIL) && message.length > STALE_ID_HEAD.length + STALE_ID_TAIL.length);

const UNREACHABLE_CAUSES = new Set(["ECONNREFUSED", "ENOTFOUND", "ECONNRESET", "EAI_AGAIN", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);
const UNREACHABLE_NAMES = new Set(["CDPConnectionClosedError"]);

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

export function classifyBrowserError(error: unknown, effectful: boolean, facts: FailureFacts = {}): BrowserFailure {
  // Stagehand wraps SDK failures with { cause }: the HTTP status and the real message live on the cause.
  const cause = (error as any)?.cause;
  const own = error instanceof Error ? error.message : String(error);
  const message = [own, cause instanceof Error ? cause.message : cause ? String(cause) : ""].filter(Boolean).join(": ");
  const fact = transportFactOf(error);
  const status = fact.status ?? Number((error as any)?.statusCode ?? cause?.statusCode ?? NaN);
  const effect = effectful ? "possibly_effected" : "none";
  const detail = message.slice(0, 2_000);
  if (facts.aborted || fact.errorName === "AbortError") return { ok: false, code: "aborted", retryable: false, effect, message: "The browser call was cancelled by the run.", detail };
  if (status === 401) return { ok: false, code: "auth", retryable: false, effect: "none", message: "Browserbase refused the credential (401). The browser plane is unavailable for this run; use fetch (executor tools).", detail };
  if (status === 403) return { ok: false, code: "auth", retryable: false, effect: "none", message: "Browserbase refused this session type (403). Retry without `verified`, or use web_fetch.", detail };
  if (facts.sessionEnded) return { ok: false, code: "session_ended", retryable: true, effect, message: "The browser session ended (Browserbase closes a session at its timeout, or the browser died). Your next browser call opens a fresh session automatically; the old tabs, page state and cookies are gone — navigate to the page again with run, then continue from there.", detail };
  if (facts.timedOut || fact.errorName === "TimeoutError") return { ok: false, code: "timeout", retryable: true, effect, message: "The browser call timed out. Take a fresh snapshot before acting again; split a long `run` into smaller batches; if the page never loads, use web_fetch or another source.", detail };
  if (isStaleSnapshot(own)) return { ok: false, code: "stale_snapshot", retryable: true, effect: "none", message, detail };
  if ((fact.causeCode && UNREACHABLE_CAUSES.has(fact.causeCode)) || (fact.errorName && UNREACHABLE_NAMES.has(fact.errorName))) return { ok: false, code: "browser_unavailable", retryable: false, effect, message: "The browser could not be reached on this lane. The browser plane is unavailable for this run; use web_fetch or executor tools.", detail };
  return { ok: false, code: effectful ? "code_error" : "command_failed", retryable: true, effect, message: effectful ? `Your browser code threw: ${message.slice(0, 600)}` : `The browser call failed: ${message.slice(0, 600)}`, detail };
}
