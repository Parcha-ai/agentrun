import { createHash, randomUUID } from "node:crypto";
import { APIConnectionError, APIError, TypeSafeClient } from "@typesafe-ai/sdk";
import type { Fetch, RequestOptions, SystemOneRequest } from "@typesafe-ai/sdk";
import { validateAnswers, SystemOneError, SystemOneRequestError, isSystemOneResponseReason } from "@parcha/agentrun-dsl";
import type { WorkflowDeps, SystemOneResponseReason, SystemOneMetadata, SystemOneAttempt } from "@parcha/agentrun-dsl";

/** Injectable client boundary. Custom clients must honor signal and disable their own retries. */
export interface JevClient {
  systemOne(request: SystemOneRequest, options: RequestOptions): PromiseLike<unknown>;
}

export interface JevOptions {
  apiKey?: string;
  /** API root, without /v1/systemone; useful for an explicitly configured gateway. */
  baseURL?: string;
  fetch?: Fetch;
  /** When supplied, owns credentials and transport; cannot be combined with apiKey/baseURL/fetch. */
  client?: JevClient;
  model?: string;
  signal?: AbortSignal;
  /** null disables the adapter deadline; requires a cancellation-only host client. */
  timeoutMs?: number | null;
  /** Optional host guard on serialized UTF-8 JSON state; null or omission disables it. */
  maxStateBytes?: number | null;
  maxAttempts?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** Explicit estimate; unknown prices are never silently treated as free. */
  pricing?: { inputUsdPerMillionTokens: number; outputUsdPerMillionTokens: number };
}

export type JevErrorCode = "configuration" | "invalid_request" | "invalid_response" | "http" | "connection" | "aborted" | "timeout";
const adapterResponseReasons = ["response_shape", "token_usage", "model_identifier", "cost_range", "answer_validation", "max_tokens_exceeded"] as const;
export type JevResponseReason = SystemOneResponseReason | typeof adapterResponseReasons[number];
export function isJevResponseReason(value: unknown): value is JevResponseReason {
  return isSystemOneResponseReason(value) || typeof value === "string" && (adapterResponseReasons as readonly string[]).includes(value);
}
export type JevResponseDiagnostic = { reason: JevResponseReason };
export type JevRequestDiagnostic = {
  reason: "invalid_state" | "state_too_large" | "invalid_questions";
  label?: string;
  stateBytes?: number;
  maxStateBytes?: number;
};

/** Deliberately excludes provider bodies, headers, input state, and underlying causes. */
export class JevError extends SystemOneRequestError {
  readonly responseDiagnostic?: JevResponseDiagnostic;
  constructor(readonly code: JevErrorCode, message: string, readonly attempts: number = 0, readonly status?: number,
    readonly requestDiagnostic?: JevRequestDiagnostic, responseDiagnostic?: JevResponseDiagnostic) {
    super(message, code);
    this.name = "JevError";
    if (isJevResponseReason(responseDiagnostic?.reason)) this.responseDiagnostic = { reason: responseDiagnostic.reason };
  }
}

const configuration = (condition: boolean, message: string): void => {
  if (!condition) throw new JevError("configuration", message);
};
const milliseconds = (n: number, allowZero = false): boolean => Number.isSafeInteger(n) && n >= (allowZero ? 0 : 1) && n <= 2_147_483_647;
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const tokens = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

function abortable<T>(promise: PromiseLike<T>, signal: AbortSignal, error: () => JevError): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(error()); };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(
      value => { signal.removeEventListener("abort", abort); if (signal.aborted) reject(error()); else resolve(value); },
      failure => { signal.removeEventListener("abort", abort); reject(signal.aborted ? error() : failure); },
    );
    if (signal.aborted) abort();
  });
}

function wait(ms: number, signal: AbortSignal, error: () => JevError): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(error()); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

