import { validateAnswers } from "../system-one.js";
import type { WorkflowDeps } from "../workflow.js";
import type { openRecovery, RecoveryEffectParams } from "./driver.js";

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
   *  attempt, and nothing is spent. Absent, such a step has spent its attempt. */
  durableNodes?: boolean;
};

/** The dependencies to run a workflow with under `driver`. The interpreter's `recovery` hooks cover nodes; three
 *  things they have no slot for are applied to the host's adapters here:
 *   - `runEffect`: each effect is admitted before it is dispatched, a completed one is answered from its receipt, and
 *     one admitted and never completed is refused;
 *   - `runJudge`: a route's answer is committed as its decision before any branch step runs, and a resume inside the
 *     branch follows it without asking again; every answer's spend is committed with the driver's state;
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
      for (;;) {
        // An attempt that delivered a submission is asked for again only when its node never committed. A runner that
        // keeps what it delivered answers it again below, as the same attempt; with any other runner it is spent.
        if (admission.status === "submitted" && !options.durableNodes) { driver.stepAttemptFailed(params.executionPath); admission = admit(); }
        if (admission.status === "failed") throw new Error(`${params.label} failed after ${admission.attemptsAllowed} attempts`);
        // The step's record is durable before the attempt runs. A stop or a caller's cancellation that landed
        // meanwhile ends the step here: the runner is not called, and no attempt is spent.
        await driver.flush();
        driver.checkStop();
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
          driver.stepAttemptFailed(params.executionPath, final);
          if (final) throw error;
          admission = admit();
          if (admission.status !== "running") throw error;
        }
      }
    }),
  };
}
