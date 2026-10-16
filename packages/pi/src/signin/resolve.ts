// Which model a run uses, and the key it sends. First match wins:
//   1. An explicit provider and model with that provider's env key, passed on as an explicit key. pi-ai lets a stored
//      credential own its provider, so an env key alone never overrides a sign-in.
//   2. A stored ChatGPT sign-in, with the model chosen from the account's own GET /v1/models by the capability the spec
//      asks for, never a hardcoded id.
//   3. Otherwise, the sign-in.
// A resolved model serializes without its key: a demo that records or logs the result records no token.
import type { Api, AuthInteraction, Model, Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { USAGE_LIMIT_CODE, UsageLimitError } from "./limit.js";
import { CHATGPT_PROVIDER, chatgptModels, consoleInteraction, signIn, type SignInOptions } from "./signin.js";
import type { DemoSpec, EyesNeed, ModelNeed } from "./spec.js";
import { agentrunHome, fileCredentialStore } from "./store.js";

/** What Sign in with ChatGPT covers: streaming Responses calls with `store: false`, without these. */
export const CHATGPT_UNSUPPORTED = Object.freeze(["temperature", "max_output_tokens", "previous_response_id", "hosted tools", "audio input", "video input"]);

export type ResolveOptions = Omit<SignInOptions, "home"> & {
  provider?: string;
  model?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** An explicit eyes model (`--eyes-model`); `model` defaults to the spec's eyes default. */
  eyes?: { provider: string; model?: string };
  signal?: AbortSignal;
};

type Resolved = {
  model: Model<Api>;
  /** The key valid now. Not enumerable, and left out of `toJSON`. */
  readonly apiKey: string;
  /** A key valid at the time of the call: a sign-in's token is refreshed under the store's lock when it is near expiry. */
  getApiKey(): Promise<string>;
  /** Only streaming Responses calls with `store: false`, without `unsupported`. */
  responsesOnly: boolean;
  unsupported: readonly string[];
  toJSON(): Record<string, unknown>;
};
export type ResolvedModel = Resolved & { source: "flag" | "chatgpt"; limit?: string; eyes?: EyesModel };
export type EyesModel = Resolved & { source: "flag" | "lead" };

export class ResolveError extends Error {
  constructor(readonly code: "FLAGS" | "UNKNOWN_PROVIDER" | "UNKNOWN_MODEL" | "MISSING_KEY" | "NEEDS" | "EYES" | "NO_MODEL" | "MODEL_LIST" | "SIGNED_OUT", message: string) {
    super(message);
    this.name = "ResolveError";
  }
}

const meets = (model: Model<Api>, need: ModelNeed | EyesNeed) => need === "images" ? model.input.includes("image") : need !== "video";

function resolved<T extends string>(model: Model<Api>, apiKey: string, getApiKey: () => Promise<string>, source: T, extra: Record<string, unknown> = {}): Resolved & { source: T } {
  const responsesOnly = source === "chatgpt" || (extra.responsesOnly as boolean | undefined) === true;
  const result = { model, source, responsesOnly, unsupported: responsesOnly ? CHATGPT_UNSUPPORTED : [], ...extra } as Resolved & { source: T };
  Object.defineProperty(result, "apiKey", { value: apiKey, enumerable: false });
  Object.defineProperty(result, "getApiKey", { value: getApiKey, enumerable: false });
  Object.defineProperty(result, "toJSON", {
    enumerable: false,
    value: () => {
      const { model: _model, ...rest } = result as unknown as Record<string, unknown>;
      return { provider: model.provider, model: model.id, ...rest, ...(rest.eyes ? { eyes: (rest.eyes as Resolved).toJSON() } : {}) };
    },
  });
  return result;
}

/** The env key of `provider` set in `env`, and the names it was looked up under. Anthropic takes an API key only. */
async function providerKey(provider: Provider, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<{ key?: string; names: string[] }> {
  if (provider.id === "anthropic") return { key: env.ANTHROPIC_API_KEY || undefined, names: ["ANTHROPIC_API_KEY"] };
  const names: string[] = [];
  const result = await provider.auth.apiKey?.resolve({
    ctx: { env: async (name) => { names.push(name); return env[name] || undefined; }, fileExists: async () => false },
    signal,
  });
  return { key: result?.auth.apiKey, names };
}

type Listed = { id: string; created: number };

/** The account's models (GET /v1/models), those it lists as visible. */
async function accountModels(baseUrl: string, apiKey: string, signal: AbortSignal): Promise<Listed[]> {
  const response = await fetch(`${baseUrl}/models`, { headers: { authorization: `Bearer ${apiKey}` }, signal });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    if (body.includes(USAGE_LIMIT_CODE)) throw new UsageLimitError();
    throw new ResolveError("MODEL_LIST", `GET ${baseUrl}/models answered ${response.status}`);
  }
  const data = ((await response.json()) as { data?: Array<{ id?: unknown; created?: unknown; visibility?: unknown }> }).data ?? [];
  return data
    .filter((entry) => typeof entry?.id === "string" && (entry.visibility === undefined || entry.visibility === "list"))
    .map((entry) => ({ id: entry.id as string, created: typeof entry.created === "number" ? entry.created : 0 }));
}

/** The preferred id when it is listed and capable, else the newest listed model pi-ai knows that meets `needs`. */
function choose(provider: Provider, listed: Listed[], needs: ModelNeed[], preferred?: string): Model<Api> {
  const known = new Map(provider.getModels().map((model) => [model.id, model as Model<Api>]));
  const capable = listed
    .flatMap((entry) => { const model = known.get(entry.id); return model && needs.every((need) => meets(model, need)) ? [{ model, created: entry.created }] : []; })
    .sort((a, b) => b.created - a.created || a.model.id.localeCompare(b.model.id));
  const pick = capable.find((entry) => entry.model.id === preferred) ?? capable[0];
  if (!pick) throw new ResolveError("NO_MODEL", `The account lists ${listed.length} models, and none is a ${provider.name} model pi-ai knows that takes ${needs.join(", ")}.`);
  return pick.model;
}

async function flagModel(providerId: string, modelId: string | undefined, needs: Array<ModelNeed | EyesNeed>, preferred: string | undefined, env: NodeJS.ProcessEnv, signal: AbortSignal, flag: string) {
  const provider = builtinProviders().find((entry) => entry.id === providerId);
  if (!provider) throw new ResolveError("UNKNOWN_PROVIDER", `${flag} ${providerId}: pi-ai has no provider with that id`);
  const { key, names } = await providerKey(provider, env, signal);
  if (!key) throw new ResolveError("MISSING_KEY", `${flag} ${providerId} needs ${names.join(" or ") || "its key"} set`);
  // Video cannot be read from pi-ai's catalog: an explicit model is trusted to read it.
  const checked = needs.filter((need): need is ModelNeed => need !== "video");
  let model: Model<Api> | undefined;
  if (modelId) {
    model = provider.getModels().find((entry) => entry.id === modelId) as Model<Api> | undefined;
    if (!model) throw new ResolveError("UNKNOWN_MODEL", `${provider.name} has no model ${modelId} in pi-ai's catalog`);
    const gap = checked.filter((need) => !meets(model!, need));
    if (gap.length) throw new ResolveError("NEEDS", `${provider.name} ${modelId} does not take ${gap.join(" or ")} input, which this run needs`);
  } else if (providerId === CHATGPT_PROVIDER && provider.baseUrl) {
    model = choose(provider, await accountModels(provider.baseUrl, key, signal), checked, preferred);
  } else {
    const fallback = preferred ? provider.getModels().find((entry) => entry.id === preferred) as Model<Api> | undefined : undefined;
    if (!fallback || !checked.every((need) => meets(fallback, need))) throw new ResolveError("FLAGS", `${flag} ${providerId} needs a model id too`);
    model = fallback;
  }
  return { model, key };
}

/**
 * The model this run uses and the key to send, in the order above. The eyes model, when the spec has one, resolves the
 * same way: an explicit eyes model with its provider's key, else the lead's model when it meets the eyes' needs, else
 * a `ResolveError` ("EYES") naming the gap. The ChatGPT plan takes no video input.
 */
export async function resolveModel(spec: DemoSpec, options: ResolveOptions = {}): Promise<ResolvedModel> {
  const env = options.env ?? process.env;
  const signal = options.signal ?? new AbortController().signal;
  const needs = spec.models.lead.needs;
  let lead: ResolvedModel;
  if (options.provider || options.model) {
    if (!options.provider) throw new ResolveError("FLAGS", "--model needs --provider");
    const { model, key } = await flagModel(options.provider, options.model, needs, spec.models.lead.default, env, signal, "--provider");
    lead = resolved(model, key, async () => key, "flag");
  } else {
    const home = agentrunHome(options.home, env);
    const store = fileCredentialStore(home);
    if ((await store.read(CHATGPT_PROVIDER, { signal }))?.type !== "oauth") {
      // The run's signal reaches the sign-in through its interaction, so a cancel ends the login and frees its port.
      const interaction = options.interaction ?? consoleInteraction();
      // Its calls are forwarded, not spread: an interaction's notify and prompt may be methods of its class.
      const cancelled: AuthInteraction = options.signal ? {
        signal: interaction.signal ? AbortSignal.any([interaction.signal, options.signal]) : options.signal,
        notify: (event) => interaction.notify(event),
        prompt: (prompt) => interaction.prompt(prompt),
      } : interaction;
      try { await signIn({ ...options, home, env, interaction: cancelled }); }
      catch (error) { if (options.signal?.aborted) throw options.signal.reason; throw error; }
    }
    const models = chatgptModels(store);
    const getApiKey = async () => {
      const key = (await models.getAuth(CHATGPT_PROVIDER, { signal }))?.auth.apiKey;
      if (!key) throw new ResolveError("SIGNED_OUT", "The ChatGPT sign-in is gone from auth.json; sign in again");
      return key;
    };
    const key = await getApiKey();
    const provider = models.getProvider(CHATGPT_PROVIDER)!;
    const model = choose(provider, await accountModels(provider.baseUrl!, key, signal), needs, spec.models.lead.default);
    lead = resolved(model, key, getApiKey, "chatgpt", {
      limit: `Model calls count toward your ChatGPT plan's usage limit (five hours on Plus, shared with your other apps); this run expects about ${spec.expectedCalls}.`,
    });
  }
  const eyes = spec.models.eyes;
  if (!eyes) return lead;
  if (options.eyes) {
    const { model, key } = await flagModel(options.eyes.provider, options.eyes.model ?? eyes.default, eyes.needs, eyes.default, env, signal, "--eyes-model");
    lead.eyes = resolved(model, key, async () => key, "flag");
    return lead;
  }
  const gap = eyes.needs.filter((need) => !meets(lead.model, need));
  if (gap.length) {
    const reasons = gap.map((need) => need === "images" ? `the lead model ${lead.model.id} takes no image input`
      : lead.source === "chatgpt" ? "the ChatGPT plan takes no video input"
      : `pi-ai's catalog lists no video input for ${lead.model.provider} ${lead.model.id}`);
    throw new ResolveError("EYES", `The run's eyes need ${gap.join(" and ")} input: ${reasons.join("; ")}. Name a model that reads it with --eyes-model and set its provider's key${gap.includes("video") ? ", or list images and let frames be extracted locally" : ""}.`);
  }
  lead.eyes = resolved(lead.model, lead.apiKey, lead.getApiKey, "lead", { responsesOnly: lead.responsesOnly });
  return lead;
}
