// The runner's dispatch switch (design 2.1: "the runner takes every run"): which loop a claimed run runs, by its revision
// and the harness its launch names. The runner holds one dispatch loop (dispatch.ts) for every run; at the claim the
// dispatch reads the launch and asks this switch for the run's inner loop:
//   - a workflow revision runs on the workflow loop (createWorkflowLoop), whatever its harness name (a workflow's default
//     harness is pi), so the revision is read here to tell it from an agentic pi run;
//   - a built-in learning run (its launch names harness "learning") runs on the learning loop;
//   - pi runs on the kernel's adapter loop with the run's pi spec (adapterRunSpecFromLaunch);
//   - a CLI harness (claude-agent, codex, opencode) runs on the adapter loop with its own adapter;
//   - anything else fails the run in words (the dispatch's UnknownHarness).
import type { RunLaunch } from "../run-launch.js";
import { resolveHarness } from "./adapters/index.js";
import { adapterRunSpecFromLaunch, type AdapterSpecDeps, PI_WIRES } from "./adapter-run-spec.js";
import { createAdapterLoop } from "./adapter-loop.js";
import { createDispatchLoop } from "./dispatch.js";
import { cliRunSpecFromLaunch } from "./cli-run-spec.js";
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
      // The runner's seal key and data directory go with it: a claim's sealed secrets are read with them (claim-secrets.ts,
      // store-secrets.ts), and every one the server keeps is held by the run's one redactor.
      return createWorkflowLoop(workflowSpecOf({ store: deps.store, sealKey: deps.sealKey, data: deps.data, ...(deps.env ? { env: deps.env } : {}) }));
    }
    if (harness === "learning") {
      // A built-in learning run on the learning loop: its grade goes through the runner's one model route, on the grade
      // model its launch names (none: the agent's own), at that route's price (learning-dispatch.ts).
      return learningLoopOf({
        store: deps.store,
        data: deps.data,
        // The grader speaks the route's wire, as pi does (learning-ask.ts: pi.ts policyFor and port-models.ts
        // sessionProvider), so its route is asked on pi's wires; a model on neither keeps the route's Messages translation.
        routeOf: (grade) => deps.routeOf(grade.model, deps.env, "default", PI_WIRES),
        ...(deps.log ? { log: deps.log } : {}),
      });
    }
    // The harness's own entry decides which spec builds the run, by the entry's facts and never the harness's name: an entry
    // whose visible record the loop keeps (record: "loop") runs the CLI spec (cli-run-spec.ts), one that keeps its own (pi)
    // runs the pi spec (adapterRunSpecFromLaunch). A harness with no entry is unknown here: the dispatch fails it in words.
    const runner = resolveHarness(harness);
    if (runner) {
      // A run that learns supplies its own end-of-run step (reflect + proposal over its store) from its spec builder now,
      // where the run's Archil claim is: a Mode 2 run's learning folder is on its claim's disk, not this machine's local
      // path (adapter-run-spec.ts / cli-run-spec.ts endOfRun). The loop prefers the spec's step over its deps' (stepOf); a
      // run that does not learn supplies none. The same for the pi and the CLI spec.
      return createAdapterLoop((claim, adapterRun) =>
        runner.record === "loop"
          ? cliRunSpecFromLaunch(launch, adapterRun, deps, claim)
          : adapterRunSpecFromLaunch(launch, adapterRun, deps, claim));
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
