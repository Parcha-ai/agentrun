// Decision providers: the models a workflow's judge, pick, sift, route and ask nodes ask, through the DSL's `runJudge`.
// This server runs two, each when its environment names the provider's key: Jev (TypeSafe's System One), on
// TYPESAFE_API_KEY (the route to use) or OPENROUTER_API_KEY for Jev through OpenRouter, and Parallel Decisions, on
// PARALLEL_API_KEY. A node names its provider (`provider: "parallel"`); one that names none is answered by Jev.
//
// The TypeSafe and Parallel keys never enter a run's environment, which the run's tools and its model's provider read
// (`ToolHost.env`, a call node's effect). The server drops the variables from the run's process and hands their values
// over once, by name, on an inherited pipe (`DECISION_KEY_FD_ENV` names it), at each launch of a workflow run. The run's
// process reads them into its providers and nowhere else. On the OpenRouter route the Jev key is also the model gateway's
// key, which the run's process already holds in its environment for its model nodes. That route keeps it there.
import { closeSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { DecisionProvider } from "@parcha/agentrun-dsl";
import { FAUX_ENV } from "./model.js";

export const JEV_KEY_ENV = "TYPESAFE_API_KEY";
export const JEV_OPENROUTER_KEY_ENV = "OPENROUTER_API_KEY";
export const PARALLEL_KEY_ENV = "PARALLEL_API_KEY";
/** The keys the server hands a workflow run's process on the descriptor `DECISION_KEY_FD_ENV` names, never in its
 *  environment. */
export const HANDED_KEYS = [JEV_KEY_ENV, PARALLEL_KEY_ENV] as const;
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

/** One decision provider as capabilities lists it: whether this server runs it, when not why, and what to know when
 *  it runs in a way the operator should hear of. */
export type DecisionOffer = { id: "jev" | "parallel"; available: boolean; reason?: string; note?: string };

const isSet = (value: string | undefined) => typeof value === "string" && value.trim() !== "";

/** How this server reaches Jev: TypeSafe's API when its key is set, else OpenRouter's System One when that key is. */
export function jevRoute(env: NodeJS.ProcessEnv): "typesafe" | "openrouter" | undefined {
  if (isSet(env[JEV_KEY_ENV])) return "typesafe";
  return isSet(env[JEV_OPENROUTER_KEY_ENV]) ? "openrouter" : undefined;
}

/** Why Jev does not run here, naming the variable to set. */
export const jevMissing = `This server's environment does not set ${JEV_KEY_ENV} (or ${JEV_OPENROUTER_KEY_ENV}, for Jev through OpenRouter), which a workflow's judge, pick, sift, route and ask nodes need.`;

/** Why Parallel does not run here, naming the variable to set. */
export const parallelMissing = `This server's environment does not set ${PARALLEL_KEY_ENV}, which a decision node naming the provider "parallel" needs.`;

/** Why the OpenRouter route is worth a note: its key is also the model gateway's, which a run's process holds. */
export const jevGatewayNote = `The Jev key is the model gateway key on this server (${JEV_OPENROUTER_KEY_ENV}), which a run's processes hold in their environment for its model nodes. Set ${JEV_KEY_ENV} to keep the decision key out of them.`;

/** What this server offers of each decision provider. */
export function decisionsOf(env: NodeJS.ProcessEnv): DecisionOffer[] {
  const route = jevRoute(env);
  const jev: DecisionOffer = route === "typesafe" ? { id: "jev", available: true } : route === "openrouter" ? { id: "jev", available: true, note: jevGatewayNote } : { id: "jev", available: false, reason: jevMissing };
  const parallel: DecisionOffer = isSet(env[PARALLEL_KEY_ENV]) ? { id: "parallel", available: true } : { id: "parallel", available: false, reason: parallelMissing };
  return [jev, parallel];
}

/** Why provider `id` does not run here and the variables that would make it run; undefined when it runs, and no `needs`
 *  for a provider this server does not have at all. */
export function providerMissing(env: NodeJS.ProcessEnv, id: string): { message: string; needs?: string[] } | undefined {
  if (id === "jev") return jevRoute(env) ? undefined : { message: jevMissing, needs: [JEV_KEY_ENV] };
  if (id === "parallel") return isSet(env[PARALLEL_KEY_ENV]) ? undefined : { message: parallelMissing, needs: [PARALLEL_KEY_ENV] };
  return { message: `This server's decision providers are jev and parallel; this workflow also names the provider ${id}.` };
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

/** The keys the server handed the run's process, by name, read once and the descriptor closed; empty when none were. */
export function handedKeys(env: NodeJS.ProcessEnv): Record<string, string> {
  const fd = Number(env[DECISION_KEY_FD_ENV]);
  if (!Number.isSafeInteger(fd) || fd < 3) return {};
  try {
    const keys: unknown = JSON.parse(readFileSync(fd, "utf8"));
    return Object.fromEntries(HANDED_KEYS.flatMap((name) => (typeof (keys as Record<string, unknown>)?.[name] === "string" ? [[name, (keys as Record<string, string>)[name]]] : [])));
  } finally {
    closeSync(fd);
  }
}

const fauxFetch = async (env: NodeJS.ProcessEnv, name: string) =>
  env[FAUX_ENV] && env[name] ? ((await import(pathToFileURL(env[name]).href)) as { default: typeof fetch }).default : undefined;

/** In a run's process: the judge its workflow's typed questions run on, over the providers the server gave it a key
 *  for, with each node's provider by name and Jev for a node that names none; undefined when it gave it none. Called once
 *  per process, since the handed keys can be read once. Each provider sends a request once: one that fails after it was
 *  sent may have been answered and billed, so the decision escalates as interrupted instead of being asked again. */
export async function decisionJudgeOf(env: NodeJS.ProcessEnv) {
  const handed = handedKeys(env);
  const providers: Record<string, DecisionProvider> = {};
  const route = handed[JEV_KEY_ENV] !== undefined ? "typesafe" : isSet(env[JEV_OPENROUTER_KEY_ENV]) ? "openrouter" : undefined;
  if (route) {
    const [{ jevProvider }, faux] = await Promise.all([import("@parcha/agentrun-jev"), fauxFetch(env, FAUX_JEV_ENV)]);
    providers.jev = jevProvider({ ...(route === "typesafe" ? { apiKey: handed[JEV_KEY_ENV] } : { provider: "openrouter" }), ...(faux ? { fetch: faux } : {}) });
  }
  if (handed[PARALLEL_KEY_ENV] !== undefined) {
    const [{ parallelProvider }, faux] = await Promise.all([import("@parcha/agentrun-decisions"), fauxFetch(env, FAUX_PARALLEL_ENV)]);
    providers.parallel = parallelProvider({ apiKey: handed[PARALLEL_KEY_ENV], ...(faux ? { fetch: faux } : {}) });
  }
  if (!Object.keys(providers).length) return undefined;
  const { judgeFromProviders } = await import("@parcha/agentrun-dsl");
  return judgeFromProviders({ providers, default: DEFAULT_DECISION_PROVIDER });
}
