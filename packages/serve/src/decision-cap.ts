// A workflow run's decisions under its spend cap: each request is held, before it is admitted, at what it may cost, by
// paidCall's rule (cap.ts holdPaid), and settled at what it charged once it answers. Two halves, around the durable
// driver's admission of the request (dsl withRecovery: the request is committed before the judge is asked, and one
// asked and never answered is never asked again):
//   - `before` (outside the admission): prices the request (holdOf), takes its hold, and waits for a raise when the cap
//     has no room for it (RunSpend.wait), so a wait is never a request admitted and unanswered. A request with no price
//     under a cap is not sent: the run stops (budget.ts CapStop).
//   - `settling` (the judge itself, inside the admission): asks the provider and settles the hold at the cost the answer
//     reports, at the hold when it reports none or the request failed after it may have been sent (chargedCost), and lets
//     it go when nothing was sent. What it counted is booked in the run's store as a DECISION_COST entry, which a later
//     process reads back (cap.ts decisionSpentIn), so the cap counts every decision once, across a resume.
// The hold, per request, with its input bound one token per UTF-8 byte of its state and questions (cap.ts inputBound's
// rule) and DECISION_IMAGE_TOKENS for each image:
//   - Parallel: its list price for one request (PARALLEL_LIST_PRICE_USD), which is what it is booked at.
//   - Jev: TypeSafe's published price (JEV_PUBLISHED_PRICING) for its input; its output is free.
//   - OpenRouter's Decisions models: the catalog's price (openrouter.ts priceOf): per request, per image, per input token,
//     and per output token for DECISION_OUTPUT_TOKENS a question (expected), or the catalog's most output (strict: none
//     listed and its output priced is no bound, and is not sent). A model the catalog does not price is not sent. A
//     catalog that cannot be read is read again (CATALOG_TRIES); one still down fails the request unsent, as a connection
//     error the node's own attempts take, never as a refusal of the cap, which would end the run.
import type { DecisionProvider, WorkflowDeps } from "@parcha/agentrun-dsl";
import { chargedCost, DecisionProviderError } from "@parcha/agentrun-dsl";
import type { DecisionModelPrice } from "@parcha/agentrun-decisions";
import { type CapMode, type CapRefusal, holdPaid, money, type PaidTicket, runCap } from "./cap.js";
import type { BudgetWaits, StepAt } from "./budget.js";

type RunJudge = NonNullable<WorkflowDeps["runJudge"]>;
type JudgeParams = Parameters<RunJudge>[0];

/** An image's input allowance, in tokens: what a 1568 px square (Jev's longest side) reads as at 750 pixels a token. */
export const DECISION_IMAGE_TOKENS = 3_300;
/** The output an answer is expected to take, per question, where a Decisions model prices its output (expected mode). */
export const DECISION_OUTPUT_TOKENS = 256;
/** TypeSafe's published price for Jev, per input token (USD; JEV_PUBLISHED_PRICING, $0.042 a million). */
export const JEV_INPUT_USD = 0.042 / 1e6;
/** Parallel's list price for one decision request (USD; PARALLEL_LIST_PRICE_USD). */
export const PARALLEL_DECISION_USD = 0.001;

/** A provider's failures that say the request was never billed: refused before it was sent, or by the provider unbilled. */
const UNBILLED = new Set(["configuration", "auth", "invalid_request", "rate_limited", "connection"]);
const unbilled = (error: unknown): boolean => error instanceof DecisionProviderError && (error.unsent === true || UNBILLED.has(error.code));
/** How a provider is named in a refusal's words. */
const providerName = (provider: DecisionProvider, model: string | undefined): string =>
  provider.id === "openrouter" ? (model ?? "OpenRouter") : provider.id === "jev" ? "Jev" : provider.id === "parallel" ? "Parallel" : provider.id;

/** How many times a decision's price is read from OpenRouter's catalog before its request fails unsent, and the waits
 *  between the reads, in ms. */
