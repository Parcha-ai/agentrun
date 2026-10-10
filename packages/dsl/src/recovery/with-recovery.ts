import { validateAnswers } from "../system-one.js";
import type { WorkflowDeps } from "../workflow.js";
import type { openRecovery, RecoveryEffectParams } from "./driver.js";

/** A recovery driver, as `openRecovery` returns it. */
export type RecoveryDriver = Awaited<ReturnType<typeof openRecovery>>;

/** The dependencies to run a workflow with under `driver`. The interpreter's `recovery` hooks cover nodes; three
 *  things they have no slot for are applied to the host's adapters here:
 *   - `runEffect`: each effect is admitted before it is dispatched, a completed one is answered from its receipt, and
 *     one admitted and never completed is refused;
 *   - `runJudge`: a route's answer is committed as its decision before any branch step runs, and a resume inside the
 *     branch follows it without asking again; every answer's spend is committed with the driver's state;
 *   - `runNode`: an LLM step's record is committed before the step runs, with two attempts. An attempt is spent when
 *     the adapter fails, and when it delivered a submission whose node never committed (the interpreter refused it);
 *     a step that spent both is refused. A process that dies inside a step spends no attempt.
 *  The run stops through the driver's signal, together with the host's own. */
export function withRecovery(driver: RecoveryDriver, deps: Omit<WorkflowDeps, "runEffect"> & { runEffect?: (params: RecoveryEffectParams) => Promise<unknown> }): WorkflowDeps {
  const { runEffect, runJudge, runNode } = deps;
  return {
    ...deps,
    recovery: driver.recovery,
    signal: deps.signal ? AbortSignal.any([deps.signal, driver.signal]) : driver.signal,
    runEffect: runEffect && driver.wrapEffect(runEffect),
    runJudge: runJudge && (async (params) => {
      const decided = params.kind === "route" ? driver.routeDecision(params.executionPath) : undefined;
      if (decided) return decided.result as Awaited<ReturnType<typeof runJudge>>;
      const result = await runJudge(params);
      const cost = typeof result.cost_usd === "number" && Number.isFinite(result.cost_usd) ? result.cost_usd : null;
      // An answer the interpreter would refuse is spent at its price and is never a decision: the question is
      // asked again by the next process.
      try { validateAnswers(params.questions, result.answers); }
      catch (error) { driver.recordQuestionSpend(cost); throw error; }
      driver.recordQuestionSpend(cost, params.kind === "route" ? { executionPath: params.executionPath, label: params.label, result: result as Record<string, unknown>, receipts: null } : undefined);
      // The decision is durable before the interpreter acts on the answer, and a stop taken meanwhile ends the run here.
      await driver.flush();
      driver.checkStop();
      return result;
    }),
    runNode: runNode && (async (params) => {
      const admit = () => driver.stepSession(params.executionPath, params.label, { attemptsAllowed: 2 });
      let admission = admit();
      // An attempt that delivered a submission is asked for again only when its node never committed: the interpreter
      // refused what it delivered, or the process died before the commit. Either way that attempt is spent.
      if (admission.status === "submitted") { driver.stepAttemptFailed(params.executionPath); admission = admit(); }
      if (admission.status === "failed") throw new Error(`${params.label} failed after ${admission.attemptsAllowed} attempts`);
      // The step's record is durable before the step runs. A stop or a caller's cancellation that landed meanwhile ends
      // the step here: the adapter is not called, and no attempt is spent.
      await driver.flush();
      driver.checkStop();
      if (params.signal?.aborted) throw params.signal.reason;
      try {
        const submission = await runNode(params);
        driver.stepSubmitted(params.executionPath);
        return submission;
      } catch (error) {
        // A stop the driver took, or a sibling's failure, ends the step where it is: no attempt is spent.
        if (!driver.signal.aborted && !params.signal?.aborted) driver.stepAttemptFailed(params.executionPath);
        throw error;
      }
    }),
  };
}
