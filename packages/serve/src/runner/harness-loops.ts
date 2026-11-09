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
import { learningLoopOf } from "./learning-dispatch.js";
import type { LoopFactory } from "./loop-contract.js";
import { createWorkflowLoop, isWorkflowRevision } from "./workflow-loop.js";
import { workflowSpecOf } from "./workflow-spec.js";

/** The dispatch's `resolve`, built from the runner's deps: it reads the run's revision (for a workflow revision) and
 *  returns the loop the run runs on, or undefined when this runner does not run it (the dispatch fails it in words). */
export function resolveRunnerLoop(deps: AdapterSpecDeps): (harness: string, launch: RunLaunch, runId: string) => Promise<LoopFactory | undefined> {
  return async (harness, launch, runId) => {
    // A workflow revision runs on the workflow loop whatever the harness its body names (its default is pi): read the
    // revision to tell it apart from an agentic pi run.
    const run = await deps.store.runs.get(runId);
    const revision = run ? await deps.store.agents.revision(run.revisionId) : undefined;
    if (revision && isWorkflowRevision(revision)) {
      // A workflow run on the workflow loop: its claim-time spec (workflow-spec.ts) resolves each tier's model the one way
      // the runner resolves any (routeProviderOf over the route, the default when no providerOf is given).
      return createWorkflowLoop(workflowSpecOf({ store: deps.store, ...(deps.env ? { env: deps.env } : {}) }));
    }
    if (harness === "learning") {
      // A built-in learning run on the learning loop: its grade goes through the runner's one model route, on the grade
      // model its launch names (none: the agent's own), at that route's price (learning-dispatch.ts).
      return learningLoopOf({
        store: deps.store,
        data: deps.data,
        routeOf: (grade) => deps.routeOf(grade.model, deps.env),
        ...(deps.log ? { log: deps.log } : {}),
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
