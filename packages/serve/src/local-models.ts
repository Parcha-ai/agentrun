import type { Api, Model, MutableModels, Provider } from "@earendil-works/pi-ai";

/** Particle-1's price, USD per million tokens: Particle's own list price, from https://docs.particle.ai/models (read
 *  2026-11-07: $0.25 input, $0.03 cached input, $1.00 output; no cache-write price, so $0). Not OpenRouter's current
 *  promotional $0.05 input, $0.003 cache read, $0.50 output (pi-ai 1.5.0's entry): on pi-ai 1.1.0 a run's cost is
 *  computed from this price, and one below what can be billed would make the spend cap undercount; above it errs safe. */
export const PARTICLE_1_PRICE = { input: 0.25, output: 1, cacheRead: 0.03, cacheWrite: 0 } as const;

/** Models serve lists beside pi-ai's built-in catalog: ones a newer pi-ai lists that the pi family's pinned pi-ai (1.1.0,
 *  capped below 1.4.0 with pi-durable) does not. Each entry is copied as it stands in the newer catalog, limits included,
 *  never estimated; its price is cited where it is set. A model the built-in catalog lists under the same provider and
 *  id wins over its entry. Remove each when the pi family moves to >= 1.5.0. */
export const LOCAL_MODELS: readonly Model<Api>[] = [
  // pi-ai 1.5.0 dist/providers/data/openrouter.json ("openai-completions"), its OpenRouter listing: Particle AI's
  // Particle-1, every field but its price (PARTICLE_1_PRICE). Remove when the pi family moves to >= 1.5.0.
  {
    type: "chat",
    id: "particle-ai/particle-1",
    name: "Particle AI: Particle-1",
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    provider: "openrouter",
    reasoning: true,
    thinkingLevelMap: { off: "none", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
    input: ["text", "image"],
    cost: { ...PARTICLE_1_PRICE },
    contextWindow: 1_048_576,
    maxTokens: 131_072,
    compat: { supportsDeveloperRole: false, thinkingFormat: "openrouter", supportsStrictMode: true, sendSessionAffinityHeaders: true },
    inputLimits: { images: { resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80 } } },
  } as unknown as Model<Api>,
];

/** `list` with the local models of its provider that it does not list itself (by id). */
const withLocal = <M extends { id: string }>(list: readonly M[], local: readonly Model<Api>[]): readonly M[] => [...list, ...(local.filter((model) => !list.some((listed) => listed.id === model.id)) as unknown as M[])];

/** `models` (pi-ai's built-in catalog, or one built on it) with LOCAL_MODELS added to their providers, in place: each such
 *  provider answers for them as for its own (its auth, its API), so a request, a price and a capability read find them. */
export function withLocalModels<M extends MutableModels>(models: M): M {
  for (const providerId of new Set(LOCAL_MODELS.map((model) => model.provider))) {
    const own = models.getProvider(providerId);
    if (!own) continue;
    const local = LOCAL_MODELS.filter((model) => model.provider === providerId);
    const listed: Provider = Object.assign(Object.create(own) as Provider, {
      getModels: () => withLocal(own.getModels(), local),
      ...(own.getAllModels ? { getAllModels: () => withLocal(own.getAllModels!(), local) } : {}),
    });
    models.setProvider(listed);
  }
  return models;
}
