// The kernel cap (kernel tangle 2: the cap lives in the kernel, the same for every harness). Not exported from the
// package's index until the cutover: its tests import it from dist/kernel/cap/.
export { CapRefused, createCap } from "./admit.js";
export { ANSWER_TOKENS_LEAST, CACHE_WARM_MS, CAP_TOLERANCE, FIT_TOLERANCE, STOP_ALLOWANCE_TOKENS, THINKING_BUDGET_LEAST, expectedInput, inputBound, mostOutput, pricingOf, requestPrice } from "./price.js";
export { CAP_REFUSAL_CODE, SPEND_CAP_REACHED, SUGGESTED_RAISE_FACTOR, centsMoney, leastMoney, money, raiseFigure, raiseTo, suggestedRaise } from "./words.js";
export type { Admission, Cap, CapMode, CapModel, CapOptions, CapRequest, ModelCapRequest, ModelPrice, Previous, RefusalFigures, Settled, ToolCapRequest } from "./types.js";
