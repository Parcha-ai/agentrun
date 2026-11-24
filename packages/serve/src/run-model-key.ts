// A run's own model key: a key its caller hands with the run (`model_key` on POST /runs, POST /agents/{id}/runs and
// POST /runs/{id}/messages), such as a LiteLLM virtual key minted for that run, which every model request the run makes
// carries in place of the server's own key. AgentRun never mints, lists or revokes it: the caller owns its life.
//
// Where it goes: the model gateway at AGENT_MODEL_BASE_URL, which every pi model and every workflow model node is sent to,
// and Anthropic's Messages endpoint when ANTHROPIC_BASE_URL names that same gateway origin (a CLI harness on Anthropic's
// wire). It is sealed with the run, bound to that origin when handed (store/seal.ts RunModelKey), so a gateway moved since
// never receives it; it fills the gateway's key variable (and ANTHROPIC_API_KEY on that origin) in the model routes' env
// alone, read at each request, never enumerable and never on the env a tool, a harness or a sandbox runs under.
//
// No setting: what the server holds decides. A run with a model_key spends on it alone, outside its turn too (its
// subagents, learned nodes, end-of-run compile turn), never on the server's key. A run without one spends on the server's
// key for its route, as before. A server that holds no key for a run's route (no AGENT_MODEL_API_KEY, nothing saved in
// Settings) is an operator saying "callers bring their own": a start or a message that would start a turn with no key
// to spend is 422 model_key_required, never a failure at the first model call. Spend after a run's turn ended (its key
// erased with that end, and revoked by its caller) or tied to no run, with no key to spend, is skipped or refused in words.
import { ApiError, type InputIssue } from "./errors.js";
import { handedSecretOf } from "./handed-secret.js";
import { PLAN_PROVIDER } from "./chatgpt-plan.js";
import { DEFAULT_HARNESS } from "./harness.js";
import { harnessOf } from "./harness-table.js";
import { FAUX_ENV, GATEWAY_KEY_ENV, hostModel, MODEL_PROVIDER, PROVIDER_KEYS } from "./model.js";
import { gatewayBase } from "./provider.js";
import type { RunLaunch } from "./run-launch.js";
import { modelWire, WIRES } from "./wires.js";

/** The longest model key a run takes: a header value, never a document. */
export const MAX_MODEL_KEY_CHARS = 4096;

/** The origin of the model gateway a run's model key goes to (AGENT_MODEL_BASE_URL's, by the one base rule), or undefined
 *  when the server names none or one a key may not go to. */
export function runModelOrigin(env: NodeJS.ProcessEnv): string | undefined {
  if (!env.AGENT_MODEL_BASE_URL) return undefined;
  try {
    return new URL(gatewayBase("AGENT_MODEL_BASE_URL", env.AGENT_MODEL_BASE_URL)).origin;
  } catch {
    return undefined;
  }
}

/** Whether ANTHROPIC_BASE_URL names the gateway at `origin`: there a CLI harness on Anthropic's wire sends ANTHROPIC_API_KEY,
 *  which a run's key then fills. */
function anthropicOnGateway(env: NodeJS.ProcessEnv, origin: string): boolean {
  if (!env.ANTHROPIC_BASE_URL) return false;
  try {
    return new URL(gatewayBase("ANTHROPIC_BASE_URL", env.ANTHROPIC_BASE_URL)).origin === origin;
  } catch {
    return false;
  }
}

/** The variables a run's model key fills in a model route's env, for a gateway at `origin`: the gateway's key, and
 *  ANTHROPIC_API_KEY where ANTHROPIC_BASE_URL is that same gateway. */
export function runKeyNames(env: NodeJS.ProcessEnv, origin: string): string[] {
  return [GATEWAY_KEY_ENV, ...(anthropicOnGateway(env, origin) ? ["ANTHROPIC_API_KEY"] : [])];
}

/** Every model key a model route reads by name: each of pi-ai's providers' and the gateway's. */
const MODEL_KEY_NAMES: ReadonlySet<string> = new Set([...Object.values(PROVIDER_KEYS).flat(), GATEWAY_KEY_ENV]);

/** A model key `body` hands, checked as every handed key is (handed-secret.ts), up to MAX_MODEL_KEY_CHARS. Issues are
 *  pushed at `model_key`. */
export function modelKeyOf(value: unknown, issues: InputIssue[]): string | undefined {
  if (typeof value !== "string") return void issues.push({ field: "model_key", reason: "wrong_type", message: "model_key is the run's model key as text, such as a LiteLLM virtual key minted for this run." });
  const wrong = handedSecretOf(value, "model_key", MAX_MODEL_KEY_CHARS);
  return wrong ? void issues.push(wrong) : value;
}