export const CATALOG_TRIES = 3;
const CATALOG_RETRY_MS = [500, 1_500];

/** `model`'s price from `priced`'s catalog, read up to CATALOG_TRIES times: a catalog still down then fails the request
 *  as a connection error, unsent (DecisionProviderError), which the node's attempts take as any provider's outage. */
async function catalogPrice(priced: { priceOf(model: string): Promise<DecisionModelPrice | null> }, model: string, signal: AbortSignal | undefined): Promise<DecisionModelPrice | null> {
  for (let tries = 1; ; tries += 1) {
    try {
      return await priced.priceOf(model);
    } catch (cause) {
      if (tries >= CATALOG_TRIES || signal?.aborted) {
        throw new DecisionProviderError("connection", `OpenRouter's catalog could not be read, so the price of ${model} is not known and its decision was not sent. Try again once the catalog answers.`, { attempts: tries, unsent: true, cause });
      }
      const ms = CATALOG_RETRY_MS[tries - 1] ?? CATALOG_RETRY_MS.at(-1)!;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, ms);
        function done() { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); }
        signal?.addEventListener("abort", done, { once: true });
      });
    }
  }
}

/** Whether the durable driver answers `params`'s request from what it holds, sending nothing, so the request holds and
 *  waits for nothing: a route it decided, or a request an earlier process admitted that did not fail (asked and never
 *  answered: the driver escalates it unsent, dsl with-recovery). */
export const askedBefore = (driver: { routeDecision(executionPath: never): unknown; decisionRequests(): Record<string, { status: string }> }, params: JudgeParams): boolean => {
  if (params.kind === "route" && driver.routeDecision(params.executionPath as never) !== undefined) return true;
  const asked = params.decisionId === undefined ? undefined : driver.decisionRequests()[params.decisionId];
  return asked !== undefined && asked.status !== "failed";
};

/** A request's hold, or why it has none (its words, no raise sends it). */
export type DecisionHold = { usd: number; basis: string } | { unpriced: string };

/** The bytes of what a request sends: its state and questions as JSON, one token a byte. */
const inputOf = (params: JudgeParams): { tokens: number; images: number } => {
  const images = Object.keys(params.images ?? {}).length;
  return { tokens: Buffer.byteLength(JSON.stringify({ state: params.state ?? null, questions: params.questions }), "utf8") + images * DECISION_IMAGE_TOKENS, images };
};

/** The hold of `params`'s request to `provider`, under a cap of mode `mode`. */
export async function holdOf(provider: DecisionProvider, params: JudgeParams, mode: CapMode): Promise<DecisionHold> {
  const { tokens, images } = inputOf(params);
  if (provider.id === "parallel") return { usd: PARALLEL_DECISION_USD, basis: "Parallel's list price for one decision request" };
  if (provider.id === "jev") return { usd: tokens * JEV_INPUT_USD, basis: `TypeSafe's published price for Jev, ${money(JEV_INPUT_USD * 1e6)} a million input tokens, for ${tokens} tokens at most` };
  const priced = provider as DecisionProvider & { priceOf?(model: string): Promise<DecisionModelPrice | null> };
  const model = params.model;
  // A request that names no model is refused by its provider before it is sent: nothing to hold.
  if (typeof priced.priceOf === "function" && model === undefined) return { usd: 0, basis: "no request is sent without a model" };
  // A catalog that cannot be read gives no price: read again, then the request fails unsent (catalogPrice).
  const price = typeof priced.priceOf === "function" && model !== undefined ? await catalogPrice(priced as { priceOf(model: string): Promise<DecisionModelPrice | null> }, model, params.signal) : null;
  if (!price) return { unpriced: `${model ?? provider.id} has no price here` };
  const questions = Object.keys(params.questions).length;
  const output = mode === "strict" ? price.maxCompletionTokens : questions * DECISION_OUTPUT_TOKENS;
  if (output === null && price.completionUsd > 0) return { unpriced: `${model} names no most output and its output is priced, so what a request may cost has no bound` };
  const usd = price.requestUsd + price.imageUsd * images + price.promptUsd * tokens + price.completionUsd * (output ?? 0);
  return { usd, basis: `${model}'s price in OpenRouter's catalog, for ${tokens} input tokens${price.completionUsd > 0 ? ` and ${output} output tokens` : ""} at most` };
}

