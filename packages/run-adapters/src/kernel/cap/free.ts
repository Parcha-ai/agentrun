// The request ceiling for free models. The dollar cap cannot stop a run whose requests cost nothing: a free model's (its
// catalog price all zeros, an OpenRouter `:free` model and the like, whose shared daily quota one looping run can burn).
// So such requests are counted across the run, and once it has made the server's limit of them (FREE_MODEL_REQUESTS,
// else the operator's), its next one is refused for good and the run ends as the dollar cap ends one it can never fit:
// failed, in the cap's code and these words. A paid request never counts toward it, and is never refused by it; nor is a
// ChatGPT plan's request (ChatGPT-plan requests don't count).
import type { BeforeRequest } from "../../runner.js";
import { SPEND_CAP_REACHED } from "./words.js";
import type { CapModel, ModelPrice } from "./types.js";

/** The requests on a free model a run may make by default. */
export const FREE_MODEL_REQUESTS = 60;

/** OpenRouter's routers, each of which picks a model per request: OpenRouter prices them at the routed model's price,
 *  which pi-ai's catalog writes as $0, so their zeros are no price and none is free. The same list as serve's
 *  local-models.ts ROUTERS. */
const ROUTERS: ReadonlySet<string> = new Set(["auto", "openrouter/auto", "openrouter/auto-beta", "openrouter/auto-code", "openrouter/free", "openrouter/fusion", "openrouter/pareto-code", "typesafe/jev-router"]);

const zero = (rates: { input: number; output: number; cacheRead?: number; cacheWrite?: number }): boolean =>
  rates.input === 0 && rates.output === 0 && (rates.cacheRead ?? 0) === 0 && (rates.cacheWrite ?? 0) === 0;

/** Whether `model` is a free model: one whose known price is $0 for every token, each tier's included. A model with no
 *  price (null), or none at all, is no free model: unknown, the dollar cap's to refuse; nor is an OpenRouter router
 *  (ROUTERS), whatever its catalog price; nor a ChatGPT plan's (CapModel.plan), whatever its listing. */
export function freeModel(model: CapModel | undefined): boolean {
  if (!model || model.plan || ROUTERS.has(model.id)) return false;
  const price: ModelPrice | null = model.price;
  return !!price && zero(price) && (price.tiers ?? []).every(zero);
}

/** Whether `request` is on a free model (freeModel, as `modelOf` prices it): never one with a fee beside it (a native
 *  web search's) or a paid step's charge, which cost dollars, nor one named by a router. The one rule for both what the
 *  runner books at a known $0 (Admitted.free) and what the run's limit counts. */
export function freeRequest(request: Parameters<BeforeRequest>[0], modelOf: (id: string, route?: string) => CapModel | undefined): boolean {
  if (request.paid || (request.feeUsd ?? 0) !== 0 || ROUTERS.has(request.model)) return false;
  return freeModel(modelOf(request.model, request.route));
}

/** A ChatGPT plan's model as the cap prices it, on every harness alike (pi's route and a CLI's model proxy): billed to the
 *  plan, so no price here (never its $0 listing, never an unknown price) and the plan's mark (CapModel.plan). */
export function planCapModel(id: string, api: string, outputCeiling: number | null): CapModel {
  return { id, api, price: null, outputCeiling, plan: true };
}

/** The words a run ends in once it has made `limit` requests on free models: the dollar cap's code, then why. */
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
