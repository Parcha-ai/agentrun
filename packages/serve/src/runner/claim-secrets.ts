// The secrets a claimed run's tools get, read from the one store (store.sealedKeys, each sealed under the runner's seal
// key), never from this process's environment or a pipe (the old per-run process read its own over a pipe; the runner is
// one process for many runs). Scoped to the run as the old per-run environment was: the keys its revision's tools unlock
// and its model needs (runs.ts keysFor/needsOf), and its decision provider keys (decisions.ts decisionKeysFor, Parallel's
// where a web tool resolves there), and no other; an agentic run's learned workflows add the keys of the decision
// providers they name, read once the claim's seed lay chose them (learnedDecisionKeys). So a run that names no monid never gets the monid key, and two runs on
// one runner never see each other's keys: each claim reads its own, into its own environment. (MCP credentials are the
// other per-claim secret; they come through mcp-claim.ts, which already opens them from the store under the claim.)
import { decisionKeysFor, decisionsUseGatewayKey, JEV_GATEWAY_KEY_ENV, JEV_KEY_ENV, JEV_OPENROUTER_KEY_ENV, PARALLEL_KEY_ENV, providersNamed } from "../decisions.js";
import type { LearnedWorkflow } from "../learning.js";
import { FAUX_ENV, FAUX_PROVIDER, GATEWAY_KEY_ENV, hostModel, modelKeys, PROVIDER_KEYS, type Tier, tierModelOf, TIERS, workflowNodes } from "../model.js";
import { readLaunchBody, type RunLaunch } from "../run-launch.js";
import { keysFor, needsOf, RUN_SECRETS, type RunNeeds } from "../run-secrets.js";
import { BUILTIN_OWN_KEYS } from "../harness-table.js";
import { DECISION_KEYS, withoutSecrets } from "../secrets.js";
import { getSealedKey } from "../server-keys.js";
import { PLAN_PROVIDER, planOf, planReaderOf, withPlan } from "../chatgpt-plan.js";
import type { SealedKeys } from "../store/store.js";
import { handsJevWeb, handsParallel } from "../tool-plane.js";
import type { Revision } from "../agent-rows.js";
import { held, held as runnerSeam } from "./held.js";
import { savedGatewayIn } from "../model-gateway.js";
import type { HeldRedact } from "./redact.js";
import { type HeldModelKey, noServerKeyWords, runKeyEndedFor, runModelOrigin, withRunModelKey, withRunModelKeyLater } from "../run-model-key.js";
import { openRunLaunch, type RunModelKey, type RunToolKeys } from "../store/seal.js";
import { declaredFrom } from "../run-keys.js";
import { type Claim, StoreLaunchMissing } from "../store/store.js";
import { withRequestMetadata } from "../request-metadata.js";

/** Every server secret a run might be handed (runs.ts RUN_SECRETS is the tool and model keys; the decision keys go beside
 *  them). Read from the store into a working environment, then scoped to the run below. */
const CANDIDATES: readonly string[] = [...new Set([...RUN_SECRETS, ...DECISION_KEYS])];

/** What claimSecrets reads the keys from: the one store (its sealed keys) and the runner's seal key, and the runner's base
 *  environment (its own, with no server secret in it: those are the store's). */
export interface ClaimSecretsDeps {
  /** `put`, `replaceIf`, `removeIf` and `clock` for the ChatGPT sign-in alone, which a run renews and seals again under a
   *  lease on the store's clock (chatgpt-plan.ts). `runs.launch` for a claim given its run's id: its launch's sealed
   *  column, which holds the run's own tool keys. */
  readonly store: { readonly sealedKeys: Pick<SealedKeys, "get" | "put" | "replaceIf" | "removeIf" | "clock">; readonly runs?: RunLaunchReader };
  /** The runner's seal key: with none, no saved key is opened, and only the environment's values are read. */
  readonly sealKey: Buffer | undefined;
  readonly env?: NodeJS.ProcessEnv;
}

/** What reads a run's launch sealed column. */
type RunLaunchReader = { launch(runId: string): Promise<{ readonly sealed: Uint8Array | null }> };
/** What reads a run's launch for its own model key: its sealed column, and its body, which says whether the run sends a
 *  model key at all (sendsNoModelKey). */
type RunModelKeyReader = { launch(runId: string): Promise<{ readonly sealed: Uint8Array | null; readonly body?: unknown }> };

