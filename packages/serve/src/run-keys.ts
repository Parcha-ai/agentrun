// A run's own tool keys: `keys` on a run's start (POST /agents/{id}/runs, POST /runs) or on a message, by name, for the tool
// keys its revision declares (declaredKeys). They are taken out of the body before anything reads it, as model_key is
// (server.ts handedLaunchSecrets), sealed with the run's launch secrets (store/seal.ts sealRunLaunch), opened by its
// claim for its tools alone (runner/claim-secrets.ts), and erased with the rest when the run's turn ends. Stored only
// sealed with the run's launch, until its turn ends; never logged or answered: only their names are read before the seal,
// for the checks a start makes.
//
// AGENTRUN_RUN_KEYS=1 (env-switch.ts): an install whose runs bring the tool keys it does not hold. A template's
// apply then makes its agent though a tool key the template declares is not set here, and says so in a warning; a run of
// that revision that does not carry the key is refused (409 agent_not_runnable, at keys.<NAME>), and no trigger is made
// whose firings could not carry it (firingsOwe). Off, nothing changes.
import { ApiError, type InputIssue } from "./errors.js";
import { handedSecretOf } from "./handed-secret.js";
import { LAUNCH_HOOK_SECRET_ENV, LAUNCH_HOOK_URL_ENV } from "./trigger-launch-hook.js";
import type { Revision } from "./agent-rows.js";
import { needsOf, type RunNeeds, unlockedFields } from "./run-secrets.js";
import type { TemplatePackage } from "./store/store.js";
import { TOOL_FIELDS } from "./tool-keys.js";
import { isObject } from "./validate.js";
import { RUN_KEYS_ENV } from "./env-switch.js";

/** A run's own tool keys, by name. */
export type RunKeys = Readonly<Record<string, string>>;

/** The tool keys a template's apply made `revision` with (its package's `secrets`, kept on the revision): the ones a run
 *  can carry. A model key is not one. */
export const packageKeysOf = (revision: object): string[] => ((revision as { package?: TemplatePackage | null }).package?.secrets ?? []).filter((name) => TOOL_FIELDS.includes(name));

/** The names a run of `revision`, whose needs are `needs` (run-secrets.ts needsOf), may carry in `keys`: each tool key its
 *  tools read (an agentic revision's tools, a workflow's on its nodes and calls, and its decision providers'), and its
 *  template's tool keys. */
export const declaredFrom = (needs: RunNeeds, revision: object): string[] =>
  [...new Set([...unlockedFields([...needs.tools, ...needs.decisionProviders.map((provider) => `decisions.${provider}`)]), ...packageKeysOf(revision)])];

/** The names a run of `revision` may carry in `keys` (declaredFrom). */
export async function declaredKeys(revision: Pick<Revision, "kind" | "body"> & object): Promise<string[]> {
  return declaredFrom(await needsOf(revision as Revision), revision);
}

/** The longest key value taken. */
export const MAX_KEY = 8192;

/** `keys` as a body gives it, checked: tool key names (TOOL_FIELDS) to their values, each checked as every handed key is
 *  (handed-secret.ts), up to MAX_KEY. Each problem goes to `issues` by name, never with its value. */
export function runKeysOf(value: unknown, issues: InputIssue[]): RunKeys {
  if (!isObject(value)) {
    issues.push({ field: "keys", reason: "wrong_type", message: 'keys is an object of tool key names to their values, such as {"PARALLEL_API_KEY": "..."}.' });
    return {};
  }
  const out: Record<string, string> = {};
  for (const [name, given] of Object.entries(value)) {
    const field = `keys.${name}`;
    if (!TOOL_FIELDS.includes(name)) issues.push({ field, reason: "not_an_option", message: `${name} is not a tool key a run can carry: one of ${TOOL_FIELDS.join(", ")}.` });
    else if (typeof given !== "string") issues.push({ field, reason: "wrong_type", message: `${field} is the key's value, as text.` });
    else {
      const wrong = handedSecretOf(given, field, MAX_KEY);
      if (wrong) issues.push(wrong);
      else out[name] = given;
    }
  }
  return out;
}

