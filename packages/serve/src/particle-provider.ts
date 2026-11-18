import { createHash } from "node:crypto";
import { createAssistantMessageEventStream, type AssistantMessage, type Model, type ProviderStreams, type StreamOptions } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createProvider } from "@earendil-works/pi-ai/models";

/** Regular peak list prices, USD per million tokens (https://docs.particle.ai/models, 2026-11-15).
 * Cached input is part of prompt_tokens; reasoning is already part of completion_tokens. Off-peak,
 * Flex and account-specific pricing can change the bill. These rates estimate usage and reserve the cap,
 * never claim to be a provider-reported charge. */
export const PARTICLE_1_PRICE = { input: 0.25, output: 1, cacheRead: 0.03, cacheWrite: 0 } as const;

/** Direct Particle uses Chat Completions, not OpenRouter's reasoning envelope or text tools.
 * HTTP Responses is unsupported (https://docs.particle.ai/responses); Pi translates its session
 * requests through this provider. Limits are Particle's own model catalog, not OpenRouter's. */
const PARTICLE_1: Model<"openai-completions"> = {
  id: "particle-1",
  name: "Particle-1",
  provider: "particle",
  api: "openai-completions",
  baseUrl: "https://api.particle.ai/v1",
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 1_048_576,
  maxTokens: 131_072,
  cost: PARTICLE_1_PRICE,
  thinkingLevelMap: { off: "none", minimal: "low", low: "low", medium: "high", high: "high", xhigh: "high", max: "max" },
  compat: {
    thinkingFormat: "openai",
    supportsReasoningEffort: true,
    supportsUsageInStreaming: true,
    supportsDeveloperRole: false,
    supportsStore: false,
    supportsStrictMode: false,
    maxTokensField: "max_completion_tokens",
    promptCacheKeyMode: "enabled",
    sendSessionAffinityHeaders: false,
  },
};

/** A stable opaque key, bounded below Particle's 256 UTF-8 byte limit and pi-ai's 64-character
 * limit. Hashing the whole ID avoids collisions from truncating long IDs with a shared prefix. */
const requestOptions = <T extends StreamOptions>(options?: T): T & { maxRetries: number } => ({
  ...options,
  maxRetries: 0,
  ...(options?.sessionId ? { sessionId: createHash("sha256").update(options.sessionId).digest("hex") } : {}),
} as T & { maxRetries: number });

/** With include_usage, a successful stream must carry the provider's token counts. A finish_reason
 * alone proves neither usage nor a free request. Fail closed on absent/malformed accounting. */
function metered<F extends ProviderStreams["stream"]>(send: F): F {
  return ((model, context, options) => {
    let accounted = false;
    let ended = false;
    const fetcher = options?.fetch ?? globalThis.fetch;
    const inner = send(model, context, {
      ...requestOptions(options),
      // The shared client accepts EOF after finish_reason. Particle explicitly requires [DONE]
      // (docs.particle.ai/streaming); observe that delimiter without buffering the response.
      fetch: async (input, init) => {
        const response = await fetcher(input, init);
        if (!response.ok || !response.body) return response;
        let tail = "";
        const decoder = new TextDecoder();
        return new Response(response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            const text = tail + decoder.decode(chunk, { stream: true });
            ended ||= /(?:^|\r|\n)data:[ \t]*\[DONE\][ \t]*(?:\r|\n)/.test(text);
            tail = text.slice(-128);
            controller.enqueue(chunk);
          },
        })), { status: response.status, statusText: response.statusText, headers: response.headers });
      },
      onProviderStreamEvent: async (data, current) => {
        const frame = data as { usage?: Record<string, unknown>; choices?: { usage?: Record<string, unknown> }[] } | null;
        // Match both usage locations the shared client consumes; a later compatibility report must not
        // overwrite already-validated accounting with unchecked counters.
        const usage = frame?.usage || (Array.isArray(frame?.choices) ? frame.choices[0]?.usage : undefined);
        if (usage) {
          accounted = false;
          const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
          // Validate every counter the shared client consumes, including its compatibility aliases.
          // Particle documents no separately billed cache writes; treating them as free would underprice input.
          const details = usage.prompt_tokens_details as { cached_tokens?: unknown; cache_write_tokens?: unknown } | undefined;
          const cached = details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? usage.cached_tokens ?? 0;
          const written = details?.cache_write_tokens ?? 0;
          const reasoning = (usage.completion_tokens_details as { reasoning_tokens?: unknown } | undefined)?.reasoning_tokens ?? 0;
          if (!count(usage.prompt_tokens) || !count(usage.completion_tokens) || !count(cached) || !count(reasoning) || written !== 0 || cached > usage.prompt_tokens || reasoning > usage.completion_tokens) {
            throw new Error("Particle returned invalid token usage; cost is unknown.");
          }
          accounted = true;
        }
        await options?.onProviderStreamEvent?.(data, current);
      },
    });
    const outer = createAssistantMessageEventStream();
    void (async () => {
      for await (const event of inner) {
        if (event.type === "done" && (!accounted || !ended)) {
          event.message.stopReason = "error";
          event.message.errorMessage = !accounted ? "Particle stream ended without token usage; cost is unknown." : "Particle stream ended without [DONE]; the response is incomplete and cost is unknown.";
          delete (event.message.usage.cost as { total?: number }).total;
          outer.push({ type: "error", reason: "error", error: event.message });
        } else {
          if (event.type === "error" && !accounted) delete (event.error.usage.cost as { total?: number }).total;
          outer.push(event);
        }
      }
      outer.end();
    })().catch((error: unknown) => {
      const failed: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], stopReason: options?.signal?.aborted ? "aborted" : "error", timestamp: Date.now(), errorMessage: String(error), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      delete (failed.usage.cost as { total?: number }).total;
      outer.push({ type: "error", reason: failed.stopReason as "error" | "aborted", error: failed });
      outer.end();
    });
    return outer;
  }) as F;
}

export function particleProvider() {
  const api = openAICompletionsApi();
  return createProvider({
    id: "particle",
    name: "Particle",
    baseUrl: PARTICLE_1.baseUrl,
    auth: { apiKey: { name: "PARTICLE_API_KEY", resolve: async ({ ctx }) => {
      const key = await ctx.env("PARTICLE_API_KEY");
      return key ? { auth: { apiKey: key }, source: "PARTICLE_API_KEY" } : undefined;
    } } },
    models: [PARTICLE_1],
    // Do not transparently replay a paid request after a transport/5xx failure whose outcome is
    // unknown. Even a safe pre-admission 429 is surfaced for the caller to retry deliberately.
    api: {
      stream: metered(api.stream),
      streamSimple: metered(api.streamSimple),
    },
  });
}