/** The environment a claimed run's tools run under: the runner's base (its secrets stripped), with the keys the run's
 *  revision needs read from the store on top — the tool keys its tools unlock, the model keys its model needs, and its
 *  decision provider keys — and, for claim `runId`, the run's own tool keys its revision declares (run-keys.ts) over the
 *  server's by the same name. Its model keys are readable by name and never enumerable (MODEL_KEY_NAMES): its model
 *  routes read them by name (claimModelEnv), and a spread or a spawn of the tools' environment carries none. A fresh
 *  object per claim, so no run's keys reach another's. `redact`: the runner's one
 *  redactor, which the run's own tool keys are carried into before they are laid, so its journal is cut of them as it is
 *  written (no one holds them after the turn); a plain JS caller that passes none lays no run key, and throws. A run whose
 *  model sends no key (sendsNoModelKey: a held run its model kept from running, any run on a --faux runner, a faux-pinned
 *  one) is laid no model key and no plan sign-in. A held run its model kept from running at its create (hold.refused) is
 *  laid no built-in harness's own key either (harness-table.ts BUILTIN_OWN_KEYS: Cursor's): its agent never starts. Its
 *  tools' keys, its decision keys and its own tool keys are laid as any run's. The one tool key row that names
 *  a model key's name, TypeSafe's (key-words.ts; model.ts PROVIDER_KEYS typesafe), is a decision key (secrets.ts
 *  DECISION_KEYS): keysFor never names one, so the model key filter below never sees it, and decisionKeysFor lays it
 *  apart, as it lays OpenRouter's for a decision node that runs on it. */
