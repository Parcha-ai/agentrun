// The kernel cap (kernel tangle 2: the cap lives in the kernel, the same for every harness). Not exported from the
// package's index until the cutover: its tests import it from dist/kernel/cap/.
export { CapRefused, createCap, DECISION_IMAGE_TOKENS, DECISION_OUTPUT_TOKENS, DecisionPriceUnreadable, END_MARK_WAIT_MS, END_NOT_WRITTEN, MARK_NOT_WRITTEN, openCap } from "./admit.js";
export { capRule, noteFor, type Judged, type JudgeState, type NoteState } from "./rule.js";
export { beforeRequestOf, type BeforeRequestOptions } from "./port.js";
export { DECISION_SESSION, paidCalls, runCap, TOOL_SESSION, type RunCap, type RunCapOptions, type RunDecisions, type RunTools } from "./run-cap.js";
export { ANSWER_TOKENS_LEAST, CACHE_WARM_MS, CAP_TOLERANCE, FIT_TOLERANCE, STOP_ALLOWANCE_TOKENS, THINKING_BUDGET_LEAST, expectedInput, inputBound, mostOutput, pricingOf, ratesFor, requestPrice } from "./price.js";
export { CAP_REFUSAL_CODE, SPEND_CAP_REACHED, SUGGESTED_RAISE_FACTOR, centsMoney, leastMoney, money, overCapWords, raiseFigure, raiseTo, suggestedRaise } from "./words.js";
export { checkRaise, followUpOf, parkOf, takeRaises, type BudgetPending, type Park, type RaiseCheck, type RaiseState } from "./park.js";
export { WRAP_UP_FACTOR, WRAP_UP_LEAST_FACTOR, WRAP_UP_STEP0_ANSWER_TOKENS, typicalCost, wrapUpDue, wrapUpWords } from "./wrap-up.js";
export { CapStop, createStepWaits, type StepWaits } from "./steps.js";
export { memoryMarks, type CapMark, type CapMarks, type EndMark, type StartMark, type ToldMark, type WaitMark } from "./marks.js";
export { ownCostsOf, spendOf, toldIn, type Spend } from "./recover.js";
export { StepNotHeld, StepNotSettled } from "./ledger.js";
export { reasoningBytes, stoppedTokens, streamedBytes } from "./stopped.js";
export type { Admission, Cap, CapMode, CapModel, CapOptions, CapRequest, DecisionCapRequest, ModelCapRequest, ModelPrice, PriceRates, PriceTier, Previous, RefusalFigures, Settled, ToolCapRequest } from "./types.js";
