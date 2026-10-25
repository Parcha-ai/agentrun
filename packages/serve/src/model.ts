// Where a run's model comes from. An agentic revision names one as "provider/model-id", or names none and runs on this
// host's default (`AGENT_MODEL`). A workflow's model node names a tier, and the host maps it: fast to
// `AGENT_MODEL_FAST`, strong to `AGENT_MODEL_STRONG`, each falling back to the default. With `--faux` every model is the
// faux module's (no key, no network); with `AGENT_MODEL_BASE_URL` every model id goes to that one OpenAI Responses
// gateway; otherwise pi-ai's providers serve it, with their keys from the environment.
import { pathToFileURL } from "node:url";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

/** The child's environment names the faux module by absolute path. */
export const FAUX_ENV = "AGENTRUN_SERVE_FAUX";
/** A run's `effort`, passed to its child. */
export const EFFORT_ENV = "AGENTRUN_SERVE_EFFORT";
export const MODEL_PROVIDER = "agent-model";
export const EFFORTS = ["low", "medium", "high"] as const;
export type Effort = (typeof EFFORTS)[number];
/** The thinking levels a revision or the host may name. Never off. */
export const THINKING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export const TIERS = ["fast", "default", "strong"] as const;
export type Tier = (typeof TIERS)[number];
const TIER_ENV: Record<Tier, string> = { fast: "AGENT_MODEL_FAST", default: "AGENT_MODEL", strong: "AGENT_MODEL_STRONG" };
/** The workflow node kinds that run on a model. */
export const MODEL_NODES = ["agent", "decide", "extract", "report"] as const;

/** The host's model id for `tier`: its own variable, else the default's. */
const tierModel = (env: NodeJS.ProcessEnv, tier: Tier): string | undefined => env[TIER_ENV[tier]] || env.AGENT_MODEL || undefined;
/** A faux model id per tier: `faux-1`, or the id a tier's variable names. */
const fauxModel = (env: NodeJS.ProcessEnv, tier: Tier): string => (tier === "default" ? undefined : env[TIER_ENV[tier]]) || "faux-1";

export type ModelSource = { source: "faux" | "gateway" | "providers" } & Record<Tier, string | null>;

/** What capabilities say about models here: where they come from, and the model of each tier (`default` is also what a
 *  revision that names none runs on). */
export function modelSource(env: NodeJS.ProcessEnv): ModelSource {
  const each = (name: (tier: Tier) => string | null) => Object.fromEntries(TIERS.map((tier) => [tier, name(tier)])) as Record<Tier, string | null>;
  if (env[FAUX_ENV]) return { source: "faux", ...each((tier) => `faux/${fauxModel(env, tier)}`) };
  if (env.AGENT_MODEL_BASE_URL) return { source: "gateway", ...each((tier) => (tierModel(env, tier) ? `${MODEL_PROVIDER}/${tierModel(env, tier)}` : null)) };
  return { source: "providers", ...each((tier) => tierModel(env, tier) ?? null) };
}

/** A workflow's nodes as the DSL's inspection lists them, each read from the document at its path: only what the
 *  workflow's structure makes a node, never data shaped like one (a node's `state` may hold an example node). */
export function workflowNodes(workflow: unknown, inspection: { nodes: readonly { path: string }[] }): Record<string, unknown>[] {
  const at = (path: string) => path.split("/").slice(1).reduce<unknown>((value, part) => (value as Record<string, unknown>)[part.replace(/~1/g, "/").replace(/~0/g, "~")], workflow);
  return inspection.nodes.map(({ path }) => at(path) as Record<string, unknown>);
}

/** The tiers a workflow's model nodes name (`nodes` from workflowNodes); a node that names none is `default`. */
export function nodeTiers(nodes: readonly Record<string, unknown>[]): Tier[] {
  const tiers = new Set<Tier>();
  for (const node of nodes) {
    const model = (MODEL_NODES as readonly unknown[]).includes(node.node) || (node.node === "artifact" && ["markdown", "report"].includes(String(node.type)));
    if (model) tiers.add((TIERS as readonly unknown[]).includes(node.tier) ? (node.tier as Tier) : "default");
  }
  return TIERS.filter((tier) => tiers.has(tier));
}

