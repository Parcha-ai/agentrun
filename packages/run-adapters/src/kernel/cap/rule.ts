// The kernel cap's one rule, stateless: given the cap, what the run has spent and what its steps under way hold, judge
// admits a step (what it is held at, the output it may be sent with) or refuses it in words; noteFor decides the wrap-up.
// Every path calls these and nothing else decides: createCap (pi, decisions, tools, on its own ledger) and beforeRequestOf
// (the CLI harnesses, on the runner's booking). capRule.judge is called through the object, once per decision, so a test
// can see that no path decides without it.
import { CapRefused } from "./errors.js";
import { FIT_TOLERANCE, inputBound, mostOutput, outputAsked, outputLeast, pricingOf, requestPrice, STOP_ALLOWANCE_TOKENS, thinkingLeast, thinkingWithin } from "./price.js";
import { typicalCost, WRAP_UP_STEP0_ANSWER_TOKENS, wrapUpDue, wrapUpWords } from "./wrap-up.js";
import { noCeiling, noPrice, noToolPrice, paidRefusal, roomRefusal, unknownHeld, unknownSpend, unmeasured } from "./words.js";
import type { CapMode, ModelCapRequest, ToolCapRequest } from "./types.js";

/** What a judgement reads: the cap (read before this check), the run's spend (null: unknown) and its holds (null:
 *  unknown). */
export type JudgeState = { capUsd: number; spentUsd: number | null; heldUsd: number | null; mode: CapMode; now: number };
/** The state once both figures are known. */
type Known = JudgeState & { spentUsd: number; heldUsd: number };

/** A money figure the cap can count: a finite number of 0 or more. Anything else (null, NaN, Infinity, below 0) is
 *  unknown: it never reads as $0 and never frees room. */
export const isFigure = (usd: unknown): usd is number => typeof usd === "number" && Number.isFinite(usd) && usd >= 0;

/** A step admitted: what it is held at, the most a cache miss adds, its worst case, the output it may be sent with and its
 *  thinking budget, and what it counts at if stopped having streamed that many tokens (within its hold). */
export type Judged = { heldUsd: number; boundUsd: number; worstUsd: number; outputTokensMax?: number; thinkingBudget?: number; stoppedUsd(streamedTokens: number): number };

/** A model request priced: its output asked and least, its input's bound, and its cost and worst case at an output (with
 *  the input parts the cost priced, `input`). */
export function priced(request: ModelCapRequest, mode: CapMode, now: number) {
  const bound = inputBound(request);
  const price = request.model.price;
  if (bound === undefined || price === null) return undefined;
  const asked = outputAsked(request);
  const { cost, worst, input } = requestPrice(pricingOf(price), bound, request.previous, now, mode, request.model.id, request.feeUsd ?? 0);
  return { asked, bound, cost, worst, input, least: asked === undefined ? 0 : outputLeast(request, asked) };
}

function judgeModel(request: ModelCapRequest, { capUsd, spentUsd: spent, heldUsd: held, mode, now }: Known): Judged {
  if (inputBound(request) === undefined) throw new CapRefused(unmeasured(capUsd), { forGood: true, spentUsd: spent });
  const price = request.model.price;
  if (price === null) throw new CapRefused(noPrice(capUsd), { forGood: true, spentUsd: spent });
  if (request.model.outputCeiling === null && price.output > 0) throw new CapRefused(noCeiling(capUsd), { forGood: true, spentUsd: spent });
  const p = priced(request, mode, now)!;
  const output = mostOutput(p.cost, p.least, p.asked ?? 0, capUsd - spent - held);
  if (output === undefined) {
    // What the least is for, said beside it: the input's bound, what of it the cache reads, and the least output, its
    // answer and its thinking apart where the cap knows the split.
    const thinking = thinkingLeast(request, p.least);
    const parts = { inputTokens: p.bound, cachedTokens: p.input(p.least).cached, ...(thinking === undefined ? { outputTokens: p.least } : { answerTokens: p.least - thinking, thinkingTokens: thinking }) };
    const { text, figures } = roomRefusal(capUsd, spent, held, p.cost(p.least), p.worst(p.least) - p.cost(p.least), parts);
    throw new CapRefused(text, { forGood: false, spentUsd: spent, figures });
  }
  const heldUsd = p.cost(output);
  const worstUsd = p.worst(output);
  const stoppedPrice = (streamed: number) => p.cost(Math.min(output, streamed + STOP_ALLOWANCE_TOKENS));
  const thinking = thinkingWithin(request, output);
  return {
    heldUsd,
    boundUsd: Math.max(0, worstUsd - heldUsd),
    worstUsd,
    ...(p.asked === undefined ? {} : { outputTokensMax: output }),
    ...(thinking === undefined ? {} : { thinkingBudget: thinking }),
    stoppedUsd: (streamed) => Math.min(heldUsd, stoppedPrice(streamed)),
  };
}

