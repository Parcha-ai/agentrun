import { chargedCost, DecisionProviderError } from "../decision-provider.js";
import { validateAnswers } from "../system-one.js";
import { EscalationSignal, type WorkflowDeps } from "../workflow.js";
import { canonicalHash } from "./canonical-hash.js";
import type { openRecovery, RecoveryEffectParams } from "./driver.js";

import { DECISION_INTERRUPTED } from "../decision-receipts.js";
export { DECISION_INTERRUPTED };

/** A recovery driver, as `openRecovery` returns it. */
export type RecoveryDriver = Awaited<ReturnType<typeof openRecovery>>;

/** The attempt of an LLM step a node runner is asked to run, as the driver admitted it. One attempt is one session:
 *  a runner that keeps what an attempt delivered keys it by `sessionId`. */
export type RecoveryStep = { sessionId: string; attempt: number; earlierSessionIds: readonly string[] };

/** What a host's node runner receives under the driver: the interpreter's parameters, and the attempt it runs. A
 *  runner marks a failure no second attempt should follow (one that ended on a bound of its own) with `final: true`
 *  on what it throws. */
export type RecoveryNodeParams = Parameters<NonNullable<WorkflowDeps["runNode"]>>[0] & { step?: RecoveryStep };

/** The host's adapters as `withRecovery` takes them: the interpreter's, with the two that learn more under the driver. */
export type RecoveryAdapters = Omit<WorkflowDeps, "runEffect" | "runNode"> & {
  runEffect?: (params: RecoveryEffectParams) => Promise<unknown>;
  runNode?: (params: RecoveryNodeParams) => Promise<unknown>;
};

export type WithRecoveryOptions = {
  /** The node runner keeps what each attempt delivered: asked again for a `sessionId` whose record it holds, it
   *  returns that record without running anything. A step found delivered is then asked of it again as the same
   *  attempt, and nothing is spent. Absent, such a step has spent its attempt.
   *  A record the interpreter refuses is therefore returned, and refused, again at every later open: the step neither
   *  advances nor spends, and the run fails the same way each time until the host ends it (an escalation, a new run). */
  durableNodes?: boolean;
};

/** The dependencies to run a workflow with under `driver`. The interpreter's `recovery` hooks cover nodes; three
 *  things they have no slot for are applied to the host's adapters here:
 *   - `runEffect`: each effect is admitted before it is dispatched, a completed one is answered from its receipt, and
 *     one admitted and never completed is refused;
 *   - `runJudge`: each request is committed (`decision.request`) before the judge is asked, and ends with one outcome:
 *     answered, or failed in its own process (asked again as its next attempt). A later open that finds it asked and
 *     never answered (the process died, or a cancel cut the call) books it once at an unknown cost and ends the run
 *     escalated (`decision_interrupted`) instead of asking again. A route's answer is committed as its decision before
 *     any branch step runs, and a resume inside the branch follows it without asking again; every answer's spend is
 *     committed with the driver's state;
 *   - `runNode`: an LLM step's record is committed before the step runs, with two attempts, each handed to the
 *     runner as its `step`. A failed attempt is followed at once by the second, unless the runner marked the
 *     failure final; a step that spent both is refused at every later open. A process that dies inside a step spends
 *     no attempt. A step that delivered a submission and whose node never committed (the interpreter refused it, or
 *     the process died first) is answered again from the runner's own record under `durableNodes`, and has spent its
 *     attempt otherwise.
 *  The run stops through the driver's signal, together with the host's own. */
