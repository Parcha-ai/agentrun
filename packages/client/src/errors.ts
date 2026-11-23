// One error class per way a call can fail, the outcome kinds every client of the server maps to its own idiom (the CLI to
// an exit code, this client to a class). No message holds the API key or a secret a body carried: a message names the
// route, the status, the server's error code and its reason, read from the error object the client keeps (the key cut
// from it; after a secret body, no reason).
import type { Run } from "./operations.generated.js";

/** The server's error object (`{ code, message, ... }`), with every copy of the API key cut from its values and keys. */
export type ServerError = Record<string, unknown>;

/** The most of the server's reason a message carries. */
export const REASON_CHARS = 300;

/** The server's reason as a message's end: `: <its message>`, on one line, at most REASON_CHARS characters (code points);
 *  empty when the error object holds no message. `error` is the one the client keeps, the key already cut from it. */
export function said(error: ServerError | undefined): string {
  const message = error?.message;
  if (typeof message !== "string" || !message.trim()) return "";
  const line = [...message.trim().split(/\s+/).join(" ")];
  return `: ${line.length <= REASON_CHARS ? line.join("") : `${line.slice(0, REASON_CHARS - 1).join("")}…`}`;
}

/** What every error of this client is: `kind` says which outcome it is. */
export abstract class AgentRunError extends Error {
  abstract readonly kind: "refused" | "auth" | "unsupported" | "unreachable" | "usage" | "late";
}

/** The server answered and refused: a 4xx or 5xx other than 401, 403 and 501; a redirect it would take the key along
 *  to follow (`code` `redirect`); or an answer this client cannot read (`code` `bad_answer`). */
export class AgentRunRefused extends AgentRunError {
  readonly kind = "refused";
  readonly status: number;
  readonly code: string | undefined;
  readonly error: ServerError | undefined;
  /** How long the server asked to be left before the same request again (its Retry-After), in milliseconds. */
  readonly retryAfterMs: number | undefined;
  constructor(route: string, status: number, code: string | undefined, error: ServerError | undefined, why?: string, retryAfterMs?: number) {
    super(why ?? `The server refused ${route}: ${status}${code ? ` ${code}` : ""}${said(error) || "."}`);
    this.name = "AgentRunRefused";
    this.status = status;
    this.code = code;
    this.error = error;
    this.retryAfterMs = retryAfterMs;
  }
}

/** No API key, one that is not a valid header value (refused before any request), or one the server refused (401, 403). */
export class AgentRunAuthError extends AgentRunError {
  readonly kind = "auth";
  readonly reason: "no_token" | "bad_header" | "refused";
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly error: ServerError | undefined;
  constructor(reason: "no_token" | "bad_header" | "refused", message: string, answer?: { status: number; code?: string; error?: ServerError }) {
    super(message);
    this.name = "AgentRunAuthError";
    this.reason = reason;
    this.status = answer?.status;
    this.code = answer?.code;
    this.error = answer?.error;
  }
}

/** The server does not offer this operation here (501 `unsupported_here`); `capability` names what is off. */
export class AgentRunUnsupported extends AgentRunError {
  readonly kind = "unsupported";
  readonly by = "server";
  readonly capability: string | undefined;
  readonly status: number;
  readonly code: string | undefined;
  readonly error: ServerError | undefined;
  constructor(route: string, status: number, code: string | undefined, error: ServerError | undefined) {
    const capability = typeof error?.capability === "string" ? error.capability : undefined;
    super(`The server does not offer ${route} here${capability ? ` (${capability} is off)` : ""}.`);
    this.name = "AgentRunUnsupported";
    this.capability = capability;
    this.status = status;
    this.code = code;
    this.error = error;
  }
}

/** The server could not be reached, or stopped answering. `cause` is the failure's code (ECONNREFUSED, timeout), never
 *  its message, which can quote a header. */
export class AgentRunUnreachable extends AgentRunError {
  readonly kind = "unreachable";
  override readonly cause: string;
  constructor(baseUrl: string, cause: string) {
    super(`Cannot reach the server at ${baseUrl} (${cause}).`);
    this.name = "AgentRunUnreachable";
    this.cause = cause;
  }
}

/** The call was wrong before anything was sent: a bad argument, base URL or option. */
export class AgentRunUsage extends AgentRunError {
  readonly kind = "usage";
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "AgentRunUsage";
    this.reason = reason;
  }
}

/** `runs.wait` passed its `timeoutMs`; the run goes on. `run` is the run as last read, when it was. */
export class AgentRunTimeout extends AgentRunError {
  readonly kind = "late";
  readonly runId: string;
  readonly run: Run | undefined;
  constructor(runId: string, timeoutMs: number, run: Run | undefined) {
    super(`Run ${runId} did not end or wait on a person within ${timeoutMs} ms; it goes on.`);
    this.name = "AgentRunTimeout";
    this.runId = runId;
    this.run = run;
  }
}
