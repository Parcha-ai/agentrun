// The kernel cap on the runner's booking, for every CLI harness (claude-agent, codex, opencode: their model proxy asks the
// runner, and the runner asks the host's beforeRequest with the session's spend and its requests in flight). The decision
// is the one rule, capRule.judge, once per request (a request carrying the wrap-up's note: once without it, and once with
// it when that fits); the ledger is the runner's (its runner.request and runner.turn
// records) until the cutover binds CapMarks to those records and createCap's own ledger goes.
import type { BeforeRequest } from "../../runner.js";
import { CapRefused } from "./errors.js";
import { inputBound, pricingOf } from "./price.js";
import { capRule, isFigure } from "./rule.js";
import { SPEND_CAP_REACHED, unmeasured } from "./words.js";
import type { CapModel, ModelCapRequest } from "./types.js";

/** The cap's refusal as the runner takes it: its words, its code, and what the run's end is decided from (parkOf): for
 *  good, or for room with its figures. */
const refusalOf = (error: CapRefused) => ({ refuse: error.message, code: error.code, forGood: error.forGood, ...(error.figures ? { figures: error.figures } : {}) });

export interface BeforeRequestOptions {
  /** The run's cap, read before every request. Undefined: no cap, nothing refused. */
  capUsd(): number | undefined;
  /** A model as the cap prices it, by its id and the route its request came by (ModelRequest.route; absent, the
   *  session's own): one id two routes price apart is priced as its route books it. Undefined: a model with no price here. */
  modelOf(id: string, route?: string): CapModel | undefined;
  /** What the run spent beside the session's model requests, which the runner's booking does not hold: its priced tools'
   *  charges (null: unknown). The run's spend is the runner's plus this. A figure that is not finite and 0 or more is
   *  unknown too. */
  spentUsd?(): number | null;
  /** What the run's priced tools under way hold, beside the session's requests in flight (null: unknown). A figure that is
   *  not finite and 0 or more is unknown too: the request is refused, never judged as $0 held. */
  heldUsd?(): number | null;
  /** What the host keeps back beside model request `request` (priced as `asked`) for the steps it may still ask for while
   *  it streams (the rule's JudgeState.keepUsd): serve's wrap-up reserve for the session's own requests. Undefined: none. */
  keepBackUsd?(request: Parameters<BeforeRequest>[0], asked: ModelCapRequest): number | undefined;
}

/** A model the host has no price for: refused under a cap, by the rule. */
const unpriced = (id: string): CapModel => ({ id, api: "unknown", price: null, outputCeiling: null });

/** What prices a model request: its model and route, its input bound, the output it asks and needs at least, its fee,
 *  and whether it is a side call. */
export type PricedRequest = Pick<Parameters<BeforeRequest>[0], "model" | "route" | "inputTokensMax" | "outputTokensAsked" | "outputTokensLeast" | "feeUsd" | "side">;

/** `request` as the rule prices it: the one place a request's model is chosen for it (a CLI's request names its model as
 *  its provider does, openai/gpt-6.1-sol for gpt-6.1-sol), so its admission, the wrap-up's note and what the run keeps
 *  back to answer (requestFigures) price it alike: its whole input bound uncached. */
export function capRequestOf(id: string, request: PricedRequest, options: Pick<BeforeRequestOptions, "modelOf">): ModelCapRequest {
  const model = options.modelOf(request.model, request.route) ?? unpriced(request.model);
  return {
    kind: "model",
    id,
    model,
    inputTokens: request.inputTokensMax,
    ...(request.outputTokensAsked === undefined ? {} : { outputAsked: request.outputTokensAsked }),
    ...(request.outputTokensLeast === undefined ? {} : { outputTokensLeast: request.outputTokensLeast }),
    ...(isFigure(request.feeUsd) && request.feeUsd > 0 ? { feeUsd: request.feeUsd } : {}),
    ...(request.side ? { side: true } : {}),
  };
}