/** 422 model_key_required: a run start, or a message that would start a turn, with no model key to spend: none handed,
 *  none the run holds, and none the server holds for its route. */
export const modelKeyRequired = (message: boolean): ApiError =>
  new ApiError("model_key_required", `This server holds no model key for this run's model (AGENT_MODEL_API_KEY is not set and none is saved in Settings → Model keys), so each run's caller brings its own: send model_key with ${message ? "a message that starts a turn" : "the run"}, a key for the model gateway at AGENT_MODEL_BASE_URL (such as a LiteLLM virtual key) minted for ${message ? "that turn" : "this run"}.`, { fields: [{ field: "model_key", reason: "missing", message: "model_key is required here: the server holds no model key for this run's model." }] });

/** What of a run says where its model requests go: its kind and its launch's pinned model. */
export type ModelKeyTarget = { readonly kind: "agentic" | "workflow" | string; readonly model?: { readonly provider: string; readonly modelId: string } | undefined; readonly native?: boolean };

/** A created run's ModelKeyTarget: its revision's kind and its launch's pinned model. A held run its model kept from
 *  running (run-launch.ts hold.refused) pins none, so it is keyed by its revision's model as named (heldKeyModel): a
 *  gateway server with no key refuses it at its create as it refuses any run there. */
export function keyTargetOf(env: NodeJS.ProcessEnv, launch: Pick<RunLaunch, "model" | "native" | "hold" | "harness">, revision: { readonly kind: string; readonly body: unknown }): ModelKeyTarget {
  const named = revision.kind === "agentic" ? (revision.body as { model?: unknown } | null)?.model : undefined;
  const model = launch.model ?? (launch.hold?.refused ? heldKeyModel(env, launch.harness ?? DEFAULT_HARNESS, typeof named === "string" ? named : undefined) : undefined);
  return { kind: revision.kind, ...(model ? { model } : {}), native: Boolean(launch.native) };
}

/** The model a run on `harness` of `ref` (its revision's; none, the host's default for the harness) is keyed by, read
 *  from the name alone (no model resolved, no key read): on the gateway, pi's model and a model on a wire the gateway
 *  serves are the gateway's (model.ts chooseModel, wires.ts WIRES), a ChatGPT plan's excepted; else the provider the
 *  name gives. None on a harness billed to its own plan, or for a name with no provider.
 *  It mirrors the router's gateway rule by name, so it moves with it: model.ts chooseModel (a ChatGPT plan's name goes to
 *  the plan, any other on AGENT_MODEL_BASE_URL to MODEL_PROVIDER), provider.ts modelOn (a harness on its own plan, no
 *  modelWire, chooses none) and wires.ts WIRES[wire].gateway (which CLI wires the gateway serves). A change to which
 *  names or wires go to the gateway there must be made here too, or a held run is checked for the wrong key. */
function heldKeyModel(env: NodeJS.ProcessEnv, harness: string, ref: string | undefined): ModelKeyTarget["model"] {
  const wire = harnessOf(env, harness)?.facts?.wire;
  if (wire && !modelWire(wire)) return undefined;
  const named = ref ?? hostModel(env, "default", harness);
  if (env.AGENT_MODEL_BASE_URL && !named?.startsWith(`${PLAN_PROVIDER}/`) && (!wire || WIRES[wire].gateway)) return { provider: MODEL_PROVIDER, modelId: named ?? "" };
  const slash = named?.indexOf("/") ?? -1;
  return named && slash > 0 ? { provider: named.slice(0, slash), modelId: named.slice(slash + 1) } : undefined;
}

/** The variables a run's model route reads its key from when that route goes to the model gateway (a workflow's model
 *  nodes, pi's and codex's models, a CLI harness on Anthropic's wire where ANTHROPIC_BASE_URL is the gateway's origin);
 *  undefined for a route that goes elsewhere (a provider's own, the ChatGPT plan, the faux model) or a native run. */
export function gatewayKeyNames(env: NodeJS.ProcessEnv, run: ModelKeyTarget): string[] | undefined {
  const origin = runModelOrigin(env);
  if (!origin || run.native || env[FAUX_ENV]) return undefined;
  if (run.kind === "workflow" || run.model?.provider === MODEL_PROVIDER) return [GATEWAY_KEY_ENV];
  if (run.model?.provider === "anthropic" && anthropicOnGateway(env, origin)) return ["ANTHROPIC_API_KEY"];
  return undefined;
}

/** Whether a run of `run` with no key of its own has none to spend: its route goes to the gateway, and `env` (the
 *  server's, with the keys saved in Settings) holds no key it reads. */