/** Each of `names` that `declared` leaves out, as a 422 issue at keys.<NAME>. */
export function undeclaredKeys(names: readonly string[], declared: readonly string[]): InputIssue[] {
  const reads = declared.length ? `it reads ${declared.join(", ")}` : "it reads none";
  return names.filter((name) => !declared.includes(name)).map((name) => ({ field: `keys.${name}`, reason: "not_an_option", message: `${name} is a key no tool of this run's revision reads: ${reads}.` }));
}

/** What the start's checks read for a key a run carries: never a value, only that one is set. */
const CARRIED = "(carried by the run)";

/** `env` with each of `names` set, for the checks a start makes and the tool plane it resolves (never a process's
 *  environment): a key the run carries counts as one this server holds. Every property of `env` is kept, its symbols
 *  among them. */
export function withCarried(env: NodeJS.ProcessEnv, names: readonly string[]): NodeJS.ProcessEnv {
  if (!names.length) return env;
  // A held secret is a fixed property (secrets.ts withSecrets), set even when empty: one the run carries and `env` holds
  // empty is left out of the copy, then marked carried.
  const owed = names.filter((name) => !env[name]);
  const descriptors = Object.getOwnPropertyDescriptors(env) as Record<string | symbol, PropertyDescriptor>;
  for (const name of owed) delete descriptors[name];
  const out = Object.defineProperties({}, descriptors) as NodeJS.ProcessEnv;
  for (const name of owed) Object.defineProperty(out, name, { value: CARRIED, enumerable: false, configurable: true });
  return out;
}

/** Under the run-keys setting, each tool key `revision`'s template declared that `env` (the server's) does not hold and
 *  the run does not carry, as a 409 issue at keys.<NAME>: the apply made it on the promise each run brings it. */
export function keysOwed(revision: object, env: NodeJS.ProcessEnv, carried: readonly string[]): InputIssue[] {
  return packageKeysOf(revision).filter((name) => !env[name] && !carried.includes(name)).map((name) => ({
    field: `keys.${name}`,
    reason: "not_set_up_here",
    message: `This agent's template needs ${name}, which this server does not hold: it takes it from each run (${RUN_KEYS_ENV}=1).`,
    fix: `Send keys.${name} with the run.`,
  }));
}

/** The 409 a run that owes `owed` (keysOwed) gets at its start, and a trigger that could only start or message such runs
 *  gets when it is made or moved (firingsOwe). */
export const keysOwedRefusal = (owed: readonly InputIssue[]): ApiError =>
  new ApiError("agent_not_runnable", owed.map((one) => one.message).join(" "), { fields: [...owed], details: { unbound: [], missing: {} } });

/** Under the run-keys setting, whether a trigger's firings could never bring the keys runs of its agent owe (`owed`,
 *  keysOwed with nothing carried): a message_run's never do, hook or not; a start_run's do only through the launch hook,
 *  which hands each firing to the backend in front of this server to start the run with its keys (trigger-launch-hook.ts). */
export const firingsOwe = (owed: readonly unknown[], target: "start_run" | "message_run", hooked: boolean): boolean =>
  owed.length > 0 && (target === "message_run" || !hooked);

/** Why an apply under the run-keys setting does not make `trigger` of the `packageName` template (a start_run's) for an
 *  agent whose runs owe `owed`, or undefined when it makes it (firingsOwe). */
export function runKeysTriggerSkipped(packageName: string, trigger: { name?: unknown; source?: unknown }, owed: readonly string[], hooked: boolean): { reason: "not_set_up_here"; message: string } | undefined {
  if (!firingsOwe(owed, "start_run", hooked)) return undefined;
  const kind = isObject(trigger.source) ? String(trigger.source.kind) : "";
  return {
    reason: "not_set_up_here",
    message: `The ${packageName} template's trigger ${String(trigger.name).trim()} (${kind}) was not made: each run of its agent must carry ${owed.join(" and ")} in keys (${RUN_KEYS_ENV}=1), and its firings would start runs without them. Start its runs through the API with keys, or set the launch hook (${LAUNCH_HOOK_URL_ENV} and ${LAUNCH_HOOK_SECRET_ENV}) and apply again: each firing then goes to the backend in front of this server, which starts the run with its keys.`,
  };
}