function judgeTool(request: ToolCapRequest, { capUsd, spentUsd: spent, heldUsd: held }: Known): Judged {
  // A hold that is not a finite figure of 0 or more cannot be kept within a cap (a NaN would fail every check open; a
  // negative one would free room): refused for good.
  if (typeof request.holdUsd !== "number" || !Number.isFinite(request.holdUsd) || request.holdUsd < 0) throw new CapRefused(noToolPrice(capUsd, request.name), { forGood: true, spentUsd: spent });
  // Written so that a figure that is not a number refuses.
  if (!(spent + held + request.holdUsd <= capUsd + FIT_TOLERANCE)) {
    const { text, figures } = paidRefusal(capUsd, spent, held, request.name, request.holdUsd, request.basis);
    throw new CapRefused(text, { forGood: false, spentUsd: spent, figures });
  }
  return { heldUsd: request.holdUsd, boundUsd: 0, worstUsd: request.holdUsd, stoppedUsd: () => request.holdUsd };
}

/** The one rule: admits `request` under `state`, or throws CapRefused. */
function judge(request: ModelCapRequest | ToolCapRequest, state: JudgeState): Judged {
  // An unknown figure refuses for good: no raise can make it fit, and none is read as $0 (its words never say NaN).
  if (!isFigure(state.spentUsd)) throw new CapRefused(unknownSpend(state.capUsd), { forGood: true, spentUsd: null });
  if (!isFigure(state.heldUsd)) throw new CapRefused(unknownHeld(state.capUsd), { forGood: true, spentUsd: state.spentUsd });
  const known: Known = { ...state, spentUsd: state.spentUsd, heldUsd: state.heldUsd };
  return request.kind === "model" ? judgeModel(request, known) : judgeTool(request, known);
}

/** The rule's entry, called through this object by every path. */
export const capRule = { judge };

/** What the wrap-up reads: the cap, spend and holds as admission counts them, the run's own priced answers on the
 *  request's model, and whether it was told. */
export type NoteState = { capUsd: number | undefined; spentUsd: number | null; heldUsd: number; costs: readonly number[]; told: boolean; mode: CapMode; now: number };

/** The wrap-up for `request`, the run's next main-model request measured before the note is placed: due under three times
 *  the typical cost (step 0: its input and a 4,096-token answer) or twice its least, not yet told, never for a side call,
 *  and never when the request fits what is left only without the note's bytes. */
export function noteFor(request: ModelCapRequest, state: NoteState): { words: string; leftUsd: number } | undefined {
  if (request.side || state.told || state.capUsd === undefined || state.spentUsd === null) return undefined;
  const p = priced(request, state.mode, state.now);
  if (!p) return undefined;
  const least = p.cost(p.least);
  const typical = typicalCost(state.costs, p.cost(Math.min(p.asked ?? 0, WRAP_UP_STEP0_ANSWER_TOKENS)));
  const due = wrapUpDue(state.capUsd, state.spentUsd, state.heldUsd, typical, least);
  if (!due) return undefined;
  const words = wrapUpWords(due.leftUsd, state.costs.length === 0);
  const noted = priced({ ...request, inputTokens: (request.inputTokens ?? 0) + Buffer.byteLength(words, "utf8") }, state.mode, state.now);
  if (noted && noted.cost(noted.least) > due.leftUsd + FIT_TOLERANCE && least <= due.leftUsd + FIT_TOLERANCE) return undefined;
  return { words, leftUsd: due.leftUsd };
}
