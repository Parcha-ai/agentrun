// The kernel cap on the runner's booking, for every CLI harness (claude-agent, codex, opencode: their model proxy asks the
// runner, and the runner asks the host's beforeRequest with the session's spend and its requests in flight). The decision
// is the one rule, capRule.judge, once per request (a request carrying the wrap-up's note: once without it, and once with
// it when that fits); the ledger is the runner's (its runner.request and runner.turn
// records) until the cutover binds CapMarks to those records and createCap's own ledger goes.
import type { BeforeRequest } from "../../runner.js";
import { CapRefused } from "./errors.js";
import { inputBound, pricingOf } from "./price.js";
import { capRule, isFigure } from "./rule.js";
import { unmeasured } from "./words.js";
import type { CapMode, CapModel, ModelCapRequest, Previous } from "./types.js";

export interface BeforeRequestOptions {
  /** The run's cap, read before every request. Undefined: no cap, nothing refused. */
  capUsd(): number | undefined;
  /** A model as the cap prices it, by its id; undefined: a model with no price here. */
  modelOf(id: string): CapModel | undefined;
  /** The session's previous request on a model, as its usage reported it: none prices the input uncached. */
  previousOf?(model: string): Previous | undefined;
  /** What the run spent beside the session's model requests, which the runner's booking does not hold: its priced tools'
   *  charges (null: unknown). The run's spend is the runner's plus this. A figure that is not finite and 0 or more is
   *  unknown too. */
  spentUsd?(): number | null;
  /** What the run's priced tools under way hold, beside the session's requests in flight (null: unknown). A figure that is
   *  not finite and 0 or more is unknown too: the request is refused, never judged as $0 held. */
  heldUsd?(): number | null;
  mode?: CapMode;
  now?: () => number;
}

/** A model the host has no price for: refused under a cap, by the rule. */
const unpriced = (id: string): CapModel => ({ id, api: "unknown", price: null, outputCeiling: null });

/** The host's beforeRequest for a CLI harness's session: the runner's spend and holds, judged by the one rule. */
export function beforeRequestOf(options: BeforeRequestOptions): BeforeRequest {
  const mode = options.mode ?? "expected";
  const now = options.now ?? Date.now;
  return (request) => {
    const capUsd = options.capUsd();
    if (capUsd === undefined) return undefined;
    const model = options.modelOf(request.model) ?? unpriced(request.model);
    // A request the host sends beside the harness's own (its host label: a learned workflow's node) is another
    // conversation's prompt: nothing of the session's cache is read for it, so it is priced as a cache miss.
    const previous = request.host === undefined ? options.previousOf?.(request.model) : undefined;
    const asked: ModelCapRequest = {
      kind: "model",
      id: `turn-${request.turn}`,
      model,
      inputTokens: request.inputTokensMax,
      ...(request.outputTokensAsked === undefined ? {} : { outputAsked: request.outputTokensAsked }),
      ...(request.outputTokensLeast === undefined ? {} : { outputTokensLeast: request.outputTokensLeast }),
      ...(previous ? { previous } : {}),
      ...(request.side ? { side: true } : {}),
    };
    // Each request in flight at what the host held for it, else its worst case at the limit it was admitted with; one with
    // neither (no hold, no price or no measure) cannot be kept within the cap: refused for good, as an unmeasured input.
    let inFlight = 0;
    for (const flight of request.inFlight) {
      const figure = isFigure(flight.holdUsd) ? flight.holdUsd : worstOf(options.modelOf(flight.model), flight.inputTokensMax, flight.outputTokensMax);
      if (figure === undefined) return { refuse: unmeasured(capUsd) };
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
    const judge = (input: number | undefined) => {
      try {
        const judged = capRule.judge({ ...asked, inputTokens: input }, { capUsd, spentUsd, heldUsd, mode, now: now() });
        return { holdUsd: judged.heldUsd, boundUsd: judged.boundUsd, ...(judged.outputTokensMax === undefined ? {} : { outputTokensMax: judged.outputTokensMax }), stoppedUsd: judged.stoppedUsd };
      } catch (error) {
        // Its words, and what the run's end is decided from (parkOf): for good, or for room with its figures.
        if (error instanceof CapRefused) return { refuse: error.message, forGood: error.forGood, ...(error.figures ? { figures: error.figures } : {}) };
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
  return pricingOf(model.price)({ cached: 0, fresh: bound ?? inputTokens }, outputTokens ?? model.outputCeiling ?? 0);
}
