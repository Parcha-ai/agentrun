import { ClientError, problemOf } from "./client";
import { dollars } from "./format";
import type { PendingApproval, Run } from "./v2";

/** The run's timeline row of a tool call that waited for the owner's approval (serve's tool gate): it follows the call's
 *  result, with its tool_use_id, and says "Waiting for your approval: …" while it waits. */
export const APPROVAL_ROW = "tool_approval_requested";

/** The tool call the run waits on the owner's approval of, only while it waits (input_required, waiting); else null. */
export function approvalOf(run: Pick<Run, "status" | "state" | "pending">): PendingApproval | null {
  if (run.status !== "input_required" || run.state !== "waiting") return null;
  return run.pending?.kind === "approval" ? run.pending : null;
}

/** What one call costs, as the card says it: dollars where its tool names a price, "Not metered" for an unpriced call,
 *  nothing when its tool names none. */
export function priceLine(price: PendingApproval["price"]): string | null {
  if (price === "not metered") return "Not metered";
  if (price === 0) return "Costs nothing per call";
  return typeof price === "number" ? `Costs ${dollars(price)} per call` : null;
}

/** A call's arguments as the card shows them: laid out when the preview is whole JSON, else as the server sent it (a
 *  preview cut at 2 KiB ends in "…" and is shown so). */
export function argsShown(preview: string): string {
  try { return JSON.stringify(JSON.parse(preview), null, 2); } catch { return preview; }
}

const ALREADY: Record<string, string> = {
  allow: "This call was already allowed, in another tab or by another answer. The run shows what happened next.",
  // A message sent while the call waited declines it too (as its reason): "deny" covers both.
  deny: "This call was already declined. The run shows what happened next.",
  // A stop or a cancel withdraws a call that waits, or one answered and not acted on yet: neither runs.
  withdrawn: "The run was stopped before this call ran, so it was withdrawn and never ran.",
  canceled: "The run was cancelled before this call ran, so it never ran.",
};

/** An answer the server refused, in plain words: an answer given before (`already_answered`, with its decision: another
 *  answer, a stop's withdrawal or a cancel), who may answer, a sign-in that ended, a call no longer waiting; any other
 *  as the server said it. */
export function approvalRefusal(e: unknown): string {
  if (e instanceof ClientError) {
    const decision = e.details?.reason === "already_answered" && typeof e.details.decision === "string" ? ALREADY[e.details.decision] : undefined;
    if (e.status === 409 && decision) return decision;
    if (e.status === 403) return "Only the owner, signed in with the password on this page, can answer an approval.";
    if (e.status === 401) return "Your sign-in ended. Sign in again to answer.";
    if (e.status === 404) return "This run no longer waits on that call.";
  }
  return problemOf(e);
}
