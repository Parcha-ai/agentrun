// The model gateway the owner saves in the console (Settings → Model keys → Use a model gateway): an OpenAI-compatible
// proxy they already run (LiteLLM, or another), which every model is then sent to, as AGENT_MODEL_BASE_URL sends them.
// It is the same gateway the environment names, kept in the one store instead: its address, how it takes model ids, the
// default model of each tier (one settings row, no secret), and its key (a sealed-key row, sealed under the server's seal
// key as every saved key is). The routes:
//   GET    /v2/settings/model-gateway       which gateway is in force (the environment's, the console's, or none), its
//                                           address, id style and models, the variables set where AgentRun starts, and
//                                           its key as every secret's view says it (never a value)
//   PUT    /v2/settings/model-gateway       the gateway saved: its address (gatewayBase's one rule), its key (null
//                                           removes it; left out, the saved one is kept for the same origin alone), its
//                                           id style and its models
//   DELETE /v2/settings/model-gateway       the gateway and its key removed: the provider keys are back in force
//   POST   /v2/settings/model-gateway/test  the gateway's GET <base>/v1/models, asked by the server, under the same rule,
//                                           with no redirect followed and a timeout: { ok, models } or { ok: false, why }
// Which wins: AGENT_MODEL_BASE_URL set where AgentRun starts makes the environment's gateway the one in force, whole (its
// key, its id style, its models), and the saved one is not read; its PUT and DELETE are 409 key_set_by_server. Else the
// saved gateway is in force with its own key alone (never AGENT_MODEL_API_KEY from the environment, which was set for no
// address this server was given), and each of AGENT_MODEL, AGENT_MODEL_FAST, AGENT_MODEL_STRONG and
// AGENT_MODEL_GATEWAY_IDS that the environment sets wins over the saved field it would fill.
//
// How it takes effect: withSavedGateway lays the saved gateway over an environment as the variables would be set, so every
// reader of AGENT_MODEL_BASE_URL (model.ts, provider.ts, a run's model key, a run's routes) reads it unchanged. The server
// lays it over its reading at each save (no restart), and the runner over its run environment at each claim
// (harness-loops.ts), from the store. The key is a non-enumerable property, as every saved key is (secrets.ts withSecrets):
// readable by name, never in a spread, a spawn or a run's environment, and cut from every text the server shows.
//
// The key is sealed together with the origin it was saved for (one sealed value, `{ origin, key }`), and a reading hands
// it on only with an address of that origin. The address row and the key row are written one after the other, and a
// runner in another process may read them between the two writes, or after a write that failed: a pair that does not
// match is read as a gateway with no key, so a key never goes to an address it was not saved for.
import { gatewayBase, HarnessUnavailable, modelGatewayBase } from "./provider.js";
import { ApiError, type InputIssue, invalid } from "./errors.js";
import { envValue, type KeyEnv } from "./key-meta.js";
import { GATEWAY_KEY_ENV, type Tier, TIERS } from "./model.js";
import { registerSecretPage, registerSecretWrite, type SecretMeta, secretMeta, secretName } from "./secret-writes.js";
import { getSealedKey, putSealedKey, removeSealedKey } from "./server-keys.js";
import type { SealedKeys, Settings } from "./store/index.js";
import { isObject, unknownFields } from "./validate.js";

// Saving, removing and testing the gateway are the owner's session's alone (secret-writes.ts): each may carry its key, and
// its address says where every model request, and the key, goes. Reading it is not: no answer holds the key.
for (const operation of ["saveModelGateway", "deleteModelGateway", "testModelGateway"]) registerSecretWrite(operation, () => true);
// A refusal of any of them links to where the owner does it: Settings → Model keys, where the gateway's row is.
registerSecretPage(["saveModelGateway", "deleteModelGateway", "testModelGateway"], "/#/settings/keys");

/** The routes, by their operation names. */
export const MODEL_GATEWAY_ROUTES: ReadonlySet<string> = new Set(["getModelGateway", "saveModelGateway", "deleteModelGateway", "testModelGateway"]);

/** The settings row: the address, the id style and the models. */
export const GATEWAY_SETTING = "model_gateway";
/** The sealed-key row of the gateway's key: never AGENT_MODEL_API_KEY's name, so nothing that reads a key by that name
 *  (a run's claim, the environment's gateway) opens it. Only withSavedGateway hands it on, with its own address. */
