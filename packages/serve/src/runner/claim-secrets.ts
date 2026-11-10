// The secrets a claimed run's tools get, read from the one store (store.sealedKeys, each sealed under the runner's seal
// key), never from this process's environment or a pipe (the old per-run process read its own over a pipe; the runner is
// one process for many runs). Scoped to the run as the old per-run environment was: the keys its revision's tools unlock
// and its model needs (runs.ts keysFor/needsOf), and its decision provider keys (decisions.ts decisionKeysFor, Parallel's
// where a web tool resolves there), and no other. So a run that names no monid never gets the monid key, and two runs on
// one runner never see each other's keys: each claim reads its own, into its own environment. (MCP credentials are the
// other per-claim secret; they come through mcp-claim.ts, which already opens them from the store under the claim.)
import { decisionKeysFor } from "../decisions.js";
import { GATEWAY_KEY_ENV, PROVIDER_KEYS } from "../model.js";
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
export async function claimSecrets(deps: ClaimSecretsDeps, revision: Revision, launch: Pick<RunLaunch, "plane" | "model">): Promise<NodeJS.ProcessEnv> {
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
  // An agentic run's model keys are its PINNED model's (the launch's, chosen at its start), the one its route sends, never
  // the host's default now: a key saved since the run started (another provider's, now first) would otherwise be opened
  // in its place, and the run would hold a key its model never sends and lack the one it does.
  const scoped = launch.model && !needs.tiers ? { ...needs, model: `${launch.model.provider}/${launch.model.modelId}` } : needs;
  const env: NodeJS.ProcessEnv = { ...base };
  for (const name of keysFor(scoped, working)) if (working[name] !== undefined) env[name] = working[name];
  const decision = decisionKeysFor(working, { providers: needs.decisionProviders, parallelWeb: launch.plane ? handsParallel(launch.plane) : false });
  for (const [name, value] of Object.entries(decision)) env[name] = value;
  return env;
}

/** Every model key a model route reads by name: each of pi-ai's providers' (model.ts PROVIDER_KEYS) and the gateway's. */
export const MODEL_KEY_NAMES: readonly string[] = [...new Set([...Object.values(PROVIDER_KEYS).flat(), GATEWAY_KEY_ENV])];

/** `env` for a model route (model-route.ts routeOf, a CLI's providerFor): the runner's own environment, its secrets kept
 *  as runEnv makes them (readable by name, never enumerable), with each model key it lacks taken from `opened`: the keys
 *  a claim opened from the store (claimSecrets, scoped to the run's model), or every one the server holds
 *  (savedModelKeys). So a model key saved in Settings → Model keys reaches the next run's model requests with no
 *  restart, as a tool key reaches its tools; a key set where AgentRun starts still wins (claimSecrets reads it first),
 *  and a provider the runner holds any key of gets none of its saved ones.
 *  The keys added are never enumerable either: a spread of the result, or a spawn given it, carries none of them. */
export function withModelKeys(env: NodeJS.ProcessEnv, opened: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const name of Object.getOwnPropertyNames(env)) {
    if (!Object.prototype.propertyIsEnumerable.call(env, name)) Object.defineProperty(out, name, Object.getOwnPropertyDescriptor(env, name)!);
  }
  // A provider's keys are filled together or not at all: only when the runner holds none of them. A credential handed where
  // AgentRun started (ANTHROPIC_AUTH_TOKEN, an AWS key id) is never mixed with a saved key of the same provider, which its
  // route would send first (ANTHROPIC_API_KEY before the token) or pair with it (another AWS name).
  for (const names of [...Object.values(PROVIDER_KEYS), [GATEWAY_KEY_ENV]]) {
    if (names.some((name) => env[name] !== undefined)) continue;
    for (const name of names) {
      if (out[name] !== undefined || opened[name] === undefined) continue;
      Object.defineProperty(out, name, { value: opened[name], enumerable: false, writable: false, configurable: false });
    }
  }
  return out;
}

/** Every model key the server holds, for a model route with no revision to scope it by (a learning run's grade): each
 *  by its name from `deps.env` first, then the store's sealed value, as claimSecrets reads them. */
export async function savedModelKeys(deps: ClaimSecretsDeps): Promise<NodeJS.ProcessEnv> {
  const out: NodeJS.ProcessEnv = {};
  for (const name of MODEL_KEY_NAMES) {
    const value = deps.env?.[name] ?? (deps.sealKey ? await getSealedKey(deps.store, deps.sealKey, name) : undefined);
    if (value !== undefined) out[name] = value;
  }
  return out;
}
