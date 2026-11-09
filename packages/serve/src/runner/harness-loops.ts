// The runner's dispatch switch (design 2.1: "the runner takes every run"): which loop a claimed run runs, by its revision
// and the harness its launch names. The runner holds one dispatch loop (dispatch.ts) for every run; at the claim the
// dispatch reads the launch and asks this switch for the run's inner loop:
//   - a workflow revision runs on the workflow loop (createWorkflowLoop), whatever its harness name (a workflow's default
//     harness is pi), so the revision is read here to tell it from an agentic pi run;
//   - a built-in learning run (its launch names harness "learning") runs on the learning loop;
//   - pi runs on the kernel's adapter loop with the run's pi spec (adapterRunSpecFromLaunch);
//   - a CLI harness (claude-agent, codex, opencode) runs on the adapter loop with its own adapter;
//   - anything else fails the run in words (the dispatch's UnknownHarness).
import { DEFAULT_HARNESS, HARNESSES } from "../harness.js";
import type { RunLaunch } from "../run-launch.js";
import { adapterRunSpecFromLaunch, type AdapterSpecDeps } from "./adapter-run-spec.js";
import { createAdapterLoop } from "./adapter-loop.js";
import { createDispatchLoop } from "./dispatch.js";
import { learningLoopOf } from "./learning-dispatch.js";
import type { LoopFactory } from "./loop-contract.js";
import { isWorkflowRevision } from "./workflow-loop.js";

/** The dispatch's `resolve`, built from the runner's deps: it reads the run's revision (for a workflow revision) and
 *  returns the loop the run runs on, or undefined when this runner does not run it (the dispatch fails it in words). */
export function resolveRunnerLoop(deps: AdapterSpecDeps): (harness: string, launch: RunLaunch, runId: string) => Promise<LoopFactory | undefined> {
  return async (harness, launch, runId) => {
    // A workflow revision runs on the workflow loop whatever the harness its body names (its default is pi): read the
    // revision to tell it apart from an agentic pi run.
    const run = await deps.store.runs.get(runId);
    const revision = run ? await deps.store.agents.revision(run.revisionId) : undefined;
    if (revision && isWorkflowRevision(revision)) {
      // TODO(E2r2): createWorkflowLoop(specOf) once the workflow host build helper lands (E2w: WorkflowRunSpec.build, the
      // model proxy, the tool table, the cap and the decision providers, moved from app.ts's workflow branch). Until then
      // a workflow run is not taken by this runner.
      return undefined;
    }
    if (harness === "learning") {
      // A built-in learning run grades on the runner's one model route: the launch's grade model, else the agent of the
      // run that learned reads its own model (as main grades). ModelRoute carries the grader's route fields, so the one
      // routeOf serves the grade.
      return learningLoopOf({
        store: deps.store,
        data: deps.data,
        routeOf: async ({ model, agentId }) => {
          let chosen = model;
          if (chosen === undefined) {
            const agent = await deps.store.agents.get(agentId);
            const revision = agent?.currentRevision ? await deps.store.agents.revision(agent.currentRevision) : undefined;
            const body = revision?.body as { model?: string } | undefined;
            chosen = typeof body?.model === "string" ? body.model : undefined;
          }
          return deps.routeOf(chosen, deps.env);
        },
      });
    }
    if (harness === DEFAULT_HARNESS) {
      return createAdapterLoop((claim, adapterRun) => adapterRunSpecFromLaunch(launch, adapterRun, deps, claim));
    }
    if ((HARNESSES as readonly string[]).includes(harness)) {
      // TODO(E2r2): resolveHarness(harness) for claude-agent, codex and opencode on the adapter loop (ws-c3, cutover-cli:
      // not merged yet).
      return undefined;
    }
    return undefined;
  };
}

/** The loop factory the runner holds for every run (its createLoop), built from the runner's deps over the one store: the
 *  dispatch (dispatch.ts) reads each run's launch and asks the switch (resolveRunnerLoop) for its harness loop. The server
 *  start and the test server pass this to startRunner. */
export function dispatchRunner(deps: AdapterSpecDeps): LoopFactory {
  return createDispatchLoop({
    launchOf: (runId) => deps.store.runs.launch(runId),
    resolve: resolveRunnerLoop(deps),
  });
}
