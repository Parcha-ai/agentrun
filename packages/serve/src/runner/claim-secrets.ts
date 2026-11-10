// The secrets a claimed run's tools get, read from the one store (store.sealedKeys, each sealed under the runner's seal
// key), never from this process's environment or a pipe (the old per-run process read its own over a pipe; the runner is
// one process for many runs). Scoped to the run as the old per-run environment was: the keys its revision's tools unlock
// and its model needs (runs.ts keysFor/needsOf), and its decision provider keys (decisions.ts decisionKeysFor, Parallel's
// where a web tool resolves there), and no other. So a run that names no monid never gets the monid key, and two runs on
// one runner never see each other's keys: each claim reads its own, into its own environment. (MCP credentials are the
// other per-claim secret; they come through mcp-claim.ts, which already opens them from the store under the claim.)
import { decisionKeysFor } from "../decisions.js";
import type { RunLaunch } from "../run-launch.js";
import { keysFor, needsOf, RUN_SECRETS } from "../runs.js";
import { DECISION_KEYS, withoutSecrets } from "../secrets.js";
import { getSealedKey } from "../server-keys.js";
import type { SealedKeys } from "../store/store.js";
import { handsParallel } from "../tool-plane.js";
import type { Revision } from "@parcha/pi-durable-agent";

/** Every server secret a run might be handed (runs.ts RUN_SECRETS is the tool and model keys; the decision keys go beside
 *  them). Read from the store into a working environment, then scoped to the run below. */
const CANDIDATES: readonly string[] = [...new Set([...RUN_SECRETS, ...DECISION_KEYS])];

/** What claimSecrets reads the keys from: the one store (its sealed keys) and the runner's seal key, and the runner's base
 *  environment (its own, with no server secret in it: those are the store's). */
export interface ClaimSecretsDeps {
  readonly store: { readonly sealedKeys: Pick<SealedKeys, "get"> };
  /** The runner's seal key: with none, no saved key is opened, and only the environment's values are read. */
  readonly sealKey: Buffer | undefined;
  readonly env?: NodeJS.ProcessEnv;
}

/** The environment a claimed run's tools run under: the runner's base (its secrets stripped), with the keys the run's
 *  revision needs read from the store on top — the tool keys its tools unlock, the model keys its model needs, and its
 *  decision provider keys. A fresh object per claim, so no run's keys reach another's. */
export async function claimSecrets(deps: ClaimSecretsDeps, revision: Revision, launch: Pick<RunLaunch, "plane">): Promise<NodeJS.ProcessEnv> {
  const base = withoutSecrets(deps.env ?? {});
  // Every candidate secret into a working environment, then scoped to the run below so a key the run does not need is never
  // put on the environment its tools run under. The server process's own environment value wins over the store's by the same
  // name (the secrets rule 4: env always overrides a pasted value), so a key set where the server starts is not shadowed by a
  // stale one saved in the store.
  const working: NodeJS.ProcessEnv = { ...base };
  for (const name of CANDIDATES) {
    const value = deps.env?.[name] ?? (deps.sealKey ? await getSealedKey(deps.store, deps.sealKey, name) : undefined);
    if (value !== undefined) working[name] = value;
  }
  const needs = await needsOf(revision);
  const env: NodeJS.ProcessEnv = { ...base };
  for (const name of keysFor(needs, working)) if (working[name] !== undefined) env[name] = working[name];
  const decision = decisionKeysFor(working, { providers: needs.decisionProviders, parallelWeb: launch.plane ? handsParallel(launch.plane) : false });
  for (const [name, value] of Object.entries(decision)) env[name] = value;
  return env;
}
