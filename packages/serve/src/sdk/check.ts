// Connected agents keep their tools. Their caller checks one compiled candidate after each independent native turn the
// server reserves for it (runner/promotion.ts reserveSdkCheck); the server compares that result with the native answer
// and collects the turns until it holds compile_after of them, then decides once on all of them through the shared
// promotion gate, the evidence bar a managed check's compile_after inputs set (runner/promotion.ts sdkCheckTurn).
import type { Shown } from "../learning.js";
import { releaseSdkCheck, sdkCheckDeadline, sdkCheckTurn, sdkInputText } from "../runner/promotion.js";
import { promotionOf, promotionsOf } from "../learn/promote.js";
import type { RunLaunch } from "../run-launch.js";
import type { Store } from "../store/store.js";
import type { SdkInbox } from "./runs.js";

export type SdkWorkflowCheckEvent = {
  type: "workflow_check";
  id: string;
  digest: string;
  outcome: "answered" | "handed_back" | "failed" | "skipped_write";
  answer?: string;
  reason?: string;
  skipped?: { tool: string; unmarked?: true };
  /** Fresh read-only calls the shadow made where the native recording had no result (the client's shadowReadFallback). */
  fresh_reads?: number;
};

/** Why a completed inbox's native turn cannot be its check's baseline, or undefined when it can: a completed turn with
 *  complete, unredacted evidence and no learned workflow or nested call in it, whose shadow answered or handed back. */
function notBaseline(inbox: SdkInbox & { completion: NonNullable<SdkInbox["completion"]> }, reported: SdkWorkflowCheckEvent | undefined): string | undefined {
  const result = inbox.completion;
  if (result.status !== "completed") return `its native turn ${result.status === "cancelled" ? "was cancelled" : "failed"}`;
  if (result.evidence_complete === false) return "the backend reported its native turn's evidence incomplete";
  if (inbox.check_redacted) return "its native evidence held a protected value, so two different answers could agree by their placeholder";
  if (inbox.batches.some((batch) => batch.events.some((event) => event.type === "tool" && (event.name === "learned_workflow" || event.parent_tool_use_id !== undefined))))
    return "its native turn ran a learned workflow, so its answer is not the agent's own";
  if (!reported) return "the connected agent reported no shadow check";
  if (reported.outcome === "failed") return `its shadow did not answer (${reported.reason ?? "no reason given"})`;
  if (reported.outcome === "skipped_write") return `its shadow stopped at a write the native turn did not make (${reported.skipped?.tool ?? "a tool"})`;
  return undefined;
}

/** Settles a connected agent's reserved turn at its run's end. The client reports execution, never its own verdict, and
 *  the immutable completion is the baseline. A shadow that answered or handed back on a valid native turn is one row of
 *  the check (sdkCheckTurn: kept until the check holds compile_after rows, the one that makes compile_after deciding on
 *  them all); any other turn is given back (releaseSdkCheck) and the check waits for the next turn; a turn the backend
 *  never completed before its inbox expired is one failed row (sdkCheckDeadline). Exact retries and reclaims compete on
 *  the reservation. */
export async function settleSdkCheck(deps: { store: Store; agentId: string; launch: RunLaunch; inbox: SdkInbox; shown: () => Promise<Shown>; log: (line: string) => void }) {
  const { inbox } = deps;
  const check = inbox.learning_check;
  if (!check) return;
  const record = promotionOf(await promotionsOf(deps.store.learning, deps.agentId), check.workflow.name, check.digest);
  if (record?.decided !== "replaying" || record.via !== "sdk" || record.replay_id !== check.id || !record.check || record.commit !== check.revision || record.runs?.[0] !== inbox.run_id) return;
  const completion = inbox.completion;
  if (!completion) {
    if (inbox.closed === "expired") return sdkCheckDeadline(deps, record);
    // A cancel is a person's choice, not the integration failing to give a baseline: given back uncounted.
    if (inbox.closed) return releaseSdkCheck(deps, record, inbox.closed === "cancelled" ? "its native turn was stopped before the backend completed it" : "its native turn ended before the backend completed it", inbox.closed !== "cancelled");
    return;
  }
  const reported = inbox.batches.flatMap((batch) => batch.events)
    .find((event): event is SdkWorkflowCheckEvent => event.type === "workflow_check" && event.id === check.id && event.digest === check.digest);
  const cause = notBaseline({ ...inbox, completion }, reported);
  if (cause !== undefined || !reported) return releaseSdkCheck(deps, record, cause ?? "the connected agent reported no shadow check", completion.status !== "cancelled");
  return sdkCheckTurn(deps, { ...record, check: record.check }, {
    of: inbox.run_id, input: sdkInputText(deps.launch), agent: completion.answer, outcome: reported.outcome,
    answer: reported.outcome === "answered" ? reported.answer ?? null : null,
    ...(reported.outcome === "handed_back" ? { escalated: reported.reason ?? "The shadow workflow handed the task back." } : {}),
  }, (was) => was?.decided === "replaying" && was.replay_id === check.id, {
    ...(reported.fresh_reads ? { fresh_reads: reported.fresh_reads } : {}),
    exactMismatchReason: "its answer did not match the native answer exactly; connected SDK checks do not use a semantic grader, so name the fields that carry the decision (learning.agree_on) when whole-answer equality is not the intended check",
  });
}
