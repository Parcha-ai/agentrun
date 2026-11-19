// Connected agents keep their tools. Their caller checks one compiled candidate after an independent native turn;
// the server owns the reservation and compares that result with the native answer through the shared promotion gate.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { LearnedWorkflow, Shown } from "../learning.js";
import { loopOf } from "../learning-setting.js";
import { attemptOf, decideCheck, REPLAY_DEADLINE_MS } from "../runner/promotion.js";
import { workflowDigest } from "../runner/workflow-first.js";
import { promotionOf, promotionsOf, recordPromotion, replayingOf } from "../learn/promote.js";
import type { RunLaunch } from "../run-launch.js";
import type { Store } from "../store/store.js";
import type { SdkInbox } from "./runs.js";
import { uuidv7 } from "../agents-store.js";

export type SdkWorkflowCheck = {
  id: string;
  revision: string;
  digest: string;
  workflow: LearnedWorkflow;
};
export type SdkWorkflowCheckEvent = {
  type: "workflow_check";
  id: string;
  digest: string;
  outcome: "answered" | "handed_back" | "failed" | "skipped_write";
  answer?: string;
  reason?: string;
  skipped?: { tool: string; unmarked?: true };
};

/** One candidate per native turn, and one check at work per workflow across concurrent starts and revisions. A lost
 *  start/abandoned old client holds its candidate after the deadline; it never silently promotes or executes it. */
export async function reserveSdkCheck(store: Store, agentId: string, runId: string, revision: string | null, learning: unknown, flows: readonly LearnedWorkflow[]): Promise<SdkWorkflowCheck | undefined> {
  if (!revision) return;
  for (const flow of flows) {
    let records = await promotionsOf(store.settings, agentId);
    for (const pending of replayingOf(records, flow.name, null)) {
      // An SDK check is its own native run, with no server replay launch. Managed replays always have distinct
      // replay/input run ids. Do not expire or relaunch a managed check through the SDK admission path.
      if (pending.launch || pending.runs?.length !== 1 || pending.inputs?.[0] !== pending.runs[0] || Date.now() - Date.parse(pending.at) <= REPLAY_DEADLINE_MS) continue;
      await recordPromotion(store.settings, agentId, {
        ...pending, at: new Date().toISOString(), decided: "hold",
        reason: "The connected agent did not deliver its shadow check before the deadline. Nothing was promoted.",
        ...(pending.check ? { check: { ...pending.check, n: 1, agreed: 0, alone: 0, of: pending.inputs ?? [], outcomes: { answered: 0, handed_back: 0, failed: 1, skipped_write: 0 } } } : {}),
      }, was => was?.decided === "replaying" && was.replay_id === pending.replay_id);
    }
    records = await promotionsOf(store.settings, agentId);
    const digest = workflowDigest(flow);
    if (promotionOf(records, flow.name, digest) || replayingOf(records, flow.name, digest).length) continue;
    const id = uuidv7();
    const reserved = await recordPromotion(store.settings, agentId, {
      workflow: flow.name, digest, at: new Date().toISOString(), decided: "replaying",
      reason: "Checking in the connected agent against one independent native turn before this draft can be reused.",
      replay_id: id, runs: [runId], inputs: [runId], commit: revision,
      check: { ...loopOf(learning), attempt: attemptOf(records, flow.name, digest) },
    }, (was, current) => was === undefined && replayingOf(current, flow.name, digest).length === 0);
    if (reserved.won) return { id, revision, digest, workflow: flow };
  }
}

/** The client reports execution, never its own verdict. Immutable completion is the baseline; incomplete, failed or
 *  workflow-assisted native turns cannot establish agreement. Exact retries/reclaims compete on the reservation. */
export async function settleSdkCheck(deps: { store: Store; agentId: string; revisionId: string; launch: RunLaunch; inbox: SdkInbox; shown: () => Promise<Shown>; log: (line: string) => void }) {
  const check = deps.inbox.learning_check;
  if (!check) return;
  const record = promotionOf(await promotionsOf(deps.store.settings, deps.agentId), check.workflow.name, check.digest);
  if (record?.decided !== "replaying" || record.replay_id !== check.id || !record.check || record.commit !== check.revision || record.runs?.[0] !== deps.inbox.run_id) return;
  const events = deps.inbox.batches.flatMap(batch => batch.events);
  const reported = events.find((event): event is SdkWorkflowCheckEvent => event.type === "workflow_check");
  const result = deps.inbox.completion;
  const independent = result?.status === "completed" && result.evidence_complete !== false && !deps.inbox.check_redacted &&
    !events.some(event => event.type === "tool" && (event.name === "learned_workflow" || event.parent_tool_use_id !== undefined));
  const valid = independent && reported?.id === check.id && reported.digest === check.digest;
  const outcome = valid ? reported.outcome : "failed";
  const outcomes = { answered: 0, handed_back: 0, failed: 0, skipped_write: 0 };
  outcomes[outcome]++;
  return decideCheck({ ...deps, runId: deps.inbox.run_id, context: BACKGROUND_CONTEXT }, check.workflow.name, check.digest, record.check, {
    rows: [{ of: deps.inbox.run_id, input: JSON.stringify(deps.launch.input), agent: independent ? result!.answer : null,
      outcome, answer: outcome === "answered" ? reported!.answer ?? null : null,
      ...(outcome === "handed_back" ? { escalated: reported?.reason ?? "The shadow workflow handed the task back." } : {}),
      ...(outcome === "skipped_write" && reported?.skipped ? { skipped: { ...reported.skipped, step: "connected-shadow" } } : {}),
    }], cost: null, outcomes, unstarted: reported ? 0 : 1,
    exactMismatchReason: "its answer did not match the native answer exactly; connected SDK checks do not use a semantic grader, so name the fields that carry the decision (learning.agree_on) when whole-answer equality is not the intended check",
  }, was => was?.decided === "replaying" && was.replay_id === check.id,
  { runs: record.runs, replay_id: check.id, commit: check.revision });
}