export type ModelRef = { provider: string; modelId: string };

/**
 * The model a revision runs on here, or why it cannot: `ref` is an agentic revision's "provider/model-id", absent for
 * the host's model of `tier`. Through the gateway the model id is the part after the provider.
 */
export async function chooseModel(env: NodeJS.ProcessEnv, ref: string | undefined, tier: Tier = "default"): Promise<{ model: ModelRef } | { why: string }> {
  if (env[FAUX_ENV]) return { model: { provider: "faux", modelId: fauxModel(env, tier) } };
  const named = ref ?? tierModel(env, tier);
  const none = tier === "default" ? "The revision names no model, and this host has no default" : `A workflow node of the ${tier} tier has no model here (${TIER_ENV[tier]}), and this host has no default`;
  if (env.AGENT_MODEL_BASE_URL) {
    if (!named) return { why: `${none}: set AGENT_MODEL, or name a model in the definition.` };
    return { model: { provider: MODEL_PROVIDER, modelId: ref ? ref.slice(ref.indexOf("/") + 1) : named } };
  }
  if (!named) return { why: `${none}: set AGENT_MODEL to a provider/model-id, start agentrun-serve with --faux MODULE, or name a model in the definition.` };
  const slash = named.indexOf("/");
  if (slash < 1) return { why: `The host's default model ${named} is not a provider/model-id.` };
  const [provider, modelId] = [named.slice(0, slash), named.slice(slash + 1)];
  const { builtinModels } = await import("@earendil-works/pi-ai/providers/all");
  const models = builtinModels();
  const model = models.getModel(provider, modelId);
  if (!model) return { why: `pi-ai knows no model ${modelId} of ${provider}. Name one of its models, or route every model through a gateway with AGENT_MODEL_BASE_URL.` };
  if (!(await models.getAuth(model))) return { why: `pi-ai finds no key for ${provider} in this environment (${models.getProvider(provider)?.auth.apiKey?.name ?? "its API key"}): set it where agentrun-serve starts.` };
  return { model: { provider, modelId } };
}

/** A run's thinking level: its `effort`, else its revision's `thinking`, else the host's `AGENT_THINKING`, else medium.
 *  Never off. */
export function thinkingOf(env: NodeJS.ProcessEnv, revision?: string): ModelThinkingLevel {
  const level = [env[EFFORT_ENV], revision, env.AGENT_THINKING].find((name) => (THINKING_LEVELS as readonly unknown[]).includes(name));
  return (level ?? "medium") as ModelThinkingLevel;
}

/** The helpers a faux module's reply gets, so it needs no import of its own. */
export type FauxHelpers = {
  /** Aborted when the turn is stopped: a slow reply resolves with `message("", { stopReason: "aborted" })`. */
  signal?: AbortSignal;
  message: typeof import("@earendil-works/pi-ai").fauxAssistantMessage;
  text: typeof import("@earendil-works/pi-ai").fauxText;
  thinking: typeof import("@earendil-works/pi-ai").fauxThinking;
  toolCall: typeof import("@earendil-works/pi-ai").fauxToolCall;
};

/** The models for a run, and its model of each tier it uses and of no other: an agentic revision's `ref` (or the
 *  default) is its `default`, and a workflow's tiers are the ones its nodes name. The faux module's replies, the gateway
 *  in the environment, or pi-ai's providers. */