export async function claimSecrets(deps: ClaimSecretsDeps & { readonly redact: HeldRedact }, revision: Revision, launch: Pick<RunLaunch, "plane" | "model" | "hold">, runId?: string): Promise<NodeJS.ProcessEnv> {
  const base = withoutSecrets(deps.env ?? {});
  const needs = await needsOf(revision);
  const keyless = sendsNoModelKey(launch, deps.env ?? {});
  const modelRefused = launch.hold?.refused !== undefined;
  // A run that sends no model key (sendsNoModelKey) lays none, so its claim opens none: a key it never lays is never
  // decrypted. A run with decision nodes still reads the decision keys' own names (DECISION_KEY_NAMES: Jev's TypeSafe key,
  // OpenRouter's), which decisionKeysFor lays as decision keys alone; the model key filter below lays none of them as a
  // model key. Parallel's is no model key's name, so it is never left unread. A held run its model kept from running
  // (hold.refused) lays no built-in harness's own key either (its agent never starts), so it opens none of those.
  const deciding = keyless && needs.decisionProviders.length > 0;
  const unread = [...(keyless ? MODEL_KEY_NAMES.filter((name) => !(deciding && DECISION_KEY_NAMES.has(name))) : []), ...(modelRefused ? BUILTIN_OWN_KEYS : [])];
  const working = await workingEnv(deps, unread);
  // The gateway's key (JEV_GATEWAY_KEY_ENV) is read for such a run only where its decisions would run on it
  // (decisions.ts decisionsUseGatewayKey, asked of the keys read so far): never for a gateway off OpenRouter, nor where
  // OpenRouter's own key or TypeSafe's answers its nodes. A web tool of a run that sends no model key is ranked by no Jev.
  if (deciding && decisionsUseGatewayKey(working, { providers: needs.decisionProviders, parallelWeb: launch.plane ? handsParallel(launch.plane) : false, jevWeb: false })) {
    const gateway = await savedKey(deps, JEV_GATEWAY_KEY_ENV);
    if (gateway !== undefined) working[JEV_GATEWAY_KEY_ENV] = gateway;
  }
  // An agentic run's model keys are its PINNED model's (the launch's, chosen at its start), the one its route sends, never
  // the host's default now: a key saved since the run started (another provider's, now first) would otherwise be opened
  // in its place, and the run would hold a key its model never sends and lack the one it does.
  const scoped = launch.model && !needs.tiers ? { ...needs, model: `${launch.model.provider}/${launch.model.modelId}` } : needs;
  const env: NodeJS.ProcessEnv = { ...base };
  // The key of a gateway saved in the console (model-gateway.ts) stays on the run environment its model routes read, never
  // on the tools': it is read there by name alone (claimModelEnv), as a run's own model key is.
  const savedGateway = savedGatewayIn(deps.env ?? {});
  // A model key is never enumerable, as withModelKeys lays a route's, but unlike a route's it stays writable and deletable
  // (withoutModelKeys drops it); a tool key is a plain value, which its tools read and hand on.
  for (const name of keysFor(scoped, working)) if (working[name] !== undefined && !(savedGateway && name === GATEWAY_KEY_ENV) && !(keyless && MODEL_KEY_NAMES.includes(name)) && !(modelRefused && BUILTIN_OWN_KEYS.includes(name))) Object.defineProperty(env, name, { value: working[name], enumerable: !MODEL_KEY_NAMES.includes(name), writable: true, configurable: true });
  // TypeSafe's key is a model key: a run whose model sends none (keyless) is not handed it for Jev's web ranking either,
  // and its web tools answer unranked.
  const decision = decisionKeysFor(working, { providers: needs.decisionProviders, parallelWeb: launch.plane ? handsParallel(launch.plane) : false, jevWeb: launch.plane && !keyless ? handsJevWeb(launch.plane, working, needs.harness) : false });
  // A decision key is a plain value, as before, under a model key's name too (OpenRouter's, which Jev's nodes use).
  for (const [name, value] of Object.entries(decision)) Object.defineProperty(env, name, { value, enumerable: true, writable: true, configurable: true });
  // The run's own tool keys, sealed with its launch: each one its revision declares, over the server's by the same name.
  // Opened by a runner, which holds the seal key; a run's own process is handed them with the rest of its claim's keys.
  if (runId !== undefined && deps.sealKey && deps.store.runs) {
    const carried = await openRunKeys({ runs: deps.store.runs, sealKey: deps.sealKey }, runId);
    const declared = carried ? declaredFrom(needs, revision) : [];
    const laid = Object.entries(carried ?? {}).filter(([name]) => declared.includes(name));
    if (laid.length) {
      if (!deps.redact) throw new Error(`Run ${runId} carries its own tool keys (${laid.map(([name]) => name).join(", ")}), and this claim has no redactor to cut them from what the run writes: none is laid.`);
      deps.redact.carry(runId, laid.map(([, value]) => value));
    }
    for (const [name, value] of laid) env[name] = value;
  }
  // The server's ChatGPT sign-in, read from the store for this claim: its token is asked at each request the run's model
  // proxy sends (chatgpt-plan.ts), never put on the environment its tools run under (a symbol no spawn copies). Only for
  // a run that can reach a plan model: one pinned to a key's model (and its tiers on keys) never holds the sign-in, which
  // renews and spends the person's plan for any process that holds it.
  const plan = keyless ? undefined : await planReaderOf(deps.store, deps.sealKey);
  return plan && reachesPlan(withPlan({ ...working }, plan), scoped, revision) ? withPlan(env, plan) : env;
}

/** Whether a run of `launch`, claimed by a runner of `env`, sends no model key: a held run its model kept from running at
 *  its create (hold.refused) runs its model nowhere; on a --faux runner (FAUX_ENV) every model is the faux model (model.ts
 *  chooseModel), which sends none, for a workflow's nodes and an agent's turns alike, pinned or not; and a launch pinned to
 *  the faux model (a --faux start's) sends none on any runner: one claimed by a runner on the same store without FAUX_ENV
 *  has no model of its own to send a key for. Such a run is laid no model key (claimSecrets), and its own process is
 *  handed none, a saved gateway's neither (run-child-host.ts). */
export const sendsNoModelKey = (launch: Pick<RunLaunch, "model" | "hold">, env: NodeJS.ProcessEnv): boolean => launch.hold?.refused !== undefined || Boolean(env[FAUX_ENV]) || launch.model?.provider === FAUX_PROVIDER;

const onPlan = (model: string | undefined): boolean => model?.startsWith(`${PLAN_PROVIDER}/`) === true;

/** Whether a run of `revision`, with `needs` scoped to its chosen model, can reach a model on the ChatGPT plan, by `env`
 *  (the claim's working environment carrying the sign-in's reader, so the host's defaults read as they would on the
 *  run): its own model (pinned, chosen at its start, or the host's default for its harness), a workflow's tiers' host
 *  models, or an agentic run's subagent tiers (its modelTiers, else the host's tier variables). A learned workflow's
 *  tiers are read once its seed chose them (tierModelKeys). */