export const GATEWAY_KEY_ROW = "model_gateway.api_key";
/** How the gateway takes the ids a revision or a provider key's default names: whole (`as_named`, `openai/gpt-x`), or
 *  `bare`, the part after the provider (AGENT_MODEL_GATEWAY_IDS=bare). The tiers' own models go as saved either way. */
export const GATEWAY_IDS = ["as_named", "bare"] as const;
export type GatewayIds = (typeof GATEWAY_IDS)[number];
/** The variable each tier's model fills, as the environment names it (model.ts TIER_ENV). */
const TIER_VARS: Readonly<Record<Tier, string>> = { default: "AGENT_MODEL", fast: "AGENT_MODEL_FAST", strong: "AGENT_MODEL_STRONG" };
/** Whether a gateway is sent a model id whole or bare: read by the process that sends (a runner, for its runs). */
export const GATEWAY_IDS_ENV = "AGENT_MODEL_GATEWAY_IDS";
const IDS_VAR = GATEWAY_IDS_ENV;
const BASE_VAR = "AGENT_MODEL_BASE_URL";
/** The longest key and model id taken: a header value, a name. */
const MAX_KEY_CHARS = 4096;
const MAX_ID_CHARS = 200;
/** How long the test waits for the gateway, and how many ids it lists. */
export const TEST_TIMEOUT_MS = 10_000;
const MAX_LISTED = 500;
/** The most of the gateway's answer to the test that is read: a list of MAX_LISTED models is far smaller. */
export const MAX_TEST_BYTES = 4 * 1024 * 1024;

/** The saved row. */
export type GatewaySetting = { v: 1; base_url: string; ids: GatewayIds; models: Partial<Record<Tier, string>> };
/** The saved gateway with its key opened (none saved, or one that does not open: none). */
export type SavedGateway = GatewaySetting & { key?: string };

/** The key's name in every secret's view (secret-writes.ts SecretMeta). */
export const GATEWAY_SECRET = secretName("model", "gateway");

/** A model id as saved: text, no whitespace or control character. */
const idIssue = (value: unknown): string | undefined =>
  typeof value !== "string" || !value.length ? "is a model id as the gateway lists it, as text" : value.length > MAX_ID_CHARS ? `is at most ${MAX_ID_CHARS} characters` : /[\s\x00-\x1f\x7f]/.test(value) ? "holds no space or control character" : undefined;

/** The row as saved, or undefined when there is none (or it is not one this reads). */
export async function gatewaySettingOf(settings: Pick<Settings, "get">): Promise<GatewaySetting | undefined> {
  const row = (await settings.get(GATEWAY_SETTING)) as Partial<GatewaySetting> | null | undefined;
  if (!isObject(row) || row.v !== 1 || typeof row.base_url !== "string" || !GATEWAY_IDS.includes(row.ids as GatewayIds) || !isObject(row.models)) return undefined;
  const models = Object.fromEntries(TIERS.flatMap((tier) => (typeof row.models![tier] === "string" && !idIssue(row.models![tier]) ? [[tier, row.models![tier]]] : [])));
  return { v: 1, base_url: row.base_url, ids: row.ids as GatewayIds, models };
}

/** The key's sealed value: the key and the origin it was saved for, sealed as one. */
type BoundKey = { readonly origin: string; readonly key: string };

/** The saved key and its origin, opened under `sealKey`; undefined with none saved, or one that does not open or is not
 *  of this shape (never a key without the origin it was saved for). */
async function openGatewayKey(store: { readonly sealedKeys: Pick<SealedKeys, "get"> }, sealKey: Buffer | undefined): Promise<BoundKey | undefined> {
  const opened = sealKey ? await getSealedKey(store, sealKey, GATEWAY_KEY_ROW) : undefined;
  return opened === undefined ? undefined : boundKeyOf(opened);
}

/** The key's row opened, read as its shape; undefined for one that is not (no key). */
function boundKeyOf(opened: string): BoundKey | undefined {
  try {
    const parsed: unknown = JSON.parse(opened);
    if (isObject(parsed) && parsed.v === 1 && typeof parsed.origin === "string" && typeof parsed.key === "string" && parsed.key.length) return { origin: parsed.origin, key: parsed.key };
  } catch {
    // Not this shape: no key.
  }
  return undefined;
}

/** The secrets of the key's row as opened, for the scan of every stored secret (runner/store-secrets.ts): the key itself,
 *  which is what a gateway's reply or a tool's output could quote, never the JSON it is sealed in alone. A row not of
 *  this shape is one secret whole. */
