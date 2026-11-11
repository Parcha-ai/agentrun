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
import { savedModelKeys, withModelKeys } from "./claim-secrets.js";
import { runnerSecrets } from "./redact.js";
import { storeSecrets } from "./store-secrets.js";
import { createDispatchLoop } from "./dispatch.js";
import { cliRunSpecFromLaunch } from "./cli-run-spec.js";
import { gradeModelFor, type GradeRouteAsk, gradeRouteOf, learningLoopOf } from "./learning-dispatch.js";
import type { GraderRoute } from "./learning-ask.js";
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
        // What a consolidation must never keep: every secret the server keeps sealed, and the runner's own.
        refuse: async () => runnerSecrets(deps.env ?? process.env, await storeSecrets(deps.store, deps.sealKey, deps.data)),
        // The grader speaks the route's wire, as pi does (learning-ask.ts: pi.ts policyFor and port-models.ts
        // sessionProvider), so its route is asked on pi's wires; a model on neither keeps the route's Messages translation.
        // A grade model whose vendor this host reaches only through OpenRouter goes there as main's grade does
        // (gradeRouteOf): OpenRouter's key its one credential, priced at OpenRouter's price.
        // The grade's model, main's order (gradeModelFor): the grade model the server names, else the agent's own.
        // Its model's key from the runner's environment, else the one saved in Settings → Model keys (savedModelKeys), read
        // at each grade, so a key saved with no restart grades the next learning run.
        routeOf: async (grade) => {
          const base = deps.env ?? process.env;
          const env = withModelKeys(base, await savedModelKeys({ store: deps.store, sealKey: deps.sealKey, env: base }));
          return gradeRouteFor(grade, env, deps.routeOf);
        },
        ...(deps.log ? { log: deps.log } : {}),
        ...(deps.gradeBound ? { gradeBound: deps.gradeBound } : {}),
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

/** The route a grade asks for (gradeModelFor: the grade model the server named, else the agent's own), from the runner's
 *  one route (`routeOf`), through gradeRouteOf. A grade model the server named (--grade-model, else AGENT_MODEL_STRONG)
 *  is the strong tier's: it goes with that tier's settings, sent whole as AGENT_MODEL_STRONG is (never cut to its bare id
 *  by AGENT_MODEL_GATEWAY_IDS) and priced at AGENT_MODEL_STRONG_PRICE. The agent's own model goes as its runs' does, on
 *  the default tier. */
export function gradeRouteFor(grade: GradeRouteAsk, env: NodeJS.ProcessEnv, routeOf: AdapterSpecDeps["routeOf"]): Promise<GraderRoute> {
  return gradeRouteOf(gradeModelFor(grade), env, (model) => (grade.model !== undefined && model === grade.model
    // The runner's environment under the grader as its strong model: every key it holds read through it, a non-enumerable
    // one (a launcher-held or Settings key) too, which a copy would drop.
    ? routeOf(undefined, Object.create(env, { AGENT_MODEL_STRONG: { value: model, enumerable: true } }) as NodeJS.ProcessEnv, "strong", PI_WIRES)
    : routeOf(model, env, "default", PI_WIRES)));
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