function reachesPlan(env: NodeJS.ProcessEnv, needs: RunNeeds, revision: Revision): boolean {
  const own = needs.tiers ? needs.tiers.map((tier) => hostModel(env, tier)) : [needs.model ?? hostModel(env, "default", needs.harness)];
  // The claim's revision row carries the stored body whole (store/agent-body.ts AgenticBody), modelTiers with it.
  const named = revision.kind === "agentic" ? Object.values((revision.body as { modelTiers?: Record<string, unknown> }).modelTiers ?? {}) : [];
  const tiers = revision.kind === "agentic" ? [...named, ...TIERS.map((tier) => tierModelOf(env, tier))] : [];
  return [...own, ...tiers].some((model) => onPlan(typeof model === "string" ? model : undefined));
}

/** Every candidate secret in a working environment over the runner's base, read for one claim and scoped by its caller, so
 *  a key the run does not need is never put on the environment its tools run under. The server process's own environment
 *  value wins over the store's by the same name (the secrets rule 4: env always overrides a pasted value), so a key set
 *  where the server starts is not shadowed by a stale one saved in the store. `unread`: names the claim never lays, read
 *  from neither. */
async function workingEnv(deps: ClaimSecretsDeps, unread: readonly string[] = []): Promise<NodeJS.ProcessEnv> {
  const working: NodeJS.ProcessEnv = { ...withoutSecrets(deps.env ?? {}) };
  // A name present with no value (`-e NAME`, an empty optional secret) is not a key: the store's saved one stands.
  for (const name of CANDIDATES) {
    if (unread.includes(name)) continue;
    const value = await savedKey(deps, name);
    if (value !== undefined) working[name] = value;
  }
  return working;
}

/** The server's key `name`: the runner's environment's value, else the one saved in the store, opened under the seal key
 *  (none without one). Only that one row is read. */
async function savedKey(deps: ClaimSecretsDeps, name: string): Promise<string | undefined> {
  return deps.env?.[name] || (deps.sealKey ? await getSealedKey(deps.store, deps.sealKey, name) : undefined);
}

/** `keys` (learnedDecisionKeys') laid onto `env`, a claim's environment, where it holds no value of that name: what the
 *  claim laid stays, a run's own tool key over the server's above all. A name both read holds the same server key. */
export function underClaimed(env: NodeJS.ProcessEnv, keys: Readonly<Record<string, string>>): void {
  for (const [name, value] of Object.entries(keys)) if (!env[name]) env[name] = value;
}

/** The decision keys a run's learned workflows need, beside those claimSecrets scoped to its revision (whose own nodes
 *  are all needsOf reads, so an agentic run gets none there): the keys of the providers the chosen workflows' typed
 *  questions name (decisions.ts providersNamed, Jev for a node that names none), but any provider `allowed` refuses (the
 *  run's gate), read as claimSecrets reads its keys and scoped by decisionKeysFor. `workflows`: those the claim's seed
 *  lay chose for the run's learned_workflow tool (runner/learning-seed.ts), so this read comes after the lay. A
 *  workflow that does not parse or inspect names no provider: the tool refuses it before any node runs. No workflow, or
 *  no provider left, reads nothing. A fresh object per call, so no run's keys reach another's. */
export async function learnedDecisionKeys(deps: ClaimSecretsDeps, workflows: readonly Pick<LearnedWorkflow, "workflow">[], allowed: (provider: string) => boolean): Promise<Record<string, string>> {
  if (!workflows.length) return {};
  const { inspectWorkflow } = await import("@parcha/agentrun-dsl");
  const named = new Set<string>();
  for (const { workflow } of workflows) {
    let nodes: Record<string, unknown>[];
    try {
      const doc: unknown = JSON.parse(workflow);
      nodes = workflowNodes(doc, inspectWorkflow(doc));
    } catch {
      continue;
    }
    for (const id of providersNamed(nodes)) named.add(id);
  }
  return hostDecisionKeys(deps, [...named].filter((id) => allowed(id)));
}

/** The host's keys of the decision providers `providers` (bare ids), read as claimSecrets reads its keys and scoped by
 *  decisionKeysFor; none for none. learnedDecisionKeys hands them to a run; a learning end (LS-07) builds its check's
 *  providers on them, host-side, never handed to the run. A fresh object per call. */
