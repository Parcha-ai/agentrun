// What requests cost at a catalog's list prices: pi-ai's catalog and its calculateCost, the pricing serve's import
// estimates a session with when the source wrote no cost of its own. pi-ai is an optional peer: without it, no price.
import type { Usage } from "./types.js";

export type ModelCost = { input: number; output: number; cacheRead: number; cacheWrite: number; tiers?: unknown };
/** A model's entry in a catalog: its provider, and its price in USD per million tokens. */
export type Listed = { provider: string; cost: ModelCost };
/** Catalog entries by model id, every provider's. */
export type Catalog = ReadonlyMap<string, readonly Listed[]>;

/** pi-ai's built-in catalog, by model id; undefined when pi-ai is not installed. serve prices with its own catalog
 *  (pi-ai's, with serve's overrides and added models), which it passes in. */
export async function builtinCatalog(): Promise<Catalog | undefined> {
  const loaded = await import("@earendil-works/pi-ai/providers/all").catch(() => undefined);
  if (!loaded) return undefined;
  const out = new Map<string, Listed[]>();
  for (const model of loaded.builtinModels().getModels()) {
    const { input = 0, output = 0, cacheRead = 0, cacheWrite = 0, tiers } = (model as { cost?: Partial<ModelCost> }).cost ?? {};
    const listed = out.get(model.id) ?? out.set(model.id, []).get(model.id)!;
    listed.push({ provider: model.provider, cost: { input, output, cacheRead, cacheWrite, ...(tiers ? { tiers } : {}) } });
  }
  return out;
}

/** A request to price: the model it ran on ("provider/model"), and its tokens. */
export type Priced = { model?: string; usage?: Usage };

/** What `requests` cost at `catalog`'s list prices, each at its own provider's entry for its model, rounded to a
 *  millionth of a dollar: undefined when one request's tokens are unknown or its provider does not list its model (the
 *  request was served at a price no one lists here), or pi-ai is not installed. A provider's $0 entry is $0. A request of
 *  no tokens costs nothing at any price. */
export async function priceRequests(requests: readonly Priced[], catalog: Catalog): Promise<number | undefined> {
  const ai = await import("@earendil-works/pi-ai").catch(() => undefined);
  if (!ai) return undefined;
  let total = 0;
  for (const { model, usage } of requests) {
    if (!usage) return undefined;
    const { input, output, cacheRead, cacheWrite, cacheWrite1h } = usage;
    if (input + output + cacheRead + cacheWrite === 0) continue;
    const at = model?.indexOf("/") ?? -1;
    const cost = model && at > 0 ? catalog.get(model.slice(at + 1))?.find((entry) => entry.provider === model.slice(0, at))?.cost : undefined;
    if (!cost) return undefined;
    const counted = { input, output, cacheRead, cacheWrite, ...(cacheWrite1h !== undefined ? { cacheWrite1h } : {}), totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    total += ai.calculateCost({ cost } as never, counted).total;
  }
  return Math.round(total * 1e6) / 1e6;
}
