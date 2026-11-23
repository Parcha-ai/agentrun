import { envGatewayInForce, readSavedGateway, savedGatewayIn, savedGatewayMarked, SAVED_GATEWAY_ENV, withSavedGateway } from "../model-gateway.js";
import { GATEWAY_KEY_ENV } from "../model.js";
import { heldRedactor } from "./redact.js";
import { envValue } from "../key-meta.js";
import { createSdkLoop } from "./sdk-loop.js";
import { createNativeLoop } from "./native-loop.js";
// The runner's dispatch switch (design 2.1: "the runner takes every run"): which loop a claimed run runs, by its revision
// and the harness its launch names. The runner holds one dispatch loop (dispatch.ts) for every run; at the claim the
// dispatch reads the launch and asks this switch for the run's inner loop:
//   - a workflow revision runs on the workflow loop (createWorkflowLoop), whatever its harness name (a workflow's default
//     harness is pi), so the revision is read here to tell it from an agentic pi run;
//   - pi runs on the kernel's adapter loop with the run's pi spec (adapterRunSpecFromLaunch), and so does a harness a
//     module adds with no adapter facts of its own, on its runner's adapter;
//   - a CLI harness (claude-agent, codex, opencode) runs on the adapter loop with its own adapter;
//   - anything else fails the run in words (the dispatch's UnknownHarness).
import { harnessOf, recipeKeysOf } from "../harness-table.js";
import { harnessKeysSaved, RECIPE_SIGN_IN_PERSON_ONLY } from "../harness-keys.js";
import type { SealedKeys } from "../store/index.js";
import { hostMemory, neverFits } from "../host.js";
import { personStarted, type RunLaunch } from "../run-launch.js";
import { resolveHarness } from "./adapters/index.js";
import { adapterRunSpecFromLaunch, type AdapterSpecDeps, PI_WIRES } from "./adapter-run-spec.js";
import { createAdapterLoop } from "./adapter-loop.js";
import { savedModelKeys, withModelKeys } from "./claim-secrets.js";
import { withRequestMetadata } from "../request-metadata.js";
import { noServerKeyFor } from "../run-model-key.js";
import { createDispatchLoop } from "./dispatch.js";
import { cliRunSpecFromLaunch } from "./cli-run-spec.js";
import { askRouteOf } from "./sdk-ask.js";
import { ClaimRefused, type LoopFactory } from "./loop-contract.js";
import { createWorkflowLoop, isWorkflowRevision } from "./workflow-loop.js";
import { workflowSpecOf } from "./workflow-spec.js";

/** A claimed run whose harness this host's memory never holds: its message is the host's words (neverFits). A claim
 *  refused for good, so a parked run it wakes fails too, never retried as a resume (runner.ts finish). */
export class NeverFits extends ClaimRefused {
  override name = "NeverFits";
}

export { RECIPE_SIGN_IN_PERSON_ONLY };

/** Refuses at its claim a run no person is on record as starting (run-launch.ts personStarted: no startedBy, or a
 *  schedule's, a trigger's, a learned workflow's audit shadow or replay; an imported run or one from before launches kept
 *  the record too) on a plan-billed recipe's harness (harness-table.ts recipeKeysOf) unless every key it runs on is saved
 *  for that harness (harness-keys.ts): such a run goes on those keys, never its owner's own sign-in. On every path a
 *  claim takes (run-child-host.ts staysInRunner, and here): the early word, before a process is made. Rows are counted,
 *  never opened; the claim's spec opens them and refuses it again if not every one opened, since a row counted here can
 *  be gone or not open by then (cli-run-spec.ts). */
export async function refuseRecipeTriggerRun(deps: { readonly env?: NodeJS.ProcessEnv; readonly store: { readonly sealedKeys: Pick<SealedKeys, "all"> } }, harness: string, launch: Pick<RunLaunch, "startedBy" | "trigger" | "audit" | "replay">): Promise<void> {
  if (personStarted(launch)) return;
  const keys = recipeKeysOf(deps.env ?? {}, harness);
  if (keys !== undefined && !(await harnessKeysSaved(deps.store, harness, keys))) throw new ClaimRefused(RECIPE_SIGN_IN_PERSON_ONLY);
}

/** The dispatch's `resolve`, built from the runner's deps: it reads the run's revision (for a workflow revision) and
 *  returns the loop the run runs on, or undefined when this runner does not run it (the dispatch fails it in words).
 *  `keysCounted`: a run's own process (run-child.ts), whose runner counted its harness's key rows before it made the
 *  process (run-child-host.ts staysInRunner). The process's store lists no rows (STORE_CALLS has no sealedKeys.all), so
 *  it never counts them again; its claim's spec opens the claim's own keys and refuses the run if not every one opened. */
export function resolveRunnerLoop(given: AdapterSpecDeps, options: { readonly keysCounted?: boolean } = {}): (harness: string, launch: RunLaunch, runId: string) => Promise<LoopFactory | undefined> {
  return async (harness, launch, runId) => {
    if (!options.keysCounted) await refuseRecipeTriggerRun(given, harness, launch);
    // The model gateway saved in the console (model-gateway.ts), read from the store at each claim and laid over the run
    // environment as its variables would be, so a gateway saved or removed since reaches the next run with no restart. A
    // gateway the runner's environment names wins, and nothing saved is read over it.
    const deps = await withSavedGatewayDeps(given);
    const made = await loopOn(deps, harness, launch, runId);
    return made && holdingGatewayKey(made, deps.env);
  };
}