export async function hostDecisionKeys(deps: ClaimSecretsDeps, providers: readonly string[]): Promise<Record<string, string>> {
  if (!providers.length) return {};
  // A run's own process holds no seal key: its runner reads them (held.ts).
  const at = deps.sealKey ? undefined : held();
  if (at) return at.decisionKeys(providers);
  return decisionKeysFor(await workingEnv(deps), { providers, parallelWeb: false, jevWeb: false });
}

/** The model keys the host's models of `tiers` need (model.ts modelKeys: each one's provider's, or the gateway's), read as
 *  claimSecrets reads a run's (the runner's environment first, then the key saved in Settings → Model keys), for a run's
 *  learned workflow nodes of those tiers (adapter-run-spec.ts learnedTierRoutes): claimSecrets opens only the run's own
 *  model's. For the tiers' routes alone, through withModelKeys (never enumerable), never onto a tool's environment.
 *  `refs`: a model named for a tier in place of the host's (an agentic revision's modelTiers, for its subagent tiers:
 *  subagentTierKeys), read on the runner alone; a run's process names none. It scopes the key names alone: the ChatGPT
 *  sign-in is given for the host's models of `tiers`, as before (a revision's own model on the plan reaches the sign-in
 *  through its claim: claimSecrets reachesPlan). */
export async function tierModelKeys(deps: ClaimSecretsDeps, tiers: readonly Tier[], refs: Readonly<Partial<Record<Tier, string>>> = {}): Promise<NodeJS.ProcessEnv> {
  // On a --faux runner every tier's model is the faux model (model.ts chooseModel), which sends no key: none is read.
  if (!tiers.length || deps.env?.[FAUX_ENV]) return {};
  // A run's own process holds no seal key: its runner reads them, the plan's reader with them (held.ts).
  const at = deps.sealKey ? undefined : held();
  if (at) {
    const given = await at.tierModelKeys(tiers);
    return given.plan ? withPlan({ ...given.keys }, given.plan) : { ...given.keys };
  }
  const working = await workingEnv(deps);
  const out: NodeJS.ProcessEnv = {};
  for (const name of modelKeys(working, undefined, tiers, refs)) if (working[name] !== undefined) out[name] = working[name];
  // The ChatGPT sign-in, when a host model of those tiers is on the plan (claimSecrets gives it only to a run whose own
  // models reach it), as a symbol withModelKeys reads, never a key.
  const plan = await planReaderOf(deps.store, deps.sealKey);
  const probe = withPlan({ ...working }, plan);
  return plan && tiers.some((tier) => onPlan(hostModel(probe, tier))) ? withPlan(out, plan) : out;
}

/** Every model key a model route reads by name: each of pi-ai's providers' (model.ts PROVIDER_KEYS) and the gateway's. */
export const MODEL_KEY_NAMES: readonly string[] = [...new Set([...Object.values(PROVIDER_KEYS).flat(), GATEWAY_KEY_ENV])];

/** `env` for a model route (model-route.ts routeOf, a CLI's providerFor): the runner's own environment, its secrets kept
 *  as runEnv makes them (readable by name, never enumerable), with each model key it lacks taken from `opened`: the keys
 *  a claim opened from the store (claimSecrets, scoped to the run's model), or every one the server holds
 *  (savedModelKeys). So a model key saved in Settings → Model keys reaches the next run's model requests with no
 *  restart, as a tool key reaches its tools; a key set where AgentRun starts still wins (claimSecrets reads it first),
 *  and a provider the runner holds any key of gets none of its saved ones. Each name is read from the first of `opened`
 *  that holds it, by name, as a run's process is handed its keys (run-child-host.ts handed): a claim's model keys, never
 *  enumerable, count as any other.
 *  The keys added are never enumerable either: a spread of the result, or a spawn given it, carries none of them. */
