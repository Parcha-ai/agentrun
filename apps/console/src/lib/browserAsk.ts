import { ClientError, problemOf } from "./client";

/** A refused hand-back (POST /v2/runs/{id}/browser/hand-back) in words. 409 `handoff_answered`: the first answer won, or
 *  the ask expired (`details.outcome`). 403: the route takes the owner's password session alone, never a token (as under
 *  `npm run dev` with a token, or accounts off). */
export function handBackRefusal(e: unknown): string {
  if (e instanceof ClientError && e.code === "handoff_answered") {
    const outcome = e.details?.outcome;
    return outcome === "expired" ? "The ask expired before your answer: the agent was told." : `It was already answered: ${outcome === "cancelled" ? "cancelled" : "done"}.`;
  }
  if (e instanceof ClientError && e.status === 403) return "Sign in with your password to answer from here.";
  return `Not answered: ${problemOf(e)}`;
}
