// The request ceiling for free models. The dollar cap cannot stop a run whose requests cost nothing: a free model's (its
// catalog price all zeros, an OpenRouter `:free` model and the like, whose shared daily quota one looping run can burn).
// So such requests are counted across the run, and once it has made the server's limit of them (FREE_MODEL_REQUESTS,
// else the operator's), its next one is refused for good and the run ends as the dollar cap ends one it can never fit:
// failed, in the cap's code and these words. A paid request never counts toward it, and is never refused by it; nor is a
// ChatGPT plan's request (ChatGPT-plan requests don't count), nor a local model's (CapModel.local: free, with no shared
// quota to burn). The agent's own limit (definition.max_requests) counts every free request, a local model's included:
// local requests are counted apart (localRequestsIn) and added to the others there, so a run on a local model that keeps
// calling tools stops at it.
import { type BeforeRequest, RUNNER_RECORDS } from "../../runner.js";
import type { SessionRecord } from "../../types.js";
import { SPEND_CAP_REACHED } from "./words.js";
import { SERVER_NOTE_LABEL } from "./wrap-up.js";
import type { CapModel, ModelPrice } from "./types.js";

/** The requests on a free model a run may make by default. */
export const FREE_MODEL_REQUESTS = 60;

/** OpenRouter's routers, each of which picks a model per request: OpenRouter prices them at the routed model's price,
 *  which pi-ai's catalog writes as $0, so their zeros are no price and none is free. The one list: serve's
 *  local-models.ts isRouter reads it. */
export const ROUTERS: ReadonlySet<string> = new Set(["auto", "openrouter/auto", "openrouter/auto-beta", "openrouter/auto-code", "openrouter/free", "openrouter/fusion", "openrouter/pareto-code", "typesafe/jev-router"]);

const zero = (rates: { input: number; output: number; cacheRead?: number; cacheWrite?: number }): boolean =>
  rates.input === 0 && rates.output === 0 && (rates.cacheRead ?? 0) === 0 && (rates.cacheWrite ?? 0) === 0;

/** Whether `model` is a free model: one whose known price is $0 for every token, each tier's included. A model with no
 *  price (null), or none at all, is no free model: unknown, the dollar cap's to refuse; nor is an OpenRouter router
 *  (ROUTERS), whatever its catalog price; nor a ChatGPT plan's (CapModel.plan), whatever its listing. The one rule: serve's
 *  local-models.ts isFree, the model picker's free mark, reads it on the catalog entry's price. */
export function freeModel(model: CapModel | undefined): boolean {
  if (!model || model.plan || ROUTERS.has(model.id)) return false;
  const price: ModelPrice | null = model.price;
  return !!price && zero(price) && (price.tiers ?? []).every(zero);
}

/** Whether `request` is on a free model (freeModel, as `modelOf` prices it): never one with a fee beside it (a native
 *  web search's) or a paid step's charge, which cost dollars, nor one named by a router. What the runner books at a known
 *  $0 (Admitted.free); the run's limit counts those of them that limitedFree says. */
export function freeRequest(request: Parameters<BeforeRequest>[0], modelOf: (id: string, route?: string) => CapModel | undefined): boolean {
  if (request.paid || (request.feeUsd ?? 0) !== 0 || ROUTERS.has(request.model)) return false;
  return freeModel(modelOf(request.model, request.route));
}

/** Whether a free request on `model` counts toward the server's free-model limit: a free model's (freeModel), but a local
 *  one's (CapModel.local) never. The one rule for that limit's count and its wrap-up note. The agent's own limit counts a
 *  local one as well (run-cap.ts). */
export function limitedFree(model: CapModel | undefined): boolean {
  return freeModel(model) && !model?.local;
}

/** A ChatGPT plan's model as the cap prices it, on every harness alike (pi's route and a CLI's model proxy): billed to the
 *  plan, so no price here (never its $0 listing, never an unknown price) and the plan's mark (CapModel.plan). */
