// Decision providers: the models a workflow's judge, pick, sift, route and ask nodes ask, through the DSL's `runJudge`.
// This server runs three, each when its environment names the provider's key: Jev (TypeSafe's System One), on
// TYPESAFE_API_KEY (the route to use), or for Jev through OpenRouter OPENROUTER_API_KEY, else an OpenRouter model
// gateway's AGENT_MODEL_API_KEY; Parallel Decisions, on PARALLEL_API_KEY; and OpenRouter's Decisions models, on the
// same OpenRouter key Jev's OpenRouter route reads. A node names its provider (`provider: "parallel"`); one that names
// none is answered by Jev.
//
// The keys a run gets (decisionKeysFor): its workflow's decision providers' keys, Parallel's where one of its web tools
// resolves to Parallel and TypeSafe's where its web tools run Jev (tool-plane.ts handsParallel, handsJevWeb), and no
// other. The runner's claim reads them from the store and lays them on the claim's own environment
// (runner/claim-secrets.ts claimSecrets), the `ToolHost.env` its tools and providers read (parallelKeyOf,
// decisionProvidersIn, web-run.ts jevWebOf), a fresh object per claim, so no run sees another's. The run's shell is
// never given it (workspace/hands.ts shellEnv is fixed). On the OpenRouter route the Jev key is also the model
// gateway's key, which the claim holds for its model nodes.
//
// The pipe path (`DECISION_KEY_FD_ENV`, handedKeys) is dead: it was the old per-run process's, and nothing in src has
// set it since #2244 removed that engine. Only tests set it; its deletion is its own change.
import { closeSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { DecisionProvider } from "@parcha/agentrun-dsl";
import { openRouterApp } from "@parcha/agentrun-kernel/host";
import { JEV_MODEL } from "@parcha/agentrun-web";
import { WEB_JEV_OFF_ENV, webJevOff } from "./env-switch.js";
import { FAUX_ENV } from "./model.js";
import { keyNeeded } from "./key-words.js";

export const JEV_KEY_ENV = "TYPESAFE_API_KEY";
export const JEV_OPENROUTER_KEY_ENV = "OPENROUTER_API_KEY";
export const PARALLEL_KEY_ENV = "PARALLEL_API_KEY";
/** The provider a decision node that names none is answered by. */
export const DEFAULT_DECISION_PROVIDER = "jev";
/** The adapter a workflow's typed questions run through. */
export const DECISION_ADAPTER = "runJudge";
/** Set on a run's process the server hands decision keys: the descriptor's number, never a key. The keys come as one
 *  JSON object of variable name to value, on the first descriptor after the process's stdio and its secrets pipe:
 *  macOS aborts the parent of a spawn with a pipe at 16 or above. */
export const DECISION_KEY_FD_ENV = "AGENTRUN_SERVE_DECISION_KEY_FD";
/** Under --faux only: a module whose default export is the fetch Jev's runner sends through, in place of TypeSafe's
 *  API (the tests' fake). */
export const FAUX_JEV_ENV = "AGENTRUN_SERVE_FAUX_JEV";
/** Under --faux only: a module whose default export is the fetch the Parallel provider sends through, in place of
 *  Parallel's API (the tests' fake). */
export const FAUX_PARALLEL_ENV = "AGENTRUN_SERVE_FAUX_PARALLEL";
/** Under `faux` only (startServe's `fauxOpenrouter`): a module whose default export is the fetch the OpenRouter decisions
 *  provider sends through, in place of OpenRouter's System One API (`@parcha/agentrun-decisions/testing/faux-system-one`
 *  is one). */
export const FAUX_OPENROUTER_ENV = "AGENTRUN_SERVE_FAUX_OPENROUTER";

/** One decision provider as capabilities lists it: whether this server runs it, when not why, and what to know when
 *  it runs in a way the operator should hear of. */
export type DecisionOffer = { id: "jev" | "parallel" | "openrouter"; available: boolean; reason?: string; note?: string; route?: ParallelRoute };
/** Where a node naming `parallel` is answered: Parallel's own API, or Parallel's model through OpenRouter. */
export type ParallelRoute = "parallel" | "openrouter";
/** Parallel's model on OpenRouter, the route a server with no Parallel key and an OpenRouter one takes. */
export const PARALLEL_ON_OPENROUTER = "parallel/decisions-fast";

/** The route `parallel` runs on here: Parallel's own key first, else the OpenRouter key Jev's OpenRouter route reads. */
export const parallelRoute = (env: NodeJS.ProcessEnv): ParallelRoute | undefined => (isSet(env[PARALLEL_KEY_ENV]) ? "parallel" : openRouterKeyEnv(env) ? "openrouter" : undefined);

const isSet = (value: string | undefined) => typeof value === "string" && value.trim() !== "";

/** The model gateway's key (model.ts), Jev's on the OpenRouter route when that gateway is OpenRouter. */
export const JEV_GATEWAY_KEY_ENV = "AGENT_MODEL_API_KEY";

/** AgentRun's OpenRouter app attribution for a Decisions provider on OpenRouter (the kernel's one helper names the app), or
 *  none where AGENTRUN_OPENROUTER_ATTRIBUTION=off. */
const appOf = (env: NodeJS.ProcessEnv): { app?: { url: string; title: string; categories: string } } => {
  const app = openRouterApp(env);
  return app ? { app: { ...app } } : {};
};

/** The variable Jev's OpenRouter key is in: OPENROUTER_API_KEY, else the model gateway's key when AGENT_MODEL_BASE_URL's
 *  host is exactly openrouter.ai. Jev sends it to openrouter.ai, so another host's key never goes there. */
function openRouterKeyEnv(env: NodeJS.ProcessEnv): string | undefined {
  if (isSet(env[JEV_OPENROUTER_KEY_ENV])) return JEV_OPENROUTER_KEY_ENV;
  const onOpenRouter = URL.parse(env.AGENT_MODEL_BASE_URL ?? "")?.hostname === "openrouter.ai";
  return onOpenRouter && isSet(env[JEV_GATEWAY_KEY_ENV]) ? JEV_GATEWAY_KEY_ENV : undefined;
}

/** The key Jev runs on here and its route: TypeSafe's API when its key is set, else OpenRouter's System One when an
 *  OpenRouter key is (openRouterKeyEnv). */
export function jevKey(env: NodeJS.ProcessEnv): { route: "typesafe" | "openrouter"; key: string } | undefined {
  if (isSet(env[JEV_KEY_ENV])) return { route: "typesafe", key: env[JEV_KEY_ENV]! };
  const name = openRouterKeyEnv(env);
  return name ? { route: "openrouter", key: env[name]! } : undefined;
}

/** How this server reaches Jev, when it does. */
export const jevRoute = (env: NodeJS.ProcessEnv) => jevKey(env)?.route;

/** The keys the server hands a workflow run's process, by name: Jev's, as TYPESAFE_API_KEY or, on the OpenRouter route,
 *  as OPENROUTER_API_KEY whichever variable holds it; an OpenRouter key (openRouterKeyEnv) as OPENROUTER_API_KEY for
 *  OpenRouter's Decisions models, on either Jev route; and Parallel's. */
export function decisionKeysOf(env: NodeJS.ProcessEnv): Record<string, string> {
  const jev = jevKey(env);
  const openrouter = openRouterKeyEnv(env);
  return {
    ...(jev ? { [jev.route === "typesafe" ? JEV_KEY_ENV : JEV_OPENROUTER_KEY_ENV]: jev.key } : {}),
    ...(openrouter ? { [JEV_OPENROUTER_KEY_ENV]: env[openrouter]! } : {}),
    ...(isSet(env[PARALLEL_KEY_ENV]) ? { [PARALLEL_KEY_ENV]: env[PARALLEL_KEY_ENV]! } : {}),
  };
}

/** What a run's decision keys are for: the providers of its workflow's typed questions (providersNamed), whether one
 *  of its web tools resolves to Parallel (tool-plane.ts' handsParallel), whose client reads Parallel's key (web-run.ts
 *  webOf), and whether one of them runs with Jev ranking its results (web-run.ts handsJevWeb), on TypeSafe's key. */
export type DecisionNeeds = { providers: readonly string[]; parallelWeb: boolean; jevWeb?: boolean };

/** What capabilities' why says of Jev on `tool` under the server's `env`: on, on TypeSafe's route, naming what the tool
 *  sends TypeSafe (a search: its objective and each result's URL, title, snippet and published date; a fetch given an objective: the
 *  page's text and the objective); off by AGENTRUN_WEB_JEV_OFF; off with only an OpenRouter key (the web decider runs
 *  on TypeSafe's route alone). Nothing with no Jev key at all. */
export function jevWebWhy(env: NodeJS.ProcessEnv, tool: "web_search" | "web_fetch" = "web_search"): string | undefined {
  if (webJevOff(env)) return `Jev off (${WEB_JEV_OFF_ENV})`;
  const route = jevRoute(env);
  if (route === "typesafe") {
    return tool === "web_search"
      ? `Jev (${JEV_MODEL}) ranks results against the objective, or the query when none is given; each search sends that and each result's URL, title, snippet and published date to TypeSafe, billed per request on the server's TypeSafe key`
      : `a fetch given an objective sends the page's text and the objective to TypeSafe for Jev (${JEV_MODEL}) to pick its chunks, billed per request on the server's TypeSafe key; a fetch with none sends TypeSafe nothing`;
  }
  return route === "openrouter" ? "Jev off: no TypeSafe key" : undefined;
}

/** The decision keys the server hands a run's process for `needs`, of those it holds (decisionKeysOf): Jev's by its route
 *  (TypeSafe's, or OpenRouter's), OpenRouter's for an OpenRouter decision node, Parallel's for a Parallel one or for a
 *  web tool that resolves to Parallel, TypeSafe's for web tools Jev ranks (`jevWeb`; on TypeSafe's route only). None
 *  else: a run with no decision node, no web tool on Parallel and no web tool Jev ranks gets no descriptor at all. */
export function decisionKeysFor(env: NodeJS.ProcessEnv, needs: DecisionNeeds): Record<string, string> {
  const names = new Set<string>();
  for (const id of needs.providers) {
    const route = id === DEFAULT_DECISION_PROVIDER ? jevRoute(env) : undefined;
    if (route) names.add(route === "typesafe" ? JEV_KEY_ENV : JEV_OPENROUTER_KEY_ENV);
    if (id === "openrouter") names.add(JEV_OPENROUTER_KEY_ENV);
    if (id === "parallel") { const route = parallelRoute(env); if (route) names.add(route === "parallel" ? PARALLEL_KEY_ENV : JEV_OPENROUTER_KEY_ENV); }
  }
  if (needs.parallelWeb) names.add(PARALLEL_KEY_ENV);
  if (needs.jevWeb && jevRoute(env) === "typesafe") names.add(JEV_KEY_ENV);
  return Object.fromEntries(Object.entries(decisionKeysOf(env)).filter(([name]) => names.has(name)));
}

/** A stand-in for the model gateway's key, never a key: what decisionsUseGatewayKey sets in its place. */
const GATEWAY_KEY_PROBE = "agentrun-gateway-key-probe";

/** Whether decisionKeysFor would lay a key for `needs` from the model gateway's key (JEV_GATEWAY_KEY_ENV), were `env` to
 *  hold one: asked of decisionKeysFor itself with a stand-in in its place, so the answer is this file's rule
 *  (openRouterKeyEnv: no OpenRouter key of its own and AGENT_MODEL_BASE_URL on openrouter.ai, for a provider that reads an
 *  OpenRouter key) and never a copy of it. A claim that lays no model key reads the gateway's only where this holds
 *  (claim-secrets.ts claimSecrets). */
export function decisionsUseGatewayKey(env: NodeJS.ProcessEnv, needs: DecisionNeeds): boolean {
  return Object.values(decisionKeysFor({ ...env, [JEV_GATEWAY_KEY_ENV]: GATEWAY_KEY_PROBE }, needs)).includes(GATEWAY_KEY_PROBE);
}

/** Why Jev does not run here, naming the variable to set. */
export const jevMissing = `A workflow's judge, pick, sift, route and ask nodes need ${keyNeeded([JEV_KEY_ENV])}. Jev also runs through OpenRouter, on ${keyNeeded([JEV_OPENROUTER_KEY_ENV])}, or on ${JEV_GATEWAY_KEY_ENV} with AGENT_MODEL_BASE_URL on openrouter.ai, set where the server starts.`;

/** Why Parallel does not run here, naming the variable to set. */
export const parallelMissing = `A decision node naming the provider "parallel" needs ${keyNeeded([PARALLEL_KEY_ENV])}, or runs on OpenRouter's ${PARALLEL_ON_OPENROUTER} with ${keyNeeded([JEV_OPENROUTER_KEY_ENV])}.`;
/** The note on the OpenRouter route: which model and key, and how to use Parallel's API instead. */
export const parallelNote = (env: NodeJS.ProcessEnv) => `Runs on OpenRouter's ${PARALLEL_ON_OPENROUTER}, on ${openRouterKeyEnv(env)}, the model gateway key on this server, which a run's processes hold in their environment. Its web citations are its evidence, as on Parallel's API; set ${PARALLEL_KEY_ENV} to use Parallel's API directly.`;

/** Why the OpenRouter route is worth a note, naming the variable Jev runs on: its key is also the model gateway's, which
 *  a run's process holds. */
export const jevGatewayNote = (env: NodeJS.ProcessEnv) => `Jev runs on ${openRouterKeyEnv(env)}, the model gateway key on this server, which a run's processes hold in their environment for its model nodes. Set ${JEV_KEY_ENV} to keep the decision key out of them.`;

/** Why OpenRouter's decision models do not run here, naming the variable to set. */
export const openrouterMissing = `A decision node naming the provider "openrouter" needs ${keyNeeded([JEV_OPENROUTER_KEY_ENV])}, or ${JEV_GATEWAY_KEY_ENV} with AGENT_MODEL_BASE_URL on openrouter.ai, set where the server starts.`;

/** What to know of OpenRouter's decision models here: the key they run on, which a run's process holds as the model
 *  gateway's, and that images go only to a model the catalog lists with image input, untested live. */
export const openrouterNote = (env: NodeJS.ProcessEnv) => `Any OpenRouter Decisions model, named by the node's model (required), on ${openRouterKeyEnv(env)}, the model gateway key on this server, which a run's processes hold in their environment. Images are experimental: sent only to a model OpenRouter's catalog lists with image input.`;

/** What this server offers of each decision provider. */
export function decisionsOf(env: NodeJS.ProcessEnv): DecisionOffer[] {
  const route = jevRoute(env);
  const jev: DecisionOffer = route === "typesafe" ? { id: "jev", available: true } : route === "openrouter" ? { id: "jev", available: true, note: jevGatewayNote(env) } : { id: "jev", available: false, reason: jevMissing };
  const parallelOn = parallelRoute(env);
  const parallel: DecisionOffer = parallelOn === "parallel" ? { id: "parallel", available: true, route: "parallel" } : parallelOn === "openrouter" ? { id: "parallel", available: true, route: "openrouter", note: parallelNote(env) } : { id: "parallel", available: false, reason: parallelMissing };
  const openrouter: DecisionOffer = openRouterKeyEnv(env) ? { id: "openrouter", available: true, note: openrouterNote(env) } : { id: "openrouter", available: false, reason: openrouterMissing };
  return [jev, parallel, openrouter];
}

/** Why provider `id` does not run here and the variables that would make it run; undefined when it runs, and no `needs`
 *  for a provider this server does not have at all. */
export function providerMissing(env: NodeJS.ProcessEnv, id: string): { message: string; needs?: string[] } | undefined {
  if (id === DEFAULT_DECISION_PROVIDER) return jevRoute(env) ? undefined : { message: jevMissing, needs: [JEV_KEY_ENV] };
  if (id === "parallel") return parallelRoute(env) ? undefined : { message: parallelMissing, needs: [PARALLEL_KEY_ENV, JEV_OPENROUTER_KEY_ENV] };
  if (id === "openrouter") return openRouterKeyEnv(env) ? undefined : { message: openrouterMissing, needs: [JEV_OPENROUTER_KEY_ENV] };
  return { message: `This server's decision providers are jev, parallel and openrouter; this workflow also names the provider ${id}.` };
}

/** The providers a workflow's typed questions are answered by (`nodes` from workflowNodes): each decision node's and
 *  `ask` predicate's own, else the default, as is a generative node's `verify`. */
export function providersNamed(nodes: readonly Record<string, unknown>[]): string[] {
  const ids = new Set<string>();
  const add = (at: unknown) => ids.add(typeof (at as { provider?: unknown }).provider === "string" ? ((at as { provider: string }).provider) : DEFAULT_DECISION_PROVIDER);
  for (const node of nodes) {
    if (["judge", "pick", "sift"].includes(node.node as string) || (node.node === "route" && node.valuePath === undefined)) add(node);
    for (const predicate of [node.node === "loop" ? node.until : undefined, node.node === "escalate" ? node.when : undefined]) {
      if ((predicate as { predicate?: unknown } | undefined)?.predicate === "ask") add(predicate);
    }
    if (node.verify) ids.add(DEFAULT_DECISION_PROVIDER);
  }
  return [...ids];
}

/** Each decision a workflow asks that pins its model (`model`), with its node's label and its provider (Jev for one
 *  that names none): what a capped start prices before the run (runnable.ts). */
export function decisionModelsNamed(nodes: readonly Record<string, unknown>[]): { label: string; provider: string; model: string }[] {
  const out: { label: string; provider: string; model: string }[] = [];
  const add = (at: unknown, label: unknown) => {
    const { provider, model } = (at ?? {}) as { provider?: unknown; model?: unknown };
    if (typeof model === "string" && model.trim()) out.push({ label: String(label ?? ""), provider: typeof provider === "string" ? provider : DEFAULT_DECISION_PROVIDER, model });
  };
  for (const node of nodes) {
    if (["judge", "pick", "sift"].includes(node.node as string) || (node.node === "route" && node.valuePath === undefined)) add(node, node.label);
    for (const predicate of [node.node === "loop" ? node.until : undefined, node.node === "escalate" ? node.when : undefined]) {
      if ((predicate as { predicate?: unknown } | undefined)?.predicate === "ask") add(predicate, node.label);
    }
  }
  return out;
}

/** The keys a per-run process was handed on its pipe, once read: process-wide on purpose, as that process is one run's.
 *  The runner (one process for many claims) never reads the pipe: each claim's keys are in its own environment
 *  (parallelKeyOf, decisionProvidersIn), so nothing here is shared between claims. */
let keysHanded: Record<string, string> | undefined;
/** The keys the server handed the run's process, by name: read at the first call and the descriptor closed, and the
 *  same object at every later one (the decision providers' and the web tools'), so the descriptor is read and closed once
 *  whoever asks first. Empty when none were handed, or when the first read failed. */
export function handedKeys(env: NodeJS.ProcessEnv): Record<string, string> {
  if (keysHanded) return keysHanded;
  keysHanded = {};
  const fd = Number(env[DECISION_KEY_FD_ENV]);
  if (!Number.isSafeInteger(fd) || fd < 3) return keysHanded;
  try {
    const keys: unknown = JSON.parse(readFileSync(fd, "utf8"));
    return (keysHanded = Object.fromEntries([JEV_KEY_ENV, JEV_OPENROUTER_KEY_ENV, PARALLEL_KEY_ENV].flatMap((name) => (typeof (keys as Record<string, unknown>)?.[name] === "string" ? [[name, (keys as Record<string, string>)[name]]] : []))));
  } finally {
    closeSync(fd);
  }
}

/** The Parallel key a call's environment holds: in the claim's own environment, where the runner's claim put it
 *  (claim-secrets.ts), or on the dead pipe path where `DECISION_KEY_FD_ENV` is set (handedKeys; only tests set it). Read
 *  from the environment the call is given each time, so a claim's key is its own. */
export function parallelKeyOf(env: NodeJS.ProcessEnv): string | undefined {
  return handedKeyOf(env, PARALLEL_KEY_ENV);
}

/** The key in the variable `name`, as a claim holds it: in `env`, the claim's own environment (claim-secrets.ts); on the
 *  dead pipe path (`DECISION_KEY_FD_ENV` set, only by tests) from the keys handed on it; undefined where it holds none. */
export function handedKeyOf(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (env[DECISION_KEY_FD_ENV] !== undefined) return handedKeys(env)[name];
  return isSet(env[name]) ? env[name] : undefined;
}

/** Under --faux only: the fetch the module `env[name]` names, in place of a provider's API (the tests' fake). */
export const fauxFetch = async (env: NodeJS.ProcessEnv, name: string) =>
  env[FAUX_ENV] && env[name] ? ((await import(pathToFileURL(env[name]).href)) as { default: typeof fetch }).default : undefined;

/** In a run's process: the decision providers its workflow's typed questions are answered by, on the keys the server
 *  handed it (Jev's, Parallel's), and the one a node that names none gets; undefined when it handed none. Called once per
 *  process, on the keys handedKeys read once for it and the web tools alike. The run's judge (`judgeFromProviders`) and its
 *  checks before any node runs take this one registry, so a node's provider and timeoutMs hold, and a node naming a
 *  provider it lacks is refused before the run instead of being asked of another. Each provider sends a request once: one that fails after it
 *  was sent may have been answered and billed, so the decision escalates as interrupted instead of being asked again. */
export async function decisionProvidersOf(env: NodeJS.ProcessEnv): Promise<{ providers: Record<string, DecisionProvider>; default: string } | undefined> {
  return decisionProvidersFrom(handedKeys(env), env);
}

/** In the runner (one process for many runs): a claim's decision providers, built from the decision keys in its own
 *  environment (claim-secrets.ts read them from the store into it), never from a shared pipe or a process-wide cache. The
 *  same providers decisionProvidersOf builds, on the keys the claim's environment holds (decisionKeysOf). */
export async function decisionProvidersIn(env: NodeJS.ProcessEnv): Promise<{ providers: Record<string, DecisionProvider>; default: string } | undefined> {
  return decisionProvidersFrom(decisionKeysOf(env), env);
}

/** The decision providers on the keys `handed` (by name), with each provider's faux fetch read from `env` under --faux: Jev
 *  (TypeSafe's or OpenRouter's route), Parallel (its own API or OpenRouter), and OpenRouter's Decisions models. Undefined
 *  when `handed` names no provider key. The one builder behind decisionProvidersOf (the per-run pipe) and decisionProvidersIn
 *  (the runner's store), so both routes build the same providers. */
async function decisionProvidersFrom(handed: Record<string, string>, env: NodeJS.ProcessEnv): Promise<{ providers: Record<string, DecisionProvider>; default: string } | undefined> {
  const providers: Record<string, DecisionProvider> = {};
  const jev = handed[JEV_KEY_ENV] !== undefined ? { apiKey: handed[JEV_KEY_ENV] } : handed[JEV_OPENROUTER_KEY_ENV] !== undefined ? { provider: "openrouter" as const, apiKey: handed[JEV_OPENROUTER_KEY_ENV] } : undefined;
  if (jev) {
    const [{ jevProvider }, faux] = await Promise.all([import("@parcha/agentrun-jev"), fauxFetch(env, FAUX_JEV_ENV)]);
    providers.jev = jevProvider({ ...jev, ...(faux ? { fetch: faux } : {}) });
  }
  if (handed[PARALLEL_KEY_ENV] !== undefined) {
    const [{ parallelProvider }, faux] = await Promise.all([import("@parcha/agentrun-decisions"), fauxFetch(env, FAUX_PARALLEL_ENV)]);
    providers.parallel = parallelProvider({ apiKey: handed[PARALLEL_KEY_ENV], ...(faux ? { fetch: faux } : {}) });
  } else if (handed[JEV_OPENROUTER_KEY_ENV] !== undefined) {
    // No Parallel key handed: Parallel's model through OpenRouter, on the OpenRouter key (parallelRoute chose it).
    const [{ parallelProvider }, faux] = await Promise.all([import("@parcha/agentrun-decisions"), fauxFetch(env, FAUX_OPENROUTER_ENV)]);
    providers.parallel = parallelProvider({ openrouter: { apiKey: handed[JEV_OPENROUTER_KEY_ENV], ...appOf(env) }, ...(faux ? { fetch: faux } : {}) });
  }
  if (handed[JEV_OPENROUTER_KEY_ENV] !== undefined) {
    const [{ openrouterProvider }, faux] = await Promise.all([import("@parcha/agentrun-decisions"), fauxFetch(env, FAUX_OPENROUTER_ENV)]);
    providers.openrouter = openrouterProvider({ apiKey: handed[JEV_OPENROUTER_KEY_ENV], ...(faux ? { fetch: faux } : {}), ...appOf(env) });
  }
  return Object.keys(providers).length ? { providers, default: DEFAULT_DECISION_PROVIDER } : undefined;
}
