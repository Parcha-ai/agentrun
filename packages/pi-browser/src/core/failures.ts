// The failure envelope every browser and web tool returns with `isError: true`, and the classifier that picks its
// code. A class comes from typed facts only (the HTTP status, error class names and system codes on the cause chain,
// the facade's exported refusal strings compared by identity, what the call knows of itself), never from reading an
// error's message; the message is detail for the model.

export const FAILURE_CODES = Object.freeze([
  "browser_unavailable", "auth", "timeout", "aborted", "refused", "stale_snapshot", "session_ended",
  "session_replaced", "effect_unknown", "code_error", "command_failed", "not_content", "blocked", "rate_limited",
] as const);
export type FailureCode = (typeof FAILURE_CODES)[number];

export type BrowserFailure = {
  ok: false;
  code: FailureCode;
  retryable: boolean;
  /** Whether the page may have changed: a failed read never effected anything; a failed `run` may have. */
  effect: "none" | "possibly_effected";
  /** The way out, in the package's words. */
  message: string;
  /** Provider or page text, at most 2,000 characters; redacted before it reaches the model. */
  detail?: string;
};

/** What the call itself knows: the provider reported its session no longer running, the run cancelled it, or it ran
 *  to the batch deadline the driver set (Stagehand reports that as a plain Error). */
export type FailureFacts = { sessionEnded?: boolean; aborted?: boolean; timedOut?: boolean };

/** The Stagehand facade's own snapshot refusals, exported by its contract and compared by identity. The vendored
 *  facade's drift test holds these equal to upstream's constants. */
export const NO_HYDRATED_SNAPSHOT_ERROR = "No hydrated snapshot exists for the active page; call snapshot first.";
export const NAVIGATED_SNAPSHOT_ERROR = "The active page navigated after its snapshot; call snapshot again.";
export const STALE_SNAPSHOT_ID_ERROR = 'Snapshot ID "${id}" is stale or not actionable; call snapshot again.';

const [STALE_ID_HEAD, STALE_ID_TAIL] = STALE_SNAPSHOT_ID_ERROR.split("${id}");
/** One of the facade's refusals: identity with its constants, the one templated by the element id compared around
 *  that id. */
const isStaleSnapshot = (message: string): boolean => message === NO_HYDRATED_SNAPSHOT_ERROR || message === NAVIGATED_SNAPSHOT_ERROR
  || (message.startsWith(STALE_ID_HEAD) && message.endsWith(STALE_ID_TAIL) && message.length > STALE_ID_HEAD.length + STALE_ID_TAIL.length);

/** System codes on an error's cause chain, and error class names, of a browser that cannot be reached. */
const UNREACHABLE_CAUSES = new Set(["ECONNREFUSED", "ENOTFOUND", "ECONNRESET", "EAI_AGAIN", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);
const UNREACHABLE_NAMES = new Set(["CDPConnectionClosedError"]);

export type TransportFact = { status?: number; errorName?: string; causeCode?: string };

/** The typed facts an error carries: a `transport` record a throw site attached, else its class name, its string
 *  `code` and a numeric `status`, walking the cause chain; the first value found for each field wins. */
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

/** Classify an SDK or facade error. `effectful` is true for a call that may act on the page (`run`). */
export function classifyBrowserError(error: unknown, effectful: boolean, facts: FailureFacts = {}): BrowserFailure {
  // Stagehand wraps SDK failures ("Failed to upload the Stagehand extension…", { cause }); the HTTP status and the
  // real message live on the cause.
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
  // The session is gone (the provider closed it at its timeout, or the browser died): the code the model wrote is not
  // at fault, and no retry against this session can succeed.
  if (facts.sessionEnded) return { ok: false, code: "session_ended", retryable: true, effect, message: "The browser session ended (Browserbase closes a session at its timeout, or the browser died). Your next browser call opens a fresh session automatically; the old tabs, page state and cookies are gone — navigate to the page again with run, then continue from there.", detail };
  if (facts.timedOut || fact.errorName === "TimeoutError") return { ok: false, code: "timeout", retryable: true, effect, message: "The browser call timed out. Take a fresh snapshot before acting again; split a long `run` into smaller batches; if the page never loads, use web_fetch or another source.", detail };
  if (isStaleSnapshot(own)) return { ok: false, code: "stale_snapshot", retryable: true, effect: "none", message, detail };
  if ((fact.causeCode && UNREACHABLE_CAUSES.has(fact.causeCode)) || (fact.errorName && UNREACHABLE_NAMES.has(fact.errorName))) return { ok: false, code: "browser_unavailable", retryable: false, effect, message: "The browser could not be reached on this lane. The browser plane is unavailable for this run; use web_fetch or executor tools.", detail };
  return { ok: false, code: effectful ? "code_error" : "command_failed", retryable: true, effect, message: effectful ? `Your browser code threw: ${message.slice(0, 600)}` : `The browser call failed: ${message.slice(0, 600)}`, detail };
}
