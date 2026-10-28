// The seam for decision models: a DecisionProvider answers typed questions (noul, choice, score, box) about a state, fast
// and without an agent harness, and judgeFromProvider makes one the interpreter's runJudge. Jev is one provider and a
// third-party API another; each passes the conformance suite in `@parcha/agentrun-dsl/testing`.
import { completeConfidence, validateAnswers, type SystemOneAnswer, type SystemOneQuestion } from "./system-one.js";
import type { WorkflowDeps } from "./workflow.js";

type RunJudge = NonNullable<WorkflowDeps["runJudge"]>;
type JudgeParams = Parameters<RunJudge>[0];
type JudgeResult = Awaited<ReturnType<RunJudge>>;

export type DecisionInput = "text" | "json" | "image" | "pdf" | "url";

/** What a provider answers, so a workflow or host can tell before it asks. */
export interface DecisionCapabilities {
  types: SystemOneQuestion["type"][];
  inputs: DecisionInput[];
  /** What grounds the answers: nothing, sources for the whole call, or spans per answer. */
  evidence: "none" | "citations" | "spans";
  /** Where the probabilities come from. Only "calibrated" claims to have been measured against outcomes. */
  probability: "calibrated" | "model" | "self_reported" | "none";
  /** Whether it looks things up on the web. */
  grounding: boolean;
  /** "never": a request is paid when sent, so one cut off is never sent again unasked. "deduped": the provider answers a
   *  decision id it has seen with the same answer and no new charge. */
  replay: "never" | "deduped";
  /** The most questions one request may hold, or null for no limit. */
  maxQuestions: number | null;
  /** The largest state one request may hold, as UTF-8 JSON bytes, or null for no limit. */
  maxStateBytes: number | null;
}

export type DecisionRequest = Pick<JudgeParams, "label" | "kind" | "state" | "questions" | "item" | "executionPath">;

export interface DecisionContext {
  /** The decision receipt's id: the same request asked again has the same id. */
  decisionId: string;
  signal: AbortSignal;
  /** How long the provider has, every attempt included, in milliseconds; null leaves it to the provider. */
  deadlineMs: number | null;
}

/** A source an answer rests on. `scope` is "call" when the provider grounds the whole request in it, or the id of the one
 *  question it supports. */
export interface DecisionEvidence { url: string; title: string | null; excerpts: string[]; scope: string }

type WithoutConfidence<A> = A extends { confidence: unknown } ? Omit<A, "confidence"> & { confidence?: number | null } : A;
/** An answer as a provider gives it: a choice or score may lack a confidence, which judgeFromProvider derives. */
export type ProviderAnswer = SystemOneAnswer | WithoutConfidence<Extract<SystemOneAnswer, { type: "choice" | "score" }>>;

/** How a cost was reached. "unknown" goes with a null cost, never with 0. */
export type CostBasis = "reported" | "estimate" | "unknown";

export interface DecisionOutcome {
  answers: Record<string, ProviderAnswer>;
  evidence: DecisionEvidence[];
  model: string | null;
  usage: { input_tokens: number; output_tokens: number } | null;
  cost_usd: number | null;
  cost_basis: CostBasis;
  provider_request_id: string | null;
}

export type DecisionProviderErrorCode = "configuration" | "auth" | "rate_limited" | "timeout" | "aborted" | "invalid_request" | "invalid_response" | "http" | "connection";

/** A provider's failure. Its message names what failed, never a key, a header, a request or response body. */
export class DecisionProviderError extends Error {
  readonly status?: number;
  readonly attempts: number;
  /** The provider's own reference for the failure, when it gives one. */
  readonly refId?: string;
  constructor(readonly code: DecisionProviderErrorCode, message: string, details: { status?: number; attempts?: number; refId?: string } = {}) {
    super(message);
    this.name = "DecisionProviderError";
    this.attempts = details.attempts ?? 0;
    if (details.status !== undefined) this.status = details.status;
    if (details.refId !== undefined) this.refId = details.refId;
  }
}

export interface DecisionProvider {
  /** "jev", "parallel", "http:<name>" and the like. */
  readonly id: string;
  /** The environment variables it reads its keys from, by name; never their values. */
  readonly needs: readonly string[];
  readonly capabilities: DecisionCapabilities;
  decide(request: DecisionRequest, ctx: DecisionContext): Promise<DecisionOutcome>;
}

/** Refuses, as invalid_request, a request beyond what `capabilities` declares: a question type it does not answer, more
 *  questions than it takes, or a larger state. A provider calls it before it sends anything. */
export function checkCapabilities(capabilities: DecisionCapabilities, request: Pick<DecisionRequest, "questions" | "state">): void {
  const types = Object.values(request.questions).map((question) => question?.type);
  const unknown = types.filter((type) => !capabilities.types.includes(type));
  if (unknown.length) throw new DecisionProviderError("invalid_request", `The provider does not answer ${[...new Set(unknown)].map(String).join(", ")} questions.`);
  if (capabilities.maxQuestions !== null && types.length > capabilities.maxQuestions) throw new DecisionProviderError("invalid_request", `${types.length} questions exceed the ${capabilities.maxQuestions} one request may hold.`);
  if (capabilities.maxStateBytes !== null) {
    const bytes = Buffer.byteLength(JSON.stringify(request.state ?? null) ?? "null", "utf8");
    if (bytes > capabilities.maxStateBytes) throw new DecisionProviderError("invalid_request", `A state of ${bytes} bytes exceeds the ${capabilities.maxStateBytes} one request may hold.`);
  }
}

/** The interpreter's runJudge, answered by `provider`: the request goes to it with the decision's id, its signal and
 *  `deadlineMs`; a choice or score without a confidence gets one derived, and the result names each one's source. The
 *  answers are validated against the questions, and ones that do not match them are invalid_response. */
export function judgeFromProvider(provider: DecisionProvider, options: { deadlineMs?: number | null } = {}): RunJudge {
  return async (params) => {
    const request: DecisionRequest = { label: params.label, kind: params.kind, state: params.state, questions: params.questions, ...(params.item ? { item: params.item } : {}), ...(params.executionPath !== undefined ? { executionPath: params.executionPath } : {}) };
    checkCapabilities(provider.capabilities, request);
    const outcome = await provider.decide(request, { decisionId: params.decisionId ?? "", signal: params.signal ?? new AbortController().signal, deadlineMs: options.deadlineMs ?? null });
    const { answers, confidence_source } = completeConfidence(params.questions, (outcome.answers ?? {}) as Record<string, unknown>);
    try { validateAnswers(params.questions, answers); }
    catch (error) { throw new DecisionProviderError("invalid_response", `${provider.id} answered with ${(error as Error).message.replace(/^System One /, "")}`); }
    const result: JudgeResult = {
      answers, model: outcome.model, usage: outcome.usage, cost_usd: outcome.cost_usd, cost_basis: outcome.cost_basis,
      evidence: outcome.evidence, provider_request_id: outcome.provider_request_id, confidence_source,
    };
    return result;
  };
}
