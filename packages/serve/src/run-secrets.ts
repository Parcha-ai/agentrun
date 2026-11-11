// Which secrets a run is handed: every secret but the server's own and the decision keys (RUN_SECRETS), less each tool key
// that unlocks none of the tools its revision binds and each model key its model does not need (keysFor over needsOf).
// The runner's claim reads them (runner/claim-secrets.ts).
import type { Revision } from "@parcha/pi-durable-agent";
import { harnessModelKeys } from "./adapters.js";
import { BOX_KEYS } from "./place-offers.js";
import { providersNamed } from "./decisions.js";
import { harnessOfBody } from "./harness.js";
import { harnessOf } from "./harness-table.js";
import { GATEWAY_KEY_ENV, llmTiers, modelKeys, nodeTiers, PROVIDER_KEYS, type Tier, workflowNodes } from "./model.js";
import { DECISION_KEYS, SECRET_NAMES } from "./secrets.js";
import { TOOL_KEYS } from "./tool-keys.js";
import { workflowTools } from "./tools.js";

/** The server's own secrets, which a run never gets: the API token, by name or by value, the seal key the tool keys are
 *  kept under (tool-keys.ts), the store's URL (it may hold the database's password), and the remote boxes' keys
 *  (place-offers.ts BOX_KEYS), which only the server's computer providers use. */
const SERVER_ONLY = new Set(["AGENTRUN_TOKEN", "AGENTRUN_API_KEY", "AGENTRUN_SEAL_KEY", "AGENTRUN_STORE_URL", ...BOX_KEYS]);
/** The secrets a run may be handed: every one but the server's own and the decision keys, which go apart. */
export const RUN_SECRETS = SECRET_NAMES.filter((name) => !SERVER_ONLY.has(name) && !DECISION_KEYS.includes(name));
type KeyRow = { kind: string; fields: readonly string[]; unlocks: readonly string[] };
/** The fields a run gets only when its revision names what they unlock: a `tool` key's. Any other kind's (a model key's)
 *  is the model's to need, as every model key is. */
const scopedOf = (rows: readonly KeyRow[]): readonly string[] => rows.filter((row) => row.kind === "tool").flatMap((row) => row.fields);
/** The model keys: every key of pi-ai's providers (model.ts' PROVIDER_KEYS) and the gateway's. A run gets those its model
 *  needs and no other (keysFor). A workflow's decision keys, OpenRouter's among them, go apart (decisions.ts), whatever
 *  its model. */
const MODEL_KEYS: readonly string[] = [...new Set([...Object.values(PROVIDER_KEYS).flat(), GATEWAY_KEY_ENV])];

/** What of a revision decides the secrets its runs are handed, none of it a key, read once per revision (a revision
 *  never changes): its harness, the model it names, the tools it binds (an agentic revision's `tools`, a workflow's on
 *  its model nodes and its `call` nodes), a workflow's tiers (those its model nodes and `llm` calls run on), and its
 *  decision providers (decisions.ts' decisionKeysFor: a workflow's decision nodes', providersNamed, Jev for a node that
 *  names none; an agentic revision's, none). Names only: no instruction and no skill. */
export type RunNeeds = { harness: string; model?: string; tools: readonly string[]; tiers?: readonly Tier[]; decisionProviders: readonly string[] };

/** `revision`'s RunNeeds. */
export async function needsOf(revision: Revision): Promise<RunNeeds> {
  const workflow = revision.kind === "workflow" ? revision.body.workflow : undefined;
  const nodes = workflow ? workflowNodes(workflow, (await import("@parcha/agentrun-dsl")).inspectWorkflow(workflow)) : undefined;
  const bound = nodes && workflowTools(nodes);
  return {
    harness: harnessOfBody(revision.body),
    ...(revision.kind === "agentic" && revision.body.model ? { model: revision.body.model } : {}),
    tools: bound ? [...bound.nodes, ...bound.calls] : [...(revision.body.tools ?? [])],
    ...(nodes ? { tiers: llmTiers(nodes, nodeTiers(nodes)) } : {}),
    decisionProviders: nodes ? providersNamed(nodes) : [],
  };
}

/** The secrets a run of `needs` is handed, by the keys `env` holds now: RUN_SECRETS but each field of a `tool` row of
 *  `rows` (TOOL_KEYS) that unlocks none of the tools the run binds; and but each model key its model does not need, from
 *  the host's model settings and the keys in `env`: a pi run's, its models' providers' keys or the gateway's (model.ts'
 *  modelKeys: its own model, or the host's of each tier it runs); a run on an adapter's, the one key its wire's route
 *  sends for the revision's model (adapters.ts' harnessModelKeys). Read at each claim, so a key saved with no restart
 *  counts at the next. */
export function keysFor(needs: RunNeeds, env: NodeJS.ProcessEnv, rows: readonly KeyRow[] = TOOL_KEYS): string[] {
  const named = new Set(needs.tools);
  const unlocked = new Set<string>(rows.filter((row) => row.unlocks.some((name) => named.has(name))).flatMap((row) => row.fields));
  const scoped = scopedOf(rows);
  const entry = harnessOf(env, needs.harness);
  const model = new Set(!entry || entry.facts ? harnessModelKeys(needs.harness, env, needs.model) : needs.tiers ? modelKeys(env, undefined, needs.tiers) : modelKeys(env, needs.model));
  return RUN_SECRETS.filter((name) => (!scoped.includes(name) || unlocked.has(name)) && (!MODEL_KEYS.includes(name) || model.has(name)));
}

/** The secrets a run of `revision` is handed with the keys `env` holds (needsOf, then keysFor). */
export async function secretsFor(revision: Revision, rows: readonly KeyRow[] = TOOL_KEYS, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  return keysFor(await needsOf(revision), env, rows);
}