export function withModelKeys(env: NodeJS.ProcessEnv, ...opened: readonly NodeJS.ProcessEnv[]): NodeJS.ProcessEnv {
  // A provider's keys are filled together or not at all: only when the runner holds none of them. A credential handed where
  // AgentRun started (ANTHROPIC_AUTH_TOKEN, an AWS key id) is never mixed with a saved key of the same provider, which its
  // route would send first (ANTHROPIC_API_KEY before the token) or pair with it (another AWS name). A key held empty
  // (`-e NAME` with no value, which runEnv keeps as a fixed property) holds nothing: the saved key takes its place.
  const fill = new Map<string, string>();
  for (const names of [...Object.values(PROVIDER_KEYS), [GATEWAY_KEY_ENV]]) {
    if (names.some((name) => env[name])) continue;
    for (const name of names) {
      const value = opened.map((from) => from[name]).find((held) => held);
      if (value) fill.set(name, value);
    }
  }
  // Every property of `env` as it is (enumerable or not, as runEnv made it), but a name the fill replaces, so a fixed empty
  // property is never copied in its way.
  const out: NodeJS.ProcessEnv = {};
  for (const name of Object.getOwnPropertyNames(env)) {
    if (!fill.has(name)) Object.defineProperty(out, name, Object.getOwnPropertyDescriptor(env, name)!);
  }
  for (const [name, value] of fill) Object.defineProperty(out, name, { value, enumerable: false, writable: false, configurable: false });
  // The claim's ChatGPT sign-in (claimSecrets), else the runner's own.
  return withPlan(out, opened.map(planOf).find((plan) => plan) ?? planOf(env));
}

/** The saved model keys of the models of a run's subagent tiers (`tiers`, `refs` as subagent.ts routedSubagentTiers
 *  gives them; the revision's model of a tier over the host's): each model's provider's key, or the gateway's. None for
 *  no tier. */
export async function subagentTierKeys(deps: ClaimSecretsDeps, tiers: readonly Tier[], refs: Readonly<Partial<Record<Tier, string>>>): Promise<NodeJS.ProcessEnv> {
  if (!tiers.length) return {};
  // A run's own process holds no seal key: its runner reads them for the claim's tiers (held.ts).
  const at = deps.sealKey ? undefined : held();
  return at ? { ...(await at.subagentTierKeys()) } : tierModelKeys(deps, tiers, refs);
}

/** Every model key the server holds, for a model route with no revision to scope it by (an SDK run's compile turn): each
 *  by its name from `deps.env` first, then the store's sealed value, as claimSecrets reads them. */
