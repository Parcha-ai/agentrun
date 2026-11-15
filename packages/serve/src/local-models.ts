import type { Api, Model, MutableModels, Provider } from "@earendil-works/pi-ai";

/** Particle-1's price, USD per million tokens: Particle's own list price, from https://docs.particle.ai/models (read
 *  2026-11-07: $0.25 input, $0.03 cached input, $1.00 output; no cache-write price, so $0). */
export const PARTICLE_1_PRICE = { input: 0.25, output: 1, cacheRead: 0.03, cacheWrite: 0 } as const;

/** How a model takes its tools: "native", the request's own tools parameter (every model pi-ai lists), or "text", the
 *  tools described in its system prompt and its calls read back from its reply (runner/text-tools.ts, on the runner's
 *  translated route, runner/model-route.ts). A wire format of the model's provider, not a choice of a task's. */
export type ToolsAs = "native" | "text";

/** What serve sets over pi-ai's own catalog entries, by provider and id: a price (`cost`), and how the model takes its
 *  tools (`toolsAs`, absent: native). pi-ai 1.5.0 lists particle-ai/particle-1 at
 *  OpenRouter's current promotional price ($0.05 input, $0.003 cache read, $0.50 output). A run's cap holds each request
 *  at its worst case, priced from the catalog, before it is sent, and a hold must never price below what can be billed:
 *  the promotion can end before the catalog follows. So the hold takes Particle's list price, and so does the booking:
 *  a request that answers is booked at pi-ai's calculateCost on this same catalog entry, its list price, not at what
 *  OpenRouter bills during the promotion. */
export const PRICE_OVERRIDES: readonly { readonly provider: string; readonly id: string; readonly cost: Model<Api>["cost"]; readonly toolsAs?: ToolsAs }[] = [
  // Particle-1 takes its tools as text: Particle AI, its one provider on OpenRouter, caches no prefix of a request that
  // carries a tools parameter (measured 2026-11-11: such a request renders to a prompt whose token count varies by send,
  // and 0-30% of it is cached); with its tools as text, 76-92% of a review's input is read from the cache.
  { provider: "openrouter", id: "particle-ai/particle-1", cost: { ...PARTICLE_1_PRICE }, toolsAs: "text" },
];

/** `list` with each overridden model's price in place of the catalog's, whole: a field of the catalog's cost the override
 *  does not name (its price `tiers`, which pi-ai's calculateCost prices a request at once its input passes one) never
 *  survives, so a later catalog's promotional tier cannot price a hold below the list price. An override's `toolsAs`
 *  rides on the entry beside it. */
const priced = <M extends { id: string }>(list: readonly M[], overrides: typeof PRICE_OVERRIDES): readonly M[] =>
  list.map((model) => {
    const override = overrides.find((entry) => entry.id === model.id);
    return override ? { ...model, cost: { ...override.cost }, ...(override.toolsAs ? { toolsAs: override.toolsAs } : {}) } : model;
  });

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

/** Models serve lists that pi-ai's catalog does not: OpenRouter's free variants of models that take tools, each a copy of
 *  `like` (a catalog entry on the same provider and wire: its api, base URL, compat and reasoning settings) under its own
 *  id, name, input, context window and output ceiling, at $0, with the `toolsAs` it takes. Context and output ceiling are
 *  OpenRouter's (GET https://openrouter.ai/api/v1/models, read 2026-11-15: context_length and
 *  top_provider.max_completion_tokens; pricing "0" prompt and completion). Each one answered a request that defined a tool
 *  with a call to that tool, through OpenRouter, on 2026-11-15, billed $0. */