export function planCapModel(id: string, api: string, outputCeiling: number | null): CapModel {
  return { id, api, price: null, outputCeiling, plan: true };
}

/** The requests before its limit at which a run on a free model is told to finish (told on the request that has this many
 *  left, itself included). 3: enough for the model to read the note, answer and tidy up once, few enough that a normal
 *  run never sees it. */
export const FREE_WRAP_UP_MARGIN = 3;

/** Whether a run that has made `made` counted requests, under `limit`, is due its wrap-up on its next one: at most
 *  FREE_WRAP_UP_MARGIN requests left, that next one included. Returns how many are left. */
export function freeWrapUpDue(limit: number, made: number): { left: number } | undefined {
  const left = limit - made;
  return left >= 1 && left <= FREE_WRAP_UP_MARGIN ? { left } : undefined;
}

/** The free limit a run's next request on `model` is nearest, and what counts toward it: the agent's own (`own`,
 *  max_requests) over its free and local requests together, and on a free model with a quota behind it (limitedFree) the
 *  run's free limit (`server`) over its free requests alone; of the two, the one with fewer requests left. Undefined where
 *  none applies: a paid model, a router, a plan's, or a local model with no limit of the agent's. */
export function freeLimitNearest(model: CapModel | undefined, limits: { own?: number; server?: number }, made: { free: number; local: number }): { limit: number; made: number } | undefined {
  const local = freeModel(model) && model?.local === true;
  const counted = limitedFree(model);
  const each = [
    ...(limits.own !== undefined && (local || counted) ? [{ limit: limits.own, made: made.free + made.local }] : []),
    ...(limits.server !== undefined && counted ? [{ limit: limits.server, made: made.free }] : []),
  ];
  return each.reduce<{ limit: number; made: number } | undefined>((near, one) => (near === undefined || one.limit - one.made < near.limit - near.made ? one : near), undefined);
}

/** The note's words, once per run and limit (the dollar cap's wrap-up note carries them, the same mechanism). */
export const freeWrapUpWords = (left: number): string => `${SERVER_NOTE_LABEL}${left} free-model request${left === 1 ? "" : "s"} left in this run, this one included: finish now with your answer.`;

/** The requests counted toward the free limit that `records` (a session's runner records) hold: each runner.request marked
 *  `freeRequest`, answered, in flight or cut. The one count, runBooking's and the wrap-up's. */
export const freeRequestsIn = (records: readonly SessionRecord[]): number =>
  records.filter((r) => r.kind === RUNNER_RECORDS.request && (r.data as { freeRequest?: unknown } | undefined)?.freeRequest === true).length;

/** The requests on local models that `records` hold (each runner.request marked `localRequest`), counted as
 *  freeRequestsIn counts the others: the agent's own limit adds them. */
export const localRequestsIn = (records: readonly SessionRecord[]): number =>
  records.filter((r) => r.kind === RUNNER_RECORDS.request && (r.data as { localRequest?: unknown } | undefined)?.localRequest === true).length;

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

/** A run's limit on its requests on free models: the server's (freeModelRequestsOf), or the agent's own when it is lower
 *  (definition.max_requests, its revision's `maxRequests`, a whole number above 0). The server's always holds: an agent's
 *  higher one gets the server's. */
export function freeRequestLimitOf(env: Record<string, string | undefined>, maxRequests?: unknown): number {
  const server = freeModelRequestsOf(env);
  const own = maxRequestsOf(maxRequests);
  return own === undefined ? server : Math.min(own, server);
}

/** The agent's own limit (definition.max_requests, a whole number above 0), else undefined: the limit a run's requests on
 *  local models stop at, counted with its other free requests (RunCapOptions.maxRequests). */
export const maxRequestsOf = (maxRequests: unknown): number | undefined =>
  typeof maxRequests === "number" && Number.isSafeInteger(maxRequests) && maxRequests >= 1 ? maxRequests : undefined;
