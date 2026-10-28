// Decision providers: the models a workflow's judge, pick, sift, route and ask nodes ask, through the DSL's `runJudge`.
// Jev (TypeSafe's System One) is the one this server runs, when its environment names Jev's key: TYPESAFE_API_KEY, or
// OPENROUTER_API_KEY for Jev through OpenRouter.
//
// The TypeSafe key never enters a run's environment, which the run's tools and its model's provider read
// (`ToolHost.env`, a call node's effect). The server drops the variable from the run's process and hands the value over
// once, on an inherited pipe (`DECISION_KEY_FD`), at each launch of a workflow run. The run's process reads it into the
// judge's runner and nowhere else. On the OpenRouter route the key is also the model gateway's key, which the run's
// process already holds in its environment for its model nodes. That route keeps it there.
import { closeSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { FAUX_ENV } from "./model.js";

export const JEV_KEY_ENV = "TYPESAFE_API_KEY";
export const JEV_OPENROUTER_KEY_ENV = "OPENROUTER_API_KEY";
/** The adapter a workflow's typed questions run through. */
export const DECISION_ADAPTER = "runJudge";
/** The descriptor a run's process reads the TypeSafe key from: the first one after stdin, stdout and stderr. */
export const DECISION_KEY_FD = 3;
/** Set on a run's process the server hands the TypeSafe key: the descriptor's number, never the key. */
export const DECISION_KEY_FD_ENV = "AGENTRUN_SERVE_DECISION_KEY_FD";
/** Under --faux only: a module whose default export is the fetch Jev's runner sends through, in place of TypeSafe's
 *  API (the tests' fake). */
export const FAUX_JEV_ENV = "AGENTRUN_SERVE_FAUX_JEV";

/** One decision provider as capabilities lists it: whether this server runs it, and when not, why. */
export type DecisionOffer = { id: "jev"; available: boolean; reason?: string };

const isSet = (value: string | undefined) => typeof value === "string" && value.trim() !== "";

/** How this server reaches Jev: TypeSafe's API when its key is set, else OpenRouter's System One when that key is. */
export function jevRoute(env: NodeJS.ProcessEnv): "typesafe" | "openrouter" | undefined {
  if (isSet(env[JEV_KEY_ENV])) return "typesafe";
  return isSet(env[JEV_OPENROUTER_KEY_ENV]) ? "openrouter" : undefined;
}

/** Why Jev does not run here, naming the variable to set. */
export const jevMissing = `This server's environment does not set ${JEV_KEY_ENV} (or ${JEV_OPENROUTER_KEY_ENV}, for Jev through OpenRouter), which a workflow's judge, pick, sift, route and ask nodes need.`;

/** What this server offers of each decision provider. */
export function decisionsOf(env: NodeJS.ProcessEnv): DecisionOffer[] {
  return [jevRoute(env) ? { id: "jev", available: true } : { id: "jev", available: false, reason: jevMissing }];
}

/** The TypeSafe key the server handed the run's process, read once and the descriptor closed; undefined when none was. */
function handedKey(env: NodeJS.ProcessEnv): string | undefined {
  const fd = Number(env[DECISION_KEY_FD_ENV]);
  if (!Number.isSafeInteger(fd) || fd < DECISION_KEY_FD) return undefined;
  try {
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/** In a run's process: the judge its workflow's typed questions run on, or undefined when the server gave it no route
 *  to Jev. Called once per process, since the handed key can be read once. */
export async function jevJudgeOf(env: NodeJS.ProcessEnv) {
  const handed = handedKey(env);
  const route = handed !== undefined ? "typesafe" : isSet(env[JEV_OPENROUTER_KEY_ENV]) ? "openrouter" : undefined;
  if (!route) return undefined;
  const faux = env[FAUX_ENV] && env[FAUX_JEV_ENV] ? ((await import(pathToFileURL(env[FAUX_JEV_ENV]).href)) as { default: typeof fetch }).default : undefined;
  const { createJevRunner } = await import("@parcha/agentrun-jev");
  return createJevRunner({ ...(route === "typesafe" ? { apiKey: handed } : { provider: "openrouter" }), ...(faux ? { fetch: faux } : {}) });
}
