import type { Api, Model, MutableModels, Provider } from "@earendil-works/pi-ai";

/** Particle-1's price, USD per million tokens: Particle's own list price, from https://docs.particle.ai/models (read
 *  2026-11-07: $0.25 input, $0.03 cached input, $1.00 output; no cache-write price, so $0). */
export const PARTICLE_1_PRICE = { input: 0.25, output: 1, cacheRead: 0.03, cacheWrite: 0 } as const;

/** Prices serve sets over pi-ai's own catalog entries, by provider and id. pi-ai 1.5.0 lists particle-ai/particle-1 at
 *  OpenRouter's current promotional price ($0.05 input, $0.003 cache read, $0.50 output). A run's cap holds each request
 *  at its worst case, priced from the catalog, before it is sent, and a hold must never price below what can be billed:
 *  the promotion can end before the catalog follows. So the hold takes Particle's list price. What a request is booked
 *  at once it answers stays pi-ai's: OpenRouter's billed total (Usage.cost.totalFromProvider), and this price only
 *  where OpenRouter reports none. */
export const PRICE_OVERRIDES: readonly { readonly provider: string; readonly id: string; readonly cost: Model<Api>["cost"] }[] = [
  { provider: "openrouter", id: "particle-ai/particle-1", cost: { ...PARTICLE_1_PRICE } },
];

/** `list` with each overridden model's price in place of the catalog's, whole: a field of the catalog's cost the override
 *  does not name (its price `tiers`, which pi-ai's calculateCost prices a request at once its input passes one) never
 *  survives, so a later catalog's promotional tier cannot price a hold below the list price. */
const priced = <M extends { id: string }>(list: readonly M[], overrides: typeof PRICE_OVERRIDES): readonly M[] =>
  list.map((model) => {
    const override = overrides.find((entry) => entry.id === model.id);
    return override ? { ...model, cost: { ...override.cost } } : model;
  });

/** `models` (pi-ai's built-in catalog, or one built on it) with PRICE_OVERRIDES set on their providers' own entries, in
 *  place: a request, a price and a capability read find the catalog's entry at the overridden price. */
export function withLocalModels<M extends MutableModels>(models: M): M {
  for (const providerId of new Set(PRICE_OVERRIDES.map((entry) => entry.provider))) {
    const own = models.getProvider(providerId);
    if (!own) continue;
    const overrides = PRICE_OVERRIDES.filter((entry) => entry.provider === providerId);
    const listed: Provider = Object.assign(Object.create(own) as Provider, {
      getModels: () => priced(own.getModels(), overrides),
      ...(own.getAllModels ? { getAllModels: () => priced(own.getAllModels!(), overrides) } : {}),
    });
    models.setProvider(listed);
  }
  return models;
}