export const gatewayKeyRowSecrets = (opened: string): string[] => {
  const bound = boundKeyOf(opened);
  return bound ? [bound.key] : [opened];
};

/** The origin of an address the one rule takes, or undefined for one it refuses. */
const originIfValid = (base: string): string | undefined => (baseProblem("base_url", base) ? undefined : originOf(base));

/** The saved gateway with its key opened under `sealKey`, or undefined when none is saved. The key is there only when it
 *  was saved for the address's origin: none without a seal key, one that does not open, or one saved for another origin
 *  (an address changed while this read, or a save that failed between its two writes). */
export async function readSavedGateway(store: { readonly settings: Pick<Settings, "get">; readonly sealedKeys: Pick<SealedKeys, "get"> }, sealKey: Buffer | undefined): Promise<SavedGateway | undefined> {
  const setting = await gatewaySettingOf(store.settings);
  if (!setting) return undefined;
  const bound = await openGatewayKey(store, sealKey);
  const key = bound && bound.origin === originIfValid(setting.base_url) ? bound.key : undefined;
  return { ...setting, ...(key ? { key } : {}) };
}

/** Whether the environment AgentRun started with names its own gateway: then it is the one in force, whole. */
export const envGatewayInForce = (env: KeyEnv): boolean => envValue(env, BASE_VAR) !== undefined;

/** Marks an environment withSavedGateway laid a saved gateway over (a symbol: no spawn sees it, a spread keeps it). */
const SAVED = Symbol.for("agentrun.saved-gateway");
/** Whether `env`'s gateway is the one saved in the console. */
export const savedGatewayIn = (env: NodeJS.ProcessEnv): boolean => (env as Record<symbol, unknown>)[SAVED] === true;

/** The plain variable a runner sets on a run's own process (run-child-host.ts) whose gateway is the one saved in the
 *  console: that process holds no seal key and reads no store row of the gateway, so its runner lays the gateway over the
 *  claim and hands its key over the secrets' pipe, and this says the gateway is the saved one (savedGatewayIn), so its
 *  key stays off the run's tools there too. Not a secret. */
export const SAVED_GATEWAY_ENV = "AGENTRUN_MODEL_GATEWAY_SAVED";

/** `env` (a run's own process's, its runner having laid the saved gateway over it) marked as the saved gateway's, without
 *  SAVED_GATEWAY_ENV; `env` itself where that variable is not set. A copy, every property of `env` as it is. */
export function savedGatewayMarked<E extends NodeJS.ProcessEnv>(env: E): E {
  if (envValue(env, SAVED_GATEWAY_ENV) !== "1") return env;
  const out = {} as E;
  for (const name of Reflect.ownKeys(env)) if (name !== SAVED_GATEWAY_ENV) Object.defineProperty(out, name, Object.getOwnPropertyDescriptor(env, name)!);
  Object.defineProperty(out, SAVED, { value: true, enumerable: true, configurable: true });
  return out;
}

/**
 * `env` with the saved gateway laid over it, as the variables would set it: AGENT_MODEL_BASE_URL, its key as
 * AGENT_MODEL_API_KEY (non-enumerable; empty where none is saved, so a key the environment holds for no address never goes
 * to this one), and AGENT_MODEL_GATEWAY_IDS and each tier's model where the environment sets none. `env` itself where
 * nothing is saved or the environment names its own gateway (envGatewayInForce). A copy, every property of `env` as it is
 * (non-enumerable secrets and symbols too), never `env` changed.
 */
export function withSavedGateway<E extends NodeJS.ProcessEnv>(env: E, saved: SavedGateway | undefined): E {
  if (!saved || envGatewayInForce(env)) return env;
  const set: Record<string, string> = { [BASE_VAR]: saved.base_url };
  if (saved.ids === "bare" && envValue(env, IDS_VAR) === undefined) set[IDS_VAR] = "bare";
  for (const tier of TIERS) if (saved.models[tier] && envValue(env, TIER_VARS[tier]) === undefined) set[TIER_VARS[tier]] = saved.models[tier]!;
  const out = {} as E;
  for (const name of Reflect.ownKeys(env)) if (name !== GATEWAY_KEY_ENV && !(typeof name === "string" && Object.hasOwn(set, name))) Object.defineProperty(out, name, Object.getOwnPropertyDescriptor(env, name)!);
  for (const [name, value] of Object.entries(set)) Object.defineProperty(out, name, { value, enumerable: true, writable: true, configurable: true });
  Object.defineProperty(out, GATEWAY_KEY_ENV, { value: saved.key ?? "", enumerable: false, writable: false, configurable: false });
  Object.defineProperty(out, SAVED, { value: true, enumerable: true, configurable: true });
  return out;
}