export function serverKeyMissing(env: NodeJS.ProcessEnv, run: ModelKeyTarget): boolean {
  const names = gatewayKeyNames(env, run);
  return names !== undefined && !names.some((name) => env[name]);
}

/** Words for model spend tied to no run's key (`what`, a noun phrase) on a server that holds no gateway key (`env`, its
 *  keys saved in Settings among them): skipped or refused, never sent with no key. Undefined where the server holds one. */
export function noServerKeyFor(env: NodeJS.ProcessEnv, what: string): string | undefined {
  return runModelOrigin(env) && !env[GATEWAY_KEY_ENV] ? noServerKeyWords(what) : undefined;
}

/** The words of noServerKeyFor for `what`. */
export const noServerKeyWords = (what: string): string => `${what} is skipped: it is tied to no run's model key, and this server holds none of its own (AGENT_MODEL_API_KEY is not set and none is saved in Settings → Model keys).`;

/** Words for spend after the turn of a run that held its own model key (`what`): skipped, since that key is erased with
 *  the turn's end and revoked by its caller, and the server's key never pays for a run that brought its own. */
export const runKeyEndedFor = (what: string): string => `${what} is skipped: this run spent on its own model key, which is erased when its turn ends; the server's key never pays for a run that brought its own.`;

/** Why a run's model key would never be used, so it is refused rather than kept unused; undefined where it applies: a
 *  workflow run (its model nodes go to the gateway), or an agentic run whose model goes to the gateway (pi's and codex's,
 *  MODEL_PROVIDER) or to Anthropic's endpoint on the gateway's origin (a CLI harness on Anthropic's wire). */
export function modelKeyMisfit(env: NodeJS.ProcessEnv, run: ModelKeyTarget): string | undefined {
  const origin = runModelOrigin(env);
  if (!origin) return "This server sends no model through a gateway (AGENT_MODEL_BASE_URL is not set), so a run's model key has nowhere to go.";
  if (run.native) return "A native run's model runs on its own machine, never through this server's gateway, so a model key would never be used.";
  if (run.kind === "workflow") return undefined;
  if (run.model?.provider === MODEL_PROVIDER) return undefined;
  if (run.model?.provider === "anthropic" && anthropicOnGateway(env, origin)) return undefined;
  const named = run.model ? `${run.model.provider}/${run.model.modelId}` : "its harness's own model";
  return `This run's model (${named}) is not sent through the gateway at AGENT_MODEL_BASE_URL, so its model key would never be used.`;
}

/** A run's model key as a claim holds it: the gateway origin it was handed for, and the key now (a message's replaces it
 *  at the next command; none before the run's first key, and none once its launch no longer holds one). */
export interface HeldModelKey {
  readonly origin: string;
  key(): string | undefined;
}

/**
 * `env` for a run's model routes when the run holds its own key: every property of `env` but each model key (the runner's
 * own and any saved one never go), with the run's key read at each request (`held.key()`) in each variable it fills
 * (runKeyNames). Those are getters, never enumerable: a spread of the result, a spawn given it or a tool's env made from
 * it carries none of them. No ChatGPT sign-in either (a symbol, not copied): every model call tied to the run carries
 * the run's key.
 */
export function withRunModelKey(env: NodeJS.ProcessEnv, held: HeldModelKey): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const name of Object.getOwnPropertyNames(env)) {
    if (!MODEL_KEY_NAMES.has(name)) Object.defineProperty(out, name, Object.getOwnPropertyDescriptor(env, name)!);
  }
  for (const name of runKeyNames(env, held.origin)) Object.defineProperty(out, name, { get: () => held.key(), enumerable: false, configurable: false });
  return out;
}

/**
 * `env` (a claim's model env on the server's keys, withModelKeys) for a run that holds no key of its own yet: each
 * variable a run's key fills (runKeyNames) reads the run's key once a message hands one, and the server's value until
 * then, at each request; every other variable as it is. So a run that started on the server's key spends a message's
 * key from the request after that message on. Getters, never enumerable, as withRunModelKey's.
 */
export function withRunModelKeyLater(env: NodeJS.ProcessEnv, held: HeldModelKey): NodeJS.ProcessEnv {
  const names = new Set(runKeyNames(env, held.origin));
  const out: NodeJS.ProcessEnv = {};
  for (const name of Object.getOwnPropertyNames(env)) {
    if (!names.has(name)) Object.defineProperty(out, name, Object.getOwnPropertyDescriptor(env, name)!);
  }
  for (const name of names) {
    const server = env[name];
    Object.defineProperty(out, name, { get: () => held.key() ?? server, enumerable: false, configurable: false });
  }
  return out;
}

