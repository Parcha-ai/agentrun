// What requests cost at a catalog's list prices: pi-ai's catalog and its calculateCost, the pricing serve's import
// estimates a session with when the source wrote no cost of its own. pi-ai is a dependency, loaded on the first price asked
// for (not at startup); a load that fails throws with its reason, never a price of null that says nothing why.
import type { Usage } from "./types.js";

export type ModelCost = { input: number; output: number; cacheRead: number; cacheWrite: number; tiers?: unknown };
/** A model's entry in a catalog: its provider, and its price in USD per million tokens. */
export type Listed = { provider: string; cost: ModelCost };
/** Catalog entries by model id, every provider's. */
export type Catalog = ReadonlyMap<string, readonly Listed[]>;

/** A catalog of pi-ai's models (builtinModels().getModels()), by model id. */
export function catalogOf(models: readonly { id: string; provider: string; cost?: Partial<ModelCost> }[]): Catalog {
  const out = new Map<string, Listed[]>();
  for (const model of models) {
    const { input = 0, output = 0, cacheRead = 0, cacheWrite = 0, tiers } = model.cost ?? {};
    const listed = out.get(model.id) ?? out.set(model.id, []).get(model.id)!;
    listed.push({ provider: model.provider, cost: { input, output, cacheRead, cacheWrite, ...(tiers ? { tiers } : {}) } });
  }
  return out;
}

/** pi-ai's built-in catalog, by model id. serve prices with its own catalog (pi-ai's, with serve's overrides and added
 *  models), which it passes in; the CLI imports pi-ai itself. */
export async function builtinCatalog(): Promise<Catalog> {
  return catalogOf((await import("@earendil-works/pi-ai/providers/all")).builtinModels().getModels());
}

/** pi-ai's calculateCost: what one request's usage costs at a model's price. */
export type CalculateCost = (model: { cost: ModelCost }, usage: Usage & { totalTokens: number; cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } }) => { total: number };

/** A request to price: the model it ran on ("provider/model"), and its tokens. */
export type Priced = { model?: string; usage?: Usage };

/** pi-ai's calculateCost, loaded. */
export const loadCalculateCost = async (): Promise<CalculateCost> => (await import("@earendil-works/pi-ai")).calculateCost as unknown as CalculateCost;

/** What one request costs at `catalog`'s list prices, unrounded: undefined when its tokens are unknown or its provider
 *  does not list its model; 0 for a request of no tokens, at any price. */
export function priceRequest({ model, usage }: Priced, catalog: Catalog, calculate: CalculateCost): number | undefined {
  if (!usage) return undefined;
  const { input, output, cacheRead, cacheWrite, cacheWrite1h } = usage;
  if (input + output + cacheRead + cacheWrite === 0) return 0;
  const at = model?.indexOf("/") ?? -1;
  const cost = model && at > 0 ? catalog.get(model.slice(at + 1))?.find((entry) => entry.provider === model.slice(0, at))?.cost : undefined;
  if (!cost) return undefined;
  const counted = { input, output, cacheRead, cacheWrite, ...(cacheWrite1h !== undefined ? { cacheWrite1h } : {}), totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  return calculate({ cost }, counted).total;
}

/** A sum of requests' costs rounded to a millionth of a dollar. */
export const roundUsd = (usd: number): number => Math.round(usd * 1e6) / 1e6;

/** What `requests` cost at `catalog`'s list prices, each at its own provider's entry for its model, rounded to a
 *  millionth of a dollar: undefined when one request's tokens are unknown or its provider does not list its model (the
 *  request was served at a price no one lists here). A provider's $0 entry is $0. A request of no tokens costs nothing
 *  at any price. The sum is taken in the requests' order, adding a request of no tokens as 0
 *  (which leaves any sum as it is). */
export async function priceRequests(requests: readonly Priced[], catalog: Catalog, calculateCost?: CalculateCost): Promise<number | undefined> {
  const calculate = calculateCost ?? (await loadCalculateCost());
  let total = 0;
  for (const request of requests) {
    const usd = priceRequest(request, catalog, calculate);
    if (usd === undefined) return undefined;
    total += usd;
  }
  return roundUsd(total);
}