/** GET /v2/settings/model-gateway. `source`: the gateway in force, the environment's (`env`), the console's (`console`),
 *  or none (`null`: the provider keys are). `set_at_start`: the variables of these fields set where AgentRun starts, which
 *  win, read-only here. `problem`: why the gateway in force runs no model (an address a run refuses: the one rule, or an API that is no gateway's, modelGatewayBase), else null. */
export type GatewayView = {
  source: "env" | "console" | null;
  base_url: string | null;
  ids: GatewayIds;
  models: Record<Tier, string | null>;
  set_at_start: string[];
  secret: SecretMeta;
  problem: string | null;
};

/** What the test answers: the model ids the gateway lists, or why it could not be asked, in words. */
export type GatewayTest = { ok: true; models: string[] } | { ok: false; why: string };

/** What the routes need of the server: its store, its seal key, the environment it started with (never a saved key), and
 *  `changed`, its reading made again after a save or a removal. `fetch` is the test's (a test's fake, else the global). */
export type ModelGatewayDeps = {
  readonly store: { readonly settings: Pick<Settings, "get" | "put" | "remove">; readonly sealedKeys: Pick<SealedKeys, "get" | "put" | "remove" | "all">; flush(): Promise<void> };
  readonly sealKey: Buffer;
  readonly env: KeyEnv;
  readonly changed: () => Promise<void>;
  readonly fetch?: typeof fetch;
};

/** The variables of the gateway's fields that the environment sets. */
const setAtStart = (env: KeyEnv): string[] => [BASE_VAR, IDS_VAR, ...TIERS.map((tier) => TIER_VARS[tier]), GATEWAY_KEY_ENV].filter((name) => envValue(env, name) !== undefined);

/** Why `value` may not be the gateway's address, under the field's name, or undefined: by `rule`, the one address rule
 *  (gatewayBase) unless given another. */
function baseProblem(field: string, value: string, rule: (field: string, value: string) => unknown = gatewayBase): string | undefined {
  try {
    rule(field, value);
    return undefined;
  } catch (error) {
    if (error instanceof HarnessUnavailable) return error.message;
    throw error;
  }
}

/** The rule a run holds the gateway to (modelGatewayBase: the address rule, and an API that is no gateway's, Particle's). */
const runRule = (field: string, value: string): string => modelGatewayBase(value, field);
/** Why a run refuses `value` as the gateway, in a run's words, or null: the view's `problem`, which the console's first
 *  screen shows, and what a save refuses. */
const runProblem = (field: string, value: string): string | null => baseProblem(field, value, runRule) ?? null;

const originOf = (base: string): string => new URL(gatewayBase("base_url", base)).origin;

export async function gatewayView({ store, env }: Pick<ModelGatewayDeps, "store" | "env">): Promise<GatewayView> {
  const set_at_start = setAtStart(env);
  if (envGatewayInForce(env)) {
    const base = envValue(env, BASE_VAR)!;
    const key = envValue(env, GATEWAY_KEY_ENV) !== undefined;
    return {
      source: "env",
      base_url: base,
      ids: envValue(env, IDS_VAR) === "bare" ? "bare" : "as_named",
      models: Object.fromEntries(TIERS.map((tier) => [tier, envValue(env, TIER_VARS[tier]) ?? null])) as Record<Tier, string | null>,
      set_at_start,
      secret: secretMeta(GATEWAY_SECRET, key ? { set: true, source: "env", changedAt: null } : { set: false }),
      problem: runProblem(BASE_VAR, base),
    };
  }
  const saved = await gatewaySettingOf(store.settings);
  const keyRow = (await store.sealedKeys.all()).find((row) => row.name === GATEWAY_KEY_ROW);
  const secret = keyRow ? secretMeta(GATEWAY_SECRET, { set: true, source: "console", changedAt: new Date(keyRow.updatedAt) }) : secretMeta(GATEWAY_SECRET, { set: false });
  const ids: GatewayIds = envValue(env, IDS_VAR) === "bare" ? "bare" : envValue(env, IDS_VAR) !== undefined ? "as_named" : (saved?.ids ?? "as_named");
  return {
    source: saved ? "console" : null,
    base_url: saved?.base_url ?? null,
    ids,
    models: Object.fromEntries(TIERS.map((tier) => [tier, envValue(env, TIER_VARS[tier]) ?? saved?.models[tier] ?? null])) as Record<Tier, string | null>,
    set_at_start,
    secret,
    problem: saved ? runProblem("base_url", saved.base_url) : null,
  };
}