export async function savedModelKeys(deps: ClaimSecretsDeps): Promise<NodeJS.ProcessEnv> {
  const out: NodeJS.ProcessEnv = {};
  for (const name of MODEL_KEY_NAMES) {
    const value = await savedKey(deps, name);
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/** A run's own model key, held by its claim (run-model-key.ts): `fresh()` opens it from the run's launch again (a message's
 *  new key replaces it, or a run that started on the server's key takes its first); `everHeld()`, whether the claim ever
 *  held one, so spend after the turn never falls to the server's key for a run that brought its own. */
export interface ClaimModelKey extends HeldModelKey {
  fresh(): Promise<void>;
  everHeld(): boolean;
  /** Calls `listener` with the key now and with each new one fresh() opens: the run's redactors hold every key it held. */
  watch(listener: (key: string) => void): void;
}

/** How many times fresh() reads a run's launch before it gives up, and the first wait between reads (doubled each time). */
const FRESH_TRIES = 3;
const FRESH_WAIT_MS = 50;

/** Run `runId`'s own model key as its launch's sealed column holds it, opened under `deps.sealKey`: none for a launch that
 *  holds none (or no launch row: a test's, an import's), and none for a run none of whose routes sends a model key (held,
 *  or on a --faux runner: sendsNoModelKey of its launch's hold and the runner's `deps.env`), whose launch is never opened for it: a key it never sends is never
 *  read, at its claim (claimModelKey), at a message's (fresh()), or for its process (held.ts runModelKey). Throws, in
 *  words, where the launch does not open. */
export async function openRunModelKey(deps: { readonly store: { readonly runs: RunModelKeyReader }; readonly sealKey: Buffer | undefined; readonly env?: NodeJS.ProcessEnv }, runId: string): Promise<RunModelKey | undefined> {
  const row = await deps.store.runs.launch(runId).catch((error: unknown) => {
    if (error instanceof StoreLaunchMissing) return undefined;
    throw error;
  });
  if (!row || row.sealed === null) return undefined;
  // By its hold and the runner alone: a pin to the faux model makes the run's own model faux, while its subagent tiers,
  // its learned workflows and a workflow's model nodes route as the runner's, by tier, on this key.
  if (sendsNoModelKey({ hold: readLaunchBody(row.body)?.hold }, deps.env ?? {})) return undefined;
  const sealed = row.sealed;
  const opened = deps.sealKey ? openRunLaunch(deps.sealKey, runId, sealed) : undefined;
  if (!opened) throw new Error("This run's launch secrets do not open with this runner's seal key: its model key is not sent.");
  return opened.model;
}

/** Run `runId`'s own tool keys as its launch's sealed column holds them (run-keys.ts), opened under `deps.sealKey`: none
 *  for a launch that holds none (or no launch row). Throws, in words, where the launch does not open. */
export async function openRunKeys(deps: { readonly runs: RunLaunchReader; readonly sealKey: Buffer }, runId: string): Promise<RunToolKeys | undefined> {
  const sealed = await deps.runs.launch(runId).then((launch) => launch.sealed, (error: unknown) => {
    if (error instanceof StoreLaunchMissing) return null;
    throw error;
  });
  if (sealed === null) return undefined;
  const opened = openRunLaunch(deps.sealKey, runId, sealed);
  if (!opened) throw new Error("This run's launch secrets do not open with this runner's seal key: its keys are not sent.");
  return opened.keys;
}

/**
 * The run's own model key for claim `runId`, opened from its launch's sealed column under the runner's seal key (the
 * server sealed it there with mcp_auth, store/seal.ts). Undefined only where the server has no gateway and the run holds
 * no key: a claim on a gateway server holds one even before the run's first key, so a message that hands it one reaches
 * the next request (fresh()). Read at every claim, a reclaim after a runner's crash among them, so a run's key outlives no
 * process but its own launch row. A run that sends no model key (sendsNoModelKey) holds none, ever: openRunModelKey never
 * opens its launch for one. Throws, in words, when its launch does not open, or when the key was handed for another
 * gateway than AGENT_MODEL_BASE_URL's now: it is never sent where it was not handed for.
 */
export async function claimModelKey(deps: { readonly store: { readonly runs: RunModelKeyReader }; readonly sealKey: Buffer | undefined; readonly env?: NodeJS.ProcessEnv }, runId: string): Promise<ClaimModelKey | undefined> {
  const origin = runModelOrigin(deps.env ?? {});
  // A run's own process holds no seal key: its runner opens the claim's own launch, whatever run id this one names (held.ts).
  const at = deps.sealKey ? undefined : runnerSeam();
  const open = (): Promise<RunModelKey | undefined> => (at ? at.runModelKey() : openRunModelKey(deps, runId));
  let held = await open();
  if (held && held.origin !== origin) throw new Error(`This run's model key was handed for the gateway at ${held.origin}, and AGENT_MODEL_BASE_URL names ${origin ?? "none"} here now: the key is never sent anywhere else.`);
  if (!origin) return undefined;
  let ever = held !== undefined;
  const listeners: ((key: string) => void)[] = [];
  return {
    origin,
    key: () => held?.key,
    everHeld: () => ever,
    // A message that hands no key keeps the run's (the server's write keeps it), so none here is a run whose launch holds
    // none (yet, or no longer). A key for another origin is never taken. Fail-closed: a launch that cannot be read is read
    // again, FRESH_TRIES in all with a growing wait, and then fresh() throws, so the command that asked is not handed to
    // the session (the runner leaves its row untaken and delivers it again at its next poll). A message's key is never
    // replaced by the key the claim held before it, nor by the server's.
    fresh: async () => {
      let now: RunModelKey | undefined;
      for (let attempt = 1; ; attempt++) {
        try {
          now = await open();
          break;
        } catch (error) {
          if (attempt >= FRESH_TRIES) throw new Error(`the run's model key could not be read from its launch (${FRESH_TRIES} tries): the message is held until it can be, never sent on another key: ${(error as Error)?.message ?? error}`);
          await new Promise((resolve) => setTimeout(resolve, FRESH_WAIT_MS * 2 ** (attempt - 1)));
        }
      }
      held = now && now.origin === origin ? now : undefined;
      if (held) {
        ever = true;
        for (const listener of listeners) listener(held.key);
      }
    },
    watch: (listener) => {
      listeners.push(listener);
      if (held) listener(held.key);
    },
  };
}

/** The run's own model key held by `redact` (one of the run's redactors), the key now and each one a message hands it. */
export function holdRunKey(redact: HeldRedact, runKey: ClaimModelKey): void {
  runKey.watch((key) => redact.hold([key]));
}

/** Whether the claim opened a key of the run's own at its start: its routes then carry that key alone, its tools hold no
 *  model key, and no saved key is read for it. */
export const keyedAtClaim = (runKey: ClaimModelKey | undefined): boolean => runKey?.key() !== undefined;

/** Whether the server has a gateway (AGENT_MODEL_BASE_URL) and holds no key for it, in the runner's environment or saved:
 *  claimSpendOff's spend with no key to pay it. The gateway's key alone is read, never another saved model key. */
export async function serverKeyless(deps: ClaimSecretsDeps): Promise<boolean> {
  return runModelOrigin(deps.env ?? {}) !== undefined && !(await savedKey(deps, GATEWAY_KEY_ENV));
}

/** Why the claim's model spend after the run's turn, or beside it on runs the runner starts (a shadow audit, a replay
 *  check), is skipped: `what` the work, asked when that spend would start. A claim that holds the run's own key now runs
 *  it on that key (the runs it starts take a sealed copy of it, store/seal.ts sealHandedLaunch), whatever the server
 *  holds. A run that brought its own key, at its start or with a message since (everHeld), and holds none now: that key
 *  was erased with its turn's end and the server's never pays for it (runKeyEndedFor). Else, a server that holds no
 *  gateway key (the runner's environment or Settings → Model keys) has none to spend (noServerKeyWords). Undefined where
 *  it runs. */
export async function claimSpendOff(deps: ClaimSecretsDeps, runKey: ClaimModelKey | undefined): Promise<(what: string) => string | undefined> {
  // A run's own process holds no seal key, nor every saved key: its runner says whether the server holds a gateway key.
  const at = deps.sealKey ? undefined : held();
  const keyless = at ? await at.serverKeyless() : await serverKeyless(deps);
  return (what) => (runKey?.key() !== undefined ? undefined : runKey?.everHeld() ? runKeyEndedFor(what) : keyless ? noServerKeyWords(what) : undefined);
}

/** Whether the claim holds the run's own model key now: the learning work it starts then spends on that key, out of what
 *  the run's cap leaves (learning-work.ts). Read when that work starts, never cached. */
export const keyedNow = (runKey: ClaimModelKey | undefined): (() => boolean) => () => runKey?.key() !== undefined;

/** The env a claimed run's model routes read: the run's own key alone where the claim opened one (withRunModelKey); else
 *  the runner's environment with the keys `opened` for it, each name from the first source that holds it (withModelKeys),
 *  whose gateway variables read the run's key once a message hands it one (withRunModelKeyLater). */
export function claimModelEnv(env: NodeJS.ProcessEnv, opened: readonly NodeJS.ProcessEnv[], runKey: ClaimModelKey | undefined, claim?: Pick<Claim, "runId" | "turn" | "attempt">): NodeJS.ProcessEnv {
  // The claim's run, turn and attempt, which each request on serve's gateway names (request-metadata.ts).
  if (!runKey) return withRequestMetadata(withModelKeys(env, ...opened), claim);
  return withRequestMetadata(keyedAtClaim(runKey) ? withRunModelKey(env, runKey) : withRunModelKeyLater(withModelKeys(env, ...opened), runKey), claim);
}

/** The decision providers' own keys (decisions.ts: Jev's TypeSafe key, OpenRouter's, Parallel's): some are also pi-ai
 *  provider names, but a run's model key never replaces them, so withoutModelKeys keeps them. */
const DECISION_KEY_NAMES: ReadonlySet<string> = new Set([JEV_KEY_ENV, JEV_OPENROUTER_KEY_ENV, PARALLEL_KEY_ENV]);

/** `toolEnv` with no model key in it, for a run that holds its own: a tool's environment never carries a model key the
 *  run's model routes do not send. The decision providers' keys stay (DECISION_KEY_NAMES): a keyed workflow's judge,
 *  pick, sift, route and ask nodes run on them as any run's do. */
export function withoutModelKeys(toolEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  for (const name of MODEL_KEY_NAMES) if (!DECISION_KEY_NAMES.has(name)) delete toolEnv[name];
  return toolEnv;
}