/** `made` with the saved gateway's key, as this claim read it, held by the run's one redactor before the loop starts: the
 *  key stays off the claim's tool keys (claimSecrets), and a later scan of the store (holdStored) would find only a key
 *  saved since, so a gateway reply that echoes this one is cut in the run's records and logs all the same. `made` itself
 *  where the gateway is not the saved one. */
function holdingGatewayKey(made: LoopFactory, env: NodeJS.ProcessEnv | undefined): LoopFactory {
  const key = env && savedGatewayIn(env) ? env[GATEWAY_KEY_ENV] : undefined;
  if (!key) return made;
  return (loopDeps) => {
    if (loopDeps.redact) heldRedactor(loopDeps.redact).hold([key]);
    return made(loopDeps);
  };
}

/** The loop a claimed run runs on, over `deps` (the saved gateway laid over its environment). */
async function loopOn(deps: AdapterSpecDeps, harness: string, launch: RunLaunch, runId: string): Promise<LoopFactory | undefined> {
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
  // A backend SDK run's compile turn is asked on the runner's one model route, on the agent's own model (its learning
  // start's), its key from the runner's environment, else the one saved in Settings → Model keys, read at each ask.
  if (launch.sdk || launch.cli_learning) return createSdkLoop(launch, deps, async (claim) => {
    if (launch.cli_learning) throw new Error("Connected CLI capture has no workflow execution bridge.");
    const base = deps.env ?? process.env;
    // Its requests on serve's gateway name the claim's run, turn and attempt, as every other request of a claim does
    // (request-metadata.ts): withModelKeys makes the env this ask's own.
    const env = withRequestMetadata(withModelKeys(base, await savedModelKeys({ store: deps.store, sealKey: deps.sealKey, env: base })), claim);
    // It runs after its backend reported the run complete, on no run's key: on a server that holds no gateway key it is
    // skipped in words (run-model-key.ts noServerKeyFor), nothing sent.
    const off = noServerKeyFor(env, "An SDK run's compile turn");
    if (off) {
      deps.log?.(off);
      throw new Error(off);
    }
    return askRouteOf(launch.learning!.model, env, (model) => deps.routeOf(model, env, "default", PI_WIRES));
  });
  if (launch.native) return createNativeLoop(launch, deps);
  // The harness's own entry decides which spec builds the run, by what the entry gives and never the harness's name: an
  // entry with an adapter's facts and serve's own adapter for it (the CLI harnesses) runs the CLI spec (cli-run-spec.ts);
  // any other (pi, or a harness module's entry that gives only the required members) runs the run spec
  // (adapterRunSpecFromLaunch), whose adapter is its runner's (resolveHarness), with the record mode that runner names.
  // A harness with no entry is unknown here: the dispatch fails it in words.
  const env = deps.env ?? process.env;
  const runner = resolveHarness(harness, env);
  if (runner) {
    // A run this host's memory never holds (host.ts neverFits: one run of its harness is more than the host has for runs)
    // fails at its claim, in the words a start of it is refused in here (harness.ts harnessOffers): a run another host
    // started, or one left before this host's memory shrank. Claimed alone (runner.ts claimByMemory), it would run past
    // the host's memory and its OOM kill would take every run on it.
    const tooBig = neverFits(harness, hostMemory(), env);
    if (tooBig) throw new NeverFits(tooBig);
    const entry = harnessOf(env, harness);
    // A run that learns supplies its own end-of-run step (reflect + proposal over its store) from its spec builder now,
    // where the run's Archil claim is: a Mode 2 run's learning folder is on its claim's disk, not this machine's local
    // path (adapter-run-spec.ts / cli-run-spec.ts endOfRun). The loop prefers the spec's step over its deps' (stepOf); a
    // run that does not learn supplies none. The same for the pi and the CLI spec.
    return createAdapterLoop((claim, adapterRun) =>
      entry?.facts && entry.adapter
        ? cliRunSpecFromLaunch(launch, adapterRun, deps, claim)
        : adapterRunSpecFromLaunch(launch, adapterRun, deps, claim, runner), deps.modelRetry ?? {});
  }
  return undefined;
}

/** The loop factory the runner holds for every run (its createLoop), built from the runner's deps over the one store: the
 *  dispatch (dispatch.ts) reads each run's launch and asks resolveRunnerLoop for its harness loop. The server
 *  start and the test server pass this to startRunner. */
export function dispatchRunner(deps: AdapterSpecDeps): LoopFactory {
  return createDispatchLoop({
    launchOf: (runId) => deps.store.runs.launch(runId),
    resolve: resolveRunnerLoop(deps),
  });
}

/** `deps` with the model gateway saved in the console laid over its run environment (model-gateway.ts withSavedGateway),
 *  read from the store now; `deps` itself where none is saved or the runner's environment names its own. A run's own
 *  process (no seal key) reads nothing of it: its runner laid it over the claim (run-child-host.ts) and marked it
 *  (SAVED_GATEWAY_ENV), and only that mark is read here. */
export async function withSavedGatewayDeps(deps: AdapterSpecDeps): Promise<AdapterSpecDeps> {
  const base = deps.env ?? process.env;
  if (envValue(base, SAVED_GATEWAY_ENV) === "1") return { ...deps, env: savedGatewayMarked(base) };
  if (envGatewayInForce(base) || !deps.sealKey) return deps;
  const saved = await readSavedGateway(deps.store, deps.sealKey);
  return saved ? { ...deps, env: withSavedGateway(base, saved) } : deps;
}