/** 409 while the environment names its own gateway: nothing saved here would take effect. */
function refuseWhileEnv(env: KeyEnv): void {
  if (!envGatewayInForce(env)) return;
  throw new ApiError("key_set_by_server", `This server is started with ${BASE_VAR}: its model gateway is changed where the server is started, not here.`, { details: { fields: [BASE_VAR] } });
}

/** A key as the body gives it, checked: text of 1 to MAX_KEY_CHARS characters with no whitespace or control character. */
function keyIssue(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.length) return "api_key is the gateway's key as text, or null to remove it";
  if (value.length > MAX_KEY_CHARS || /[\s\x00-\x1f\x7f]/.test(value)) return `api_key is at most ${MAX_KEY_CHARS} characters with no space or control character`;
  return undefined;
}

/** PUT: the gateway saved, once every field is right; nothing is saved when one is not. No message holds the key. */
export async function saveGateway(deps: ModelGatewayDeps, body: unknown): Promise<GatewayView> {
  const { store, sealKey, env } = deps;
  refuseWhileEnv(env);
  if (!isObject(body)) throw new ApiError("input_invalid", "the body is a JSON object: { base_url, api_key?, ids?, models: { default, fast?, strong? } }");
  const issues: InputIssue[] = unknownFields(body, ["base_url", "api_key", "ids", "models"]);
  const base = typeof body.base_url === "string" ? body.base_url.trim() : undefined;
  if (base === undefined || !base) issues.push({ field: "base_url", reason: body.base_url === undefined ? "missing" : "wrong_type", message: "base_url is the gateway's address, such as https://gateway.example/v1" });
  else {
    // A run's rule, so nothing is saved that no run could use.
    const problem = runProblem("base_url", base);
    if (problem) issues.push({ field: "base_url", reason: "invalid", message: problem });
  }
  if (body.api_key !== undefined && body.api_key !== null) {
    const problem = keyIssue(body.api_key);
    if (problem) issues.push({ field: "api_key", reason: "invalid", message: problem });
  }
  if (body.ids !== undefined && !GATEWAY_IDS.includes(body.ids as GatewayIds)) issues.push({ field: "ids", reason: "not_an_option", message: `ids is one of ${GATEWAY_IDS.join(", ")}` });
  const models = body.models === undefined ? {} : body.models;
  if (!isObject(models)) issues.push({ field: "models", reason: "wrong_type", message: "models is an object: { default, fast?, strong? }" });
  else {
    issues.push(...unknownFields(models, [...TIERS]).map((issue) => ({ ...issue, field: `models.${issue.field}` })));
    for (const tier of TIERS) {
      const value = models[tier];
      if (value === undefined || (value === null && tier !== "default")) continue;
      const problem = idIssue(value);
      if (problem) issues.push({ field: `models.${tier}`, reason: "invalid", message: `models.${tier} ${problem}` });
    }
    if (models.default === undefined && envValue(env, TIER_VARS.default) === undefined) issues.push({ field: "models.default", reason: "missing", message: "models.default is the model a run that names none takes, as the gateway lists it (the test lists them)" });
  }
  if (issues.length) throw invalid(issues);
  // A field the environment sets wins: 409, as a tool key the server is started with is, never saved to no effect.
  const held = [...(body.ids !== undefined && envValue(env, IDS_VAR) !== undefined ? [IDS_VAR] : []), ...TIERS.filter((tier) => isObject(models) && models[tier] !== undefined && models[tier] !== null && envValue(env, TIER_VARS[tier]) !== undefined).map((tier) => TIER_VARS[tier])];
  if (held.length) throw new ApiError("key_set_by_server", `This server is started with ${held.join(" and ")}: change it where the server is started.`, { details: { fields: held } });
  // The saved key goes only to the origin it was saved for (sealed with it): a new origin takes a new key, or none said
  // outright. A saved key that does not open is never kept either.
  const origin = originOf(base!);
  const keySaved = (await store.sealedKeys.get(GATEWAY_KEY_ROW)) !== undefined;
  const bound = keySaved ? await openGatewayKey(store, sealKey) : undefined;
  if (body.api_key === undefined && keySaved && bound?.origin !== origin) {
    throw invalid([{ field: "api_key", reason: "missing", message: `The saved key was for ${bound ? bound.origin : "another gateway"}, and a saved key goes only to the origin it was saved for: enter the key for ${origin}, or send api_key null to use this gateway with no key.` }]);
  }
  const given = models as Record<string, unknown>;
  const setting: GatewaySetting = { v: 1, base_url: base!, ids: (body.ids as GatewayIds | undefined) ?? "as_named", models: Object.fromEntries(TIERS.flatMap((tier) => (typeof given[tier] === "string" ? [[tier, given[tier] as string]] : []))) };
  // The key first, sealed with its origin, then the address: a reader between the two (or after the second failed) finds
  // a key whose origin is not the address's, which it reads as no key (readSavedGateway).
  if (body.api_key === null) await removeSealedKey(store, GATEWAY_KEY_ROW);
  else if (typeof body.api_key === "string") await putSealedKey(store, sealKey, GATEWAY_KEY_ROW, JSON.stringify({ v: 1, origin, key: body.api_key }));
  await store.settings.put(GATEWAY_SETTING, setting);
  await store.flush();
  await deps.changed();
  return gatewayView(deps);
}

