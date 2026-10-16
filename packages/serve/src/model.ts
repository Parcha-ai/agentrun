// Where a run's model comes from: a faux module (`--faux`, no key, no network), or an OpenAI Responses endpoint named in
// the environment. The definition names no model; this host binds it.
import { pathToFileURL } from "node:url";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

/** The child's environment names the faux module by absolute path. */
export const FAUX_ENV = "AGENTRUN_SERVE_FAUX";
/** A run's `effort`, passed to its child. */
export const EFFORT_ENV = "AGENTRUN_SERVE_EFFORT";
export const MODEL_PROVIDER = "agent-model";
export const EFFORTS = ["low", "medium", "high"] as const;
export type Effort = (typeof EFFORTS)[number];
const THINKING: Record<Effort, ModelThinkingLevel> = { low: "low", medium: "medium", high: "high" };

export type ModelSource = { source: "faux" | "env"; default: string | null } | null;

/** What capabilities say about the model, or null when no model is configured (a run then cannot start). */
export function modelSource(env: NodeJS.ProcessEnv): ModelSource {
  if (env[FAUX_ENV]) return { source: "faux", default: "faux/faux-1" };
  if (env.AGENT_MODEL_BASE_URL && env.AGENT_MODEL) return { source: "env", default: `${MODEL_PROVIDER}/${env.AGENT_MODEL}` };
  return null;
}

export const thinkingOf = (env: NodeJS.ProcessEnv): ModelThinkingLevel => THINKING[(env[EFFORT_ENV] as Effort) in THINKING ? (env[EFFORT_ENV] as Effort) : "medium"];

/** The helpers a faux module's reply gets, so it needs no import of its own. */
export type FauxHelpers = {
  /** Aborted when the turn is stopped: a slow reply resolves with `message("", { stopReason: "aborted" })`. */
  signal?: AbortSignal;
  message: typeof import("@earendil-works/pi-ai").fauxAssistantMessage;
  text: typeof import("@earendil-works/pi-ai").fauxText;
  thinking: typeof import("@earendil-works/pi-ai").fauxThinking;
  toolCall: typeof import("@earendil-works/pi-ai").fauxToolCall;
};

/** The models and model ref for a run: the faux module's replies, or the endpoint in the environment. */
export async function runModels(env: NodeJS.ProcessEnv) {
  const ai = await import("@earendil-works/pi-ai");
  const { createModels, createProvider } = await import("@earendil-works/pi-ai/models");
  const models = createModels();
  const faux = env[FAUX_ENV];
  if (faux) {
    const mod = (await import(pathToFileURL(faux).href)) as { default?: unknown; cost?: { input: number; output: number; cacheRead: number; cacheWrite: number } };
    if (typeof mod.default !== "function") throw new Error(`the faux module ${faux} has no default export function`);
    const reply = mod.default as (context: unknown, helpers: FauxHelpers) => unknown;
    const helpers: FauxHelpers = { message: ai.fauxAssistantMessage, text: ai.fauxText, thinking: ai.fauxThinking, toolCall: ai.fauxToolCall };
    const core = ai.createFauxCore(mod.cost ? { models: [{ id: "faux-1", cost: mod.cost }] } : {});
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
    const model = core.getModel();
    return { models, model: { provider: model.provider, modelId: model.id } };
  }
  const baseUrl = env.AGENT_MODEL_BASE_URL?.replace(/\/+$/, "");
  const id = env.AGENT_MODEL;
  if (!baseUrl || !id) throw new Error("no model: start agentrun-serve with --faux MODULE, or set AGENT_MODEL_BASE_URL and AGENT_MODEL");
  const { openAIResponsesApi } = await import("@earendil-works/pi-ai/api/openai-responses.lazy");
  // USD per million input, output, cache-read and cache-write tokens, so the run's usage has a price; unset, it is $0.
  const [input = 0, output = 0, cacheRead = 0, cacheWrite = input] = (env.AGENT_MODEL_PRICE || "0").split(",").map(Number);
  models.setProvider(createProvider({
    id: MODEL_PROVIDER,
    baseUrl,
    auth: { apiKey: { name: "AGENT_MODEL_API_KEY", resolve: async () => ({ auth: { apiKey: env.AGENT_MODEL_API_KEY || "none" }, source: "AGENT_MODEL_API_KEY" }) } },
    models: [{
      id, name: id, api: "openai-responses", provider: MODEL_PROVIDER, baseUrl, reasoning: true, input: ["text", "image"],
      cost: { input, output, cacheRead, cacheWrite }, contextWindow: 128_000, maxTokens: 32_000, compat: { supportsDeveloperRole: false },
    }],
    api: openAIResponsesApi(),
  }));
  return { models, model: { provider: MODEL_PROVIDER, modelId: id } };
}
