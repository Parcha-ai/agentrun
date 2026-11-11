// A workflow decision's price under its run's spend cap, as the runner's decision cap holds it (runner/workflow-spec.ts,
// admitted and settled through the kernel cap once the DSL driver has admitted the request), and the checks around it.
// The hold, per request, with its input bound one token per UTF-8 byte of its state and questions (cap.ts inputBound's
// rule) and DECISION_IMAGE_TOKENS for each image:
//   - Parallel: its list price for one request (PARALLEL_LIST_PRICE_USD), which is what it is booked at.
//   - Jev: TypeSafe's published price (JEV_PUBLISHED_PRICING) for its input; its output is free.
//   - OpenRouter's Decisions models: the catalog's price (openrouter.ts priceOf): per request, per image, per input token,
//     and per output token for DECISION_OUTPUT_TOKENS a question (expected), or the catalog's most output (strict: none
//     listed and its output priced is no bound, and is not sent). A model the catalog does not price is not sent. A
//     catalog that cannot be read is read again (CATALOG_TRIES); one still down fails the request unsent, as a connection
//     error (DecisionProviderError "connection"), and the decision node fails (decision nodes have no attempts loop):
//     never a refusal of the cap, which would end the run spend_cap_reached.
import type { DecisionProvider, WorkflowDeps } from "@parcha/agentrun-dsl";
import { DecisionProviderError } from "@parcha/agentrun-dsl";
import type { DecisionModelPrice } from "@parcha/agentrun-decisions";
import { type CapMode, money } from "./cap.js";

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

/** How many times a decision's price is read from OpenRouter's catalog before its request fails unsent, and the waits
 *  between the reads, in ms. */
export const CATALOG_TRIES = 3;
const CATALOG_RETRY_MS = [500, 1_500];

/** `model`'s price from `priced`'s catalog, read up to CATALOG_TRIES times: a catalog still down then fails the request
 *  unsent, as a connection error (DecisionProviderError "connection"), and the decision node fails (decision nodes have
 *  no attempts loop), as on any provider's outage: never a CapStop. */
export async function catalogPrice(priced: { priceOf(model: string): Promise<DecisionModelPrice | null> }, model: string, signal: AbortSignal | undefined): Promise<DecisionModelPrice | null> {
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
