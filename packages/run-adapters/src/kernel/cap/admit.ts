// cap.admit, the one door every paid step goes through, on every harness: before each one, what the run has spent, plus
// what its steps under way are held at, plus what this step needs at the least, must stay within the cap, read before
// every check so a raise holds from the next paid step. A model request is limited to the output what is left buys and
// held at that; a paid call is held at its quote or allowance. What cannot be kept within a cap (an unknown spend, a model
// with no price, a priced model with no output ceiling, an input not measured) is refused for good under one; with no cap
// nothing is refused.
import { inputBound, mostOutput, outputAsked, outputLeast, pricingOf, requestPrice, STOP_ALLOWANCE_TOKENS, thinkingWithin } from "./price.js";
import { Ledger } from "./ledger.js";
import { noCeiling, noPrice, paidRefusal, roomRefusal, unknownSpend, unmeasured } from "./words.js";
import type { Admission, Cap, CapMode, CapOptions, CapRequest, ModelCapRequest, RefusalFigures, Settled, ToolCapRequest } from "./types.js";

/** The cap's refusal: `forGood` when no raise could send the step (the run fails, never parks), else a refusal for room
 *  with its figures (the run parks, offered the raise its words name). */
export class CapRefused extends Error {
  readonly code = "spend_cap_reached";
  readonly forGood: boolean;
  readonly spentUsd: number | null;
  readonly figures?: RefusalFigures;
  constructor(message: string, { forGood, spentUsd, figures }: { forGood: boolean; spentUsd: number | null; figures?: RefusalFigures }) {
    super(message);
    this.name = "CapRefused";
    this.forGood = forGood;
    this.spentUsd = spentUsd;
    if (figures) this.figures = figures;
  }
}

const NO_HOLD = (id: string): Admission => ({ id, heldUsd: 0, boundUsd: 0, worstUsd: 0, stoppedUsd: () => 0 });

export function createCap(options: CapOptions): Cap {
  const mode: CapMode = options.mode ?? "expected";
  const now = options.now ?? Date.now;
  const ledger = new Ledger(options.spentUsd === undefined ? 0 : options.spentUsd);

  /** A model request priced: its bound, the output it asks and needs at least, and its cost and worst case at an output. */
  const priced = (request: ModelCapRequest) => {
    const bound = inputBound(request);
    const price = request.model.price;
    if (bound === undefined || price === null) return undefined;
    const asked = outputAsked(request);
    const { cost, worst } = requestPrice(pricingOf(price), bound, request.previous, now(), mode, request.model.id, request.feeUsd ?? 0);
    return { bound, asked, cost, worst, least: asked === undefined ? 0 : outputLeast(request, asked) };
  };

  const admitModel = (request: ModelCapRequest, capUsd: number, spent: number): Admission => {
    const held = ledger.held();
    if (inputBound(request) === undefined) throw new CapRefused(unmeasured(capUsd), { forGood: true, spentUsd: spent });
    const price = request.model.price;
    if (price === null) throw new CapRefused(noPrice(capUsd), { forGood: true, spentUsd: spent });
    if (request.model.outputCeiling === null && price.output > 0) throw new CapRefused(noCeiling(capUsd), { forGood: true, spentUsd: spent });
    const p = priced(request)!;
    const asked = p.asked ?? 0;
    const output = mostOutput(p.cost, p.least, asked, capUsd - spent - held);
    if (output === undefined) {
      const { text, figures } = roomRefusal(capUsd, spent, held, p.cost(p.least), p.worst(p.least) - p.cost(p.least));
      throw new CapRefused(text, { forGood: false, spentUsd: spent, figures });
    }
    const heldUsd = p.cost(output);
    const worstUsd = p.worst(output);
    const stoppedPrice = (streamed: number) => p.cost(Math.min(output, streamed + STOP_ALLOWANCE_TOKENS));
    ledger.hold(request.id, { usd: heldUsd, stoppedPrice });
    const thinking = thinkingWithin(request, output);
    return {
      id: request.id,
      heldUsd,
      boundUsd: Math.max(0, worstUsd - heldUsd),
      worstUsd,
      ...(p.asked === undefined ? {} : { outputTokensMax: output }),
      ...(thinking === undefined ? {} : { thinkingBudget: thinking }),
      stoppedUsd: (streamed) => Math.min(heldUsd, stoppedPrice(streamed)),
    };
  };

  const admitTool = (request: ToolCapRequest, capUsd: number, spent: number): Admission => {
    const held = ledger.held();
    if (spent + held + request.holdUsd > capUsd + 1e-12) {
      const { text, figures } = paidRefusal(capUsd, spent, held, request.name, request.holdUsd, request.basis);
      throw new CapRefused(text, { forGood: false, spentUsd: spent, figures });
    }
    if (request.holdUsd > 0) ledger.hold(request.id, { usd: request.holdUsd });
    return { id: request.id, heldUsd: request.holdUsd, boundUsd: 0, worstUsd: request.holdUsd, stoppedUsd: () => request.holdUsd };
  };

  return {
    async admit(request: CapRequest): Promise<Admission> {
      // Read before every check: a raise holds from the next paid step.
      const capUsd = options.capUsd();
      if (capUsd === undefined) return NO_HOLD(request.id);
      const spent = ledger.spent();
      if (spent === null) throw new CapRefused(unknownSpend(capUsd), { forGood: true, spentUsd: null });
      return request.kind === "model" ? admitModel(request, capUsd, spent) : admitTool(request, capUsd, spent);
    },
    async settle(id: string, ended: Settled): Promise<number | null> {
      return ledger.settle(id, ended);
    },
    leastUsd(request: ModelCapRequest): number {
      const p = priced(request);
      return p ? p.cost(p.least) : Number.NaN;
    },
    spentUsd: () => ledger.spent(),
    heldUsd: () => ledger.held(),
  };
}
