import { ClientError, problemOf } from "./client";
import type { ComputerAsk, Run } from "./v2";

/** The ask a run waits on the person for at its computer, of either kind (its browser's, or a desktop's or phone's), only
 *  while it waits (input_required); else null. */
export const askOf = (run: Pick<Run, "status" | "pending">): ComputerAsk | null =>
  run.status === "input_required" && (run.pending?.kind === "browser" || run.pending?.kind === "computer") ? run.pending : null;

/** The computer an ask names: its own (`computer`), or the browser for the browser's ask. */
export const askedAt = (ask: ComputerAsk): "browser" | "desktop" | "phone" => (ask.kind === "computer" ? ask.computer : "browser");

/** A refused take-over or hand-back (POST /v2/runs/{id}/computer/take-over, …/hand-back) in words. 409
 *  `handoff_answered`: answered another way first, or expired, by its outcome (else the server's words); 409
 *  `computer_not_live`: the server's own words. 404 on a
 *  hand-back: the agent isn't asking and nobody holds the computer. 403: the routes take the owner's password session
 *  alone, never a token. */
export function computerRefusal(e: unknown, what: "take" | "hand"): string {
  // An ask answered first another way, or past its expiry, names its outcome (`details.outcome`): said in the console's words.
  if (e instanceof ClientError && e.code === "handoff_answered") {
    const outcome = e.details?.outcome;
    if (outcome === "expired") return "The ask expired before your answer: the agent was told.";
    if (outcome === "done" || outcome === "cancelled") return `It was already answered: ${outcome}.`;
    return e.message;
  }
  if (e instanceof ClientError && e.code === "computer_not_live") return e.message;
  if (e instanceof ClientError && e.status === 404) return what === "hand" ? "The agent isn't asking for you now." : "This run has no screen to take over.";
  if (e instanceof ClientError && e.status === 403) return "Sign in with your password to do this from here.";
  return `${what === "hand" ? "Not answered" : "Not taken"}: ${problemOf(e)}`;
}
