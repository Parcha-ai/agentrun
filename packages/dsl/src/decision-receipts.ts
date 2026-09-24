import { createHash, randomUUID } from "node:crypto";
import {
  SystemOneError, SystemOneRequestError, validateAnswers,
  type DecisionContext, type DecisionReceipt, type DecisionRequest, type SystemOneMetadata, type SystemOneResponse,
} from "./system-one.js";

export const decisionMetadata = (value: SystemOneMetadata = {}): DecisionReceipt["metadata"] => ({
  model: value.model ?? null, usage: value.usage ?? null, cost_usd: value.cost_usd ?? null,
  request_sha256: value.request_sha256 ?? null, provider_request_id: value.provider_request_id ?? null,
  pricing: value.pricing ?? null, transport_attempts: value.transport_attempts ?? null, replayed: value.replayed ?? false,
});
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Required persistence happens before a decision may affect workflow state or actions. */
export async function recordDecisionCall(
  request: DecisionRequest,
  workflowHash: string,
  context: DecisionContext | undefined,
  call: () => Promise<SystemOneResponse>,
  persist?: (receipt: DecisionReceipt, request: DecisionRequest) => Promise<void>,
  observe?: (receipt: DecisionReceipt) => void,
): Promise<SystemOneResponse & { decision_id: string }> {
  const original = structuredClone(request);
  const started = performance.now();
  const base = {
    version: 1 as const, id: randomUUID(),
    run_id: context?.runId ?? null, attempt_id: context?.attemptId ?? null, phase: context?.phase ?? null,
    workflow_sha256: workflowHash, execution_path: request.executionPath, label: request.label, kind: request.kind,
    input_sha256: hash(original.state), questions_sha256: hash(original.questions), started_at: new Date().toISOString(),
  };
  let result: SystemOneResponse | undefined;
  let failure: unknown;
  let failed = false;
  try {
    result = await call();
    validateAnswers(original.questions, result.answers);
  } catch (error) { failed = true; failure = error; }
  const receipt: DecisionReceipt = {
    ...base, elapsed_ms: Math.max(0, performance.now() - started), status: failed ? "failed" : "answered",
    answers: failed ? null : structuredClone(result!.answers),
    metadata: structuredClone(decisionMetadata(result ?? (failure instanceof SystemOneRequestError ? failure.metadata : undefined))),
    error: failed ? {
      category: failure instanceof SystemOneError ? "invalid_response" : "adapter",
      reason: failure instanceof SystemOneError ? failure.responseReason ?? null : null,
      adapter_kind: failure instanceof SystemOneRequestError ? failure.failureKind ?? null : null,
    } : null,
  };
  if (persist) {
    try { await persist(structuredClone(receipt), original); }
    catch (persistenceError) {
      if (failed) throw new AggregateError([failure, persistenceError], "Decision failed and its receipt could not be persisted", { cause: failure });
      throw new Error("Decision receipt could not be persisted; its answer was not applied", { cause: persistenceError });
    }
  }
  observe?.(receipt);
  if (failed) throw failure;
  return { ...result!, decision_id: receipt.id };
}