export async function runModels(env: NodeJS.ProcessEnv, ref: string | undefined, tiers: readonly Tier[] = ["default"]) {
  const ai = await import("@earendil-works/pi-ai");
  const { createModels, createProvider } = await import("@earendil-works/pi-ai/models");
  const faux = env[FAUX_ENV];
  const byTier = new Map<Tier, ModelRef>();
  for (const tier of new Set(tiers)) {
    const chosen = await chooseModel(env, tier === "default" ? ref : undefined, tier);
    if ("why" in chosen) throw new Error(chosen.why);
    byTier.set(tier, chosen.model);
  }
  const model = byTier.get("default");
  if (!faux && !env.AGENT_MODEL_BASE_URL) {
    const { builtinModels } = await import("@earendil-works/pi-ai/providers/all");
    return { models: builtinModels(), model, byTier };
  }
  const ids = [...new Set([...byTier.values()].map((m) => m.modelId))];
  const models = createModels();
  if (!ids.length) return { models, model, byTier };
  if (faux) {
    const mod = (await import(pathToFileURL(faux).href)) as { default?: unknown; cost?: { input: number; output: number; cacheRead: number; cacheWrite: number } };
    if (typeof mod.default !== "function") throw new Error(`the faux module ${faux} has no default export function`);
    const reply = mod.default as (context: unknown, helpers: FauxHelpers) => unknown;
    const helpers: FauxHelpers = { message: ai.fauxAssistantMessage, text: ai.fauxText, thinking: ai.fauxThinking, toolCall: ai.fauxToolCall };
    const core = ai.createFauxCore({ models: ids.map((id) => ({ id, ...(mod.cost ? { cost: mod.cost } : {}) })) as [{ id: string }, ...{ id: string }[]] });
    const step = (async (context: unknown, options?: { signal?: AbortSignal }) => reply(context, { ...helpers, ...(options?.signal ? { signal: options.signal } : {}) })) as unknown as Parameters<typeof core.setResponses>[0][number];
    core.setResponses(Array.from({ length: 10_000 }, () => step));
    // `cost` (USD per million tokens) prices the faux model's usage, which the faux core leaves at $0, so a run's
    // estimate and its cap can be tested.
    const priced: typeof core.stream = (model, context, options) => {
      const inner = core.stream(model, context, options);
      if (!mod.cost) return inner;
      const outer = ai.createAssistantMessageEventStream();
      void (async () => {
        let last: Parameters<typeof outer.end>[0];
        for await (const event of inner) {
          const message = event.type === "done" ? event.message : event.type === "error" ? event.error : undefined;
          if (message) {
            message.usage.cost = ai.calculateCost(model, message.usage);
            last = message;
          }
          outer.push(event);
        }
        outer.end(last ?? (await inner.result()));
      })();
      return outer;
    };
    models.setProvider(createProvider({
      id: core.provider,
      auth: { apiKey: { name: "Faux", resolve: async () => ({ auth: {} }) } },
      models: core.models,
      api: { stream: priced, streamSimple: priced, fetchDeferred: core.fetchDeferred, cancelDeferred: core.cancelDeferred },
    }));
    return { models, model, byTier };
  }
  const baseUrl = env.AGENT_MODEL_BASE_URL!.replace(/\/+$/, "");
  const { openAIResponsesApi } = await import("@earendil-works/pi-ai/api/openai-responses.lazy");
  // USD per million input, output, cache-read and cache-write tokens, so the run's usage has a price; unset, it is $0. A
  // tier's own price (`AGENT_MODEL_FAST_PRICE`, `AGENT_MODEL_STRONG_PRICE`) goes with its model, else the default's; a
  // model two tiers share takes the default's.
  const prices = new Map<string, string>();
  for (const tier of ["default", "fast", "strong"] as const) {
    const id = byTier.get(tier)?.modelId;
    if (id !== undefined && !prices.has(id)) prices.set(id, (tier !== "default" && env[`${TIER_ENV[tier]}_PRICE`]) || env.AGENT_MODEL_PRICE || "0");
  }
  const priceOf = (id: string) => {
    const [input = 0, output = 0, cacheRead = 0, cacheWrite = input] = prices.get(id)!.split(",").map(Number);
    return { input, output, cacheRead, cacheWrite };
  };
  models.setProvider(createProvider({
    id: MODEL_PROVIDER,
    baseUrl,
    auth: { apiKey: { name: "AGENT_MODEL_API_KEY", resolve: async () => ({ auth: { apiKey: env.AGENT_MODEL_API_KEY || "none" }, source: "AGENT_MODEL_API_KEY" }) } },
    models: ids.map((id) => ({
      id, name: id, api: "openai-responses", provider: MODEL_PROVIDER, baseUrl, reasoning: true, input: ["text", "image"] as ("text" | "image")[],
      cost: priceOf(id), contextWindow: 128_000, maxTokens: 32_000, compat: { supportsDeveloperRole: false },
    })),
    api: openAIResponsesApi(),
  }));
  return { models, model, byTier };
}
