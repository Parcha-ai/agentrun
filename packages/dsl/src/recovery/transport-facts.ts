// What a request's transport knew when it failed, and the retry class an effect earns from it.
//
// A failure is classified from typed fields the error carries (the HTTP status, the thrown error's
// class name, the system code on it or its cause, which deadline cut a silent stream), never from
// the text of an error message.

import type { CallRetryClass } from "../workflow.js";

export type TransportFact = {
  /** The HTTP status the response carried, when one arrived. */
  status?: number;
  /** The thrown error's class name: TimeoutError (a deadline), AbortError, TypeError. */
  errorName?: string;
  /** The Node or undici system code on the error or its cause chain (ECONNRESET, UND_ERR_SOCKET, ENOTFOUND). */
  causeCode?: string;
  /** The provider's error object `type`, when a throw site attached it. */
  providerType?: string;
  /** The provider's error object `code`, from the same place. */
  providerCode?: string;
  /** Which deadline cut a silent stream: no response headers, or no bytes mid-body. */
  idle?: "headers" | "body";
};

// ---- reading typed fields off a thrown error ----------------------------------------------------

const asCode = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);

/** The typed facts an error carries: a `transport` record a throw site attached, else its class
 *  name, its string `code` (a system code) and a numeric `status`, walking the cause chain; the
 *  first value found for each field wins. Message text is never read. */
export function transportFactOf(error: unknown): TransportFact {
  const out: TransportFact = {};
  let current: any = error;
  for (let depth = 0; current && typeof current === "object" && depth < 6; depth += 1, current = current.cause) {
    const attached = current.transport;
    if (attached && typeof attached === "object") {
      for (const [key, value] of Object.entries(attached as TransportFact)) if (value !== undefined && (out as any)[key] === undefined) (out as any)[key] = value;
    }
    if (out.errorName === undefined && typeof current.name === "string" && current.name !== "Error") out.errorName = current.name;
    if (out.causeCode === undefined && asCode(current.code)) out.causeCode = asCode(current.code);
    if (out.status === undefined && Number.isInteger(current.status)) out.status = current.status;
  }
  return out;
}

// ---- effects (tool calls) -------------------------------------------------------------------------

const TIMEOUT_CAUSES = new Set(["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);
const CONNECTION_CAUSES = new Set(["ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "EPIPE", "ECONNABORTED", "UND_ERR_SOCKET", "UND_ERR_CLOSED"]);

/** The retry class a failed effect earns from its typed facts, or null: only a failure transient
 *  by nature (a deadline, a 408 or 429, a 5xx, a dropped or refused connection) earns one. The
 *  classes are the workflow's call retry classes. */
export function effectRetryClass(fact: TransportFact): CallRetryClass | null {
  if (fact.errorName === "TimeoutError" || fact.idle || fact.status === 408 || (fact.causeCode && TIMEOUT_CAUSES.has(fact.causeCode))) return "timeout";
  if (fact.status === 429) return "http_429";
  if (fact.status !== undefined && fact.status >= 500 && fact.status <= 599) return "http_5xx";
  if (fact.causeCode && CONNECTION_CAUSES.has(fact.causeCode)) return "connection";
  return null;
}