export function createJevRunner(options: JevOptions = {}): NonNullable<WorkflowDeps["runJudge"]> {
  const timeoutMs = options.timeoutMs === null ? null : (options.timeoutMs ?? 30_000);
  const maxStateBytes = options.maxStateBytes ?? null;
  const maxAttempts = options.maxAttempts ?? 3;
  const retryBaseMs = options.retryBaseMs ?? 500;
  const retryMaxMs = options.retryMaxMs ?? 5_000;
  configuration(timeoutMs === null || milliseconds(timeoutMs), "timeoutMs must be null or a positive integer of at most 2147483647.");
  configuration(maxStateBytes === null || (Number.isSafeInteger(maxStateBytes) && maxStateBytes > 0), "maxStateBytes must be null or a positive safe integer.");
  configuration(timeoutMs !== null || options.client !== undefined, "The TypeSafe SDK requires a finite timeout. For timeoutMs: null, supply a cancellation-only host client.");
  configuration(Number.isInteger(maxAttempts) && maxAttempts >= 1 && maxAttempts <= 10, "maxAttempts must be an integer from 1 to 10.");
  configuration(milliseconds(retryBaseMs, true) && milliseconds(retryMaxMs, true) && retryBaseMs <= retryMaxMs, "Retry delays must be nonnegative integers; retryBaseMs cannot exceed retryMaxMs.");
  configuration(!options.client || (options.apiKey === undefined && options.baseURL === undefined && options.fetch === undefined), "Supply either client or transport options, not both.");
  const pricing = options.pricing ? { ...options.pricing } : undefined;
  if (pricing) configuration([pricing.inputUsdPerMillionTokens, pricing.outputUsdPerMillionTokens].every(n => Number.isFinite(n) && n >= 0), "Configured token prices must be finite nonnegative numbers.");
  const model = options.model ?? "jev-latest";
  configuration(typeof model === "string" && model.trim().length > 0, "model must be a nonempty string.");
  let client: JevClient;
  try {
    client = options.client ?? new TypeSafeClient({
      apiKey: options.apiKey, baseURL: options.baseURL, fetch: options.fetch,
      defaultModel: model, retry: { maxRetries: 0 }, timeout: timeoutMs ?? undefined, logLevel: "off",
    });
  } catch {
    throw new JevError("configuration", "Could not configure Jev. Supply apiKey or set TYPESAFE_API_KEY, and check transport options.");
  }
  const runnerSignal = options.signal;

  return async params => {
    const deadline = new AbortController();
    const signals = [deadline.signal, runnerSignal, params.signal].filter((s): s is AbortSignal => !!s);
    const signal = AbortSignal.any(signals);
    let attempt = 0;
    const abortError = () => (runnerSignal?.aborted || params.signal?.aborted)
      ? new JevError("aborted", "Jev request was cancelled.", attempt)
      : new JevError("timeout", "Jev request exceeded its total deadline.", attempt);
    if (signal.aborted) throw abortError();
    const timer = timeoutMs === null ? undefined : setTimeout(() => deadline.abort(), timeoutMs);
    const started = Date.now();
    const transportAttempts: SystemOneAttempt[] = [];
    const metadata: SystemOneMetadata = { model: null, pricing: pricing ?? null, usage: null, cost_usd: null, transport_attempts: transportAttempts };
    try {
      let body: string;
      let request: SystemOneRequest;
      const invalid = (reason: JevRequestDiagnostic['reason'], message: string, stateBytes?: number) => new JevError(
        "invalid_request", message, 0, undefined, { reason,
          ...(typeof params.label === "string" ? { label: params.label.slice(0, 200) } : {}),
          ...(stateBytes === undefined || maxStateBytes === null ? {} : { stateBytes, maxStateBytes }) });
      const state = params.state ?? null;
      let serializedState: string;
      try {
        if (typeof state !== "string" && state !== null && typeof state !== "object") throw new Error();
        serializedState = JSON.stringify(state);
        if (typeof serializedState !== "string") throw new Error();
      } catch {
        throw invalid("invalid_state", "Jev state must be JSON-serializable text, an object, an array or null.");
      }
      const stateBytes = Buffer.byteLength(serializedState, "utf8");
      if (maxStateBytes !== null && stateBytes > maxStateBytes) throw invalid("state_too_large",
        `Jev assembled state is ${stateBytes} UTF-8 bytes; configured host limit is ${maxStateBytes} bytes. No request was sent.`, stateBytes);
      try {
        body = JSON.stringify({ state: JSON.parse(serializedState), model, questions: params.questions });
        request = JSON.parse(body) as SystemOneRequest;
        if (!record(request.questions) || Object.keys(request.questions).length === 0) throw new Error();
      } catch {
        throw invalid("invalid_questions", "Jev requires a nonempty JSON question map; no request was sent.");
      }
      metadata.request_sha256 = createHash("sha256").update(body).digest("hex");
      for (attempt = 1; ; attempt++) {
        if (signal.aborted) throw abortError();
        const attemptStarted = performance.now();
        const transport: SystemOneAttempt = { id: randomUUID(), number: attempt, status: "unknown", elapsed_ms: 0, http_status: null, usage: null, cost_usd: null };
        transportAttempts.push(transport);
        let result: unknown;
        try {
          result = await abortable(client.systemOne(request, {
            signal, ...(timeoutMs === null ? {} : { timeout: Math.max(1, timeoutMs - (Date.now() - started)) }), retry: { maxRetries: 0 },
          }), signal, abortError);
        } catch (error) {
          transport.elapsed_ms = Math.max(0, performance.now() - attemptStarted);
          if (signal.aborted) throw abortError();
          const status = error instanceof APIError ? error.status : undefined;
          transport.http_status = Number.isInteger(status) && status! >= 100 && status! <= 599 ? status! : null;
          transport.status = status === undefined ? "unknown" : "failed";
          const retryable = status === 408 || status === 429 || (status !== undefined && status >= 500 && status <= 599) || error instanceof APIConnectionError;
          if (retryable && attempt < maxAttempts) {
            await wait(Math.min(retryMaxMs, retryBaseMs * 2 ** (attempt - 1)), signal, abortError);
            continue;
          }
          if (status !== undefined) {
            const safeStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
            const capacity = error instanceof APIError && record(error.body) && record(error.body.detail)
              && error.body.detail.error_type === "max_tokens_exceeded";
            throw new JevError("http", safeStatus === undefined ? "Jev returned an HTTP failure." : `Jev returned HTTP ${safeStatus}.`, attempt, safeStatus, undefined,
              capacity ? { reason: "max_tokens_exceeded" } : undefined);
          }
          if (error instanceof APIConnectionError) throw new JevError("connection", "Jev transport failed.", attempt);
          throw new JevError("invalid_request", "Jev could not process the request. Check question and transport configuration.", attempt);
        }
        transport.elapsed_ms = Math.max(0, performance.now() - attemptStarted);
        transport.status = "failed";
        // A returned response may be billed even when its answers fail validation.
        if (record(result)) {
          if (record(result.usage) && tokens(result.usage.input_tokens) && tokens(result.usage.output_tokens)) {
            transport.usage = { input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens };
            const estimate = pricing ? (transport.usage.input_tokens * pricing.inputUsdPerMillionTokens + transport.usage.output_tokens * pricing.outputUsdPerMillionTokens) / 1_000_000 : null;
            transport.cost_usd = estimate !== null && Number.isFinite(estimate) ? estimate : null;
            metadata.usage = transport.usage;
            metadata.cost_usd = transport.cost_usd;
          }
          if (typeof result.model === "string" && result.model.trim()) metadata.model = result.model;
          if (typeof result.request_id === "string" && result.request_id.trim()) metadata.provider_request_id = result.request_id;
        }
        if (!record(result)) throw new JevError("invalid_response", "Jev returned an invalid response.", attempt, undefined, undefined, { reason: "response_shape" });
        const answers = result.answers;
        try { validateAnswers(params.questions, answers); }
        catch (error) { throw new JevError("invalid_response", "Jev returned invalid answers or probability distributions.", attempt, undefined, undefined,
          { reason: error instanceof SystemOneError && isSystemOneResponseReason(error.responseReason) ? error.responseReason : "answer_validation" }); }
        const usage = result.usage;
        if (usage != null && (!record(usage) || !tokens(usage.input_tokens) || !tokens(usage.output_tokens))) {
          throw new JevError("invalid_response", "Jev returned invalid token usage.", attempt, undefined, undefined, { reason: "token_usage" });
        }
        if (result.model != null && (typeof result.model !== "string" || !result.model.trim())) {
          throw new JevError("invalid_response", "Jev returned an invalid model identifier.", attempt, undefined, undefined, { reason: "model_identifier" });
        }
        const metering = record(usage) ? { input_tokens: usage.input_tokens as number, output_tokens: usage.output_tokens as number } : null;
        const cost = pricing && metering ? (metering.input_tokens * pricing.inputUsdPerMillionTokens + metering.output_tokens * pricing.outputUsdPerMillionTokens) / 1_000_000 : null;
        if (cost !== null && !Number.isFinite(cost)) throw new JevError("invalid_response", "Jev cost estimate exceeded the numeric range.", attempt, undefined, undefined, { reason: "cost_range" });
        transport.status = "answered";
        return {
          ...metadata,
          answers, model: typeof result.model === "string" ? result.model : null,
          usage: metering, cost_usd: cost,
          request_sha256: createHash("sha256").update(body).digest("hex"),
        };
      }
    } catch (error) {
      if (error instanceof JevError) error.metadata = metadata;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
}