/** The host's beforeRequest for a CLI harness's session: the runner's spend and holds, judged by the one rule. */
export function beforeRequestOf(options: BeforeRequestOptions): BeforeRequest {
  return (request) => {
    const capUsd = options.capUsd();
    if (capUsd === undefined) return undefined;
    // `owed`: money already owed at the provider: booked and held, never asked of the rule; only for charges incurred
    // outside a call (a browser session's release, the time a person used). It counts in the run's spend and holds like
    // any paid step, so every refusable step after it sees it. Only a figure is money: one that is not goes to the rule.
    if (request.paid?.owed && isFigure(request.feeUsd ?? 0)) return { holdUsd: request.feeUsd ?? 0 };
    const asked = capRequestOf(`turn-${request.turn}`, request, options);
    // Each request in flight at what the host held for it, else its worst case at the limit it was admitted with; one with
    // neither (no hold, no price or no measure) cannot be kept within the cap: refused for good, as an unmeasured input.
    let inFlight = 0;
    for (const flight of request.inFlight) {
      const figure = isFigure(flight.holdUsd) ? flight.holdUsd : worstOf(options.modelOf(flight.model, flight.route), flight.inputTokensMax, flight.outputTokensMax);
      if (figure === undefined) return { refuse: unmeasured(capUsd), code: SPEND_CAP_REACHED };
      inFlight += figure;
    }
    // The run's spend and holds: the runner's (its model requests) and the host's (its priced tools).
    // $0 only with no hook: a figure that is not one (null, undefined, NaN, Infinity, below 0), the runner's or a hook's,
    // makes the run's spend or holds unknown, refused by the rule, never free and never room. Each part is checked before
    // it is summed: a positive part would hide a negative one in the sum ($1 and -$0.50 read as a valid $0.50).
    const toolSpent = options.spentUsd ? options.spentUsd() : 0;
    const spentUsd = isFigure(request.spentUsd) && isFigure(toolSpent) ? request.spentUsd + toolSpent : null;
    const toolHeld = options.heldUsd ? options.heldUsd() : 0;
    const heldUsd = isFigure(toolHeld) ? inFlight + toolHeld : null;
    // A paid tool call (a web search's request, a monid call): held at its price, by the rule's tool judgement (main's
    // paidCall), its words naming it, beside the run's spend and holds.
    if (request.paid) {
      try {
        const judged = capRule.judge({ kind: "tool", id: `turn-${request.turn}`, name: request.paid.name, holdUsd: request.feeUsd ?? 0, basis: request.paid.basis }, { capUsd, spentUsd, heldUsd });
        return { holdUsd: judged.heldUsd };
      } catch (error) {
        if (error instanceof CapRefused) return refusalOf(error);
        throw error;
      }
    }
    const judge = (input: number | undefined) => {
      try {
        const sized: ModelCapRequest = { ...asked, inputTokens: input };
        const keepUsd = options.keepBackUsd?.(request, sized);
        const judged = capRule.judge(sized, { capUsd, spentUsd, heldUsd, ...(keepUsd === undefined ? {} : { keepUsd }) });
        return { holdUsd: judged.heldUsd, ...(judged.outputTokensMax === undefined ? {} : { outputTokensMax: judged.outputTokensMax }), stoppedUsd: judged.stoppedUsd };
      } catch (error) {
        // Its words, and what the run's end is decided from (parkOf): for good, or for room with its figures.
        if (error instanceof CapRefused) return refusalOf(error);
        throw error;
      }
    };
    // A request carrying the wrap-up's note is judged as its client sent it first (inputTokensMaxWithoutNote): refused so,
    // it is refused in those words; admitted so, it goes with the note when the note's bytes fit too, and otherwise
    // without it (withoutNote), the note left for another request. The note never refuses what fits.
    if (request.noted && typeof request.inputTokensMaxWithoutNote === "number") {
      const plain = judge(request.inputTokensMaxWithoutNote);
      if ("refuse" in plain) return plain;
      const full = judge(request.inputTokensMax);
      return "refuse" in full ? { ...plain, withoutNote: true as const } : full;
    }
    return judge(request.inputTokensMax);
  };
}

/** A request in flight with no figure held for it: its input uncached and its output limit at its model's price; no price,
 *  no measure, or priced output with neither a limit nor a ceiling (as the rule's noCeiling): undefined (it cannot be
 *  counted), never 0 and never Infinity. */
function worstOf(model: CapModel | undefined, inputTokens: number | undefined, outputTokens: number | undefined): number | undefined {
  if (!model?.price || inputTokens === undefined) return undefined;
  if (outputTokens === undefined && model.outputCeiling === null && model.price.output > 0) return undefined;
  const bound = inputBound({ kind: "model", id: "", model, inputTokens });
  return pricingOf(model.price)(bound ?? inputTokens, outputTokens ?? model.outputCeiling ?? 0);
}
