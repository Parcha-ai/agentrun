// The runner's model route: where a model's requests go, on which id, at what price. This first form resolves the
// model as main does and goes to its provider's catalog origin with its base rates: no tiers, and no fetch of its own,
// so a faux model's requests fall through to the network.
import { chooseModel, DEFAULT_MODEL_ENV, runModels, type Tier } from "../model.js";

/** What a request on a model costs, USD per million tokens, as pi-ai's catalog lists it (tiers included). */
export type RouteCost = { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number; readonly tiers?: readonly { readonly inputTokensAbove: number; readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number }[] };

/** Where a model's requests go: Anthropic's Messages API at `origin` (the shape the kernel's model proxy forwards), for
 *  `model`, priced by `price`; `fetch`, the route's own upstream when its model does not speak Messages. */
export interface ModelRoute {
  readonly provider: { readonly api: "anthropic-messages"; readonly origin: string; readonly credential: () => string | Promise<string>; readonly headers?: Readonly<Record<string, string>> };
  readonly model: string;
  /** A request's price from its usage (the proxy's booking reads it). */
  readonly price?: (model: string, usage: { input: number; output: number; cacheRead: number; cacheWrite: number }) => number | null;
  /** The upstream fetch: the route's own, for a model that does not speak Messages (a test's scripted origin too). */
  readonly fetch?: typeof fetch;
  /** The catalog's cost of the model, tiers included: what the cap prices a request at before it leaves. */
  readonly cost?: RouteCost;
}

export async function routeOf(model: string | undefined, env: NodeJS.ProcessEnv = process.env, tier: Tier = "default"): Promise<ModelRoute> {
  const chosen = await chooseModel(env, model, tier);
  if ("why" in chosen) throw new Error(chosen.why);
  void DEFAULT_MODEL_ENV;
  const { models } = await runModels(env, model, [tier]);
  const target = models.getModel(chosen.model.provider, chosen.model.modelId) as { baseUrl?: string; cost: RouteCost } | undefined;
  if (!target) throw new Error(`no model ${chosen.model.provider}/${chosen.model.modelId} here`);
  const base = target.cost;
  return {
    provider: { api: "anthropic-messages", origin: target.baseUrl ?? "", credential: () => env.ANTHROPIC_API_KEY ?? "" },
    model: chosen.model.modelId,
    price: (_model, usage) => (usage.input * base.input + usage.output * base.output + usage.cacheRead * base.cacheRead + usage.cacheWrite * base.cacheWrite) / 1e6,
    cost: base,
  };
}
