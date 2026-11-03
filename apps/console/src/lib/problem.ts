import { ClientError } from "./client";
import { Unreachable } from "./connection";

/** A failed read or write, said for a person: what failed, why in plain words, and what to do next. `said` is the
 *  server's own message and `code` its typed code and request id, kept small on the page for a bug report. */
export type Problem = { title: string; why: string; next: string; said?: string; code?: string };

const sentence = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** The server could not be reached: the connection's own refusal of a write, or a browser's failed fetch. */
const unreached = (e: unknown) => e instanceof Unreachable || (e instanceof TypeError && /fetch|network/i.test(e.message));

/** `what` names the thing read ("Mission Control", "the runs"): "Mission Control could not be read." */
export function problem(e: unknown, what: string): Problem {
  const title = `${sentence(what)} could not be read.`;
  if (unreached(e))
    return { title, why: "Can't reach agentrun-serve.", next: "It may be restarting: the console reconnects by itself." };
  if (!(e instanceof ClientError)) return { title, why: "Something went wrong in the console.", next: "Reload the page.", said: e instanceof Error ? e.message : String(e) };
  const said = e.message, code = [e.code, e.requestId].filter(Boolean).join(" · ");
  const of = (why: string, next: string): Problem => ({ title, why, next, said, code });
  if (e.status === 401) return of("This browser is signed out.", "Reload the page to sign in again.");
  if (e.status === 403) return of("The server doesn't allow this here.", "Sign in as the server's owner, or open the console from the address the server printed.");
  if (e.status === 404) return of("This server doesn't have it.", "Check the address, or open the list it belongs to.");
  if (e.status === 429) return of("Too many requests at once.", "Wait a few seconds, then try again.");
  if (e.retryable || e.status === 409 || e.status === 503) return of("The server is busy.", "Try again in a moment.");
  if (e.status >= 500) return of("The server hit a problem on its side.", "Try again. If it keeps failing, the server's log says why.");
  return of("The server turned the request down.", "Its words say why: change what they name, then try again.");
}

/** A title for a request the server did not carry out: "refused" only when it answered with a refusal (a 4xx). */
export function refusalTitle(e: unknown): string {
  if (unreached(e)) return "Can't reach agentrun-serve";
  if (!(e instanceof ClientError)) return "Something went wrong in the console";
  if (e.status >= 500) return "The server hit a problem";
  return "The server refused this";
}
