import type { Api, Model, MutableModels, Provider } from "@earendil-works/pi-ai";
import { freeModel, type ModelPrice, ROUTERS } from "@parcha/agentrun-kernel/kernel/cap";
import { PARTICLE_1_PRICE, particleProvider } from "./particle-provider.js";

export { PARTICLE_1_PRICE } from "./particle-provider.js";

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
 *  id, name, input, context window and output ceiling, at $0, taking its tools natively (the `like` entry's `toolsAs` is
 *  not copied). Context and output ceiling are OpenRouter's (GET https://openrouter.ai/api/v1/models, read 2026-11-15:
 *  context_length and top_provider.max_completion_tokens; pricing "0" prompt and completion). Each one answered a request
 *  that defined a tool with a call to that tool, through OpenRouter, on 2026-11-15, billed $0. `mustReason` is that list's
 *  `reasoning.mandatory` (read 2026-11-16): a model that must reason has thinking off mapped to no effort (thinkingLevelMap
 *  `off: null`, as pi-ai's catalog maps Claude Sonnet 5.5's), so pi-ai never sends it `reasoning: {effort: "none"}`, which
 *  OpenRouter refuses with "Reasoning is mandatory for this endpoint and cannot be disabled", and the model reasons at
 *  its default. A model that lists `reasoning` among its supported parameters need not reason (Ling 3.2 Flash): only
 *  `mandatory` says so. */
export const ADDED_MODELS: readonly { readonly provider: string; readonly id: string; readonly like: string; readonly name: string; readonly input: readonly ("text" | "image")[]; readonly contextWindow: number; readonly maxTokens: number; readonly mustReason: boolean }[] = [
  { provider: "openrouter", id: "baidu/ernie-5.5-flash-preview:free", like: "inclusionai/ling-3.1-flash", name: "Baidu: ERNIE 5.5 Flash Preview (free)", input: ["text"], contextWindow: 1_024_000, maxTokens: 921_600, mustReason: true },
  { provider: "openrouter", id: "inclusionai/ling-3.2-flash:free", like: "inclusionai/ling-3.1-flash", name: "inclusionAI: Ling 3.2 Flash (free)", input: ["text"], contextWindow: 1_048_576, maxTokens: 262_144, mustReason: false },
];

/** `list` with ADDED_MODELS appended, each built on its `like` entry in `list` (one whose `like` the list lacks is left
 *  out) and never twice: once pi-ai lists an id itself, its own entry stands. */
const added = <M extends { id: string }>(list: readonly M[], adds: typeof ADDED_MODELS): readonly M[] => [
  ...list,
  ...adds.flatMap(({ id, like, name, input, contextWindow, maxTokens, mustReason }) => {
    const base = list.find((model) => model.id === like);
    if (!base || list.some((model) => model.id === id)) return [];
    const { toolsAs: _base, ...rest } = base as M & { toolsAs?: ToolsAs; thinkingLevelMap?: Record<string, string | null> | null };
    const levels = (rest as { thinkingLevelMap?: Record<string, string | null> | null }).thinkingLevelMap;
    return [{ ...rest, id, name, input: [...input], contextWindow, maxTokens, cost: { ...ZERO }, ...(mustReason ? { reasoning: true, thinkingLevelMap: { ...levels, off: null } } : {}) } as unknown as M];
  }),
];

/** Whether `provider`/`id` is one of OpenRouter's routers, each of which picks a model per request (the kernel cap's
 *  ROUTERS, the one list). OpenRouter lists the price of `auto`, `openrouter/auto*`, `openrouter/fusion`,
 *  `openrouter/pareto-code` and `typesafe/jev-router` as -1, the routed model's (read 2026-11-15), which pi-ai's catalog
 *  writes as 0; `openrouter/free` routes to a different free model per request. Their zeros say no model's price, so
 *  none of them is free: a model serve has no price for, which a cap cannot be kept on and which is never booked at its
 *  catalog's $0 (model.ts runModels' `unpriced`). */
export const isRouter = (provider: string, id: string): boolean => provider === "openrouter" && ROUTERS.has(id);

/** Whether a catalog entry runs at $0: the kernel's freeModel (kernel/cap/free.ts, the one rule, what a run on it books
 *  at $0) on the entry's price, its tiers included. An entry with no cost has no price, so is not free. */
export function isFree(model: { id: string; api?: string; cost?: ModelPrice | null }): boolean {
  return freeModel({ id: model.id, api: model.api ?? "", price: model.cost ?? null, outputCeiling: null });
}

/** `models` with serve's direct Particle provider registered, PRICE_OVERRIDES on the built-in providers' entries,
 *  and ADDED_MODELS beside them. Requests, prices and capability reads use this same catalog. */
export function withLocalModels<M extends MutableModels>(models: M): M {
  models.setProvider(particleProvider());
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