/** DELETE: the gateway and its key gone; the provider keys are in force again. */
export async function removeGateway(deps: ModelGatewayDeps): Promise<GatewayView> {
  refuseWhileEnv(deps.env);
  await removeSealedKey(deps.store, GATEWAY_KEY_ROW);
  await deps.store.settings.remove(GATEWAY_SETTING);
  await deps.store.flush();
  await deps.changed();
  return gatewayView(deps);
}

/** POST /test: the model ids the gateway lists at GET <base>/v1/models, asked with its key. The body may name an address
 *  and a key not saved yet (the form's), else the gateway in force is asked with its own. A saved key goes only to the
 *  origin it was saved for; the environment's key only to the environment's gateway. No redirect is followed, and the
 *  answer never holds the key. */
export async function testGateway(deps: ModelGatewayDeps, body: unknown, signal?: AbortSignal): Promise<GatewayTest> {
  const { store, sealKey, env } = deps;
  const given = body === undefined || body === null ? {} : body;
  if (!isObject(given)) throw new ApiError("input_invalid", "the body is a JSON object: { base_url?, api_key? } (api_key null: test with no key)");
  const issues: InputIssue[] = unknownFields(given, ["base_url", "api_key"]);
  if (given.base_url !== undefined && (typeof given.base_url !== "string" || !given.base_url.trim())) issues.push({ field: "base_url", reason: "wrong_type", message: "base_url is the gateway's address as text" });
  else if (typeof given.base_url === "string") {
    const problem = baseProblem("base_url", given.base_url.trim());
    if (problem) issues.push({ field: "base_url", reason: "invalid", message: problem });
  }
  // null: test with no key (the form's "Use no key"), never the saved one.
  if (given.api_key !== undefined && given.api_key !== null) {
    const problem = keyIssue(given.api_key);
    if (problem) issues.push({ field: "api_key", reason: "invalid", message: problem });
  }
  if (issues.length) throw invalid(issues);
  // The gateway in force and its own key: the environment's whole, else the saved one.
  const inForce = envGatewayInForce(env)
    ? { base: envValue(env, BASE_VAR)!, key: envValue(env, GATEWAY_KEY_ENV), field: BASE_VAR }
    : await readSavedGateway(store, sealKey).then((saved) => (saved ? { base: saved.base_url, key: saved.key, field: "base_url" } : undefined));
  const base = typeof given.base_url === "string" ? given.base_url.trim() : inForce?.base;
  if (base === undefined) return { ok: false, why: "No model gateway is saved here: enter its address to test it." };
  const field = typeof given.base_url === "string" ? "base_url" : inForce!.field;
  const problem = baseProblem(field, base);
  if (problem) return { ok: false, why: problem };
  const root = gatewayBase(field, base);
  const sameOrigin = inForce !== undefined && !baseProblem(inForce.field, inForce.base) && new URL(gatewayBase(inForce.field, inForce.base)).origin === new URL(root).origin;
  const key = typeof given.api_key === "string" ? given.api_key : given.api_key === null ? undefined : sameOrigin ? inForce!.key : undefined;
  return listModels(root, key, deps.fetch ?? fetch, signal);
}