/** The two halves of a workflow's capped decisions, over `providers` (the run's, decisions.ts), the run's `waits`
 *  (budget.ts) and `book`, which writes a DECISION_COST entry to the run's store. */
export function cappedDecisions({ providers, waits, mode, book }: {
  providers: { providers: Readonly<Record<string, DecisionProvider>>; default: string };
  waits: BudgetWaits;
  mode: CapMode;
  book: (data: { call: string; usd: number }) => Promise<void>;
}) {
  /** Each request's hold, taken by `before` and settled by `settling`, by the params object both are handed. */
  const tickets = new WeakMap<object, { ticket: PaidTicket; usd: number; call: string }>();
  const stepOf = (params: JudgeParams): StepAt => ({ label: params.label, path: params.executionPath ?? null });
  return {
    /** Before the admission: the hold taken, or a wait for a raise, or the run stopped. `replayed` says whether the
     *  driver answers this request from what it decided before (a route's), which sends nothing and holds nothing. */
    before(next: RunJudge, replayed: (params: JudgeParams) => boolean): RunJudge {
      return async (params) => {
        const cap = runCap();
        if (cap === undefined || replayed(params)) return next(params);
        const id = params.provider ?? providers.default;
        const provider = Object.hasOwn(providers.providers, id) ? providers.providers[id] : undefined;
        // A provider the host lacks is refused by the judge as configuration, before anything is sent.
        if (!provider) return next(params);
        const name = `${params.label}'s decision on ${providerName(provider, params.model)}`;
        const hold = await holdOf(provider, params, mode);
        if ("unpriced" in hold) {
          const refusal: CapRefusal = { words: `Not sent: ${name}: ${hold.unpriced}, so the run's cap of ${money(cap)} cannot be kept: the run is out of budget.`, room: false, capUsd: cap };
          return waits.stop(refusal, stepOf(params));
        }
        const held = await holdPaid(name, hold, params.signal);
        if ("refused" in held) {
          if (held.refused.room) throw params.signal?.reason ?? new Error(`${name} was not sent: its wait for a raise ended`);
          return waits.stop(held.refused, stepOf(params));
        }
        const call = `${params.label}@${params.executionPath ?? ""}${params.item ? `#${params.item.index}` : ""}`;
        tickets.set(params, { ticket: held.ticket, usd: hold.usd, call });
        try {
          return await next(params);
        } finally {
          // A request the driver answered without asking (one asked by an earlier process escalates) sent nothing.
          held.ticket.drop();
        }
      };
    },
    /** The judge itself: asks, and settles the request's hold at what it charged. */
    settling(judge: RunJudge): RunJudge {
      return async (params) => {
        const held = tickets.get(params);
        if (!held) return judge(params);
        const settle = async (usd: number | null) => {
          held.ticket.settle(usd);
          await book({ call: held.call, usd: usd ?? held.usd }).catch(() => undefined);
        };
        try {
          const result = await judge(params);
          await settle(typeof result.cost_usd === "number" && Number.isFinite(result.cost_usd) ? result.cost_usd : null);
          return result;
        } catch (error) {
          // Sent and maybe billed (its outcome lost, its answer refused, cut in flight): at what it was charged, else at its
          // hold. One that failed before it was sent, or that its provider refused unbilled, charged nothing.
          const charged = chargedCost(error);
          if (charged !== undefined) await settle(charged);
          else if (!unbilled(error)) await settle(null);
          throw error;
        }
      };
    },
  };
}
