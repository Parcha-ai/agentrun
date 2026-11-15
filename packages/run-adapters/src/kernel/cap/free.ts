// The request ceiling for requests priced $0. The dollar cap cannot stop a run whose requests cost nothing: a free model's
// (its catalog price all zeros) or a ChatGPT plan's (CapModel.plan, billed to the plan). So such requests are counted
// across the run, and once it has made the server's limit of them (FREE_MODEL_REQUESTS, else the operator's), its next one
// is refused for good and the run ends as the dollar cap ends one it can never fit: failed, in the cap's code and these
// words. A paid request never counts toward it, and is never refused by it.
import type { BeforeRequest, ZeroPriced } from "../../runner.js";
import { SPEND_CAP_REACHED } from "./words.js";
import type { CapModel, ModelPrice } from "./types.js";

export type { ZeroPriced };

/** The requests on a $0-priced model a run may make by default. */
export const FREE_MODEL_REQUESTS = 60;

/** OpenRouter's routers, each of which picks a model per request: OpenRouter prices them at the routed model's price,
 *  which pi-ai's catalog writes as $0, so their zeros are no price and none is free. The same list as serve's
 *  local-models.ts ROUTERS. */
const ROUTERS: ReadonlySet<string> = new Set(["auto", "openrouter/auto", "openrouter/auto-beta", "openrouter/auto-code", "openrouter/free", "openrouter/fusion", "openrouter/pareto-code", "typesafe/jev-router"]);

const zero = (rates: { input: number; output: number; cacheRead?: number; cacheWrite?: number }): boolean =>
  rates.input === 0 && rates.output === 0 && (rates.cacheRead ?? 0) === 0 && (rates.cacheWrite ?? 0) === 0;

/** Whether a request on `model` is priced $0, and why: a plan's model, or a free model, one whose known price is $0 for
 *  every token, each tier's included. A model with no price (null), or none at all, is no $0 price: unknown, the dollar
 *  cap's to refuse; nor is an OpenRouter router (ROUTERS), whatever its catalog price. */
export function zeroPricedOf(model: CapModel | undefined): ZeroPriced | undefined {
  if (!model) return undefined;
  if (model.plan) return "plan";
  if (ROUTERS.has(model.id)) return undefined;
  const price: ModelPrice | null = model.price;
  if (!price) return undefined;
  return zero(price) && (price.tiers ?? []).every(zero) ? "free" : undefined;
}

/** Whether `request` is priced $0, and why (zeroPricedOf its model, as `modelOf` prices it): never one with a fee beside
 *  it (a native web search's) or a paid step's charge, which cost dollars, nor one named by a router. The one rule for
 *  both what the runner books at a known $0 (a free model's: Admitted.free) and what the run's limit counts. */
export function zeroPricedRequestOf(request: Parameters<BeforeRequest>[0], modelOf: (id: string, route?: string) => CapModel | undefined): ZeroPriced | undefined {
  if (request.paid || (request.feeUsd ?? 0) !== 0 || ROUTERS.has(request.model)) return undefined;
  return zeroPricedOf(modelOf(request.model, request.route));
}

/** A ChatGPT plan's model as the cap prices it, on every harness alike (pi's route and a CLI's model proxy): billed to the
 *  plan, so no price here (never its $0 listing, never an unknown price) and the plan's mark (CapModel.plan). */
export function planCapModel(id: string, api: string, outputCeiling: number | null): CapModel {
  return { id, api, price: null, outputCeiling, plan: true };
}

/** The words a run ends in once it has made `limit` requests priced $0: the dollar cap's code, then why. */
export const freeCeilingEnd = (limit: number): string => `${SPEND_CAP_REACHED}: Not sent: this run reached its ${limit}-request limit for free models.`;

const FREE_CEILING = new RegExp(`^${SPEND_CAP_REACHED}: (Not sent: this run reached its \\d+-request limit for free models\\.)$`);
/** The message of a run's end in freeCeilingEnd's words: what follows its code; undefined for any other summary. */
export const freeCeilingMessage = (summary: string | null | undefined): string | undefined =>
  typeof summary === "string" ? FREE_CEILING.exec(summary)?.[1] : undefined;

/** The limit an environment sets (`AGENTRUN_FREE_MODEL_REQUESTS`, a whole number above 0), else FREE_MODEL_REQUESTS. A value
 *  that is no such number is refused, loudly: a limit read as none would let a free run loop for ever. */
export const FREE_MODEL_REQUESTS_ENV = "AGENTRUN_FREE_MODEL_REQUESTS";
export function freeModelRequestsOf(env: Record<string, string | undefined>): number {
  const given = env[FREE_MODEL_REQUESTS_ENV];
  if (given === undefined || given.trim() === "") return FREE_MODEL_REQUESTS;
  const value = Number(given);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${FREE_MODEL_REQUESTS_ENV} is a whole number of requests above 0, not ${given}`);
  return value;
}