/** The ids GET <root>/v1/models lists (OpenAI's shape: `{ data: [{ id }] }`), or why not, with `key` cut from any words. */
async function listModels(root: string, key: string | undefined, fetcher: typeof fetch, signal?: AbortSignal): Promise<GatewayTest> {
  const url = `${root}/v1/models`;
  const scrub = (text: string): string => (key ? text.split(key).join("[the key]") : text).replace(/\s+/g, " ").slice(0, 300);
  let answer: Response;
  try {
    answer = await fetcher(url, { method: "GET", redirect: "manual", headers: { accept: "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TEST_TIMEOUT_MS)]) : AbortSignal.timeout(TEST_TIMEOUT_MS) });
  } catch (error) {
    const name = (error as Error)?.name;
    if (name === "TimeoutError") return { ok: false, why: `The gateway did not answer GET ${url} within ${TEST_TIMEOUT_MS / 1000} seconds.` };
    if (name === "AbortError") return { ok: false, why: "The test was cancelled." };
    const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
    return { ok: false, why: `The gateway could not be reached at ${url}: ${scrub(cause?.code ?? cause?.message ?? (error as Error)?.message ?? String(error))}.` };
  }
  if (answer.status >= 300 && answer.status < 400) {
    await answer.body?.cancel();
    return { ok: false, why: `The gateway answered GET ${url} with a redirect (${answer.status}), and AgentRun follows none: a key goes only to the address you give. Use the address it redirects to.` };
  }
  const read = await textUpTo(answer, MAX_TEST_BYTES);
  if (read === undefined) return { ok: false, why: `The gateway's answer to GET ${url} is over ${MAX_TEST_BYTES / (1024 * 1024)} MB, more than a list of models: is this an OpenAI-compatible gateway's address?` };
  const text = read;
  if (answer.status === 401 || answer.status === 403) return { ok: false, why: `The gateway refused the key (${answer.status}): check the key, then test again.${detail(text, scrub)}` };
  if (!answer.ok) return { ok: false, why: `The gateway answered ${answer.status} to GET ${url}.${detail(text, scrub)}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, why: `The gateway's answer to GET ${url} is not JSON: is this an OpenAI-compatible gateway's address?` };
  }
  const data = isObject(parsed) && Array.isArray(parsed.data) ? parsed.data : undefined;
  if (!data) return { ok: false, why: `The gateway's answer to GET ${url} lists no models (no "data" array): is this an OpenAI-compatible gateway's address?` };
  // An id that holds the key is left out: the answer, and the console's model list, never show it.
  const ids = [...new Set(data.flatMap((entry) => (isObject(entry) && typeof entry.id === "string" && !idIssue(entry.id) && !(key && entry.id.includes(key)) ? [entry.id] : [])))].slice(0, MAX_LISTED);
  return { ok: true, models: ids };
}

/** `answer`'s body as text, read up to `max` bytes; undefined once it is longer (the rest is cancelled, never read), and
 *  "" for a body that could not be read. */
async function textUpTo(answer: Response, max: number): Promise<string | undefined> {
  const reader = answer.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => {});
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    return "";
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The gateway's own words after a refusal: its JSON's error message, else its text, short. */
function detail(text: string, scrub: (text: string) => string): string {
  let said = text;
  try {
    const body = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
    const message = typeof body.error === "object" ? body.error?.message : (body.error ?? body.message);
    if (typeof message === "string") said = message;
  } catch {
    // Not JSON: its text.
  }
  const shown = scrub(said).trim();
  return shown ? ` (The gateway said: ${shown})` : "";
}

/** One of the routes at its handler: its answer (sent 200), or an ApiError. */
export async function modelGatewayRoute(deps: ModelGatewayDeps, name: string, request: { readonly body?: unknown; readonly signal?: AbortSignal }): Promise<unknown> {
  if (name === "getModelGateway") return gatewayView(deps);
  if (name === "saveModelGateway") return saveGateway(deps, request.body);
  if (name === "deleteModelGateway") return removeGateway(deps);
  if (name === "testModelGateway") return testGateway(deps, request.body, request.signal);
  throw new ApiError("not_found", `no model gateway route ${name}`);
}