export const ADDED_MODELS: readonly { readonly provider: string; readonly id: string; readonly like: string; readonly name: string; readonly input: readonly ("text" | "image")[]; readonly contextWindow: number; readonly maxTokens: number; readonly toolsAs?: ToolsAs }[] = [
  // Particle-1 on its free route, served by Particle AI as the paid one is: its tools as text, for the same caching.
  { provider: "openrouter", id: "particle-ai/particle-1:free", like: "particle-ai/particle-1", name: "Particle AI: Particle-1 (free)", input: ["text", "image"], contextWindow: 1_048_576, maxTokens: 131_072, toolsAs: "text" },
  { provider: "openrouter", id: "baidu/ernie-5.5-flash-preview:free", like: "inclusionai/ling-3.1-flash", name: "Baidu: ERNIE 5.5 Flash Preview (free)", input: ["text"], contextWindow: 1_024_000, maxTokens: 921_600 },
  { provider: "openrouter", id: "inclusionai/ling-3.2-flash:free", like: "inclusionai/ling-3.1-flash", name: "inclusionAI: Ling 3.2 Flash (free)", input: ["text"], contextWindow: 1_048_576, maxTokens: 262_144 },
];

/** `list` with ADDED_MODELS appended, each built on its `like` entry in `list` (one whose `like` the list lacks is left
 *  out) and never twice: once pi-ai lists an id itself, its own entry stands. */
const added = <M extends { id: string }>(list: readonly M[], adds: typeof ADDED_MODELS): readonly M[] => [
  ...list,
  ...adds.flatMap(({ id, like, name, input, contextWindow, maxTokens, toolsAs }) => {
    const base = list.find((model) => model.id === like);
    if (!base || list.some((model) => model.id === id)) return [];
    const { toolsAs: _base, ...rest } = base as M & { toolsAs?: ToolsAs };
    return [{ ...rest, id, name, input: [...input], contextWindow, maxTokens, cost: { ...ZERO }, ...(toolsAs ? { toolsAs } : {}) } as unknown as M];
  }),
];

/** OpenRouter's routers: each picks a model per request. OpenRouter lists the price of `auto`, `openrouter/auto*`,
 *  `openrouter/fusion`, `openrouter/pareto-code` and `typesafe/jev-router` as -1, the routed model's (read 2026-11-15), which
 *  pi-ai's catalog writes as 0; `openrouter/free` routes to a different free model per request. Their zeros say no
 *  model's price, so none of them is free. */
const ROUTERS: ReadonlySet<string> = new Set(["auto", "openrouter/auto", "openrouter/auto-beta", "openrouter/auto-code", "openrouter/free", "openrouter/fusion", "openrouter/pareto-code", "typesafe/jev-router"]);

/** Whether a catalog entry runs at $0: its price is all zeros, every price tier's too. Read from the price alone, never
 *  from the id (a `:free` id at a price is not free), except an OpenRouter router (ROUTERS), whose zeros are no price. */
export function isFree(model: { provider: string; id: string; cost?: Partial<Model<Api>["cost"]> }): boolean {
  if (model.provider === "openrouter" && ROUTERS.has(model.id)) return false;
  if (!model.cost) return false;
  const { tiers = [], ...flat } = model.cost as Record<string, unknown> & { tiers?: readonly Record<string, unknown>[] };
  const zero = (price: Record<string, unknown>) => Object.values(price).every((v) => typeof v !== "number" || v === 0);
  return flat.input === 0 && flat.output === 0 && zero(flat) && tiers.every(zero);
}

/** `models` (pi-ai's built-in catalog, or one built on it) with PRICE_OVERRIDES set on their providers' own entries and
 *  ADDED_MODELS listed beside them, in place: a request, a price and a capability read find the catalog's entry at the
 *  overridden price, with its toolsAs, and an added model as if the catalog listed it. */
export function withLocalModels<M extends MutableModels>(models: M): M {
  for (const providerId of new Set([...PRICE_OVERRIDES, ...ADDED_MODELS].map((entry) => entry.provider))) {
    const own = models.getProvider(providerId);
    if (!own) continue;
    const overrides = PRICE_OVERRIDES.filter((entry) => entry.provider === providerId);
    const adds = ADDED_MODELS.filter((entry) => entry.provider === providerId);
    const listed: Provider = Object.assign(Object.create(own) as Provider, {
      getModels: () => added(priced(own.getModels(), overrides), adds),
      ...(own.getAllModels ? { getAllModels: () => added(priced(own.getAllModels!(), overrides), adds) } : {}),
    });
    models.setProvider(listed);
  }
  return models;
}