export function withRecovery(driver: RecoveryDriver, deps: RecoveryAdapters, options: WithRecoveryOptions = {}): WorkflowDeps {
  const { runEffect, runJudge, runNode } = deps;
  return {
    ...deps,
    recovery: driver.recovery,
    signal: deps.signal ? AbortSignal.any([deps.signal, driver.signal]) : driver.signal,
    runEffect: runEffect && driver.wrapEffect(runEffect),
    runJudge: runJudge && (async (params) => {
      const decided = params.kind === "route" ? driver.routeDecision(params.executionPath) : undefined;
      if (decided) return decided.result as Awaited<ReturnType<typeof runJudge>>;
      await driver.seam();
      const decisionId = params.decisionId ?? canonicalHash(["decision-request", params.executionPath, params.kind, params.questions, params.state]);
      const open = driver.admitDecision(params.executionPath, { decision_id: decisionId, kind: params.kind, label: params.label, model: params.model ?? null,
        request_sha256: canonicalHash({ kind: params.kind, label: params.label, state: params.state, questions: params.questions }) });
      if (open) {
        // An earlier process asked and its answer never reached a receipt: never asked again, booked once at an unknown
        // cost, and the run goes to review. The unknown cost is counted with the outcome in one commit, the way the
        // answered and failed paths commit theirs, so the run's spend reads incomplete and never omits it.
        if (open.status === "requested") driver.decisionEnded(params.executionPath, decisionId, "interrupted", null, () => driver.recordQuestionSpend(null));
        await driver.flush();
        throw new EscalationSignal({ kind: DECISION_INTERRUPTED, stage: "decision", executionPath: params.executionPath, label: params.label, state: driver.lastState(),
          summary: `The decision "${params.label}" was asked by an earlier process and its answer never reached a receipt; it is not asked again.` });
      }
      try {
        // The request is durable before the judge is asked.
        await driver.flush();
        let result: Awaited<ReturnType<typeof runJudge>>;
        try { result = await runJudge(params); }
        catch (error) {
          // A request sent whose outcome was lost may have been answered and billed: it is interrupted, never asked again,
          // and its estimate (or an unknown cost, which makes the spend read incomplete) is booked with that outcome.
          const charge = chargedCost(error);
          if (error instanceof DecisionProviderError && error.code === "outcome_unknown") {
            driver.decisionEnded(params.executionPath, decisionId, "interrupted", charge ?? null, () => driver.recordQuestionSpend(charge ?? null));
            throw error;
          }
          // An answer rejected after it was paid for failed, and its cost (or an unknown one) is booked with that outcome:
          // the next process asks again.
          if (charge !== undefined) {
            driver.decisionEnded(params.executionPath, decisionId, "failed", charge, () => driver.recordQuestionSpend(charge));
            throw error;
          }
          // A cut call (a cancel, the run's failure) has no outcome: a later open finds it asked and unanswered. A call
          // that ended on its own failed, and the next process asks again.
          if (!driver.signal.aborted && !params.signal?.aborted) driver.decisionEnded(params.executionPath, decisionId, "failed", null);
          throw error;
        }
        const cost = typeof result.cost_usd === "number" && Number.isFinite(result.cost_usd) ? result.cost_usd : null;
        // An answer the interpreter would refuse is spent at its price and is never a decision: the question is
        // asked again by the next process.
        try { validateAnswers(params.questions, result.answers); }
        catch (error) { driver.decisionEnded(params.executionPath, decisionId, "failed", cost, () => driver.recordQuestionSpend(cost)); throw error; }
        // The outcome, the spend and a route's decision are one commit.
        driver.decisionEnded(params.executionPath, decisionId, "answered", cost, () => driver.recordQuestionSpend(cost, params.kind === "route"
          ? { executionPath: params.executionPath, label: params.label, result: result as Record<string, unknown>, receipts: null } : undefined));
        // The decision is durable before the interpreter acts on the answer, and a stop taken meanwhile ends the run here.
        await driver.flush();
        driver.checkStop();
        return result;
      } finally { driver.decisionSettled(); }
    }),
    runNode: runNode && (async (params) => {
      const admit = () => driver.stepSession(params.executionPath, params.label, { attemptsAllowed: 2 });
      let admission = admit();
      for (;;) {
        // An attempt that delivered a submission is asked for again only when its node never committed. A runner that
        // keeps what it delivered answers it again below, as the same attempt; with any other runner it is spent.
        if (admission.status === "submitted" && !options.durableNodes) { driver.stepAttemptFailed(params.executionPath); admission = admit(); }
        // A step that failed on an item failure is refused with it, so the item it lies in ends on the same failure.
        if (admission.status === "failed") {
          throw admission.failure ? Object.assign(new Error(admission.failure.message), { code: admission.failure.code, itemFailure: true })
            : new Error(`${params.label} failed after ${admission.attemptsAllowed} attempts`);
        }
        // The step's record is durable before the attempt runs. A stop or a caller's cancellation that landed
        // meanwhile ends the step here: the runner is not called, and no attempt is spent. A pause waiting for an
        // effect in flight holds the step here until it is taken.
        await driver.flush();
        await driver.seam();
        if (params.signal?.aborted) throw params.signal.reason;
        try {
          const submission = await runNode({ ...params, step: { sessionId: admission.sessionId, attempt: admission.attempt, earlierSessionIds: admission.earlierSessionIds } });
          driver.stepSubmitted(params.executionPath);
          return submission;
        } catch (error) {
          // A stop the driver took, or a sibling's failure, ends the step where it is: no attempt is spent.
          if (driver.signal.aborted || params.signal?.aborted) throw error;
          // A failure the runner marked final (an attempt that ended on a bound of its own) gets no second attempt: it
          // would spend the same again.
          const final = (error as { final?: unknown } | null)?.final === true;
          driver.stepAttemptFailed(params.executionPath, final, error);
          if (final) throw error;
          admission = admit();
          if (admission.status !== "running") throw error;
        }
      }
    }),
  };
}
